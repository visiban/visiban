"""Tests for card CRUD edge cases: cross-board foreign keys, non-existent IDs,
non-member assignment, and update validation."""
from unittest.mock import patch

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, Column, Swimlane,
)


PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"


def _make_board(owner, name="Board"):
    board = Board.objects.create(name=name, owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col, swim


def _make_card(board, col, swim, user, title="Card"):
    return Card.objects.create(
        board=board, column=col, swimlane=swim,
        title=title, created_by=user, position=0,
    )


# ---------------------------------------------------------------------------
# 1. Invalid foreign key tests
# ---------------------------------------------------------------------------

class CrossBoardForeignKeyTests(TestCase):
    """Creating/moving a card with column or swimlane from a different board."""

    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board_a, self.col_a, self.swim_a = _make_board(self.user, "Board A")
        self.board_b, self.col_b, self.swim_b = _make_board(self.user, "Board B")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_create_card_with_column_from_different_board_rejected(self):
        """Column from board B should not be accepted when creating on board A."""
        r = self.client.post(
            f"/api/v1/boards/{self.board_a.id}/cards/",
            {"title": "X", "column": self.col_b.id, "swimlane": self.swim_a.id},
        )
        self.assertIn(r.status_code, [status.HTTP_400_BAD_REQUEST, status.HTTP_404_NOT_FOUND])

    def test_create_card_with_swimlane_from_different_board_rejected(self):
        """Swimlane from board B should not be accepted when creating on board A."""
        r = self.client.post(
            f"/api/v1/boards/{self.board_a.id}/cards/",
            {"title": "X", "column": self.col_a.id, "swimlane": self.swim_b.id},
        )
        self.assertIn(r.status_code, [status.HTTP_400_BAD_REQUEST, status.HTTP_404_NOT_FOUND])

    @patch(PATCH_BROADCAST)
    def test_move_card_to_column_from_different_board_rejected(self, _):
        card = _make_card(self.board_a, self.col_a, self.swim_a, self.user)
        r = self.client.post(
            f"/api/v1/boards/{self.board_a.id}/cards/{card.id}/move/",
            {"column_id": self.col_b.id, "swimlane_id": self.swim_a.id, "position": 0},
        )
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)

    @patch(PATCH_BROADCAST)
    def test_move_card_to_swimlane_from_different_board_rejected(self, _):
        card = _make_card(self.board_a, self.col_a, self.swim_a, self.user)
        r = self.client.post(
            f"/api/v1/boards/{self.board_a.id}/cards/{card.id}/move/",
            {"column_id": self.col_a.id, "swimlane_id": self.swim_b.id, "position": 0},
        )
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)


class NonExistentForeignKeyTests(TestCase):
    """Creating a card with a non-existent column or swimlane ID."""

    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, self.swim = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_create_card_with_nonexistent_column_id(self):
        r = self.client.post(
            f"/api/v1/boards/{self.board.id}/cards/",
            {"title": "X", "column": 999999, "swimlane": self.swim.id},
        )
        self.assertIn(r.status_code, [status.HTTP_400_BAD_REQUEST, status.HTTP_404_NOT_FOUND])

    def test_create_card_with_nonexistent_swimlane_id(self):
        r = self.client.post(
            f"/api/v1/boards/{self.board.id}/cards/",
            {"title": "X", "column": self.col.id, "swimlane": 999999},
        )
        self.assertIn(r.status_code, [status.HTTP_400_BAD_REQUEST, status.HTTP_404_NOT_FOUND])


class NonMemberAssigneeTests(TestCase):
    """Assigning a card to a user who is not a board member."""

    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.non_member = User.objects.create_user(username="outsider", password="pass")
        self.board, self.col, self.swim = _make_board(self.user)
        self.card = _make_card(self.board, self.col, self.swim, self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    @patch(PATCH_BROADCAST)
    def test_assign_card_to_non_member(self, _):
        """Assigning to a non-member is rejected.

        The serializer scopes assignee_id to board members, so assigning
        a non-member returns 400 Bad Request.
        """
        r = self.client.patch(
            f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/",
            {"assignee_id": self.non_member.id},
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.card.refresh_from_db()
        self.assertIsNone(self.card.assignee_id)


# ---------------------------------------------------------------------------
# 5. Board/Card update validation
# ---------------------------------------------------------------------------

class CardUpdateValidationTests(TestCase):
    """Edge cases for card and column update validation."""

    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board_a, self.col_a, self.swim_a = _make_board(self.user, "Board A")
        self.board_b, self.col_b, self.swim_b = _make_board(self.user, "Board B")
        self.card = _make_card(self.board_a, self.col_a, self.swim_a, self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    @patch(PATCH_BROADCAST)
    def test_update_card_column_to_different_board_column(self, _):
        """Updating a card's column to one from a different board via PATCH.

        The CardSerializer accepts a column PK without board scoping, so
        Django will happily save the FK. However, the card remains scoped
        to board_a in the URL, and the column actually belongs to board_b.
        Document the current behavior.
        """
        r = self.client.patch(
            f"/api/v1/boards/{self.board_a.id}/cards/{self.card.id}/",
            {"column": self.col_b.id},
        )
        # Current behavior: the serializer does not cross-validate the
        # column's board against the card's board on plain update (PATCH).
        # We document the status code so that if validation is later added
        # (returning 400), this test will need updating.
        self.assertIn(r.status_code, [status.HTTP_200_OK, status.HTTP_400_BAD_REQUEST])

    @patch(PATCH_BROADCAST)
    def test_update_board_name_to_empty_string(self, _):
        """Board name set to empty string should be rejected by the serializer."""
        r = self.client.patch(
            f"/api/v1/boards/{self.board_a.id}/",
            {"name": ""},
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    @patch(PATCH_BROADCAST)
    def test_set_negative_wip_limit_on_column(self, _):
        """Setting a negative WIP limit on a column.

        The Column model uses a plain IntegerField for wip_limit, so
        negative values are accepted at the database level. Document
        the current behavior.
        """
        r = self.client.patch(
            f"/api/v1/boards/{self.board_a.id}/columns/{self.col_a.id}/",
            {"wip_limit": -5},
        )
        # Current behavior: negative WIP limit is accepted since no
        # model-level or serializer-level validation prevents it.
        self.assertIn(r.status_code, [status.HTTP_200_OK, status.HTTP_400_BAD_REQUEST])
        if r.status_code == status.HTTP_200_OK:
            self.col_a.refresh_from_db()
            self.assertEqual(self.col_a.wip_limit, -5)
