"""File size limit enforcement tests (#400).

Verify that uploading a file exceeding the 10 MB limit to the card
attachment endpoint returns 400.
"""
from unittest.mock import patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, Column, Swimlane


PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"


def _png_header():
    """PNG magic bytes for content-type validation."""
    return (
        b"\x89PNG\r\n\x1a\n"
        b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x02\x00\x00\x00\x90wS\xde"
    )


def _make_board_and_card():
    owner = User.objects.create_user(username="owner", password="pass")
    board = Board.objects.create(name="Upload Board", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    card = Card.objects.create(
        board=board, column=col, swimlane=swim,
        title="Upload Card", created_by=owner, position=0,
    )
    return board, card, owner


@patch(PATCH_BROADCAST)
class FileSizeLimitTests(TestCase):
    """The attachment endpoint must reject files larger than 10 MB."""

    def setUp(self):
        self.board, self.card, self.owner = _make_board_and_card()
        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        self.url = f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/attachments/"

    def test_file_over_10mb_rejected(self, _broadcast):
        """A file just over the 10 MB limit must be rejected with 400."""
        # 10 MB + 1 byte — exceeds the default MAX_UPLOAD_SIZE
        oversized_content = _png_header() + b"\x00" * (10 * 1024 * 1024 + 1 - len(_png_header()))
        f = SimpleUploadedFile("large.png", oversized_content, content_type="image/png")
        resp = self.client.post(self.url, {"file": f}, format="multipart")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("too large", resp.json()["detail"].lower())

    def test_file_exactly_10mb_accepted(self, _broadcast):
        """A file exactly at the 10 MB limit must be accepted."""
        content = _png_header() + b"\x00" * (10 * 1024 * 1024 - len(_png_header()))
        # Pad with IEND chunk to make it a more valid PNG (not strictly necessary
        # but keeps the magic-byte validator happy).
        f = SimpleUploadedFile("exact.png", content, content_type="image/png")
        resp = self.client.post(self.url, {"file": f}, format="multipart")
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

    def test_small_file_accepted(self, _broadcast):
        """A small file well under the limit must be accepted."""
        small_content = (
            b"\x89PNG\r\n\x1a\n"
            b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
            b"\x08\x02\x00\x00\x00\x90wS\xde"
            b"\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N"
            b"\x00\x00\x00\x00IEND\xaeB`\x82"
        )
        f = SimpleUploadedFile("small.png", small_content, content_type="image/png")
        resp = self.client.post(self.url, {"file": f}, format="multipart")
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
