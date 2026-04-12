"""Tests verifying that viewer-role users cannot be assigned to cards.

The fix in CardSerializer.__init__ scopes the assignee_id queryset via
_get_assignable_member_ids(), which excludes viewer-role memberships.
These tests confirm the serializer rejects viewer IDs as invalid PKs and
accepts admin, member, and collaborator IDs.

Also covers the clear_viewer_assignees management command which back-fills
cards that were assigned to viewers before the serializer fix.
"""

import io
from unittest.mock import patch

from django.core.management import call_command
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


class ClearViewerAssigneesCommandTests(TestCase):
    """Tests for the clear_viewer_assignees management command."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.viewer = User.objects.create_user(username="viewer", password="pass")
        self.member = User.objects.create_user(username="member", password="pass")

        self.board = Board.objects.create(name="Board A", owner=self.owner)
        BoardMembership.objects.create(
            board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN
        )
        BoardMembership.objects.create(
            board=self.board, user=self.viewer, role=BoardMembership.Role.VIEWER
        )
        BoardMembership.objects.create(
            board=self.board, user=self.member, role=BoardMembership.Role.MEMBER
        )

        col = Column.objects.create(
            board=self.board, name="Todo", position=0, allow_card_creation=True
        )
        swim = Swimlane.objects.create(board=self.board, name="General", position=0)

        self.stale_card = Card.objects.create(
            board=self.board,
            column=col,
            swimlane=swim,
            title="Stale",
            created_by=self.owner,
            assignee=self.viewer,
            position=0,
        )
        self.clean_card = Card.objects.create(
            board=self.board,
            column=col,
            swimlane=swim,
            title="Clean",
            created_by=self.owner,
            assignee=self.member,
            position=1,
        )

    def _call(self, *args, **kwargs):
        out = io.StringIO()
        call_command("clear_viewer_assignees", *args, stdout=out, **kwargs)
        return out.getvalue()

    def test_dry_run_reports_card_without_modifying(self):
        """--dry-run prints the affected card but does not clear the assignee."""
        output = self._call("--dry-run")
        self.assertIn("[DRY RUN]", output)
        self.assertIn(self.stale_card.title, output)
        # assignee must be unchanged after dry run
        self.stale_card.refresh_from_db()
        self.assertEqual(self.stale_card.assignee_id, self.viewer.id)

    def test_live_run_clears_viewer_assignee(self):
        """Running without --dry-run clears the assignee on affected cards."""
        output = self._call()
        self.assertIn("Cleared assignee on 1 card(s)", output)
        self.stale_card.refresh_from_db()
        self.assertIsNone(self.stale_card.assignee_id)

    def test_live_run_preserves_non_viewer_assignee(self):
        """Member-assigned cards must not be touched."""
        self._call()
        self.clean_card.refresh_from_db()
        self.assertEqual(self.clean_card.assignee_id, self.member.id)

    def test_board_flag_restricts_to_single_board(self):
        """--board <id> only scans the specified board."""
        other_board = Board.objects.create(name="Other", owner=self.owner)
        BoardMembership.objects.create(
            board=other_board, user=self.owner, role=BoardMembership.Role.ADMIN
        )
        BoardMembership.objects.create(
            board=other_board, user=self.viewer, role=BoardMembership.Role.VIEWER
        )
        col2 = Column.objects.create(
            board=other_board, name="Todo", position=0, allow_card_creation=True
        )
        swim2 = Swimlane.objects.create(board=other_board, name="General", position=0)
        other_stale = Card.objects.create(
            board=other_board,
            column=col2,
            swimlane=swim2,
            title="Other Stale",
            created_by=self.owner,
            assignee=self.viewer,
            position=0,
        )

        # Only scan board A — other_board's card should be untouched
        self._call("--board", str(self.board.pk))

        other_stale.refresh_from_db()
        self.assertEqual(other_stale.assignee_id, self.viewer.id)

        self.stale_card.refresh_from_db()
        self.assertIsNone(self.stale_card.assignee_id)

    def test_dual_role_user_not_cleared(self):
        """A user with both a viewer AND a non-viewer membership is not cleared.

        Non-viewer membership wins; pure-viewer logic should not touch their cards.
        """
        # Give the viewer a second, non-viewer membership (edge case — possible
        # via group inheritance in the real app, simulated here directly).
        BoardMembership.objects.create(
            board=self.board, user=self.viewer, role=BoardMembership.Role.COLLABORATOR
        )
        # Reset the stale card to confirm the dual-role user keeps their assignment
        self._call()
        self.stale_card.refresh_from_db()
        # With a collaborator membership the viewer is in non_viewer_ids, so card kept
        self.assertEqual(self.stale_card.assignee_id, self.viewer.id)
