"""History names the assigner on an assignee override (#2594).

``CardActivity.assigned_by`` is set on the ``override_used`` row only when the
override's basis is ``assignee``, from the same snapshot as the ``CardOverride``
rows. It is exposed additively, in the slim ``BoardUserSerializer`` shape the
row's ``actor`` uses, on the activities endpoint, the timeline (``data`` of
``override_used`` entries only) and MCP; carried by JSON export as a username;
never set from an import file; and cleared when the assigner's account is
deleted. Every absent input (admin basis, legacy row, deleted account,
imported row) yields no assigner, never a guessed one (#1075).
"""
import io
import json
from unittest.mock import patch

from django.test import TestCase
from rest_framework.test import APIClient

from accounts.admin import VisibanUserAdmin
from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, CardActivity, CardOverride, Column, Swimlane,
)
from mcp_server.tools import _serialize_activity

PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"
R = BoardMembership.Role
ET = CardActivity.EventType


@patch(PATCH_BROADCAST)
class OverrideAssignedByTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(
            username="ab_admin", password="pass", display_name="Avery Admin",
        )
        self.member = User.objects.create_user(username="ab_member", password="pass")
        self.board = Board.objects.create(name="AB", owner=self.admin, allow_assignee_override=True)
        BoardMembership.objects.create(board=self.board, user=self.admin, role=R.ADMIN)
        BoardMembership.objects.create(board=self.board, user=self.member, role=R.MEMBER)
        self.src = Column.objects.create(board=self.board, name="Src", position=0, allow_card_creation=True)
        self.dst = Column.objects.create(
            board=self.board, name="Dst", position=1, wip_limit=1, allow_card_creation=True,
        )
        self.lane = Swimlane.objects.create(board=self.board, name="Lane", position=0)
        Card.objects.create(
            board=self.board, column=self.dst, swimlane=self.lane, title="Filler",
            created_by=self.admin, position=0,
        )
        self.card = Card.objects.create(
            board=self.board, column=self.src, swimlane=self.lane, title="Mine",
            created_by=self.admin, position=0, assignee=self.member, assigned_by=self.admin,
        )
        self.base = f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}"

    def _client(self, user):
        client = APIClient()
        client.force_authenticate(user)
        return client

    def _move(self, user, reason=None):
        body = {"column_id": self.dst.pk, "swimlane_id": self.lane.pk, "position": 0}
        if reason is not None:
            body["override_reason"] = reason
        return self._client(user).post(f"{self.base}/move/?force=true", body, format="json")

    def _override_row(self):
        return CardActivity.objects.get(card=self.card, event_type=ET.OVERRIDE_USED)

    def _timeline_override(self, user=None):
        r = self._client(user or self.admin).get(f"{self.base}/timeline/")
        self.assertEqual(r.status_code, 200, r.content)
        return next(e for e in r.json()["results"] if e["event_type"] == "override_used")

    # -- write path -----------------------------------------------------------

    def test_assignee_override_records_the_assigner_on_the_activity(self, _):
        self.assertEqual(self._move(self.member, reason="escalation").status_code, 200)
        act = self._override_row()
        self.assertEqual(act.assigned_by_id, self.admin.pk)
        self.assertEqual(act.assigned_by_id, CardOverride.objects.get().assigned_by_id)

    def test_admin_override_records_no_assigner(self, _):
        self.assertEqual(self._move(self.admin).status_code, 200)
        self.assertIsNone(self._override_row().assigned_by_id)

    def test_snapshot_survives_a_later_reassignment(self, _):
        self._move(self.member, reason="escalation")
        Card.objects.filter(pk=self.card.pk).update(assigned_by=self.member)
        self.assertEqual(self._override_row().assigned_by_id, self.admin.pk)

    # -- read paths -----------------------------------------------------------

    def test_timeline_carries_the_assigner_on_override_entries_only(self, _):
        self._move(self.member, reason="escalation")
        CardActivity.objects.create(card=self.card, event_type=ET.PRIORITY_CHANGE, from_value="low", to_value="high")
        r = self._client(self.member).get(f"{self.base}/timeline/")
        data = {e["event_type"]: e["data"] for e in r.json()["results"]}
        self.assertEqual(data["override_used"]["assigned_by"], {
            "id": self.admin.pk, "username": "ab_admin", "display_name": "Avery Admin",
            "avatar_url": self.admin.avatar_url,
        })
        self.assertNotIn("assigned_by", data["priority_change"])

    def test_timeline_assigner_is_null_when_absent(self, _):
        # Admin basis: the key is there, null.
        self._move(self.admin)
        self.assertIsNone(self._timeline_override()["data"]["assigned_by"])

    def test_legacy_assignee_row_without_assigner_reads_null(self, _):
        # An assignee row written before #2594 has no assigner to show.
        CardActivity.objects.create(
            card=self.card, event_type=ET.OVERRIDE_USED, from_value="assignee", to_value="wip",
            item_text="old", actor=self.member,
        )
        self.assertIsNone(self._timeline_override()["data"]["assigned_by"])

    def test_deleted_assigner_reads_null_everywhere(self, _):
        self._move(self.member, reason="escalation")
        self.admin_pk = self.admin.pk
        self.board.owner = self.member
        self.board.save(update_fields=["owner"])
        self.admin.delete()
        act = self._override_row()
        self.assertIsNone(act.assigned_by_id)
        self.assertIsNone(self._timeline_override(self.member)["data"]["assigned_by"])
        self.assertIsNone(_serialize_activity(act)["assigned_by"])

    def test_assigner_reference_puts_card_in_user_delete_lock_set(self, _):
        # The user delete SET_NULLs assigned_by on the card's activity row, so
        # the card must be locked first (card, then user lock order).
        self._move(self.member, reason="escalation")
        # Drop every other reference the admin has to this card.
        Card.objects.filter(pk=self.card.pk).update(created_by=self.member, assigned_by=None)
        CardActivity.objects.filter(card=self.card, actor=self.admin).delete()
        # The override snapshot also names the admin; only the activity row's
        # assigner may be left, or this stops isolating that reference.
        CardOverride.objects.filter(card=self.card).delete()
        self.board.owner = self.member
        self.board.save(update_fields=["owner"])
        locked = set(VisibanUserAdmin._cards_to_lock([self.admin.pk]).values_list("pk", flat=True))
        self.assertIn(self.card.pk, locked)

    def test_each_assigner_and_override_reference_alone_locks_the_card(self, _):
        # A bare card that references nobody; the target user gets exactly one
        # reference at a time, and each one alone must put the card in the set.
        target = User.objects.create_user(username="ab_target", password="pass")
        self.board.owner = self.member
        self.board.save(update_fields=["owner"])
        bare = Card.objects.create(
            board=self.board, column=self.src, swimlane=self.lane, title="Bare",
            created_by=self.member, position=5,
        )

        def locked():
            return set(VisibanUserAdmin._cards_to_lock([target.pk]).values_list("pk", flat=True))

        self.assertNotIn(bare.pk, locked())  # the baseline: no reference, no lock

        # Card.assigned_by: the delete updates the cards row itself.
        Card.objects.filter(pk=bare.pk).update(assigned_by=target)
        self.assertIn(bare.pk, locked())
        Card.objects.filter(pk=bare.pk).update(assigned_by=None)
        self.assertNotIn(bare.pk, locked())

        def override(**kw):
            return CardOverride.objects.create(
                card=bare, board=self.board, actor_basis="assignee", **kw,
            )

        for field in ("actor", "assigned_by"):
            with self.subTest(reference=f"CardOverride.{field}"):
                row = override(**{field: target})
                self.assertIn(bare.pk, locked())
                CardOverride.objects.filter(pk=row.pk).delete()
                self.assertNotIn(bare.pk, locked())

    def test_activities_endpoint_and_mcp_expose_the_assigner(self, _):
        self._move(self.member, reason="escalation")
        CardActivity.objects.create(card=self.card, event_type=ET.PRIORITY_CHANGE, from_value="low", to_value="high")
        r = self._client(self.member).get(f"{self.base}/activities/")
        self.assertEqual(r.status_code, 200)
        by_type = {a["event_type"]: a for a in r.json()}
        self.assertEqual(by_type["override_used"]["assigned_by"]["username"], "ab_admin")
        self.assertIsNone(by_type["priority_change"]["assigned_by"])
        self.assertEqual(
            _serialize_activity(self._override_row())["assigned_by"],
            {"username": "ab_admin", "display_name": "Avery Admin"},
        )

    def test_non_member_cannot_read_the_assigner(self, _):
        self._move(self.member, reason="escalation")
        outsider = User.objects.create_user(username="ab_outsider", password="pass")
        r = self._client(outsider).get(f"{self.base}/timeline/")
        self.assertIn(r.status_code, (403, 404))
        self.assertNotIn("ab_admin", r.content.decode())

    # -- export / import ------------------------------------------------------

    def _export(self):
        r = self._client(self.admin).get(f"/api/v1/boards/{self.board.pk}/export/?format=json")
        return json.loads(b"".join(r.streaming_content) if r.streaming else r.content)

    def test_json_export_carries_the_username_and_import_drops_it(self, _):
        self._move(self.member, reason="escalation")
        CardActivity.objects.create(card=self.card, event_type=ET.PRIORITY_CHANGE, from_value="low", to_value="high")
        body = self._export()
        acts = next(c for c in body["cards"] if c["title"] == "Mine")["activities"]
        by_type = {a["event_type"]: a for a in acts}
        self.assertEqual(by_type["override_used"]["assigned_by"], "ab_admin")
        self.assertIsNone(by_type["priority_change"]["assigned_by"])
        f = io.BytesIO(json.dumps(body).encode())
        f.name = "board.json"
        r = self._client(self.admin).post("/api/v1/boards/import/", {"file": f}, format="multipart")
        self.assertEqual(r.status_code, 201, r.content)
        imported = CardActivity.objects.get(card__board_id=r.data["id"], event_type=ET.OVERRIDE_USED)
        # History is never attributed to an account on a file's word (#1675).
        self.assertIsNone(imported.assigned_by_id)
        self.assertEqual(imported.item_text, "escalation")

    def test_deleted_card_history_export_carries_the_username(self, _):
        self._move(self.member, reason="escalation")
        Card.objects.filter(pk=self.card.pk).delete()
        body = self._export()
        acts = [a for e in body["deleted_card_history"] for a in e["activities"]]
        self.assertEqual(
            next(a for a in acts if a["event_type"] == "override_used")["assigned_by"], "ab_admin",
        )
