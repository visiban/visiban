"""Movement history pages are stable at same-instant ties (#2400).

The board ``/movements/`` endpoint and the card ``/timeline/`` endpoint both
page by offset. Ordering by ``moved_at`` alone leaves rows that share a
timestamp (bulk moves, imports) in no defined order, so two page reads could
return one row twice and skip another. Both now break the tie on ``id``.
"""
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, CardMovement, Column, Swimlane


class _TiedMovementsBase(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="admin2400", password="pw")
        self.board = Board.objects.create(name="Ties", owner=self.user)
        BoardMembership.objects.create(board=self.board, user=self.user, role="admin")
        self.todo = Column.objects.create(board=self.board, name="To Do", position=0)
        self.doing = Column.objects.create(board=self.board, name="Doing", position=1)
        self.lane = Swimlane.objects.create(board=self.board, name="Lane", position=0)
        self.card = Card.objects.create(
            board=self.board, column=self.todo, swimlane=self.lane, title="Tied", created_by=self.user,
        )
        self.client = APIClient()
        self.client.force_authenticate(user=self.user)

    def _tied_movements(self, n, at):
        CardMovement.objects.bulk_create([
            CardMovement(
                card=self.card, board=self.board,
                from_column=self.todo, from_column_name="To Do",
                to_column=self.doing, to_column_name="Doing",
                moved_by=self.user,
            )
            for _ in range(n)
        ])
        CardMovement.objects.filter(card=self.card).update(moved_at=at)
        return [r.pk for r in CardMovement.objects.filter(card=self.card)]


class BoardMovementsTieBreakTests(_TiedMovementsBase):
    def test_same_timestamp_rows_across_a_page_boundary_neither_repeat_nor_skip(self):
        # 70 rows at one instant straddle the 50-row page boundary.
        ids = self._tied_movements(70, timezone.now())
        url = f"/api/v1/boards/{self.board.pk}/movements/"
        first = self.client.get(url)
        second = self.client.get(url, {"offset": 50})
        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        paged = [r["id"] for r in first.data["results"]] + [r["id"] for r in second.data["results"]]
        self.assertEqual(len(paged), 70)
        self.assertEqual(len(set(paged)), 70, "a row appeared on both pages")
        # The order is unique and total: newest id first within the tie.
        self.assertEqual(paged, sorted(ids, reverse=True))

    def test_tie_break_is_below_moved_at(self):
        """``-id`` only orders rows that tie: an older row with a higher id still comes later."""
        now = timezone.now()
        newer = self._tied_movements(1, now)[0]
        older = CardMovement.objects.create(
            card=self.card, board=self.board, from_column=self.todo, to_column=self.doing, moved_by=self.user,
        )
        CardMovement.objects.filter(pk=older.pk).update(moved_at=now - timezone.timedelta(hours=1))
        resp = self.client.get(f"/api/v1/boards/{self.board.pk}/movements/")
        self.assertEqual([r["id"] for r in resp.data["results"]], [newer, older.pk])


class CardTimelineTieBreakTests(_TiedMovementsBase):
    def test_same_timestamp_moves_across_a_page_boundary_neither_repeat_nor_skip(self):
        ids = self._tied_movements(30, timezone.now())
        url = f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/timeline/"
        first = self.client.get(url, {"event_types": "move", "limit": 20})
        second = self.client.get(url, {"event_types": "move", "limit": 20, "offset": 20})
        self.assertEqual(first.status_code, 200, first.content)
        paged = [e["id"] for e in first.json()["results"]] + [e["id"] for e in second.json()["results"]]
        self.assertEqual(len(set(paged)), 30)
        self.assertEqual(paged, sorted(ids, reverse=True))
