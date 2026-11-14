"""Checklist assignee and due-date History rows name the item (#2199).

``CardActivity.item_text`` is a snapshot of the item's text on
``checklist_item_assigned`` and ``checklist_item_due_changed`` rows: set on
every write path that records them, exposed additively on the activities
endpoint, the timeline and MCP, carried by JSON export and import, and null on
other event types and on rows written before it existed.
"""
import io
import json
from unittest.mock import patch

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, CardActivity, CardChecklist, Column, Swimlane,
)
from mcp_server.tools import _serialize_activity

PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"
ET = CardActivity.EventType


@patch(PATCH_BROADCAST)
class ChecklistHistoryItemTextTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.member = User.objects.create_user(username="member", password="pass")
        self.board = Board.objects.create(name="B", owner=self.owner)
        BoardMembership.objects.create(board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN)
        BoardMembership.objects.create(board=self.board, user=self.member, role=BoardMembership.Role.MEMBER)
        col = Column.objects.create(board=self.board, name="Todo", position=0, allow_card_creation=True)
        swim = Swimlane.objects.create(board=self.board, name="General", position=0)
        self.card = Card.objects.create(
            board=self.board, column=col, swimlane=swim, title="Card", created_by=self.owner, position=0,
        )
        self.item = CardChecklist.objects.create(card=self.card, text="Write tests", position=0, created_by=self.owner)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        self.base = f"/api/v1/boards/{self.board.id}/cards/{self.card.id}"
        self.item_url = f"{self.base}/checklist/{self.item.id}/"

    def _rows(self, *types):
        return list(
            CardActivity.objects.filter(card=self.card, event_type__in=types)
            .order_by("id").values_list("event_type", "item_text")
        )

    def test_patch_assign_and_due_record_the_item_text(self, _):
        r = self.client.patch(self.item_url, {"assignee_id": self.member.id, "due_date": "2026-11-18"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assertEqual(
            self._rows(ET.CHECKLIST_ITEM_ASSIGNED, ET.CHECKLIST_ITEM_DUE_CHANGED),
            [(ET.CHECKLIST_ITEM_ASSIGNED, "Write tests"), (ET.CHECKLIST_ITEM_DUE_CHANGED, "Write tests")],
        )

    def test_rename_in_the_same_patch_records_the_new_text(self, _):
        # The row is written after the save, so it names the item as it now reads.
        self.client.patch(self.item_url, {"text": "Write more tests", "assignee_id": self.member.id}, format="json")
        self.assertEqual(self._rows(ET.CHECKLIST_ITEM_ASSIGNED), [(ET.CHECKLIST_ITEM_ASSIGNED, "Write more tests")])

    def test_snapshot_survives_a_later_rename_and_delete(self, _):
        self.client.patch(self.item_url, {"assignee_id": self.member.id}, format="json")
        self.client.patch(self.item_url, {"text": "Renamed"}, format="json")
        self.client.delete(self.item_url)
        self.assertEqual(self._rows(ET.CHECKLIST_ITEM_ASSIGNED), [(ET.CHECKLIST_ITEM_ASSIGNED, "Write tests")])

    def test_create_with_assignee_records_the_item_text(self, _):
        r = self.client.post(
            f"{self.base}/checklist/", {"text": "New one", "assignee_id": self.member.id, "due_date": "2026-12-01"},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.content)
        self.assertEqual(
            self._rows(ET.CHECKLIST_ITEM_ASSIGNED, ET.CHECKLIST_ITEM_DUE_CHANGED),
            [(ET.CHECKLIST_ITEM_ASSIGNED, "New one"), (ET.CHECKLIST_ITEM_DUE_CHANGED, "New one")],
        )

    def test_other_checklist_events_leave_item_text_null(self, _):
        self.client.patch(self.item_url, {"is_checked": True}, format="json")
        self.assertEqual(self._rows(ET.CHECKLIST_ITEM_CHECKED), [(ET.CHECKLIST_ITEM_CHECKED, None)])

    def test_activities_endpoint_and_mcp_expose_item_text(self, _):
        self.client.patch(self.item_url, {"assignee_id": self.member.id}, format="json")
        CardActivity.objects.create(card=self.card, event_type=ET.PRIORITY_CHANGE, from_value="low", to_value="high")
        r = self.client.get(f"{self.base}/activities/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        by_type = {a["event_type"]: a for a in r.json()}
        self.assertEqual(by_type["checklist_item_assigned"]["item_text"], "Write tests")
        self.assertIsNone(by_type["priority_change"]["item_text"])
        act = CardActivity.objects.get(card=self.card, event_type=ET.CHECKLIST_ITEM_ASSIGNED)
        self.assertEqual(_serialize_activity(act)["item_text"], "Write tests")

    def test_timeline_data_carries_item_text_only_on_assign_and_due_rows(self, _):
        self.client.patch(self.item_url, {"assignee_id": self.member.id}, format="json")
        # A row written before #2199 has no item text.
        CardActivity.objects.create(card=self.card, event_type=ET.CHECKLIST_ITEM_DUE_CHANGED, to_value="2026-11-18")
        CardActivity.objects.create(card=self.card, event_type=ET.PRIORITY_CHANGE, from_value="low", to_value="high")
        r = self.client.get(f"{self.base}/timeline/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        data = {e["event_type"]: e["data"] for e in r.json()["results"]}
        self.assertEqual(data["checklist_item_assigned"]["item_text"], "Write tests")
        self.assertIn("item_text", data["checklist_item_due_changed"])
        self.assertIsNone(data["checklist_item_due_changed"]["item_text"])
        self.assertNotIn("item_text", data["priority_change"])

    def test_json_export_and_import_round_trip_item_text(self, _):
        self.client.patch(self.item_url, {"assignee_id": self.member.id}, format="json")
        r = self.client.get(f"/api/v1/boards/{self.board.id}/export/?format=json")
        body = json.loads(b"".join(r.streaming_content) if r.streaming else r.content)
        acts = body["cards"][0]["activities"]
        assigned = next(a for a in acts if a["event_type"] == "checklist_item_assigned")
        self.assertEqual(assigned["item_text"], "Write tests")
        f = io.BytesIO(json.dumps(body).encode())
        f.name = "board.json"
        r = self.client.post("/api/v1/boards/import/", {"file": f}, format="multipart")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.content)
        imported = CardActivity.objects.get(card__board_id=r.data["id"], event_type=ET.CHECKLIST_ITEM_ASSIGNED)
        self.assertEqual(imported.item_text, "Write tests")

    def _import_activity(self, activity):
        data = {
            "name": "Imported",
            "columns": [{"name": "Todo", "position": 0}],
            "swimlanes": [{"name": "General", "position": 0}],
            "labels": [],
            "cards": [{
                "title": "T", "column": "Todo", "swimlane": "General", "priority": "medium",
                "position": 0, "activities": [activity],
            }],
        }
        f = io.BytesIO(json.dumps(data).encode())
        f.name = "board.json"
        return self.client.post("/api/v1/boards/import/", {"file": f}, format="multipart")

    def test_import_without_item_text_stores_null(self, _):
        r = self._import_activity({"event_type": "checklist_item_assigned", "from_value": "", "to_value": "x"})
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.content)
        act = CardActivity.objects.get(card__board_id=r.data["id"])
        self.assertIsNone(act.item_text)

    def test_import_rejects_a_bad_item_text(self, _):
        base = {"event_type": "checklist_item_assigned", "from_value": "", "to_value": "x"}
        for bad in (5, ["a"], "x" * 501, "nul\x00"):
            with self.subTest(bad=bad):
                r = self._import_activity({**base, "item_text": bad})
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
                self.assertIn("item_text", r.json()["detail"])
