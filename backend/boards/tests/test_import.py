import io
import json

from django.test import TestCase, TransactionTestCase
from rest_framework.test import APIClient
from rest_framework import status

from accounts.models import User
from boards.models import Board, BoardMembership, Column, Swimlane, Label, Card, CardComment, CardChecklist


class BoardImportJSONTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="importer", password="pass")
        self.client.force_authenticate(self.user)

    def _make_json_file(self, data, filename="board.json"):
        content = json.dumps(data).encode("utf-8")
        f = io.BytesIO(content)
        f.name = filename
        return f

    def _valid_json_data(self):
        return {
            "name": "Exported Board",
            "description": "A test board",
            "columns": [
                {"name": "To Do", "position": 0, "color": "#3B82F6", "wip_limit": 5, "weight_limit": None, "allow_card_creation": True},
                {"name": "Done", "position": 1, "color": "#10B981", "wip_limit": None, "weight_limit": None, "allow_card_creation": False},
            ],
            "swimlanes": [
                {"name": "General", "position": 0, "color": "#6B7280", "contact_email": "", "notes": ""},
            ],
            "labels": [
                {"name": "Bug", "color": "#EF4444"},
                {"name": "Feature", "color": "#3B82F6"},
            ],
            "cards": [
                {
                    "title": "Fix login",
                    "description": "Login is broken",
                    "column": "To Do",
                    "swimlane": "General",
                    "priority": "high",
                    "assignee": None,
                    "labels": ["Bug"],
                    "due_date": None,
                    "weight": 3,
                    "position": 0,
                    "comments": [
                        {"author": "someone", "body": "This is urgent", "created_at": "2026-01-01T00:00:00Z"},
                    ],
                    "checklist": [
                        {"text": "Reproduce issue", "is_checked": True},
                        {"text": "Write fix", "is_checked": False},
                    ],
                },
            ],
        }

    def test_json_import_creates_board(self):
        data = self._valid_json_data()
        resp = self.client.post(
            "/api/boards/import/",
            {"file": self._make_json_file(data)},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.data["name"], "Exported Board")

    def test_json_import_creates_correct_structure(self):
        data = self._valid_json_data()
        resp = self.client.post(
            "/api/boards/import/",
            {"file": self._make_json_file(data)},
            format="multipart",
        )
        board_id = resp.data["id"]

        self.assertEqual(Column.objects.filter(board_id=board_id).count(), 2)
        self.assertEqual(Swimlane.objects.filter(board_id=board_id).count(), 1)
        self.assertEqual(Label.objects.filter(board_id=board_id).count(), 2)
        self.assertEqual(Card.objects.filter(board_id=board_id).count(), 1)

        card = Card.objects.get(board_id=board_id)
        self.assertEqual(card.title, "Fix login")
        self.assertEqual(card.priority, "high")
        self.assertEqual(card.weight, 3)
        self.assertEqual(card.labels.count(), 1)
        self.assertEqual(card.labels.first().name, "Bug")
        self.assertEqual(CardComment.objects.filter(card=card).count(), 1)
        self.assertEqual(CardChecklist.objects.filter(card=card).count(), 2)

    def test_json_import_name_override(self):
        data = self._valid_json_data()
        resp = self.client.post(
            "/api/boards/import/",
            {"file": self._make_json_file(data), "name": "My Custom Name"},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.data["name"], "My Custom Name")

    def test_json_import_correct_owner(self):
        data = self._valid_json_data()
        resp = self.client.post(
            "/api/boards/import/",
            {"file": self._make_json_file(data)},
            format="multipart",
        )
        board = Board.objects.get(pk=resp.data["id"])
        self.assertEqual(board.owner, self.user)
        membership = BoardMembership.objects.get(board=board, user=self.user)
        self.assertEqual(membership.role, BoardMembership.Role.ADMIN)

    def test_invalid_json_returns_400(self):
        f = io.BytesIO(b"not valid json{{{")
        f.name = "bad.json"
        resp = self.client.post("/api/boards/import/", {"file": f}, format="multipart")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("Invalid JSON", resp.data["detail"])

    def test_missing_required_fields_returns_400(self):
        # Missing columns
        data = {"name": "Test", "swimlanes": [{"name": "General"}]}
        resp = self.client.post(
            "/api/boards/import/",
            {"file": self._make_json_file(data)},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("columns", resp.data["detail"])

    def test_missing_card_required_fields_returns_400(self):
        data = self._valid_json_data()
        data["cards"] = [{"description": "No title"}]
        resp = self.client.post(
            "/api/boards/import/",
            {"file": self._make_json_file(data)},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("title", resp.data["detail"])

    def test_unauthenticated_cannot_import(self):
        anon = APIClient()
        data = self._valid_json_data()
        resp = anon.post(
            "/api/boards/import/",
            {"file": self._make_json_file(data)},
            format="multipart",
        )
        self.assertIn(resp.status_code, (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN))


class BoardImportCSVTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="importer", password="pass")
        self.client.force_authenticate(self.user)

    def _make_csv_file(self, content, filename="board.csv"):
        f = io.BytesIO(content.encode("utf-8"))
        f.name = filename
        return f

    def _valid_csv_content(self):
        return (
            "Card ID,Title,Description,Column,Swimlane,Priority,Assignee,Labels,Due Date,Weight,Created At,Created By,Last Moved At,Movement Count,Movement History\n"
            '1,Fix login,Login is broken,To Do,General,high,,Bug,,,2026-01-01,importer,,,\n'
            '2,Add dashboard,,Done,General,medium,,"Bug,Feature",,2,2026-01-02,importer,,,\n'
        )

    def test_csv_import_creates_board(self):
        resp = self.client.post(
            "/api/boards/import/",
            {"file": self._make_csv_file(self._valid_csv_content()), "name": "CSV Board"},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.data["name"], "CSV Board")

    def test_csv_import_creates_correct_structure(self):
        resp = self.client.post(
            "/api/boards/import/",
            {"file": self._make_csv_file(self._valid_csv_content()), "name": "CSV Board"},
            format="multipart",
        )
        board_id = resp.data["id"]

        columns = list(Column.objects.filter(board_id=board_id).order_by("position").values_list("name", flat=True))
        self.assertEqual(columns, ["To Do", "Done"])

        swimlanes = list(Swimlane.objects.filter(board_id=board_id).values_list("name", flat=True))
        self.assertEqual(swimlanes, ["General"])

        labels = set(Label.objects.filter(board_id=board_id).values_list("name", flat=True))
        self.assertEqual(labels, {"Bug", "Feature"})

        self.assertEqual(Card.objects.filter(board_id=board_id).count(), 2)

        card1 = Card.objects.get(board_id=board_id, title="Fix login")
        self.assertEqual(card1.priority, "high")
        self.assertEqual(card1.labels.count(), 1)

        card2 = Card.objects.get(board_id=board_id, title="Add dashboard")
        self.assertEqual(card2.weight, 2)
        self.assertEqual(card2.labels.count(), 2)

    def test_invalid_csv_returns_400(self):
        # Missing required headers
        csv_content = "Name,Description\nFoo,Bar\n"
        resp = self.client.post(
            "/api/boards/import/",
            {"file": self._make_csv_file(csv_content)},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("missing required headers", resp.data["detail"])

    def test_csv_missing_required_field_in_row_returns_400(self):
        csv_content = (
            "Card ID,Title,Description,Column,Swimlane,Priority,Assignee,Labels,Due Date,Weight,Created At,Created By,Last Moved At,Movement Count,Movement History\n"
            ",,,To Do,General,medium,,,,,,,,,,\n"
        )
        resp = self.client.post(
            "/api/boards/import/",
            {"file": self._make_csv_file(csv_content)},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("Title", resp.data["detail"])

    def test_csv_import_correct_owner(self):
        resp = self.client.post(
            "/api/boards/import/",
            {"file": self._make_csv_file(self._valid_csv_content()), "name": "CSV Board"},
            format="multipart",
        )
        board = Board.objects.get(pk=resp.data["id"])
        self.assertEqual(board.owner, self.user)

    def test_no_file_returns_400(self):
        resp = self.client.post("/api/boards/import/", {}, format="multipart")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("No file", resp.data["detail"])

    def test_unsupported_format_returns_400(self):
        f = io.BytesIO(b"some data")
        f.name = "board.xml"
        resp = self.client.post("/api/boards/import/", {"file": f}, format="multipart")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("Unsupported", resp.data["detail"])


class BoardImportEdgeCaseTests(TestCase):
    """Edge case tests for board import: malformed files, duplicates, permissions."""

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="importer", password="pass")
        self.client.force_authenticate(self.user)

    def _make_json_file(self, data, filename="board.json"):
        content = json.dumps(data).encode("utf-8")
        f = io.BytesIO(content)
        f.name = filename
        return f

    def _valid_json_data(self):
        return {
            "name": "Exported Board",
            "description": "A test board",
            "columns": [
                {"name": "To Do", "position": 0, "color": "#3B82F6", "wip_limit": 5,
                 "weight_limit": None, "allow_card_creation": True},
            ],
            "swimlanes": [
                {"name": "General", "position": 0, "color": "#6B7280",
                 "contact_email": "", "notes": ""},
            ],
            "labels": [
                {"name": "Bug", "color": "#EF4444"},
            ],
            "cards": [],
        }

    def test_truncated_json_file_returns_400(self):
        """Malformed JSON (truncated mid-object) should return 400."""
        truncated = b'{"name": "Board", "columns": [{"name": "To Do"'
        f = io.BytesIO(truncated)
        f.name = "truncated.json"
        resp = self.client.post("/api/boards/import/", {"file": f}, format="multipart")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("Invalid JSON", resp.data["detail"])

    def test_csv_missing_title_column_returns_400(self):
        """CSV without the required Title header should return 400."""
        csv_content = (
            "Card ID,Description,Column,Swimlane,Priority,Assignee,Labels,"
            "Due Date,Weight,Created At,Created By,Last Moved At,Movement Count,"
            "Movement History\n"
            ",Some desc,To Do,General,medium,,,,,,,,,,\n"
        )
        f = io.BytesIO(csv_content.encode("utf-8"))
        f.name = "missing_title.csv"
        resp = self.client.post("/api/boards/import/", {"file": f}, format="multipart")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("missing required headers", resp.data["detail"])
        self.assertIn("Title", resp.data["detail"])

    def test_empty_json_file_returns_400(self):
        """An empty file with .json extension should return 400."""
        f = io.BytesIO(b"")
        f.name = "empty.json"
        resp = self.client.post("/api/boards/import/", {"file": f}, format="multipart")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_empty_csv_file_returns_400(self):
        """An empty file with .csv extension should return 400."""
        f = io.BytesIO(b"")
        f.name = "empty.csv"
        resp = self.client.post("/api/boards/import/", {"file": f}, format="multipart")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_non_group_member_cannot_import_into_group(self):
        """A user who is not a member of a group cannot import a board into it."""
        from groups.models import Group, GroupMembership

        group_owner = User.objects.create_user(username="gowner", password="pass")
        group = Group.objects.create(name="Private Group", owner=group_owner)
        GroupMembership.objects.create(
            group=group, user=group_owner, role=GroupMembership.Role.ADMIN
        )

        data = self._valid_json_data()
        resp = self.client.post(
            "/api/boards/import/",
            {"file": self._make_json_file(data), "group_id": group.pk},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(Board.objects.filter(name="Exported Board").count(), 0)


class BoardImportDuplicateLabelTests(TransactionTestCase):
    """TransactionTestCase needed because IntegrityError breaks TestCase savepoints."""

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="importer", password="pass")
        self.client.force_authenticate(self.user)

    def _make_json_file(self, data, filename="board.json"):
        content = json.dumps(data).encode("utf-8")
        f = io.BytesIO(content)
        f.name = filename
        return f

    def test_json_import_with_duplicate_label_names_rolls_back(self):
        """Duplicate label names trigger an IntegrityError inside transaction.atomic().

        The atomic block ensures the entire import is rolled back, so no board
        is created. The unhandled IntegrityError surfaces as a server error.
        """
        data = {
            "name": "Dup Labels Board",
            "description": "",
            "columns": [{"name": "To Do", "position": 0}],
            "swimlanes": [{"name": "General", "position": 0}],
            "labels": [
                {"name": "Bug", "color": "#EF4444"},
                {"name": "Bug", "color": "#FF0000"},
            ],
            "cards": [],
        }
        with self.assertRaises(Exception):
            self.client.post(
                "/api/boards/import/",
                {"file": self._make_json_file(data)},
                format="multipart",
            )
        # The atomic block ensures no board was created
        self.assertEqual(Board.objects.filter(name="Dup Labels Board").count(), 0)
