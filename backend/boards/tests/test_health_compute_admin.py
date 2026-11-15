"""Auto health status through the Django admin (#2245).

The admin bypasses the REST viewsets, so it must take the same service paths
(``apply_auto_health_change``, ``rollup_board_health``): unticking auto clears
every computed value, ticking it or changing a rule input computes, a lane pin
change or delete re-derives the roll-up, a lane moved to another board drops
the computed values of the board it left, and the computed columns themselves
are read-only.
"""

import datetime
import threading
from unittest import skipUnless
from unittest.mock import patch

from django.contrib import admin as django_admin
from django.db import connection, connections, transaction
from django.test import RequestFactory, TestCase, TransactionTestCase
from django.urls import reverse
from django.utils import timezone

from accounts.models import User
from boards.models import Board, BoardHealthChange, BoardMembership, Swimlane
from boards.services.health_compute import compute_board_health
from boards.admin import SwimlaneAdmin
from boards.tests.conftest import _make_board, _make_card, _make_column
from boards.tests.lock_wait import assert_blocked_on_lock
from boards.tests.test_admin_board_concurrent_edits import _PLAIN_STATIC, page_data

YESTERDAY = lambda: timezone.localdate() - datetime.timedelta(days=1)  # noqa: E731
COMPUTED = ("computed_health_status", "health_computed_at", "health_computed_counts")


@_PLAIN_STATIC
class AutoHealthAdminTests(TestCase):
    def setUp(self):
        self.staff = User.objects.create_superuser(username="ah_staff", password="p", email="ah@x")
        self.board = _make_board(self.staff, health_auto_enabled=True, allowed_priorities=["low"])
        BoardMembership.objects.get_or_create(
            board=self.board, user=self.staff, defaults={"role": BoardMembership.Role.ADMIN},
        )
        self.todo = _make_column(self.board, "Todo", 0)
        self.acme = Swimlane.objects.create(board=self.board, name="Acme", position=0)
        self.beta = Swimlane.objects.create(board=self.board, name="Beta", position=1)
        _make_card(self.todo, self.acme, title="late", due_date=YESTERDAY())
        _make_card(self.todo, self.beta, title="fine")
        compute_board_health(self.board.pk)
        self.client.force_login(self.staff)

    def _board_url(self):
        return reverse("admin:boards_board_change", args=[self.board.pk])

    def _lane_url(self, lane):
        return reverse("admin:boards_swimlane_change", args=[lane.pk])

    def _post(self, url, **overrides):
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.post(url, page_data(response, **overrides))
        self.assertEqual(response.status_code, 302, getattr(response, "context", None) and response.context.get("errors"))
        self.board.refresh_from_db()

    def test_computed_columns_are_read_only(self):
        for url in (self._board_url(), self._lane_url(self.acme)):
            form = self.client.get(url).context["adminform"].form
            for name in COMPUTED:
                self.assertNotIn(name, form.fields, (url, name))
        self._post(self._board_url(), computed_health_status="off_track", name="Renamed")
        self.assertEqual((self.board.name, self.board.computed_health_status), ("Renamed", "at_risk"))

    def test_unticking_auto_clears_board_and_lanes(self):
        self._post(self._board_url(), health_auto_enabled=False)
        self.assertEqual([getattr(self.board, f) for f in COMPUTED], [None, None, None])
        for lane in (self.acme, self.beta):
            lane.refresh_from_db()
            self.assertEqual([getattr(lane, f) for f in COMPUTED], [None, None, None])
        row = BoardHealthChange.objects.filter(board=self.board).latest("id")
        self.assertEqual((row.kind, row.from_status, row.to_status, row.changed_by), ("computed", "at_risk", None, self.staff))

    def test_ticking_auto_computes(self):
        Board.objects.filter(pk=self.board.pk).update(health_auto_enabled=False)
        Swimlane.objects.filter(board=self.board).update(computed_health_status=None, health_computed_at=None)
        Board.objects.filter(pk=self.board.pk).update(computed_health_status=None, health_computed_at=None)
        self._post(self._board_url(), health_auto_enabled=True)
        self.assertEqual(self.board.computed_health_status, "at_risk")
        self.assertIsNotNone(self.board.health_computed_at)

    def test_rule_input_change_recomputes(self):
        self._post(self._board_url(), health_off_track_cards="1")
        self.assertEqual(self.board.computed_health_status, "off_track")

    def test_lane_pin_change_and_delete_roll_up(self):
        self._post(self._lane_url(self.beta), health_status="off_track")
        self.assertEqual(self.board.computed_health_status, "off_track")
        url = reverse("admin:boards_swimlane_delete", args=[self.beta.pk])
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(self.client.post(url, {"post": "yes"}).status_code, 302)
        self.board.refresh_from_db()
        self.assertEqual(self.board.computed_health_status, "at_risk")

    def test_lane_moved_to_auto_off_board_drops_computed_values(self):
        other = _make_board(self.staff, name="Other")
        self._post(self._lane_url(self.acme), board=str(other.pk))
        self.acme.refresh_from_db()
        self.assertEqual(self.acme.board_id, other.pk)
        self.assertEqual([getattr(self.acme, f) for f in COMPUTED], [None, None, None])
        # The board it left re-derives its roll-up without it.
        self.assertEqual(self.board.computed_health_status, "on_track")

    def test_lane_moved_to_auto_board_computes_it_and_rolls_up_the_board_left(self):
        other = _make_board(self.staff, name="Other", health_auto_enabled=True)
        _make_column(other, "Todo", 0)
        compute_board_health(other.pk)
        self._post(self._lane_url(self.acme), board=str(other.pk))
        self.acme.refresh_from_db()
        other.refresh_from_db()
        self.assertEqual(self.acme.board_id, other.pk)
        # The board it moved to computed it: its cards are that board's (none).
        self.assertIsNotNone(self.acme.health_computed_at)
        self.assertEqual(self.acme.health_computed_counts["open"], 0)
        self.assertIsNotNone(other.health_computed_at)
        # The board it left re-derives its roll-up without it.
        self.assertEqual(self.board.computed_health_status, "on_track")

    def test_lane_created_with_pin_rolls_up(self):
        url = reverse("admin:boards_swimlane_add")
        response = self.client.get(url)
        data = page_data(
            response, board=str(self.board.pk), name="Gamma", position="2", color="#6B7280",
            health_status="off_track",
        )
        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.post(url, data)
        self.assertEqual(response.status_code, 302, getattr(response, "context", None) and response.context.get("errors"))
        self.board.refresh_from_db()
        self.assertEqual(self.board.computed_health_status, "off_track")

    def test_bulk_delete_rolls_up_each_board(self):
        other = _make_board(self.staff, name="Other", health_auto_enabled=True)
        _make_column(other, "Todo", 0)
        pinned = Swimlane.objects.create(board=other, name="Pinned", position=0, health_status="off_track")
        Swimlane.objects.create(board=other, name="Quiet", position=1)
        compute_board_health(other.pk)
        Swimlane.objects.filter(pk=self.beta.pk).update(health_status="off_track")
        compute_board_health(self.board.pk)
        other.refresh_from_db()
        self.board.refresh_from_db()
        self.assertEqual((self.board.computed_health_status, other.computed_health_status), ("off_track", "off_track"))
        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.post(reverse("admin:boards_swimlane_changelist"), {
                "action": "delete_selected", "_selected_action": [str(self.beta.pk), str(pinned.pk)], "post": "yes",
            })
        self.assertEqual(response.status_code, 302)
        self.assertFalse(Swimlane.objects.filter(pk__in=[self.beta.pk, pinned.pk]).exists())
        other.refresh_from_db()
        self.board.refresh_from_db()
        self.assertEqual(self.board.computed_health_status, "at_risk")
        self.assertNotEqual(other.computed_health_status, "off_track")

    def test_board_added_with_auto_on_computes_at_once(self):
        url = reverse("admin:boards_board_add")
        response = self.client.get(url)
        data = page_data(
            response, name="Fresh", owner=str(self.staff.pk), health_auto_enabled=True, allowed_priorities='["low"]',
        )
        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.post(url, data)
        self.assertEqual(response.status_code, 302, getattr(response, "context", None) and response.context.get("errors"))
        board = Board.objects.get(name="Fresh")
        self.assertTrue(board.health_auto_enabled)
        self.assertIsNotNone(board.health_computed_at)


HOLD_TIMEOUT = 10.0


@skipUnless(connection.vendor == "postgresql", "row locks are only observable on PostgreSQL")
class AdminLaneMoveLockOrderTests(TransactionTestCase):
    """An admin lane move takes both board rows, in pk order, before the lane (#2245).

    It used to lock the new board, then the lane, then (after the write) the
    board it left, while ``compute_board_health`` on the board left locks that
    board and then its lanes, the moving one included: the move paused after
    its lane lock and a compute of the board left started then deadlocked
    once the move went on. Now the compute waits on the board row the move
    already holds, and both finish.
    """

    def setUp(self):
        self.staff = User.objects.create_superuser(username="ah_lock", password="p", email="ahl@x")
        # The board the lane moves to has the lower pk, so the old order
        # (new board first) and pk order start the same way.
        self.new = _make_board(self.staff, name="New", health_auto_enabled=True)
        self.old = _make_board(self.staff, name="Old", health_auto_enabled=True)
        todo = _make_column(self.old, "Todo", 0)
        _make_column(self.new, "Todo", 0)
        self.lane = Swimlane.objects.create(board=self.old, name="Moving", position=0)
        Swimlane.objects.create(board=self.old, name="Staying", position=1)
        _make_card(todo, self.lane, title="late", due_date=YESTERDAY())
        compute_board_health(self.old.pk)
        compute_board_health(self.new.pk)
        patcher = patch("boards.broadcast.broadcast_board_event")
        patcher.start()
        self.addCleanup(patcher.stop)

    def _move(self):
        request = RequestFactory().post("/")
        request.user = self.staff
        with transaction.atomic():
            lane = Swimlane.objects.get(pk=self.lane.pk)
            lane.board_id = self.new.pk
            django_admin.site._registry[Swimlane].save_model(request, lane, None, True)

    def _thread(self, name, fn, results):
        def run():
            try:
                results[name] = fn()
            except Exception as exc:  # reported by the test
                results[name] = exc
            finally:
                connections.close_all()

        t = threading.Thread(target=run, name=name)
        t.start()
        return t

    def test_move_and_compute_of_the_board_left_both_complete(self):
        paused, release, results = threading.Event(), threading.Event(), {}
        real = SwimlaneAdmin._under_board_lock

        def held(admin_self, obj):
            # After every lock the move takes, before its write.
            if threading.current_thread().name == "move":
                paused.set()
                release.wait(HOLD_TIMEOUT)
            return real(admin_self, obj)

        with patch.object(SwimlaneAdmin, "_under_board_lock", held):
            move = self._thread("move", self._move, results)
            self.assertTrue(paused.wait(HOLD_TIMEOUT), "the move never reached its write")
            compute = self._thread("compute", lambda: compute_board_health(self.old.pk), results)
            try:
                assert_blocked_on_lock(self, compute, "the compute of the board left waits for the move")
            finally:
                release.set()
                move.join(HOLD_TIMEOUT * 3)
                compute.join(HOLD_TIMEOUT * 3)
        for name in ("move", "compute"):
            self.assertNotIsInstance(results.get(name), Exception, (name, results.get(name)))
        self.lane.refresh_from_db()
        self.old.refresh_from_db()
        self.new.refresh_from_db()
        self.assertEqual(self.lane.board_id, self.new.pk)
        self.assertEqual(self.lane.health_computed_counts["open"], 0)
        # The late card stayed on the board left, in no lane of it now.
        self.assertIsNone(self.old.computed_health_status)
        self.assertIsNotNone(self.new.health_computed_at)
