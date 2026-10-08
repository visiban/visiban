"""Assertions for the head of ``boards/views/import_export.py`` (#1502).

The #1453 / #1484 passes took ``_import_csv``, ``export`` and ``export_history``
above 90% mutation kill rate; the head (module helpers, ``import_board``,
``_import_json``, ``import_trello``) stayed lower. The survivors were mostly
missing assertions on helper return values, option parsing and OpenAPI text.
Each test here pins a value a caller or a client can observe. Survivors that
cannot be observed are classified as equivalent in
``docs/development/mutation-testing.md`` instead of being tested.
"""

import json

from django.core.cache import cache
from django.test import TestCase
from rest_framework.request import Request
from rest_framework.test import APIRequestFactory

from accounts.models import User
from boards.models import Board, CustomFieldDefinition
from boards.serializers import CSVImportOptionsSerializer, ImportOptionsSerializer
from boards.views.import_export import (
    BoardExportThrottle,
    BoardImportThrottle,
    TrelloImportThrottle,
    _cell,
    _is_truthy_non_string,
    _import_field_values,
    _json_skip_counts,
    _list_len,
    _parse_import_options,
    _query_flag,
    _sanitize_csv_field,
)

ALL_ON = {key: True for key in ImportOptionsSerializer.OPTION_KEYS}


class ThrottleScopeTests(TestCase):
    def setUp(self):
        cache.clear()

    def test_scopes_and_rates(self):
        from django.conf import settings

        self.assertEqual(BoardImportThrottle.scope, "board_import")
        self.assertEqual(BoardExportThrottle.scope, "board_export")
        self.assertEqual(TrelloImportThrottle.scope, "board_import_preview")
        rates = settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]
        # The test settings raise the numeric rates; the scope names must still
        # resolve to a configured rate or DRF raises ImproperlyConfigured.
        for scope in ("board_import", "board_export", "board_import_preview"):
            self.assertIn(scope, rates)

    def test_trello_throttle_picks_scope_and_rate_from_mode(self):
        factory = APIRequestFactory()
        throttle = TrelloImportThrottle()
        throttle.allow_request(Request(factory.post("/x/?confirm=true")), None)
        self.assertEqual(throttle.scope, "board_import")
        self.assertEqual(throttle.rate, throttle.THROTTLE_RATES["board_import"])
        throttle = TrelloImportThrottle()
        throttle.allow_request(Request(factory.post("/x/?dry_run=true")), None)
        self.assertEqual(throttle.scope, "board_import_preview")
        self.assertEqual(throttle.rate, throttle.THROTTLE_RATES["board_import_preview"])


class QueryFlagAndCellTests(TestCase):
    def _request(self, query):
        return Request(APIRequestFactory().post(f"/x/{query}"))

    def test_query_flag_accepts_true_and_one_case_insensitively(self):
        for value in ("true", "TRUE", "True", "1"):
            with self.subTest(value=value):
                self.assertTrue(_query_flag(self._request(f"?f={value}"), "f"))
        for value in ("false", "0", "yes", "", "2"):
            with self.subTest(value=value):
                self.assertFalse(_query_flag(self._request(f"?f={value}"), "f"))
        self.assertFalse(_query_flag(self._request(""), "f"))

    def test_cell_strips_and_treats_missing_as_empty(self):
        self.assertEqual(_cell({"a": "  x  "}, "a"), "x")
        self.assertEqual(_cell({"a": None}, "a"), "")
        self.assertEqual(_cell({}, "a"), "")
        self.assertEqual(_cell({"a": ""}, "a"), "")

    def test_is_truthy_non_string(self):
        self.assertTrue(_is_truthy_non_string(5))
        self.assertTrue(_is_truthy_non_string(["x"]))
        self.assertTrue(_is_truthy_non_string({"k": 1}))
        self.assertTrue(_is_truthy_non_string(True))
        for value in ("x", "", None, 0, False, [], {}):
            with self.subTest(value=value):
                self.assertFalse(_is_truthy_non_string(value))


class ParseImportOptionsTests(TestCase):
    def test_absent_or_blank_means_every_flag_on(self):
        for raw in (None, "", "   ", "\n"):
            with self.subTest(raw=raw):
                self.assertEqual(
                    _parse_import_options(raw, ImportOptionsSerializer), (ALL_ON, None)
                )

    def test_csv_serializer_defaults_cover_the_same_keys(self):
        options, error = _parse_import_options(None, CSVImportOptionsSerializer)
        self.assertIsNone(error)
        self.assertEqual(options, ALL_ON)

    def test_non_string_raw_value_is_rejected(self):
        # A multipart ``options`` part that is a file upload arrives as a
        # non-string; the view must not try to json.loads it.
        for raw in (123, ["{}"], {"cards": True}, b"{}"):
            with self.subTest(raw=raw):
                self.assertEqual(
                    _parse_import_options(raw, ImportOptionsSerializer),
                    (None, "'options' must be a JSON object."),
                )

    def test_invalid_json_and_non_object(self):
        self.assertEqual(
            _parse_import_options("{nope", ImportOptionsSerializer),
            (None, "'options' is not valid JSON."),
        )
        self.assertEqual(
            _parse_import_options('"str"', ImportOptionsSerializer),
            (None, "'options' must be a JSON object."),
        )
        self.assertEqual(
            _parse_import_options("[]", ImportOptionsSerializer),
            (None, "'options' must be a JSON object."),
        )

    def test_deeply_nested_json_is_a_clean_error(self):
        raw = "[" * 100000 + "]" * 100000
        self.assertEqual(
            _parse_import_options(raw, ImportOptionsSerializer),
            (None, "'options' is not valid JSON."),
        )

    def test_valid_object_returns_validated_dict(self):
        options, error = _parse_import_options(
            '{"comments": false, "history": false}', ImportOptionsSerializer
        )
        self.assertIsNone(error)
        self.assertIs(type(options), dict)
        self.assertIs(options["comments"], False)
        self.assertIs(options["history"], False)
        self.assertIs(options["cards"], True)


class ImportFieldValuesTests(TestCase):
    def setUp(self):
        owner = User.objects.create_user(username="fv", password="x")
        board = Board.objects.create(name="B", owner=owner)
        self.text = CustomFieldDefinition.objects.create(
            board=board, name="Notes", field_type="text", position=0
        )
        self.num = CustomFieldDefinition.objects.create(
            board=board, name="Qty", field_type="number", position=1
        )
        self.defs = {"Notes": self.text, "Qty": self.num}

    def test_non_dict_raw_yields_nothing(self):
        for raw in (None, [], ["Notes"], "Notes", 3):
            with self.subTest(raw=raw):
                self.assertEqual(_import_field_values(raw, self.defs, "CUSTOM_FIELD_VALIDATORS"), [])

    def test_unknown_and_invalid_entries_are_skipped_without_stopping(self):
        raw = {"Nope": "x", 5: "y", "Qty": "not a number", "Notes": "hello"}
        out = _import_field_values(raw, self.defs, "CUSTOM_FIELD_VALIDATORS")
        self.assertEqual(out, [(self.text, "hello")])

    def test_unknown_name_first_does_not_stop_the_loop(self):
        raw = {"Nope": "x", "Notes": "a", "Qty": "3"}
        out = _import_field_values(raw, self.defs, "CUSTOM_FIELD_VALIDATORS")
        self.assertEqual(out, [(self.text, "a"), (self.num, "3")])

    def test_values_that_normalize_to_empty_are_dropped(self):
        raw = {"Notes": "", "Qty": None}
        self.assertEqual(
            _import_field_values(raw, self.defs, "CUSTOM_FIELD_VALIDATORS"), []
        )
        raw = {"Notes": "", "Qty": "7"}
        self.assertEqual(
            _import_field_values(raw, self.defs, "CUSTOM_FIELD_VALIDATORS"),
            [(self.num, "7")],
        )


class JsonSkipCountsTests(TestCase):
    def test_list_len(self):
        self.assertEqual(_list_len([1, 2, 3]), 3)
        self.assertEqual(_list_len([]), 0)
        for value in ("abc", 5, None, {"a": 1}):
            with self.subTest(value=value):
                self.assertEqual(_list_len(value), 0)

    def test_empty_data_skips_nothing(self):
        off = {k: False for k in ALL_ON}
        self.assertEqual(
            _json_skip_counts({}, off),
            {
                "cards": 0, "comments": 0, "checklist_items": 0,
                "label_refs": 0, "movements": 0, "activities": 0,
            },
        )

    def test_label_refs_count_only_defined_label_names(self):
        # Entries that are not objects, or whose name is not a string, define
        # no label; a ref to one is dropped by the importer so it is not
        # reported as skipped.
        data = {
            "labels": ["junk", {"name": 5}, {"name": "bug"}, {"nm": "x"}, {"name": "ui"}],
            "cards": [{"labels": ["bug", "bug", "ui", "5", "junk", 5, None]}],
        }
        counts = _json_skip_counts(data, {**ALL_ON, "labels": False})
        self.assertEqual(counts["label_refs"], 2)
        counts = _json_skip_counts(data, {**ALL_ON, "cards": False, "comments": False,
                                          "checklist": False, "history": False})
        self.assertEqual(counts["label_refs"], 2)
        self.assertEqual(counts["cards"], 1)

    def test_non_list_children_count_as_zero(self):
        data = {"cards": [{"comments": "x", "checklist": 4, "movements": None, "activities": "y", "labels": "z"}]}
        off = {k: False for k in ALL_ON}
        self.assertEqual(
            _json_skip_counts(data, off),
            {
                "cards": 1, "comments": 0, "checklist_items": 0,
                "label_refs": 0, "movements": 0, "activities": 0,
            },
        )


class ImportOpenApiTests(TestCase):
    """The ``extend_schema`` text of the two import actions is the public API doc."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from drf_spectacular.generators import SchemaGenerator

        cls.paths = SchemaGenerator().get_schema(request=None, public=True)["paths"]

    @staticmethod
    def _props(op):
        schema = op["requestBody"]["content"]["multipart/form-data"]["schema"]
        assert schema["type"] == "object"
        return schema["properties"], schema["required"]

    def test_native_import_operation(self):
        op = self.paths["/api/v1/boards/import/"]["post"]
        self.assertEqual(op["summary"], "Import a board from a Visiban JSON or CSV export")
        props, required = self._props(op)
        self.assertEqual(required, ["file"])
        self.assertEqual(set(props), {"file", "name", "group_id", "options"})
        self.assertEqual(props["file"], {
            "type": "string", "format": "binary",
            "description": (
                "A .json or .csv Visiban export. The format is chosen from the file "
                "extension, falling back to the upload's content type."
            ),
        })
        self.assertEqual(props["name"], {
            "type": "string",
            "description": (
                "Board name, used exactly as given. When omitted, the board is named "
                "'Imported: <name>' — the name in a JSON file, or the CSV filename "
                "without its extension — with ' - 1', ' - 2', ... appended if that "
                "name is taken."
            ),
        })
        self.assertEqual(props["group_id"], {
            "type": "integer", "description": "Place the imported board into this group.",
        })
        self.assertEqual(props["options"], {
            "type": "string",
            "description": (
                "JSON object choosing what to import. Keys (all optional booleans, "
                "default true): labels, cards, comments, checklist, history. comments, "
                "checklist and history require cards. Also shift_dates_from (YYYY-MM-DD, "
                "JSON only, optional, default off): moves every date in the file forward "
                "by the days between that date and today. A CSV import accepts only "
                "labels and cards."
            ),
        })
        self.assertEqual(set(op["responses"]), {"201", "400", "401", "403", "404", "429"})
        self.assertEqual(
            op["responses"]["201"]["description"],
            "The new board (same shape as GET /boards/{id}/) plus an import_summary object.",
        )

    def test_trello_import_operation(self):
        op = self.paths["/api/v1/boards/import/trello/"]["post"]
        self.assertEqual(op["summary"], "Import a Trello board export (preview or confirm)")
        params = {p["name"]: p for p in op["parameters"]}
        self.assertEqual(set(params), {"dry_run", "confirm"})
        self.assertEqual(
            params["dry_run"]["description"], "Return a preview of the mapping; creates nothing."
        )
        self.assertEqual(
            params["confirm"]["description"],
            "Create the board. Exactly one of dry_run/confirm is required.",
        )
        for p in params.values():
            self.assertEqual(p["schema"], {"type": "boolean"})
        props, required = self._props(op)
        self.assertEqual(required, ["file"])
        self.assertEqual(props, {
            "file": {"type": "string", "format": "binary"},
            "name": {"type": "string", "description": "Board name; defaults to the Trello board name."},
            "group_id": {"type": "integer"},
            "mapping": {"type": "string", "description": "JSON object of mapping options."},
            "file_sha256": {
                "type": "string",
                "description": "Optional guard: must match the previewed file.",
            },
        })
        self.assertEqual(
            set(op["responses"]), {"200", "201", "400", "401", "403", "404", "413", "429"}
        )


class SanitizeCsvFieldTests(TestCase):
    def test_strips_only_formula_prefix_characters(self):
        self.assertEqual(_sanitize_csv_field("=+-@\t\r=x"), "x")
        self.assertEqual(_sanitize_csv_field("XYZ"), "XYZ")
        self.assertEqual(_sanitize_csv_field("x=y-z"), "x=y-z")
        self.assertEqual(_sanitize_csv_field(" =x"), " =x")
        self.assertEqual(_sanitize_csv_field(5), 5)
        self.assertIsNone(_sanitize_csv_field(None))


class ImportJsonRejectionTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(username="rej", password="x")
        from rest_framework.test import APIClient

        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _post(self, raw):
        from django.core.files.uploadedfile import SimpleUploadedFile

        cache.clear()
        return self.client.post(
            "/api/v1/boards/import/",
            {"file": SimpleUploadedFile("b.json", raw, content_type="application/json")},
            format="multipart",
        )

    def test_malformed_payload_is_logged_as_a_warning(self):
        with self.assertLogs("boards.views.import_export", level="WARNING") as logs:
            resp = self._post(b"{not json")
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(len(logs.records), 1)
        self.assertEqual(logs.records[0].levelname, "WARNING")
        self.assertTrue(
            logs.records[0].getMessage().startswith(
                "Board JSON import rejected \u2014 malformed payload: "
            ),
            logs.records[0].getMessage(),
        )

    def test_boolean_schema_version_is_rejected(self):
        for value in (True, False):
            with self.subTest(value=value):
                resp = self._post(
                    json.dumps({"schema_version": value, "name": "n"}).encode()
                )
                self.assertEqual(resp.status_code, 400, resp.content)
                self.assertEqual(
                    resp.json(), {"detail": "'schema_version' must be an integer."}
                )


def _base(**card_extra):
    card = {"title": "t", "column": "c", "swimlane": "s", **card_extra}
    return {"name": "B", "columns": [{"name": "c"}], "swimlanes": [{"name": "s"}], "cards": [card]}


class ImportJsonMessageTests(TestCase):
    """Exact ``detail`` text of every pre-transaction 400 in ``_import_json``.

    The wave-4 suite pins most of these with ``assertIn``, which a mutant that
    wraps the message in ``XX`` or renames the ``detail`` key survives.
    """

    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(username="msg", password="x")
        from rest_framework.test import APIClient

        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def check(self, data, detail):
        from django.core.files.uploadedfile import SimpleUploadedFile

        cache.clear()
        before = Board.objects.count()
        resp = self.client.post(
            "/api/v1/boards/import/",
            {"file": SimpleUploadedFile("b.json", json.dumps(data).encode(), content_type="application/json")},
            format="multipart",
        )
        self.assertEqual(resp.status_code, 400, resp.content)
        self.assertEqual(resp.json(), {"detail": detail})
        self.assertEqual(Board.objects.count(), before)

    def test_structure_entries_must_be_named_objects(self):
        for key, label in (("columns", "Column"), ("swimlanes", "Swimlane"), ("labels", "Label")):
            with self.subTest(key=key, kind="not an object"):
                data = _base()
                data[key] = [{"name": "ok"}, "x"] if key == "labels" else [data[key][0], 7]
                self.check(data, f"{label} at index 1 must be an object")
            with self.subTest(key=key, kind="name missing"):
                data = _base()
                data[key] = [{"name": "ok"}, {"color": "#fff"}] if key == "labels" else [data[key][0], {}]
                data["cards"] = []
                self.check(data, f"{label} at index 1: name must be a string")
            with self.subTest(key=key, kind="name not a string"):
                data = _base()
                data[key] = [{"name": 5}] if key == "labels" else [{"name": 5}]
                data["cards"] = []
                self.check(data, f"{label} at index 0: name must be a string")

    def test_card_entry_must_be_an_object(self):
        data = _base()
        data["cards"] = [data["cards"][0], "x"]
        self.check(data, "Card at index 1 must be an object")

    def test_card_children_must_be_lists(self):
        for key in ("comments", "movements", "activities", "checklist"):
            with self.subTest(key=key):
                self.check(_base(**{key: "x"}), f"Card at index 0: '{key}' must be a list")
        data = _base(comments=[])
        data["cards"] = [data["cards"][0], _base(movements={"a": 1})["cards"][0]]
        self.check(data, "Card at index 1: 'movements' must be a list")

    def test_card_child_entries_must_be_objects(self):
        for key, label in (
            ("comments", "comment"), ("movements", "movement"),
            ("activities", "activity"), ("checklist", "checklist item"),
        ):
            with self.subTest(key=key):
                self.check(
                    _base(**{key: [{}, "x"]}),
                    f"Card at index 0, {label} at index 1 must be an object",
                )

    def test_name_keys_of_children_must_be_strings(self):
        for key in ("from_column", "to_column", "from_swimlane", "to_swimlane", "moved_by"):
            with self.subTest(key=key):
                self.check(
                    _base(movements=[{}, {key: 5}]),
                    f"Card at index 0, movement at index 1: '{key}' must be a string",
                )
        self.check(
            _base(activities=[{}, {"actor": ["x"]}]),
            "Card at index 0, activity at index 1: 'actor' must be a string",
        )

    def test_card_scalar_shape_messages(self):
        self.check(_base(title=5), "Card at index 0: 'title' must be a string")
        self.check(_base(assignee=5), "Card at index 0: 'assignee' must be a string")
        self.check(_base(labels="x"), "Card at index 0: 'labels' must be a list of names")
        self.check(_base(labels=["a", ["b"]]), "Card at index 0: 'labels' must be a list of names")
        self.check(_base(labels=[{"a": 1}]), "Card at index 0: 'labels' must be a list of names")

    def test_card_required_fields(self):
        for field in ("title", "column", "swimlane"):
            with self.subTest(field=field):
                data = _base()
                data["cards"] = [data["cards"][0], {**data["cards"][0], field: ""}]
                self.check(data, f"Card at index 1 is missing required field: {field}")
        data = _base()
        del data["cards"][0]["title"]
        self.check(data, "Card at index 0 is missing required field: title")

    def test_timestamp_and_number_messages(self):
        self.check(
            _base(archived_at="nope"),
            "Card at index 0: invalid timestamp for 'archived_at': 'nope'",
        )
        self.check(_base(due_date="not-a-date"), "Card at index 0: invalid due_date: 'not-a-date'")
        for bad in (-1, 1.5, "3", True):
            with self.subTest(weight=bad):
                self.check(_base(weight=bad), "Card at index 0: weight must be a non-negative integer")
            with self.subTest(position=bad):
                self.check(_base(position=bad), "Card at index 0: position must be a non-negative integer")
        self.check(
            _base(comments=[{}, {"created_at": "bad"}]),
            "Card at index 0, comment at index 1: invalid 'created_at': 'bad'",
        )
        self.check(
            _base(movements=[{}, {"moved_at": "bad"}]),
            "Card at index 0, movement at index 1: invalid 'moved_at': 'bad'",
        )
        self.check(
            _base(activities=[{}, {"created_at": "bad"}]),
            "Card at index 0, activity at index 1: invalid 'created_at': 'bad'",
        )

    def test_column_limit_messages(self):
        for field in ("wip_limit", "weight_limit"):
            for bad in (-1, 2.5, "4", True):
                with self.subTest(field=field, bad=bad):
                    data = _base()
                    data["columns"] = [{"name": "c"}, {"name": "d", field: bad}]
                    data["cards"] = []
                    self.check(data, f"Column at index 1: {field} must be a non-negative integer")

    def test_duplicate_name_messages_are_sorted_and_unique(self):
        data = _base()
        data["columns"] = [{"name": "z"}, {"name": "a"}, {"name": "z"}, {"name": "a"}, {"name": "z"}, {"name": "q"}]
        data["cards"] = []
        self.check(data, "Duplicate column names: a, z")
        data = _base()
        data["swimlanes"] = [{"name": "s"}, {"name": "s"}]
        data["cards"] = []
        self.check(data, "Duplicate swimlane names: s")
        data = _base()
        data["labels"] = [{"name": "l"}, {"name": "l"}]
        data["cards"] = []
        self.check(data, "Duplicate label names: l")

    def test_undefined_references(self):
        data = _base()
        data["cards"] = [data["cards"][0], {**data["cards"][0], "column": "nope"}]
        self.check(data, "Card at index 1 references undefined column: 'nope'")
        data["cards"][1] = {**data["cards"][0], "swimlane": "nope"}
        self.check(data, "Card at index 1 references undefined swimlane: 'nope'")
        data["cards"][1] = {**data["cards"][0], "column": ["c"]}
        self.check(data, "Card at index 1 references undefined column: ['c']")
        data["cards"][1] = {**data["cards"][0], "swimlane": {"s": 1}}
        self.check(data, "Card at index 1 references undefined swimlane: {'s': 1}")
