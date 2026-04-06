"""Tests for optimistic concurrency control (OCC) on the card move endpoint.

Source of change: Gemini Pro external codebase review (2026-04-01).
"""

from unittest.mock import patch

from django.test import TestCase
from rest_framework.test import APIClient
from rest_framework import status

from accounts.models import User
from boards.models import Board, BoardMembership, Column, Swimlane, Card


class CardVersionConflictTests(TestCase):
    def setUp(self):
        self._broadcast_patcher = patch("boards.broadcast.broadcast_board_event")
        self._broadcast_patcher.start()

        self.client = APIClient()
        self.user = User.objects.create_user(username="alice", password="pass")
        self.client.force_authenticate(self.user)

        self.board = Board.objects.create(name="Board", owner=self.user)
        BoardMembership.objects.create(
            board=self.board, user=self.user, role=BoardMembership.Role.ADMIN
        )
        self.col_a = Column.objects.create(board=self.board, name="Todo", position=0)
        self.col_b = Column.objects.create(board=self.board, name="Done", position=1)
        self.swim = Swimlane.objects.create(board=self.board, name="Default", position=0)
        self.card = Card.objects.create(
            board=self.board,
            column=self.col_a,
            swimlane=self.swim,
            title="OCC Card",
            created_by=self.user,
            position=0,
        )

    def tearDown(self):
        self._broadcast_patcher.stop()

    def _move_url(self):
        return f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/move/"

    def test_move_succeeds_with_correct_version(self):
        resp = self.client.post(self._move_url(), {
            "column_id": self.col_b.pk,
            "swimlane_id": self.swim.pk,
            "position": 0,
            "version": self.card.version,
        })
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.card.refresh_from_db()
        self.assertEqual(self.card.column_id, self.col_b.pk)
        # Version should have incremented.
        self.assertEqual(self.card.version, 2)

    def test_move_rejected_with_stale_version(self):
        # Simulate another user bumping the version.
        Card.objects.filter(pk=self.card.pk).update(version=5)

        resp = self.client.post(self._move_url(), {
            "column_id": self.col_b.pk,
            "swimlane_id": self.swim.pk,
            "position": 0,
            "version": 1,  # stale
        })
        self.assertEqual(resp.status_code, status.HTTP_409_CONFLICT)
        self.assertEqual(resp.data["code"], "version_conflict")
        self.assertEqual(resp.data["current_version"], 5)
        # Card should NOT have moved.
        self.card.refresh_from_db()
        self.assertEqual(self.card.column_id, self.col_a.pk)

    def test_move_without_version_skips_occ(self):
        """Backward compatibility: omitting version bypasses the OCC check."""
        resp = self.client.post(self._move_url(), {
            "column_id": self.col_b.pk,
            "swimlane_id": self.swim.pk,
            "position": 0,
        })
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.card.refresh_from_db()
        self.assertEqual(self.card.column_id, self.col_b.pk)

    def test_version_included_in_card_serializer_response(self):
        resp = self.client.post(self._move_url(), {
            "column_id": self.col_b.pk,
            "swimlane_id": self.swim.pk,
            "position": 0,
        })
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertIn("version", resp.data["card"])
        self.assertEqual(resp.data["card"]["version"], 2)

    def test_version_increments_on_card_update(self):
        url = f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/"
        resp = self.client.patch(url, {"title": "Updated"}, format="json")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.card.refresh_from_db()
        self.assertEqual(self.card.version, 2)
        self.assertEqual(resp.data["version"], 2)

    def test_invalid_version_returns_400(self):
        resp = self.client.post(self._move_url(), {
            "column_id": self.col_b.pk,
            "swimlane_id": self.swim.pk,
            "position": 0,
            "version": "not-a-number",
        })
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
