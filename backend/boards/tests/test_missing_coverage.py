"""Tests for code paths with zero coverage identified in the pre-1.0 audit.

Covers: _validate_upload_mime, card_status action,
BoardTemplateListView, and _sanitize_csv_field.
"""
import io
from unittest.mock import patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, BoardTemplate, Card, Column, Swimlane
from boards.views.cards import _validate_upload_mime
from boards.views.import_export import _sanitize_csv_field


PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"


def _make_board(owner):
    board = Board.objects.create(name="B", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col, swim


def _make_card(board, col, swim, user, title="Card"):
    return Card.objects.create(
        board=board, column=col, swimlane=swim,
        title=title, created_by=user, position=0,
    )


# ---------------------------------------------------------------------------
# _validate_upload_mime
# ---------------------------------------------------------------------------

class ValidateUploadMimeTests(TestCase):
    """Unit tests for _validate_upload_mime — the upload security gate."""

    def _make_file(self, content: bytes, content_type: str, name: str = "file"):
        return SimpleUploadedFile(name, content, content_type=content_type)

    def test_jpeg_with_correct_magic_bytes_passes(self):
        # JPEG magic: FF D8 FF
        data = b"\xff\xd8\xff" + b"\x00" * 20
        f = self._make_file(data, "image/jpeg", "photo.jpg")
        self.assertIsNone(_validate_upload_mime(f))

    def test_executable_renamed_as_jpeg_rejected(self):
        # ELF magic bytes (Linux executable) — not in any allowed signature
        data = b"\x7fELF" + b"\x00" * 20
        f = self._make_file(data, "image/jpeg", "photo.jpg")
        error = _validate_upload_mime(f)
        self.assertIsNotNone(error)
        self.assertIn("does not match", error)

    def test_text_plain_with_script_tag_rejected(self):
        data = b"<script>alert(1)</script>"
        f = self._make_file(data, "text/plain", "notes.txt")
        error = _validate_upload_mime(f)
        self.assertIsNotNone(error)
        self.assertIn("HTML/script", error)

    def test_disallowed_mime_type_rejected(self):
        # application/x-executable is not in the allowlist
        data = b"some binary data"
        f = self._make_file(data, "application/x-executable", "virus.bin")
        error = _validate_upload_mime(f)
        self.assertIsNotNone(error)
        self.assertIn("not allowed", error)

    def test_text_plain_clean_passes(self):
        data = b"Just a plain text file with no markup."
        f = self._make_file(data, "text/plain", "readme.txt")
        self.assertIsNone(_validate_upload_mime(f))

    def test_png_with_correct_magic_bytes_passes(self):
        data = b"\x89PNG\r\n\x1a\n" + b"\x00" * 20
        f = self._make_file(data, "image/png", "image.png")
        self.assertIsNone(_validate_upload_mime(f))


# ---------------------------------------------------------------------------
# card_status action
# ---------------------------------------------------------------------------

class CardStatusTests(TestCase):
    """Tests for GET /api/v1/boards/{board_pk}/cards/{pk}/status/"""

    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, self.swim = _make_board(self.user)
        self.card = _make_card(self.board, self.col, self.swim, self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _url(self, board_id, card_id):
        return f"/api/v1/boards/{board_id}/cards/{card_id}/status/"

    def test_active_card_returns_archived_false(self):
        r = self.client.get(self._url(self.board.id, self.card.id))
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json(), {"archived": False})

    @patch(PATCH_BROADCAST)
    def test_archived_card_returns_archived_true(self, _):
        self.card.archived_at = timezone.now()
        self.card.save(update_fields=["archived_at"])
        r = self.client.get(self._url(self.board.id, self.card.id))
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json(), {"archived": True})

    def test_card_from_another_board_returns_404(self):
        other_user = User.objects.create_user(username="other", password="pass")
        other_board, other_col, other_swim = _make_board(other_user)
        other_card = _make_card(other_board, other_col, other_swim, other_user)
        # self.user is not a member of other_board, and the card does not
        # belong to self.board — both conditions should produce 404.
        r = self.client.get(self._url(self.board.id, other_card.id))
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)


# ---------------------------------------------------------------------------
# BoardTemplateListView
# ---------------------------------------------------------------------------

class BoardTemplateListViewTests(TestCase):
    """Tests for GET /api/v1/boards/templates/"""

    URL = "/api/v1/boards/templates/"

    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.client = APIClient()
        self.active = BoardTemplate.objects.create(
            name="Scrum", slug="scrum", description="Sprint board",
            sort_order=1, is_active=True,
        )
        self.inactive = BoardTemplate.objects.create(
            name="Hidden", slug="hidden", description="Not shown",
            sort_order=2, is_active=False,
        )

    def test_authenticated_user_receives_active_templates(self):
        self.client.force_authenticate(self.user)
        r = self.client.get(self.URL)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        names = [t["name"] for t in r.json()]
        self.assertIn("Scrum", names)

    def test_unauthenticated_request_returns_401(self):
        r = self.client.get(self.URL)
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_inactive_templates_excluded(self):
        self.client.force_authenticate(self.user)
        r = self.client.get(self.URL)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        names = [t["name"] for t in r.json()]
        self.assertNotIn("Hidden", names)


# ---------------------------------------------------------------------------
# _sanitize_csv_field
# ---------------------------------------------------------------------------

class SanitizeCsvFieldTests(TestCase):
    """Unit tests for _sanitize_csv_field — CSV formula injection prevention."""

    def test_equals_prefix_stripped(self):
        self.assertEqual(_sanitize_csv_field("=SUM(A1)"), "SUM(A1)")

    def test_plus_prefix_stripped(self):
        self.assertEqual(_sanitize_csv_field("+val"), "val")

    def test_normal_string_unchanged(self):
        self.assertEqual(_sanitize_csv_field("normal"), "normal")

    def test_empty_string_unchanged(self):
        self.assertEqual(_sanitize_csv_field(""), "")

    def test_at_sign_prefix_stripped(self):
        self.assertEqual(_sanitize_csv_field("@IMPORTRANGE(A1)"), "IMPORTRANGE(A1)")

    def test_minus_prefix_stripped(self):
        self.assertEqual(_sanitize_csv_field("-1+2"), "1+2")
