"""Checklist item assignee and due date (#445).

Covers the architect review's binding points: the assignee is limited to the
board's assignable members (IDOR, fail closed without a board in context),
the creator-only ownership gate is unchanged for assign/due edits (R2), two
History event types in the ``checklist`` group (R3b), the card-face fields
on CardSerializer and its card_query mirror but not the public share
serializer (R3a), MCP reusing the REST serializer (Rule 10), JSON
export/import carrying the assignee by username (Rule 5), and the
user-delete lock set.
"""
import datetime
import io
import json
from unittest.mock import patch

from django.test import TestCase
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from accounts.admin import VisibanUserAdmin
from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, CardActivity, CardChecklist, Column, Swimlane,
)
from boards.serializers import (
    CardChecklistSerializer, CardSerializer, PublicCardSerializer, _card_queryset,
)
from boards.views.card_query import CardQuerySerializer
from boards.views.cards import CardViewSet
from mcp_server.tools import _serialize_checklist_item

PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"


class _Base(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.member = User.objects.create_user(username="member", password="pass")
        self.viewer = User.objects.create_user(username="viewer", password="pass")
        self.outsider = User.objects.create_user(username="outsider", password="pass")
        self.board = Board.objects.create(name="B", owner=self.owner)
        BoardMembership.objects.create(board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN)
        BoardMembership.objects.create(board=self.board, user=self.member, role=BoardMembership.Role.MEMBER)
        BoardMembership.objects.create(board=self.board, user=self.viewer, role=BoardMembership.Role.VIEWER)
        # The outsider is a member of another board only.
        other = Board.objects.create(name="Other", owner=self.outsider)
        BoardMembership.objects.create(board=other, user=self.outsider, role=BoardMembership.Role.ADMIN)
        col = Column.objects.create(board=self.board, name="Todo", position=0, allow_card_creation=True)
        swim = Swimlane.objects.create(board=self.board, name="General", position=0)
        self.card = Card.objects.create(
            board=self.board, column=col, swimlane=swim, title="Card", created_by=self.owner, position=0,
        )
        self.item = CardChecklist.objects.create(card=self.card, text="Item", position=0, created_by=self.owner)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        self.list_url = f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/checklist/"
        self.item_url = f"{self.list_url}{self.item.id}/"


@patch(PATCH_BROADCAST)
class ChecklistAssigneeScopingTests(_Base):
    def test_assign_board_member_and_set_due_date(self, _):
        r = self.client.patch(self.item_url, {"assignee_id": self.member.id, "due_date": "2026-11-18"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assertEqual(r.json()["assignee"]["id"], self.member.id)
        self.assertEqual(r.json()["due_date"], "2026-11-18")
        self.assertNotIn("assignee_id", r.json())
        self.item.refresh_from_db()
        self.assertEqual(self.item.assignee, self.member)
        self.assertEqual(self.item.due_date, datetime.date(2026, 11, 18))

    def test_create_with_assignee_and_due(self, _):
        r = self.client.post(
            self.list_url, {"text": "New", "assignee_id": self.member.id, "due_date": "2026-12-01"}, format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.content)
        self.assertEqual(r.json()["assignee"]["id"], self.member.id)
        types = set(CardActivity.objects.filter(card=self.card).values_list("event_type", flat=True))
        self.assertIn(CardActivity.EventType.CHECKLIST_ITEM_ASSIGNED, types)
        self.assertIn(CardActivity.EventType.CHECKLIST_ITEM_DUE_CHANGED, types)

    def test_non_assignable_users_are_refused(self, _):
        inactive = User.objects.create_user(username="gone", password="pass", is_active=False)
        BoardMembership.objects.create(board=self.board, user=inactive, role=BoardMembership.Role.MEMBER)
        for user in (self.viewer, self.outsider, inactive):
            with self.subTest(user=user.username):
                r = self.client.patch(self.item_url, {"assignee_id": user.id}, format="json")
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
                r = self.client.post(self.list_url, {"text": "x", "assignee_id": user.id}, format="json")
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.item.refresh_from_db()
        self.assertIsNone(self.item.assignee)

    def test_missing_board_context_fails_closed(self, _):
        s = CardChecklistSerializer(self.item, data={"assignee_id": self.member.id}, partial=True)
        self.assertFalse(s.is_valid())
        self.assertIn("assignee_id", s.errors)

    def test_unassign_and_clear_due(self, _):
        self.item.assignee = self.member
        self.item.due_date = datetime.date(2026, 11, 18)
        self.item.save()
        r = self.client.patch(self.item_url, {"assignee_id": None, "due_date": None}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.item.refresh_from_db()
        self.assertIsNone(self.item.assignee)
        self.assertIsNone(self.item.due_date)

    def test_assignee_kept_when_member_leaves_board(self, _):
        # Same rule as Card.assignee: leaving the board does not clear it.
        self.item.assignee = self.member
        self.item.save()
        BoardMembership.objects.filter(board=self.board, user=self.member).delete()
        self.item.refresh_from_db()
        self.assertEqual(self.item.assignee, self.member)
        # Re-saving another field leaves it untouched; re-assigning them is refused.
        r = self.client.patch(self.item_url, {"text": "Renamed"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json()["assignee"]["id"], self.member.id)
        r = self.client.patch(self.item_url, {"assignee_id": self.member.id}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)


@patch(PATCH_BROADCAST)
class ChecklistAssignOwnershipGateTests(_Base):
    """R2: a member may not assign or date an item someone else created."""

    def test_member_cannot_assign_or_date_others_item(self, _):
        self.client.force_authenticate(self.member)
        for body in ({"assignee_id": self.member.id}, {"due_date": "2026-11-18"}):
            with self.subTest(body=body):
                r = self.client.patch(self.item_url, body, format="json")
                self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_member_can_assign_own_item(self, _):
        own = CardChecklist.objects.create(card=self.card, text="Mine", position=1, created_by=self.member)
        self.client.force_authenticate(self.member)
        r = self.client.patch(f"{self.list_url}{own.id}/", {"assignee_id": self.owner.id}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_viewer_cannot_assign(self, _):
        self.client.force_authenticate(self.viewer)
        r = self.client.patch(self.item_url, {"assignee_id": self.member.id}, format="json")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)


@patch(PATCH_BROADCAST)
class ChecklistAssignHistoryTests(_Base):
    """R3b: two History event types in the checklist group."""

    def _events(self, event_type):
        return list(
            CardActivity.objects.filter(card=self.card, event_type=event_type)
            .order_by("id").values_list("from_value", "to_value")
        )

    def test_assign_then_reassign_then_unassign(self, _):
        self.client.patch(self.item_url, {"assignee_id": self.member.id}, format="json")
        self.client.patch(self.item_url, {"assignee_id": self.owner.id}, format="json")
        self.client.patch(self.item_url, {"assignee_id": None}, format="json")
        self.assertEqual(
            self._events(CardActivity.EventType.CHECKLIST_ITEM_ASSIGNED),
            [("", "member"), ("member", "owner"), ("owner", "")],
        )

    def test_due_change_records_iso_dates(self, _):
        self.client.patch(self.item_url, {"due_date": "2026-11-18"}, format="json")
        self.client.patch(self.item_url, {"due_date": "2026-11-20"}, format="json")
        self.client.patch(self.item_url, {"due_date": None}, format="json")
        self.assertEqual(
            self._events(CardActivity.EventType.CHECKLIST_ITEM_DUE_CHANGED),
            [("", "2026-11-18"), ("2026-11-18", "2026-11-20"), ("2026-11-20", "")],
        )

    def test_unchanged_values_record_nothing(self, _):
        self.client.patch(self.item_url, {"assignee_id": None, "due_date": None, "text": "Same"}, format="json")
        self.assertFalse(CardActivity.objects.filter(
            card=self.card,
            event_type__in=[
                CardActivity.EventType.CHECKLIST_ITEM_ASSIGNED,
                CardActivity.EventType.CHECKLIST_ITEM_DUE_CHANGED,
            ],
        ).exists())

    def test_events_are_in_the_checklist_timeline_group(self, _):
        group = CardViewSet._TIMELINE_ACTIVITY_GROUPS["checklist"]
        self.assertIn("checklist_item_assigned", group)
        self.assertIn("checklist_item_due_changed", group)


class ChecklistFaceFieldsTests(_Base):
    """R3a: raw suffix data on CardSerializer and card_query, not on the share serializer."""

    def _card(self):
        return _card_queryset(Card.objects.filter(pk=self.card.pk)).get()

    def setUp(self):
        super().setUp()
        self.item.assignee = self.member
        self.item.due_date = datetime.date(2026, 11, 20)
        self.item.save()
        CardChecklist.objects.create(
            card=self.card, text="b", position=1, assignee=self.member, due_date=datetime.date(2026, 11, 1),
        )
        # Checked items are excluded from both lists.
        CardChecklist.objects.create(
            card=self.card, text="c", position=2, is_checked=True,
            assignee=self.owner, due_date=datetime.date(2026, 1, 1),
        )
        CardChecklist.objects.create(card=self.card, text="d", position=3)

    def test_card_serializer_fields(self):
        data = CardSerializer(self._card(), context={"board": self.board}).data
        self.assertEqual(data["checklist_open_due_dates"], ["2026-11-01", "2026-11-20"])
        self.assertEqual(data["checklist_open_assignee_ids"], [self.member.id, self.member.id])
        self.assertEqual((data["checklist_total"], data["checklist_done"]), (4, 1))

    def test_card_query_mirror_matches(self):
        card = self._card()
        rest = CardSerializer(card, context={"board": self.board}).data
        query = CardQuerySerializer(card).data
        for key in ("checklist_open_due_dates", "checklist_open_assignee_ids"):
            self.assertEqual(query[key], rest[key])

    def test_public_share_serializer_omits_them(self):
        fields = set(PublicCardSerializer().fields)
        self.assertNotIn("checklist_open_due_dates", fields)
        self.assertNotIn("checklist_open_assignee_ids", fields)

    def test_overdue_checklist_item_does_not_make_the_card_stale_or_due(self):
        # A-Q9: checklist due dates feed only the checklist suffix.
        data = CardSerializer(self._card(), context={"board": self.board}).data
        self.assertIsNone(data["due_date"])
        self.assertFalse(data["is_stale"])


class ChecklistMcpParityTests(_Base):
    """Rule 10: MCP serves the REST checklist shape."""

    def test_mcp_item_matches_rest(self):
        self.item.assignee = self.member
        self.item.due_date = datetime.date(2026, 11, 18)
        self.item.save()
        item = CardChecklist.objects.select_related("created_by", "assignee").get(pk=self.item.pk)
        mcp = _serialize_checklist_item(item)
        rest = dict(CardChecklistSerializer(item).data)
        self.assertEqual(mcp, rest)
        self.assertEqual(set(mcp), {"id", "text", "is_checked", "position", "created_by", "assignee", "due_date"})
        self.assertEqual(mcp["assignee"]["id"], self.member.id)


@patch(PATCH_BROADCAST)
class ChecklistExportImportTests(_Base):
    """Rule 5: the assignee travels as a username and resolves like card assignee."""

    def test_export_carries_assignee_username_and_due(self, _):
        self.item.assignee = self.member
        self.item.due_date = datetime.date(2026, 11, 18)
        self.item.save()
        r = self.client.get(f"/api/v1/boards/{self.board.id}/export/?format=json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        body = json.loads(b"".join(r.streaming_content) if r.streaming else r.content)
        item = body["cards"][0]["checklist"][0]
        self.assertEqual(item["assignee"], "member")
        self.assertEqual(item["due_date"], "2026-11-18")

    def _import(self, checklist):
        data = {
            "name": "Exported",
            "columns": [{"name": "Todo", "position": 0}],
            "swimlanes": [{"name": "General", "position": 0}],
            "labels": [],
            "cards": [{
                "title": "T", "column": "Todo", "swimlane": "General", "priority": "medium",
                "position": 0, "checklist": checklist,
            }],
        }
        f = io.BytesIO(json.dumps(data).encode())
        f.name = "board.json"
        return self.client.post("/api/v1/boards/import/", {"file": f}, format="multipart")

    def test_import_resolves_visible_username_case_insensitively(self, _):
        r = self._import([{"text": "a", "is_checked": False, "assignee": "MEMBER", "due_date": "2026-11-18"}])
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.content)
        item = CardChecklist.objects.get(card__board_id=r.data["id"])
        self.assertEqual(item.assignee, self.member)
        self.assertEqual(item.due_date, datetime.date(2026, 11, 18))

    def test_import_unknown_or_invisible_username_imports_unassigned(self, _):
        # The outsider shares no board or group with the importer.
        r = self._import([
            {"text": "a", "assignee": "outsider"},
            {"text": "b", "assignee": "nobody-here"},
        ])
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.content)
        self.assertFalse(
            CardChecklist.objects.filter(card__board_id=r.data["id"], assignee__isnull=False).exists()
        )

    def test_import_date_shift_moves_checklist_due_dates_and_activity_values(self, _):
        today = timezone.localdate()
        base = today - datetime.timedelta(days=10)
        data = {
            "name": "Shifted",
            "columns": [{"name": "Todo", "position": 0}],
            "swimlanes": [{"name": "General", "position": 0}],
            "labels": [],
            "cards": [{
                "title": "T", "column": "Todo", "swimlane": "General", "priority": "medium",
                "position": 0,
                "checklist": [{"text": "a", "due_date": base.isoformat()}],
                "activities": [{
                    "event_type": "checklist_item_due_changed",
                    "from_value": base.isoformat(),
                    "to_value": (base + datetime.timedelta(days=2)).isoformat(),
                }],
            }],
        }
        f = io.BytesIO(json.dumps(data).encode())
        f.name = "board.json"
        r = self.client.post(
            "/api/v1/boards/import/",
            {"file": f, "options": json.dumps({"shift_dates_from": base.isoformat()})},
            format="multipart",
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.content)
        item = CardChecklist.objects.get(card__board_id=r.data["id"])
        self.assertEqual(item.due_date, today)
        act = CardActivity.objects.get(
            card__board_id=r.data["id"], event_type="checklist_item_due_changed"
        )
        self.assertEqual(act.from_value, today.isoformat())
        self.assertEqual(act.to_value, (today + datetime.timedelta(days=2)).isoformat())

    def test_import_rejects_bad_types(self, _):
        for entry in ({"text": "a", "assignee": 5}, {"text": "a", "due_date": "not-a-date"}):
            with self.subTest(entry=entry):
                self.assertEqual(self._import([entry]).status_code, status.HTTP_400_BAD_REQUEST)


class ChecklistAssigneeUserDeleteTests(_Base):
    def test_assignee_reference_puts_card_in_lock_set(self):
        self.item.assignee = self.member
        self.item.save()
        locked = set(VisibanUserAdmin._cards_to_lock([self.member.pk]).values_list("pk", flat=True))
        self.assertIn(self.card.pk, locked)

    def test_user_delete_nulls_the_assignee(self):
        self.item.assignee = self.member
        self.item.save()
        self.member.delete()
        self.item.refresh_from_db()
        self.assertIsNone(self.item.assignee)
