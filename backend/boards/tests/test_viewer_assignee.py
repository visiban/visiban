"""Tests verifying that viewer-role users cannot be assigned to cards.

The fix in CardSerializer.__init__ scopes the assignee_id queryset via
_get_assignable_member_ids(), which excludes viewer-role memberships.
These tests confirm the serializer rejects viewer IDs as invalid PKs and
accepts admin, member, and collaborator IDs.
"""

from unittest.mock import patch

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, Column, Swimlane


PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"


def _make_board(owner):
    board = Board.objects.create(name="Test Board", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col, swim


def _make_card(board, col, swim, created_by, title="Test Card"):
    return Card.objects.create(
        board=board,
        column=col,
        swimlane=swim,
        title=title,
        created_by=created_by,
        position=0,
    )


class ViewerAssigneeRejectionTests(TestCase):
    """Verify that the assignee_id field rejects viewer-role users."""

    def setUp(self):
        self.admin_user = User.objects.create_user(username="admin_user", password="pass")
        self.member_user = User.objects.create_user(username="member_user", password="pass")
        self.collaborator_user = User.objects.create_user(username="collab_user", password="pass")
        self.viewer_user = User.objects.create_user(username="viewer_user", password="pass")

        self.board, self.col, self.swim = _make_board(self.admin_user)
        # admin_user already has ADMIN membership via _make_board
        BoardMembership.objects.create(
            board=self.board, user=self.member_user, role=BoardMembership.Role.MEMBER
        )
        BoardMembership.objects.create(
            board=self.board, user=self.collaborator_user, role=BoardMembership.Role.COLLABORATOR
        )
        BoardMembership.objects.create(
            board=self.board, user=self.viewer_user, role=BoardMembership.Role.VIEWER
        )

        self.card = _make_card(self.board, self.col, self.swim, self.admin_user)

        self.client = APIClient()
        self.client.force_authenticate(self.admin_user)

    def _patch_card(self, payload):
        return self.client.patch(
            f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/",
            payload,
            format="json",
        )

    @patch(PATCH_BROADCAST)
    def test_viewer_cannot_be_assigned_to_card(self, _):
        """PATCH with a viewer-role user ID must be rejected with HTTP 400."""
        r = self._patch_card({"assignee_id": self.viewer_user.id})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    @patch(PATCH_BROADCAST)
    def test_member_can_be_assigned_to_card(self, _):
        """PATCH with a member-role user ID must succeed."""
        r = self._patch_card({"assignee_id": self.member_user.id})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json()["assignee"]["id"], self.member_user.id)

    @patch(PATCH_BROADCAST)
    def test_admin_can_be_assigned_to_card(self, _):
        """PATCH with an admin-role user ID must succeed."""
        r = self._patch_card({"assignee_id": self.admin_user.id})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json()["assignee"]["id"], self.admin_user.id)

    @patch(PATCH_BROADCAST)
    def test_collaborator_can_be_assigned_to_card(self, _):
        """PATCH with a collaborator-role user ID must succeed."""
        r = self._patch_card({"assignee_id": self.collaborator_user.id})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json()["assignee"]["id"], self.collaborator_user.id)
