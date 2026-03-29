"""Cross-board IDOR tests (#399).

Verify that a member of Board A cannot access resources belonging to Board B:
cards (read/update/delete), comments (create), and attachments (upload).
"""
from unittest.mock import patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, Column, Swimlane


PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"


def _png_bytes():
    """Minimal 1x1 PNG so magic-byte validation passes."""
    return (
        b"\x89PNG\r\n\x1a\n"
        b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x02\x00\x00\x00\x90wS\xde"
        b"\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N"
        b"\x00\x00\x00\x00IEND\xaeB`\x82"
    )


def _make_board(owner, name="Board"):
    """Create a board with one column, one swimlane, and one card."""
    board = Board.objects.create(name=name, owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    card = Card.objects.create(
        board=board, column=col, swimlane=swim,
        title=f"{name} Card", created_by=owner, position=0,
    )
    return board, col, swim, card


@patch(PATCH_BROADCAST)
class CrossBoardCardIDORTests(TestCase):
    """A member of Board A must not read, update, or delete cards on Board B."""

    def setUp(self):
        self.owner_a = User.objects.create_user(username="owner_a", password="pass")
        self.owner_b = User.objects.create_user(username="owner_b", password="pass")

        self.board_a, self.col_a, self.swim_a, self.card_a = _make_board(self.owner_a, "Board A")
        self.board_b, self.col_b, self.swim_b, self.card_b = _make_board(self.owner_b, "Board B")

        # owner_a is a member of Board A only
        self.client = APIClient()
        self.client.force_authenticate(self.owner_a)

    def test_cannot_read_card_on_other_board(self, _broadcast):
        resp = self.client.get(
            f"/api/boards/{self.board_b.pk}/cards/{self.card_b.pk}/",
        )
        self.assertIn(resp.status_code, (status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND))

    def test_cannot_update_card_on_other_board(self, _broadcast):
        resp = self.client.patch(
            f"/api/boards/{self.board_b.pk}/cards/{self.card_b.pk}/",
            {"title": "Hijacked"},
        )
        self.assertIn(resp.status_code, (status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND))

    def test_cannot_delete_card_on_other_board(self, _broadcast):
        resp = self.client.delete(
            f"/api/boards/{self.board_b.pk}/cards/{self.card_b.pk}/",
        )
        self.assertIn(resp.status_code, (status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND))

    def test_cannot_list_cards_on_other_board(self, _broadcast):
        resp = self.client.get(f"/api/boards/{self.board_b.pk}/cards/")
        self.assertIn(resp.status_code, (status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND))

    def test_cannot_move_card_on_other_board(self, _broadcast):
        resp = self.client.post(
            f"/api/boards/{self.board_b.pk}/cards/{self.card_b.pk}/move/",
            {"column_id": self.col_b.pk, "swimlane_id": self.swim_b.pk, "position": 0},
        )
        self.assertIn(resp.status_code, (status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND))


@patch(PATCH_BROADCAST)
class CrossBoardCommentIDORTests(TestCase):
    """A member of Board A must not create comments on cards belonging to Board B."""

    def setUp(self):
        self.owner_a = User.objects.create_user(username="owner_a", password="pass")
        self.owner_b = User.objects.create_user(username="owner_b", password="pass")

        self.board_a, _, _, self.card_a = _make_board(self.owner_a, "Board A")
        self.board_b, _, _, self.card_b = _make_board(self.owner_b, "Board B")

        self.client = APIClient()
        self.client.force_authenticate(self.owner_a)

    def test_cannot_create_comment_on_other_board_card(self, _broadcast):
        resp = self.client.post(
            f"/api/boards/{self.board_b.pk}/cards/{self.card_b.pk}/comments/",
            {"body": "Sneaky comment"},
        )
        self.assertIn(resp.status_code, (status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND))

    def test_cannot_list_comments_on_other_board_card(self, _broadcast):
        resp = self.client.get(
            f"/api/boards/{self.board_b.pk}/cards/{self.card_b.pk}/comments/",
        )
        self.assertIn(resp.status_code, (status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND))


@patch(PATCH_BROADCAST)
class CrossBoardAttachmentIDORTests(TestCase):
    """A member of Board A must not upload attachments to cards on Board B."""

    def setUp(self):
        self.owner_a = User.objects.create_user(username="owner_a", password="pass")
        self.owner_b = User.objects.create_user(username="owner_b", password="pass")

        self.board_a, _, _, self.card_a = _make_board(self.owner_a, "Board A")
        self.board_b, _, _, self.card_b = _make_board(self.owner_b, "Board B")

        self.client = APIClient()
        self.client.force_authenticate(self.owner_a)

    def test_cannot_upload_attachment_to_other_board_card(self, _broadcast):
        f = SimpleUploadedFile("test.png", _png_bytes(), content_type="image/png")
        resp = self.client.post(
            f"/api/boards/{self.board_b.pk}/cards/{self.card_b.pk}/attachments/",
            {"file": f},
            format="multipart",
        )
        self.assertIn(resp.status_code, (status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND))

    def test_cannot_list_attachments_on_other_board_card(self, _broadcast):
        resp = self.client.get(
            f"/api/boards/{self.board_b.pk}/cards/{self.card_b.pk}/attachments/",
        )
        self.assertIn(resp.status_code, (status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND))
