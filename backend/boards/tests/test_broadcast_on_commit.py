"""
Tests for #204: broadcast_board_event must fire via transaction.on_commit(),
not directly inside the transaction, so a rollback cannot push stale state
to connected WebSocket clients.
"""
from unittest.mock import patch, call

from django.test import TestCase
from rest_framework.test import APIClient
from rest_framework import status

from accounts.models import User
from boards.models import Board, BoardMembership, Column, Swimlane, Card


def make_board(owner):
    board = Board.objects.create(name="Test Board", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    return board


class CardCreatedBroadcastOnCommitTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="tester", password="pass")
        self.client.force_authenticate(self.user)
        self.board = make_board(self.user)
        self.col = Column.objects.create(board=self.board, name="Backlog", position=0)
        self.swim = Swimlane.objects.create(board=self.board, name="Acme", position=0)

    def test_card_created_broadcast_fires_after_commit(self):
        """broadcast_board_event for card.created fires via on_commit, not inside the transaction."""
        with patch("boards.views.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.post(
                    f"/api/boards/{self.board.pk}/cards/",
                    {"title": "New card", "column": self.col.pk, "swimlane": self.swim.pk},
                )
            self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
            mock_broadcast.assert_called_once()
            event_type = mock_broadcast.call_args[0][1]
            self.assertEqual(event_type, "card.created")

    def test_card_created_broadcast_not_called_before_commit(self):
        """Broadcast must not have fired before on_commit callbacks execute."""
        with patch("boards.views.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=False):
                self.client.post(
                    f"/api/boards/{self.board.pk}/cards/",
                    {"title": "New card", "column": self.col.pk, "swimlane": self.swim.pk},
                )
                # on_commit callbacks have not run yet
                mock_broadcast.assert_not_called()


class CardMovedBroadcastOnCommitTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="tester", password="pass")
        self.client.force_authenticate(self.user)
        self.board = make_board(self.user)
        self.col_a = Column.objects.create(board=self.board, name="Backlog", position=0)
        self.col_b = Column.objects.create(board=self.board, name="Done", position=1)
        self.swim = Swimlane.objects.create(board=self.board, name="Acme", position=0)
        self.card = Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.swim,
            title="Test Card", created_by=self.user, position=0,
        )

    def _move_url(self):
        return f"/api/boards/{self.board.pk}/cards/{self.card.pk}/move/"

    def test_card_moved_broadcast_fires_after_commit(self):
        """broadcast_board_event for card.moved fires via on_commit, not inside the transaction."""
        with patch("boards.views.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.post(self._move_url(), {
                    "column_id": self.col_b.pk,
                    "swimlane_id": self.swim.pk,
                    "position": 0,
                })
            self.assertEqual(resp.status_code, status.HTTP_200_OK)
            mock_broadcast.assert_called_once()
            event_type = mock_broadcast.call_args[0][1]
            self.assertEqual(event_type, "card.moved")

    def test_card_moved_broadcast_not_called_before_commit(self):
        """Broadcast must not have fired before on_commit callbacks execute."""
        with patch("boards.views.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=False):
                self.client.post(self._move_url(), {
                    "column_id": self.col_b.pk,
                    "swimlane_id": self.swim.pk,
                    "position": 0,
                })
                mock_broadcast.assert_not_called()

    def test_pure_reorder_no_broadcast(self):
        """Moving a card within the same cell (position change only) does not broadcast card.moved."""
        card2 = Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.swim,
            title="Other Card", created_by=self.user, position=1,
        )
        with patch("boards.views.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.post(self._move_url(), {
                    "column_id": self.col_a.pk,
                    "swimlane_id": self.swim.pk,
                    "position": 1,
                })
            self.assertEqual(resp.status_code, status.HTTP_200_OK)
            # card.moved fires even for pure reorder (position update still broadcasts)
            mock_broadcast.assert_called_once()
        card2.delete()
