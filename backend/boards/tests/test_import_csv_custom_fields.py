"""CSV import of the ``Custom:`` / ``Swimlane Custom:`` columns (#1449).

The CSV export has appended these columns since #371/#1140; until #1449 the
importer ignored them, so a CSV round trip lost every custom field value. A CSV
carries no field type, so the importer derives ``text`` definitions and stores
each cell exactly as exported.
"""

import csv
import io
import json
from unittest import mock

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board,
    CustomFieldDefinition,
    CustomFieldValue,
    SwimlaneCustomFieldDefinition,
    SwimlaneCustomFieldValue,
)
from boards.views.import_export import BoardExportThrottle, BoardImportThrottle

_URL = "/api/v1/boards/import/"
_BASE = "Title,Column,Swimlane"


def _csv_file(content, filename="board.csv"):
    f = io.BytesIO(content.encode("utf-8"))
    f.name = filename
    return f


def _csv(header_extra, *rows):
    """A CSV text: fixed headers plus *header_extra*; each row is a list of cells."""
    out = io.StringIO()
    w = csv.writer(out, lineterminator="\n")
    w.writerow([*_BASE.split(","), *header_extra])
    for row in rows:
        w.writerow(row)
    return out.getvalue()


def _definition(name, field_type, **extra):
    base = {
        "name": name,
        "field_type": field_type,
        "choices": [],
        "show_on_card": False,
        "is_required": False,
        "help_text": "",
        "number_prefix": "",
        "number_suffix": "",
        "number_decimals": None,
        "choice_colors": {},
    }
    base.update(extra)
    return base


def _source_board():
    """A board with every card and row field type, for the round-trip test."""
    return {
        "schema_version": 2,
        "name": "Source",
        "description": "",
        "columns": [{"name": "To Do", "position": 0}],
        "swimlanes": [
            {
                "name": "East",
                "position": 0,
                "custom_field_values": {
                    "Owner": "Avery",
                    "Quota": "-1200",
                    "Tier": "Gold",
                    "Renewal": "2026-09-01",
                    "Strategic": "true",
                    "Products": '["Boards","SSO"]',
                    "Plan": "https://docs.example.com/p",
                },
            },
        ],
        "labels": [],
        "custom_fields": [
            _definition("Deal value", "number"),
            _definition("Stage", "dropdown", choices=["Open", "Won"]),
            _definition("Close", "date"),
            _definition("Multi-year", "checkbox"),
            _definition("Areas", "multi_select", choices=["UI", "API", "DB"]),
            _definition("CRM", "url"),
            _definition("Champion", "text"),
        ],
        "swimlane_custom_fields": [
            _definition("Owner", "text", show_on_row=False, is_admin_only=False),
            _definition("Quota", "number", show_on_row=False, is_admin_only=False),
            _definition(
                "Tier",
                "dropdown",
                choices=["Gold", "Silver"],
                show_on_row=False,
                is_admin_only=False,
            ),
            _definition("Renewal", "date", show_on_row=False, is_admin_only=False),
            _definition(
                "Strategic", "checkbox", show_on_row=False, is_admin_only=False
            ),
            _definition(
                "Products",
                "multi_select",
                choices=["Boards", "SSO"],
                show_on_row=False,
                is_admin_only=False,
            ),
            _definition("Plan", "url", show_on_row=False, is_admin_only=False),
        ],
        "cards": [
            {
                "title": "Deal one",
                "column": "To Do",
                "swimlane": "East",
                "custom_field_values": {
                    "Deal value": "-5",
                    "Stage": "Open",
                    "Close": "2026-06-30",
                    "Multi-year": "false",
                    "Areas": '["UI","DB"]',
                    "CRM": "https://crm.example.com/1",
                    "Champion": "Dana",
                },
            }
        ],
    }


@mock.patch.object(BoardImportThrottle, "allow_request", return_value=True)
@mock.patch.object(BoardExportThrottle, "allow_request", return_value=True)
class CsvCustomFieldImportTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="importer", password="pass")
        self.client.force_authenticate(self.user)

    def _post(self, content, options=None):
        payload = {"file": _csv_file(content)}
        if options is not None:
            payload["options"] = json.dumps(options)
        return self.client.post(_URL, payload, format="multipart")

    def _card_values(self, board, title=None):
        qs = CustomFieldValue.objects.filter(card__board=board)
        if title:
            qs = qs.filter(card__title=title)
        return {
            v.field_definition.name: v.value
            for v in qs.select_related("field_definition")
        }

    def _lane_values(self, board, lane):
        qs = SwimlaneCustomFieldValue.objects.filter(
            swimlane__board=board, swimlane__name=lane
        )
        return {
            v.field_definition.name: v.value
            for v in qs.select_related("field_definition")
        }

    def _ok(self, content, options=None):
        resp = self._post(content, options)
        self.assertEqual(
            resp.status_code, status.HTTP_201_CREATED, getattr(resp, "data", None)
        )
        return resp, Board.objects.get(pk=resp.data["id"])

    def _exported_csv(self):
        source = self.client.post(
            _URL,
            {"file": self._json_file(_source_board())},
            format="multipart",
        )
        self.assertEqual(source.status_code, status.HTTP_201_CREATED, source.data)
        resp = self.client.get(f"/api/v1/boards/{source.data['id']}/export/")
        self.assertEqual(resp.status_code, 200)
        return source, resp.content.decode("utf-8")

    @staticmethod
    def _json_file(data):
        f = io.BytesIO(json.dumps(data).encode())
        f.name = "board.json"
        return f

    def test_round_trip_restores_every_field_type_as_text(self, *_):
        source, text = self._exported_csv()
        rows = list(csv.reader(io.StringIO(text)))
        header, first = rows[0], dict(zip(rows[0], rows[1]))

        _, board = self._ok(text)

        card_defs = list(
            CustomFieldDefinition.objects.filter(board=board).order_by("position")
        )
        self.assertEqual(
            [d.name for d in card_defs],
            [h[len("Custom: ") :] for h in header if h.startswith("Custom: ")],
        )
        self.assertEqual({d.field_type for d in card_defs}, {"text"})
        self.assertEqual([d.position for d in card_defs], list(range(len(card_defs))))
        lane_defs = list(
            SwimlaneCustomFieldDefinition.objects.filter(board=board).order_by(
                "position"
            )
        )
        self.assertEqual(
            [d.name for d in lane_defs],
            [
                h[len("Swimlane Custom: ") :]
                for h in header
                if h.startswith("Swimlane Custom: ")
            ],
        )
        self.assertEqual({d.field_type for d in lane_defs}, {"text"})

        # Values equal the exported cell strings; the multi-select is plain text.
        expected_card = {
            h[len("Custom: ") :]: first[h]
            for h in header
            if h.startswith("Custom: ") and first[h]
        }
        self.assertEqual(self._card_values(board), expected_card)
        self.assertEqual(expected_card["Areas"], "UI; DB")
        expected_lane = {
            h[len("Swimlane Custom: ") :]: first[h]
            for h in header
            if h.startswith("Swimlane Custom: ") and first[h]
        }
        self.assertEqual(self._lane_values(board, "East"), expected_lane)
        self.assertEqual(expected_lane["Products"], "Boards; SSO")

    def test_negative_number_survives_export_and_round_trip(self, *_):
        _, text = self._exported_csv()
        rows = list(csv.reader(io.StringIO(text)))
        cells = dict(zip(rows[0], rows[1]))
        self.assertEqual(cells["Custom: Deal value"], "-5")
        self.assertEqual(cells["Swimlane Custom: Quota"], "-1200")
        _, board = self._ok(text)
        self.assertEqual(self._card_values(board)["Deal value"], "-5")
        self.assertEqual(self._lane_values(board, "East")["Quota"], "-1200")

    def test_formula_cell_is_stored_as_given_and_re_exported_stripped(self, *_):
        _, board = self._ok(_csv(["Custom: Note"], ["A", "To Do", "Lane", "=1+1"]))
        self.assertEqual(self._card_values(board), {"Note": "=1+1"})
        exported = self.client.get(
            f"/api/v1/boards/{board.pk}/export/"
        ).content.decode()
        rows = list(csv.reader(io.StringIO(exported)))
        self.assertEqual(rows[1][rows[0].index("Custom: Note")], "1+1")

    def test_multi_select_cell_is_not_parsed(self, *_):
        _, board = self._ok(_csv(["Custom: Areas"], ["A", "To Do", "Lane", "UI; DB"]))
        self.assertEqual(self._card_values(board), {"Areas": "UI; DB"})

    def test_swimlane_conflict_keeps_first_and_warns_once(self, *_):
        resp, board = self._ok(
            _csv(
                ["Swimlane Custom: Owner"],
                ["A", "To Do", "East", "Avery"],
                ["B", "To Do", "East", "Blake"],
                ["C", "To Do", "East", "Casey"],
                ["D", "To Do", "West", "Dana"],
            )
        )
        self.assertEqual(self._lane_values(board, "East"), {"Owner": "Avery"})
        self.assertEqual(self._lane_values(board, "West"), {"Owner": "Dana"})
        warnings = resp.data["import_summary"]["warnings"]
        self.assertEqual(len(warnings), 1)
        self.assertIn("East", warnings[0])
        self.assertIn("Owner", warnings[0])
        self.assertIn("Avery", warnings[0])

    def test_swimlane_first_non_empty_wins_and_blank_lane_has_no_value(self, *_):
        resp, board = self._ok(
            _csv(
                ["Swimlane Custom: Owner"],
                ["A", "To Do", "East", ""],
                ["B", "To Do", "East", "Blake"],
                ["C", "To Do", "East", "Blake"],
                ["D", "To Do", "West", ""],
            )
        )
        self.assertEqual(self._lane_values(board, "East"), {"Owner": "Blake"})
        self.assertEqual(self._lane_values(board, "West"), {})
        self.assertEqual(resp.data["import_summary"]["warnings"], [])

    def test_duplicate_custom_headers_are_rejected(self, *_):
        before = Board.objects.count()
        resp = self._post(
            _csv(["Custom: X", "Custom: X"], ["A", "To Do", "Lane", "1", "2"])
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("Duplicate", resp.data["detail"])
        self.assertIn("Custom: X", resp.data["detail"])
        self.assertEqual(Board.objects.count(), before)

    def test_card_and_swimlane_field_with_the_same_name_coexist(self, *_):
        _, board = self._ok(
            _csv(
                ["Custom: Region", "Swimlane Custom: Region"],
                ["A", "To Do", "East", "card-val", "lane-val"],
            )
        )
        self.assertEqual(self._card_values(board), {"Region": "card-val"})
        self.assertEqual(self._lane_values(board, "East"), {"Region": "lane-val"})

    def test_too_many_columns_reject_the_import_and_create_no_board(self, *_):
        before = Board.objects.count()
        for headers in (
            [f"Custom: F{i}" for i in range(31)],
            [f"Swimlane Custom: F{i}" for i in range(16)],
        ):
            resp = self._post(
                _csv(headers, ["A", "To Do", "Lane", *([""] * len(headers))])
            )
            self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
            self.assertIn("at most", resp.data["detail"])
        self.assertEqual(Board.objects.count(), before)
        # The limits themselves are accepted.
        self._ok(
            _csv(
                [f"Custom: F{i}" for i in range(30)],
                ["A", "To Do", "Lane", *([""] * 30)],
            )
        )
        self._ok(
            _csv(
                [f"Swimlane Custom: F{i}" for i in range(15)],
                ["A", "To Do", "Lane", *([""] * 15)],
            )
        )

    def test_overlong_cell_is_dropped_with_a_warning(self, *_):
        resp, board = self._ok(
            _csv(
                ["Custom: Note", "Custom: Ok"],
                ["A", "To Do", "Lane", "x" * 501, "fine"],
            )
        )
        self.assertEqual(self._card_values(board), {"Ok": "fine"})
        warnings = resp.data["import_summary"]["warnings"]
        self.assertEqual(len(warnings), 1)
        self.assertIn("Note", warnings[0])
        self.assertLess(len(warnings[0]), 200)
        # Exactly the limit is kept.
        _, board = self._ok(_csv(["Custom: Note"], ["A", "To Do", "Lane", "y" * 500]))
        self.assertEqual(len(self._card_values(board)["Note"]), 500)

    def test_overlong_swimlane_cell_is_dropped_with_a_warning(self, *_):
        resp, board = self._ok(
            _csv(["Swimlane Custom: Note"], ["A", "To Do", "East", "x" * 501])
        )
        self.assertEqual(self._lane_values(board, "East"), {})
        self.assertEqual(len(resp.data["import_summary"]["warnings"]), 1)
        self.assertIn("East", resp.data["import_summary"]["warnings"][0])

    def test_empty_field_name_column_is_skipped_with_a_warning(self, *_):
        resp, board = self._ok(
            _csv(["Custom: ", "Custom: Ok"], ["A", "To Do", "Lane", "v", "w"])
        )
        self.assertEqual(self._card_values(board), {"Ok": "w"})
        self.assertEqual(CustomFieldDefinition.objects.filter(board=board).count(), 1)
        self.assertEqual(len(resp.data["import_summary"]["warnings"]), 1)

    def test_warnings_are_capped(self, *_):
        rows = [[f"C{i}", "To Do", "Lane", "z" * 501] for i in range(25)]
        resp, _board = self._ok(_csv(["Custom: Note"], *rows))
        warnings = resp.data["import_summary"]["warnings"]
        self.assertEqual(len(warnings), 21)
        self.assertEqual(warnings[-1], "…and 5 more")

    def test_cards_off_keeps_definitions_and_swimlane_values_only(self, *_):
        _, board = self._ok(
            _csv(
                ["Custom: Note", "Swimlane Custom: Owner"],
                ["A", "To Do", "East", "n", "Avery"],
            ),
            options={"cards": False},
        )
        self.assertEqual(CustomFieldDefinition.objects.filter(board=board).count(), 1)
        self.assertEqual(
            SwimlaneCustomFieldDefinition.objects.filter(board=board).count(), 1
        )
        self.assertEqual(self._card_values(board), {})
        self.assertEqual(self._lane_values(board, "East"), {"Owner": "Avery"})

    def test_blank_cells_create_no_value_rows(self, *_):
        _, board = self._ok(
            _csv(
                ["Custom: Note", "Swimlane Custom: Owner"],
                ["A", "To Do", "East", "", "  "],
            )
        )
        self.assertEqual(CustomFieldDefinition.objects.filter(board=board).count(), 1)
        self.assertEqual(CustomFieldValue.objects.filter(card__board=board).count(), 0)
        self.assertEqual(
            SwimlaneCustomFieldValue.objects.filter(swimlane__board=board).count(), 0
        )

    def test_csv_without_custom_columns_is_unchanged_apart_from_empty_warnings(
        self, *_
    ):
        resp, board = self._ok(_csv([], ["A", "To Do", "Lane"]))
        self.assertEqual(resp.data["import_summary"]["warnings"], [])
        self.assertEqual(
            set(resp.data["import_summary"]), {"options_applied", "skipped", "warnings"}
        )
        self.assertEqual(CustomFieldDefinition.objects.filter(board=board).count(), 0)
        self.assertEqual(
            SwimlaneCustomFieldDefinition.objects.filter(board=board).count(), 0
        )

    def test_extension_validator_hooks_apply(self, *_):
        from django.core.exceptions import ValidationError
        from boards import hooks

        def no_dana(definition, value):
            if value == "Dana":
                raise ValidationError("blocked by policy")
            return None

        def upper_owner(definition, value):
            return value.upper() if definition.name == "Owner" else None

        with (
            mock.patch.object(hooks, "CUSTOM_FIELD_VALIDATORS", [no_dana]),
            mock.patch.object(hooks, "SWIMLANE_CUSTOM_FIELD_VALIDATORS", [upper_owner]),
        ):
            resp, board = self._ok(
                _csv(
                    ["Custom: Champion", "Swimlane Custom: Owner"],
                    ["A", "To Do", "East", "Dana", "blake"],
                )
            )
        self.assertEqual(self._card_values(board), {})
        self.assertEqual(self._lane_values(board, "East"), {"Owner": "BLAKE"})
        self.assertEqual(len(resp.data["import_summary"]["warnings"]), 1)

    def test_failure_after_definitions_are_created_leaves_nothing_behind(self, *_):
        before = Board.objects.count()
        with mock.patch.object(
            CustomFieldValue.objects,
            "bulk_create",
            side_effect=RuntimeError("boom"),
        ):
            with self.assertRaises(RuntimeError):
                self._post(
                    _csv(
                        ["Custom: Note", "Swimlane Custom: Owner"],
                        ["A", "To Do", "East", "n", "o"],
                    )
                )
        self.assertEqual(Board.objects.count(), before)
        self.assertEqual(CustomFieldDefinition.objects.count(), 0)
        self.assertEqual(SwimlaneCustomFieldDefinition.objects.count(), 0)
        self.assertEqual(SwimlaneCustomFieldValue.objects.count(), 0)


class CsvNumberCellExportTests(TestCase):
    """The export must not strip the sign of a stored number (#1449)."""

    def test_number_and_checkbox_cells_are_written_as_stored(self):
        from boards.views.import_export import _csv_custom_field_cell

        number = CustomFieldDefinition(name="N", field_type="number")
        for stored in ("-5", "+5", "1e5", "-0.25", "5"):
            self.assertEqual(_csv_custom_field_cell(number, stored), stored)
        checkbox = CustomFieldDefinition(name="C", field_type="checkbox")
        self.assertEqual(_csv_custom_field_cell(checkbox, "true"), "true")

    def test_non_canonical_numbers_and_other_types_are_still_sanitized(self):
        from boards.views.import_export import _csv_custom_field_cell

        number = CustomFieldDefinition(name="N", field_type="number")
        for stored in ("=1+1", "@SUM(A1)", "-NaN", "-Infinity", "-5 ", "\t5"):
            cell = _csv_custom_field_cell(number, stored)
            self.assertFalse(cell[:1] in "=+-@\t\r" and cell != "", cell)
        text = CustomFieldDefinition(name="T", field_type="text")
        self.assertEqual(_csv_custom_field_cell(text, "-5"), "5")
        self.assertEqual(_csv_custom_field_cell(text, "=cmd"), "cmd")
