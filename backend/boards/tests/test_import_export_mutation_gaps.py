"""Exact-value assertions for ``boards/views/import_export.py`` (#1453).

The scoped mutation run in #1443 (``docs/development/mutation-testing.md``)
found the import/export suites asserted status codes and counts but not the
error bodies, JSON keys, ordering or limit boundaries, so most mutants of
message strings, defaults and ``>`` vs ``>=`` on the import caps survived.
Every assertion here pins a value a client or a downstream tool can observe:

* the exact ``detail`` of every import rejection,
* both sides of each import cap (500 cards, 50 columns, 100 swimlanes),
* the key set and key ORDER of the JSON export and of each nested object,
* the sort order of cards, comments, checklist items, movements, activities,
* the CSV header row and the formatting of the Movement History cell,
* the defaults the importer applies when a field is absent,
* the Trello endpoint's own (view-level) error paths.

The compliance-grade history export planned for 1.2 builds on these shapes.
"""

import csv
import datetime
import io
import json
from unittest import mock

from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board,
    BoardEvent,
    BoardExportLog,
    BoardMembership,
    Card,
    CardActivity,
    CardChecklist,
    CardComment,
    CardExternalRef,
    CardMovement,
    Column,
    CustomFieldDefinition,
    CustomFieldValue,
    Label,
    Swimlane,
    SwimlaneCustomFieldDefinition,
    SwimlaneCustomFieldValue,
)
from boards.permissions import SITE_ADMIN
from boards.views.import_export import (
    _can_export_at_min_role,
    _csv_custom_field_cell,
    _flatten_serializer_errors,
    _imported_board_name,
    _role_at_export,
    _sanitize_csv_field,
)
from groups.models import Group, GroupMembership


IMPORT_URL = "/api/v1/boards/import/"
TRELLO_URL = "/api/v1/boards/import/trello/"
Role = BoardMembership.Role


def _make_visible(importer, *others):
    """Put ``others`` on a board with ``importer`` so the importer can see them (#1434)."""
    board = Board.objects.create(name="Shared", owner=importer)
    for u in (importer, *others):
        BoardMembership.objects.get_or_create(
            board=board, user=u, defaults={"role": BoardMembership.Role.MEMBER}
        )


def _upload(data, name="board.json", content_type=None):
    raw = data if isinstance(data, bytes) else json.dumps(data).encode("utf-8")
    return SimpleUploadedFile(
        name, raw, content_type=content_type or "application/octet-stream"
    )


def _csv_upload(text, name="board.csv"):
    return SimpleUploadedFile(name, text.encode("utf-8"), content_type="text/csv")


def _minimal(**overrides):
    data = {
        "name": "Src",
        "columns": [{"name": "To Do"}, {"name": "Done"}],
        "swimlanes": [{"name": "General"}],
        "cards": [],
    }
    data.update(overrides)
    return data


def _card(title="C", **extra):
    return {"title": title, "column": "To Do", "swimlane": "General", **extra}


class ImportBase(TestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(username="importer", password="pass")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def post(self, data, **extra):
        # Failed requests count against the 10/hour import throttle too.
        cache.clear()
        payload = {"file": _upload(data) if not hasattr(data, "read") else data}
        payload.update(extra)
        return self.client.post(IMPORT_URL, payload, format="multipart")

    def post_csv(self, text, name="board.csv", **extra):
        cache.clear()
        payload = {"file": _csv_upload(text, name)}
        payload.update(extra)
        return self.client.post(IMPORT_URL, payload, format="multipart")

    def assert_400(self, resp, detail):
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST, resp.content)
        self.assertEqual(resp.json(), {"detail": detail})


# ---------------------------------------------------------------------------
# import_board: dispatch and pre-parse rejections
# ---------------------------------------------------------------------------


class ImportDispatchErrorTests(ImportBase):
    def test_no_file(self):
        cache.clear()
        resp = self.client.post(IMPORT_URL, {}, format="multipart")
        self.assert_400(resp, "No file provided.")

    @override_settings(MAX_UPLOAD_SIZE=1024 * 1024)
    def test_file_one_byte_over_limit_is_rejected_with_size_in_mb(self):
        resp = self.post(_upload(b"x" * (1024 * 1024 + 1)))
        self.assert_400(resp, "File too large. Maximum size is 1 MB.")

    @override_settings(MAX_UPLOAD_SIZE=1024 * 1024)
    def test_file_exactly_at_limit_is_not_a_size_error(self):
        resp = self.post(_upload(b"x" * (1024 * 1024)))
        # Falls through to JSON parsing, which is what proves the size gate passed.
        self.assert_400(resp, "The uploaded file is not valid JSON.")

    def test_unsupported_extension_and_type(self):
        f = SimpleUploadedFile("board.txt", b"{}", content_type="text/plain")
        resp = self.post(f)
        self.assert_400(resp, "Unsupported file format. Upload a .json or .csv file.")

    def test_json_chosen_from_content_type_when_extension_unknown(self):
        f = SimpleUploadedFile(
            "export", json.dumps(_minimal()).encode(), content_type="application/json"
        )
        self.assertEqual(self.post(f).status_code, status.HTTP_201_CREATED)

    def test_csv_chosen_from_content_type_when_extension_unknown(self):
        f = SimpleUploadedFile(
            "export", b"Title,Column,Swimlane\nA,B,C\n", content_type="text/csv"
        )
        resp = self.post(f)
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.content)
        self.assertEqual(resp.json()["name"], "Imported: export")

    def test_extension_is_case_insensitive(self):
        f = SimpleUploadedFile(
            "BOARD.JSON", json.dumps(_minimal()).encode(), content_type="x/y"
        )
        self.assertEqual(self.post(f).status_code, status.HTTP_201_CREATED)
        f = SimpleUploadedFile(
            "BOARD.CSV", b"Title,Column,Swimlane\nA,B,C\n", content_type="x/y"
        )
        self.assertEqual(self.post(f).status_code, status.HTTP_201_CREATED)


class ImportOptionsErrorTests(ImportBase):
    def _opts(self, raw, filename="b.json", data=None):
        f = _upload(_minimal() if data is None else data, name=filename)
        cache.clear()
        return self.client.post(
            IMPORT_URL, {"file": f, "options": raw}, format="multipart"
        )

    def test_options_not_json(self):
        self.assert_400(self._opts("{nope"), "'options' is not valid JSON.")

    def test_options_not_an_object(self):
        self.assert_400(self._opts("[1, 2]"), "'options' must be a JSON object.")

    def test_options_unknown_key(self):
        self.assert_400(
            self._opts('{"zeta": true, "alpha": 1}'),
            "Invalid 'options': Unknown import option(s): alpha, zeta.",
        )

    def test_options_wrong_type_names_the_field(self):
        resp = self._opts('{"cards": "yes"}')
        self.assertEqual(resp.status_code, 400)
        self.assertTrue(
            resp.json()["detail"].startswith("Invalid 'options': 'cards': "),
            resp.json(),
        )

    def test_options_dependents_require_cards(self):
        self.assert_400(
            self._opts('{"cards": false, "history": true, "comments": true}'),
            "Invalid 'options': Import option(s) comments, history require 'cards'.",
        )

    def test_options_blank_string_means_everything(self):
        resp = self._opts("   ")
        self.assertEqual(resp.status_code, 201, resp.content)
        applied = resp.json()["import_summary"]["options_applied"]
        self.assertEqual(
            applied,
            {
                "labels": True,
                "cards": True,
                "comments": True,
                "checklist": True,
                "history": True,
            },
        )

    def test_csv_rejects_json_only_options(self):
        resp = self._opts(
            '{"history": false}',
            filename="b.csv",
            data=b"Title,Column,Swimlane\nA,B,C\n",
        )
        self.assert_400(resp, "Invalid 'options': Unknown import option(s): history.")

    def test_options_applied_echoes_resolved_flags(self):
        resp = self._opts('{"cards": false}')
        self.assertEqual(
            resp.json()["import_summary"]["options_applied"],
            {
                "labels": True,
                "cards": False,
                "comments": False,
                "checklist": False,
                "history": False,
            },
        )

    def test_csv_options_applied_has_all_five_keys(self):
        resp = self._opts(
            '{"cards": false}', filename="b.csv", data=b"Title,Column,Swimlane\nA,B,C\n"
        )
        self.assertEqual(
            resp.json()["import_summary"]["options_applied"],
            {
                "labels": True,
                "cards": False,
                "comments": False,
                "checklist": False,
                "history": False,
            },
        )


class FlattenSerializerErrorsTests(TestCase):
    def test_shapes(self):
        self.assertEqual(_flatten_serializer_errors({"cards": ["bad"]}), "'cards': bad")
        self.assertEqual(
            _flatten_serializer_errors({"non_field_errors": ["boom"]}), "boom"
        )
        self.assertEqual(_flatten_serializer_errors({"detail": ["boom"]}), "boom")
        self.assertEqual(
            _flatten_serializer_errors({"a": {"b": ["deep"]}}), "'a': 'b': deep"
        )
        self.assertEqual(_flatten_serializer_errors(["first", "second"]), "first")
        self.assertEqual(_flatten_serializer_errors([]), "[]")
        self.assertEqual(_flatten_serializer_errors("plain"), "plain")
        self.assertEqual(
            _flatten_serializer_errors({"a": ["one"], "b": ["two"]}), "'a': one"
        )


# ---------------------------------------------------------------------------
# _import_json: validation bodies
# ---------------------------------------------------------------------------


class ImportJsonValidationTests(ImportBase):
    def test_malformed_json_and_logs_a_warning(self):
        with self.assertLogs("boards.views.import_export", level="WARNING") as cm:
            resp = self.post(_upload(b"{not json"))
        self.assert_400(resp, "The uploaded file is not valid JSON.")
        self.assertIn("Board JSON import rejected", cm.output[0])
        self.assertIn("malformed payload", cm.output[0])

    def test_non_utf8_bytes(self):
        self.assert_400(
            self.post(_upload(b"\xff\xfe\x00")), "The uploaded file is not valid JSON."
        )

    def test_top_level_must_be_object(self):
        self.assert_400(
            self.post(_upload([1, 2])),
            "Invalid JSON: expected an object at the top level.",
        )

    def test_collection_keys_must_be_lists(self):
        for key in ("cards", "columns", "swimlanes", "labels"):
            with self.subTest(key=key):
                self.assert_400(
                    self.post(_minimal(**{key: "oops"})),
                    f"Invalid JSON: '{key}' must be a list.",
                )

    def test_missing_required_top_level_fields(self):
        data = _minimal()
        del data["name"]
        self.assert_400(self.post(data), "Missing required field: name")
        self.assert_400(
            self.post(_minimal(columns=[])), "Missing required field: columns"
        )
        self.assert_400(
            self.post(_minimal(swimlanes=[])), "Missing required field: swimlanes"
        )
        data = _minimal()
        del data["columns"]
        self.assert_400(self.post(data), "Missing required field: columns")
        data = _minimal()
        del data["swimlanes"]
        self.assert_400(self.post(data), "Missing required field: swimlanes")

    def test_card_missing_required_field_reports_index_and_field(self):
        for field in ("title", "column", "swimlane"):
            with self.subTest(field=field):
                bad = _card("B")
                bad[field] = ""
                self.assert_400(
                    self.post(_minimal(cards=[_card("A"), bad])),
                    f"Card at index 1 is missing required field: {field}",
                )
        bad = _card("B")
        del bad["title"]
        self.assert_400(
            self.post(_minimal(cards=[bad])),
            "Card at index 0 is missing required field: title",
        )

    def test_invalid_card_timestamps_and_dates(self):
        cases = [
            (
                _card(archived_at="nope"),
                "Card at index 1: invalid timestamp for 'archived_at': 'nope'",
            ),
            (
                _card(due_date="31/12/2026"),
                "Card at index 1: invalid due_date: '31/12/2026'",
            ),
        ]
        for bad, detail in cases:
            with self.subTest(detail=detail):
                self.assert_400(self.post(_minimal(cards=[_card("A"), bad])), detail)

    def test_weight_and_position_must_be_non_negative_ints(self):
        for field in ("weight", "position"):
            for bad in (-1, True, "3", 1.5):
                with self.subTest(field=field, bad=bad):
                    self.assert_400(
                        self.post(_minimal(cards=[_card("A"), _card(**{field: bad})])),
                        f"Card at index 1: {field} must be a non-negative integer",
                    )

    def test_zero_weight_and_position_are_accepted(self):
        resp = self.post(_minimal(cards=[_card(weight=0, position=0)]))
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(Card.objects.get().weight, 0)

    def test_invalid_nested_timestamps_report_card_and_item_index(self):
        base = _card()
        cases = [
            (
                {"comments": [{"body": "ok"}, {"body": "x", "created_at": "bad"}]},
                "Card at index 0, comment at index 1: invalid 'created_at': 'bad'",
            ),
            (
                {"movements": [{"moved_at": "bad"}]},
                "Card at index 0, movement at index 0: invalid 'moved_at': 'bad'",
            ),
            (
                {"activities": [{"event_type": "title_change", "created_at": "bad"}]},
                "Card at index 0, activity at index 0: invalid 'created_at': 'bad'",
            ),
        ]
        for extra, detail in cases:
            with self.subTest(detail=detail):
                self.assert_400(self.post(_minimal(cards=[{**base, **extra}])), detail)

    def test_column_limits_must_be_non_negative_ints(self):
        for fname in ("wip_limit", "weight_limit"):
            for bad in (-1, True, "5", 2.5):
                with self.subTest(fname=fname, bad=bad):
                    cols = [{"name": "A"}, {"name": "B", fname: bad}]
                    self.assert_400(
                        self.post(_minimal(columns=cols)),
                        f"Column at index 1: {fname} must be a non-negative integer",
                    )

    def test_column_limit_zero_is_accepted(self):
        resp = self.post(
            _minimal(columns=[{"name": "A", "wip_limit": 0, "weight_limit": 0}])
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        col = Column.objects.get()
        self.assertEqual((col.wip_limit, col.weight_limit), (0, 0))

    def test_duplicate_names_are_listed_sorted(self):
        self.assert_400(
            self.post(
                _minimal(
                    columns=[{"name": "B"}, {"name": "A"}, {"name": "B"}, {"name": "A"}]
                )
            ),
            "Duplicate column names: A, B",
        )
        self.assert_400(
            self.post(_minimal(swimlanes=[{"name": "S"}, {"name": "S"}])),
            "Duplicate swimlane names: S",
        )
        self.assert_400(
            self.post(
                _minimal(labels=[{"name": "L", "color": "#111111"}, {"name": "L"}])
            ),
            "Duplicate label names: L",
        )

    def test_card_references_undefined_column_or_swimlane(self):
        self.assert_400(
            self.post(
                _minimal(
                    cards=[
                        _card("A"),
                        {"title": "B", "column": "Nope", "swimlane": "General"},
                    ]
                )
            ),
            "Card at index 1 references undefined column: 'Nope'",
        )
        self.assert_400(
            self.post(
                _minimal(cards=[{"title": "B", "column": "To Do", "swimlane": "Nope"}])
            ),
            "Card at index 0 references undefined swimlane: 'Nope'",
        )

    def test_unhashable_column_reference_is_a_clean_400(self):
        self.assert_400(
            self.post(
                _minimal(
                    cards=[{"title": "B", "column": ["To Do"], "swimlane": "General"}]
                )
            ),
            "Card at index 0 references undefined column: ['To Do']",
        )
        self.assert_400(
            self.post(
                _minimal(
                    cards=[{"title": "B", "column": "To Do", "swimlane": {"a": 1}}]
                )
            ),
            "Card at index 0 references undefined swimlane: {'a': 1}",
        )

    def test_nothing_is_created_by_a_rejected_import(self):
        self.post(
            _minimal(cards=[{"title": "B", "column": "Nope", "swimlane": "General"}])
        )
        self.assertEqual(Board.objects.count(), 0)


class ImportCapTests(ImportBase):
    """Each cap accepts exactly N and rejects N + 1, with the exact message."""

    def _cards(self, n):
        return [_card(f"c{i}") for i in range(n)]

    def test_cards_500_accepted(self):
        resp = self.post(_minimal(cards=self._cards(500)))
        self.assertEqual(resp.status_code, 201, resp.content[:300])
        self.assertEqual(Card.objects.count(), 500)

    def test_cards_501_rejected(self):
        self.assert_400(
            self.post(_minimal(cards=self._cards(501))),
            "Import contains 501 cards, which exceeds the limit of 500.",
        )
        self.assertEqual(Board.objects.count(), 0)

    def test_columns_50_accepted(self):
        resp = self.post(_minimal(columns=[{"name": f"c{i}"} for i in range(50)]))
        self.assertEqual(resp.status_code, 201, resp.content[:300])
        self.assertEqual(Column.objects.count(), 50)

    def test_columns_51_rejected(self):
        self.assert_400(
            self.post(_minimal(columns=[{"name": f"c{i}"} for i in range(51)])),
            "Import contains 51 columns, which exceeds the limit of 50.",
        )

    def test_swimlanes_100_accepted(self):
        resp = self.post(_minimal(swimlanes=[{"name": f"s{i}"} for i in range(100)]))
        self.assertEqual(resp.status_code, 201, resp.content[:300])
        self.assertEqual(Swimlane.objects.count(), 100)

    def test_swimlanes_101_rejected(self):
        self.assert_400(
            self.post(_minimal(swimlanes=[{"name": f"s{i}"} for i in range(101)])),
            "Import contains 101 swimlanes, which exceeds the limit of 100.",
        )

    def test_caps_are_checked_before_required_fields(self):
        data = _minimal(cards=self._cards(501))
        del data["name"]
        self.assert_400(
            self.post(data),
            "Import contains 501 cards, which exceeds the limit of 500.",
        )

    def test_csv_rows_500_accepted_501_rejected(self):
        head = "Title,Column,Swimlane\n"
        ok = head + "".join(f"t{i},A,B\n" for i in range(500))
        resp = self.post_csv(ok)
        self.assertEqual(resp.status_code, 201, resp.content[:300])
        self.assertEqual(Card.objects.count(), 500)
        over = head + "".join(f"t{i},A,B\n" for i in range(501))
        self.assert_400(
            self.post_csv(over),
            "Import contains 501 rows, which exceeds the card limit of 500.",
        )

    def test_csv_columns_50_accepted_51_rejected(self):
        head = "Title,Column,Swimlane\n"
        resp = self.post_csv(head + "".join(f"t,c{i},S\n" for i in range(50)))
        self.assertEqual(resp.status_code, 201, resp.content[:300])
        self.assertEqual(Column.objects.count(), 50)
        self.assert_400(
            self.post_csv(head + "".join(f"t,c{i},S\n" for i in range(51))),
            "Import contains 51 columns, which exceeds the limit of 50.",
        )

    def test_csv_swimlanes_100_accepted_101_rejected(self):
        head = "Title,Column,Swimlane\n"
        resp = self.post_csv(head + "".join(f"t,C,s{i}\n" for i in range(100)))
        self.assertEqual(resp.status_code, 201, resp.content[:300])
        self.assertEqual(Swimlane.objects.count(), 100)
        self.assert_400(
            self.post_csv(head + "".join(f"t,C,s{i}\n" for i in range(101))),
            "Import contains 101 swimlanes, which exceeds the limit of 100.",
        )


class ImportFieldDefinitionErrorTests(ImportBase):
    """``_validate_import_field_definitions`` error bodies for both lists."""

    def _def(self, name, **extra):
        return {"name": name, "field_type": "text", **extra}

    def test_not_a_list(self):
        self.assert_400(
            self.post(_minimal(custom_fields={"a": 1})),
            "'custom_fields' must be a list.",
        )
        self.assert_400(
            self.post(_minimal(swimlane_custom_fields="x")),
            "'swimlane_custom_fields' must be a list.",
        )

    def test_too_many_entries(self):
        n = CustomFieldDefinition.MAX_PER_BOARD + 1
        self.assert_400(
            self.post(_minimal(custom_fields=[self._def(f"f{i}") for i in range(n)])),
            f"'custom_fields' has {n} entries; a board may define at most {n - 1}.",
        )
        m = SwimlaneCustomFieldDefinition.MAX_PER_BOARD + 1
        self.assert_400(
            self.post(
                _minimal(swimlane_custom_fields=[self._def(f"f{i}") for i in range(m)])
            ),
            f"'swimlane_custom_fields' has {m} entries; a board may define at most {m - 1}.",
        )

    def test_exactly_at_the_cap_is_accepted(self):
        n = CustomFieldDefinition.MAX_PER_BOARD
        resp = self.post(_minimal(custom_fields=[self._def(f"f{i}") for i in range(n)]))
        self.assertEqual(resp.status_code, 201, resp.content[:300])
        self.assertEqual(CustomFieldDefinition.objects.count(), n)
        m = SwimlaneCustomFieldDefinition.MAX_PER_BOARD
        resp = self.post(
            _minimal(swimlane_custom_fields=[self._def(f"f{i}") for i in range(m)])
        )
        self.assertEqual(resp.status_code, 201, resp.content[:300])
        self.assertEqual(SwimlaneCustomFieldDefinition.objects.count(), m)

    def test_entry_must_be_object(self):
        self.assert_400(
            self.post(_minimal(custom_fields=[self._def("a"), "text"])),
            "'custom_fields' entry at index 1 must be an object.",
        )

    def test_invalid_entry_reports_index_and_first_error(self):
        resp = self.post(
            _minimal(
                custom_fields=[self._def("a"), {"name": "b", "field_type": "bogus"}]
            )
        )
        self.assertEqual(resp.status_code, 400)
        detail = resp.json()["detail"]
        self.assertTrue(
            detail.startswith("'custom_fields' entry at index 1: 'field_type': "),
            detail,
        )
        resp = self.post(_minimal(swimlane_custom_fields=[{"field_type": "text"}]))
        detail = resp.json()["detail"]
        self.assertTrue(
            detail.startswith("'swimlane_custom_fields' entry at index 0: 'name': "),
            detail,
        )

    def test_duplicate_names(self):
        self.assert_400(
            self.post(
                _minimal(
                    custom_fields=[
                        self._def("b"),
                        self._def("a"),
                        self._def("b"),
                        self._def("a"),
                    ]
                )
            ),
            "Duplicate custom_fields names: a, b",
        )

    def test_too_many_pinned(self):
        n = CustomFieldDefinition.MAX_PINNED_PER_BOARD + 1
        defs = [self._def(f"f{i}", show_on_card=True) for i in range(n)]
        self.assert_400(
            self.post(_minimal(custom_fields=defs)),
            f"'custom_fields' pins {n} fields with 'show_on_card'; at most {n - 1} are allowed.",
        )
        m = SwimlaneCustomFieldDefinition.MAX_PINNED_PER_BOARD + 1
        defs = [self._def(f"f{i}", show_on_row=True) for i in range(m)]
        self.assert_400(
            self.post(_minimal(swimlane_custom_fields=defs)),
            f"'swimlane_custom_fields' pins {m} fields with 'show_on_row'; at most {m - 1} are allowed.",
        )

    def test_pinned_exactly_at_the_cap_is_accepted(self):
        n = CustomFieldDefinition.MAX_PINNED_PER_BOARD
        defs = [self._def(f"f{i}", show_on_card=True) for i in range(n)]
        self.assertEqual(self.post(_minimal(custom_fields=defs)).status_code, 201)

    def test_definition_positions_follow_list_order(self):
        resp = self.post(_minimal(custom_fields=[self._def("z"), self._def("a")]))
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(
            list(
                CustomFieldDefinition.objects.order_by("position").values_list(
                    "name", "position"
                )
            ),
            [("z", 0), ("a", 1)],
        )


# ---------------------------------------------------------------------------
# _import_json: what gets created (defaults, backfills, side records)
# ---------------------------------------------------------------------------


class ImportJsonDefaultsTests(ImportBase):
    def test_structure_defaults(self):
        resp = self.post(
            _minimal(
                labels=[{"name": "L"}],
                columns=[
                    {"name": "A"},
                    {"name": "B"},
                    {
                        "name": "C",
                        "position": 7,
                        "color": "#123456",
                        "wip_limit": 4,
                        "weight_limit": 9,
                        "allow_card_creation": True,
                        "is_done": True,
                    },
                ],
                swimlanes=[
                    {"name": "S1"},
                    {
                        "name": "S2",
                        "position": 5,
                        "color": "#ABCDEF",
                        "contact_email": "a@b.co",
                        "notes": "n",
                    },
                ],
            )
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        cols = {c.name: c for c in Column.objects.all()}
        a, b, c = cols["A"], cols["B"], cols["C"]
        self.assertEqual((a.position, b.position, c.position), (0, 1, 7))
        self.assertEqual((a.color, b.color, c.color), ("#6B7280", "#6B7280", "#123456"))
        self.assertEqual((a.wip_limit, a.weight_limit), (None, None))
        self.assertEqual((c.wip_limit, c.weight_limit), (4, 9))
        # allow_card_creation defaults to True for the first column only.
        self.assertEqual(
            (a.allow_card_creation, b.allow_card_creation, c.allow_card_creation),
            (True, False, True),
        )
        self.assertEqual((a.is_done, c.is_done), (False, True))
        sws = {s.name: s for s in Swimlane.objects.all()}
        self.assertEqual((sws["S1"].position, sws["S2"].position), (0, 5))
        self.assertEqual((sws["S1"].color, sws["S2"].color), ("#3B82F6", "#ABCDEF"))
        self.assertEqual((sws["S1"].contact_email, sws["S1"].notes), ("", ""))
        self.assertEqual((sws["S2"].contact_email, sws["S2"].notes), ("a@b.co", "n"))
        self.assertEqual(Label.objects.get().color, "#EAB308")

    def test_board_row_owner_membership_and_description(self):
        resp = self.post(_minimal(description="About"))
        board = Board.objects.get()
        self.assertEqual(board.description, "About")
        self.assertEqual(board.owner, self.user)
        self.assertEqual(board.name, "Imported: Src")
        m = BoardMembership.objects.get(board=board)
        self.assertEqual((m.user, m.role), (self.user, Role.ADMIN))
        self.assertEqual(resp.json()["name"], "Imported: Src")
        # No description key -> empty string.
        data = _minimal()
        self.post(data)
        self.assertEqual(Board.objects.exclude(pk=board.pk).get().description, "")

    def test_explicit_name_is_used_verbatim(self):
        resp = self.post(_minimal(), name="Exactly This")
        self.assertEqual(resp.json()["name"], "Exactly This")

    def test_card_defaults(self):
        self.post(_minimal(cards=[_card("Plain")]))
        card = Card.objects.get()
        self.assertEqual(card.priority, "medium")
        self.assertEqual(card.description, "")
        self.assertIsNone(card.due_date)
        self.assertEqual(card.weight, 1)
        self.assertEqual(card.position, 0)
        self.assertIsNone(card.assignee)
        self.assertIsNone(card.archived_at)
        self.assertEqual(card.created_by, self.user)
        self.assertEqual(card.column.name, "To Do")
        self.assertEqual(card.swimlane.name, "General")
        self.assertFalse(CardActivity.objects.exists())

    def test_card_field_values(self):
        self.post(
            _minimal(
                cards=[
                    _card(
                        "Full",
                        description="D",
                        priority="urgent",
                        due_date="2026-12-31",
                        weight=5,
                        position=3,
                        archived_at="2026-01-02T03:04:05Z",
                    )
                ]
            )
        )
        card = Card.objects.get()
        self.assertEqual(
            (
                card.description,
                card.priority,
                card.due_date,
                card.weight,
                card.position,
            ),
            ("D", "urgent", datetime.date(2026, 12, 31), 5, 3),
        )
        self.assertEqual(card.archived_at.isoformat(), "2026-01-02T03:04:05+00:00")

    def test_unknown_or_unhashable_priority_falls_back_to_medium(self):
        for bad in ("critical", ["high"], {"a": 1}, 7):
            with self.subTest(bad=bad):
                Card.objects.all().delete()
                self.post(_minimal(cards=[_card(priority=bad)]))
                self.assertEqual(Card.objects.get().priority, "medium")

    def test_assignee_resolution_is_case_insensitive_and_unknown_is_none(self):
        other = User.objects.create_user(username="MixedCase", password="x")
        _make_visible(self.user, other)
        self.post(
            _minimal(
                cards=[_card("a", assignee="mixedcase"), _card("b", assignee="ghost")]
            )
        )
        by_title = {c.title: c for c in Card.objects.all()}
        self.assertEqual(by_title["a"].assignee, other)
        self.assertIsNone(by_title["b"].assignee)

    def test_weight_activity_only_above_one(self):
        self.post(
            _minimal(
                cards=[
                    _card("one", weight=1),
                    _card("zero", weight=0),
                    _card("five", weight=5),
                ]
            )
        )
        acts = CardActivity.objects.all()
        self.assertEqual(acts.count(), 1)
        act = acts.get()
        self.assertEqual(act.card.title, "five")
        self.assertEqual(act.event_type, "weight_change")
        self.assertEqual(
            (act.from_value, act.to_value, act.actor), ("1", "5", self.user)
        )

    def test_label_links_and_activity_text(self):
        self.post(
            _minimal(
                labels=[{"name": "A"}, {"name": "B"}],
                cards=[
                    _card("x", labels=["A", "B", "Unknown"]),
                    _card("y", labels=["Unknown"]),
                ],
            )
        )
        x = Card.objects.get(title="x")
        self.assertEqual(sorted(lb.name for lb in x.labels.all()), ["A", "B"])
        self.assertEqual(Card.objects.get(title="y").labels.count(), 0)
        act = CardActivity.objects.get()
        self.assertEqual(act.card, x)
        self.assertEqual(act.event_type, "label_change")
        self.assertEqual((act.from_value, act.to_value), ("", "+A, B"))
        self.assertEqual(act.actor, self.user)

    def test_comments_default_body_author_and_backfilled_timestamp(self):
        self.post(
            _minimal(
                cards=[
                    _card(
                        comments=[
                            {
                                "body": "hello",
                                "created_at": "2025-03-04T05:06:07Z",
                                "author": "ignored",
                            },
                            {},
                        ]
                    )
                ]
            )
        )
        comments = list(CardComment.objects.order_by("id"))
        self.assertEqual([c.body for c in comments], ["hello", ""])
        self.assertTrue(all(c.author == self.user for c in comments))
        self.assertEqual(
            comments[0].created_at.isoformat(), "2025-03-04T05:06:07+00:00"
        )
        # Second comment had no created_at, so it keeps the import time.
        self.assertGreater(comments[1].created_at.year, 2025)

    def test_checklist_items_positions_defaults_and_activity(self):
        self.post(
            _minimal(
                cards=[
                    _card(
                        checklist=[
                            {"text": "one", "is_checked": True},
                            {"text": "two"},
                            {},
                        ]
                    )
                ]
            )
        )
        items = list(CardChecklist.objects.order_by("position"))
        self.assertEqual(
            [(i.text, i.is_checked, i.position) for i in items],
            [("one", True, 0), ("two", False, 1), ("", False, 2)],
        )
        acts = list(
            CardActivity.objects.filter(event_type="checklist_item_added").order_by(
                "id"
            )
        )
        self.assertEqual(
            [(a.from_value, a.to_value, a.actor) for a in acts],
            [("", "one", self.user), ("", "two", self.user), ("", "", self.user)],
        )

    def test_movement_import_resolution_and_defaults(self):
        mover = User.objects.create_user(username="Mover", password="x")
        _make_visible(self.user, mover)
        self.post(
            _minimal(
                cards=[
                    _card(
                        movements=[
                            {
                                "from_column": "To Do",
                                "to_column": "Done",
                                "from_swimlane": "General",
                                "to_swimlane": "General",
                                "moved_by": "mover",
                                "moved_at": "2024-05-06T07:08:09Z",
                                "notes": "shipped",
                                "movement_type": "archived",
                            },
                            {
                                "from_column": "Deleted col",
                                "to_column": "To Do",
                                "to_swimlane": "Gone lane",
                                "moved_by": "ghost",
                                "movement_type": ["move"],
                            },
                            {"movement_type": "bogus"},
                        ]
                    )
                ]
            )
        )
        mvs = list(CardMovement.objects.order_by("id"))
        first, second, third = mvs
        todo, done = Column.objects.get(name="To Do"), Column.objects.get(name="Done")
        general = Swimlane.objects.get(name="General")
        self.assertEqual((first.from_column, first.to_column), (todo, done))
        self.assertEqual((first.from_swimlane, first.to_swimlane), (general, general))
        self.assertEqual(
            (first.from_column_name, first.to_column_name), ("To Do", "Done")
        )
        self.assertEqual(
            (first.from_swimlane_name, first.to_swimlane_name), ("General", "General")
        )
        self.assertEqual(
            (first.from_column_uid, first.to_column_uid), (todo.uid, done.uid)
        )
        self.assertEqual(
            (first.from_swimlane_uid, first.to_swimlane_uid), (general.uid, general.uid)
        )
        self.assertEqual(first.moved_by, mover)
        self.assertEqual(first.notes, "shipped")
        self.assertEqual(first.movement_type, "archived")
        self.assertEqual(first.moved_at.isoformat(), "2024-05-06T07:08:09+00:00")
        # Unknown names keep the exported text and an empty uid; unknown mover -> importer.
        self.assertIsNone(second.from_column)
        self.assertEqual(second.from_column_name, "Deleted col")
        self.assertEqual(second.from_column_uid, "")
        self.assertEqual(second.to_column, todo)
        self.assertIsNone(second.to_swimlane)
        self.assertEqual(second.to_swimlane_name, "Gone lane")
        self.assertEqual(second.to_swimlane_uid, "")
        self.assertEqual(second.from_swimlane_name, "")
        self.assertEqual(second.moved_by, self.user)
        self.assertEqual(second.movement_type, "move")
        self.assertEqual(second.notes, "")
        self.assertEqual(third.movement_type, "move")
        self.assertEqual((third.from_column_name, third.to_column_name), ("", ""))
        self.assertEqual(third.moved_by, self.user)

    def test_activity_import_skips_unknown_types_and_falls_back_to_importer(self):
        actor = User.objects.create_user(username="Actor", password="x")
        _make_visible(self.user, actor)
        self.post(
            _minimal(
                cards=[
                    _card(
                        activities=[
                            {
                                "event_type": "title_change",
                                "from_value": "a",
                                "to_value": "b",
                                "actor": "actor",
                                "created_at": "2023-01-02T03:04:05Z",
                            },
                            {"event_type": "due_date_change", "actor": "ghost"},
                            {"event_type": "not_a_type"},
                            {"event_type": ["x"]},
                            {},
                        ]
                    )
                ]
            )
        )
        acts = list(CardActivity.objects.order_by("id"))
        self.assertEqual(
            [a.event_type for a in acts], ["title_change", "due_date_change"]
        )
        self.assertEqual(
            (acts[0].from_value, acts[0].to_value, acts[0].actor), ("a", "b", actor)
        )
        self.assertEqual(acts[0].created_at.isoformat(), "2023-01-02T03:04:05+00:00")
        self.assertEqual(
            (acts[1].from_value, acts[1].to_value, acts[1].actor), ("", "", self.user)
        )

    def test_file_history_suppresses_the_synthetic_entry_of_the_same_type(self):
        self.post(
            _minimal(
                labels=[{"name": "A"}],
                cards=[
                    _card(
                        weight=4,
                        labels=["A"],
                        checklist=[{"text": "t"}],
                        activities=[
                            {
                                "event_type": "weight_change",
                                "from_value": "1",
                                "to_value": "4",
                                "actor": "x",
                            },
                            {
                                "event_type": "label_change",
                                "from_value": "",
                                "to_value": "+A",
                            },
                            {"event_type": "checklist_item_added", "to_value": "t"},
                        ],
                    )
                ],
            )
        )
        counts = {}
        for a in CardActivity.objects.all():
            counts[a.event_type] = counts.get(a.event_type, 0) + 1
        self.assertEqual(
            counts, {"weight_change": 1, "label_change": 1, "checklist_item_added": 1}
        )

    def test_history_off_keeps_synthetic_label_and_checklist_but_not_weight(self):
        resp = self.post(
            _minimal(
                labels=[{"name": "A"}],
                cards=[
                    _card(
                        weight=4,
                        labels=["A"],
                        checklist=[{"text": "t"}],
                        activities=[{"event_type": "title_change"}],
                    )
                ],
            ),
            options=json.dumps({"history": False}),
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        types = sorted(CardActivity.objects.values_list("event_type", flat=True))
        self.assertEqual(types, ["checklist_item_added", "label_change"])

    def test_external_ref_valid_and_invalid(self):
        self.post(
            _minimal(
                cards=[
                    _card(
                        "ok",
                        external_ref={
                            "provider": "gitlab",
                            "ref": "!12",
                            "url": "https://gitlab.com/o/r/-/merge_requests/12",
                        },
                    ),
                    _card(
                        "bad",
                        external_ref={
                            "provider": "gitlab",
                            "ref": "!1",
                            "url": "javascript:alert(1)",
                        },
                    ),
                    _card("junk", external_ref="nope"),
                ]
            )
        )
        ref = CardExternalRef.objects.get()
        self.assertEqual(ref.card.title, "ok")
        self.assertEqual((ref.provider, ref.ref), ("gitlab", "!12"))

    def test_response_shape_and_summary(self):
        resp = self.post(
            _minimal(
                labels=[{"name": "L"}],
                cards=[
                    _card(
                        labels=["L"],
                        comments=[{"body": "x"}],
                        checklist=[{"text": "t"}],
                        movements=[{}],
                        activities=[{"event_type": "title_change"}],
                    )
                ],
            ),
            options=json.dumps(
                {
                    "cards": True,
                    "comments": False,
                    "checklist": False,
                    "history": False,
                    "labels": False,
                }
            ),
        )
        self.assertEqual(resp.status_code, 201)
        body = resp.json()
        self.assertEqual(
            body["import_summary"],
            {
                "options_applied": {
                    "labels": False,
                    "cards": True,
                    "comments": False,
                    "checklist": False,
                    "history": False,
                },
                "skipped": {
                    "cards": 0,
                    "comments": 1,
                    "checklist_items": 1,
                    "label_refs": 1,
                    "movements": 1,
                    "activities": 1,
                },
            },
        )
        self.assertEqual(body["card_count"], 1)
        self.assertEqual(body["member_count"], 1)

    def test_cards_off_skip_counts_and_nothing_below_a_card(self):
        resp = self.post(
            _minimal(
                labels=[{"name": "L"}],
                cards=[
                    _card(
                        "a",
                        labels=["L", "L", "ghost"],
                        comments=[{"body": "x"}, {"body": "y"}],
                        checklist=[{"text": "t"}],
                        movements=[{}, {}],
                        activities=[
                            {"event_type": "title_change"},
                            {"event_type": "nope"},
                        ],
                    ),
                    _card("b"),
                ],
            ),
            options=json.dumps({"cards": False}),
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(
            resp.json()["import_summary"]["skipped"],
            {
                "cards": 2,
                "comments": 2,
                "checklist_items": 1,
                "label_refs": 1,
                "movements": 2,
                "activities": 1,
            },
        )
        self.assertEqual(Card.objects.count(), 0)
        self.assertEqual(Label.objects.count(), 1)

    def test_each_dependent_option_skip_count(self):
        card = _card(
            comments=[{"body": "x"}],
            checklist=[{"text": "t"}, {"text": "u"}],
            movements=[{}, {}, {}],
            activities=[{"event_type": "title_change"}, {"event_type": "bogus"}],
        )
        for opt, expected in (
            ("comments", {"comments": 1}),
            ("checklist", {"checklist_items": 2}),
            ("history", {"movements": 3, "activities": 1}),
        ):
            with self.subTest(opt=opt):
                resp = self.post(
                    _minimal(cards=[card]), options=json.dumps({opt: False})
                )
                skipped = resp.json()["import_summary"]["skipped"]
                base = {
                    "cards": 0,
                    "comments": 0,
                    "checklist_items": 0,
                    "label_refs": 0,
                    "movements": 0,
                    "activities": 0,
                }
                base.update(expected)
                self.assertEqual(skipped, base)

    def test_labels_off_skips_label_refs_but_cards_keep_everything_else(self):
        resp = self.post(
            _minimal(labels=[{"name": "L"}], cards=[_card(labels=["L"])]),
            options=json.dumps({"labels": False}),
        )
        self.assertEqual(resp.json()["import_summary"]["skipped"]["label_refs"], 1)
        self.assertEqual(Label.objects.count(), 0)
        self.assertEqual(Card.objects.count(), 1)
        self.assertFalse(CardActivity.objects.exists())

    def test_board_created_event_payload_carries_import_options(self):
        resp = self.post(_minimal())
        event = BoardEvent.objects.get(board_id=resp.json()["id"])
        self.assertEqual(event.event, "board.created")
        self.assertEqual(event.actor_id, self.user.id)
        self.assertEqual(event.data["name"], "Imported: Src")
        self.assertEqual(
            event.data["import_options"],
            {
                "labels": True,
                "cards": True,
                "comments": True,
                "checklist": True,
                "history": True,
            },
        )

    def test_schema_version_warning_only_above_supported(self):
        with self.assertNoLogs("boards.views.import_export", level="WARNING"):
            self.post(_minimal(schema_version=2))
        with self.assertLogs("boards.views.import_export", level="WARNING") as cm:
            resp = self.post(_minimal(schema_version=3))
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(len(cm.records), 1)
        self.assertEqual(
            cm.records[0].getMessage(),
            "Importing board JSON with schema_version=3 (importer supports up to 2). "
            "Some fields may be ignored.",
        )

    def test_shift_dates_moves_card_dates(self):
        today = timezone.localdate()
        base = today - datetime.timedelta(days=10)
        resp = self.post(
            _minimal(cards=[_card(due_date=base.isoformat())]),
            options=json.dumps({"shift_dates_from": base.isoformat()}),
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(Card.objects.get().due_date, today)
        self.assertEqual(
            resp.json()["import_summary"]["options_applied"]["shift_dates_from"],
            base.isoformat(),
        )


class ImportGroupTests(ImportBase):
    def test_group_membership_rules(self):
        owner = User.objects.create_user(username="gowner", password="x")
        member = User.objects.create_user(username="gmember", password="x")
        group = Group.objects.create(name="G", owner=owner)
        GroupMembership.objects.create(group=group, user=member)

        # outsider -> 403 with the exact message
        resp = self.post(_minimal(), group_id=str(group.pk))
        self.assertEqual(resp.status_code, 403)
        self.assertEqual(
            resp.json(), {"detail": "You are not a member of the target group."}
        )

        # missing group -> 404
        resp = self.post(_minimal(), group_id="999999")
        self.assertEqual(resp.status_code, 404)

        # member -> placed in the group
        self.client.force_authenticate(member)
        resp = self.post(_minimal(), group_id=str(group.pk))
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(Board.objects.get().group, group)

        # group owner -> allowed too
        Board.objects.all().delete()
        self.client.force_authenticate(owner)
        resp = self.post(_minimal(), group_id=str(group.pk))
        self.assertEqual(resp.status_code, 201, resp.content)

    def test_no_group_id_means_ungrouped(self):
        self.post(_minimal())
        self.assertIsNone(Board.objects.get().group)


# ---------------------------------------------------------------------------
# _import_csv
# ---------------------------------------------------------------------------


class ImportCsvTests(ImportBase):
    def test_non_utf8(self):
        cache.clear()
        resp = self.client.post(
            IMPORT_URL,
            {
                "file": SimpleUploadedFile(
                    "b.csv", b"\xff\xfe\x00bad", content_type="text/csv"
                )
            },
            format="multipart",
        )
        self.assertEqual(resp.status_code, 400)
        self.assertTrue(resp.json()["detail"].startswith("Invalid CSV: "), resp.json())

    def test_empty_file_and_header_only(self):
        self.assert_400(self.post_csv(""), "CSV file is empty.")
        self.assert_400(self.post_csv("Title,Column,Swimlane\n"), "CSV file is empty.")

    def test_missing_headers_listed_sorted(self):
        self.assert_400(
            self.post_csv("Foo,Bar\n1,2\n"),
            "CSV is missing required headers: Column, Swimlane, Title",
        )
        self.assert_400(
            self.post_csv("Title,Swimlane\nA,B\n"),
            "CSV is missing required headers: Column",
        )

    def test_row_missing_required_field_uses_spreadsheet_row_number(self):
        for field, text in (
            ("Title", "Title,Column,Swimlane\nok,A,B\n  ,A,B\n"),
            ("Column", "Title,Column,Swimlane\nok,A,B\nt,,B\n"),
            ("Swimlane", "Title,Column,Swimlane\nok,A,B\nt,A,   \n"),
        ):
            with self.subTest(field=field):
                self.assert_400(
                    self.post_csv(text), f"Row 3 is missing required field: {field}"
                )

    def test_invalid_due_date(self):
        self.assert_400(
            self.post_csv(
                "Title,Column,Swimlane,Due Date\nok,A,B,2026-01-01\nt,A,B,soon\n"
            ),
            "Row 3: invalid Due Date: 'soon'",
        )

    def test_short_row_missing_required_field_is_400_not_500(self):
        # DictReader fills missing trailing cells with None (#1496).
        for field, text in (
            ("Swimlane", "Title,Column,Swimlane\nA,To Do\n"),
            ("Column", "Title,Column,Swimlane\nA\n"),
        ):
            with self.subTest(field=field):
                self.assert_400(
                    self.post_csv(text), f"Row 2 is missing required field: {field}"
                )
                self.assertEqual(Board.objects.count(), 0)
                self.assertEqual(Card.objects.count(), 0)

    def _assert_rejected_clean(self, text, prefix):
        resp = self.post_csv(text)
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST, resp.content)
        detail = resp.json()["detail"]
        self.assertTrue(detail.startswith(prefix), detail)
        self.assertLess(len(detail), 400)  # echoes a bounded slice only
        self.assertEqual(Board.objects.count(), 0)
        self.assertEqual(Card.objects.count(), 0)

    def test_over_length_title_column_swimlane_label_is_400(self):
        # #1512: PostgreSQL DataError in bulk_create became a 500.
        for field, text, prefix in (
            ("Title", f"Title,Column,Swimlane\n{'t' * 501},A,B\n", "Row 2: Title exceeds 500"),
            ("Column", f"Title,Column,Swimlane\nt,{'c' * 256},B\n", "Row 2: Column exceeds 255"),
            ("Swimlane", f"Title,Column,Swimlane\nt,A,{'s' * 256}\n", "Row 2: Swimlane exceeds 255"),
            ("Labels", f"Title,Column,Swimlane,Labels\nt,A,B,{'l' * 51}\n", "Row 2: Labels entry exceeds 50"),
        ):
            with self.subTest(field=field):
                self._assert_rejected_clean(text, prefix)

    def test_max_length_values_still_import(self):
        resp = self.post_csv(f"Title,Column,Swimlane,Labels\n{'t' * 500},{'c' * 255},{'s' * 255},{'l' * 50}\n")
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(len(Card.objects.get().title), 500)

    def test_oversized_weight_is_400(self):
        self._assert_rejected_clean(
            "Title,Column,Swimlane,Weight\nt,A,B,2147483648\n", "Row 2: Weight out of range"
        )

    def test_nul_byte_in_cell_is_400(self):
        self._assert_rejected_clean(
            "Title,Column,Swimlane,Description\nt,A,B,bad\x00cell\n",
            "Row 2: Description contains a NUL byte",
        )

    def test_impossible_due_date_is_400(self):
        self._assert_rejected_clean(
            "Title,Column,Swimlane,Due Date\nt,A,B,2020-02-30\n",
            "Row 2: invalid Due Date: '2020-02-30'",
        )

    def test_short_row_missing_optional_trailing_fields_uses_defaults(self):
        resp = self.post_csv(
            "Title,Column,Swimlane,Description,Priority,Weight,Due Date,Assignee,Labels\n"
            "A,To Do,Lane\n"
            "B,To Do,Lane,desc\n"
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        a, b = Card.objects.order_by("title")
        self.assertEqual(
            (a.description, a.priority, a.weight, a.due_date, a.assignee),
            ("", "medium", 1, None, None),
        )
        self.assertEqual((b.description, b.priority, b.weight), ("desc", "medium", 1))
        self.assertEqual(Label.objects.count(), 0)

    def test_short_row_missing_trailing_due_date_cell(self):
        # Due Date is the LAST column, so the short row's cell is None, which
        # crashed on .strip() before #1496.
        resp = self.post_csv("Title,Column,Swimlane,Due Date\nA,To Do,Lane\n")
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertIsNone(Card.objects.get().due_date)

    def test_short_row_then_invalid_due_date_still_400(self):
        self.assert_400(
            self.post_csv("Title,Column,Swimlane,Due Date\nok,A,B\nt,A,B,soon\n"),
            "Row 3: invalid Due Date: 'soon'",
        )
        self.assertEqual(Board.objects.count(), 0)

    def test_long_row_surplus_cells_are_ignored(self):
        resp = self.post_csv("Title,Column,Swimlane\nA,To Do,Lane,extra,more\n")
        self.assertEqual(resp.status_code, 201, resp.content)
        card = Card.objects.get()
        self.assertEqual(card.title, "A")

    def test_header_aliases_are_normalized(self):
        resp = self.post_csv(
            "title , COLUMN,Swimlane,due_date,PRIORITY,weight,Labels,description\n"
            "T,A,B,2026-02-03,high,4,x,Desc\n"
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        card = Card.objects.get()
        self.assertEqual(
            (card.title, card.priority, card.weight, card.description),
            ("T", "high", 4, "Desc"),
        )
        self.assertEqual(card.due_date, datetime.date(2026, 2, 3))
        for alias in ("duedate", "due date", "Due Date"):
            Card.objects.all().delete()
            resp = self.post_csv(f"Title,Column,Swimlane,{alias}\nT,A,B,2026-04-05\n")
            self.assertEqual(
                Card.objects.get().due_date, datetime.date(2026, 4, 5), alias
            )

    def test_structure_order_and_defaults(self):
        resp = self.post_csv(
            "Title,Column,Swimlane,Labels\n"
            't1,Second,Lane2,"b, a"\n'
            "t2,First,Lane1,a\n"
            "t3,Second,Lane2,\n"
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        cols = list(Column.objects.order_by("position"))
        self.assertEqual(
            [(c.name, c.position, c.color, c.allow_card_creation) for c in cols],
            [("Second", 0, "#6B7280", True), ("First", 1, "#6B7280", False)],
        )
        sws = list(Swimlane.objects.order_by("position"))
        self.assertEqual(
            [(s.name, s.position, s.color) for s in sws],
            [("Lane2", 0, "#3B82F6"), ("Lane1", 1, "#3B82F6")],
        )
        labels = list(Label.objects.order_by("id"))
        self.assertEqual(
            [(lb.name, lb.color) for lb in labels], [("b", "#EAB308"), ("a", "#EAB308")]
        )
        board = Board.objects.get()
        self.assertEqual(board.description, "")
        self.assertEqual(board.name, "Imported: board")
        m = BoardMembership.objects.get(board=board)
        self.assertEqual((m.user, m.role), (self.user, Role.ADMIN))

    def test_card_defaults_and_fallbacks(self):
        self.post_csv(
            "Title,Column,Swimlane,Priority,Weight,Description\n"
            "  padded  ,A,B,Critical,abc, spaced \n"
            "ok,A,B,Urgent,3,\n"
        )
        first, second = Card.objects.order_by("id")
        self.assertEqual(first.title, "padded")
        self.assertEqual(first.priority, "medium")
        self.assertEqual(first.weight, 1)
        self.assertEqual(first.description, "spaced")
        self.assertIsNone(first.due_date)
        self.assertEqual((first.position, first.created_by), (0, self.user))
        self.assertEqual(second.priority, "urgent")
        self.assertEqual(second.weight, 3)

    def test_weight_and_label_activities(self):
        self.post_csv(
            'Title,Column,Swimlane,Weight,Labels\na,A,B,5,"x, y ,"\nb,A,B,1,\n'
        )
        acts = list(CardActivity.objects.order_by("id"))
        self.assertEqual(
            [(a.event_type, a.from_value, a.to_value, a.actor) for a in acts],
            [
                ("weight_change", "1", "5", self.user),
                ("label_change", "", "+x, y", self.user),
            ],
        )
        self.assertEqual(
            sorted(lb.name for lb in Card.objects.get(title="a").labels.all()),
            ["x", "y"],
        )

    def test_summary_and_skip_counts(self):
        resp = self.post_csv(
            'Title,Column,Swimlane,Labels\na,A,B,"x, y"\nb,A,B,x\n',
            options=json.dumps({"cards": False}),
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(
            resp.json()["import_summary"]["skipped"],
            {
                "cards": 2,
                "comments": 0,
                "checklist_items": 0,
                "label_refs": 3,
                "movements": 0,
                "activities": 0,
            },
        )
        self.assertEqual(Card.objects.count(), 0)
        self.assertEqual(Label.objects.count(), 2)

    def test_labels_off(self):
        resp = self.post_csv(
            'Title,Column,Swimlane,Labels\na,A,B,"x, y"\n',
            options=json.dumps({"labels": False}),
        )
        self.assertEqual(resp.json()["import_summary"]["skipped"]["label_refs"], 2)
        self.assertEqual(Label.objects.count(), 0)
        self.assertEqual(Card.objects.count(), 1)

    def test_explicit_name_and_filename_default(self):
        resp = self.post_csv(
            "Title,Column,Swimlane\na,A,B\n", name="Quarterly Plan.csv"
        )
        self.assertEqual(resp.json()["name"], "Imported: Quarterly Plan")
        resp = self.post_csv("Title,Column,Swimlane\na,A,B\n", name="x.csv")
        self.assertEqual(resp.json()["name"], "Imported: x")

    def test_board_created_event_payload_carries_import_options(self):
        resp = self.post_csv("Title,Column,Swimlane\na,A,B\n")
        event = BoardEvent.objects.get(board_id=resp.json()["id"])
        self.assertEqual(event.data["import_options"]["cards"], True)
        self.assertEqual(event.actor_id, self.user.id)


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------


class ExportBase(TestCase):
    def setUp(self):
        cache.clear()
        self.owner = User.objects.create_user(username="owner", password="x")
        self.board = Board.objects.create(
            name="Export Me", description="Desc", owner=self.owner
        )
        BoardMembership.objects.create(
            board=self.board, user=self.owner, role=Role.ADMIN
        )
        self.col = Column.objects.create(
            board=self.board,
            name="Todo",
            position=0,
            color="#111111",
            wip_limit=3,
            weight_limit=9,
            allow_card_creation=True,
            is_done=False,
        )
        self.col2 = Column.objects.create(
            board=self.board, name="Done", position=1, is_done=True
        )
        self.sw = Swimlane.objects.create(
            board=self.board,
            name="Lane",
            position=0,
            color="#222222",
            contact_email="lane@example.com",
            notes="secret notes",
        )
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def export(self, fmt="json", user=None, board=None):
        cache.clear()
        if user is not None:
            self.client.force_authenticate(user)
        board = board or self.board
        # ``?format=csv`` would hit DRF's renderer negotiation (404); CSV is the
        # no-parameter default, so it is requested by omitting the parameter.
        params = {"format": fmt} if fmt == "json" else {}
        return self.client.get(f"/api/v1/boards/{board.id}/export/", params)

    def member(self, role, username=None):
        u = User.objects.create_user(username=username or f"u_{role}", password="x")
        BoardMembership.objects.create(board=self.board, user=u, role=role)
        return u

    def make_card(self, title="Card", **kw):
        kw.setdefault("created_by", self.owner)
        kw.setdefault("position", 0)
        return Card.objects.create(
            board=self.board, column=self.col, swimlane=self.sw, title=title, **kw
        )


class ExportJsonShapeTests(ExportBase):
    def test_headers_and_envelope(self):
        resp = self.export("json")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp["Content-Type"], "application/json")
        self.assertEqual(resp["Cache-Control"], "no-store")
        today = datetime.date.today().isoformat()
        self.assertEqual(
            resp["Content-Disposition"],
            f'attachment; filename="export-me-{today}.json"',
        )
        body = resp.content.decode()
        # indent=2 and ensure_ascii=False are part of the file format.
        self.assertTrue(
            body.startswith('{\n  "schema_version": 2,\n  "name": "Export Me",'),
            body[:80],
        )

    def test_filename_falls_back_to_board_when_name_has_no_slug(self):
        self.board.name = "!!!"
        self.board.save()
        today = datetime.date.today().isoformat()
        self.assertEqual(
            self.export("json")["Content-Disposition"],
            f'attachment; filename="board-{today}.json"',
        )
        self.assertEqual(
            self.export("csv")["Content-Disposition"],
            f'attachment; filename="board-{today}.csv"',
        )

    def test_non_ascii_is_not_escaped(self):
        self.make_card("Café ☃")
        self.assertIn("Café ☃", self.export("json").content.decode("utf-8"))

    def test_top_level_keys_and_order(self):
        data = json.loads(self.export("json").content)
        self.assertEqual(
            list(data),
            [
                "schema_version",
                "name",
                "description",
                "columns",
                "swimlanes",
                "labels",
                "custom_fields",
                "swimlane_custom_fields",
                "cards",
            ],
        )
        self.assertEqual(data["schema_version"], 2)
        self.assertEqual((data["name"], data["description"]), ("Export Me", "Desc"))

    def test_column_swimlane_label_shapes_and_order(self):
        Column.objects.create(board=self.board, name="Mid", position=5)
        Label.objects.create(board=self.board, name="Bug", color="#FF0000")
        data = json.loads(self.export("json").content)
        self.assertEqual([c["name"] for c in data["columns"]], ["Todo", "Done", "Mid"])
        self.assertEqual(
            list(data["columns"][0]),
            [
                "name",
                "position",
                "color",
                "wip_limit",
                "weight_limit",
                "allow_card_creation",
                "is_done",
            ],
        )
        self.assertEqual(
            data["columns"][0],
            {
                "name": "Todo",
                "position": 0,
                "color": "#111111",
                "wip_limit": 3,
                "weight_limit": 9,
                "allow_card_creation": True,
                "is_done": False,
            },
        )
        self.assertEqual(data["columns"][1]["is_done"], True)
        self.assertEqual(data["columns"][1]["wip_limit"], None)
        self.assertEqual(
            list(data["swimlanes"][0]),
            [
                "name",
                "position",
                "color",
                "contact_email",
                "notes",
                "custom_field_values",
            ],
        )
        self.assertEqual(
            data["swimlanes"][0],
            {
                "name": "Lane",
                "position": 0,
                "color": "#222222",
                "contact_email": "lane@example.com",
                "notes": "secret notes",
                "custom_field_values": {},
            },
        )
        self.assertEqual(data["labels"], [{"name": "Bug", "color": "#FF0000"}])

    def test_swimlane_pii_visible_to_admin_only(self):
        for role, visible in (
            (Role.ADMIN, True),
            (Role.MEMBER, False),
            (Role.COLLABORATOR, False),
            (Role.VIEWER, False),
        ):
            with self.subTest(role=role):
                user = self.member(role)
                sw = json.loads(self.export("json", user=user).content)["swimlanes"][0]
                self.assertEqual("contact_email" in sw, visible)
                self.assertEqual("notes" in sw, visible)
                self.assertEqual(list(sw)[:3], ["name", "position", "color"])
                self.assertIn("custom_field_values", sw)

    def test_card_keys_values_and_order(self):
        assignee = User.objects.create_user(username="asg", password="x")
        label = Label.objects.create(board=self.board, name="Bug", color="#FF0000")
        card = self.make_card(
            "T",
            description="D",
            priority="high",
            assignee=assignee,
            weight=4,
            position=2,
            due_date=datetime.date(2026, 7, 8),
        )
        card.labels.add(label)
        data = json.loads(self.export("json").content)
        out = data["cards"][0]
        self.assertEqual(
            list(out),
            [
                "title",
                "description",
                "column",
                "swimlane",
                "priority",
                "assignee",
                "labels",
                "due_date",
                "weight",
                "position",
                "created_at",
                "created_by",
                "archived_at",
                "custom_field_values",
                "external_ref",
                "comments",
                "checklist",
                "movements",
                "activities",
            ],
        )
        self.assertEqual(
            {
                k: out[k]
                for k in (
                    "title",
                    "description",
                    "column",
                    "swimlane",
                    "priority",
                    "assignee",
                    "labels",
                    "due_date",
                    "weight",
                    "position",
                    "created_by",
                    "archived_at",
                    "custom_field_values",
                    "external_ref",
                )
            },
            {
                "title": "T",
                "description": "D",
                "column": "Todo",
                "swimlane": "Lane",
                "priority": "high",
                "assignee": "asg",
                "labels": ["Bug"],
                "due_date": "2026-07-08",
                "weight": 4,
                "position": 2,
                "created_by": "owner",
                "archived_at": None,
                "custom_field_values": {},
                "external_ref": None,
            },
        )
        card.refresh_from_db()
        self.assertEqual(out["created_at"], card.created_at.isoformat())

    def test_card_null_fields(self):
        self.make_card("T", created_by=None)
        out = json.loads(self.export("json").content)["cards"][0]
        self.assertIsNone(out["assignee"])
        self.assertIsNone(out["created_by"])
        self.assertIsNone(out["due_date"])
        self.assertEqual(out["labels"], [])

    def test_archived_card_is_exported_with_timestamp(self):
        stamp = datetime.datetime(2026, 1, 2, 3, 4, 5, tzinfo=datetime.timezone.utc)
        self.make_card("Old", archived_at=stamp)
        out = json.loads(self.export("json").content)["cards"][0]
        self.assertEqual(out["archived_at"], stamp.isoformat())

    def test_cards_ordered_by_position(self):
        self.make_card("third", position=2)
        self.make_card("first", position=0)
        self.make_card("second", position=1)
        titles = [c["title"] for c in json.loads(self.export("json").content)["cards"]]
        self.assertEqual(titles, ["first", "second", "third"])

    def test_nested_collections_shape_and_order(self):
        card = self.make_card("T")
        t0 = timezone.now() - datetime.timedelta(days=5)
        mover = User.objects.create_user(username="mover", password="x")
        # Created out of order on purpose: output must be sorted, not insertion-ordered.
        late = CardMovement.objects.create(
            card=card,
            from_column=self.col,
            to_column=self.col2,
            from_swimlane=self.sw,
            to_swimlane=self.sw,
            moved_by=mover,
            notes="later",
            movement_type="move",
        )
        early = CardMovement.objects.create(
            card=card,
            from_column=None,
            to_column=self.col,
            from_swimlane=None,
            to_swimlane=self.sw,
            moved_by=None,
            notes="first",
            movement_type="archived",
        )
        CardMovement.objects.filter(pk=early.pk).update(moved_at=t0)
        c_late = CardComment.objects.create(card=card, author=self.owner, body="b-late")
        c_early = CardComment.objects.create(card=card, author=None, body="a-early")
        CardComment.objects.filter(pk=c_early.pk).update(created_at=t0)
        CardChecklist.objects.create(
            card=card, text="second", is_checked=True, position=1
        )
        CardChecklist.objects.create(
            card=card, text="first", is_checked=False, position=0
        )
        a_late = CardActivity.objects.create(
            card=card,
            event_type="title_change",
            from_value="x",
            to_value="y",
            actor=self.owner,
        )
        a_early = CardActivity.objects.create(
            card=card,
            event_type="weight_change",
            from_value="1",
            to_value="3",
            actor=None,
        )
        CardActivity.objects.filter(pk=a_early.pk).update(created_at=t0)
        late.refresh_from_db()
        c_late.refresh_from_db()
        a_late.refresh_from_db()

        out = json.loads(self.export("json").content)["cards"][0]
        self.assertEqual(
            out["comments"],
            [
                {"author": None, "body": "a-early", "created_at": t0.isoformat()},
                {
                    "author": "owner",
                    "body": "b-late",
                    "created_at": c_late.created_at.isoformat(),
                },
            ],
        )
        self.assertEqual(list(out["comments"][0]), ["author", "body", "created_at"])
        self.assertEqual(
            out["checklist"],
            [
                {"text": "first", "is_checked": False},
                {"text": "second", "is_checked": True},
            ],
        )
        self.assertEqual(list(out["checklist"][0]), ["text", "is_checked"])
        self.assertEqual(
            out["movements"],
            [
                {
                    "from_column": None,
                    "to_column": "Todo",
                    "from_swimlane": None,
                    "to_swimlane": "Lane",
                    "moved_by": None,
                    "moved_at": t0.isoformat(),
                    "notes": "first",
                    "movement_type": "archived",
                },
                {
                    "from_column": "Todo",
                    "to_column": "Done",
                    "from_swimlane": "Lane",
                    "to_swimlane": "Lane",
                    "moved_by": "mover",
                    "moved_at": late.moved_at.isoformat(),
                    "notes": "later",
                    "movement_type": "move",
                },
            ],
        )
        self.assertEqual(
            list(out["movements"][0]),
            [
                "from_column",
                "to_column",
                "from_swimlane",
                "to_swimlane",
                "moved_by",
                "moved_at",
                "notes",
                "movement_type",
            ],
        )
        self.assertEqual(
            out["activities"],
            [
                {
                    "event_type": "weight_change",
                    "from_value": "1",
                    "to_value": "3",
                    "actor": None,
                    "created_at": t0.isoformat(),
                },
                {
                    "event_type": "title_change",
                    "from_value": "x",
                    "to_value": "y",
                    "actor": "owner",
                    "created_at": a_late.created_at.isoformat(),
                },
            ],
        )
        self.assertEqual(
            list(out["activities"][0]),
            [
                "event_type",
                "from_value",
                "to_value",
                "actor",
                "created_at",
            ],
        )

    def test_external_ref_exported(self):
        card = self.make_card("T")
        CardExternalRef.objects.create(
            card=card,
            provider="gitlab",
            ref="!7",
            url="https://gitlab.com/o/r/-/merge_requests/7",
        )
        out = json.loads(self.export("json").content)["cards"][0]
        self.assertEqual(
            out["external_ref"],
            {
                "provider": "gitlab",
                "ref": "!7",
                "url": "https://gitlab.com/o/r/-/merge_requests/7",
            },
        )
        self.assertEqual(list(out["external_ref"]), ["provider", "ref", "url"])

    def test_custom_field_schema_and_values(self):
        d1 = CustomFieldDefinition.objects.create(
            board=self.board,
            name="Stage",
            field_type="dropdown",
            choices_json=["Open", "Won"],
            position=1,
            show_on_card=True,
            is_required=True,
            help_text="h",
            choice_colors={"Open": "blue"},
        )
        d0 = CustomFieldDefinition.objects.create(
            board=self.board,
            name="Amount",
            field_type="number",
            position=0,
            number_prefix="$",
            number_suffix="k",
            number_decimals=2,
        )
        card = self.make_card("T")
        CustomFieldValue.objects.create(card=card, field_definition=d1, value="Open")
        CustomFieldValue.objects.create(card=card, field_definition=d0, value="12.50")
        sf = SwimlaneCustomFieldDefinition.objects.create(
            board=self.board,
            name="Owner",
            field_type="text",
            position=0,
            show_on_row=True,
            is_admin_only=False,
            help_text="who",
        )
        sf_admin = SwimlaneCustomFieldDefinition.objects.create(
            board=self.board,
            name="Secret",
            field_type="text",
            position=1,
            is_admin_only=True,
        )
        SwimlaneCustomFieldValue.objects.create(
            swimlane=self.sw, field_definition=sf, value="Avery"
        )
        SwimlaneCustomFieldValue.objects.create(
            swimlane=self.sw, field_definition=sf_admin, value="shh"
        )

        data = json.loads(self.export("json").content)
        self.assertEqual(
            [f["name"] for f in data["custom_fields"]], ["Amount", "Stage"]
        )
        self.assertEqual(
            list(data["custom_fields"][0]),
            [
                "name",
                "field_type",
                "choices",
                "position",
                "show_on_card",
                "is_required",
                "help_text",
                "number_prefix",
                "number_suffix",
                "number_decimals",
                "choice_colors",
            ],
        )
        self.assertEqual(
            data["custom_fields"][1],
            {
                "name": "Stage",
                "field_type": "dropdown",
                "choices": ["Open", "Won"],
                "position": 1,
                "show_on_card": True,
                "is_required": True,
                "help_text": "h",
                "number_prefix": "",
                "number_suffix": "",
                "number_decimals": None,
                "choice_colors": {"Open": "blue"},
            },
        )
        self.assertEqual(
            (
                data["custom_fields"][0]["number_prefix"],
                data["custom_fields"][0]["number_suffix"],
                data["custom_fields"][0]["number_decimals"],
            ),
            ("$", "k", 2),
        )
        self.assertEqual(
            data["cards"][0]["custom_field_values"],
            {"Stage": "Open", "Amount": "12.50"},
        )
        self.assertEqual(
            [f["name"] for f in data["swimlane_custom_fields"]], ["Owner", "Secret"]
        )
        self.assertEqual(
            list(data["swimlane_custom_fields"][0]),
            [
                "name",
                "field_type",
                "choices",
                "position",
                "show_on_row",
                "is_admin_only",
                "is_required",
                "help_text",
                "number_prefix",
                "number_suffix",
                "number_decimals",
                "choice_colors",
            ],
        )
        self.assertEqual(
            data["swimlanes"][0]["custom_field_values"],
            {"Owner": "Avery", "Secret": "shh"},
        )

        # A non-admin exporter gets neither the admin-only definition nor its value.
        viewer = self.member(Role.VIEWER)
        vdata = json.loads(self.export("json", user=viewer).content)
        self.assertEqual(
            [f["name"] for f in vdata["swimlane_custom_fields"]], ["Owner"]
        )
        self.assertEqual(
            vdata["swimlanes"][0]["custom_field_values"], {"Owner": "Avery"}
        )

    def test_no_format_parameter_means_csv(self):
        self.assertEqual(self.export(None)["Content-Type"], "text/csv")


class ExportAuditLogTests(ExportBase):
    def test_owner_row_json_and_csv(self):
        self.make_card("a")
        self.make_card("b")
        self.export("json")
        self.export("csv")
        rows = list(BoardExportLog.objects.order_by("id"))
        self.assertEqual(
            [
                (r.export_format, r.row_count, r.role_at_export, r.actor, r.board)
                for r in rows
            ],
            [
                ("json", 2, "owner", self.owner, self.board),
                ("csv", 2, "owner", self.owner, self.board),
            ],
        )

    def test_role_strings_and_failed_exports_are_not_logged(self):
        admin = self.member(Role.ADMIN)
        viewer = self.member(Role.VIEWER)
        self.export("json", user=admin)
        self.export("csv", user=viewer)
        self.assertEqual(
            list(
                BoardExportLog.objects.order_by("id").values_list(
                    "role_at_export", flat=True
                )
            ),
            ["admin", "viewer"],
        )
        outsider = User.objects.create_user(username="outsider", password="x")
        before = BoardExportLog.objects.count()
        self.assertEqual(self.export("json", user=outsider).status_code, 403)
        self.assertEqual(BoardExportLog.objects.count(), before)

    def test_site_admin_is_logged_as_site_admin(self):
        site_admin = User.objects.create_user(
            username="sa", password="x", is_staff=True, is_superuser=True
        )
        resp = self.export("json", user=site_admin)
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(BoardExportLog.objects.get().role_at_export, "site_admin")

    def test_restricted_response_body_is_exact(self):
        self.board.export_min_role = "admin"
        self.board.save()
        member = self.member(Role.MEMBER)
        resp = self.export("json", user=member)
        self.assertEqual(resp.status_code, 403)
        self.assertEqual(
            resp.json(),
            {
                "detail": "Export is restricted on this board.",
                "code": "export_restricted",
                "min_role": "admin",
            },
        )
        self.assertFalse(BoardExportLog.objects.exists())

    def test_restricted_min_role_defaults_to_viewer_when_blank(self):
        # A blank threshold means "everyone"; the body would report "viewer" if it ever fired.
        self.board.export_min_role = ""
        self.board.save()
        viewer = self.member(Role.VIEWER)
        self.assertEqual(self.export("json", user=viewer).status_code, 200)

    def test_threshold_boundary_is_inclusive(self):
        self.board.export_min_role = "member"
        self.board.save()
        member = self.member(Role.MEMBER)
        collab = self.member(Role.COLLABORATOR)
        self.assertEqual(self.export("json", user=member).status_code, 200)
        resp = self.export("json", user=collab)
        self.assertEqual(resp.status_code, 403)
        self.assertEqual(resp.json()["min_role"], "member")


class ExportHistoryEndpointTests(ExportBase):
    def test_admin_sees_rows_newest_first_with_exact_fields(self):
        self.export("json")
        self.export("csv")
        resp = self.client.get(f"/api/v1/boards/{self.board.id}/export-history/")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["count"], 2)
        first, second = body["results"]
        self.assertEqual(
            list(first),
            [
                "id",
                "actor",
                "actor_role_label",
                "export_format",
                "row_count",
                "created_at",
            ],
        )
        self.assertEqual(
            (first["export_format"], second["export_format"]), ("csv", "json")
        )
        self.assertEqual(first["actor_role_label"], "owner")
        self.assertEqual(first["actor"]["username"], "owner")
        self.assertEqual(first["row_count"], 0)

    def test_non_admin_is_forbidden_with_exact_body(self):
        for role in (Role.MEMBER, Role.COLLABORATOR, Role.VIEWER):
            with self.subTest(role=role):
                user = self.member(role)
                self.client.force_authenticate(user)
                resp = self.client.get(
                    f"/api/v1/boards/{self.board.id}/export-history/"
                )
                self.assertEqual(resp.status_code, 403)
                self.assertEqual(
                    resp.json(),
                    {"detail": "Export history is restricted to board admins."},
                )

    def test_site_admin_may_read(self):
        sa = User.objects.create_user(
            username="sa", password="x", is_staff=True, is_superuser=True
        )
        self.client.force_authenticate(sa)
        resp = self.client.get(f"/api/v1/boards/{self.board.id}/export-history/")
        self.assertEqual(resp.status_code, 200)


class ExportCsvShapeTests(ExportBase):
    HEADER = [
        "Card ID",
        "Title",
        "Description",
        "Column",
        "Swimlane",
        "Priority",
        "Assignee",
        "Labels",
        "Due Date",
        "Weight",
        "Created At",
        "Created By",
        "Last Moved At",
        "Movement Count",
        "Movement History",
    ]

    def rows(self, **kw):
        return list(csv.reader(io.StringIO(self.export("csv", **kw).content.decode())))

    def test_header_row_without_cards(self):
        self.assertEqual(self.rows(), [self.HEADER])

    def test_data_row_is_exact(self):
        assignee = User.objects.create_user(username="asg", password="x")
        a = Label.objects.create(board=self.board, name="A", color="#111111")
        b = Label.objects.create(board=self.board, name="B", color="#222222")
        card = self.make_card(
            "T",
            description="D",
            priority="high",
            assignee=assignee,
            weight=4,
            due_date=datetime.date(2026, 7, 8),
        )
        card.labels.add(a, b)
        t1 = timezone.now() - datetime.timedelta(days=3)
        t2 = timezone.now() - datetime.timedelta(days=1)
        m2 = CardMovement.objects.create(
            card=card,
            from_column=self.col,
            to_column=self.col2,
            from_swimlane=self.sw,
            to_swimlane=self.sw,
            moved_by=self.owner,
        )
        m1 = CardMovement.objects.create(
            card=card,
            from_column=None,
            to_column=self.col,
            from_swimlane=None,
            to_swimlane=self.sw,
            moved_by=None,
        )
        CardMovement.objects.filter(pk=m1.pk).update(moved_at=t1)
        CardMovement.objects.filter(pk=m2.pk).update(moved_at=t2)
        card.refresh_from_db()
        rows = self.rows()
        self.assertEqual(rows[0], self.HEADER)
        self.assertEqual(
            rows[1],
            [
                str(card.id),
                "T",
                "D",
                "Todo",
                "Lane",
                "high",
                "asg",
                "A, B",
                "2026-07-08",
                "4",
                card.created_at.isoformat(),
                "owner",
                t2.isoformat(),
                "2",
                f"{t1.isoformat()}||Todo|; {t2.isoformat()}|Todo|Done|owner",
            ],
        )

    def test_empty_optional_cells(self):
        card = self.make_card("T", created_by=None)
        row = self.rows()[1]
        self.assertEqual(row[6], "")  # assignee
        self.assertEqual(row[7], "")  # labels
        self.assertEqual(row[8], "")  # due date
        self.assertEqual(row[11], "")  # created by
        self.assertEqual(row[12], "")  # last moved
        self.assertEqual(row[13], "0")
        self.assertEqual(row[14], "")
        self.assertEqual(row[0], str(card.id))

    def test_formula_prefixes_are_stripped_everywhere(self):
        user = User.objects.create_user(username="=evil", password="x")
        label = Label.objects.create(board=self.board, name="@lab", color="#111111")
        self.col.name = "+Col"
        self.col.save()
        self.sw.name = "-Lane"
        self.sw.save()
        card = self.make_card("=SUM(A1)", description="@cmd", assignee=user)
        card.labels.add(label)
        CardMovement.objects.create(
            card=card,
            from_column=self.col,
            to_column=self.col,
            from_swimlane=self.sw,
            to_swimlane=self.sw,
            moved_by=user,
        )
        row = self.rows()[1]
        self.assertEqual(row[1:5], ["SUM(A1)", "cmd", "Col", "Lane"])
        self.assertEqual(row[6], "evil")
        self.assertEqual(row[7], "lab")
        self.assertTrue(row[14].endswith("|Col|Col|evil"), row[14])

    def test_custom_field_columns_follow_the_fixed_ones(self):
        d_text = CustomFieldDefinition.objects.create(
            board=self.board, name="Note", field_type="text", position=1
        )
        d_multi = CustomFieldDefinition.objects.create(
            board=self.board,
            name="Areas",
            field_type="multi_select",
            choices_json=["UI", "API"],
            position=0,
        )
        sf = SwimlaneCustomFieldDefinition.objects.create(
            board=self.board,
            name="Owner",
            field_type="text",
            position=0,
            is_admin_only=False,
        )
        sf_admin = SwimlaneCustomFieldDefinition.objects.create(
            board=self.board,
            name="Secret",
            field_type="text",
            position=1,
            is_admin_only=True,
        )
        card = self.make_card("T")
        CustomFieldValue.objects.create(
            card=card, field_definition=d_text, value="=1+1"
        )
        CustomFieldValue.objects.create(
            card=card, field_definition=d_multi, value='["UI", "API"]'
        )
        SwimlaneCustomFieldValue.objects.create(
            swimlane=self.sw, field_definition=sf, value="Avery"
        )
        SwimlaneCustomFieldValue.objects.create(
            swimlane=self.sw, field_definition=sf_admin, value="shh"
        )
        rows = self.rows()
        self.assertEqual(
            rows[0][15:],
            [
                "Custom: Areas",
                "Custom: Note",
                "Swimlane Custom: Owner",
                "Swimlane Custom: Secret",
            ],
        )
        self.assertEqual(rows[1][15:], ["UI; API", "1+1", "Avery", "shh"])
        viewer = self.member(Role.VIEWER)
        vrows = self.rows(user=viewer)
        self.assertEqual(
            vrows[0][15:], ["Custom: Areas", "Custom: Note", "Swimlane Custom: Owner"]
        )
        self.assertEqual(vrows[1][15:], ["UI; API", "1+1", "Avery"])

    def test_missing_custom_value_is_an_empty_cell(self):
        CustomFieldDefinition.objects.create(
            board=self.board, name="Note", field_type="text"
        )
        SwimlaneCustomFieldDefinition.objects.create(
            board=self.board, name="Owner", field_type="text"
        )
        self.make_card("T")
        self.assertEqual(self.rows()[1][15:], ["", ""])


class ExportHelperUnitTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="o", password="x")
        self.other = User.objects.create_user(username="p", password="x")
        self.board = Board.objects.create(name="B", owner=self.owner)

    def test_role_at_export(self):
        self.assertEqual(
            _role_at_export(self.board, self.owner, SITE_ADMIN), "site_admin"
        )
        self.assertEqual(_role_at_export(self.board, self.owner, Role.ADMIN), "owner")
        self.assertEqual(
            _role_at_export(self.board, self.other, Role.ADMIN), Role.ADMIN
        )
        self.assertEqual(_role_at_export(self.board, self.other, Role.VIEWER), "viewer")

    def test_can_export_at_min_role(self):
        b = self.board
        self.assertTrue(_can_export_at_min_role(b, self.other, SITE_ADMIN))
        self.assertTrue(_can_export_at_min_role(b, self.owner, Role.VIEWER))
        b.export_min_role = "admin"
        self.assertTrue(_can_export_at_min_role(b, self.owner, Role.VIEWER))
        self.assertTrue(_can_export_at_min_role(b, self.other, SITE_ADMIN))
        self.assertTrue(_can_export_at_min_role(b, self.other, Role.ADMIN))
        self.assertFalse(_can_export_at_min_role(b, self.other, Role.MEMBER))
        b.export_min_role = "collaborator"
        self.assertTrue(_can_export_at_min_role(b, self.other, Role.COLLABORATOR))
        self.assertFalse(_can_export_at_min_role(b, self.other, Role.VIEWER))
        # Unknown threshold falls back to the most permissive rank.
        b.export_min_role = "typo"
        self.assertTrue(_can_export_at_min_role(b, self.other, Role.VIEWER))
        b.export_min_role = ""
        self.assertTrue(_can_export_at_min_role(b, self.other, Role.VIEWER))
        # An unranked role (not a member role) never passes.
        self.assertFalse(_can_export_at_min_role(b, self.other, "stranger"))
        self.assertFalse(_can_export_at_min_role(b, self.other, None))

    def test_sanitize_csv_field(self):
        self.assertEqual(_sanitize_csv_field("=+-@\t\rx=y"), "x=y")
        self.assertEqual(_sanitize_csv_field("plain"), "plain")
        self.assertEqual(_sanitize_csv_field(""), "")
        self.assertEqual(_sanitize_csv_field(5), 5)
        self.assertIsNone(_sanitize_csv_field(None))

    def test_csv_custom_field_cell(self):
        multi = CustomFieldDefinition(name="m", field_type="multi_select")
        text = CustomFieldDefinition(name="t", field_type="text")
        self.assertEqual(_csv_custom_field_cell(multi, '["a", "=b"]'), "a; b")
        self.assertEqual(_csv_custom_field_cell(multi, ""), "")
        self.assertEqual(_csv_custom_field_cell(text, "=x"), "x")
        self.assertEqual(_csv_custom_field_cell(text, '["a"]'), '["a"]')


# ---------------------------------------------------------------------------
# Round trip: what the exporter writes the importer must read back
# ---------------------------------------------------------------------------


class ExportImportRoundTripTests(ExportBase):
    def test_history_survives_a_round_trip(self):
        card = self.make_card("T", weight=3)
        t0 = timezone.now().replace(microsecond=0) - datetime.timedelta(days=2)
        mv = CardMovement.objects.create(
            card=card,
            from_column=self.col,
            to_column=self.col2,
            from_swimlane=self.sw,
            to_swimlane=self.sw,
            moved_by=self.owner,
            notes="shipped",
            movement_type="move",
        )
        CardMovement.objects.filter(pk=mv.pk).update(moved_at=t0)
        exported = self.export("json").content
        cache.clear()
        resp = self.client.post(
            IMPORT_URL,
            {
                "file": SimpleUploadedFile(
                    "x.json", exported, content_type="application/json"
                )
            },
            format="multipart",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        new_board = Board.objects.get(pk=resp.json()["id"])
        imported = CardMovement.objects.get(card__board=new_board)
        self.assertEqual(imported.moved_at, t0)
        self.assertEqual(
            (imported.from_column_name, imported.to_column_name), ("Todo", "Done")
        )
        self.assertEqual(
            (imported.notes, imported.movement_type, imported.moved_by),
            ("shipped", "move", self.owner),
        )
        # Re-export must keep the key set stable across the trip.
        again = json.loads(self.export("json", board=new_board).content)
        original = json.loads(exported)
        self.assertEqual(list(again), list(original))
        self.assertEqual(list(again["cards"][0]), list(original["cards"][0]))
        self.assertEqual(
            again["cards"][0]["movements"], original["cards"][0]["movements"]
        )


# ---------------------------------------------------------------------------
# import_trello: the view's own paths (parsing/mapping live in services/)
# ---------------------------------------------------------------------------


def _trello_export(**overrides):
    data = {
        "id": "b1",
        "name": "Trello Board",
        "desc": "",
        "closed": False,
        "lists": [{"id": "l1", "name": "Todo", "closed": False, "pos": 1}],
        "cards": [
            {
                "id": "c1",
                "name": "A card",
                "desc": "",
                "idList": "l1",
                "closed": False,
                "pos": 1,
                "idLabels": [],
                "idMembers": [],
                "idChecklists": [],
            }
        ],
        "labels": [],
        "checklists": [],
        "members": [],
        "actions": [],
    }
    data.update(overrides)
    return data


class TrelloViewTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(username="importer", password="x")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def post(self, query="dry_run=true", data=None, **extra):
        raw = (
            data
            if isinstance(data, bytes)
            else json.dumps(_trello_export() if data is None else data).encode()
        )
        payload = {
            "file": SimpleUploadedFile("t.json", raw, content_type="application/json")
        }
        payload.update(extra)
        return self.client.post(
            f"{TRELLO_URL}?{query}" if query else TRELLO_URL,
            payload,
            format="multipart",
        )

    def test_mode_flags_must_be_exactly_one(self):
        expected = {"detail": "Specify exactly one of ?dry_run=true or ?confirm=true."}
        for query in (
            "",
            "dry_run=true&confirm=true",
            "dry_run=false",
            "confirm=0",
            "dry_run=nope",
        ):
            with self.subTest(query=query):
                resp = self.post(query)
                self.assertEqual(resp.status_code, 400)
                self.assertEqual(resp.json(), expected)

    def test_flag_spellings(self):
        for query in ("dry_run=1", "dry_run=TRUE", "dry_run=True"):
            with self.subTest(query=query):
                self.assertEqual(self.post(query).status_code, 200)

    def test_no_file(self):
        resp = self.client.post(f"{TRELLO_URL}?dry_run=true", {}, format="multipart")
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json(), {"detail": "No file provided."})

    @override_settings(VISIBAN_IMPORT_MAX_SIZE=1024 * 1024)
    def test_oversize_is_413_with_mb_in_message_and_boundary_is_inclusive(self):
        over = self.post(data=b"x" * (1024 * 1024 + 1))
        self.assertEqual(over.status_code, 413)
        self.assertEqual(
            over.json(),
            {"detail": "File too large. The maximum size for a Trello import is 1 MB."},
        )
        # Exactly at the cap is not a size error (it fails later, as invalid JSON).
        at = self.post(data=b"x" * (1024 * 1024))
        self.assertEqual(at.status_code, 400)
        self.assertNotIn("too large", at.json()["detail"])

    def test_preview_shape(self):
        resp = self.post()
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        self.assertEqual(body["source"], "trello")
        self.assertEqual(len(body["file_sha256"]), 64)
        self.assertEqual(Board.objects.count(), 0)

    def test_sha_guard_mismatch_blocks_confirm_but_not_preview(self):
        mismatch = self.post("confirm=true", file_sha256="0" * 64)
        self.assertEqual(mismatch.status_code, 400)
        self.assertEqual(
            mismatch.json(),
            {
                "detail": "The uploaded file does not match the file that was previewed. Preview it again.",
            },
        )
        self.assertEqual(Board.objects.count(), 0)
        # dry_run never consults the guard.
        self.assertEqual(
            self.post("dry_run=true", file_sha256="0" * 64).status_code, 200
        )

    def test_sha_guard_match_and_blank_are_accepted(self):
        sha = self.post().json()["file_sha256"]
        cache.clear()
        self.assertEqual(self.post("confirm=true", file_sha256=sha).status_code, 201)
        cache.clear()
        self.assertEqual(self.post("confirm=true", file_sha256="").status_code, 201)

    def test_unparseable_file_is_a_400_with_the_service_detail(self):
        resp = self.post(data=b"not json at all")
        self.assertEqual(resp.status_code, 400)
        self.assertTrue(resp.json()["detail"])
        self.assertEqual(set(resp.json()), {"detail"})

    def test_confirm_creates_board_and_returns_board_and_summary(self):
        resp = self.post("confirm=true")
        self.assertEqual(resp.status_code, 201, resp.content)
        body = resp.json()
        self.assertEqual(set(body), {"board", "summary"})
        self.assertEqual(
            set(body["summary"]), {"counts", "result", "warnings", "unmappable"}
        )
        self.assertEqual(body["board"]["name"], "Trello Board")
        self.assertEqual(Board.objects.get().owner, self.user)
        self.assertEqual(Card.objects.count(), 1)
        self.assertEqual(body["board"]["card_count"], 1)
        self.assertEqual(body["board"]["member_count"], 1)
        event = BoardEvent.objects.get(board_id=body["board"]["id"])
        self.assertEqual(event.event, "board.created")
        self.assertEqual(event.actor_id, self.user.id)

    def test_confirm_name_override_is_stripped_and_nul_removed(self):
        resp = self.post("confirm=true", name="  My\x00 Board  ")
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(resp.json()["board"]["name"], "My Board")

    def test_blank_name_falls_back_to_the_trello_name(self):
        resp = self.post("confirm=true", name="   ")
        self.assertEqual(resp.json()["board"]["name"], "Trello Board")

    def test_group_membership_is_enforced_in_both_modes(self):
        owner = User.objects.create_user(username="gowner", password="x")
        group = Group.objects.create(name="G", owner=owner)
        for query in ("dry_run=true", "confirm=true"):
            with self.subTest(query=query):
                cache.clear()
                resp = self.post(query, group_id=str(group.pk))
                self.assertEqual(resp.status_code, 403)
                self.assertEqual(
                    resp.json(), {"detail": "You are not a member of the target group."}
                )
        GroupMembership.objects.create(group=group, user=self.user)
        cache.clear()
        resp = self.post("confirm=true", group_id=str(group.pk))
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(Board.objects.get().group, group)

    def test_dry_run_uses_the_looser_preview_scope(self):
        from boards.views.import_export import TrelloImportThrottle
        from rest_framework.test import APIRequestFactory
        from rest_framework.request import Request

        factory = APIRequestFactory()
        throttle = TrelloImportThrottle()
        throttle.allow_request(Request(factory.post("/x/?confirm=true")), None)
        self.assertEqual(throttle.scope, "board_import")
        throttle = TrelloImportThrottle()
        throttle.allow_request(Request(factory.post("/x/?dry_run=true")), None)
        self.assertEqual(throttle.scope, "board_import_preview")


# ---------------------------------------------------------------------------
# _imported_board_name (default name of an imported board, #1446)
# ---------------------------------------------------------------------------


class ImportedBoardNameUnitTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="namer", password="x")
        self.max = Board._meta.get_field("name").max_length

    def _board(self, name, group=None, owner=None):
        board = Board.objects.create(name=name, owner=owner or self.user, group=group)
        BoardMembership.objects.create(
            board=board, user=owner or self.user, role=Role.ADMIN
        )
        return board

    def test_prefix_and_cleaning(self):
        name = _imported_board_name
        self.assertEqual(name("Roadmap", self.user, None), "Imported: Roadmap")
        self.assertEqual(name("  padded  ", self.user, None), "Imported: padded")
        self.assertEqual(name("a\x00b", self.user, None), "Imported: ab")
        self.assertEqual(name("a\nb\tc", self.user, None), "Imported: a b c")
        self.assertEqual(name("a\n\n\nb", self.user, None), "Imported: a b")

    def test_empty_or_non_string_falls_back_to_board(self):
        for bad in ("", "   ", "\x00", "\n", None, 7, ["x"]):
            with self.subTest(bad=bad):
                self.assertEqual(
                    _imported_board_name(bad, self.user, None), "Imported: Board"
                )

    def test_long_name_is_truncated_to_the_column_length(self):
        out = _imported_board_name("x" * 500, self.user, None)
        self.assertEqual(len(out), self.max)
        self.assertTrue(out.startswith("Imported: xxx"))

    def test_lowest_unused_suffix_fills_gaps(self):
        self._board("Imported: Plan")
        self.assertEqual(
            _imported_board_name("Plan", self.user, None), "Imported: Plan - 1"
        )
        self._board("Imported: Plan - 1")
        self.assertEqual(
            _imported_board_name("Plan", self.user, None), "Imported: Plan - 2"
        )
        self._board("Imported: Plan - 3")
        self.assertEqual(
            _imported_board_name("Plan", self.user, None), "Imported: Plan - 2"
        )

    def test_suffix_respects_max_length_for_a_full_length_name(self):
        base = ("Imported: " + "y" * 500)[: self.max]
        self._board(base)
        out = _imported_board_name("y" * 500, self.user, None)
        self.assertEqual(len(out), self.max)
        self.assertTrue(out.endswith(" - 1"))
        self.assertNotEqual(out, base)

    def test_ungrouped_scope_is_the_callers_accessible_ungrouped_boards(self):
        other = User.objects.create_user(username="someone", password="x")
        self._board("Imported: Plan", owner=other)  # not accessible to self.user
        self.assertEqual(
            _imported_board_name("Plan", self.user, None), "Imported: Plan"
        )
        group = Group.objects.create(name="G", owner=self.user)
        self._board(
            "Imported: Plan", group=group
        )  # grouped boards do not collide with ungrouped
        self.assertEqual(
            _imported_board_name("Plan", self.user, None), "Imported: Plan"
        )

    def test_group_scope_counts_every_board_in_the_group(self):
        group = Group.objects.create(name="G", owner=self.user)
        other = User.objects.create_user(username="someone", password="x")
        self._board("Imported: Plan", group=group, owner=other)
        self.assertEqual(
            _imported_board_name("Plan", self.user, group), "Imported: Plan - 1"
        )
        other_group = Group.objects.create(name="H", owner=self.user)
        self.assertEqual(
            _imported_board_name("Plan", self.user, other_group), "Imported: Plan"
        )


# ---------------------------------------------------------------------------
# #1484: the ``_import_csv`` tail, ``export`` and ``export_history`` survivors
# of the 2026-10-06 re-measure
# ---------------------------------------------------------------------------

_MINIMAL_CSV = "Title,Column,Swimlane\nA,To Do,Lane\nB,To Do,Lane\nC,Done,Lane\n"


class ImportCsvTailGapTests(ImportBase):
    def test_lowercase_labels_header_is_normalized(self):
        resp = self.post_csv("title,column,swimlane,labels\nA,To Do,Lane,bug\n")
        self.assertEqual(resp.status_code, 201, resp.content)
        board = Board.objects.get()
        self.assertEqual(list(board.labels.values_list("name", flat=True)), ["bug"])
        self.assertEqual(
            list(Card.objects.get().labels.values_list("name", flat=True)), ["bug"]
        )

    def test_optional_columns_absent_use_empty_defaults(self):
        resp = self.post_csv(_MINIMAL_CSV)
        self.assertEqual(resp.status_code, 201, resp.content)
        card = Card.objects.get(title="A")
        self.assertEqual(card.description, "")
        self.assertEqual(card.priority, "medium")
        self.assertEqual(card.weight, 1)
        self.assertIsNone(card.assignee)
        self.assertEqual(Label.objects.count(), 0)
        self.assertEqual(CardActivity.objects.count(), 0)

    def test_absent_labels_column_counts_no_skipped_label_refs(self):
        resp = self.post_csv(_MINIMAL_CSV, options=json.dumps({"labels": False}))
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(resp.json()["import_summary"]["skipped"]["label_refs"], 0)

    def test_duplicate_label_in_one_cell_attaches_once(self):
        resp = self.post_csv(
            "Title,Column,Swimlane,Labels\nA,To Do,Lane,\"bug, bug\"\n"
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(Card.objects.get().labels.count(), 1)

    def test_response_counts_reflect_the_imported_board(self):
        resp = self.post_csv(_MINIMAL_CSV)
        self.assertEqual(resp.status_code, 201, resp.content)
        body = resp.json()
        self.assertEqual(body["member_count"], 1)
        self.assertEqual(body["card_count"], 3)
        self.assertEqual(body["archived_card_count"], 0)

    def test_csv_into_group_sets_group_expands_and_broadcasts_to_group(self):
        group = Group.objects.create(name="G", owner=self.user)
        with mock.patch(
            "boards.views.import_export._broadcast.broadcast_board_event"
        ), mock.patch("groups.broadcast.broadcast_group_event") as group_event:
            with self.captureOnCommitCallbacks(execute=True):
                cache.clear()
                resp = self.client.post(
                    IMPORT_URL + "?expand=group",
                    {"file": _csv_upload(_MINIMAL_CSV), "group_id": group.pk},
                    format="multipart",
                )
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(Board.objects.get().group, group)
        self.assertEqual(resp.json()["group_detail"]["id"], group.pk)
        self.assertEqual(group_event.call_count, 1)
        self.assertEqual(group_event.call_args.args[0], group.pk)

    def test_csv_without_group_does_not_broadcast_to_a_group(self):
        with mock.patch(
            "boards.views.import_export._broadcast.broadcast_board_event"
        ), mock.patch("groups.broadcast.broadcast_group_event") as group_event:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.post_csv(_MINIMAL_CSV)
        self.assertEqual(resp.status_code, 201, resp.content)
        group_event.assert_not_called()


class ExportGapTests(ExportBase):
    def test_csv_history_cell_for_a_movement_with_no_destination_column(self):
        card = self.make_card("T")
        when = timezone.now() - datetime.timedelta(days=2)
        mv = CardMovement.objects.create(
            card=card,
            from_column=self.col,
            to_column=None,
            from_swimlane=self.sw,
            to_swimlane=self.sw,
            moved_by=self.owner,
        )
        CardMovement.objects.filter(pk=mv.pk).update(moved_at=when)
        rows = list(
            csv.reader(io.StringIO(self.export("csv").content.decode()))
        )
        history_idx = rows[0].index("Movement History")
        self.assertEqual(rows[1][history_idx], f"{when.isoformat()}|Todo||owner")


class ExportHistoryGapTests(ExportBase):
    def test_unpaginated_fallback_returns_a_bare_list_newest_first(self):
        self.export("json")
        self.export("csv")
        self.client.force_authenticate(self.owner)
        with mock.patch(
            "boards.views.boards.BoardViewSet.paginate_queryset", return_value=None
        ):
            resp = self.client.get(f"/api/v1/boards/{self.board.id}/export-history/")
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        self.assertIsInstance(body, list)
        self.assertEqual([r["export_format"] for r in body], ["csv", "json"])
        self.assertEqual(body[0]["actor"]["username"], "owner")

    def test_openapi_operation_documents_the_endpoint(self):
        from drf_spectacular.generators import SchemaGenerator

        schema = SchemaGenerator().get_schema(request=None, public=True)
        op = schema["paths"]["/api/v1/boards/{id}/export-history/"]["get"]
        self.assertEqual(op["summary"], "Board export history")
        self.assertEqual(
            op["description"],
            "Admin only. Recent export audit log entries for this board, newest first.",
        )
