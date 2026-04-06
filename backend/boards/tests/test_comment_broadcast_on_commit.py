"""
Tests for #491: comment creation broadcast must fire via transaction.on_commit(),
not immediately, so WebSocket events only fire after the transaction commits.
"""
from unittest.mock import patch

from django.test import TestCase
from rest_framework.test import APIClient
from rest_framework import status

from accounts.models import User
from boards.models import Board, BoardMembership, Card, Column, Swimlane


def make_board(owner):
    board = Board.objects.create(name="Test Board", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    return board


class CommentCreatedBroadcastOnCommitTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="tester", password="pass")
        self.client.force_authenticate(self.user)
        self.board = make_board(self.user)
        self.col = Column.objects.create(board=self.board, name="Backlog", position=0)
        self.swim = Swimlane.objects.create(board=self.board, name="Acme", position=0)
        self.card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Test Card", created_by=self.user, position=0,
        )

    def _comments_url(self):
        return f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/comments/"

    def test_comment_broadcast_fires_after_commit(self):
        """broadcast_board_event for comment creation fires via on_commit, not inside the transaction."""
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.post(self._comments_url(), {"body": "Hello!"})
            self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
            mock_broadcast.assert_called_once()
            event_type = mock_broadcast.call_args[0][1]
            self.assertEqual(event_type, "card.updated")

    def test_comment_broadcast_not_called_before_commit(self):
        """Broadcast must not have fired before on_commit callbacks execute."""
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=False):
                self.client.post(self._comments_url(), {"body": "Hello!"})
                # on_commit callbacks have not run yet
                mock_broadcast.assert_not_called()
