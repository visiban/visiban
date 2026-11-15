"""Auto health status for lanes and boards (#2245).

Covers the service (``boards.services.health_compute``): the absolute-count
mapping, pin precedence, the board roll-up, history rows with no user, the
compare-and-write idempotency (including two concurrent runs, on PostgreSQL),
the broadcasts (after commit, only on change), the settings toggle on PATCH,
the lane pin roll-up, and the ``POST /boards/{id}/health-recompute/``
endpoint's RBAC, 409 and throttle.
"""

import datetime
import threading
import unittest
from unittest.mock import patch

from django.core.cache import cache
from django.db import connection, connections as _conns, transaction
from django.test import TestCase, TransactionTestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from boards.models import Board, BoardHealthChange, BoardMembership, Swimlane
from boards.services.health_compute import (
    EMPTY_COUNTS, compute_board_health, lane_counts, status_for_counts,
)
from boards.tests.conftest import _make_board, _make_card, _make_column, _make_membership, _make_user
from boards.tests.test_swimlane_health_status import _capture_frames

YESTERDAY = lambda: timezone.localdate() - datetime.timedelta(days=1)  # noqa: E731


class MappingTests(TestCase):
    def test_absolute_count_mapping(self):
        def counts(open_, flagged):
            return {**EMPTY_COUNTS, "open": open_, "flagged": flagged}

        self.assertIsNone(status_for_counts(counts(0, 0), 3))
        self.assertIsNone(status_for_counts(None, 3))
        self.assertEqual(status_for_counts(counts(5, 0), 3), "on_track")
        self.assertEqual(status_for_counts(counts(5, 1), 3), "at_risk")
        self.assertEqual(status_for_counts(counts(5, 2), 3), "at_risk")
        self.assertEqual(status_for_counts(counts(5, 3), 3), "off_track")
        # Absolute, not a share: 3 of 100 is still off track.
        self.assertEqual(status_for_counts(counts(100, 3), 3), "off_track")
        self.assertEqual(status_for_counts(counts(1, 1), 1), "off_track")


class _AutoBoardMixin:
    def _setup_board(self, **board_kwargs):
        self.admin = _make_user("ah_admin")
        self.board = _make_board(self.admin, health_auto_enabled=True, **board_kwargs)
        self.todo = _make_column(self.board, "Todo", 0)
        self.done = _make_column(self.board, "Done", 1, is_done=True)
        self.acme = Swimlane.objects.create(board=self.board, name="Acme", position=0)
        self.beta = Swimlane.objects.create(board=self.board, name="Beta", position=1)

    def _card(self, lane, **kwargs):
        column = kwargs.pop("column", self.todo)
        return _make_card(column, lane, **kwargs)


class ComputeTests(_AutoBoardMixin, TestCase):
    def setUp(self):
        self._setup_board()

    def test_counts_one_card_once_and_exclude_done_and_archived(self):
        # Overdue AND blocked: flagged once.
        self._card(self.acme, title="a", due_date=YESTERDAY(), blocked_at=timezone.now())
        self._card(self.acme, title="b")
        self._card(self.acme, title="done", column=self.done, due_date=YESTERDAY())
        self._card(self.acme, title="arch", due_date=YESTERDAY(), archived_at=timezone.now())
        counts = lane_counts(self.board)
        self.assertEqual(
            counts[self.acme.pk], {"open": 2, "overdue": 1, "stale": 0, "blocked": 1, "flagged": 1},
        )
        self.assertNotIn(self.beta.pk, counts)

    def test_stale_card_is_flagged(self):
        card = self._card(self.acme, title="old")
        type(card).objects.filter(pk=card.pk).update(created_at=timezone.now() - datetime.timedelta(days=30))
        self.assertEqual(lane_counts(self.board)[self.acme.pk]["stale"], 1)

    def test_compute_stores_lanes_and_board_worst_with_history(self):
        for i in range(3):
            self._card(self.acme, title=f"late{i}", due_date=YESTERDAY())
        self._card(self.beta, title="fine")
        result = compute_board_health(self.board.pk)
        self.acme.refresh_from_db()
        self.beta.refresh_from_db()
        self.board.refresh_from_db()
        self.assertEqual(self.acme.computed_health_status, "off_track")
        self.assertEqual(self.beta.computed_health_status, "on_track")
        self.assertEqual(self.board.computed_health_status, "off_track")
        self.assertEqual(self.board.health_computed_counts["flagged"], 3)
        self.assertIsNotNone(self.board.health_computed_at)
        self.assertTrue(result.board_changed)
        row = BoardHealthChange.objects.get(board=self.board)
        self.assertEqual((row.kind, row.changed_by, row.from_status, row.to_status), ("computed", None, None, "off_track"))
        self.assertIn("Acme", row.reason)
        # The pin's last-change columns never move on a computed change.
        self.assertIsNone(self.board.health_status_changed_at)

    def test_empty_lane_is_null_and_board_ignores_it(self):
        self._card(self.beta, title="fine")
        compute_board_health(self.board.pk)
        self.acme.refresh_from_db()
        self.board.refresh_from_db()
        self.assertIsNone(self.acme.computed_health_status)
        self.assertEqual(self.board.computed_health_status, "on_track")

    def test_rerun_is_idempotent_but_advances_computed_at(self):
        self._card(self.acme, title="late", due_date=YESTERDAY())
        compute_board_health(self.board.pk)
        self.board.refresh_from_db()
        first_at, updated_at = self.board.health_computed_at, self.board.updated_at
        result = compute_board_health(self.board.pk)
        self.board.refresh_from_db()
        self.assertFalse(result.board_changed)
        self.assertEqual(result.changed_lane_ids, [])
        self.assertEqual(BoardHealthChange.objects.filter(board=self.board).count(), 1)
        self.assertGreater(self.board.health_computed_at, first_at)
        self.assertEqual(self.board.updated_at, updated_at)

    def test_pin_overrides_computed_and_feeds_rollup(self):
        self._card(self.acme, title="late", due_date=YESTERDAY())
        Swimlane.objects.filter(pk=self.acme.pk).update(health_status="on_track")
        self._card(self.beta, title="fine")
        compute_board_health(self.board.pk)
        self.acme.refresh_from_db()
        self.board.refresh_from_db()
        # Computed value still readable under the pin; the roll-up uses the pin.
        self.assertEqual(self.acme.computed_health_status, "at_risk")
        self.assertEqual(self.board.computed_health_status, "on_track")

    def test_auto_off_board_is_untouched(self):
        Board.objects.filter(pk=self.board.pk).update(health_auto_enabled=False)
        self._card(self.acme, title="late", due_date=YESTERDAY())
        self.assertIsNone(compute_board_health(self.board.pk))
        self.board.refresh_from_db()
        self.assertIsNone(self.board.health_computed_at)
        self.assertFalse(BoardHealthChange.objects.exists())

    def test_broadcasts_after_commit_and_only_on_change(self):
        self._card(self.acme, title="late", due_date=YESTERDAY())
        with _capture_frames() as frames:
            with self.captureOnCommitCallbacks(execute=False) as callbacks:
                compute_board_health(self.board.pk)
            self.assertEqual(frames, [])  # nothing before commit
            for callback in callbacks:
                callback()
        events = [f["event"] for f in frames]
        # First run: both lanes go from never computed to a value.
        self.assertEqual(events.count("swimlane.updated"), 2)
        self.assertIn("board.updated", events)
        board_frame = next(f for f in frames if f["event"] == "board.updated")
        self.assertEqual(board_frame["data"]["computed_health_status"], "at_risk")
        self.assertNotIn("is_starred", board_frame["data"])
        with _capture_frames() as frames:
            with self.captureOnCommitCallbacks(execute=True):
                compute_board_health(self.board.pk)
        self.assertEqual(frames, [])


class SerializerTests(_AutoBoardMixin, TestCase):
    def setUp(self):
        self._setup_board()
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def test_origin_and_effective_fields(self):
        self._card(self.acme, title="late", due_date=YESTERDAY())
        compute_board_health(self.board.pk)
        data = self.client.get(f"/api/v1/boards/{self.board.pk}/").json()
        self.assertEqual(data["effective_health_status"], "at_risk")
        self.assertEqual(data["health_status_origin"], "computed")
        self.assertIsNone(data["health_status_source"])
        self.assertIsNone(data["health_review_due_at"])
        self.assertEqual(data["health_off_track_cards"], 3)
        full = self.client.get(f"/api/v1/boards/{self.board.pk}/full/").json()
        lane = next(sw for sw in full["swimlanes"] if sw["id"] == self.acme.pk)
        self.assertEqual(
            (lane["effective_health_status"], lane["health_status_origin"], lane["computed_health_status"]),
            ("at_risk", "computed", "at_risk"),
        )
        self.assertEqual(lane["health_computed_counts"]["overdue"], 1)
        # Pin wins, and the board says so.
        self.client.patch(f"/api/v1/boards/{self.board.pk}/", {"health_status": "off_track"}, format="json")
        data = self.client.get(f"/api/v1/boards/{self.board.pk}/").json()
        self.assertEqual((data["effective_health_status"], data["health_status_origin"]), ("off_track", "manual"))
        self.assertEqual(data["computed_health_status"], "at_risk")

    def test_never_computed_reads_null(self):
        data = self.client.get(f"/api/v1/boards/{self.board.pk}/").json()
        self.assertIsNone(data["health_computed_at"])
        self.assertIsNone(data["computed_health_status"])
        self.assertIsNone(data["health_status_origin"])

    def test_history_rows_carry_kind_and_reason(self):
        self._card(self.acme, title="late", due_date=YESTERDAY())
        compute_board_health(self.board.pk)
        rows = self.client.get(f"/api/v1/boards/{self.board.pk}/health-history/").json()["results"]
        self.assertEqual(rows[0]["kind"], "computed")
        self.assertIsNone(rows[0]["changed_by"])
        self.assertIn("Acme", rows[0]["reason"])

    def test_threshold_validated(self):
        response = self.client.patch(f"/api/v1/boards/{self.board.pk}/", {"health_off_track_cards": 0}, format="json")
        self.assertEqual(response.status_code, 400)

    def test_list_and_full_query_counts_unchanged_by_computed_values(self):
        self._card(self.acme, title="late", due_date=YESTERDAY())
        with CaptureQueriesContext(connection) as before:
            self.client.get("/api/v1/boards/")
            self.client.get(f"/api/v1/boards/{self.board.pk}/full/")
        compute_board_health(self.board.pk)
        with CaptureQueriesContext(connection) as after:
            self.client.get("/api/v1/boards/")
            self.client.get(f"/api/v1/boards/{self.board.pk}/full/")
        self.assertLessEqual(len(after), len(before))


class SettingsToggleTests(_AutoBoardMixin, TestCase):
    def setUp(self):
        self._setup_board()
        Board.objects.filter(pk=self.board.pk).update(health_auto_enabled=False)
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def _patch(self, body):
        return self.client.patch(f"/api/v1/boards/{self.board.pk}/", body, format="json")

    def test_turning_on_computes_in_the_same_request(self):
        self._card(self.acme, title="late", due_date=YESTERDAY())
        with _capture_frames() as frames, self.captureOnCommitCallbacks(execute=True):
            data = self._patch({"health_auto_enabled": True}).json()
        self.assertEqual(data["computed_health_status"], "at_risk")
        self.assertIsNotNone(data["health_computed_at"])
        # One board.updated (the PATCH's), carrying the computed value.
        self.assertEqual([f["event"] for f in frames].count("board.updated"), 1)

    def test_turning_off_clears_computed_columns(self):
        self._card(self.acme, title="late", due_date=YESTERDAY())
        self._patch({"health_auto_enabled": True})
        data = self._patch({"health_auto_enabled": False}).json()
        self.assertIsNone(data["computed_health_status"])
        self.assertIsNone(data["health_computed_at"])
        self.acme.refresh_from_db()
        self.assertIsNone(self.acme.computed_health_status)
        self.assertIsNone(self.acme.health_computed_at)

    def test_lane_pin_rolls_up_on_auto_board(self):
        self._card(self.beta, title="fine")
        self._patch({"health_auto_enabled": True})
        self.client.patch(
            f"/api/v1/boards/{self.board.pk}/swimlanes/{self.acme.pk}/", {"health_status": "off_track"}, format="json",
        )
        self.board.refresh_from_db()
        self.assertEqual(self.board.computed_health_status, "off_track")
        self.client.delete(f"/api/v1/boards/{self.board.pk}/swimlanes/{self.acme.pk}/")
        self.board.refresh_from_db()
        self.assertEqual(self.board.computed_health_status, "on_track")

    def test_lane_pin_does_not_roll_up_with_auto_off(self):
        self.client.patch(
            f"/api/v1/boards/{self.board.pk}/swimlanes/{self.acme.pk}/", {"health_status": "off_track"}, format="json",
        )
        self.board.refresh_from_db()
        self.assertIsNone(self.board.computed_health_status)


class RecomputeEndpointTests(_AutoBoardMixin, TestCase):
    def setUp(self):
        self._setup_board()
        self.client = APIClient()
        self.url = f"/api/v1/boards/{self.board.pk}/health-recompute/"
        cache.clear()

    def test_admin_gets_board_and_lanes(self):
        self._card(self.acme, title="late", due_date=YESTERDAY())
        self.client.force_authenticate(self.admin)
        response = self.client.post(self.url)
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["board"]["computed_health_status"], "at_risk")
        self.assertEqual({sw["id"] for sw in body["swimlanes"]}, {self.acme.pk, self.beta.pk})

    def test_non_admin_roles_403(self):
        for role in (BoardMembership.Role.MEMBER, BoardMembership.Role.VIEWER):
            user = _make_user(f"ah_{role}")
            _make_membership(self.board, user, role)
            self.client.force_authenticate(user)
            self.assertEqual(self.client.post(self.url).status_code, 403, role)

    def test_non_member_404(self):
        self.client.force_authenticate(_make_user("ah_outsider"))
        self.assertEqual(self.client.post(self.url).status_code, 404)

    def test_unauthenticated_401(self):
        self.assertIn(self.client.post(self.url).status_code, (401, 403))

    def test_auto_off_409(self):
        Board.objects.filter(pk=self.board.pk).update(health_auto_enabled=False)
        self.client.force_authenticate(self.admin)
        response = self.client.post(self.url)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "health_auto_disabled")

    def test_throttled_429(self):
        from boards.views.boards import BoardHealthRecomputeThrottle

        self.client.force_authenticate(self.admin)
        with patch.object(BoardHealthRecomputeThrottle, "get_rate", return_value="1/hour"):
            self.assertEqual(self.client.post(self.url).status_code, 200)
            self.assertEqual(self.client.post(self.url).status_code, 429)


@unittest.skipUnless(connection.vendor == "postgresql", "row locks need PostgreSQL")
class ConcurrentRunTests(_AutoBoardMixin, TransactionTestCase):
    def setUp(self):
        self._setup_board()
        self._card(self.acme, title="late", due_date=YESTERDAY())

    def test_overlapping_runs_record_one_history_row(self):
        from boards.tests.lock_wait import assert_blocked_on_lock

        errors = []

        def worker():
            try:
                compute_board_health(self.board.pk)
            except Exception as exc:  # pragma: no cover - surfaced below
                errors.append(exc)
            finally:
                _conns.close_all()

        threads = [threading.Thread(target=worker, name=f"compute-{i}") for i in range(2)]
        with transaction.atomic():
            # Hold the board row so both runs queue on it.
            Board.objects.select_for_update(no_key=True).get(pk=self.board.pk)
            for t in threads:
                t.start()
            for t in threads:
                assert_blocked_on_lock(self, t, "compute run should wait on the board row")
        for t in threads:
            t.join(30)
        self.assertEqual(errors, [])
        self.assertEqual(BoardHealthChange.objects.filter(board=self.board).count(), 1)
        self.board.refresh_from_db()
        self.assertEqual(self.board.computed_health_status, "at_risk")
