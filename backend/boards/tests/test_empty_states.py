"""Tests for empty state handling: no boards, no cards, no notifications."""
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Column, Swimlane


PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"


def _make_board(owner, name="Board"):
    board = Board.objects.create(name=name, owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col, swim


class DashboardEmptyStateTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_board_list_empty(self):
        """User with no boards should get an empty list, not an error."""
        resp = self.client.get("/api/boards/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data["results"], [])


class BoardNoCardsSummaryTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, self.swim = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_summary_no_cards_returns_zeros(self):
        resp = self.client.get(f"/api/boards/{self.board.id}/summary/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        data = resp.json()
        self.assertIn("swimlanes", data)
        row = data["swimlanes"][0]
        self.assertEqual(row["total_cards"], 0)

    def test_analytics_no_cards_returns_empty_data(self):
        resp = self.client.get(f"/api/boards/{self.board.id}/analytics/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        data = resp.json()
        self.assertIn("swimlanes", data)
        self.assertIn("columns", data)


class BoardNoCardsFullViewTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, self.swim = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_full_view_no_cards(self):
        resp = self.client.get(f"/api/boards/{self.board.id}/full/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        data = resp.json()
        self.assertEqual(data["cards"], [])
        self.assertEqual(len(data["columns"]), 1)
        self.assertEqual(len(data["swimlanes"]), 1)


class NotificationEmptyStateTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_notification_list_empty(self):
        resp = self.client.get("/api/notifications/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data, [])

    def test_unread_count_zero(self):
        resp = self.client.get("/api/notifications/unread-count/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.json()["count"], 0)

    def test_mark_all_read_with_no_notifications(self):
        resp = self.client.post("/api/notifications/mark-read/", {"all": True}, format="json")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
