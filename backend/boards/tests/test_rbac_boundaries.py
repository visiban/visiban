"""RBAC boundary tests: viewer/collaborator permission enforcement across operations."""
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Column, Swimlane, Card


PATCH_BROADCAST = "boards.views.broadcast_board_event"


def _make_board(owner):
    board = Board.objects.create(name="RBAC Board", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    col2 = Column.objects.create(board=board, name="Done", position=1)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col, col2, swim


class ViewerPermissionBoundaryTests(TestCase):
    """Viewers should be read-only: no creating or moving cards."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.viewer = User.objects.create_user(username="viewer", password="pass")
        self.board, self.col, self.col2, self.swim = _make_board(self.owner)
        BoardMembership.objects.create(
            board=self.board, user=self.viewer, role=BoardMembership.Role.VIEWER
        )
        self.client = APIClient()
        self.client.force_authenticate(self.viewer)

    def test_viewer_cannot_create_card(self):
        resp = self.client.post(
            f"/api/boards/{self.board.pk}/cards/",
            {"title": "Sneaky Card", "column": self.col.pk, "swimlane": self.swim.pk},
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_viewer_cannot_move_card(self):
        card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Immovable", created_by=self.owner, position=0,
        )
        resp = self.client.post(
            f"/api/boards/{self.board.pk}/cards/{card.pk}/move/",
            {"column_id": self.col2.pk, "swimlane_id": self.swim.pk, "position": 0},
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_viewer_cannot_update_card(self):
        card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Protected", created_by=self.owner, position=0,
        )
        resp = self.client.patch(
            f"/api/boards/{self.board.pk}/cards/{card.pk}/",
            {"title": "Changed"},
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_viewer_cannot_delete_card(self):
        card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Undeletable", created_by=self.owner, position=0,
        )
        resp = self.client.delete(
            f"/api/boards/{self.board.pk}/cards/{card.pk}/",
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_viewer_cannot_create_column(self):
        resp = self.client.post(
            f"/api/boards/{self.board.pk}/columns/",
            {"name": "New Column", "position": 99},
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_viewer_cannot_create_swimlane(self):
        resp = self.client.post(
            f"/api/boards/{self.board.pk}/swimlanes/",
            {"name": "New Swimlane"},
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)


class CollaboratorPermissionBoundaryTests(TestCase):
    """Collaborators can comment/view but cannot edit columns, swimlanes, or cards."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.collab = User.objects.create_user(username="collab", password="pass")
        self.board, self.col, self.col2, self.swim = _make_board(self.owner)
        BoardMembership.objects.create(
            board=self.board, user=self.collab, role=BoardMembership.Role.COLLABORATOR
        )
        self.client = APIClient()
        self.client.force_authenticate(self.collab)

    def test_collaborator_cannot_edit_column(self):
        resp = self.client.patch(
            f"/api/boards/{self.board.pk}/columns/{self.col.pk}/",
            {"name": "Renamed Column"},
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_collaborator_cannot_delete_column(self):
        resp = self.client.delete(
            f"/api/boards/{self.board.pk}/columns/{self.col.pk}/",
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_collaborator_cannot_delete_swimlane(self):
        resp = self.client.delete(
            f"/api/boards/{self.board.pk}/swimlanes/{self.swim.pk}/",
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_collaborator_cannot_edit_swimlane(self):
        resp = self.client.patch(
            f"/api/boards/{self.board.pk}/swimlanes/{self.swim.pk}/",
            {"name": "Renamed Swimlane"},
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_collaborator_cannot_create_card(self):
        resp = self.client.post(
            f"/api/boards/{self.board.pk}/cards/",
            {"title": "Blocked Card", "column": self.col.pk, "swimlane": self.swim.pk},
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_collaborator_cannot_move_card(self):
        card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Stuck", created_by=self.owner, position=0,
        )
        resp = self.client.post(
            f"/api/boards/{self.board.pk}/cards/{card.pk}/move/",
            {"column_id": self.col2.pk, "swimlane_id": self.swim.pk, "position": 0},
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)


class SiteAdminMembershipProtectionTests(TestCase):
    """Attempting to remove or demote a site_admin from board members should be blocked."""

    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="pass")
        self.site_admin = User.objects.create_user(
            username="sa", password="pass", is_site_admin=True
        )
        self.board, _, _, _ = _make_board(self.admin)
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def test_board_admin_cannot_remove_site_admin(self):
        resp = self.client.delete(
            f"/api/boards/{self.board.pk}/members/{self.site_admin.pk}/",
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_board_admin_cannot_change_site_admin_role(self):
        resp = self.client.post(
            f"/api/boards/{self.board.pk}/members/",
            {"user_id": self.site_admin.pk, "role": "viewer"},
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)


class LastAdminSelfDemotionTests(TestCase):
    """Document the current behavior when the last admin tries to demote themselves.

    Currently the API does NOT block this, so the owner can change their own role
    to a lower role. This test documents that behavior for visibility.
    """

    def setUp(self):
        self.owner = User.objects.create_user(username="solo_admin", password="pass")
        self.board, _, _, _ = _make_board(self.owner)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def test_last_admin_can_demote_self_via_membership_update(self):
        """Document: the API currently allows the last admin to demote themselves.
        This may be undesirable, but we test current behavior rather than failing."""
        resp = self.client.post(
            f"/api/boards/{self.board.pk}/members/",
            {"user_id": self.owner.pk, "role": "viewer"},
        )
        # The API allows this — the owner role is determined by Board.owner,
        # so even if the membership says "viewer", get_board_role returns ADMIN
        # for the board owner. The membership record changes but effective
        # permissions are unaffected.
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        membership = BoardMembership.objects.get(board=self.board, user=self.owner)
        self.assertEqual(membership.role, BoardMembership.Role.VIEWER)
        # But effective role is still admin because of ownership
        from boards.permissions import get_board_role
        effective = get_board_role(self.owner, self.board)
        self.assertEqual(effective, BoardMembership.Role.ADMIN)
