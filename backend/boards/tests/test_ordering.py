"""Tests for pagination and ordering of boards, cards, and notifications."""
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, Column, Notification, Swimlane,
)


PATCH_BROADCAST = "boards.views.broadcast_board_event"


def _make_board(owner, name="Board"):
    board = Board.objects.create(name=name, owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col, swim


class BoardListOrderingTests(TestCase):
    """Board.Meta.ordering is ['-updated_at'] — most recently updated first."""

    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_boards_ordered_by_most_recently_updated(self):
        board_a, _, _ = _make_board(self.user, name="Alpha")
        board_b, _, _ = _make_board(self.user, name="Beta")
        # Touch board_a so it becomes more recently updated
        board_a.name = "Alpha Updated"
        board_a.save()

        resp = self.client.get("/api/boards/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        ids = [b["id"] for b in resp.data]
        # board_a was updated last, so it should appear first
        self.assertEqual(ids[0], board_a.id)


class CardOrderingInColumnTests(TestCase):
    """Cards within a column/swimlane cell are ordered by position."""

    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, self.swim = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_cards_returned_in_position_order(self):
        card_c = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Card C", created_by=self.user, position=2,
        )
        card_a = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Card A", created_by=self.user, position=0,
        )
        card_b = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Card B", created_by=self.user, position=1,
        )

        resp = self.client.get(f"/api/boards/{self.board.id}/full/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        card_ids = [c["id"] for c in resp.json()["cards"]]
        self.assertEqual(card_ids, [card_a.id, card_b.id, card_c.id])


class NotificationOrderingTests(TestCase):
    """Notification.Meta.ordering is ['-created_at'] — most recent first."""

    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, _, _ = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_notifications_ordered_most_recent_first(self):
        Notification.objects.create(
            recipient=self.user, verb="First", board=self.board,
        )
        Notification.objects.create(
            recipient=self.user, verb="Second", board=self.board,
        )
        Notification.objects.create(
            recipient=self.user, verb="Third", board=self.board,
        )

        resp = self.client.get("/api/notifications/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        verbs = [n["verb"] for n in resp.data]
        # Most recently created should appear first
        self.assertEqual(verbs, ["Third", "Second", "First"])
