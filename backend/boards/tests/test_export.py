"""Tests for board export (CSV and JSON)."""
import csv
import io
import json

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, CardActivity, CardChecklist, CardComment,
    CardMovement, Column, Label, Swimlane,
)


def _make_board(owner, name="Board"):
    board = Board.objects.create(name=name, owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col, swim


class ExportCsvTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, self.col, self.swim = _make_board(self.owner)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def test_csv_content_type_and_headers(self):
        r = self.client.get(f"/api/v1/boards/{self.board.id}/export/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r["Content-Type"], "text/csv")
        self.assertIn("attachment; filename=", r["Content-Disposition"])
        self.assertIn(".csv", r["Content-Disposition"])

    def test_csv_contains_cards(self):
        label = Label.objects.create(board=self.board, name="Bug", color="#FF0000")
        card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Test Card", description="A description", priority="high",
            assignee=self.owner, created_by=self.owner, weight=3, position=0,
        )
        card.labels.add(label)
        CardMovement.objects.create(
            card=card, from_column=None, to_column=self.col,
            from_swimlane=None, to_swimlane=self.swim, moved_by=self.owner,
            notes="Card created",
        )

        r = self.client.get(f"/api/v1/boards/{self.board.id}/export/")
        content = r.getvalue().decode("utf-8")
        reader = csv.reader(io.StringIO(content))
        rows = list(reader)

        # Header + 1 data row
        self.assertEqual(len(rows), 2)
        header = rows[0]
        self.assertEqual(header[0], "Card ID")
        self.assertEqual(header[1], "Title")

        data = rows[1]
        self.assertEqual(data[1], "Test Card")
        self.assertEqual(data[2], "A description")
        self.assertEqual(data[3], "Backlog")
        self.assertEqual(data[4], "General")
        self.assertEqual(data[5], "high")
        self.assertEqual(data[6], "owner")
        self.assertEqual(data[7], "Bug")
        self.assertEqual(int(data[9]), 3)  # weight
        self.assertEqual(int(data[13]), 1)  # movement count

    def test_csv_empty_board(self):
        r = self.client.get(f"/api/v1/boards/{self.board.id}/export/")
        content = r.getvalue().decode("utf-8")
        reader = csv.reader(io.StringIO(content))
        rows = list(reader)
        # Header only
        self.assertEqual(len(rows), 1)


class ExportJsonTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, self.col, self.swim = _make_board(self.owner)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def test_json_content_type_and_headers(self):
        r = self.client.get(f"/api/v1/boards/{self.board.id}/export/?format=json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r["Content-Type"], "application/json")
        self.assertIn("attachment; filename=", r["Content-Disposition"])
        self.assertIn(".json", r["Content-Disposition"])

    def test_json_structure(self):
        label = Label.objects.create(board=self.board, name="Feature", color="#00FF00")
        card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="JSON Card", description="desc", priority="medium",
            assignee=self.owner, created_by=self.owner, weight=1, position=0,
        )
        card.labels.add(label)
        CardComment.objects.create(card=card, author=self.owner, body="A comment")
        CardChecklist.objects.create(card=card, text="Item 1", is_checked=True, position=0)

        r = self.client.get(f"/api/v1/boards/{self.board.id}/export/?format=json")
        data = json.loads(r.content.decode("utf-8"))

        self.assertEqual(data["name"], "Board")
        self.assertIn("columns", data)
        self.assertIn("swimlanes", data)
        self.assertIn("labels", data)
        self.assertIn("cards", data)

        self.assertEqual(len(data["columns"]), 1)
        self.assertEqual(data["columns"][0]["name"], "Backlog")

        self.assertEqual(len(data["cards"]), 1)
        card_data = data["cards"][0]
        self.assertEqual(card_data["title"], "JSON Card")
        self.assertEqual(card_data["column"], "Backlog")
        self.assertEqual(card_data["swimlane"], "General")
        self.assertEqual(card_data["labels"], ["Feature"])
        self.assertEqual(len(card_data["comments"]), 1)
        self.assertEqual(card_data["comments"][0]["body"], "A comment")
        self.assertEqual(len(card_data["checklist"]), 1)
        self.assertTrue(card_data["checklist"][0]["is_checked"])

    def test_json_includes_movements_and_activities(self):
        card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="History Card", priority="medium", weight=5,
            created_by=self.owner, position=0,
        )
        CardMovement.objects.create(
            card=card, from_column=None, to_column=self.col,
            from_swimlane=None, to_swimlane=self.swim,
            from_column_name="", to_column_name="Backlog",
            from_swimlane_name="", to_swimlane_name="General",
            from_column_uid="", to_column_uid=self.col.uid,
            from_swimlane_uid="", to_swimlane_uid=self.swim.uid,
            moved_by=self.owner,
        )
        CardActivity.objects.create(
            card=card, event_type=CardActivity.EventType.WEIGHT_CHANGE,
            from_value="1", to_value="5", actor=self.owner,
        )

        r = self.client.get(f"/api/v1/boards/{self.board.id}/export/?format=json")
        data = json.loads(r.content.decode("utf-8"))
        card_data = data["cards"][0]

        self.assertEqual(len(card_data["movements"]), 1)
        mv = card_data["movements"][0]
        self.assertIsNone(mv["from_column"])
        self.assertEqual(mv["to_column"], "Backlog")
        self.assertEqual(mv["moved_by"], "owner")
        self.assertIn("moved_at", mv)

        self.assertEqual(len(card_data["activities"]), 1)
        act = card_data["activities"][0]
        self.assertEqual(act["event_type"], "weight_change")
        self.assertEqual(act["from_value"], "1")
        self.assertEqual(act["to_value"], "5")
        self.assertEqual(act["actor"], "owner")
        self.assertIn("created_at", act)

    def test_json_empty_board(self):
        r = self.client.get(f"/api/v1/boards/{self.board.id}/export/?format=json")
        data = json.loads(r.content.decode("utf-8"))
        self.assertEqual(data["cards"], [])


class ExportPermissionTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, self.col, self.swim = _make_board(self.owner)
        self.client = APIClient()

    def test_viewer_can_export(self):
        """Viewers can export — they already have read access to all card/movement data (#384)."""
        viewer = User.objects.create_user(username="viewer", password="pass")
        BoardMembership.objects.create(board=self.board, user=viewer, role=BoardMembership.Role.VIEWER)
        self.client.force_authenticate(viewer)
        r = self.client.get(f"/api/v1/boards/{self.board.id}/export/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_collaborator_can_export(self):
        """Collaborators can export — consistent with their read access to card data (#384)."""
        collab = User.objects.create_user(username="collab", password="pass")
        BoardMembership.objects.create(board=self.board, user=collab, role=BoardMembership.Role.COLLABORATOR)
        self.client.force_authenticate(collab)
        r = self.client.get(f"/api/v1/boards/{self.board.id}/export/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_unauthenticated_cannot_export(self):
        r = self.client.get(f"/api/v1/boards/{self.board.id}/export/")
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_non_member_cannot_export(self):
        stranger = User.objects.create_user(username="stranger", password="pass")
        self.client.force_authenticate(stranger)
        r = self.client.get(f"/api/v1/boards/{self.board.id}/export/")
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)


class ExportJsonSwimlanePiiTests(TestCase):
    """Swimlane PII (contact_email, notes) must only appear for admin roles (#417)."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, self.col, self.swim = _make_board(self.owner)
        # Add PII to the swimlane
        self.swim.contact_email = "secret@example.com"
        self.swim.notes = "Internal notes about the customer"
        self.swim.save()
        self.client = APIClient()

    def _export_json(self):
        r = self.client.get(f"/api/v1/boards/{self.board.id}/export/?format=json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        return json.loads(r.content.decode("utf-8"))

    def test_admin_sees_swimlane_pii(self):
        """Admin-role members receive contact_email and notes in JSON export."""
        self.client.force_authenticate(self.owner)  # owner has admin role
        data = self._export_json()
        sw = data["swimlanes"][0]
        self.assertEqual(sw["contact_email"], "secret@example.com")
        self.assertEqual(sw["notes"], "Internal notes about the customer")

    def test_member_does_not_see_swimlane_pii(self):
        """Member-role users must not receive contact_email or notes."""
        member = User.objects.create_user(username="member", password="pass")
        BoardMembership.objects.create(
            board=self.board, user=member, role=BoardMembership.Role.MEMBER,
        )
        self.client.force_authenticate(member)
        data = self._export_json()
        sw = data["swimlanes"][0]
        self.assertNotIn("contact_email", sw)
        self.assertNotIn("notes", sw)

    def test_site_admin_sees_swimlane_pii(self):
        """Site admins receive contact_email and notes even without board membership."""
        site_admin = User.objects.create_user(
            username="siteadmin", password="pass",
            is_site_admin=True, can_access_all_content=True,
        )
        self.client.force_authenticate(site_admin)
        data = self._export_json()
        sw = data["swimlanes"][0]
        self.assertEqual(sw["contact_email"], "secret@example.com")
        self.assertEqual(sw["notes"], "Internal notes about the customer")


class ExportFormatNegotiation1790Tests(TestCase):
    """``?format=csv`` must negotiate to CSV, not 404 (#1790)."""

    def setUp(self):
        from django.contrib.auth import get_user_model
        from rest_framework.test import APIClient
        User = get_user_model()
        self.owner = User.objects.create_user(username="fmt1790_owner", password="x")
        self.outsider = User.objects.create_user(username="fmt1790_out", password="x")
        self.board = Board.objects.create(name="Fmt Board", owner=self.owner)
        self.url = f"/api/v1/boards/{self.board.id}/export/"
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def test_format_csv_returns_csv_identical_to_default(self):
        default = self.client.get(self.url)
        explicit = self.client.get(self.url, {"format": "csv"})
        self.assertEqual(explicit.status_code, 200)
        self.assertEqual(explicit["Content-Type"], "text/csv")
        self.assertIn("attachment", explicit["Content-Disposition"])
        self.assertEqual(explicit.getvalue(), default.getvalue())

    def test_omitted_and_json_unchanged(self):
        self.assertEqual(self.client.get(self.url)["Content-Type"], "text/csv")
        r = self.client.get(self.url, {"format": "json"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r["Content-Type"], "application/json")

    def test_format_api_still_returns_csv(self):
        # Pinned: ``api`` is the browsable-API renderer's format key; it has
        # always fallen through to the CSV default.
        r = self.client.get(self.url, {"format": "api"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r["Content-Type"], "text/csv")

    def test_unknown_format_still_404(self):
        self.assertEqual(self.client.get(self.url, {"format": "xml"}).status_code, 404)

    def test_permissions_unchanged_for_format_csv(self):
        self.client.force_authenticate(self.outsider)
        self.assertEqual(self.client.get(self.url, {"format": "csv"}).status_code, 404)
        self.client.logout()
        self.client.force_authenticate(None)
        self.assertEqual(self.client.get(self.url, {"format": "csv"}).status_code, 401)

    def test_restricted_error_body_keeps_structured_code_for_format_csv(self):
        self.board.export_min_role = "admin"
        self.board.save(update_fields=["export_min_role"])
        from boards.models import BoardMembership
        from accounts.models import User as U
        viewer = U.objects.create_user(username="fmt1790_view", password="x")
        BoardMembership.objects.create(board=self.board, user=viewer, role="viewer")
        self.client.force_authenticate(viewer)
        r = self.client.get(self.url, {"format": "csv"})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r["Content-Type"], "application/json")
        body = json.loads(r.content)
        self.assertEqual(body["code"], "export_restricted")

    def test_errors_under_format_csv_are_json_like_format_json(self):
        self.client.force_authenticate(None)
        a = self.client.get(self.url, {"format": "csv"})
        b = self.client.get(self.url, {"format": "json"})
        self.assertEqual(a.status_code, 401)
        self.assertEqual(a["Content-Type"], b["Content-Type"])
        self.assertEqual(a.content, b.content)

    def test_accept_json_with_format_csv_still_returns_csv(self):
        r = self.client.get(self.url, {"format": "csv"}, HTTP_ACCEPT="application/json")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r["Content-Type"], "text/csv")

    def test_accept_text_csv_without_format_stays_406(self):
        # Pinned: no renderer serves text/csv, as before #1790.
        r = self.client.get(self.url, HTTP_ACCEPT="text/csv")
        self.assertEqual(r.status_code, 406)

    def test_throttled_under_format_csv_is_json_429(self):
        from unittest import mock
        from boards.views.import_export import BoardExportThrottle
        with mock.patch.object(BoardExportThrottle, "allow_request", return_value=False), \
                mock.patch.object(BoardExportThrottle, "wait", return_value=1):
            r = self.client.get(self.url, {"format": "csv"})
        self.assertEqual(r.status_code, 429)
        self.assertEqual(r["Content-Type"], "application/json")
