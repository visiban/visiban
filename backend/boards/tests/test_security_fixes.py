"""Tests for security fixes in issues #219 and #220.

Covers:
  - UserSearchRateThrottle (30/min)
  - File upload MIME / magic-byte validation
  - Board/card import item-count ceilings
  - CSV export formula-injection sanitization
  - Notification actor/action_type structured fields
  - Group ancestry traversal depth-cap warning
"""
import io
import json
from unittest.mock import patch

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, Column, Notification, Swimlane,
)
from boards.views import _sanitize_csv_field, _validate_upload_mime


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_board(owner, name="Board"):
    board = Board.objects.create(name=name, owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col, swim


# ---------------------------------------------------------------------------
# CSV formula injection sanitization
# ---------------------------------------------------------------------------

class SanitizeCsvFieldTests(TestCase):
    def test_strips_equals_prefix(self):
        self.assertEqual(_sanitize_csv_field("=1+1"), "1+1")

    def test_strips_plus_prefix(self):
        self.assertEqual(_sanitize_csv_field("+1"), "1")

    def test_strips_minus_prefix(self):
        self.assertEqual(_sanitize_csv_field("-1"), "1")

    def test_strips_at_prefix(self):
        self.assertEqual(_sanitize_csv_field("@SUM(A1)"), "SUM(A1)")

    def test_strips_tab_prefix(self):
        self.assertEqual(_sanitize_csv_field("\t1"), "1")

    def test_strips_cr_prefix(self):
        self.assertEqual(_sanitize_csv_field("\r1"), "1")

    def test_strips_multiple_prefixes(self):
        self.assertEqual(_sanitize_csv_field("===bad"), "bad")

    def test_leaves_normal_text_unchanged(self):
        self.assertEqual(_sanitize_csv_field("Normal title"), "Normal title")

    def test_leaves_non_string_unchanged(self):
        # Non-string values (integers, None) are passed through as-is
        self.assertEqual(_sanitize_csv_field(42), 42)

    def test_sanitized_values_appear_in_csv_export(self):
        """Titles starting with = are stripped in the exported CSV rows."""
        owner = User.objects.create_user(username="csvowner", password="pass")
        board, col, swim = _make_board(owner)
        Card.objects.create(
            board=board, column=col, swimlane=swim,
            title="=HYPERLINK(\"evil.example.com\")",
            description="",
            priority="medium",
            position=0,
            created_by=owner,
        )
        client = APIClient()
        client.force_authenticate(owner)
        r = client.get(f"/api/boards/{board.id}/export/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        content = r.content.decode("utf-8")
        # The leading = must be stripped in the CSV output.
        self.assertNotIn("=HYPERLINK", content)
        # Python's csv module escapes double-quotes by doubling them, so the
        # literal " in the original title appears as "" in the raw CSV bytes.
        self.assertIn('HYPERLINK(""evil.example.com"")', content)


# ---------------------------------------------------------------------------
# MIME / magic-byte validation helper
# ---------------------------------------------------------------------------

class ValidateUploadMimeTests(TestCase):
    def _make_file(self, content: bytes, content_type: str, name: str = "test.bin"):
        from django.core.files.uploadedfile import SimpleUploadedFile
        return SimpleUploadedFile(name, content, content_type=content_type)

    def test_accepts_valid_jpeg(self):
        f = self._make_file(b"\xff\xd8\xff\xe0" + b"\x00" * 100, "image/jpeg", "photo.jpg")
        self.assertIsNone(_validate_upload_mime(f))

    def test_accepts_valid_png(self):
        f = self._make_file(b"\x89PNG\r\n\x1a\n" + b"\x00" * 100, "image/png", "img.png")
        self.assertIsNone(_validate_upload_mime(f))

    def test_accepts_valid_pdf(self):
        f = self._make_file(b"%PDF-1.4 " + b"\x00" * 100, "application/pdf", "doc.pdf")
        self.assertIsNone(_validate_upload_mime(f))

    def test_accepts_valid_zip(self):
        f = self._make_file(b"PK\x03\x04" + b"\x00" * 100, "application/zip", "arch.zip")
        self.assertIsNone(_validate_upload_mime(f))

    def test_accepts_plain_text(self):
        f = self._make_file(b"hello world", "text/plain", "readme.txt")
        self.assertIsNone(_validate_upload_mime(f))

    def test_accepts_csv(self):
        f = self._make_file(b"Title,Column\nCard 1,Backlog", "text/csv", "data.csv")
        self.assertIsNone(_validate_upload_mime(f))

    def test_rejects_disallowed_mime_type(self):
        f = self._make_file(b"\x7fELF" + b"\x00" * 100, "application/x-executable", "evil.elf")
        error = _validate_upload_mime(f)
        self.assertIsNotNone(error)
        self.assertIn("not allowed", error)

    def test_rejects_jpeg_magic_with_wrong_mime(self):
        # File has JPEG magic bytes but declares itself as an executable
        f = self._make_file(b"\xff\xd8\xff\xe0" + b"\x00" * 100, "application/x-executable", "bad.exe")
        error = _validate_upload_mime(f)
        self.assertIsNotNone(error)

    def test_rejects_binary_with_jpeg_mime_but_wrong_magic(self):
        # Declares image/jpeg but magic bytes don't match any allowed signature
        f = self._make_file(b"\xDE\xAD\xBE\xEF" + b"\x00" * 100, "image/jpeg", "bad.jpg")
        error = _validate_upload_mime(f)
        self.assertIsNotNone(error)
        self.assertIn("not match", error)

    def test_file_pointer_reset_after_validation(self):
        """_validate_upload_mime must not consume the file; content must be readable afterwards."""
        f = self._make_file(b"\xff\xd8\xff\xe0" + b"data", "image/jpeg", "photo.jpg")
        _validate_upload_mime(f)
        self.assertEqual(f.read(), b"\xff\xd8\xff\xe0" + b"data")


class AttachmentUploadMimeValidationTests(TestCase):
    """Integration test: attachment upload endpoint rejects disallowed file types."""

    def setUp(self):
        self.user = User.objects.create_user(username="uploader", password="pass")
        self.board, self.col, self.swim = _make_board(self.user)
        self.card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Card", priority="medium", position=0, created_by=self.user,
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.url = f"/api/boards/{self.board.id}/cards/{self.card.id}/attachments/"

    def _upload(self, content: bytes, content_type: str, filename: str):
        from django.core.files.uploadedfile import SimpleUploadedFile
        f = SimpleUploadedFile(filename, content, content_type=content_type)
        return self.client.post(self.url, {"file": f}, format="multipart")

    def test_rejects_executable_file(self):
        r = self._upload(b"\x7fELF\x00" * 20, "application/x-executable", "malware.elf")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("not allowed", r.data["detail"])

    def test_rejects_mismatched_magic(self):
        # Claims to be JPEG but contains garbage bytes
        r = self._upload(b"\xDE\xAD\xBE\xEF" * 10, "image/jpeg", "fake.jpg")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    @patch("boards.views.CardAttachment.objects.create")
    def test_accepts_valid_jpeg(self, mock_create):
        from boards.models import CardAttachment
        # Return a mock attachment so we don't need to actually write a file
        mock_create.return_value = CardAttachment(
            id=1, filename="photo.jpg", size=10,
            card=self.card, uploaded_by=self.user,
        )
        mock_create.return_value.file = type("f", (), {"url": "/media/photo.jpg"})()
        content = b"\xff\xd8\xff\xe0" + b"\x00" * 100
        r = self._upload(content, "image/jpeg", "photo.jpg")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)


# ---------------------------------------------------------------------------
# Import item-count ceilings
# ---------------------------------------------------------------------------

class ImportItemCountCeilingTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="importer2", password="pass")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _make_json_file(self, data, filename="board.json"):
        content = json.dumps(data).encode("utf-8")
        f = io.BytesIO(content)
        f.name = filename
        return f

    def _base_data(self):
        return {
            "name": "Big Board",
            "columns": [{"name": "Col", "position": 0, "color": "#000"}],
            "swimlanes": [{"name": "Lane", "position": 0, "color": "#000"}],
            "cards": [],
        }

    def test_json_rejects_over_500_cards(self):
        data = self._base_data()
        data["cards"] = [
            {"title": f"Card {i}", "column": "Col", "swimlane": "Lane"}
            for i in range(501)
        ]
        r = self.client.post(
            "/api/boards/import/",
            {"file": self._make_json_file(data)},
            format="multipart",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("501", r.data["detail"])
        self.assertIn("500", r.data["detail"])

    def test_json_rejects_over_50_columns(self):
        data = self._base_data()
        data["columns"] = [{"name": f"Col {i}", "position": i, "color": "#000"} for i in range(51)]
        r = self.client.post(
            "/api/boards/import/",
            {"file": self._make_json_file(data)},
            format="multipart",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("51", r.data["detail"])

    def test_json_rejects_over_100_swimlanes(self):
        data = self._base_data()
        data["swimlanes"] = [{"name": f"Lane {i}", "position": i, "color": "#000"} for i in range(101)]
        r = self.client.post(
            "/api/boards/import/",
            {"file": self._make_json_file(data)},
            format="multipart",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("101", r.data["detail"])

    def test_json_accepts_exactly_500_cards(self):
        data = self._base_data()
        data["cards"] = [
            {"title": f"Card {i}", "column": "Col", "swimlane": "Lane"}
            for i in range(500)
        ]
        r = self.client.post(
            "/api/boards/import/",
            {"file": self._make_json_file(data)},
            format="multipart",
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)

    def _make_csv_file(self, rows, filename="board.csv"):
        import csv
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=["Title", "Column", "Swimlane"])
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
        f = io.BytesIO(buf.getvalue().encode("utf-8"))
        f.name = filename
        return f

    def test_csv_rejects_over_500_rows(self):
        rows = [{"Title": f"Card {i}", "Column": "Backlog", "Swimlane": "General"} for i in range(501)]
        r = self.client.post(
            "/api/boards/import/",
            {"file": self._make_csv_file(rows)},
            format="multipart",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("501", r.data["detail"])

    def test_csv_rejects_over_50_columns(self):
        rows = [{"Title": f"Card {i}", "Column": f"Col{i}", "Swimlane": "General"} for i in range(51)]
        r = self.client.post(
            "/api/boards/import/",
            {"file": self._make_csv_file(rows)},
            format="multipart",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("51", r.data["detail"])

    def test_csv_rejects_over_100_swimlanes(self):
        rows = [{"Title": f"Card {i}", "Column": "Backlog", "Swimlane": f"Lane{i}"} for i in range(101)]
        r = self.client.post(
            "/api/boards/import/",
            {"file": self._make_csv_file(rows)},
            format="multipart",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("101", r.data["detail"])


# ---------------------------------------------------------------------------
# Notification actor / action_type structured fields
# ---------------------------------------------------------------------------

class NotificationStructuredFieldsTests(TestCase):
    def test_notification_stores_actor_and_action_type_on_assign(self):
        owner = User.objects.create_user(username="nowner", password="pass")
        assignee = User.objects.create_user(username="nassignee", password="pass")
        board, col, swim = _make_board(owner)
        card = Card.objects.create(
            board=board, column=col, swimlane=swim,
            title="Task", priority="medium", position=0, created_by=owner,
        )
        BoardMembership.objects.create(board=board, user=assignee, role=BoardMembership.Role.MEMBER)

        client = APIClient()
        client.force_authenticate(owner)
        with patch("boards.views.broadcast_board_event"):
            r = client.patch(
                f"/api/boards/{board.id}/cards/{card.id}/",
                # assignee_id is the write field name on CardSerializer
                {"assignee_id": assignee.id},
                format="json",
            )
        self.assertEqual(r.status_code, status.HTTP_200_OK)

        notif = Notification.objects.filter(recipient=assignee).first()
        self.assertIsNotNone(notif)
        self.assertEqual(notif.actor, owner)
        self.assertEqual(notif.action_type, Notification.ActionType.ASSIGNED)


# ---------------------------------------------------------------------------
# Group ancestry depth-cap warning
# ---------------------------------------------------------------------------

class GroupAncestryDepthCapWarningTests(TestCase):
    def test_get_board_role_emits_warning_when_cap_reached(self):
        from boards.permissions import get_board_role
        from groups.models import Group, GroupMembership

        root_owner = User.objects.create_user(username="gowner", password="pass")
        user = User.objects.create_user(username="guser", password="pass")

        # Create a chain of 8 groups (exceeds the 6-level cap)
        parent = None
        groups = []
        for i in range(8):
            g = Group.objects.create(name=f"Level {i}", owner=root_owner, parent=parent)
            groups.append(g)
            parent = g

        # Deepest group is groups[7]; give user membership only at level 0 (root)
        # so the traversal from groups[7] would need to climb 7 levels to find it
        GroupMembership.objects.create(
            group=groups[0], user=user, role="member"
        )

        # Assign board to the deepest group
        board = Board.objects.create(name="Deep Board", owner=root_owner, group=groups[7])
        BoardMembership.objects.create(board=board, user=root_owner, role=BoardMembership.Role.ADMIN)

        with self.assertLogs("boards.permissions", level="WARNING") as cm:
            role = get_board_role(user, board)

        # The traversal was capped; membership at root was not found
        self.assertIsNone(role)
        self.assertTrue(any("capped" in line for line in cm.output))

    def test_ancestors_warning_when_depth_exceeded(self):
        from groups.models import Group

        root_owner = User.objects.create_user(username="aowner", password="pass")

        # 8 groups deep
        parent = None
        groups = []
        for i in range(8):
            g = Group.objects.create(name=f"Anc {i}", owner=root_owner, parent=parent)
            groups.append(g)
            parent = g

        # Call ancestors() on the deepest group — should warn
        with self.assertLogs("groups.models", level="WARNING") as cm:
            result = groups[7].ancestors()

        # We expect 6 ancestors (the cap), not all 7
        self.assertEqual(len(result), 6)
        self.assertTrue(any("capped" in line for line in cm.output))


# ---------------------------------------------------------------------------
# UserSearchRateThrottle — verify it is wired
# ---------------------------------------------------------------------------

class UserSearchThrottleWiredTests(TestCase):
    def test_user_search_view_has_throttle_class(self):
        from accounts.views import UserSearchView, UserSearchRateThrottle
        self.assertIn(UserSearchRateThrottle, UserSearchView.throttle_classes)

    def test_user_search_throttle_scope(self):
        from accounts.views import UserSearchRateThrottle
        self.assertEqual(UserSearchRateThrottle.scope, "user_search")

    def test_user_search_rate_in_settings(self):
        from django.conf import settings
        rates = settings.REST_FRAMEWORK.get("DEFAULT_THROTTLE_RATES", {})
        self.assertIn("user_search", rates)


# ---------------------------------------------------------------------------
# JoinGroupRateThrottle — verify it is wired
# ---------------------------------------------------------------------------

class JoinGroupThrottleWiredTests(TestCase):
    def test_join_group_view_has_throttle_class(self):
        from groups.views import JoinGroupView, JoinGroupRateThrottle
        self.assertIn(JoinGroupRateThrottle, JoinGroupView.throttle_classes)

    def test_join_group_throttle_scope(self):
        from groups.views import JoinGroupRateThrottle
        self.assertEqual(JoinGroupRateThrottle.scope, "join_group")

    def test_join_group_rate_in_settings(self):
        from django.conf import settings
        rates = settings.REST_FRAMEWORK.get("DEFAULT_THROTTLE_RATES", {})
        self.assertIn("join_group", rates)


# ---------------------------------------------------------------------------
# JoinGroupView logging
# ---------------------------------------------------------------------------

class JoinGroupLoggingTests(TestCase):
    def _make_invite(self, group_owner):
        from groups.models import Group, GroupInviteLink
        group = Group.objects.create(name="LogGroup", owner=group_owner)
        link = GroupInviteLink.objects.create(
            group=group, created_by=group_owner, role="member", is_active=True
        )
        return link

    def test_post_success_is_logged(self):
        owner = User.objects.create_user(username="logowner", password="pass")
        joiner = User.objects.create_user(username="logjoiner", password="pass")
        link = self._make_invite(owner)

        client = APIClient()
        client.force_authenticate(joiner)
        with self.assertLogs("groups.views", level="INFO") as cm:
            r = client.post(f"/api/groups/join/{link.token}/")
        self.assertIn(r.status_code, [status.HTTP_200_OK, status.HTTP_201_CREATED])
        self.assertTrue(any("outcome=success" in line for line in cm.output))

    def test_expired_post_is_logged(self):
        import datetime
        from django.utils import timezone
        from groups.models import Group, GroupInviteLink

        owner = User.objects.create_user(username="logowner2", password="pass")
        group = Group.objects.create(name="ExpGroup", owner=owner)
        past = timezone.now() - datetime.timedelta(days=1)
        link = GroupInviteLink.objects.create(
            group=group, created_by=owner, role="member",
            is_active=True, expires_at=past,
        )

        joiner = User.objects.create_user(username="logjoiner2", password="pass")
        client = APIClient()
        client.force_authenticate(joiner)
        with self.assertLogs("groups.views", level="INFO") as cm:
            r = client.post(f"/api/groups/join/{link.token}/")
        self.assertEqual(r.status_code, status.HTTP_410_GONE)
        self.assertTrue(any("outcome=failure" in line for line in cm.output))
