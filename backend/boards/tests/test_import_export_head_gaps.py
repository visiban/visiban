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


# ---------------------------------------------------------------------------
# Second pass (#1502 re-measure): boundaries, defaults and tail of the head
# ---------------------------------------------------------------------------


class _ReprOf:
    """An object whose ``repr`` has an exact length, for ``_bounded_repr``."""

    def __init__(self, length):
        self.length = length

    def __repr__(self):
        return "x" * self.length


class EchoBoundTests(TestCase):
    """``_bounded_repr`` / ``_bounded_text`` cut what an error message echoes."""

    def test_repr_of_exactly_the_limit_is_kept_whole(self):
        from boards.views.import_export import _bounded_repr

        self.assertEqual(_bounded_repr(_ReprOf(60)), "x" * 60)

    def test_repr_over_the_limit_is_cut_to_57_plus_ellipsis(self):
        from boards.views.import_export import _bounded_repr

        out = _bounded_repr(["a" * 100, "b" * 100])
        self.assertEqual(len(out), 60)
        self.assertTrue(out.endswith("..."))
        self.assertEqual(out[:57], ("['" + "a" * 27 + "..." + "a" * 28 + "', ")[:57])

    def test_repr_walks_three_items_two_levels_deep(self):
        from boards.views.import_export import _bounded_repr

        self.assertEqual(_bounded_repr([1, 2, 3, 4, 5]), "[1, 2, 3, ...]")
        self.assertEqual(_bounded_repr({1: 1, 2: 2, 3: 3, 4: 4}), "{1: 1, 2: 2, 3: 3, ...}")
        self.assertEqual(_bounded_repr([[[1]]]), "[[[...]]]")
        self.assertEqual(_bounded_repr({"a": {"b": {"c": 1}}}), "{'a': {'b': {...}}}")

    def test_repr_of_a_long_object_is_cut_in_the_middle(self):
        from boards.views.import_export import _bounded_repr

        self.assertEqual(_bounded_repr(_ReprOf(61)), "x" * 28 + "..." + "x" * 29)

    def test_text_keeps_a_string_at_the_limit_and_cuts_one_over(self):
        from boards.views.import_export import _bounded_text

        self.assertEqual(_bounded_text("a" * 60), "a" * 60)
        self.assertEqual(_bounded_text("a" * 61), "a" * 57 + "...")
        self.assertEqual(_bounded_text("abcdefghij", 10), "abcdefghij")
        self.assertEqual(_bounded_text("abcdefghijk", 10), "abcdefg...")
        # Non-strings go through the bounded repr, unquoted strings stay unquoted.
        self.assertEqual(_bounded_text([1, 2, 3, 4]), "[1, 2, 3, ...]")

    def test_duplicates_detail_lists_five_and_counts_the_rest(self):
        from boards.views.import_export import _duplicates_detail

        self.assertEqual(
            _duplicates_detail("labels", list("aabbccddee")), "Duplicate labels: a, b, c, d, e"
        )
        self.assertEqual(
            _duplicates_detail("labels", list("aabbccddeeff")),
            "Duplicate labels: a, b, c, d, e (and 1 more)",
        )
        self.assertIsNone(_duplicates_detail("labels", list("abc")))


class CardRowsAndUsernamesTests(TestCase):
    def test_card_rows_counts_each_child_once(self):
        from boards.views.import_export import _card_rows

        card = {
            "comments": [{}] * 2,
            "checklist": [{}] * 3,
            "movements": [{}] * 5,
            "activities": [{}] * 7,
            "labels": ["a"] * 11,
        }
        # card 1 + comments 2 + 2 per checklist item 6 + movements 5 + activities 7
        # + labels 11 + the two importer-generated activities.
        self.assertEqual(_card_rows(card), 1 + 2 + 6 + 5 + 7 + 11 + 2)
        self.assertEqual(_card_rows({}), 3)

    def test_card_usernames_yields_only_non_empty_strings(self):
        from boards.views.import_export import _card_usernames

        card = {
            "assignee": "amy",
            "movements": [{"moved_by": "bob"}, {"moved_by": 5}, {"moved_by": ""}, {"moved_by": None}],
            "activities": [{"actor": "cy"}, {"actor": ["x"]}, {"actor": ""}],
        }
        self.assertEqual(
            list(_card_usernames(card)),
            [("assignee", "amy"), ("moved_by", "bob"), ("actor", "cy")],
        )
        self.assertEqual(list(_card_usernames({"assignee": 7})), [])


class TimestampErrorTests(TestCase):
    def test_naive_datetime_string_is_accepted(self):
        from django.utils.dateparse import parse_datetime
        from boards.views.import_export import _timestamp_error

        self.assertFalse(_timestamp_error("2024-05-06T07:08:09", parse_datetime))
        self.assertFalse(_timestamp_error("2024-05-06T07:08:09+02:00", parse_datetime))
        self.assertTrue(_timestamp_error("9999-12-31T23:59:59-12:00", parse_datetime))


class WriteGuardLogTests(TestCase):
    def test_log_names_the_importer_line_that_raised(self):
        import inspect
        from unittest import mock

        from rest_framework.exceptions import ParseError

        from boards.views import import_export
        from boards.views.import_export import _bounded_text, _json_import_write_guard

        # Three importer frames are on the stack (the guard, ``_bounded_text`` and
        # ``_bounded_repr``); the log must name the innermost one.
        lines, start = inspect.getsourcelines(import_export._bounded_repr)
        expected = next(
            start + i for i, line in enumerate(lines) if "return _encodable(text if" in line
        )
        with mock.patch.object(import_export, "_encodable", side_effect=ValueError("boom")):
            with self.assertLogs("boards.views.import_export", level="WARNING") as logs:
                with self.assertRaises(ParseError) as ctx:
                    with _json_import_write_guard():
                        _bounded_text(5)
        self.assertEqual(
            logs.records[0].getMessage(),
            f"Board JSON import rejected — ValueError while writing (line {expected}); "
            "a per-field check is missing.",
        )
        self.assertEqual(
            str(ctx.exception.detail), "The import file contains a value that cannot be stored."
        )


def _json_upload(data, name="b.json"):
    from django.core.files.uploadedfile import SimpleUploadedFile

    raw = data if isinstance(data, bytes) else json.dumps(data).encode("utf-8")
    return SimpleUploadedFile(name, raw, content_type="application/json")


class ValidateValuesBoundaryTests(TestCase):
    """Each import cap accepts exactly its limit and refuses one over."""

    def _check(self, **data):
        from boards.views.import_export import _validate_json_import_values

        data.setdefault("columns", [])
        return _validate_json_import_values(data)

    def test_per_card_child_caps(self):
        caps = {"comments": 1000, "checklist": 500, "movements": 2000, "activities": 5000}
        for child, cap in caps.items():
            with self.subTest(child=child):
                self.assertIsNone(self._check(cards=[{child: [{}] * cap}]))
                self.assertEqual(
                    self._check(cards=[{child: [{}] * (cap + 1)}]),
                    f"Card at index 0: '{child}' has {cap + 1} entries; the limit is {cap}",
                )

    def test_label_refs_per_card_cap(self):
        self.assertIsNone(self._check(cards=[{"labels": ["l"] * 1000}]))
        self.assertEqual(
            self._check(cards=[{"labels": ["l"] * 1001}]),
            "Card at index 0: 'labels' has more than 1000 entries",
        )

    def test_username_length_cap(self):
        from django.contrib.auth import get_user_model

        limit = get_user_model()._meta.get_field("username").max_length
        self.assertIsNone(self._check(cards=[{"assignee": "u" * limit}]))
        self.assertEqual(
            self._check(cards=[{"assignee": "u" * (limit + 1)}]),
            f"Card at index 0: 'assignee' must be at most {limit} characters",
        )

    def test_distinct_username_cap(self):
        cards = [{"assignee": f"u{i}"} for i in range(1000)]
        self.assertIsNone(self._check(cards=cards))
        self.assertEqual(
            self._check(cards=[*cards, {"assignee": "one-more"}]),
            "Import references more than 1000 distinct usernames.",
        )

    def test_options_serializer_message_is_cut_at_200(self):
        # An unknown option key is echoed back by the serializer message; the
        # response bounds the message to 200 characters, not the 60 of the
        # other echoes and not unbounded.
        prefix = "Invalid 'options': "
        error = _parse_import_options(json.dumps({"k" * 300: True}), ImportOptionsSerializer)[1]
        message = error[len(prefix) :]
        self.assertTrue(error.startswith(prefix))
        self.assertEqual(len(message), 200)
        self.assertTrue(message.startswith("Unknown import option(s): kkk"))
        self.assertTrue(message.endswith("k..."))

    def test_options_serializer_message_under_cap_is_untouched(self):
        error = _parse_import_options(json.dumps({"k" * 100: True}), ImportOptionsSerializer)[1]
        self.assertEqual(error, f"Invalid 'options': Unknown import option(s): {'k' * 100}.")

    def test_field_definition_serializer_message_is_cut_at_200(self):
        from boards.serializers import CustomFieldDefinitionSerializer
        from boards.views.import_export import _validate_import_field_definitions

        error = _validate_import_field_definitions(
            [{"name": "a", "field_type": "z" * 300}],
            CustomFieldDefinitionSerializer,
            CustomFieldDefinition,
            "pinned",
            "custom_fields",
        )[1]
        prefix = "'custom_fields' entry at index 0: "
        self.assertTrue(error.startswith(prefix))
        message = error[len(prefix) :]
        self.assertEqual(len(message), 200)
        self.assertTrue(message.endswith("z..."))


class ImportJsonTailTests(TestCase):
    """The JSON importer's write phase and response (#1502)."""

    def setUp(self):
        from rest_framework.test import APIClient

        cache.clear()
        self.user = User.objects.create_user(username="tail", password="x")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _post(self, data, query="", **extra):
        cache.clear()
        return self.client.post(
            "/api/v1/boards/import/" + query,
            {"file": _json_upload(data), **extra},
            format="multipart",
        )

    @staticmethod
    def _board(**over):
        data = {
            "name": "B",
            "columns": [{"name": "c"}],
            "swimlanes": [{"name": "s"}],
            "cards": [{"title": "t", "column": "c", "swimlane": "s"}],
        }
        data.update(over)
        return data

    def test_label_color_is_kept_and_defaults_to_amber(self):
        resp = self._post(
            self._board(labels=[{"name": "red", "color": "#112233"}, {"name": "plain"}])
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        colors = dict(Board.objects.get().labels.values_list("name", "color"))
        self.assertEqual(colors, {"red": "#112233", "plain": "#EAB308"})

    def test_response_counts_distinguish_active_and_archived_cards(self):
        cards = [
            {"title": f"t{i}", "column": "c", "swimlane": "s"} for i in range(3)
        ] + [{"title": "old", "column": "c", "swimlane": "s", "archived_at": "2024-01-02T03:04:05Z"}]
        resp = self._post(self._board(cards=cards))
        self.assertEqual(resp.status_code, 201, resp.content)
        body = resp.json()
        self.assertEqual(body["member_count"], 1)
        self.assertEqual(body["card_count"], 3)
        self.assertEqual(body["archived_card_count"], 1)

    def test_json_into_group_expands_group_and_broadcasts_to_group(self):
        from unittest import mock

        from groups.models import Group

        group = Group.objects.create(name="G", owner=self.user)
        with mock.patch("boards.views.import_export._broadcast.broadcast_board_event"), mock.patch(
            "groups.broadcast.broadcast_group_event"
        ) as group_event:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self._post(self._board(), "?expand=group", group_id=group.pk)
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(resp.json()["group_detail"]["id"], group.pk)
        self.assertEqual(group_event.call_count, 1)
        self.assertEqual(group_event.call_args.args[0], group.pk)
        payload = group_event.call_args.args[2]
        self.assertEqual(payload["id"], Board.objects.get().pk)

    def test_json_without_group_does_not_broadcast_to_a_group(self):
        from unittest import mock

        with mock.patch("boards.views.import_export._broadcast.broadcast_board_event"), mock.patch(
            "groups.broadcast.broadcast_group_event"
        ) as group_event:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self._post(self._board())
        self.assertEqual(resp.status_code, 201, resp.content)
        group_event.assert_not_called()

    def test_weight_two_card_gets_a_weight_change_activity_with_history(self):
        from boards.models import CardActivity

        for weight, expected in ((1, 0), (2, 1)):
            with self.subTest(weight=weight):
                Board.objects.all().delete()
                data = self._board()
                data["cards"][0]["weight"] = weight
                resp = self._post(data)
                self.assertEqual(resp.status_code, 201, resp.content)
                self.assertEqual(
                    CardActivity.objects.filter(
                        event_type=CardActivity.EventType.WEIGHT_CHANGE
                    ).count(),
                    expected,
                )

    def test_movement_without_destination_stores_empty_names_and_uids(self):
        from boards.models import CardMovement

        data = self._board()
        data["cards"][0]["movements"] = [{"from_column": "c", "from_swimlane": "s"}]
        resp = self._post(data)
        self.assertEqual(resp.status_code, 201, resp.content)
        mv = CardMovement.objects.get()
        self.assertEqual(mv.to_column_name, "")
        self.assertEqual(mv.to_swimlane_name, "")
        self.assertEqual(mv.to_column_uid, "")
        self.assertEqual(mv.to_swimlane_uid, "")

    def test_unknown_activity_type_does_not_stop_later_activities(self):
        from boards.models import CardActivity

        data = self._board()
        data["cards"][0]["activities"] = [
            {"event_type": "no-such-type"},
            {"event_type": CardActivity.EventType.WEIGHT_CHANGE, "from_value": "1", "to_value": "3"},
        ]
        resp = self._post(data)
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(
            list(CardActivity.objects.values_list("event_type", flat=True)),
            [CardActivity.EventType.WEIGHT_CHANGE],
        )

    def test_movement_names_must_be_strings(self):
        for key in ("from_column", "to_column", "from_swimlane", "to_swimlane", "moved_by"):
            with self.subTest(key=key):
                data = self._board()
                data["cards"][0]["movements"] = [{key: 123}]
                resp = self._post(data)
                self.assertEqual(resp.status_code, 400, resp.content)
                self.assertEqual(
                    resp.json(),
                    {"detail": f"Card at index 0, movement at index 0: '{key}' must be a string"},
                )

    def test_duplicate_label_reference_on_a_card_attaches_once(self):
        data = self._board(labels=[{"name": "bug"}])
        data["cards"][0]["labels"] = ["bug", "bug"]
        resp = self._post(data)
        self.assertEqual(resp.status_code, 201, resp.content)
        from boards.models import Card

        self.assertEqual(Card.objects.get().labels.count(), 1)

    def test_timestamp_backfill_runs_in_batches_of_500(self):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        from boards.models import CardComment

        data = self._board()
        data["cards"][0]["comments"] = [
            {"body": f"c{i}", "created_at": "2024-01-02T03:04:05Z"} for i in range(501)
        ]
        with CaptureQueriesContext(connection) as ctx:
            resp = self._post(data)
        self.assertEqual(resp.status_code, 201, resp.content)
        updates = [
            q["sql"] for q in ctx.captured_queries
            if q["sql"].lstrip().upper().startswith("UPDATE") and CardComment._meta.db_table in q["sql"]
        ]
        self.assertEqual(len(updates), 2, updates)


class ImportOpenApiResponseTests(TestCase):
    """Every documented error status carries an object schema."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from drf_spectacular.generators import SchemaGenerator

        cls.paths = SchemaGenerator().get_schema(request=None, public=True)["paths"]

    def test_error_responses_are_objects(self):
        for path, codes in (
            ("/api/v1/boards/import/", ("400", "401", "403", "404", "429")),
            ("/api/v1/boards/import/trello/", ("400", "401", "403", "404", "413", "429")),
        ):
            op = self.paths[path]["post"]
            for code in codes:
                with self.subTest(path=path, code=code):
                    content = op["responses"][code]["content"]["application/json"]["schema"]
                    self.assertEqual(content["type"], "object")


class ImportTrelloTailTests(TestCase):
    """Response and broadcast of ``import_trello`` confirm mode (#1502)."""

    URL = "/api/v1/boards/import/trello/"

    def setUp(self):
        from rest_framework.test import APIClient

        cache.clear()
        self.user = User.objects.create_user(username="trel", password="x")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _confirm(self, query="", **extra):
        from boards.tests.test_trello_import import as_file, load_fixture

        cache.clear()
        return self.client.post(
            f"{self.URL}?confirm=true{query}",
            {"file": as_file(load_fixture()), **extra},
            format="multipart",
        )

    def test_response_board_counts_split_active_and_archived(self):
        # The fixture has two active cards and one archived card by default; the
        # counts must differ so a swapped filter cannot pass.
        resp = self._confirm()
        self.assertEqual(resp.status_code, 201, resp.content)
        board = resp.json()["board"]
        stored = Board.objects.get(pk=board["id"])
        archived = stored.cards.filter(archived_at__isnull=False).count()
        self.assertEqual(archived, 1)
        self.assertEqual(board["card_count"], 2)
        self.assertEqual(board["archived_card_count"], archived)
        self.assertEqual(board["card_count"], stored.cards.filter(archived_at__isnull=True).count())
        self.assertEqual(board["member_count"], 1)

    def test_import_into_group_expands_group_and_broadcasts_to_group(self):
        from unittest import mock

        from groups.models import Group

        group = Group.objects.create(name="G", owner=self.user)
        with mock.patch("boards.views.import_export._broadcast.broadcast_board_event"), mock.patch(
            "groups.broadcast.broadcast_group_event"
        ) as group_event:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self._confirm("&expand=group", group_id=group.pk)
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(resp.json()["board"]["group_detail"]["id"], group.pk)
        self.assertEqual(group_event.call_count, 1)
        self.assertEqual(group_event.call_args.args[0], group.pk)

    def test_import_without_group_does_not_broadcast_to_a_group(self):
        from unittest import mock

        with mock.patch("boards.views.import_export._broadcast.broadcast_board_event"), mock.patch(
            "groups.broadcast.broadcast_group_event"
        ) as group_event:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self._confirm()
        self.assertEqual(resp.status_code, 201, resp.content)
        group_event.assert_not_called()

    def test_execute_plan_client_error_is_a_400_with_detail(self):
        from unittest import mock

        from boards.services import trello_import

        with mock.patch.object(
            trello_import, "execute_plan", side_effect=trello_import.TrelloImportError("nope")
        ):
            resp = self._confirm()
        self.assertEqual(resp.status_code, 400, resp.content)
        self.assertEqual(resp.json(), {"detail": "nope"})
        self.assertEqual(Board.objects.count(), 0)
