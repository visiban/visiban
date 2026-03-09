"""Tests for boundary and edge values across models and API."""
import datetime
from unittest.mock import patch

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, Column, Swimlane


PATCH_BROADCAST = "boards.views.broadcast_board_event"


def _make_board(owner):
    board = Board.objects.create(name="B", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col, swim


class CardTitleBoundaryTests(TestCase):
    """Card.title has max_length=500."""

    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, self.swim = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    @patch(PATCH_BROADCAST)
    def test_card_title_max_length(self, _):
        title = "A" * 500
        resp = self.client.post(
            f"/api/boards/{self.board.id}/cards/",
            {"title": title, "column": self.col.id, "swimlane": self.swim.id},
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(len(resp.json()["title"]), 500)

    def test_card_title_exceeds_max_length(self):
        title = "A" * 501
        resp = self.client.post(
            f"/api/boards/{self.board.id}/cards/",
            {"title": title, "column": self.col.id, "swimlane": self.swim.id},
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    @patch(PATCH_BROADCAST)
    def test_card_empty_description_allowed(self, _):
        resp = self.client.post(
            f"/api/boards/{self.board.id}/cards/",
            {"title": "Card", "column": self.col.id, "swimlane": self.swim.id, "description": ""},
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.json()["description"], "")


class ColumnWipLimitBoundaryTests(TestCase):
    """Column.wip_limit is IntegerField(null=True, blank=True)."""

    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, self.swim = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    @patch(PATCH_BROADCAST)
    def test_column_wip_limit_zero(self, _):
        """WIP limit of 0 is a valid value (stored as-is)."""
        resp = self.client.patch(
            f"/api/boards/{self.board.id}/columns/{self.col.id}/",
            {"wip_limit": 0},
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.col.refresh_from_db()
        self.assertEqual(self.col.wip_limit, 0)

    @patch(PATCH_BROADCAST)
    def test_column_wip_limit_large_value(self, _):
        resp = self.client.patch(
            f"/api/boards/{self.board.id}/columns/{self.col.id}/",
            {"wip_limit": 999999},
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.col.refresh_from_db()
        self.assertEqual(self.col.wip_limit, 999999)

    @patch(PATCH_BROADCAST)
    def test_column_wip_limit_null(self, _):
        """Null WIP limit means unlimited."""
        self.col.wip_limit = 5
        self.col.save()
        resp = self.client.patch(
            f"/api/boards/{self.board.id}/columns/{self.col.id}/",
            {"wip_limit": None},
            format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.col.refresh_from_db()
        self.assertIsNone(self.col.wip_limit)


class CardWeightBoundaryTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, self.swim = _make_board(self.user)
        self.card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Card", created_by=self.user, position=0,
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    @patch(PATCH_BROADCAST)
    def test_card_weight_zero(self, _):
        resp = self.client.patch(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/",
            {"weight": 0},
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.card.refresh_from_db()
        self.assertEqual(self.card.weight, 0)


class CardDueDateBoundaryTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, self.swim = _make_board(self.user)
        self.card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Card", created_by=self.user, position=0,
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    @patch(PATCH_BROADCAST)
    def test_card_due_date_far_past(self, _):
        resp = self.client.patch(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/",
            {"due_date": "2000-01-01"},
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.card.refresh_from_db()
        self.assertEqual(self.card.due_date, datetime.date(2000, 1, 1))

    @patch(PATCH_BROADCAST)
    def test_card_due_date_far_future(self, _):
        resp = self.client.patch(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/",
            {"due_date": "2099-12-31"},
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.card.refresh_from_db()
        self.assertEqual(self.card.due_date, datetime.date(2099, 12, 31))


class BoardEmptyStateModelTests(TestCase):
    """Board with no columns or no swimlanes should be a valid state."""

    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_board_with_no_columns(self):
        """A board created via API gets default columns, but deleting them all is valid."""
        board = Board.objects.create(name="Empty Board", owner=self.user)
        BoardMembership.objects.create(board=board, user=self.user, role=BoardMembership.Role.ADMIN)
        # No columns — full view should still work
        resp = self.client.get(f"/api/boards/{board.id}/full/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.json()["columns"], [])

    def test_board_with_no_swimlanes(self):
        board = Board.objects.create(name="No Swimlanes", owner=self.user)
        BoardMembership.objects.create(board=board, user=self.user, role=BoardMembership.Role.ADMIN)
        resp = self.client.get(f"/api/boards/{board.id}/full/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.json()["swimlanes"], [])
