"""#459: ``column_entered_at`` is the start of the card's open visit.

The bottleneck overlay's browser side only computes ``now - column_entered_at``
and a median, so every rule of the *Flow metric definitions* ADR (open visits,
column keys, broken continuity, misdated rows) has to hold in this one value.
Each test below is one row of that record.
"""
import datetime
from unittest.mock import patch

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, CardMovement, Column, Swimlane,
)
from boards.serializers import (
    CardSerializer, PublicBoardSerializer, _annotate_column_entered_at, _card_queryset,
    _column_entered_at,
)


class _Fixture:
    """Shared board and helpers; a plain mixin so it is not collected."""

    def setUp(self):
        self.user = User.objects.create_user(username="ce459", password="x")
        self.board = Board.objects.create(name="Dwell", owner=self.user)
        BoardMembership.objects.create(board=self.board, user=self.user, role="admin")
        self.todo = Column.objects.create(board=self.board, name="Todo", position=0, allow_card_creation=True)
        self.doing = Column.objects.create(board=self.board, name="Doing", position=1)
        self.done = Column.objects.create(board=self.board, name="Done", position=2, is_done=True)
        self.lane = Swimlane.objects.create(board=self.board, name="A", position=0)
        self.lane2 = Swimlane.objects.create(board=self.board, name="B", position=1)
        self.now = timezone.now()
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def days_ago(self, days):
        return self.now - datetime.timedelta(days=days)

    def card(self, column=None, **kwargs):
        return Card.objects.create(
            board=self.board, column=column or self.todo, swimlane=self.lane,
            title="c", created_by=self.user, position=0, **kwargs,
        )

    def row(self, card, when, *, src=None, dst=None, mtype=CardMovement.MovementType.MOVE, **extra):
        """Write one movement dated ``when``; ``src``/``dst`` are ``Column``s or None."""
        fields = {
            "from_column": src, "from_column_name": src.name if src else "",
            "from_column_uid": src.uid if src else "",
            "to_column": dst, "to_column_name": dst.name if dst else "",
            "to_column_uid": dst.uid if dst else "",
            "to_swimlane": self.lane, "from_swimlane": self.lane,
            "moved_by": self.user, "movement_type": mtype,
        }
        fields.update(extra)
        mv = CardMovement.objects.create(card=card, **fields)
        CardMovement.objects.filter(pk=mv.pk).update(moved_at=when)
        return mv

    def create_row(self, card, when, dst=None):
        return self.row(card, when, dst=dst or card.column)

    def entered(self, card):
        return _card_queryset(Card.objects.filter(pk=card.pk)).get()._column_entered_at


class OpenVisitTests(_Fixture, TestCase):
    def test_creation_movement_opens_the_visit(self):
        card = self.card()
        self.create_row(card, self.days_ago(4))
        self.assertEqual(self.entered(card), self.days_ago(4))

    def test_transition_opens_a_new_visit(self):
        card = self.card(column=self.doing)
        self.create_row(card, self.days_ago(9), dst=self.todo)
        self.row(card, self.days_ago(2), src=self.todo, dst=self.doing)
        self.assertEqual(self.entered(card), self.days_ago(2))

    def test_swimlane_only_move_does_not_reset(self):
        """The reason last_moved_at cannot serve: this row moves last_moved_at."""
        card = self.card()
        self.create_row(card, self.days_ago(6))
        self.row(card, self.days_ago(1), src=self.todo, dst=self.todo, to_swimlane=self.lane2)
        fresh = _card_queryset(Card.objects.filter(pk=card.pk)).get()
        self.assertEqual(fresh._last_moved_at, self.days_ago(1))
        self.assertEqual(fresh._column_entered_at, self.days_ago(6))

    def test_restore_opens_a_new_visit(self):
        card = self.card()
        self.create_row(card, self.days_ago(20))
        self.row(card, self.days_ago(10), src=self.todo, dst=self.todo, mtype="archived")
        self.row(card, self.days_ago(3), src=self.todo, dst=self.todo, mtype="unarchived")
        self.assertEqual(self.entered(card), self.days_ago(3))

    def test_reopen_opens_a_new_visit(self):
        card = self.card(column=self.doing)
        self.create_row(card, self.days_ago(30), dst=self.todo)
        self.row(card, self.days_ago(20), src=self.todo, dst=self.done)
        self.row(card, self.days_ago(5), src=self.done, dst=self.doing)
        self.assertEqual(self.entered(card), self.days_ago(5))

    def _tied_rows(self, card, when, destinations, *, reverse_write):
        """Rows that all tie on ``moved_at``, each moving on to the next column.

        The stored order is what a sort with no ``id`` tiebreak falls back on, so it
        is written both ways round: an engine returning the first or the last row of
        a tie gets one of the two wrong. An UPDATE rewrites the row, which is what
        makes the write order the stored order.
        """
        rows = []
        source = None
        for destination in destinations:
            rows.append(self.row(card, self.days_ago(100), src=source, dst=destination))
            source = destination
        for mv in reversed(rows) if reverse_write else rows:
            CardMovement.objects.filter(pk=mv.pk).update(moved_at=when)

    def test_tie_on_moved_at_is_broken_by_id(self):
        """Movement order is (moved_at, id): the highest id is the latest row."""
        when = self.days_ago(3)
        for reverse_write in (False, True):
            with self.subTest(reverse_write=reverse_write):
                # Ends in the card's column: measured, whatever a tie's other rows say.
                ends_here = self.card(column=self.doing)
                self._tied_rows(ends_here, when, [self.todo, self.done, self.doing], reverse_write=reverse_write)
                self.assertEqual(self.entered(ends_here), when)
                # Passes through the card's column first: the latest row points away.
                ends_away = self.card(column=self.doing)
                self._tied_rows(ends_away, when, [self.doing, self.done, self.todo], reverse_write=reverse_write)
                self.assertIsNone(self.entered(ends_away))


class NotMeasuredTests(_Fixture, TestCase):
    def test_no_movement_is_null(self):
        self.assertIsNone(self.entered(self.card()))

    def test_done_column_is_null(self):
        card = self.card(column=self.done)
        self.create_row(card, self.days_ago(2))
        self.assertIsNone(self.entered(card))

    def test_archived_is_null(self):
        card = self.card(archived_at=self.now)
        self.create_row(card, self.days_ago(2))
        self.assertIsNone(self.entered(card))

    def test_archived_set_in_admin_without_a_row_is_null(self):
        card = self.card()
        self.create_row(card, self.days_ago(2))
        Card.objects.filter(pk=card.pk).update(archived_at=self.now)
        self.assertIsNone(self.entered(card))

    def test_archive_event_on_an_unarchived_card_closed_the_visit(self):
        """Admin cleared archived_at: nothing opened a visit after the event."""
        card = self.card()
        self.create_row(card, self.days_ago(5))
        self.row(card, self.days_ago(1), src=self.todo, dst=self.todo, mtype="archived")
        self.assertIsNone(self.entered(card))

    def test_column_edited_without_a_movement_is_null(self):
        card = self.card()
        self.create_row(card, self.days_ago(5))
        Card.objects.filter(pk=card.pk).update(column=self.doing)
        self.assertIsNone(self.entered(card))

    def test_only_a_future_row_is_null(self):
        card = self.card()
        self.create_row(card, self.now + datetime.timedelta(days=2))
        self.assertIsNone(self.entered(card))

    def test_future_row_is_ignored_and_the_earlier_visit_stands(self):
        """A future-dated move cannot produce a negative dwell or end a visit."""
        card = self.card()
        self.create_row(card, self.days_ago(4))
        self.row(card, self.now + datetime.timedelta(days=2), src=self.todo, dst=self.doing)
        self.assertEqual(self.entered(card), self.days_ago(4))


class ColumnKeyTests(_Fixture, TestCase):
    def test_unknown_destination_is_unattributable_and_opens_nothing(self):
        card = self.card()
        self.create_row(card, self.days_ago(8))
        self.row(card, self.days_ago(1), src=self.todo, dst=None)
        self.assertEqual(self.entered(card), self.days_ago(8))

    def test_empty_source_on_a_later_row_is_not_a_creation(self):
        """#2052: an import loses the name of a deleted source column."""
        card = self.card(column=self.doing)
        self.create_row(card, self.days_ago(8), dst=self.todo)
        self.row(card, self.days_ago(1), src=None, dst=self.doing)
        # The row is unattributable, so the Todo visit is the open one, and Todo
        # is not the card's column: not measured.
        self.assertIsNone(self.entered(card))

    def test_a_name_never_matches_a_current_column(self):
        """A column deleted and recreated under one name is a different column.

        The name is the column's own uid on purpose: an unmarked name key would then
        compare equal to the current column, which is what the ``name:`` mark prevents.
        """
        card = self.card()
        self.row(card, self.days_ago(5), dst=None, to_column_name=self.todo.uid)
        self.assertIsNone(self.entered(card))

    def test_fk_supplies_the_key_when_the_uid_snapshot_is_empty(self):
        card = self.card()
        self.row(card, self.days_ago(5), dst=self.todo, to_column_uid="")
        self.assertEqual(self.entered(card), self.days_ago(5))

    def test_uid_snapshot_differing_from_a_name_key_is_a_transition(self):
        """A deleted source known only by name still has a key, so this transitions.

        Named with the destination's uid on purpose: an unmarked name key would make
        the two ends equal and the row a swimlane-only move.
        """
        card = self.card()
        self.row(card, self.days_ago(3), dst=self.todo, from_column_name=self.todo.uid)
        self.assertEqual(self.entered(card), self.days_ago(3))

    def test_same_name_key_on_both_ends_is_not_a_transition(self):
        card = self.card()
        self.create_row(card, self.days_ago(9))
        self.row(
            card, self.days_ago(1), dst=None,
            from_column_name="Gone", to_column_name="Gone",
        )
        self.assertEqual(self.entered(card), self.days_ago(9))


class ApiTests(_Fixture, TestCase):
    """The value on the wire, through the real write paths."""

    def _create(self):
        res = self.client.post(
            f"/api/v1/boards/{self.board.pk}/cards/",
            {"title": "x", "column": self.todo.pk, "swimlane": self.lane.pk},
            format="json",
        )
        self.assertEqual(res.status_code, 201, res.content)
        return res.data

    def _move(self, card_id, column, swimlane, version):
        res = self.client.post(
            f"/api/v1/boards/{self.board.pk}/cards/{card_id}/move/",
            {"column_id": column.pk, "swimlane_id": swimlane.pk, "position": 0, "version": version},
            format="json",
        )
        self.assertEqual(res.status_code, 200, res.content)
        return res.data["card"]

    def test_create_response_carries_the_creation_time(self):
        data = self._create()
        self.assertIsNotNone(data["column_entered_at"])

    def test_move_responses_follow_the_visit(self):
        created = self._create()
        first = created["column_entered_at"]

        lane_only = self._move(created["id"], self.todo, self.lane2, created["version"])
        self.assertEqual(lane_only["column_entered_at"], first)

        moved = self._move(created["id"], self.doing, self.lane2, lane_only["version"])
        self.assertGreater(moved["column_entered_at"], first)

        done = self._move(created["id"], self.done, self.lane2, moved["version"])
        self.assertIsNone(done["column_entered_at"])

    def test_same_cell_reorder_keeps_the_value(self):
        created = self._create()
        again = self._move(created["id"], self.todo, self.lane, created["version"])
        self.assertEqual(again["column_entered_at"], created["column_entered_at"])

    def test_archive_and_restore_through_the_api(self):
        created = self._create()
        res = self.client.post(f"/api/v1/boards/{self.board.pk}/cards/{created['id']}/archive/")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertIsNone(res.data["column_entered_at"])
        res = self.client.post(f"/api/v1/boards/{self.board.pk}/cards/{created['id']}/unarchive/")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertGreater(res.data["column_entered_at"], created["column_entered_at"])

    def test_board_full_and_cross_board_query_agree(self):
        created = self._create()
        full = self.client.get(f"/api/v1/boards/{self.board.pk}/full/")
        self.assertEqual(full.status_code, 200)
        self.assertEqual(full.data["cards"][0]["column_entered_at"], created["column_entered_at"])
        query = self.client.get("/api/v1/cards/", {"board": self.board.pk})
        self.assertEqual(query.status_code, 200)
        self.assertEqual(query.data["results"][0]["column_entered_at"], created["column_entered_at"])

    def test_field_is_read_only(self):
        created = self._create()
        res = self.client.patch(
            f"/api/v1/boards/{self.board.pk}/cards/{created['id']}/",
            {"column_entered_at": "2001-01-01T00:00:00Z", "version": created["version"]},
            format="json",
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.data["column_entered_at"], created["column_entered_at"])

    def test_public_share_payload_omits_the_field(self):
        """No consumer there: the share page draws no overlay, and its payload is a whitelist."""
        card = self.card()
        self.create_row(card, self.days_ago(1))
        cards = PublicBoardSerializer(self.board).data["cards"]
        self.assertEqual(len(cards), 1)
        self.assertNotIn("column_entered_at", cards[0])


class SocketFrameTests(_Fixture, TestCase):
    """The overlay recomputes on socket events, so the frames must carry the value (ADR)."""

    def _frames(self, action):
        with patch("boards.broadcast.broadcast_board_event") as sent, \
                self.captureOnCommitCallbacks(execute=True):
            result = action()
        return result, {call.args[1]: call.args[2] for call in sent.call_args_list}

    def _create(self):
        return self.client.post(
            f"/api/v1/boards/{self.board.pk}/cards/",
            {"title": "x", "column": self.todo.pk, "swimlane": self.lane.pk},
            format="json",
        )

    def test_created_frame(self):
        res, frames = self._frames(self._create)
        self.assertEqual(frames["card.created"]["column_entered_at"], res.data["column_entered_at"])
        self.assertIsNotNone(res.data["column_entered_at"])

    def test_moved_frame(self):
        created = self._create().data
        res, frames = self._frames(lambda: self.client.post(
            f"/api/v1/boards/{self.board.pk}/cards/{created['id']}/move/",
            {"column_id": self.doing.pk, "swimlane_id": self.lane.pk, "position": 0, "version": created["version"]},
            format="json",
        ))
        carried = frames["card.moved"]["card"]["column_entered_at"]
        self.assertEqual(carried, res.data["card"]["column_entered_at"])
        self.assertGreater(carried, created["column_entered_at"])

    def test_updated_frame_keeps_the_value(self):
        created = self._create().data
        _res, frames = self._frames(lambda: self.client.patch(
            f"/api/v1/boards/{self.board.pk}/cards/{created['id']}/",
            {"title": "renamed", "version": created["version"]},
            format="json",
        ))
        self.assertEqual(frames["card.updated"]["column_entered_at"], created["column_entered_at"])

    def test_unarchived_frame_starts_a_new_visit(self):
        created = self._create().data
        self.client.post(f"/api/v1/boards/{self.board.pk}/cards/{created['id']}/archive/")
        _res, frames = self._frames(lambda: self.client.post(
            f"/api/v1/boards/{self.board.pk}/cards/{created['id']}/unarchive/",
        ))
        self.assertGreater(frames["card.unarchived"]["column_entered_at"], created["column_entered_at"])


class QueryCostTests(_Fixture, TestCase):
    def test_board_read_query_count_does_not_grow_with_cards(self):
        """A correlated subquery in the main SELECT: no per-card query."""
        def count():
            ctx = {"board": self.board}
            with CaptureQueriesContext(connection) as captured:
                CardSerializer(
                    _card_queryset(Card.objects.filter(board=self.board)), many=True, context=ctx,
                ).data
            return len(captured)

        for _ in range(2):
            self.create_row(self.card(), self.days_ago(2))
        small = count()
        for _ in range(8):
            self.create_row(self.card(), self.days_ago(2))
        self.assertEqual(count(), small)

    def test_annotation_is_idempotent(self):
        qs = _annotate_column_entered_at(Card.objects.all())
        self.assertIs(_annotate_column_entered_at(qs), qs)

    def test_unannotated_card_gets_the_same_answer(self):
        card = self.card()
        self.create_row(card, self.days_ago(4))
        self.assertEqual(_column_entered_at(card), self.days_ago(4))
        self.assertEqual(
            _column_entered_at(_card_queryset(Card.objects.filter(pk=card.pk)).get()),
            self.days_ago(4),
        )
