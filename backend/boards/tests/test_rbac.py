from unittest.mock import patch

from django.test import TestCase
from rest_framework.test import APIClient
from rest_framework import status

from accounts.models import User
from boards.models import Board, BoardMembership, Card, CardComment, Column, Swimlane
from boards.permissions import get_board_role, SITE_ADMIN


def make_board(owner):
    board = Board.objects.create(name="Test Board", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col, swim


class GetBoardRoleTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, _, _ = make_board(self.owner)

    def test_owner_gets_admin_role(self):
        role = get_board_role(self.owner, self.board)
        self.assertEqual(role, BoardMembership.Role.ADMIN)

    def test_explicit_member_role(self):
        member = User.objects.create_user(username="member", password="pass")
        BoardMembership.objects.create(board=self.board, user=member, role=BoardMembership.Role.MEMBER)
        self.assertEqual(get_board_role(member, self.board), BoardMembership.Role.MEMBER)

    def test_explicit_viewer_role(self):
        viewer = User.objects.create_user(username="viewer", password="pass")
        BoardMembership.objects.create(board=self.board, user=viewer, role=BoardMembership.Role.VIEWER)
        self.assertEqual(get_board_role(viewer, self.board), BoardMembership.Role.VIEWER)

    def test_explicit_collaborator_role(self):
        collab = User.objects.create_user(username="collab", password="pass")
        BoardMembership.objects.create(board=self.board, user=collab, role=BoardMembership.Role.COLLABORATOR)
        self.assertEqual(get_board_role(collab, self.board), BoardMembership.Role.COLLABORATOR)

    def test_non_member_returns_none(self):
        stranger = User.objects.create_user(username="stranger", password="pass")
        self.assertIsNone(get_board_role(stranger, self.board))

    def test_site_admin_gets_site_admin_role(self):
        admin = User.objects.create_user(username="siteadmin", password="pass")
        admin.is_site_admin = True
        admin.save()
        self.assertEqual(get_board_role(admin, self.board), SITE_ADMIN)


class CardCreationRBACTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, self.col, self.swim = make_board(self.owner)

    def _create_card(self, user):
        self.client.force_authenticate(user)
        return self.client.post(
            f"/api/boards/{self.board.pk}/cards/",
            {"title": "New Card", "column": self.col.pk, "swimlane": self.swim.pk},
        )

    @patch("boards.views.broadcast_board_event")
    def test_member_can_create_card(self, _mock_broadcast):
        member = User.objects.create_user(username="member", password="pass")
        BoardMembership.objects.create(board=self.board, user=member, role=BoardMembership.Role.MEMBER)
        resp = self._create_card(member)
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

    def test_viewer_cannot_create_card(self):
        viewer = User.objects.create_user(username="viewer", password="pass")
        BoardMembership.objects.create(board=self.board, user=viewer, role=BoardMembership.Role.VIEWER)
        resp = self._create_card(viewer)
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_collaborator_cannot_create_card(self):
        collab = User.objects.create_user(username="collab", password="pass")
        BoardMembership.objects.create(board=self.board, user=collab, role=BoardMembership.Role.COLLABORATOR)
        resp = self._create_card(collab)
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_non_member_gets_403(self):
        stranger = User.objects.create_user(username="stranger", password="pass")
        resp = self._create_card(stranger)
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)


class ColumnCreationRBACTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, _, _ = make_board(self.owner)

    def _create_column(self, user):
        self.client.force_authenticate(user)
        return self.client.post(
            f"/api/boards/{self.board.pk}/columns/",
            {"name": "New Column", "position": 99},
        )

    @patch("boards.views.broadcast_board_event")
    def test_admin_can_create_column(self, _mock_broadcast):
        resp = self._create_column(self.owner)
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

    def test_member_cannot_create_column(self):
        member = User.objects.create_user(username="member", password="pass")
        BoardMembership.objects.create(board=self.board, user=member, role=BoardMembership.Role.MEMBER)
        resp = self._create_column(member)
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_viewer_cannot_create_column(self):
        viewer = User.objects.create_user(username="viewer", password="pass")
        BoardMembership.objects.create(board=self.board, user=viewer, role=BoardMembership.Role.VIEWER)
        resp = self._create_column(viewer)
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)


class ViewerCollaboratorBoundaryTests(TestCase):
    """Verify that viewer is strictly read-only and collaborator can comment/attach/checklist."""

    def setUp(self):
        self.client = APIClient()
        self.owner = User.objects.create_user(username="owner2", password="pass")
        self.board, self.col, self.swim = make_board(self.owner)
        # A card owned by the board owner for all sub-tests
        self.card = Card.objects.create(
            board=self.board,
            column=self.col,
            swimlane=self.swim,
            title="Test Card",
            created_by=self.owner,
            position=0,
        )
        self.viewer = User.objects.create_user(username="viewer2", password="pass")
        BoardMembership.objects.create(board=self.board, user=self.viewer, role=BoardMembership.Role.VIEWER)
        self.collab = User.objects.create_user(username="collab2", password="pass")
        BoardMembership.objects.create(board=self.board, user=self.collab, role=BoardMembership.Role.COLLABORATOR)

    # ------------------------------------------------------------------
    # Comments
    # ------------------------------------------------------------------

    @patch("boards.views.broadcast_board_event")
    def test_viewer_cannot_post_comment(self, _mock):
        self.client.force_authenticate(self.viewer)
        resp = self.client.post(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/comments/",
            {"body": "hello"},
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    @patch("boards.views.broadcast_board_event")
    def test_collaborator_can_post_comment(self, _mock):
        self.client.force_authenticate(self.collab)
        resp = self.client.post(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/comments/",
            {"body": "hello"},
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

    @patch("boards.views.broadcast_board_event")
    def test_viewer_cannot_delete_comment(self, _mock):
        comment = CardComment.objects.create(card=self.card, author=self.owner, body="original")
        self.client.force_authenticate(self.viewer)
        resp = self.client.delete(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/comments/{comment.pk}/",
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    @patch("boards.views.broadcast_board_event")
    def test_collaborator_can_delete_own_comment(self, _mock):
        comment = CardComment.objects.create(card=self.card, author=self.collab, body="my comment")
        self.client.force_authenticate(self.collab)
        resp = self.client.delete(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/comments/{comment.pk}/",
        )
        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)

    @patch("boards.views.broadcast_board_event")
    def test_collaborator_cannot_delete_other_users_comment(self, _mock):
        comment = CardComment.objects.create(card=self.card, author=self.owner, body="owner comment")
        self.client.force_authenticate(self.collab)
        resp = self.client.delete(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/comments/{comment.pk}/",
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    # ------------------------------------------------------------------
    # Attachments
    # ------------------------------------------------------------------

    @patch("boards.views.broadcast_board_event")
    def test_viewer_cannot_upload_attachment(self, _mock):
        from django.core.files.uploadedfile import SimpleUploadedFile
        self.client.force_authenticate(self.viewer)
        f = SimpleUploadedFile("test.txt", b"hello", content_type="text/plain")
        resp = self.client.post(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/attachments/",
            {"file": f},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    @patch("boards.views.broadcast_board_event")
    def test_collaborator_can_upload_attachment(self, _mock):
        from django.core.files.uploadedfile import SimpleUploadedFile
        self.client.force_authenticate(self.collab)
        f = SimpleUploadedFile("test.txt", b"hello", content_type="text/plain")
        resp = self.client.post(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/attachments/",
            {"file": f},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

    @patch("boards.views.broadcast_board_event")
    def test_viewer_cannot_delete_attachment(self, _mock):
        from boards.models import CardAttachment
        from django.core.files.uploadedfile import SimpleUploadedFile
        att = CardAttachment.objects.create(
            card=self.card,
            file=SimpleUploadedFile("f.txt", b"x", content_type="text/plain"),
            filename="f.txt",
            size=1,
            uploaded_by=self.owner,
        )
        self.client.force_authenticate(self.viewer)
        resp = self.client.delete(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/attachments/{att.pk}/",
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    # ------------------------------------------------------------------
    # Checklist
    # ------------------------------------------------------------------

    @patch("boards.views.broadcast_board_event")
    def test_viewer_cannot_add_checklist_item(self, _mock):
        self.client.force_authenticate(self.viewer)
        resp = self.client.post(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/checklist/",
            {"text": "a task"},
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    @patch("boards.views.broadcast_board_event")
    def test_collaborator_can_add_checklist_item(self, _mock):
        self.client.force_authenticate(self.collab)
        resp = self.client.post(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/checklist/",
            {"text": "a task"},
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

    @patch("boards.views.broadcast_board_event")
    def test_viewer_cannot_patch_checklist_item(self, _mock):
        from boards.models import CardChecklist
        item = CardChecklist.objects.create(card=self.card, text="task", position=0)
        self.client.force_authenticate(self.viewer)
        resp = self.client.patch(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/checklist/{item.pk}/",
            {"is_checked": True},
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    @patch("boards.views.broadcast_board_event")
    def test_collaborator_can_patch_checklist_item(self, _mock):
        from boards.models import CardChecklist
        item = CardChecklist.objects.create(card=self.card, text="task", position=0)
        self.client.force_authenticate(self.collab)
        resp = self.client.patch(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/checklist/{item.pk}/",
            {"is_checked": True},
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    @patch("boards.views.broadcast_board_event")
    def test_viewer_cannot_delete_checklist_item(self, _mock):
        from boards.models import CardChecklist
        item = CardChecklist.objects.create(card=self.card, text="task", position=0)
        self.client.force_authenticate(self.viewer)
        resp = self.client.delete(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/checklist/{item.pk}/",
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    @patch("boards.views.broadcast_board_event")
    def test_collaborator_can_delete_checklist_item(self, _mock):
        from boards.models import CardChecklist
        item = CardChecklist.objects.create(card=self.card, text="task", position=0)
        self.client.force_authenticate(self.collab)
        resp = self.client.delete(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/checklist/{item.pk}/",
        )
        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
