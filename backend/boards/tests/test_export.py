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
        content = r.content.decode("utf-8")
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
        content = r.content.decode("utf-8")
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
        self.assertIn(r.status_code, [status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN])

    def test_non_member_cannot_export(self):
        stranger = User.objects.create_user(username="stranger", password="pass")
        self.client.force_authenticate(stranger)
        r = self.client.get(f"/api/v1/boards/{self.board.id}/export/")
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND])


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
