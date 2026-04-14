import io
import json

from django.test import TestCase, TransactionTestCase
from django.test.utils import override_settings
from rest_framework.test import APIClient
from rest_framework import status

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Column, Swimlane, Label, Card,
    CardComment, CardChecklist, CardMovement, CardActivity,
)
from django.utils import timezone


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
            "/api/v1/boards/import/",
            {"file": self._make_json_file(data)},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.data["name"], "Exported Board")

    def test_json_import_creates_correct_structure(self):
        data = self._valid_json_data()
        resp = self.client.post(
            "/api/v1/boards/import/",
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

    def test_json_import_weight_activity_created_for_non_default(self):
        """Importing a card with weight > 1 should create a WEIGHT_CHANGE activity."""
        data = self._valid_json_data()
        data["cards"][0]["weight"] = 3
        resp = self.client.post(
            "/api/v1/boards/import/",
            {"file": self._make_json_file(data)},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        board_id = resp.data["id"]
        card = Card.objects.get(board_id=board_id)
        activity = CardActivity.objects.filter(
            card=card, event_type=CardActivity.EventType.WEIGHT_CHANGE
        ).first()
        self.assertIsNotNone(activity)
        self.assertEqual(activity.from_value, "1")
        self.assertEqual(activity.to_value, "3")
        self.assertEqual(activity.actor, self.user)

    def test_json_import_no_weight_activity_for_default(self):
        """Importing a card with weight=1 (default) should NOT create a WEIGHT_CHANGE activity."""
        data = self._valid_json_data()
        data["cards"][0]["weight"] = 1
        resp = self.client.post(
            "/api/v1/boards/import/",
            {"file": self._make_json_file(data)},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        board_id = resp.data["id"]
        card = Card.objects.get(board_id=board_id)
        self.assertFalse(
            CardActivity.objects.filter(
                card=card, event_type=CardActivity.EventType.WEIGHT_CHANGE
            ).exists()
        )

    def test_json_import_label_activity_created(self):
        """Importing a card with labels should create a LABEL_CHANGE activity."""
        data = self._valid_json_data()
        resp = self.client.post(
            "/api/v1/boards/import/",
            {"file": self._make_json_file(data)},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        board_id = resp.data["id"]
        card = Card.objects.get(board_id=board_id)
        activity = CardActivity.objects.filter(
            card=card, event_type=CardActivity.EventType.LABEL_CHANGE
        ).first()
        self.assertIsNotNone(activity)
        self.assertEqual(activity.from_value, "")
        self.assertIn("+", activity.to_value)
        self.assertIn("Bug", activity.to_value)

    def test_json_import_checklist_activity_created(self):
        """Importing checklist items should create a CHECKLIST_ITEM_ADDED activity per item."""
        data = self._valid_json_data()
        resp = self.client.post(
            "/api/v1/boards/import/",
            {"file": self._make_json_file(data)},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        board_id = resp.data["id"]
        card = Card.objects.get(board_id=board_id)
        activities = list(
            CardActivity.objects.filter(
                card=card, event_type=CardActivity.EventType.CHECKLIST_ITEM_ADDED
            ).values_list("to_value", flat=True)
        )
        # _valid_json_data has 2 checklist items: "Reproduce issue" and "Write fix"
        self.assertEqual(len(activities), 2)
        self.assertIn("Reproduce issue", activities)
        self.assertIn("Write fix", activities)

    def test_json_import_archived_at_preserved(self):
        """An archived card in the export must be restored as archived, not re-activated."""
        data = self._valid_json_data()
        data["cards"][0]["archived_at"] = "2026-01-15T10:00:00Z"
        resp = self.client.post(
            "/api/v1/boards/import/",
            {"file": self._make_json_file(data)},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        board_id = resp.data["id"]
        card = Card.objects.get(board_id=board_id)
        self.assertIsNotNone(card.archived_at)

    def test_json_import_active_card_not_archived(self):
        """A card with no archived_at must remain active after import."""
        data = self._valid_json_data()
        data["cards"][0]["archived_at"] = None
        resp = self.client.post(
            "/api/v1/boards/import/",
            {"file": self._make_json_file(data)},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        board_id = resp.data["id"]
        card = Card.objects.get(board_id=board_id)
        self.assertIsNone(card.archived_at)

    def test_json_import_movement_type_and_notes_preserved(self):
        """movement_type and notes must be restored on import, not defaulted to 'move'/''."""
        data = self._valid_json_data()
        data["cards"][0]["movements"] = [
            {
                "from_column": "To Do",
                "to_column": "Done",
                "from_swimlane": "General",
                "to_swimlane": "General",
                "moved_by": None,
                "moved_at": "2026-01-10T12:00:00Z",
                "notes": "Blocked by external dep",
                "movement_type": "archived",
            }
        ]
        resp = self.client.post(
            "/api/v1/boards/import/",
            {"file": self._make_json_file(data)},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        board_id = resp.data["id"]
        card = Card.objects.get(board_id=board_id)
        mv = CardMovement.objects.get(card=card)
        self.assertEqual(mv.movement_type, "archived")
        self.assertEqual(mv.notes, "Blocked by external dep")

    def test_json_import_comment_created_at_backfilled(self):
        """Comment timestamps from the export must be restored so the timeline is accurate."""
        data = self._valid_json_data()
        data["cards"][0]["comments"] = [
            {"author": "someone", "body": "Original comment", "created_at": "2026-01-05T08:30:00Z"}
        ]
        resp = self.client.post(
            "/api/v1/boards/import/",
            {"file": self._make_json_file(data)},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        board_id = resp.data["id"]
        card = Card.objects.get(board_id=board_id)
        comment = CardComment.objects.get(card=card)
        self.assertEqual(comment.created_at.isoformat(), "2026-01-05T08:30:00+00:00")

    def test_json_export_includes_archived_at_and_schema_version(self):
        """JSON export must include archived_at on each card and schema_version: 2."""
        board = Board.objects.create(name="Export Test", owner=self.user)
        BoardMembership.objects.create(board=board, user=self.user, role=BoardMembership.Role.ADMIN)
        col = Column.objects.create(board=board, name="Done", position=0)
        sw = Swimlane.objects.create(board=board, name="General", position=0)
        archived_time = timezone.now()
        Card.objects.create(
            board=board, column=col, swimlane=sw,
            title="Archived card", archived_at=archived_time,
        )
        Card.objects.create(
            board=board, column=col, swimlane=sw,
            title="Active card",
        )
        resp = self.client.get(f"/api/v1/boards/{board.id}/export/?format=json")
        self.assertEqual(resp.status_code, 200)
        payload = json.loads(resp.content)
        self.assertEqual(payload["schema_version"], 2)
        cards_by_title = {c["title"]: c for c in payload["cards"]}
        self.assertIsNotNone(cards_by_title["Archived card"]["archived_at"])
        self.assertIsNone(cards_by_title["Active card"]["archived_at"])

    def test_json_import_name_override(self):
        data = self._valid_json_data()
        resp = self.client.post(
            "/api/v1/boards/import/",
            {"file": self._make_json_file(data), "name": "My Custom Name"},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.data["name"], "My Custom Name")

    def test_json_import_correct_owner(self):
        data = self._valid_json_data()
        resp = self.client.post(
            "/api/v1/boards/import/",
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
        resp = self.client.post("/api/v1/boards/import/", {"file": f}, format="multipart")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("not valid JSON", resp.data["detail"])

    def test_missing_required_fields_returns_400(self):
        # Missing columns
        data = {"name": "Test", "swimlanes": [{"name": "General"}]}
        resp = self.client.post(
            "/api/v1/boards/import/",
            {"file": self._make_json_file(data)},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("columns", resp.data["detail"])

    def test_missing_card_required_fields_returns_400(self):
        data = self._valid_json_data()
        data["cards"] = [{"description": "No title"}]
        resp = self.client.post(
            "/api/v1/boards/import/",
            {"file": self._make_json_file(data)},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("title", resp.data["detail"])

    def test_unauthenticated_cannot_import(self):
        anon = APIClient()
        data = self._valid_json_data()
        resp = anon.post(
            "/api/v1/boards/import/",
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
            "/api/v1/boards/import/",
            {"file": self._make_csv_file(self._valid_csv_content()), "name": "CSV Board"},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.data["name"], "CSV Board")

    def test_csv_import_creates_correct_structure(self):
        resp = self.client.post(
            "/api/v1/boards/import/",
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

    def test_csv_import_weight_activity_created_for_non_default(self):
        """CSV import of a card with weight > 1 should create a WEIGHT_CHANGE activity."""
        csv_content = (
            "Card ID,Title,Description,Column,Swimlane,Priority,Assignee,Labels,Due Date,Weight,Created At,Created By,Last Moved At,Movement Count,Movement History\n"
            "1,Weighted card,,To Do,General,medium,,,,2,2026-01-01,importer,,,\n"
        )
        resp = self.client.post(
            "/api/v1/boards/import/",
            {"file": self._make_csv_file(csv_content), "name": "CSV Weight Board"},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        board_id = resp.data["id"]
        card = Card.objects.get(board_id=board_id, title="Weighted card")
        activity = CardActivity.objects.filter(
            card=card, event_type=CardActivity.EventType.WEIGHT_CHANGE
        ).first()
        self.assertIsNotNone(activity)
        self.assertEqual(activity.from_value, "1")
        self.assertEqual(activity.to_value, "2")
        self.assertEqual(activity.actor, self.user)

    def test_csv_import_label_activity_created(self):
        """CSV import of a card with labels should create a LABEL_CHANGE activity."""
        csv_content = (
            "Title,Column,Swimlane,Labels\n"
            "Fix login,To Do,General,\"Bug, Feature\"\n"
        )
        resp = self.client.post(
            "/api/v1/boards/import/",
            {"file": self._make_csv_file(csv_content), "name": "CSV Label Board"},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        board_id = resp.data["id"]
        card = Card.objects.get(board_id=board_id, title="Fix login")
        activity = CardActivity.objects.filter(
            card=card, event_type=CardActivity.EventType.LABEL_CHANGE
        ).first()
        self.assertIsNotNone(activity)
        self.assertEqual(activity.from_value, "")
        self.assertIn("+", activity.to_value)

    def test_csv_import_no_weight_activity_for_default(self):
        """CSV import of a card with weight=1 should NOT create a WEIGHT_CHANGE activity."""
        csv_content = (
            "Card ID,Title,Description,Column,Swimlane,Priority,Assignee,Labels,Due Date,Weight,Created At,Created By,Last Moved At,Movement Count,Movement History\n"
            "1,Default weight card,,To Do,General,medium,,,,1,2026-01-01,importer,,,\n"
        )
        resp = self.client.post(
            "/api/v1/boards/import/",
            {"file": self._make_csv_file(csv_content), "name": "CSV Default Board"},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        board_id = resp.data["id"]
        card = Card.objects.get(board_id=board_id, title="Default weight card")
        self.assertFalse(
            CardActivity.objects.filter(
                card=card, event_type=CardActivity.EventType.WEIGHT_CHANGE
            ).exists()
        )

    def test_invalid_csv_returns_400(self):
        # Missing required headers
        csv_content = "Name,Description\nFoo,Bar\n"
        resp = self.client.post(
            "/api/v1/boards/import/",
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
            "/api/v1/boards/import/",
            {"file": self._make_csv_file(csv_content)},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("Title", resp.data["detail"])

    def test_csv_import_correct_owner(self):
        resp = self.client.post(
            "/api/v1/boards/import/",
            {"file": self._make_csv_file(self._valid_csv_content()), "name": "CSV Board"},
            format="multipart",
        )
        board = Board.objects.get(pk=resp.data["id"])
        self.assertEqual(board.owner, self.user)

    def test_no_file_returns_400(self):
        resp = self.client.post("/api/v1/boards/import/", {}, format="multipart")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("No file", resp.data["detail"])

    def test_unsupported_format_returns_400(self):
        f = io.BytesIO(b"some data")
        f.name = "board.xml"
        resp = self.client.post("/api/v1/boards/import/", {"file": f}, format="multipart")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("Unsupported", resp.data["detail"])


class BoardImportEdgeCaseTests(TestCase):
    """Edge case tests for board import: malformed files, duplicates, permissions."""

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="importer", password="pass")
        self.client.force_authenticate(self.user)

    def _make_csv_file(self, content, filename="board.csv"):
        f = io.BytesIO(content.encode("utf-8"))
        f.name = filename
        return f

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
        resp = self.client.post("/api/v1/boards/import/", {"file": f}, format="multipart")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("not valid JSON", resp.data["detail"])

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
        resp = self.client.post("/api/v1/boards/import/", {"file": f}, format="multipart")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("missing required headers", resp.data["detail"])
        self.assertIn("Title", resp.data["detail"])

    def test_empty_json_file_returns_400(self):
        """An empty file with .json extension should return 400."""
        f = io.BytesIO(b"")
        f.name = "empty.json"
        resp = self.client.post("/api/v1/boards/import/", {"file": f}, format="multipart")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_empty_csv_file_returns_400(self):
        """An empty file with .csv extension should return 400."""
        f = io.BytesIO(b"")
        f.name = "empty.csv"
        resp = self.client.post("/api/v1/boards/import/", {"file": f}, format="multipart")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_csv_import_accepts_lowercase_headers(self):
        """Lowercase headers (e.g. from external tools or the seed CSV) should import successfully."""
        csv_content = (
            "title,column,swimlane,priority,description\n"
            "Fix login,To Do,General,high,Login is broken\n"
        )
        resp = self.client.post(
            "/api/v1/boards/import/",
            {"file": self._make_csv_file(csv_content), "name": "Lowercase CSV"},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        board_id = resp.data["id"]
        self.assertTrue(Card.objects.filter(board_id=board_id, title="Fix login").exists())

    def test_csv_import_accepts_due_date_snake_case(self):
        """due_date header (snake_case variant) should be treated as DueDate."""
        csv_content = (
            "title,column,swimlane,due_date\n"
            "Fix login,To Do,General,2026-06-01\n"
        )
        resp = self.client.post(
            "/api/v1/boards/import/",
            {"file": self._make_csv_file(csv_content), "name": "Snake Date CSV"},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        board_id = resp.data["id"]
        card = Card.objects.get(board_id=board_id, title="Fix login")
        self.assertIsNotNone(card.due_date)

    def test_csv_import_accepts_seed_csv_format(self):
        """The seed demo_board.csv uses lowercase snake_case headers — must import without error."""
        import os
        seed_path = os.path.join(
            os.path.dirname(__file__), "..", "..", "scripts", "seed", "demo_board.csv"
        )
        if not os.path.exists(seed_path):
            self.skipTest("demo_board.csv not present in this environment")
        with open(seed_path, "rb") as f:
            resp = self.client.post(
                "/api/v1/boards/import/",
                {"file": f, "name": "Seed Import"},
                format="multipart",
            )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

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
            "/api/v1/boards/import/",
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
                "/api/v1/boards/import/",
                {"file": self._make_json_file(data)},
                format="multipart",
            )
        # The atomic block ensures no board was created
        self.assertEqual(Board.objects.filter(name="Dup Labels Board").count(), 0)


class BoardImportCSVRoundtripTests(TestCase):
    """CSV export → import roundtrip: verify that due_date and other fields survive the cycle."""

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="roundtrip_user", password="pass")
        self.client.force_authenticate(self.user)

        # Create a board with a card that has a due_date set.
        import datetime
        from boards.models import Card as CardModel, Column as ColumnModel, Swimlane as SwimlaneModel

        self.board = Board.objects.create(name="Source", owner=self.user)
        BoardMembership.objects.create(board=self.board, user=self.user, role=BoardMembership.Role.ADMIN)
        col = ColumnModel.objects.create(board=self.board, name="Backlog", position=0, allow_card_creation=True)
        swim = SwimlaneModel.objects.create(board=self.board, name="General", position=0)
        self.due_date = datetime.date(2026, 6, 15)
        CardModel.objects.create(
            board=self.board, column=col, swimlane=swim,
            title="Round-trip card", due_date=self.due_date, created_by=self.user, position=0,
        )

    def test_csv_roundtrip_preserves_due_date(self):
        """Export a board with a due_date card, re-import the CSV, and verify due_date survives."""
        from boards.models import Card as CardModel

        # Export the board as CSV (no ?format= param to avoid DRF content-negotiation
        # interpreting "csv" as a format suffix and routing to a missing renderer).
        export_resp = self.client.get(f"/api/v1/boards/{self.board.id}/export/")
        self.assertEqual(export_resp.status_code, 200)

        # Re-import the CSV.
        csv_bytes = export_resp.content
        f = io.BytesIO(csv_bytes)
        f.name = "roundtrip.csv"
        import_resp = self.client.post(
            "/api/v1/boards/import/",
            {"file": f, "name": "Round-trip Import"},
            format="multipart",
        )
        self.assertEqual(import_resp.status_code, 201)

        # The imported card must have a populated due_date matching the original.
        imported_board_id = import_resp.data["id"]
        imported_card = CardModel.objects.get(board_id=imported_board_id, title="Round-trip card")
        self.assertIsNotNone(imported_card.due_date)
        self.assertEqual(str(imported_card.due_date), "2026-06-15")


class BoardImportBulkUserLookupTests(TestCase):
    """Verify that JSON import resolves users via a single bulk query
    instead of per-card lookups (#420)."""

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="importer", password="pass")
        self.alice = User.objects.create_user(username="alice", password="pass")
        self.bob = User.objects.create_user(username="bob", password="pass")
        self.client.force_authenticate(self.user)

    def _make_json_file(self, data, filename="board.json"):
        content = json.dumps(data).encode("utf-8")
        f = io.BytesIO(content)
        f.name = filename
        return f

    def _data_with_users(self, card_count=5):
        """Build import data with multiple cards referencing different users."""
        cards = []
        for i in range(card_count):
            cards.append({
                "title": f"Card {i}",
                "column": "To Do",
                "swimlane": "General",
                "priority": "medium",
                "assignee": "alice" if i % 2 == 0 else "bob",
                "labels": [],
                "position": i,
                "movements": [
                    {
                        "from_column": "To Do",
                        "to_column": "To Do",
                        "moved_by": "bob",
                    },
                ],
                "activities": [
                    {
                        "event_type": "priority_change",
                        "from_value": "low",
                        "to_value": "medium",
                        "actor": "alice",
                    },
                ],
            })
        return {
            "name": "Bulk User Board",
            "columns": [{"name": "To Do", "position": 0}],
            "swimlanes": [{"name": "General", "position": 0}],
            "labels": [],
            "cards": cards,
        }

    def test_import_resolves_assignee_from_bulk_lookup(self):
        """Assignee should be resolved correctly via the bulk user map."""
        data = self._data_with_users(card_count=2)
        resp = self.client.post(
            "/api/v1/boards/import/",
            {"file": self._make_json_file(data)},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        board_id = resp.data["id"]
        card0 = Card.objects.get(board_id=board_id, title="Card 0")
        card1 = Card.objects.get(board_id=board_id, title="Card 1")
        self.assertEqual(card0.assignee, self.alice)
        self.assertEqual(card1.assignee, self.bob)

    def test_import_resolves_moved_by_from_bulk_lookup(self):
        """moved_by on CardMovement should be resolved via the bulk user map."""
        data = self._data_with_users(card_count=1)
        resp = self.client.post(
            "/api/v1/boards/import/",
            {"file": self._make_json_file(data)},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        board_id = resp.data["id"]
        card = Card.objects.get(board_id=board_id, title="Card 0")
        mv = CardMovement.objects.filter(card=card).first()
        self.assertIsNotNone(mv)
        self.assertEqual(mv.moved_by, self.bob)

    def test_import_resolves_actor_from_bulk_lookup(self):
        """actor on CardActivity should be resolved via the bulk user map."""
        data = self._data_with_users(card_count=1)
        resp = self.client.post(
            "/api/v1/boards/import/",
            {"file": self._make_json_file(data)},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        board_id = resp.data["id"]
        card = Card.objects.get(board_id=board_id, title="Card 0")
        act = CardActivity.objects.filter(card=card).first()
        self.assertIsNotNone(act)
        self.assertEqual(act.actor, self.alice)

    def test_unknown_username_falls_back_gracefully(self):
        """Unknown assignee should resolve to None; unknown moved_by/actor
        should fall back to the importing user."""
        data = self._data_with_users(card_count=1)
        data["cards"][0]["assignee"] = "nonexistent_user"
        data["cards"][0]["movements"][0]["moved_by"] = "ghost"
        data["cards"][0]["activities"][0]["actor"] = "ghost"
        resp = self.client.post(
            "/api/v1/boards/import/",
            {"file": self._make_json_file(data)},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        board_id = resp.data["id"]
        card = Card.objects.get(board_id=board_id, title="Card 0")
        self.assertIsNone(card.assignee)
        mv = CardMovement.objects.filter(card=card).first()
        self.assertEqual(mv.moved_by, self.user)
        act = CardActivity.objects.filter(card=card).first()
        self.assertEqual(act.actor, self.user)

    @override_settings(DEBUG=True)
    def test_no_per_card_user_queries(self):
        """With 5 cards referencing 2 users, there should be exactly one
        User query for all usernames — not one per card/movement/activity.

        We count queries that hit the accounts_user table. Before the fix
        there would be 5 (assignee) + 5 (moved_by) + 5 (actor) = 15
        such queries. After the fix there should be exactly 1."""
        from django.db import connection, reset_queries

        data = self._data_with_users(card_count=5)
        reset_queries()
        resp = self.client.post(
            "/api/v1/boards/import/",
            {"file": self._make_json_file(data)},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

        # Count per-card user lookups (individual username = 'xxx' queries).
        # The fix replaces them with a single bulk IN query, so there should
        # be zero individual lookups.
        per_card_user_queries = [
            q for q in connection.queries
            if "accounts_user" in q["sql"]
            and "username" in q["sql"]
            and "IN" not in q["sql"].upper()
        ]
        self.assertEqual(len(per_card_user_queries), 0,
            f"Expected 0 per-card user queries, got {len(per_card_user_queries)}: "
            f"{[q['sql'][:120] for q in per_card_user_queries]}"
        )


class BoardImportBulkCreateEdgeCaseTests(TestCase):
    """Cover the bulk_create Phase 1/2/3 edge-case branches in _import_json().

    These branches are not exercised by the main happy-path tests:
      - invalid priority falls back to "medium"
      - card with unknown column/swimlane is silently skipped
      - movement with unrecognised movement_type falls back to MOVE
      - movement referencing a column/swimlane not in the board preserves the
        raw name string and sets UID to "" rather than raising
    """

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="edge_importer", password="pass")
        self.client.force_authenticate(self.user)

    def _make_json_file(self, data, filename="board.json"):
        content = json.dumps(data).encode("utf-8")
        f = io.BytesIO(content)
        f.name = filename
        return f

    def _base_payload(self):
        return {
            "name": "Edge Case Board",
            "columns": [{"name": "Backlog", "position": 0, "color": "#000", "wip_limit": None, "weight_limit": None, "allow_card_creation": True}],
            "swimlanes": [{"name": "Lane", "position": 0, "color": "#000", "contact_email": "", "notes": ""}],
            "labels": [],
            "cards": [],
        }

    def _post(self, data):
        return self.client.post(
            "/api/v1/boards/import/",
            {"file": self._make_json_file(data)},
            format="multipart",
        )

    def test_invalid_priority_falls_back_to_medium(self):
        """A card with an unrecognised priority value is imported as 'medium'."""
        data = self._base_payload()
        data["cards"] = [{
            "title": "Bad Priority Card",
            "column": "Backlog",
            "swimlane": "Lane",
            "priority": "critical",  # not a valid Priority value
            "weight": 1,
            "position": 0,
        }]
        resp = self._post(data)
        self.assertEqual(resp.status_code, 201)
        board_id = resp.data["id"]
        card = Card.objects.get(board_id=board_id, title="Bad Priority Card")
        self.assertEqual(card.priority, "medium")

    def test_card_with_unknown_column_is_skipped(self):
        """A card referencing a column name that doesn't exist is silently skipped."""
        data = self._base_payload()
        data["cards"] = [
            {"title": "Good Card", "column": "Backlog", "swimlane": "Lane", "priority": "low", "weight": 1, "position": 0},
            {"title": "Bad Card", "column": "NonExistentColumn", "swimlane": "Lane", "priority": "low", "weight": 1, "position": 1},
        ]
        resp = self._post(data)
        self.assertEqual(resp.status_code, 201)
        board_id = resp.data["id"]
        self.assertTrue(Card.objects.filter(board_id=board_id, title="Good Card").exists())
        self.assertFalse(Card.objects.filter(board_id=board_id, title="Bad Card").exists())

    def test_card_with_unknown_swimlane_is_skipped(self):
        """A card referencing a swimlane name that doesn't exist is silently skipped."""
        data = self._base_payload()
        data["cards"] = [
            {"title": "Valid Card", "column": "Backlog", "swimlane": "Lane", "priority": "low", "weight": 1, "position": 0},
            {"title": "Orphan Card", "column": "Backlog", "swimlane": "GhostLane", "priority": "low", "weight": 1, "position": 1},
        ]
        resp = self._post(data)
        self.assertEqual(resp.status_code, 201)
        board_id = resp.data["id"]
        self.assertTrue(Card.objects.filter(board_id=board_id, title="Valid Card").exists())
        self.assertFalse(Card.objects.filter(board_id=board_id, title="Orphan Card").exists())

    def test_movement_with_invalid_type_falls_back_to_move(self):
        """A movement with an unrecognised movement_type is imported as 'move'."""
        data = self._base_payload()
        data["cards"] = [{
            "title": "Moved Card",
            "column": "Backlog",
            "swimlane": "Lane",
            "priority": "low",
            "weight": 1,
            "position": 0,
            "movements": [{
                "from_column": "Backlog",
                "to_column": "Backlog",
                "from_swimlane": "Lane",
                "to_swimlane": "Lane",
                "moved_by": None,
                "notes": "",
                "moved_at": "2026-01-01T00:00:00Z",
                "movement_type": "teleported",  # not a valid MovementType
            }],
        }]
        resp = self._post(data)
        self.assertEqual(resp.status_code, 201)
        board_id = resp.data["id"]
        card = Card.objects.get(board_id=board_id, title="Moved Card")
        mv = CardMovement.objects.filter(card=card).first()
        self.assertIsNotNone(mv)
        self.assertEqual(mv.movement_type, "move")

    def test_movement_with_unresolved_column_preserves_name_and_empty_uid(self):
        """When a movement references a column not in the board, the name string
        is preserved verbatim and the UID is stored as an empty string."""
        data = self._base_payload()
        data["cards"] = [{
            "title": "History Card",
            "column": "Backlog",
            "swimlane": "Lane",
            "priority": "low",
            "weight": 1,
            "position": 0,
            "movements": [{
                "from_column": "Old Column That No Longer Exists",
                "to_column": "Backlog",
                "from_swimlane": "Old Lane",
                "to_swimlane": "Lane",
                "moved_by": None,
                "notes": "",
                "moved_at": None,
                "movement_type": "move",
            }],
        }]
        resp = self._post(data)
        self.assertEqual(resp.status_code, 201)
        board_id = resp.data["id"]
        card = Card.objects.get(board_id=board_id, title="History Card")
        mv = CardMovement.objects.filter(card=card).first()
        self.assertIsNotNone(mv)
        # Name is preserved; UID is "" because the column wasn't in the board
        self.assertEqual(mv.from_column_name, "Old Column That No Longer Exists")
        self.assertEqual(mv.from_column_uid, "")
        self.assertEqual(mv.from_swimlane_name, "Old Lane")
        self.assertEqual(mv.from_swimlane_uid, "")
