"""JSON import of custom fields and the importer's history de-dup (#1447).

The exporter has written ``custom_fields``, ``swimlane_custom_fields`` and
both ``custom_field_values`` maps since #371/#1140; until #1447 the importer
dropped all four. These tests pin that an import now restores them through
the same validation the field APIs apply, and that an import does not stack
synthetic label / checklist / weight activities on top of a file's own.
"""

import copy
import io
import json
from unittest import mock

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, CardActivity, CustomFieldDefinition, CustomFieldValue,
    SwimlaneCustomFieldDefinition, SwimlaneCustomFieldValue,
)
from boards.views.import_export import BoardExportThrottle, BoardImportThrottle

_URL = "/api/v1/boards/import/"


def _definition(name, field_type, **extra):
    base = {
        "name": name, "field_type": field_type, "choices": [], "show_on_card": False,
        "is_required": False, "help_text": "", "number_prefix": "", "number_suffix": "",
        "number_decimals": None, "choice_colors": {},
    }
    base.update(extra)
    return base


def _board():
    return {
        "schema_version": 2,
        "name": "Fields board",
        "description": "",
        "columns": [{"name": "To Do", "position": 0}, {"name": "Done", "position": 1, "is_done": True}],
        "swimlanes": [
            {"name": "East", "position": 0, "custom_field_values": {
                "Owner": "Avery", "Quota": "1200000", "Tier": "Gold",
                "Renewal": "2026-09-01", "Strategic": "true", "Products": '["Boards","SSO"]',
                "Plan": "https://docs.example.com/plan", "Secret": "admins only",
            }},
            {"name": "West", "position": 1, "custom_field_values": {"Owner": "Blake"}},
        ],
        "labels": [{"name": "Bug", "color": "#EF4444"}],
        "custom_fields": [
            _definition("Deal value", "number", show_on_card=True, number_prefix="$", number_decimals=0),
            _definition("Stage", "dropdown", choices=["Open", "Won"], show_on_card=True,
                        choice_colors={"Open": "blue", "Won": "green"}),
            _definition("Close", "date"),
            _definition("Multi-year", "checkbox"),
            _definition("Areas", "multi_select", choices=["UI", "API", "DB"]),
            _definition("CRM", "url"),
            _definition("Champion", "text", help_text="Who is pushing internally."),
        ],
        "swimlane_custom_fields": [
            _definition("Owner", "text", show_on_row=True, is_admin_only=False),
            _definition("Quota", "number", show_on_row=True, is_admin_only=False, number_prefix="$"),
            _definition("Tier", "dropdown", choices=["Gold", "Silver"], show_on_row=False, is_admin_only=False),
            _definition("Renewal", "date", show_on_row=False, is_admin_only=False),
            _definition("Strategic", "checkbox", show_on_row=False, is_admin_only=False),
            _definition("Products", "multi_select", choices=["Boards", "SSO"], show_on_row=False, is_admin_only=False),
            _definition("Plan", "url", show_on_row=False, is_admin_only=False),
            _definition("Secret", "text", show_on_row=False, is_admin_only=True),
        ],
        "cards": [
            {
                "title": "Deal one", "column": "To Do", "swimlane": "East", "labels": ["Bug"],
                "weight": 3, "checklist": [{"text": "Call", "is_checked": True}],
                "custom_field_values": {
                    "Deal value": "50000", "Stage": "Open", "Close": "2026-06-30",
                    "Multi-year": "false", "Areas": '["UI","DB"]',
                    "CRM": "https://crm.example.com/1", "Champion": "Dana",
                },
            },
        ],
    }


# The cases below exceed the per-user import throttle (10/hour) together;
# throttling is not what they test.
@mock.patch.object(BoardImportThrottle, "allow_request", return_value=True)
@mock.patch.object(BoardExportThrottle, "allow_request", return_value=True)
class CustomFieldImportTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="importer", password="pass")
        self.client.force_authenticate(self.user)

    def _post(self, data, options=None):
        f = io.BytesIO(json.dumps(data).encode())
        f.name = "board.json"
        payload = {"file": f}
        if options is not None:
            payload["options"] = json.dumps(options)
        return self.client.post(_URL, payload, format="multipart")

    def _card_values(self, board):
        return {
            v.field_definition.name: v.value
            for v in CustomFieldValue.objects.filter(card__board=board).select_related("field_definition")
        }

    def _lane_values(self, board, lane):
        return {
            v.field_definition.name: v.value
            for v in SwimlaneCustomFieldValue.objects.filter(
                swimlane__board=board, swimlane__name=lane,
            ).select_related("field_definition")
        }

    def test_definitions_and_values_of_every_type_are_restored(self, *_):
        data = _board()
        resp = self._post(data)
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.data)
        board = Board.objects.get(pk=resp.data["id"])

        defs = list(CustomFieldDefinition.objects.filter(board=board).order_by("position"))
        self.assertEqual([d.name for d in defs], [d["name"] for d in data["custom_fields"]])
        self.assertEqual([d.position for d in defs], list(range(len(defs))))
        stage = defs[1]
        self.assertEqual(stage.choices_json, ["Open", "Won"])
        self.assertEqual(stage.choice_colors, {"Open": "blue", "Won": "green"})
        self.assertTrue(stage.show_on_card)
        self.assertEqual(defs[0].number_prefix, "$")
        self.assertEqual(defs[0].number_decimals, 0)

        row_defs = list(SwimlaneCustomFieldDefinition.objects.filter(board=board).order_by("position"))
        self.assertEqual([d.name for d in row_defs], [d["name"] for d in data["swimlane_custom_fields"]])
        self.assertTrue(row_defs[-1].is_admin_only)

        self.assertEqual(self._card_values(board), data["cards"][0]["custom_field_values"])
        self.assertEqual(self._lane_values(board, "East"), data["swimlanes"][0]["custom_field_values"])
        self.assertEqual(self._lane_values(board, "West"), {"Owner": "Blake"})

    def test_export_then_import_round_trips_every_value(self, *_):
        first = self._post(_board())
        self.assertEqual(first.status_code, status.HTTP_201_CREATED)
        exported = self.client.get(f"/api/v1/boards/{first.data['id']}/export/?format=json")
        self.assertEqual(exported.status_code, 200)
        payload = json.loads(exported.content)
        self.assertEqual(len(payload["custom_fields"]), 7)

        second = self._post(payload)
        self.assertEqual(second.status_code, status.HTTP_201_CREATED, second.data)
        a = Board.objects.get(pk=first.data["id"])
        b = Board.objects.get(pk=second.data["id"])
        self.assertEqual(self._card_values(b), self._card_values(a))
        self.assertEqual(self._lane_values(b, "East"), self._lane_values(a, "East"))

    def test_invalid_or_unknown_values_are_dropped_not_fatal(self, *_):
        data = _board()
        data["cards"][0]["custom_field_values"].update({
            "Deal value": "lots", "Stage": "Not a choice", "Nope": "x", "Close": "2026-13-01",
        })
        data["swimlanes"][1]["custom_field_values"] = {"Quota": "many", "Owner": "Blake"}
        resp = self._post(data)
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.data)
        board = Board.objects.get(pk=resp.data["id"])
        values = self._card_values(board)
        for dropped in ("Deal value", "Stage", "Nope", "Close"):
            self.assertNotIn(dropped, values)
        self.assertEqual(values["Champion"], "Dana")
        self.assertEqual(self._lane_values(board, "West"), {"Owner": "Blake"})

    def test_extension_validator_hooks_apply_to_imported_values(self, *_):
        """An enterprise value policy (boards.hooks) holds on import, not just on PATCH."""
        from django.core.exceptions import ValidationError
        from boards import hooks

        def no_dana(definition, value):
            if value == "Dana":
                raise ValidationError("blocked by policy")
            return None

        def upper_owner(definition, value):
            return value.upper() if definition.name == "Owner" else None

        with mock.patch.object(hooks, "CUSTOM_FIELD_VALIDATORS", [no_dana]), \
                mock.patch.object(hooks, "SWIMLANE_CUSTOM_FIELD_VALIDATORS", [upper_owner]):
            resp = self._post(_board())
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.data)
        board = Board.objects.get(pk=resp.data["id"])
        self.assertNotIn("Champion", self._card_values(board))
        self.assertEqual(self._lane_values(board, "West"), {"Owner": "BLAKE"})

    def _assert_rejected(self, data, fragment):
        before = Board.objects.count()
        resp = self._post(data)
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn(fragment, resp.data["detail"])
        self.assertEqual(Board.objects.count(), before)

    def test_invalid_definition_rejects_the_import(self, *_):
        data = _board()
        data["custom_fields"][1]["choices"] = []  # a dropdown needs choices
        self._assert_rejected(data, "custom_fields' entry at index 1")

    def test_duplicate_definition_names_reject_the_import(self, *_):
        data = _board()
        data["swimlane_custom_fields"].append(copy.deepcopy(data["swimlane_custom_fields"][0]))
        self._assert_rejected(data, "Duplicate swimlane_custom_fields names: Owner")

    def test_card_field_cap_applies_to_the_whole_list(self, *_):
        data = _board()
        data["custom_fields"] = [
            _definition(f"F{i}", "text") for i in range(CustomFieldDefinition.MAX_PER_BOARD + 1)
        ]
        self._assert_rejected(data, "at most 30")

    def test_pin_cap_applies_to_the_whole_list(self, *_):
        data = _board()
        data["custom_fields"][2]["show_on_card"] = True  # a third pinned card field
        self._assert_rejected(data, "at most 2")

    def test_row_pin_cap_applies_to_the_whole_list(self, *_):
        data = _board()
        for d in data["swimlane_custom_fields"]:
            d["show_on_row"] = True
        data["swimlane_custom_fields"].append(
            _definition("Ninth", "text", show_on_row=True, is_admin_only=False),
        )
        self._assert_rejected(data, "at most 8")

    def test_non_list_definitions_reject_the_import(self, *_):
        data = _board()
        data["custom_fields"] = {"name": "x"}
        self._assert_rejected(data, "'custom_fields' must be a list.")

    def test_cards_off_keeps_definitions_and_row_values(self, *_):
        resp = self._post(_board(), options={"cards": False})
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.data)
        board = Board.objects.get(pk=resp.data["id"])
        self.assertEqual(CustomFieldDefinition.objects.filter(board=board).count(), 7)
        self.assertEqual(CustomFieldValue.objects.filter(card__board=board).count(), 0)
        self.assertEqual(self._lane_values(board, "West"), {"Owner": "Blake"})

    def test_file_without_fields_still_imports(self, *_):
        data = _board()
        for key in ("custom_fields", "swimlane_custom_fields"):
            del data[key]
        resp = self._post(data)
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.data)
        self.assertFalse(CustomFieldValue.objects.filter(card__board_id=resp.data["id"]).exists())


@mock.patch.object(BoardImportThrottle, "allow_request", return_value=True)
class ImportedHistoryDedupTests(TestCase):
    """The importer's synthetic activities yield to the file's own."""

    ET = CardActivity.EventType

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="importer", password="pass")
        self.client.force_authenticate(self.user)

    def _import(self, activities, options=None):
        data = _board()
        data["cards"][0]["activities"] = activities
        f = io.BytesIO(json.dumps(data).encode())
        f.name = "board.json"
        payload = {"file": f}
        if options is not None:
            payload["options"] = json.dumps(options)
        resp = self.client.post(_URL, payload, format="multipart")
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.data)
        return CardActivity.objects.filter(card__board_id=resp.data["id"])

    def _types(self, qs):
        return sorted(qs.values_list("event_type", flat=True))

    def test_without_file_history_the_importer_synthesizes_it(self, *_):
        acts = self._import([])
        self.assertEqual(
            self._types(acts),
            sorted([self.ET.WEIGHT_CHANGE, self.ET.LABEL_CHANGE, self.ET.CHECKLIST_ITEM_ADDED]),
        )

    def test_file_history_replaces_the_synthetic_entries(self, *_):
        recorded = [
            {"event_type": "label_change", "from_value": "", "to_value": "+Bug", "created_at": "2026-01-02T00:00:00+00:00"},
            {"event_type": "weight_change", "from_value": "1", "to_value": "3", "created_at": "2026-01-03T00:00:00+00:00"},
            {"event_type": "checklist_item_added", "from_value": "", "to_value": "Call", "created_at": "2026-01-04T00:00:00+00:00"},
        ]
        acts = self._import(recorded)
        self.assertEqual(
            self._types(acts),
            sorted([self.ET.WEIGHT_CHANGE, self.ET.LABEL_CHANGE, self.ET.CHECKLIST_ITEM_ADDED]),
        )
        self.assertEqual(acts.get(event_type=self.ET.LABEL_CHANGE).created_at.year, 2026)
        self.assertEqual(acts.get(event_type=self.ET.LABEL_CHANGE).created_at.month, 1)

    def test_only_the_recorded_type_is_skipped(self, *_):
        acts = self._import([{"event_type": "label_change", "from_value": "", "to_value": "+Bug"}])
        self.assertEqual(
            self._types(acts),
            sorted([self.ET.WEIGHT_CHANGE, self.ET.LABEL_CHANGE, self.ET.CHECKLIST_ITEM_ADDED]),
        )

    def test_unknown_event_types_do_not_suppress_anything(self, *_):
        acts = self._import([{"event_type": "label_changed_typo"}, {"event_type": ["label_change"]}])
        self.assertEqual(acts.filter(event_type=self.ET.LABEL_CHANGE).count(), 1)

    def test_history_off_keeps_the_synthetic_label_and_checklist_entries(self, *_):
        """With history off the file's activities are not imported, so nothing replaces them."""
        acts = self._import(
            [{"event_type": "label_change", "from_value": "", "to_value": "+Bug"}],
            options={"history": False},
        )
        self.assertEqual(
            self._types(acts), sorted([self.ET.LABEL_CHANGE, self.ET.CHECKLIST_ITEM_ADDED]),
        )
