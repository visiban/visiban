"""Tests for feature toggle: uploads_enabled (issue #312)."""
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import SiteSetting, User
from boards.models import Board, BoardMembership, Card, Column, Swimlane


def _png_bytes():
    """Minimal 1×1 PNG so magic-byte validation passes."""
    return (
        b"\x89PNG\r\n\x1a\n"
        b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x02\x00\x00\x00\x90wS\xde"
        b"\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N"
        b"\x00\x00\x00\x00IEND\xaeB`\x82"
    )


def make_board_and_card():
    owner = User.objects.create_user(username="owner", password="pass123!")
    board = Board.objects.create(name="B", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    card = Card.objects.create(board=board, column=col, swimlane=swim, title="T", position=0)
    return board, card, owner


class UploadsToggleEnforcementTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.board, self.card, self.owner = make_board_and_card()
        self.client.force_authenticate(self.owner)
        self.url = f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/attachments/"

    def _upload(self):
        f = SimpleUploadedFile("test.png", _png_bytes(), content_type="image/png")
        return self.client.post(self.url, {"file": f}, format="multipart")

    def test_upload_allowed_when_enabled(self):
        s = SiteSetting.get()
        s.uploads_enabled = True
        s.save(update_fields=["uploads_enabled"])
        r = self._upload()
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)

    def test_upload_blocked_when_disabled(self):
        s = SiteSetting.get()
        s.uploads_enabled = False
        s.save(update_fields=["uploads_enabled"])
        r = self._upload()
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(r.json().get("code"), "feature_disabled")

    def test_upload_blocked_applies_to_admins_too(self):
        """Disabling uploads blocks even board admins — this is intentional."""
        s = SiteSetting.get()
        s.uploads_enabled = False
        s.save(update_fields=["uploads_enabled"])
        # owner is board admin
        r = self._upload()
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_get_list_unaffected_by_toggle(self):
        """GET attachments is always allowed regardless of toggle state."""
        s = SiteSetting.get()
        s.uploads_enabled = False
        s.save(update_fields=["uploads_enabled"])
        r = self.client.get(self.url)
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_viewer_blocked_before_feature_check(self):
        """Viewer role check happens before the feature toggle."""
        viewer = User.objects.create_user(username="viewer2", password="pass123!")
        BoardMembership.objects.create(board=self.board, user=viewer, role=BoardMembership.Role.VIEWER)
        self.client.force_authenticate(viewer)
        # Even with uploads enabled, viewers cannot upload.
        s = SiteSetting.get()
        s.uploads_enabled = True
        s.save(update_fields=["uploads_enabled"])
        r = self._upload()
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)


class UploadsEnabledInMeEndpointTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass123!")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_me_includes_uploads_enabled_true(self):
        s = SiteSetting.get()
        s.uploads_enabled = True
        s.save(update_fields=["uploads_enabled"])
        r = self.client.get("/api/v1/auth/me/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertTrue(r.json()["uploads_enabled"])

    def test_me_includes_uploads_enabled_false(self):
        s = SiteSetting.get()
        s.uploads_enabled = False
        s.save(update_fields=["uploads_enabled"])
        r = self.client.get("/api/v1/auth/me/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertFalse(r.json()["uploads_enabled"])
