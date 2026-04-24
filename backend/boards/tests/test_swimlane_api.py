"""Tests for the SwimlaneViewSet.set_collapsed action (#743).

Verifies:
- A board member (non-admin) can PATCH set_collapsed successfully.
- A non-member gets 403.
- An invalid body (non-boolean) gets 400.
- The is_collapsed field is saved correctly.
"""

from unittest.mock import patch

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Swimlane


def _make_board(owner):
    board = Board.objects.create(name="Collapse Test Board", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    return board


def _add_member(board, user, role):
    BoardMembership.objects.create(board=board, user=user, role=role)


def _make_swimlane(board, is_collapsed=False):
    return Swimlane.objects.create(
        board=board, name="Test Lane", position=0, is_collapsed=is_collapsed,
    )


class SwimlaneSetCollapsedTests(TestCase):
    """Tests for PATCH /api/v1/boards/{board_pk}/swimlanes/{pk}/set_collapsed/."""

    def setUp(self):
        self.admin = User.objects.create_user(username="collapse_admin", password="pass")
        self.board = _make_board(self.admin)
        self.swimlane = _make_swimlane(self.board)
        self.client = APIClient()

    def _url(self):
        return f"/api/v1/boards/{self.board.id}/swimlanes/{self.swimlane.id}/set_collapsed/"

    def test_admin_can_set_collapsed_true(self):
        self.client.force_authenticate(self.admin)
        r = self.client.patch(self._url(), {"is_collapsed": True}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.swimlane.refresh_from_db()
        self.assertTrue(self.swimlane.is_collapsed)

    def test_admin_can_set_collapsed_false(self):
        # Start collapsed, set to expanded.
        self.swimlane.is_collapsed = True
        self.swimlane.save()
        self.client.force_authenticate(self.admin)
        r = self.client.patch(self._url(), {"is_collapsed": False}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.swimlane.refresh_from_db()
        self.assertFalse(self.swimlane.is_collapsed)

    def test_member_can_set_collapsed(self):
        """Non-admin board members must be allowed to use set_collapsed."""
        member = User.objects.create_user(username="collapse_member", password="pass")
        _add_member(self.board, member, BoardMembership.Role.MEMBER)
        self.client.force_authenticate(member)
        r = self.client.patch(self._url(), {"is_collapsed": True}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.swimlane.refresh_from_db()
        self.assertTrue(self.swimlane.is_collapsed)

    def test_viewer_cannot_set_collapsed(self):
        """Viewers are read-only and must not mutate board structure (#790).

        is_collapsed is persisted on the Swimlane model and affects the
        default view for every board member, so it is a board-structure
        write and requires at least member role — aligned with the rest of
        the permission matrix for write actions.
        """
        viewer = User.objects.create_user(username="collapse_viewer", password="pass")
        _add_member(self.board, viewer, BoardMembership.Role.VIEWER)
        self.client.force_authenticate(viewer)
        r = self.client.patch(self._url(), {"is_collapsed": True}, format="json")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_collaborator_cannot_set_collapsed(self):
        """Collaborators have read-only access to cards only; mutating a
        board-structure field (is_collapsed is persisted on Swimlane) requires
        at least MEMBER role per the allow-list enforced by set_collapsed."""
        collab = User.objects.create_user(username="collapse_collab", password="pass")
        _add_member(self.board, collab, BoardMembership.Role.COLLABORATOR)
        self.client.force_authenticate(collab)
        r = self.client.patch(self._url(), {"is_collapsed": True}, format="json")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_non_member_gets_403(self):
        """A user who is not a board member must not access the action."""
        stranger = User.objects.create_user(username="collapse_stranger", password="pass")
        self.client.force_authenticate(stranger)
        r = self.client.patch(self._url(), {"is_collapsed": True}, format="json")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_unauthenticated_gets_403(self):
        r = self.client.patch(self._url(), {"is_collapsed": True}, format="json")
        self.assertIn(r.status_code, [status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN])

    def test_invalid_body_non_boolean_gets_400(self):
        self.client.force_authenticate(self.admin)
        r = self.client.patch(self._url(), {"is_collapsed": "yes"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_invalid_body_integer_gets_400(self):
        self.client.force_authenticate(self.admin)
        r = self.client.patch(self._url(), {"is_collapsed": 1}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_invalid_body_missing_field_gets_400(self):
        self.client.force_authenticate(self.admin)
        r = self.client.patch(self._url(), {}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_response_contains_is_collapsed_field(self):
        self.client.force_authenticate(self.admin)
        r = self.client.patch(self._url(), {"is_collapsed": True}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIn("is_collapsed", r.json())
        self.assertTrue(r.json()["is_collapsed"])

    def test_set_collapsed_does_not_affect_other_swimlane_fields(self):
        """Ensure that only is_collapsed changes; name and position are untouched."""
        self.client.force_authenticate(self.admin)
        r = self.client.patch(self._url(), {"is_collapsed": True}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.swimlane.refresh_from_db()
        self.assertEqual(self.swimlane.name, "Test Lane")
        self.assertEqual(self.swimlane.position, 0)

    def test_perform_update_still_requires_admin(self):
        """The regular PATCH (perform_update) must still be admin-only."""
        member = User.objects.create_user(username="collapse_member2", password="pass")
        _add_member(self.board, member, BoardMembership.Role.MEMBER)
        self.client.force_authenticate(member)
        url = f"/api/v1/boards/{self.board.id}/swimlanes/{self.swimlane.id}/"
        r = self.client.patch(url, {"name": "Hacked Name"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_kebab_case_alias_works(self):
        """The canonical kebab-case path set-collapsed must work (#816)."""
        self.client.force_authenticate(self.admin)
        url = f"/api/v1/boards/{self.board.id}/swimlanes/{self.swimlane.id}/set-collapsed/"
        r = self.client.patch(url, {"is_collapsed": True}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.swimlane.refresh_from_db()
        self.assertTrue(self.swimlane.is_collapsed)

    def test_snake_case_alias_still_routable(self):
        """The deprecated snake_case path set_collapsed must remain routable
        through the 1.x series; removal is scheduled for 2.0 (#816).
        """
        self.client.force_authenticate(self.admin)
        url = f"/api/v1/boards/{self.board.id}/swimlanes/{self.swimlane.id}/set_collapsed/"
        r = self.client.patch(url, {"is_collapsed": True}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    @patch("boards.views.swimlanes.transaction.on_commit", side_effect=lambda fn: fn())
    @patch("boards.broadcast.broadcast_board_event")
    def test_set_collapsed_broadcasts_swimlane_updated(self, mock_broadcast, _on_commit):
        """set-collapsed must emit a swimlane.updated broadcast (#892)."""
        self.client.force_authenticate(self.admin)
        url = f"/api/v1/boards/{self.board.id}/swimlanes/{self.swimlane.id}/set-collapsed/"
        r = self.client.patch(url, {"is_collapsed": True}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        mock_broadcast.assert_called_once_with(
            self.board.id, "swimlane.updated", mock_broadcast.call_args[0][2]
        )
        self.assertEqual(mock_broadcast.call_args[0][1], "swimlane.updated")
