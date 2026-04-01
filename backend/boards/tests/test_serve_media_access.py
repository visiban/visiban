"""Tests for ServeMediaView non-member access and path traversal (#411).

ServeMediaView must:
1. Reject non-members with 404 (not 403, to avoid leaking file existence).
2. Reject path traversal attempts.
3. Allow board members to access their board's attachments.
"""
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, CardAttachment, Column, Swimlane


def _make_board(owner, name="Board"):
    board = Board.objects.create(name=name, owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col, swim


class ServeMediaNonMemberTests(TestCase):
    """Covers #411: non-member cannot access board attachments."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.non_member = User.objects.create_user(username="outsider", password="pass")
        self.board, self.col, self.swim = _make_board(self.owner)
        self.card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Card", priority="medium", position=0, created_by=self.owner,
        )
        f = SimpleUploadedFile("secret.pdf", b"%PDF-1.4 secret data", content_type="application/pdf")
        self.attachment = CardAttachment.objects.create(
            card=self.card, file=f, filename="secret.pdf", size=20, uploaded_by=self.owner,
        )
        self.client = APIClient()

    def test_non_member_gets_404(self):
        """A non-member must receive 404, not 403, to avoid confirming
        that the file path is a valid attachment (IDOR prevention)."""
        self.client.force_authenticate(self.non_member)
        r = self.client.get(f"/media/{self.attachment.file.name}")
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)

    def test_unauthenticated_gets_401_or_403(self):
        """Unauthenticated requests must be rejected."""
        anon = APIClient()
        r = anon.get(f"/media/{self.attachment.file.name}")
        self.assertIn(r.status_code, [status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN])

    def test_board_member_can_access(self):
        """A board member should be able to access the attachment."""
        self.client.force_authenticate(self.owner)
        r = self.client.get(f"/media/{self.attachment.file.name}")
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_member_of_different_board_gets_404(self):
        """A member of a different board cannot access this board's attachments."""
        other_owner = User.objects.create_user(username="other_owner", password="pass")
        other_board, _, _ = _make_board(other_owner, "Other Board")
        # other_owner is a member of other_board but not self.board
        self.client.force_authenticate(other_owner)
        r = self.client.get(f"/media/{self.attachment.file.name}")
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)


class ServeMediaPathTraversalTests(TestCase):
    """Covers #411: path traversal attempts must be rejected."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner_pt", password="pass")
        self.board, self.col, self.swim = _make_board(self.owner)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def test_dot_dot_slash_returns_404(self):
        """Path traversal with ../ must not serve files outside the media root."""
        r = self.client.get("/media/../etc/passwd")
        self.assertIn(r.status_code, [status.HTTP_400_BAD_REQUEST, status.HTTP_404_NOT_FOUND])

    def test_encoded_dot_dot_returns_404(self):
        """URL-encoded path traversal (..%2F) must also be rejected."""
        r = self.client.get("/media/..%2F..%2Fetc%2Fpasswd")
        self.assertIn(r.status_code, [status.HTTP_400_BAD_REQUEST, status.HTTP_404_NOT_FOUND])

    def test_nonexistent_file_returns_404(self):
        """A file path that does not match any attachment returns 404."""
        r = self.client.get("/media/attachments/nonexistent-file.pdf")
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)

    def test_absolute_path_returns_404(self):
        """An absolute path in the URL must not bypass the media root."""
        r = self.client.get("/media//etc/passwd")
        self.assertIn(r.status_code, [status.HTTP_400_BAD_REQUEST, status.HTTP_404_NOT_FOUND])


class ServeMediaContentDispositionTests(TestCase):
    """ServeMediaView must force-download non-image files to prevent stored XSS (#588).

    Only known-safe image types (JPEG, PNG, GIF, WebP) are served inline.
    All other types — including text/plain — must carry Content-Disposition: attachment
    so browsers download rather than render them.
    """

    def setUp(self):
        self.owner = User.objects.create_user(username="owner_cd", password="pass")
        self.board, self.col, self.swim = _make_board(self.owner)
        self.card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Card", priority="medium", position=0, created_by=self.owner,
        )
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def _make_attachment(self, content: bytes, filename: str, content_type: str) -> "CardAttachment":
        from django.core.files.uploadedfile import SimpleUploadedFile
        f = SimpleUploadedFile(filename, content, content_type=content_type)
        return CardAttachment.objects.create(
            card=self.card, file=f, filename=filename, size=len(content),
            uploaded_by=self.owner,
        )

    def test_plain_text_served_as_attachment_not_inline(self):
        """text/plain files must be served with Content-Disposition: attachment."""
        att = self._make_attachment(b"hello world", "notes.txt", "text/plain")
        r = self.client.get(f"/media/{att.file.name}")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        disposition = r.get("Content-Disposition", "")
        self.assertIn("attachment", disposition,
            "text/plain must not be served inline — it could render HTML/script payloads in the browser")

    def test_pdf_served_as_attachment_not_inline(self):
        """PDF files must be served with Content-Disposition: attachment."""
        att = self._make_attachment(b"%PDF-1.4 data", "doc.pdf", "application/pdf")
        r = self.client.get(f"/media/{att.file.name}")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        disposition = r.get("Content-Disposition", "")
        self.assertIn("attachment", disposition)

    def test_jpeg_served_inline(self):
        """JPEG images may be served inline — they cannot execute scripts."""
        att = self._make_attachment(
            b"\xff\xd8\xff\xe0" + b"\x00" * 100, "photo.jpg", "image/jpeg"
        )
        r = self.client.get(f"/media/{att.file.name}")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        disposition = r.get("Content-Disposition", "inline")
        self.assertEqual(disposition, "inline",
            "JPEG images should be served inline for a better UX")
