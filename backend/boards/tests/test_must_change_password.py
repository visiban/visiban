"""Tests for MustNotHavePendingPasswordChange enforcement (#414).

A user with must_change_password=True must be blocked (403) from all API
endpoints except ChangePasswordView and public/unauthenticated endpoints.
"""

from unittest.mock import patch

from django.test import TestCase
from rest_framework.test import APIClient
from rest_framework import status

from accounts.models import User
from boards.models import Board, BoardMembership, Column, Swimlane


def _make_board(owner):
    board = Board.objects.create(name="Test Board", owner=owner)
    BoardMembership.objects.create(
        board=board, user=owner, role=BoardMembership.Role.ADMIN,
    )
    Column.objects.create(board=board, name="Backlog", position=0)
    Swimlane.objects.create(board=board, name="General", position=0)
    return board


class MustChangePasswordBlocksAPITests(TestCase):
    """Users with must_change_password=True must get 403 on protected endpoints."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="flagged", password="testpass1234",
        )
        self.user.must_change_password = True
        self.user.save(update_fields=["must_change_password"])
        self.board = _make_board(self.user)

        self.client = APIClient()
        self.client.force_authenticate(user=self.user)

    # ------------------------------------------------------------------
    # Board endpoints
    # ------------------------------------------------------------------

    @patch("boards.broadcast.broadcast_board_event")
    def test_board_list_blocked(self, _bc):
        resp = self.client.get("/api/boards/")
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    @patch("boards.broadcast.broadcast_board_event")
    def test_board_detail_blocked(self, _bc):
        resp = self.client.get(f"/api/boards/{self.board.pk}/")
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    @patch("boards.broadcast.broadcast_board_event")
    def test_board_full_blocked(self, _bc):
        resp = self.client.get(f"/api/boards/{self.board.pk}/full/")
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    @patch("boards.broadcast.broadcast_board_event")
    def test_column_list_blocked(self, _bc):
        resp = self.client.get(f"/api/boards/{self.board.pk}/columns/")
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    @patch("boards.broadcast.broadcast_board_event")
    def test_card_list_blocked(self, _bc):
        resp = self.client.get(f"/api/boards/{self.board.pk}/cards/")
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    @patch("boards.broadcast.broadcast_board_event")
    def test_swimlane_list_blocked(self, _bc):
        resp = self.client.get(f"/api/boards/{self.board.pk}/swimlanes/")
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    @patch("boards.broadcast.broadcast_board_event")
    def test_label_list_blocked(self, _bc):
        resp = self.client.get(f"/api/boards/{self.board.pk}/labels/")
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    # ------------------------------------------------------------------
    # Notification endpoints
    # ------------------------------------------------------------------

    def test_notification_list_blocked(self):
        resp = self.client.get("/api/notifications/")
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_notification_mark_read_blocked(self):
        resp = self.client.post("/api/notifications/mark-read/", {"all": True})
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_notification_unread_count_blocked(self):
        resp = self.client.get("/api/notifications/unread-count/")
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    # ------------------------------------------------------------------
    # Account endpoints
    # ------------------------------------------------------------------

    def test_user_search_blocked(self):
        resp = self.client.get("/api/users/?search=test")
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_current_user_view_allowed(self):
        """CurrentUserView is exempt from pending-change gates so the frontend
        can fetch the user object and render the appropriate force-change modal."""
        resp = self.client.get("/api/auth/me/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_pat_list_blocked(self):
        resp = self.client.get("/api/auth/tokens/")
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)


class ChangePasswordViewAllowedTests(TestCase):
    """ChangePasswordView must remain accessible even with must_change_password=True."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="flagged", password="testpass1234",
        )
        self.user.must_change_password = True
        self.user.save(update_fields=["must_change_password"])

        self.client = APIClient()
        self.client.force_authenticate(user=self.user)

    def test_change_password_allowed(self):
        resp = self.client.post("/api/auth/change-password/", {
            "current_password": "testpass1234",
            "new_password": "newsecurepassword123",
        })
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.user.refresh_from_db()
        self.assertFalse(self.user.must_change_password)


class NormalUserNotBlockedTests(TestCase):
    """Users without must_change_password=True should access all endpoints normally."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="normal", password="testpass1234",
        )
        self.board = _make_board(self.user)

        self.client = APIClient()
        self.client.force_authenticate(user=self.user)

    @patch("boards.broadcast.broadcast_board_event")
    def test_board_list_allowed(self, _bc):
        resp = self.client.get("/api/boards/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    @patch("boards.broadcast.broadcast_board_event")
    def test_board_detail_allowed(self, _bc):
        resp = self.client.get(f"/api/boards/{self.board.pk}/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_notification_list_allowed(self):
        resp = self.client.get("/api/notifications/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
