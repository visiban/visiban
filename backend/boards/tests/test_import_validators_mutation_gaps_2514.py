"""Mutation gap tests for the JSON-import value validators (#2514).

``backend-mutation-report`` found 214 surviving mutants in the validators of
``boards/views/import_export.py``. Most are string literals (an error
message, a spec key) or boundary operators, so these tests call the helpers
directly with boundary inputs and assert the exact message or return value.
No database is needed.
"""

import copy
from types import SimpleNamespace

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase
from django.utils import timezone

from boards.models import CardActivity, Column, SubColumn
from boards.views import import_export as ie


def _validate(**top):
    data = {
        "name": "B",
        "columns": [{"name": "c"}],
        "swimlanes": [{"name": "s"}],
        "cards": [],
    }
    data.update(copy.deepcopy(top))
    return ie._validate_json_import_values(data)


def _card(**extra):
    return {"title": "t", "column": "c", "swimlane": "s", **extra}


class ParentSettingsTests(SimpleTestCase):
    def test_non_string_names_name_their_key(self):
        self.assertEqual(
            ie._validate_import_parent_settings({"parent_name_singular": 5}),
            (None, "'parent_name_singular' must be a string."),
        )
        self.assertEqual(
            ie._validate_import_parent_settings({"parent_name_plural": 5}),
            (None, "'parent_name_plural' must be a string."),
        )

    def test_null_name_is_skipped_and_the_next_key_still_read(self):
        out, err = ie._validate_import_parent_settings(
            {"parent_name_singular": None, "parent_name_plural": " Epics "}
        )
        self.assertIsNone(err)
        self.assertEqual(out, {"parent_name_plural": "Epics"})

    def test_clean_failure_reports_first_detail(self):
        self.assertEqual(
            ie._validate_import_parent_settings({"parent_name_plural": "a\x07b"}),
            (None, "'parent_name_plural': Use letters, numbers, spaces and punctuation only."),
        )

    def test_child_cards_flag(self):
        self.assertEqual(
            ie._validate_import_parent_settings({"cards_can_have_children": "yes"}),
            (None, "'cards_can_have_children' must be true or false."),
        )
        self.assertEqual(
            ie._validate_import_parent_settings({"cards_can_have_children": True}),
            ({"cards_can_have_children": True}, None),
        )
        self.assertEqual(ie._validate_import_parent_settings({}), ({}, None))


class LaneTierTests(SimpleTestCase):
    def test_cap_must_be_a_strict_allowed_int(self):
        msg = "'lane_details_cap' must be one of [4, 6, 9, 12, 16]."
        for bad in (True, 6.0, "6", 7):
            with self.subTest(bad=bad):
                self.assertEqual(ie._validate_import_lane_tiers([], bad), (None, msg))
        self.assertEqual(ie._validate_import_lane_tiers([], 9), (9, None))
        self.assertEqual(ie._validate_import_lane_tiers([], None), (6, None))

    def test_six_band_fields_are_accepted(self):
        self.assertEqual(ie._validate_import_lane_tiers([{"band_visibility": "band"}] * 6, 4), (4, None))

    def test_seven_band_fields_are_refused_with_the_field_prefix(self):
        defs = [{"band_visibility": "band"}] * 7
        cap, err = ie._validate_import_lane_tiers(defs, None)
        self.assertIsNone(cap)
        self.assertEqual(
            err,
            "'swimlane_custom_fields': 'band_visibility': "
            "The band holds 6 fields. Move one to Details first.",
        )

    def test_legacy_and_valid_lists_keep_the_cap(self):
        self.assertEqual(ie._validate_import_lane_tiers([{}, {}, {}], 4), (4, None))
        two = [{"band_visibility": "band"}, {"band_visibility": "band"}, {"band_visibility": "hidden"}]
        self.assertEqual(ie._validate_import_lane_tiers(two, 4), (4, None))


class SkipCountTests(SimpleTestCase):
    OPTS = {"cards": True, "labels": True, "comments": True, "checklist": True, "history": False}

    def test_deleted_card_history_counts_only_when_history_is_off(self):
        valid = CardActivity.EventType.choices[0][0]
        entry = {
            "movements": [{}, {}],
            "activities": [
                {"event_type": valid}, {"event_type": valid}, {"event_type": "bogus"},
                {"event_type": 5}, {},
            ],
        }
        data = {"cards": [], "deleted_card_history": [entry, copy.deepcopy(entry)]}
        skipped = ie._json_skip_counts(data, dict(self.OPTS))
        self.assertEqual(skipped["movements"], 4)
        self.assertEqual(skipped["activities"], 4)
        on = ie._json_skip_counts(data, {**self.OPTS, "history": True})
        self.assertEqual((on["movements"], on["activities"]), (0, 0))

    def test_entry_without_lists_counts_nothing(self):
        skipped = ie._json_skip_counts({"cards": [], "deleted_card_history": [{}]}, dict(self.OPTS))
        self.assertEqual((skipped["movements"], skipped["activities"]), (0, 0))


class LimitCheckerTests(SimpleTestCase):
    def test_gate_index(self):
        top = SubColumn.MAX_PER_COLUMN
        for ok in (0, 1, top):
            self.assertIsNone(ie._gate_index_error(ok), ok)
        for bad in (-1, True, "1", 1.5, None):
            self.assertEqual(ie._gate_index_error(bad), "must be a non-negative integer", bad)
        self.assertEqual(ie._gate_index_error(top + 1), f"must be at most {top}")
        self.assertIsNone(ie._nullable_gate_index_error(None))

    def test_swimlane_limit(self):
        top = ie._IMPORT_INT_MAX
        for ok in (None, 1, 2, top):
            self.assertIsNone(ie._swimlane_limit_error(ok), ok)
        for bad in (0, -1, True, "1", 1.5):
            self.assertEqual(ie._swimlane_limit_error(bad), "must be null or a positive integer", bad)
        self.assertEqual(ie._swimlane_limit_error(top + 1), f"must be at most {top}")

    def test_limit_enforcement(self):
        for ok in (None, "block", "hard"):
            self.assertIsNone(ie._limit_enforcement_error(ok), ok)
        for bad in ("x", 5, ""):
            self.assertEqual(ie._limit_enforcement_error(bad), 'must be null, "block" or "hard"', bad)

    def test_health_status(self):
        for ok in (None, "on_track", "at_risk", "off_track"):
            self.assertIsNone(ie._health_status_error(ok), ok)
        for bad in ("x", 5):
            self.assertEqual(
                ie._health_status_error(bad), 'must be null, "on_track", "at_risk" or "off_track"', bad
            )

    def test_limit_columns(self):
        msg = "must be null or a non-empty list of column names"
        for ok in (None, ["a"], ["a", "b"]):
            self.assertIsNone(ie._limit_columns_error(ok), ok)
        for bad in ([], "x", [5], ["a", 5], {}):
            self.assertEqual(ie._limit_columns_error(bad), msg, bad)

    def test_policy(self):
        self.assertIsNone(ie._policy_error(None))
        self.assertEqual(ie._policy_error("bad"), "is invalid: Policy must be an object or null.")

    def test_name_list(self):
        top = ie.CustomFieldDefinition.MAX_PER_BOARD
        for ok in (None, [], ["a"], [str(i) for i in range(top)]):
            self.assertIsNone(ie._name_list_error(ok), ok)
        for bad in ("x", [""], [" "], [5], ["a", 5], {}):
            self.assertEqual(ie._name_list_error(bad), "must be a list of non-empty names", bad)
        self.assertEqual(ie._name_list_error(["a", "a"]), "must not repeat a name")
        self.assertEqual(
            ie._name_list_error([str(i) for i in range(top + 1)]), f"has more than {top} entries"
        )

    def test_sub_columns(self):
        top = SubColumn.MAX_PER_COLUMN
        max_len = SubColumn._meta.get_field("name").max_length
        for ok in (None, [], ["a", "b"], [str(i) for i in range(top)], ["a", "b" * max_len]):
            self.assertIsNone(ie._sub_columns_error(ok), ok)
        count_msg = f"must list between 2 and {top} sub-columns, or none"
        for bad in (["a"], [str(i) for i in range(top + 1)]):
            self.assertEqual(ie._sub_columns_error(bad), count_msg, bad)
        name_msg = f"names must be at most {max_len} characters, without NUL"
        self.assertEqual(ie._sub_columns_error(["a", "b" * (max_len + 1)]), name_msg)
        self.assertEqual(ie._sub_columns_error(["a", "b\x00"]), name_msg)
        self.assertEqual(ie._sub_columns_error("x"), "must be a list of non-empty names")


class BlockReasonTests(SimpleTestCase):
    def test_card_level(self):
        msg = "W: 'blocked_reason' is required when 'blocked_at' is set"
        self.assertEqual(ie._block_reason_error({"blocked_at": "t", "blocked_reason": " "}, "W"), msg)
        self.assertEqual(ie._block_reason_error({"blocked_at": "t"}, "W"), msg)
        self.assertIsNone(ie._block_reason_error({"blocked_at": "t", "blocked_reason": "r"}, "W"))
        self.assertIsNone(ie._block_reason_error({"blocked_reason": ""}, "W"))

    def test_block_entries(self):
        card = {"blocks": [{"blocked_at": "t", "reason": "ok"}, {"blocked_at": "t", "reason": "  "}]}
        self.assertEqual(ie._block_reason_error(card, "W"), "W, block at index 1: 'reason' is required")
        self.assertIsNone(ie._block_reason_error({"blocks": [{"blocked_at": None, "reason": ""}]}, "W"))
        self.assertIsNone(ie._block_reason_error({"blocks": [{"blocked_at": "t", "reason": "ok"}]}, "W"))
        self.assertEqual(
            ie._block_reason_error({"blocks": [{"blocked_at": "t"}]}, "W"),
            "W, block at index 0: 'reason' is required",
        )


class ImportedCardBlocksTests(SimpleTestCase):
    def setUp(self):
        self.importer = get_user_model()(username="importer2514")
        self.col = Column(name="Doing", uid="c" * 16)
        self.other = Column(name="Review", uid="d" * 16)
        self.map = {"Review": self.other}

    def _card(self, blocked_at=None, reason=""):
        return SimpleNamespace(
            pk=7, board_id=3, uid="u" * 16, title="T", column=self.col,
            blocked_at=blocked_at, blocked_reason=reason,
        )

    def _rows(self, card, blocks, history=True):
        return ie._imported_card_blocks(card, {"blocks": blocks}, self.map, self.importer, history)

    def test_history_off_ignores_the_blocks_list(self):
        block = {"blocked_at": "2024-01-01T00:00:00Z", "unblocked_at": "2024-01-02T00:00:00Z", "reason": "r"}
        self.assertEqual(self._rows(self._card(), [block], history=False), [])

    def test_closed_blocks_are_restored_stripped(self):
        blocks = [
            {"blocked_at": "2024-01-01T00:00:00Z", "unblocked_at": "2024-01-02T00:00:00Z",
             "reason": " r1 ", "resolution": " done ", "blocked_by": "ann", "column": "Review"},
            {"blocked_at": "2024-01-01T00:00:00Z", "unblocked_at": "2024-01-01T00:00:00Z",
             "reason": "same instant", "resolution": None, "imported_from_username": "orig"},
            {"blocked_at": "2024-01-01T00:00:00Z", "unblocked_at": "2024-01-02T00:00:00Z",
             "reason": "r3"},
        ]
        rows = self._rows(self._card(), blocks)
        self.assertEqual([r.reason for r in rows], ["r1", "same instant", "r3"])
        self.assertEqual([r.resolution for r in rows], ["done", "", ""])
        self.assertEqual(rows[0].imported_from_username, "ann")
        self.assertEqual(rows[1].imported_from_username, "orig")
        self.assertEqual(rows[0].column_name, "Review")
        self.assertEqual(rows[2].column_name, "Doing")
        self.assertIs(rows[0].blocked_by, self.importer)
        self.assertIs(rows[0].unblocked_by, self.importer)

    def test_unusable_entries_are_skipped_without_stopping_the_loop(self):
        blocks = [
            {"reason": "no start"},
            {"blocked_at": "2024-01-02T00:00:00Z", "unblocked_at": "2024-01-01T00:00:00Z", "reason": "backwards"},
            {"blocked_at": "2024-01-01T00:00:00Z", "reason": "open entry"},
            {"blocked_at": "2024-01-01T00:00:00Z", "unblocked_at": "2024-01-02T00:00:00Z", "reason": "kept"},
        ]
        rows = self._rows(self._card(), blocks)
        self.assertEqual([r.reason for r in rows], ["kept"])

    def test_open_row_for_a_blocked_card_uses_the_open_entry(self):
        now = timezone.now()
        blocks = [{
            "blocked_at": "2024-01-01T00:00:00Z", "reason": "ignored", "blocked_by": "bob",
            "column": "Review",
        }]
        rows = self._rows(self._card(blocked_at=now, reason="why"), blocks)
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual((row.reason, row.resolution), ("why", ""))
        self.assertIsNone(row.unblocked_at)
        self.assertIsNone(row.unblocked_by)
        self.assertEqual(row.column_name, "Review")
        self.assertEqual(row.imported_from_username, "bob")

    def test_open_row_without_an_open_entry(self):
        rows = self._rows(self._card(blocked_at=timezone.now(), reason="why"), [])
        self.assertEqual(rows[0].imported_from_username, "")
        self.assertEqual(rows[0].column_name, "Doing")
        self.assertEqual(rows[0].resolution, "")
        rows = self._rows(self._card(blocked_at=timezone.now(), reason="why"), [], history=False)
        self.assertEqual(len(rows), 1)


class JsonValueSpecTests(SimpleTestCase):
    """Every spec key must be live: an invalid value is refused with its exact message."""

    def test_valid_base(self):
        self.assertIsNone(_validate())

    def test_column_specs(self):
        for key, bad, msg in (
            ("policy", "bad", "is invalid: Policy must be an object or null."),
            ("sub_columns", ["a"], "must list between 2 and 4 sub-columns, or none"),
            ("tracks", "x", "must be a list of non-empty names"),
        ):
            with self.subTest(key=key):
                self.assertEqual(
                    _validate(columns=[{"name": "c", key: bad}]), f"Column at index 0: '{key}' {msg}"
                )

    def test_swimlane_specs(self):
        pos = "must be null or a positive integer"
        for key, bad, msg in (
            ("wip_limit", 0, pos),
            ("weight_limit", 0, pos),
            ("limit_enforcement", "x", 'must be null, "block" or "hard"'),
            ("limit_columns", [], "must be null or a non-empty list of column names"),
            ("health_status", "x", 'must be null, "on_track", "at_risk" or "off_track"'),
            ("not_applicable_tracks", "x", "must be a list of non-empty names"),
        ):
            with self.subTest(key=key):
                self.assertEqual(
                    _validate(swimlanes=[{"name": "s", key: bad}]), f"Swimlane at index 0: '{key}' {msg}"
                )

    def test_limit_columns_must_name_file_columns(self):
        self.assertEqual(
            _validate(swimlanes=[{"name": "s"}, {"name": "t", "limit_columns": ["c", "zz"]}]),
            "Swimlane at index 1: 'limit_columns' references undefined column: 'zz'",
        )
        self.assertIsNone(_validate(swimlanes=[{"name": "s", "limit_columns": ["c"]}]))

    def test_card_specs(self):
        self.assertEqual(
            _validate(cards=[_card(blocked_reason=None)]),
            "Card at index 0: 'blocked_reason' must be a string",
        )
        self.assertEqual(
            _validate(cards=[_card(gates_passed="x")]),
            "Card at index 0: gates_passed must be a non-negative integer",
        )

    def test_gates_passed_against_the_stage(self):
        msg = "Card at index 0: 'gates_passed' must be less than the number of sub-columns of its column"
        staged = [{"name": "c", "sub_columns": ["a", "b"]}]
        self.assertIsNone(_validate(columns=staged, cards=[_card(gates_passed=1)]))
        self.assertIsNone(_validate(columns=staged, cards=[_card(gates_passed=0)]))
        self.assertEqual(_validate(columns=staged, cards=[_card(gates_passed=2)]), msg)
        # An unstaged column has one implicit gate: only 0 is legal.
        self.assertEqual(_validate(cards=[_card(gates_passed=1)]), msg)
        self.assertEqual(_validate(cards=[_card(column="zz", gates_passed=1)]), msg)
        self.assertEqual(_validate(cards=[_card(column=None, gates_passed=1)]), msg)

    def test_child_specs(self):
        w = "Card at index 0"
        cases = (
            ("comments", "comment", "imported_from_username", 5, "must be a string"),
            ("checklist", "checklist item", "assignee", 5, "must be a string"),
            ("movements", "movement", "from_gates_passed", -1, "must be a non-negative integer"),
            ("movements", "movement", "from_gates_open", -1, "must be a non-negative integer"),
            ("movements", "movement", "to_gates_passed", -1, "must be a non-negative integer"),
            ("activities", "activity", "item_text", 5, "must be a string"),
            ("blocks", "block", "reason", None, "must be a string"),
            ("blocks", "block", "resolution", None, "must be a string"),
            ("blocks", "block", "column", 5, "must be a string"),
            ("blocks", "block", "imported_from_username", 5, "must be a string"),
            ("gate_transitions", "gate transition", "from_index", "x", "must be a non-negative integer"),
            ("gate_transitions", "gate transition", "to_index", "x", "must be a non-negative integer"),
            ("gate_transitions", "gate transition", "reason", None, "must be a string"),
            ("gate_transitions", "gate transition", "column", 5, "must be a string"),
            ("gate_transitions", "gate transition", "sub_column", 5, "must be a string"),
            ("gate_transitions", "gate transition", "imported_from_username", 5, "must be a string"),
        )
        for child, label, key, bad, msg in cases:
            with self.subTest(child=child, key=key):
                self.assertEqual(
                    _validate(cards=[_card(**{child: [{key: bad}]})]),
                    f"{w}, {label} at index 0: '{key}' {msg}",
                )
        self.assertEqual(
            _validate(cards=[_card(gate_transitions=[{"movement_index": -1}])]),
            f"{w}, gate transition at index 0: movement_index must be a non-negative integer",
        )

    def test_valid_children_pass(self):
        card = _card(
            checklist=[{"assignee": None}, {"assignee": "ann"}],
            movements=[{"from_gates_passed": None, "to_gates_passed": 0}],
            gate_transitions=[{"from_index": 0, "to_index": SubColumn.MAX_PER_COLUMN, "movement_index": None}],
            blocks=[{"reason": "r", "resolution": "x", "column": "c"}],
        )
        self.assertIsNone(_validate(cards=[card]))

    def test_block_reason_is_enforced_per_card(self):
        self.assertEqual(
            _validate(cards=[_card(blocked_at="2024-01-01T00:00:00Z")]),
            "Card at index 0: 'blocked_reason' is required when 'blocked_at' is set",
        )


class DeletedHistoryTests(SimpleTestCase):
    W = "Deleted card history at index 0"

    def test_container_shape(self):
        self.assertEqual(_validate(deleted_card_history="x"), "'deleted_card_history' must be a list")
        self.assertEqual(_validate(deleted_card_history=["x"]), f"{self.W} must be an object")

    def test_entry_count_cap(self):
        top = ie._IMPORT_MAX_DELETED_CARDS
        self.assertIsNone(_validate(deleted_card_history=[{}] * top))
        err = _validate(deleted_card_history=[{}] * (top + 1))
        self.assertEqual(err, f"'deleted_card_history' has {top + 1} entries; the limit is {top}")

    def test_title_and_uid(self):
        self.assertEqual(
            _validate(deleted_card_history=[{"card_title": None}]), f"{self.W}: 'card_title' must be a string"
        )
        uid_msg = f"{self.W}: 'card_uid' must be a card uid (16 lowercase hex characters)"
        for bad in ("BAD", "a" * 15, "A" * 16, 5):
            with self.subTest(bad=bad):
                self.assertEqual(_validate(deleted_card_history=[{"card_uid": bad}]), uid_msg)
        for ok in ({}, {"card_uid": ""}, {"card_uid": "0123456789abcdef"}):
            with self.subTest(ok=ok):
                self.assertIsNone(_validate(deleted_card_history=[ok]))

    def test_child_shape_and_string_keys(self):
        for child, label in (("movements", "movement"), ("activities", "activity")):
            with self.subTest(child=child):
                self.assertEqual(
                    _validate(deleted_card_history=[{child: "x"}]), f"{self.W}: '{child}' must be a list"
                )
                self.assertEqual(
                    _validate(deleted_card_history=[{child: ["x"]}]),
                    f"{self.W}, {label} at index 0 must be an object",
                )
        for child, label, keys in (
            ("movements", "movement", ("from_column", "to_column", "from_swimlane", "to_swimlane",
                                       "moved_by", "imported_from_username")),
            ("activities", "activity", ("actor", "imported_from_username")),
        ):
            for key in keys:
                with self.subTest(child=child, key=key):
                    self.assertEqual(
                        _validate(deleted_card_history=[{child: [{key: 5}]}]),
                        f"{self.W}, {label} at index 0: '{key}' must be a string",
                    )
                    # The string check runs before the timestamp check, so it
                    # wins even when the timestamp is bad too.
                    ts = "moved_at" if child == "movements" else "created_at"
                    self.assertEqual(
                        _validate(deleted_card_history=[{child: [{key: 5, ts: "bad"}]}]),
                        f"{self.W}, {label} at index 0: '{key}' must be a string",
                    )

    def test_timestamps(self):
        for child, label, ts in (("movements", "movement", "moved_at"), ("activities", "activity", "created_at")):
            with self.subTest(child=child):
                self.assertEqual(
                    _validate(deleted_card_history=[{child: [{ts: "bad"}]}]),
                    f"{self.W}, {label} at index 0: invalid timestamp for '{ts}': 'bad'",
                )
                self.assertIsNone(_validate(deleted_card_history=[{child: [{ts: "2024-01-01T00:00:00Z"}]}]))
        # A movement's moved_at is not an activity's created_at, and vice versa.
        self.assertIsNone(_validate(deleted_card_history=[{"movements": [{"created_at": "bad"}]}]))
        self.assertIsNone(_validate(deleted_card_history=[{"activities": [{"moved_at": "bad"}]}]))

    def test_spec_errors_carry_the_item_location(self):
        self.assertEqual(
            _validate(deleted_card_history=[{"movements": [{"notes": None}]}]),
            f"{self.W}, movement at index 0: 'notes' must be a string",
        )
        self.assertEqual(
            _validate(deleted_card_history=[{"activities": [{}, {"item_text": 5}]}]),
            f"{self.W}, activity at index 1: 'item_text' must be a string",
        )

    def test_per_child_caps(self):
        for child, cap in (("movements", 2000), ("activities", 5000)):
            with self.subTest(child=child):
                self.assertIsNone(_validate(deleted_card_history=[{child: [{}] * cap}]))
                self.assertEqual(
                    _validate(deleted_card_history=[{child: [{}] * (cap + 1)}]),
                    f"{self.W}: '{child}' has {cap + 1} entries; the limit is {cap}",
                )

    def test_total_row_cap(self):
        limit = ie._IMPORT_MAX_ROWS
        msg = f"Import would write more than {limit} rows in total."
        base = 5  # the board, its membership and event, one column, one lane
        full = {"movements": [{}] * 2000}
        # 24 full entries plus one that lands the total exactly on the cap.
        last = {"movements": [{}] * (limit - base - 24 * 2000)}
        self.assertIsNone(_validate(deleted_card_history=[full] * 24 + [last]))
        over = {"movements": [{}] * (limit - base - 24 * 2000 + 1)}
        self.assertEqual(_validate(deleted_card_history=[full] * 24 + [over]), msg)
        # Movements and activities both count, and add up across entries.
        mixed = {"movements": [{}] * 2000, "activities": [{}] * 1000}
        self.assertEqual(_validate(deleted_card_history=[mixed] * 17), msg)
        self.assertIsNone(_validate(deleted_card_history=[mixed] * 16))
        acts_only = {"activities": [{}] * 3000}
        self.assertEqual(_validate(deleted_card_history=[acts_only] * 17), msg)

    def test_usernames(self):
        n = ie._field_max_length(get_user_model(), "username")
        self.assertIsNone(_validate(deleted_card_history=[{"movements": [{"moved_by": "x" * n}]}]))
        for child, key, label in (("movements", "moved_by", "movement"), ("activities", "actor", "activity")):
            with self.subTest(key=key):
                self.assertEqual(
                    _validate(deleted_card_history=[{child: [{key: "x" * (n + 1)}]}]),
                    f"{self.W}: '{key}' must be at most {n} characters",
                )
        # An unusable value earlier in the entry must not hide a long name after it.
        self.assertEqual(
            _validate(deleted_card_history=[{"movements": [{"moved_by": None}, {"moved_by": "x" * (n + 1)}]}]),
            f"{self.W}: 'moved_by' must be at most {n} characters",
        )

    def test_distinct_username_cap(self):
        top = ie._IMPORT_MAX_USERNAMES
        names = [{"moved_by": f"u{i}"} for i in range(top)]
        # Empty names are not usernames: exactly the cap, plus blanks, passes.
        self.assertIsNone(
            _validate(deleted_card_history=[{"movements": names + [{"moved_by": ""}, {"moved_by": None}]}])
        )
        self.assertIsNone(_validate(deleted_card_history=[{"activities": [{"actor": f"a{i}"} for i in range(top)]}]))
        self.assertEqual(
            _validate(deleted_card_history=[{"movements": names + [{"moved_by": "extra"}]}]),
            f"Import references more than {top} distinct usernames.",
        )
        # The cap is import-wide, across entries and across both child lists.
        self.assertEqual(
            _validate(deleted_card_history=[
                {"movements": names[: top // 2]},
                {"activities": [{"actor": f"a{i}"} for i in range(top // 2 + 1)]},
            ]),
            f"Import references more than {top} distinct usernames.",
        )


class CardCapTests(SimpleTestCase):
    def test_label_refs_cap(self):
        top = ie._IMPORT_MAX_LABEL_REFS_PER_CARD
        self.assertIsNone(_validate(cards=[_card(labels=["l"] * top)]))
        self.assertEqual(
            _validate(cards=[_card(labels=["l"] * (top + 1))]),
            f"Card at index 0: 'labels' has more than {top} entries",
        )

    def test_child_caps(self):
        for child, cap in ie._IMPORT_MAX_CHILDREN_PER_CARD.items():
            with self.subTest(child=child):
                self.assertIsNone(_validate(cards=[_card(**{child: [{}] * cap})]))
                self.assertEqual(
                    _validate(cards=[_card(**{child: [{}] * (cap + 1)})]),
                    f"Card at index 0: '{child}' has {cap + 1} entries; the limit is {cap}",
                )
