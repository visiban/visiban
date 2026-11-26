"""Flow metrics split a gated stage's dwell into work and wait (#2360, #1102).

#1102: in a stage with sub-columns, the sub-columns before the last count as
work time and the last counts as wait time. The split is read from the
recorded gate history: the entering movement's gate rows (or its
``to_gates_passed``), then every later ``CardGateTransition`` in the visit. A stage with no sub-columns reports no split.
"""
import datetime
from unittest import mock

from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, CardGateTransition, CardMovement, Column, SubColumn, Swimlane,
)
from boards.services import flow_metrics as fm

DAY = datetime.timedelta(days=1)

UTC = datetime.timezone.utc


class GatedWaitTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="flow2360", password="pw")
        self.board = Board.objects.create(name="Gated", owner=self.user)
        BoardMembership.objects.create(board=self.board, user=self.user, role="admin")
        self.backlog = Column.objects.create(board=self.board, name="Backlog", position=0)
        self.build = Column.objects.create(board=self.board, name="Build", position=1)
        self.done = Column.objects.create(board=self.board, name="Done", position=2, is_done=True)
        for i, name in enumerate(["Doing", "Review", "Ready to pull"]):
            SubColumn.objects.create(column=self.build, position=i, name=name)
        self.lane = Swimlane.objects.create(board=self.board, name="Lane", position=0)
        self.now = timezone.now()
        self.t0 = self.now - 10 * DAY

    def _card(self, title):
        return Card.objects.create(
            board=self.board, column=self.done, swimlane=self.lane, title=title, created_by=self.user,
        )

    def _move(self, card, src, dst, at, to_gates=None):
        mv = CardMovement.objects.create(
            card=card, board=self.board, from_column=src, to_column=dst, moved_by=self.user,
            to_gates_passed=to_gates,
        )
        CardMovement.objects.filter(pk=mv.pk).update(moved_at=at)
        return mv

    def _gate(self, card, from_index, to_index, at, movement=None):
        CardGateTransition.objects.create(
            card=card, board=self.board, column=self.build,
            kind="pass" if to_index > from_index else "reopen",
            from_index=from_index, to_index=to_index, created_at=at, movement=movement,
        )

    def _crosses_reopens_and_recrosses(self):
        """Enters at Doing, reaches Ready, is reopened to Review, reaches Ready again, leaves."""
        card = self._card("A")
        t1 = self.t0 + DAY
        self._move(card, None, self.backlog, self.t0)
        self._move(card, self.backlog, self.build, t1, to_gates=0)
        self._gate(card, 0, 1, t1 + DAY)
        self._gate(card, 1, 2, t1 + 2 * DAY)   # wait starts
        self._gate(card, 2, 1, t1 + 3 * DAY)   # reopened: back to work
        self._gate(card, 1, 2, t1 + 4 * DAY)   # wait again
        self._move(card, self.build, self.done, t1 + 5 * DAY)
        return card

    def _leaves_with_a_gate_open(self):
        """Placed straight into Ready by its move, reopened, leaves from Review."""
        card = self._card("B")
        t1 = self.t0 + DAY
        self._move(card, None, self.backlog, self.t0)
        entry = self._move(card, self.backlog, self.build, t1, to_gates=2)
        # The gates the move placed it past: its entry position, not in-place changes.
        self._gate(card, 0, 1, t1, movement=entry)
        self._gate(card, 1, 2, t1, movement=entry)
        self._gate(card, 2, 1, t1 + DAY)
        self._move(card, self.build, self.done, t1 + 3 * DAY)
        return card

    def _flow(self):
        return fm.load_board_flow(self.board, now=self.now)

    def test_gate_history_counts_against_the_held_budget(self):
        # The gate rows are held until the cards are analyzed, like the movements (#2428).
        from django.test import override_settings

        from boards.services.analytics_admission import AnalyticsTooLarge, analytics_slot

        self._crosses_reopens_and_recrosses()
        movements = CardMovement.objects.filter(card__board=self.board).count()
        gates = CardGateTransition.objects.filter(card__board=self.board).count()
        # One request's ticket is shared by both reads.
        with override_settings(ANALYTICS_MAX_MOVEMENTS=movements + gates - 1), self.assertRaises(AnalyticsTooLarge):
            with analytics_slot(self.user, board_id=self.board.pk, endpoint="test"):
                self._flow()
        with override_settings(ANALYTICS_MAX_MOVEMENTS=movements + gates):
            with analytics_slot(self.user, board_id=self.board.pk, endpoint="test") as ticket:
                self._flow()
        self.assertEqual(ticket.movements, movements + gates)
        # With no slot each read gets its own budget, never an unlimited one (#1075).
        with override_settings(ANALYTICS_MAX_MOVEMENTS=gates - 1), self.assertRaises(AnalyticsTooLarge):
            fm._attach_wait([], Card.objects.filter(board=self.board), {"x": 1}, self.now)

    def _range(self):
        return fm.rolling_range(30, now=self.now, zone=UTC)

    def test_completed_dwell_splits_the_gated_visit(self):
        a = self._crosses_reopens_and_recrosses()
        b = self._leaves_with_a_gate_open()
        samples = fm.completed_dwell(self._flow(), self._range())["samples"]
        build = {s["card_uid"]: s for s in samples if s["column_uid"] == self.build.uid}
        self.assertAlmostEqual(build[a.uid]["value_days"], 5.0)
        self.assertAlmostEqual(build[a.uid]["wait_days"], 2.0)
        self.assertAlmostEqual(build[a.uid]["work_days"], 3.0)
        self.assertAlmostEqual(build[b.uid]["wait_days"], 1.0)
        self.assertAlmostEqual(build[b.uid]["work_days"], 2.0)

    def test_a_stage_with_no_sub_columns_has_no_split(self):
        a = self._crosses_reopens_and_recrosses()
        response = fm.completed_dwell(self._flow(), self._range())
        backlog = [s for s in response["samples"] if s["column_uid"] == self.backlog.uid]
        self.assertEqual(backlog[0]["card_uid"], a.uid)
        self.assertAlmostEqual(backlog[0]["value_days"], 1.0)
        self.assertIsNone(backlog[0]["wait_days"])
        self.assertIsNone(backlog[0]["work_days"])
        columns = {c["column_uid"]: c for c in response["columns"]}
        self.assertIsNone(columns[self.backlog.uid]["wait_percentiles"])
        self.assertIsNone(columns[self.backlog.uid]["work_percentiles"])
        # A dict for the gated stage (its percentiles need more samples than one to be numbers).
        self.assertEqual(set(columns[self.build.uid]["wait_percentiles"]), {"p50", "p85", "p95"})

    def test_cycle_time_carries_wait_and_work_without_changing_its_value(self):
        a = self._crosses_reopens_and_recrosses()
        sample = next(s for s in fm.cycle_time(self._flow(), self._range())["samples"] if s["card_uid"] == a.uid)
        self.assertAlmostEqual(sample["value_days"], 5.0)
        self.assertAlmostEqual(sample["wait_days"], 2.0)
        self.assertAlmostEqual(sample["work_days"], 3.0)

    def test_board_with_no_gated_stage_reports_zero_wait(self):
        SubColumn.objects.all().delete()
        a = self._crosses_reopens_and_recrosses()
        flow = self._flow()
        self.assertEqual(flow.gate_last, {})
        sample = next(s for s in fm.cycle_time(flow, self._range())["samples"] if s["card_uid"] == a.uid)
        self.assertEqual(sample["wait_days"], 0.0)
        self.assertAlmostEqual(sample["work_days"], sample["value_days"])
        build = next(s for s in fm.completed_dwell(flow, self._range())["samples"] if s["column_uid"] == self.build.uid)
        self.assertIsNone(build["wait_days"])

    def test_open_visit_waits_until_now(self):
        card = Card.objects.create(
            board=self.board, column=self.build, swimlane=self.lane, title="C", created_by=self.user,
        )
        self._move(card, None, self.backlog, self.t0)
        self._move(card, self.backlog, self.build, self.now - 3 * DAY, to_gates=0)
        self._gate(card, 0, 2, self.now - DAY)
        sample = fm.current_dwell(self._flow())["samples"][0]
        self.assertAlmostEqual(sample["wait_days"], 1.0, places=3)
        self.assertAlmostEqual(sample["work_days"], 2.0, places=3)

    def test_heatmap_reports_wait_only_for_gated_stages(self):
        self._crosses_reopens_and_recrosses()
        client = APIClient()
        client.force_authenticate(self.user)
        resp = client.get(f"/api/v1/boards/{self.board.pk}/analytics/", {"days": 30})
        self.assertEqual(resp.status_code, 200, resp.content)
        lane = resp.data["swimlanes"][0]
        self.assertEqual(lane["throughput_wait_avg_days_per_column"], {"Build": 2.0})
        self.assertEqual(lane["age_wait_avg_days_per_column"], {"Build": None})
        self.assertNotIn("Backlog", lane["throughput_wait_avg_days_per_column"])


class GatedWaitThroughTheMoveApiTests(TestCase):
    """The split read from rows the real move, archive and restore paths write.

    Each step goes through the API, then its rows are re-dated: the code under
    test only reads timestamps, and the rows' shape (which movement a gate row
    is linked to, its sub-column uid, its ``to_gates_passed``) is what the
    write paths decide.
    """

    def setUp(self):
        patcher = mock.patch("boards.broadcast.broadcast_board_event")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.user = User.objects.create_user(username="flow2360api", password="pw")
        self.board = Board.objects.create(name="Gated API", owner=self.user)
        BoardMembership.objects.create(board=self.board, user=self.user, role="admin")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.backlog = Column.objects.create(board=self.board, name="Backlog", position=0)
        self.build = Column.objects.create(board=self.board, name="Build", position=1)
        self.subs = [
            SubColumn.objects.create(column=self.build, position=i, name=name)
            for i, name in enumerate(["Doing", "Review", "Ready to pull"])
        ]
        self.lane = Swimlane.objects.create(board=self.board, name="Lane", position=0)
        self.lane2 = Swimlane.objects.create(board=self.board, name="Lane 2", position=1)
        self.now = timezone.now()
        self.card = Card.objects.create(
            board=self.board, column=self.backlog, swimlane=self.lane, title="A", created_by=self.user,
        )
        CardMovement.objects.create(card=self.card, board=self.board, to_column=self.backlog, moved_by=self.user)
        self._redate(self.now - 10 * DAY, since=(0, 0))

    def _marks(self):
        last_mv = CardMovement.objects.order_by("-pk").values_list("pk", flat=True).first() or 0
        last_gate = CardGateTransition.objects.order_by("-pk").values_list("pk", flat=True).first() or 0
        return last_mv, last_gate

    def _redate(self, when, since):
        CardMovement.objects.filter(pk__gt=since[0]).update(moved_at=when)
        CardGateTransition.objects.filter(pk__gt=since[1]).update(created_at=when)

    def _step(self, when, path, body=None):
        since = self._marks()
        url = f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/{path}/"
        resp = self.client.post(url, body or {}, format="json")
        self.assertEqual(resp.status_code, 200, resp.content)
        self._redate(when, since)

    def _move(self, when, column, lane=None, **extra):
        body = {"column_id": column.pk, "swimlane_id": (lane or self.lane).pk, "position": 0, **extra}
        self._step(when, "move", body)

    def _open_sample(self):
        samples = fm.current_dwell(fm.load_board_flow(self.board, now=self.now))["samples"]
        self.assertEqual(len(samples), 1, samples)
        return samples[0]

    def test_a_gate_changed_by_a_lane_move_inside_the_stage_counts(self):
        self._move(self.now - 3 * DAY, self.build)
        self._move(self.now - DAY, self.build, lane=self.lane2, gates_passed=2)
        # The lane move wrote the gate rows, linked to its movement.
        lane_move = CardMovement.objects.latest("id")
        self.assertEqual(CardGateTransition.objects.filter(movement=lane_move).count(), 2)
        sample = self._open_sample()
        self.assertAlmostEqual(sample["wait_days"], 1.0, places=3)
        self.assertAlmostEqual(sample["work_days"], 2.0, places=3)

    def test_entering_past_gates_counts_from_the_entry(self):
        self._move(self.now - 2 * DAY, self.build, gates_passed=2)
        sample = self._open_sample()
        self.assertAlmostEqual(sample["wait_days"], 2.0, places=3)
        self.assertAlmostEqual(sample["work_days"], 0.0, places=3)

    def test_a_restored_card_resumes_its_sub_column(self):
        self._move(self.now - 4 * DAY, self.build, gates_passed=2)
        self._step(self.now - 3 * DAY, "archive")
        self._step(self.now - DAY, "unarchive")
        restore = CardMovement.objects.latest("id")
        self.assertEqual(restore.movement_type, CardMovement.MovementType.UNARCHIVED)
        self.assertIsNone(restore.to_gates_passed)  # the restore path never writes it
        sample = self._open_sample()
        self.assertAlmostEqual(sample["wait_days"], 1.0, places=3)
        self.assertAlmostEqual(sample["work_days"], 0.0, places=3)

    def test_rows_without_gate_recording_fall_back_to_the_index(self):
        """A pre-1.3 entry has no ``to_gates_passed`` and old rows no sub-column uid."""
        self._move(self.now - 3 * DAY, self.build)
        self._move(self.now - DAY, self.build, gates_passed=2)
        CardMovement.objects.filter(card=self.card).update(to_gates_passed=None)
        CardGateTransition.objects.update(sub_column_uid="")
        sample = self._open_sample()
        self.assertAlmostEqual(sample["wait_days"], 1.0, places=3)
        self.assertAlmostEqual(sample["work_days"], 2.0, places=3)

    def test_gates_passed_at_once_share_a_timestamp_and_read_in_write_order(self):
        self._move(self.now - 3 * DAY, self.build)
        self._move(self.now - DAY, self.build, gates_passed=2)
        rows = list(CardGateTransition.objects.filter(card=self.card).order_by("id").values_list("created_at", "to_index"))
        self.assertEqual([to for _, to in rows], [1, 2])
        self.assertEqual(rows[0][0], rows[1][0])
        sample = self._open_sample()
        self.assertAlmostEqual(sample["wait_days"], 1.0, places=3)

    def _reorder_ready_before_review(self):
        """What a sub-column reorder does (#2368): re-index, no gate row."""
        review, ready = self.subs[1], self.subs[2]
        SubColumn.objects.filter(pk=ready.pk).update(position=9)
        SubColumn.objects.filter(pk=review.pk).update(position=2)
        SubColumn.objects.filter(pk=ready.pk).update(position=1)
        Card.objects.filter(pk=self.card.pk).update(gates_passed=1)

    def test_attribution_follows_the_sub_column_through_a_reorder(self):
        self._move(self.now - 3 * DAY, self.build)
        self._move(self.now - 2 * DAY, self.build, gates_passed=2)  # into Ready to pull
        self._reorder_ready_before_review()
        # Ready to pull is no longer last, so its time is work; by index it would be wait.
        sample = self._open_sample()
        self.assertAlmostEqual(sample["wait_days"], 0.0, places=3)
        self.assertAlmostEqual(sample["work_days"], 3.0, places=3)

    def test_the_entry_position_follows_the_sub_column_through_a_reorder(self):
        self._move(self.now - 2 * DAY, self.build, gates_passed=1)  # entered into Review
        self._reorder_ready_before_review()
        # Review is now last: the entering move's own rows name it.
        sample = self._open_sample()
        self.assertAlmostEqual(sample["wait_days"], 2.0, places=3)
