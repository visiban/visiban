"""Tests for board export edge cases: CSV injection vectors, unicode/emoji,
empty boards, and field completeness."""
import csv
import io
import json

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, Column, Swimlane,
)


def _make_board(owner, name="Board"):
    board = Board.objects.create(name=name, owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col, swim


class CsvSpecialCharacterTests(TestCase):
    """CSV export with special characters that are potential injection vectors."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, self.col, self.swim = _make_board(self.owner)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def test_csv_with_commas_in_title(self):
        Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Fix bug, refactor code, deploy", created_by=self.owner, position=0,
        )
        r = self.client.get(f"/api/boards/{self.board.id}/export/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        reader = csv.reader(io.StringIO(r.content.decode("utf-8")))
        rows = list(reader)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[1][1], "Fix bug, refactor code, deploy")

    def test_csv_with_quotes_in_title(self):
        Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title='Update "README" file', created_by=self.owner, position=0,
        )
        r = self.client.get(f"/api/boards/{self.board.id}/export/")
        reader = csv.reader(io.StringIO(r.content.decode("utf-8")))
        rows = list(reader)
        self.assertEqual(rows[1][1], 'Update "README" file')

    def test_csv_with_newlines_in_description(self):
        Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Card", description="Line 1\nLine 2\nLine 3",
            created_by=self.owner, position=0,
        )
        r = self.client.get(f"/api/boards/{self.board.id}/export/")
        reader = csv.reader(io.StringIO(r.content.decode("utf-8")))
        rows = list(reader)
        self.assertEqual(len(rows), 2)
        self.assertIn("Line 1", rows[1][2])
        self.assertIn("Line 2", rows[1][2])

    def test_csv_with_formula_injection_in_title(self):
        """CSV injection vectors like =SUM(), +cmd, -cmd, @SUM should be
        preserved literally (proper quoting by Python csv module)."""
        Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="=SUM(A1:A10)", created_by=self.owner, position=0,
        )
        r = self.client.get(f"/api/boards/{self.board.id}/export/")
        reader = csv.reader(io.StringIO(r.content.decode("utf-8")))
        rows = list(reader)
        # The csv module should preserve the literal string
        self.assertEqual(rows[1][1], "=SUM(A1:A10)")


class JsonUnicodeTests(TestCase):
    """JSON export with unicode and emoji in card content."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, self.col, self.swim = _make_board(self.owner)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def test_json_with_unicode_in_description(self):
        Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Unicode card", description="Cafe\u0301 \u00fc\u00f6\u00e4 \u4f60\u597d \u0410\u0411\u0412",
            created_by=self.owner, position=0,
        )
        r = self.client.get(f"/api/boards/{self.board.id}/export/?format=json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        data = json.loads(r.content.decode("utf-8"))
        card = data["cards"][0]
        self.assertIn("\u4f60\u597d", card["description"])
        self.assertIn("\u0410\u0411\u0412", card["description"])

    def test_json_with_emoji_in_description(self):
        Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Emoji card", description="Ship it! \U0001f680\U0001f389\u2728",
            created_by=self.owner, position=0,
        )
        r = self.client.get(f"/api/boards/{self.board.id}/export/?format=json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        data = json.loads(r.content.decode("utf-8"))
        card = data["cards"][0]
        self.assertIn("\U0001f680", card["description"])


class ExportEmptyBoardTests(TestCase):
    """Export of a board with no cards."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, self.col, self.swim = _make_board(self.owner)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def test_csv_empty_board_has_header_only(self):
        r = self.client.get(f"/api/boards/{self.board.id}/export/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        reader = csv.reader(io.StringIO(r.content.decode("utf-8")))
        rows = list(reader)
        self.assertEqual(len(rows), 1)  # header only

    def test_json_empty_board_has_empty_cards_list(self):
        r = self.client.get(f"/api/boards/{self.board.id}/export/?format=json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        data = json.loads(r.content.decode("utf-8"))
        self.assertEqual(data["cards"], [])
        # Board structure should still be present
        self.assertIn("columns", data)
        self.assertIn("swimlanes", data)
        self.assertIn("labels", data)


class ExportFieldCompletenessTests(TestCase):
    """Verify that exports include all expected fields."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, self.col, self.swim = _make_board(self.owner)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        self.card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Test", description="desc", priority="high",
            assignee=self.owner, created_by=self.owner, weight=5, position=0,
        )

    def test_csv_header_contains_all_expected_fields(self):
        r = self.client.get(f"/api/boards/{self.board.id}/export/")
        reader = csv.reader(io.StringIO(r.content.decode("utf-8")))
        header = next(reader)
        expected = [
            "Card ID", "Title", "Description", "Column", "Swimlane",
            "Priority", "Assignee", "Labels", "Due Date", "Weight",
            "Created At", "Created By", "Last Moved At", "Movement Count",
            "Movement History",
        ]
        self.assertEqual(header, expected)

    def test_json_card_contains_all_expected_fields(self):
        r = self.client.get(f"/api/boards/{self.board.id}/export/?format=json")
        data = json.loads(r.content.decode("utf-8"))
        card = data["cards"][0]
        expected_keys = {
            "title", "description", "column", "swimlane", "priority",
            "assignee", "labels", "due_date", "weight", "position",
            "created_at", "created_by", "comments", "checklist",
        }
        self.assertTrue(expected_keys.issubset(card.keys()), f"Missing keys: {expected_keys - card.keys()}")

    def test_json_board_contains_all_expected_top_level_fields(self):
        r = self.client.get(f"/api/boards/{self.board.id}/export/?format=json")
        data = json.loads(r.content.decode("utf-8"))
        expected_keys = {"name", "description", "columns", "swimlanes", "labels", "cards"}
        self.assertTrue(expected_keys.issubset(data.keys()), f"Missing keys: {expected_keys - data.keys()}")
