"""Tests for idempotent operations: re-marking notifications, no-op moves, duplicate labels."""
from unittest.mock import patch

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, CardMovement, Column, Label, Notification, Swimlane,
)


PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"


def _make_board(owner):
    board = Board.objects.create(name="B", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    col2 = Column.objects.create(board=board, name="Done", position=1)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col, col2, swim


class NotificationMarkReadIdempotencyTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, _, _, _ = _make_board(self.user)
        self.notif = Notification.objects.create(
            recipient=self.user, verb="Test", board=self.board,
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_mark_already_read_notification_by_id(self):
        """Marking an already-read notification as read again should not error."""
        # Mark read the first time
        resp1 = self.client.post(
            "/api/notifications/mark-read/",
            {"ids": [self.notif.id]},
            format="json",
        )
        self.assertEqual(resp1.status_code, status.HTTP_200_OK)
        self.notif.refresh_from_db()
        self.assertTrue(self.notif.read)

        # Mark read again
        resp2 = self.client.post(
            "/api/notifications/mark-read/",
            {"ids": [self.notif.id]},
            format="json",
        )
        self.assertEqual(resp2.status_code, status.HTTP_200_OK)

    def test_mark_all_read_twice(self):
        """Running mark-all-read when everything is already read should not error."""
        self.client.post("/api/notifications/mark-read/", {"all": True}, format="json")
        resp = self.client.post("/api/notifications/mark-read/", {"all": True}, format="json")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(
            Notification.objects.filter(recipient=self.user, read=False).count(), 0
        )


class CardMoveIdempotencyTests(TestCase):
    def setUp(self):
        self._broadcast_patcher = patch(PATCH_BROADCAST)
        self._broadcast_patcher.start()

        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, self.col2, self.swim = _make_board(self.user)
        self.card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Card", created_by=self.user, position=0,
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def tearDown(self):
        self._broadcast_patcher.stop()

    def test_move_to_same_column_and_swimlane_no_movement_record(self):
        """Moving a card to its current column/swimlane should not create a movement."""
        resp = self.client.post(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/move/",
            {"column_id": self.col.id, "swimlane_id": self.swim.id, "position": 0},
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(CardMovement.objects.filter(card=self.card).count(), 0)

    def test_move_then_move_back_creates_two_movements(self):
        """Moving a card away and back should create two movement records."""
        # Move to col2
        self.client.post(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/move/",
            {"column_id": self.col2.id, "swimlane_id": self.swim.id, "position": 0},
        )
        # Move back to col
        self.client.post(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/move/",
            {"column_id": self.col.id, "swimlane_id": self.swim.id, "position": 0},
        )
        self.assertEqual(CardMovement.objects.filter(card=self.card).count(), 2)


class LabelAssignmentIdempotencyTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, _, self.swim = _make_board(self.user)
        self.card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Card", created_by=self.user, position=0,
        )
        self.label = Label.objects.create(board=self.board, name="Bug", color="#FF0000")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    @patch(PATCH_BROADCAST)
    def test_assigning_same_label_twice(self, _):
        """Assigning a label that is already on the card should not error or duplicate."""
        # Assign label
        resp1 = self.client.patch(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/",
            {"label_ids": [self.label.id]},
            format="json",
        )
        self.assertEqual(resp1.status_code, status.HTTP_200_OK)
        self.assertEqual(len(resp1.json()["labels"]), 1)

        # Assign same label again
        resp2 = self.client.patch(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/",
            {"label_ids": [self.label.id]},
            format="json",
        )
        self.assertEqual(resp2.status_code, status.HTTP_200_OK)
        self.assertEqual(len(resp2.json()["labels"]), 1)
        # Should still be exactly one label on the card
        self.assertEqual(self.card.labels.count(), 1)
