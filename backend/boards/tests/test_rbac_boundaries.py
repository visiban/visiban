"""RBAC boundary tests: viewer/collaborator permission enforcement across operations."""
from unittest.mock import patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, CardAttachment, Column, Swimlane


PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"


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


class MemberCardOwnershipTests(TestCase):
    """Members may only edit cards they created, unless they are moderators."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner_co", password="pass")
        self.member = User.objects.create_user(username="member_co", password="pass")
        self.moderator = User.objects.create_user(username="mod_co", password="pass")
        self.board, self.col, self.col2, self.swim = _make_board(self.owner)
        BoardMembership.objects.create(
            board=self.board, user=self.member, role=BoardMembership.Role.MEMBER
        )
        BoardMembership.objects.create(
            board=self.board, user=self.moderator, role=BoardMembership.Role.MEMBER,
            is_moderator=True,
        )

    @patch(PATCH_BROADCAST)
    def test_member_cannot_edit_card_created_by_another(self, _mock):
        card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Owner Card", created_by=self.owner, position=0,
        )
        client = APIClient()
        client.force_authenticate(self.member)
        resp = client.patch(
            f"/api/boards/{self.board.pk}/cards/{card.pk}/",
            {"title": "Hijacked"},
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    @patch(PATCH_BROADCAST)
    def test_member_can_edit_own_card(self, _mock):
        card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="My Card", created_by=self.member, position=0,
        )
        client = APIClient()
        client.force_authenticate(self.member)
        resp = client.patch(
            f"/api/boards/{self.board.pk}/cards/{card.pk}/",
            {"title": "Renamed"},
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.json()["title"], "Renamed")

    @patch(PATCH_BROADCAST)
    def test_moderator_can_edit_card_created_by_another(self, _mock):
        card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Owner Card", created_by=self.owner, position=0,
        )
        client = APIClient()
        client.force_authenticate(self.moderator)
        resp = client.patch(
            f"/api/boards/{self.board.pk}/cards/{card.pk}/",
            {"title": "Moderated"},
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.json()["title"], "Moderated")

    @patch(PATCH_BROADCAST)
    def test_admin_can_edit_card_created_by_another(self, _mock):
        card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Member Card", created_by=self.member, position=0,
        )
        client = APIClient()
        client.force_authenticate(self.owner)
        resp = client.patch(
            f"/api/boards/{self.board.pk}/cards/{card.pk}/",
            {"title": "Admin Edit"},
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.json()["title"], "Admin Edit")


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


class ViewerCannotPatchBoardTests(TestCase):
    """Finding 1: viewers and other non-admin roles must not be able to PATCH board settings."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner_vp", password="pass")
        self.viewer = User.objects.create_user(username="viewer_vp", password="pass")
        self.member = User.objects.create_user(username="member_vp", password="pass")
        self.collab = User.objects.create_user(username="collab_vp", password="pass")
        self.board, _, _, _ = _make_board(self.owner)
        BoardMembership.objects.create(board=self.board, user=self.viewer, role=BoardMembership.Role.VIEWER)
        BoardMembership.objects.create(board=self.board, user=self.member, role=BoardMembership.Role.MEMBER)
        BoardMembership.objects.create(board=self.board, user=self.collab, role=BoardMembership.Role.COLLABORATOR)

    def test_viewer_cannot_patch_board(self):
        client = APIClient()
        client.force_authenticate(self.viewer)
        resp = client.patch(f"/api/boards/{self.board.pk}/", {"name": "Hacked Name"})
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_member_cannot_patch_board(self):
        """Members can edit cards but not board-level settings."""
        client = APIClient()
        client.force_authenticate(self.member)
        resp = client.patch(f"/api/boards/{self.board.pk}/", {"name": "Member Renamed"})
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_collaborator_cannot_patch_board(self):
        client = APIClient()
        client.force_authenticate(self.collab)
        resp = client.patch(f"/api/boards/{self.board.pk}/", {"name": "Collab Renamed"})
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_admin_can_patch_board(self):
        client = APIClient()
        client.force_authenticate(self.owner)
        resp = client.patch(f"/api/boards/{self.board.pk}/", {"name": "Admin Renamed"})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.json()["name"], "Admin Renamed")


class CollaboratorAttachmentOwnershipTests(TestCase):
    """Finding 3: collaborators may only delete their own attachments."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner_att", password="pass")
        self.collab = User.objects.create_user(username="collab_att", password="pass")
        self.other_member = User.objects.create_user(username="member_att", password="pass")
        self.board = Board.objects.create(name="Att Board", owner=self.owner)
        BoardMembership.objects.create(board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN)
        BoardMembership.objects.create(board=self.board, user=self.collab, role=BoardMembership.Role.COLLABORATOR)
        BoardMembership.objects.create(board=self.board, user=self.other_member, role=BoardMembership.Role.MEMBER)
        col = Column.objects.create(board=self.board, name="Backlog", position=0, allow_card_creation=True)
        swim = Swimlane.objects.create(board=self.board, name="General", position=0)
        self.card = Card.objects.create(
            board=self.board, column=col, swimlane=swim, title="Card", position=0,
        )

    def _make_attachment(self, uploaded_by):
        """Create a CardAttachment with a minimal in-memory file."""
        f = SimpleUploadedFile("test.txt", b"hello", content_type="text/plain")
        return CardAttachment.objects.create(
            card=self.card,
            file=f,
            filename="test.txt",
            size=5,
            uploaded_by=uploaded_by,
        )

    @patch("boards.broadcast.broadcast_board_event")
    def test_collaborator_cannot_delete_another_users_attachment(self, _mock):
        attachment = self._make_attachment(uploaded_by=self.other_member)
        client = APIClient()
        client.force_authenticate(self.collab)
        resp = client.delete(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/attachments/{attachment.pk}/"
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        # Attachment must not have been deleted
        self.assertTrue(CardAttachment.objects.filter(pk=attachment.pk).exists())

    @patch("boards.broadcast.broadcast_board_event")
    def test_collaborator_can_delete_own_attachment(self, _mock):
        attachment = self._make_attachment(uploaded_by=self.collab)
        client = APIClient()
        client.force_authenticate(self.collab)
        # Patch the file storage delete so we don't hit the filesystem
        with patch.object(attachment.file, "delete", return_value=None):
            resp = client.delete(
                f"/api/boards/{self.board.pk}/cards/{self.card.pk}/attachments/{attachment.pk}/"
            )
        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)


class MemberAttachmentOwnershipTests(TestCase):
    """Members may only delete their own attachments unless they are moderators (#378)."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner_ma", password="pass")
        self.member = User.objects.create_user(username="member_ma", password="pass")
        self.other_member = User.objects.create_user(username="other_ma", password="pass")
        self.moderator = User.objects.create_user(username="mod_ma", password="pass")
        self.board = Board.objects.create(name="MA Board", owner=self.owner)
        BoardMembership.objects.create(board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN)
        BoardMembership.objects.create(board=self.board, user=self.member, role=BoardMembership.Role.MEMBER)
        BoardMembership.objects.create(board=self.board, user=self.other_member, role=BoardMembership.Role.MEMBER)
        BoardMembership.objects.create(
            board=self.board, user=self.moderator, role=BoardMembership.Role.MEMBER, is_moderator=True,
        )
        col = Column.objects.create(board=self.board, name="Backlog", position=0, allow_card_creation=True)
        swim = Swimlane.objects.create(board=self.board, name="General", position=0)
        self.card = Card.objects.create(
            board=self.board, column=col, swimlane=swim, title="Card", position=0,
        )

    def _make_attachment(self, uploaded_by):
        f = SimpleUploadedFile("test.txt", b"hello", content_type="text/plain")
        return CardAttachment.objects.create(
            card=self.card, file=f, filename="test.txt", size=5, uploaded_by=uploaded_by,
        )

    @patch(PATCH_BROADCAST)
    def test_member_cannot_delete_another_users_attachment(self, _mock):
        attachment = self._make_attachment(uploaded_by=self.other_member)
        client = APIClient()
        client.force_authenticate(self.member)
        resp = client.delete(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/attachments/{attachment.pk}/"
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        self.assertTrue(CardAttachment.objects.filter(pk=attachment.pk).exists())

    @patch(PATCH_BROADCAST)
    def test_member_can_delete_own_attachment(self, _mock):
        attachment = self._make_attachment(uploaded_by=self.member)
        client = APIClient()
        client.force_authenticate(self.member)
        with patch.object(attachment.file, "delete", return_value=None):
            resp = client.delete(
                f"/api/boards/{self.board.pk}/cards/{self.card.pk}/attachments/{attachment.pk}/"
            )
        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)

    @patch(PATCH_BROADCAST)
    def test_moderator_can_delete_another_users_attachment(self, _mock):
        attachment = self._make_attachment(uploaded_by=self.other_member)
        client = APIClient()
        client.force_authenticate(self.moderator)
        with patch.object(attachment.file, "delete", return_value=None):
            resp = client.delete(
                f"/api/boards/{self.board.pk}/cards/{self.card.pk}/attachments/{attachment.pk}/"
            )
        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)

    @patch(PATCH_BROADCAST)
    def test_admin_can_delete_another_users_attachment(self, _mock):
        attachment = self._make_attachment(uploaded_by=self.member)
        client = APIClient()
        client.force_authenticate(self.owner)
        with patch.object(attachment.file, "delete", return_value=None):
            resp = client.delete(
                f"/api/boards/{self.board.pk}/cards/{self.card.pk}/attachments/{attachment.pk}/"
            )
        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
