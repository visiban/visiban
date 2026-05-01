"""Tests for BoardViewSet star/unstar action and ?starred= filter."""

from unittest.mock import patch

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardFavorite, BoardMembership


def _make_board(owner, name="Board"):
    board = Board.objects.create(name=name, owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    return board


class BoardStarTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="alice", password="pass")
        self.other = User.objects.create_user(username="bob", password="pass")
        self.board = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    # --- star ---

    def test_star_board_creates_favorite(self):
        r = self.client.post(f"/api/v1/boards/{self.board.id}/star/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertTrue(BoardFavorite.objects.filter(user=self.user, board=self.board).exists())
        self.assertTrue(r.data["is_starred"])

    def test_star_board_is_idempotent(self):
        self.client.post(f"/api/v1/boards/{self.board.id}/star/")
        self.client.post(f"/api/v1/boards/{self.board.id}/star/")
        self.assertEqual(BoardFavorite.objects.filter(user=self.user, board=self.board).count(), 1)

    def test_star_is_per_user(self):
        BoardMembership.objects.create(board=self.board, user=self.other, role=BoardMembership.Role.MEMBER)
        self.client.post(f"/api/v1/boards/{self.board.id}/star/")
        self.assertFalse(BoardFavorite.objects.filter(user=self.other, board=self.board).exists())

    # --- unstar ---

    def test_unstar_board_removes_favorite(self):
        BoardFavorite.objects.create(user=self.user, board=self.board)
        r = self.client.delete(f"/api/v1/boards/{self.board.id}/star/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertFalse(BoardFavorite.objects.filter(user=self.user, board=self.board).exists())
        self.assertFalse(r.data["is_starred"])

    def test_unstar_when_not_starred_is_safe(self):
        r = self.client.delete(f"/api/v1/boards/{self.board.id}/star/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    # --- ?starred= filter ---

    def test_starred_filter_returns_only_starred_boards(self):
        other_board = _make_board(self.user, name="Other Board")
        BoardFavorite.objects.create(user=self.user, board=self.board)
        r = self.client.get("/api/v1/boards/", {"starred": "true"})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        ids = [b["id"] for b in r.data["results"]]
        self.assertIn(self.board.id, ids)
        self.assertNotIn(other_board.id, ids)

    def test_board_list_includes_is_starred_field(self):
        r = self.client.get("/api/v1/boards/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIn("is_starred", r.data["results"][0])

    def test_is_starred_reflects_current_user(self):
        BoardFavorite.objects.create(user=self.user, board=self.board)
        r = self.client.get("/api/v1/boards/")
        board_data = next(b for b in r.data["results"] if b["id"] == self.board.id)
        self.assertTrue(board_data["is_starred"])

        # Other user sees it as not starred
        BoardMembership.objects.create(board=self.board, user=self.other, role=BoardMembership.Role.MEMBER)
        other_client = APIClient()
        other_client.force_authenticate(self.other)
        r2 = other_client.get("/api/v1/boards/")
        board_data2 = next(b for b in r2.data["results"] if b["id"] == self.board.id)
        self.assertFalse(board_data2["is_starred"])

    # --- unauthenticated ---

    def test_star_requires_auth(self):
        anon = APIClient()
        r = anon.post(f"/api/v1/boards/{self.board.id}/star/")
        self.assertIn(r.status_code, [status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN])

    # --- broadcast ---

    def test_star_broadcasts_star_changed(self):
        """star fires board.star_changed via on_commit so other sessions of the same user sync (#814)."""
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.client.post(f"/api/v1/boards/{self.board.id}/star/")
        event_types = [call.args[1] for call in mock_broadcast.call_args_list]
        self.assertIn("board.star_changed", event_types)
        star_call = next(c for c in mock_broadcast.call_args_list if c.args[1] == "board.star_changed")
        payload = star_call.args[2]
        self.assertEqual(payload["uid"], str(self.board.uid))
        self.assertEqual(payload["user_id"], self.user.id)
        self.assertTrue(payload["is_starred"])

    def test_unstar_broadcasts_star_changed_false(self):
        BoardFavorite.objects.create(user=self.user, board=self.board)
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.client.delete(f"/api/v1/boards/{self.board.id}/star/")
        star_call = next(c for c in mock_broadcast.call_args_list if c.args[1] == "board.star_changed")
        payload = star_call.args[2]
        self.assertFalse(payload["is_starred"])
        self.assertEqual(payload["uid"], str(self.board.uid))
