"""#2655: every reader of a movement's Warn record (``CardMovement.entry_unmet``).

A Warn move, create or restore records the unmet entry requirements on the
movement (#1923 MR B). These pin that REST card and board history, the card
timeline and the JSON export return it, each with exactly the seven keys of a
409 ``unmet`` item and never a card's value, and that a movement without a
Warn record reads ``null``.
"""

import json
from unittest.mock import patch

from boards.models import Card, CardMovement, CustomFieldValue
from boards.serializers import CardMovementSerializer
from boards.services.entry_requirements import UNMET_ITEM_KEYS, warn_record_items

from .test_entry_requirements_1923 import PATCH_BROADCAST, _Fixture
from .test_import_history_attribution import ImportedHistoryAttributionTests
from .test_import_history_attribution import _payload as _import_payload


class WarnRecordItemsTests(_Fixture):
    def test_keeps_only_the_documented_keys(self):
        record = [{
            "requirement_uid": "r1", "operator": "gt", "operand": "5", "field_uid": "f1",
            "field_name": "Amount", "field_set_uid": None, "field_set_name": None,
            "value": "SECRET", "kind": "entry_requirements",
        }]
        (item,) = warn_record_items(record)
        self.assertEqual(tuple(item), UNMET_ITEM_KEYS)
        self.assertNotIn("SECRET", json.dumps(item))

    def test_absent_or_junk_record_reads_none(self):
        for record in (None, [], {}, "x", [1, "a"]):
            with self.subTest(record=record):
                self.assertIsNone(warn_record_items(record))

    def test_serializer_reads_null_without_a_record(self):
        movement = CardMovement.objects.create(
            card=self.card, from_column=self.src, to_column=self.dst, moved_by=self.admin,
        )
        self.assertIsNone(CardMovementSerializer(movement).data["entry_unmet"])


class WarnRecordTransportTests(_Fixture):
    def setUp(self):
        super().setUp()
        self.req = self._require("warn")
        # A value that does not meet the requirement: it must appear nowhere.
        CustomFieldValue.objects.create(card=self.card, field_definition=self.amount, value="12345")
        resp = self._move(self.member)
        self.assertEqual(resp.status_code, 200)
        self.expected = [{
            "requirement_uid": self.req.uid, "operator": "gt", "operand": "50000",
            "field_uid": self.amount.uid, "field_name": "Amount",
            "field_set_uid": None, "field_set_name": None,
        }]

    def _get(self, url):
        resp = self._client(self.member).get(url)
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertNotIn("12345", resp.content.decode())
        return resp.json()

    def test_card_movements(self):
        rows = self._get(f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/movements/")
        rows = rows["results"] if isinstance(rows, dict) else rows
        self.assertEqual(rows[0]["entry_unmet"], self.expected)

    def test_board_movements(self):
        rows = self._get(f"/api/v1/boards/{self.board.pk}/movements/")["results"]
        self.assertEqual(rows[0]["entry_unmet"], self.expected)

    def test_card_timeline(self):
        entries = self._get(f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/timeline/")["results"]
        moves = [e for e in entries if e["kind"] == "move"]
        self.assertEqual(moves[0]["data"]["entry_unmet"], self.expected)

    def test_json_export(self):
        resp = self._client(self.admin).get(f"/api/v1/boards/{self.board.pk}/export/?format=json")
        self.assertEqual(resp.status_code, 200)
        # The export carries the card's values under custom_field_values on
        # purpose; the movement entry must not.
        (card,) = json.loads(resp.content)["cards"]
        self.assertEqual(card["movements"][-1]["entry_unmet"], self.expected)
        self.assertNotIn("12345", json.dumps(card["movements"]))

    def test_a_met_move_records_and_reads_null(self):
        other = Card.objects.create(
            board=self.board, column=self.src, swimlane=self.lane, title="Met",
            created_by=self.admin, position=1,
        )
        CustomFieldValue.objects.create(card=other, field_definition=self.amount, value="60000")
        self.assertEqual(self._move(self.member, card=other).status_code, 200)
        rows = self._get(f"/api/v1/boards/{self.board.pk}/cards/{other.pk}/movements/")
        rows = rows["results"] if isinstance(rows, dict) else rows
        self.assertIsNone(rows[0]["entry_unmet"])

    def test_move_response_movement_carries_it(self):
        other = Card.objects.create(
            board=self.board, column=self.src, swimlane=self.lane, title="Second",
            created_by=self.admin, position=1,
        )
        with patch(PATCH_BROADCAST):
            resp = self._move(self.member, card=other)
        self.assertEqual(resp.json()["movement"]["entry_unmet"], self.expected)


class WarnRecordRoleBoundaryTests(WarnRecordTransportTests):
    """A viewer reads the same record; a non-member is refused (rbac-check, #2655)."""

    def test_viewer_reads_entry_unmet(self):
        resp = self._client(self.viewer).get(f"/api/v1/boards/{self.board.pk}/movements/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["results"][0]["entry_unmet"], self.expected)
        self.assertNotIn("12345", resp.content.decode())

    def test_non_member_is_refused(self):
        from django.contrib.auth import get_user_model
        outsider = get_user_model().objects.create_user(username="er_out_2655", password="pass")
        for url in (
            f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/movements/",
            f"/api/v1/boards/{self.board.pk}/movements/",
        ):
            with self.subTest(url=url):
                resp = self._client(outsider).get(url)
                self.assertIn(resp.status_code, (403, 404))
                self.assertNotIn("entry_unmet", resp.content.decode())


class ImportIgnoresEntryUnmetTests(ImportedHistoryAttributionTests):
    """A JSON export's movement entries now carry ``entry_unmet``; re-importing
    one must succeed and must not store or echo the foreign record (#2655).
    The import's movement reader names its keys, so the record is dropped."""

    def test_import_drops_a_populated_entry_unmet(self):
        record = [{
            "requirement_uid": "r1", "operator": "gt", "operand": "50000",
            "field_uid": "f1", "field_name": "Amount",
            "field_set_uid": None, "field_set_name": None,
        }]
        movement = {
            "from_column": "To Do", "to_column": "Done", "moved_by": "alice",
            "moved_at": "2024-03-04T05:06:07Z", "entry_unmet": record,
        }
        resp = self._post(_import_payload(movement=movement))
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertNotIn("entry_unmet", resp.content.decode())
        mv = CardMovement.objects.get(card__board_id=resp.data["id"])
        self.assertIsNone(mv.entry_unmet)
        rows = self.client.get(f"/api/v1/boards/{resp.data['id']}/movements/").json()["results"]
        self.assertIsNone(rows[0]["entry_unmet"])
