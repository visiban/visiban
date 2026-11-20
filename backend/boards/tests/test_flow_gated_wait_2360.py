"""Flow metrics split a gated stage's dwell into work and wait (#2360, #1102).

#1102: in a stage with sub-columns, the sub-columns before the last count as
work time and the last counts as wait time. The split is read from the
recorded gate history: the movement's ``to_gates_passed`` on entry, then each
in-place ``CardGateTransition``. A stage with no sub-columns reports no split.
"""
import datetime

from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, CardGateTransition, CardMovement, Column, SubColumn, Swimlane,
)
from boards.services import flow_metrics as fm

DAY = datetime.timedelta(days=1)


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
        # The gates the move placed it past: already its to_gates_passed, not re-read.
        self._gate(card, 0, 1, t1, movement=entry)
        self._gate(card, 1, 2, t1, movement=entry)
        self._gate(card, 2, 1, t1 + DAY)
        self._move(card, self.build, self.done, t1 + 3 * DAY)
        return card

    def _flow(self):
        return fm.load_board_flow(self.board, now=self.now)

    def _range(self):
        return fm.rolling_range(30, now=self.now)

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
