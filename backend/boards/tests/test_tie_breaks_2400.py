"""Same-instant movement ties in the export readers and stall detection (#2400).

Rows that share a ``moved_at`` (bulk moves, imports) have no defined order unless
the reader breaks the tie on ``id``. The movements prefetch defaults to
``-moved_at``, so a Python re-sort on ``moved_at`` alone kept ties in descending
id order and made an export's movement order, and the ``movement_index`` that
links gate rows to it, arbitrary. Also pins the flow-metrics empty-flow rule that
the docs state: a gated stage reports null work/wait percentiles when the request
selected no cards.
"""
import datetime
import json

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


class _Base(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="tie2400", password="pw")
        self.board = Board.objects.create(name="Ties", owner=self.user)
        BoardMembership.objects.create(board=self.board, user=self.user, role="admin")
        self.todo = Column.objects.create(board=self.board, name="To Do", position=0)
        self.doing = Column.objects.create(board=self.board, name="Doing", position=1)
        self.done = Column.objects.create(board=self.board, name="Done", position=2, is_done=True)
        self.lane = Swimlane.objects.create(board=self.board, name="Lane", position=0)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _tied(self, card, steps, at):
        """Create one movement per (from, to) step, all at the same instant, in id order."""
        mvs = [
            CardMovement.objects.create(
                card=card, board=self.board, from_column=src, to_column=dst, moved_by=self.user,
            )
            for src, dst in steps
        ]
        CardMovement.objects.filter(pk__in=[m.pk for m in mvs]).update(moved_at=at)
        return mvs


class ExportTieOrderTests(_Base):
    def test_tied_movements_export_in_id_order_and_gate_rows_link_to_the_right_one(self):
        card = Card.objects.create(
            board=self.board, column=self.doing, swimlane=self.lane, title="T", created_by=self.user,
        )
        CardMovement.objects.filter(card=card).delete()
        first, second, third = self._tied(
            card, [(None, self.todo), (self.todo, self.doing), (self.doing, self.done)], timezone.now(),
        )
        CardGateTransition.objects.create(
            card=card, board=self.board, column=self.doing, kind="pass",
            from_index=0, to_index=1, movement=second,
        )
        resp = self.client.get(f"/api/v1/boards/{self.board.pk}/export/?format=json")
        self.assertEqual(resp.status_code, 200)
        exported = json.loads(resp.content)["cards"][0]
        self.assertEqual([m["to_column"] for m in exported["movements"]], ["To Do", "Doing", "Done"])
        self.assertEqual(exported["gate_transitions"][0]["movement_index"], 1)
        self.assertEqual(
            list(CardMovement.objects.filter(card=card).order_by("id").values_list("pk", flat=True)),
            [first.pk, second.pk, third.pk],
        )


class StallTieBreakTests(_Base):
    def test_last_col_id_picks_the_latest_id_movement_at_a_tie(self):
        card = Card.objects.create(
            board=self.board, column=self.doing, swimlane=self.lane, title="Stuck", created_by=self.user,
        )
        CardMovement.objects.filter(card=card).delete()
        # Two moves at one instant: the earlier id lands in Done, the later one in Doing.
        self._tied(card, [(self.todo, self.done), (self.done, self.doing)], timezone.now() - 20 * DAY)
        data = self.client.get(f"/api/v1/boards/{self.board.pk}/analytics/").json()
        stalled = {c["title"] for sw in data["swimlanes"] for c in sw["stalled_cards"]}
        self.assertEqual(stalled, {"Stuck"})


class EmptyFlowGatedStageTests(_Base):
    def test_gated_stage_percentiles_are_null_when_the_request_selected_no_cards(self):
        for i, name in enumerate(["Doing", "Review", "Ready"]):
            SubColumn.objects.create(column=self.doing, position=i, name=name)
        other_lane = Swimlane.objects.create(board=self.board, name="Empty", position=1)
        flow = fm.load_board_flow(self.board, swimlane_id=other_lane.pk, now=timezone.now())
        columns = {c["column_uid"]: c for c in fm.completed_dwell(flow, fm.rolling_range(30, zone=UTC))["columns"]}
        # The stage is gated, but with no cards selected its gates are not read.
        self.assertIsNone(columns[self.doing.uid]["work_percentiles"])
        self.assertIsNone(columns[self.doing.uid]["wait_percentiles"])
