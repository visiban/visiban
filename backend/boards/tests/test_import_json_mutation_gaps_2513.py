"""Exact-value assertions for ``_import_json`` in ``boards/views/import_export.py`` (#2513).

The weekly mutation run left 184 survivors inside ``_import_json``: the date
anchor and shift options, the per-child validation messages and timestamp
checks, the structure rows (policy, sub-columns, row limits, stage tracks),
the checklist assignee resolution, the gate-transition rows, and the retained
history of deleted cards. Each test pins a persisted value or a response body
the mutant's change would alter, so none of them asserts a bare status code.
"""

import datetime
import json

from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board,
    BoardMembership,
    Card,
    CardActivity,
    CardBlock,
    CardChecklist,
    CardComment,
    CardGateTransition,
    CardMovement,
    Column,
    CustomFieldDefinition,
    Swimlane,
    SubColumn,
    StageTrack,
    SwimlaneTrackException,
)
from boards.serializers import ImportDateAnchorSerializer, shift_today
from boards.views.import_export import _bounded_repr

URL = "/api/v1/boards/import/"


def _payload(**over):
    data = {
        "schema_version": 2,
        "name": "Imported 2513",
        "columns": [
            {"name": "Todo", "position": 0},
            {"name": "Done", "position": 1, "is_done": True},
        ],
        "swimlanes": [{"name": "Lane", "position": 0}],
        "cards": [{"title": "C1", "column": "Todo", "swimlane": "Lane"}],
    }
    data.update(over)
    return data


class _ImportCase(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="imp2513", password="pass")
        self.client.force_authenticate(self.user)

    def post(self, data, options=None):
        cache.clear()
        body = {"file": SimpleUploadedFile("b.json", json.dumps(data).encode(), "application/json")}
        if options is not None:
            body["options"] = json.dumps(options)
        return self.client.post(URL, body, format="multipart")

    def ok(self, data, options=None):
        resp = self.post(data, options)
        self.assertEqual(resp.status_code, 201, resp.content)
        return resp, Board.objects.get(pk=resp.data["id"])

    def bad(self, data, detail, options=None):
        resp = self.post(data, options)
        self.assertEqual(resp.status_code, 400, resp.content)
        self.assertEqual(resp.data["detail"], detail)


class DateAnchorShiftTests(_ImportCase):
    def _dated(self, **extra):
        card = {"title": "D", "column": "Todo", "swimlane": "Lane", "due_date": "2026-01-11"}
        return _payload(cards=[card], **extra)

    def test_file_anchor_shifts_dates_and_is_reported(self):
        resp, board = self.ok(self._dated(date_anchor="2026-01-01"))
        expected = shift_today() + datetime.timedelta(days=10)
        self.assertEqual(Card.objects.get(board=board).due_date, expected)
        applied = resp.data["import_summary"]["options_applied"]
        self.assertEqual(applied["shift_dates_from"], "2026-01-01")
        self.assertNotIn("shift_dates_to", applied)

    def test_shift_dates_false_opts_out(self):
        resp, board = self.ok(self._dated(date_anchor="2026-01-01"), {"shift_dates": False})
        self.assertEqual(Card.objects.get(board=board).due_date, datetime.date(2026, 1, 11))
        self.assertNotIn("shift_dates_from", resp.data["import_summary"]["options_applied"])

    def test_non_string_anchor_is_ignored(self):
        for anchor in (20260101, ["2026-01-01"], None):
            _, board = self.ok(self._dated(date_anchor=anchor))
            self.assertEqual(Card.objects.get(board=board).due_date, datetime.date(2026, 1, 11))

    def test_explicit_shift_from_wins_over_file_anchor(self):
        resp, board = self.ok(
            self._dated(date_anchor="2026-01-01"), {"shift_dates_from": "2026-01-10"}
        )
        self.assertEqual(
            Card.objects.get(board=board).due_date, shift_today() + datetime.timedelta(days=1)
        )
        self.assertEqual(
            resp.data["import_summary"]["options_applied"]["shift_dates_from"], "2026-01-10"
        )

    def test_invalid_anchor_is_400_with_exact_detail(self):
        for bad in ("2026-13-45", "not-a-date", "2999-01-01"):
            anchor = ImportDateAnchorSerializer(data={"date_anchor": bad})
            self.assertFalse(anchor.is_valid())
            self.bad(
                self._dated(date_anchor=bad),
                f"The file's 'date_anchor' is invalid: {anchor.errors['date_anchor'][0]} "
                "Send the import option shift_dates as false to import its dates as written.",
            )

    def test_shift_dates_to_picks_the_target_day_and_is_reported(self):
        resp, board = self.ok(
            self._dated(date_anchor="2026-01-01"), {"shift_dates_to": "2026-06-01"}
        )
        self.assertEqual(Card.objects.get(board=board).due_date, datetime.date(2026, 6, 11))
        applied = resp.data["import_summary"]["options_applied"]
        self.assertEqual(applied["shift_dates_to"], "2026-06-01")
        self.assertEqual(applied["shift_dates_from"], "2026-01-01")

    def test_unapplied_shift_dates_to_is_dropped_from_options_applied(self):
        baseline, _ = self.ok(_payload())
        for options in ({"shift_dates_to": "2026-06-01"}, {"shift_dates_to": "2026-06-01", "shift_dates": False}):
            resp, _ = self.ok(self._dated(date_anchor="2026-01-01"), options) if options.get("shift_dates") is False else self.ok(_payload(), options)
            applied = resp.data["import_summary"]["options_applied"]
            self.assertNotIn("shift_dates_to", applied)
            self.assertEqual(
                set(applied) - {"shift_dates"},
                set(baseline.data["import_summary"]["options_applied"]) - {"shift_dates"},
            )
            self.assertTrue(applied["history"])


class ChildValidationMessageTests(_ImportCase):
    LABELS = {
        "comments": "comment", "movements": "movement", "activities": "activity",
        "checklist": "checklist item", "blocks": "block", "gate_transitions": "gate transition",
    }
    STR_KEYS = {
        "movements": ("from_column", "to_column", "from_swimlane", "to_swimlane", "moved_by", "imported_from_username"),
        "activities": ("actor", "imported_from_username"),
        "blocks": ("blocked_by", "unblocked_by", "imported_from_username"),
        "comments": ("imported_from_username",),
        "checklist": ("assignee",),
        "gate_transitions": ("actor", "imported_from_username"),
    }

    def _card(self, **extra):
        return {"title": "C", "column": "Todo", "swimlane": "Lane", **extra}

    def test_non_string_name_keys_are_400_per_child_and_key(self):
        for child, keys in self.STR_KEYS.items():
            for key in keys:
                with self.subTest(child=child, key=key):
                    self.bad(
                        _payload(cards=[self._card(**{child: [{key: 123}]})]),
                        f"Card at index 0, {self.LABELS[child]} at index 0: '{key}' must be a string",
                    )

    def test_author_of_a_comment_is_never_type_checked(self):
        self.ok(_payload(cards=[self._card(comments=[{"body": "x", "author": 123}])]))

    def test_non_object_and_non_list_children_name_the_child(self):
        for child, label in self.LABELS.items():
            with self.subTest(child=child):
                self.bad(
                    _payload(cards=[self._card(**{child: ["x"]})]),
                    f"Card at index 0, {label} at index 0 must be an object",
                )
                self.bad(
                    _payload(cards=[self._card(**{child: "x"})]),
                    f"Card at index 0: '{child}' must be a list",
                )


class TimestampValidationMessageTests(_ImportCase):
    def _card(self, **extra):
        return {"title": "C", "column": "Todo", "swimlane": "Lane", **extra}

    def test_card_timestamps_name_the_key(self):
        for key in ("archived_at", "blocked_at"):
            self.bad(
                _payload(cards=[self._card(**{key: "nope"})]),
                f"Card at index 0: invalid timestamp for '{key}': {_bounded_repr('nope')}",
            )

    def test_checklist_due_date_names_item_and_value(self):
        cards = [self._card(checklist=[{"text": "ok"}, {"text": "bad", "due_date": "2026-02-30"}])]
        self.bad(
            _payload(cards=cards),
            "Card at index 0, checklist item at index 1: "
            f"invalid due_date: {_bounded_repr('2026-02-30')}",
        )

    def test_child_timestamps_name_child_index_and_key(self):
        cases = (
            ("comments", "comment", "created_at"),
            ("movements", "movement", "moved_at"),
            ("activities", "activity", "created_at"),
            ("blocks", "block", "blocked_at"),
            ("blocks", "block", "unblocked_at"),
            ("gate_transitions", "gate transition", "created_at"),
        )
        for child, label, key in cases:
            with self.subTest(child=child, key=key):
                self.bad(
                    _payload(cards=[self._card(**{child: [{}, {key: "nope"}]})]),
                    f"Card at index 0, {label} at index 1: invalid '{key}': {_bounded_repr('nope')}",
                )


class StructureValidationTests(_ImportCase):
    def test_lane_details_cap_is_read_from_the_file(self):
        resp = self.post(_payload(lane_details_cap="bad"))
        self.assertEqual(resp.status_code, 400)
        self.assertTrue(resp.data["detail"].startswith("'lane_details_cap' must be one of ["))

    def test_parent_setting_errors_use_the_detail_key(self):
        self.bad(_payload(parent_name_singular=5), "'parent_name_singular' must be a string.")
        self.bad(
            _payload(cards_can_have_children="yes"), "'cards_can_have_children' must be true or false."
        )

    def test_tracks_must_name_a_dimension_field(self):
        plain = {"name": "Plain", "field_type": "text"}
        dim = {"name": "Dim", "field_type": "dropdown", "choices": ["a", "b"], "is_dimension": True,
               "choice_resolutions": {"a": "satisfied", "b": "not_applicable"}}
        cols = [{"name": "Todo", "position": 0, "tracks": ["Plain"]}, {"name": "Done", "position": 1}]
        self.bad(
            _payload(custom_fields=[plain, dim], columns=cols),
            "Column at index 0: 'tracks' references a field that is not a dimension in "
            f"'custom_fields': {_bounded_repr('Plain')}",
        )
        sw = [{"name": "Lane", "position": 0, "not_applicable_tracks": ["Plain"]}]
        self.bad(
            _payload(custom_fields=[plain, dim], swimlanes=sw),
            "Swimlane at index 0: 'not_applicable_tracks' references a field that is not a dimension in "
            f"'custom_fields': {_bounded_repr('Plain')}",
        )
        # Valid dimension names import, on both sides.
        cols = [{"name": "Todo", "position": 0, "tracks": ["Dim"]}, {"name": "Done", "position": 1}]
        sw = [{"name": "Lane", "position": 0, "not_applicable_tracks": ["Dim"]}]
        _, board = self.ok(_payload(custom_fields=[plain, dim], columns=cols, swimlanes=sw))
        self.assertEqual(
            list(StageTrack.objects.filter(column__board=board).values_list("column__name", "field_definition__name")),
            [("Todo", "Dim")],
        )
        self.assertEqual(
            list(SwimlaneTrackException.objects.filter(swimlane__board=board).values_list("swimlane__name", "field_definition__name", "created_by__username")),
            [("Lane", "Dim", "imp2513")],
        )
        self.assertEqual(
            CustomFieldDefinition.objects.get(board=board, name="Dim").is_dimension, True
        )
        self.assertEqual(CustomFieldDefinition.objects.get(board=board, name="Plain").is_dimension, False)

    def test_column_without_a_name_is_not_matched_by_a_card(self):
        resp = self.post(_payload(columns=[{"position": 0}], cards=[{"title": "C", "column": "XXXX", "swimlane": "Lane"}]))
        self.assertEqual(resp.status_code, 400)
        self.assertFalse(Board.objects.filter(name="Imported 2513").exists())
        resp = self.post(_payload(swimlanes=[{"position": 0}], cards=[{"title": "C", "column": "Todo", "swimlane": "XXXX"}]))
        self.assertEqual(resp.status_code, 400)
        self.assertFalse(Board.objects.filter(name="Imported 2513").exists())


class StructureRowTests(_ImportCase):
    def test_column_policy_is_normalized_and_stored(self):
        cols = [
            {"name": "Todo", "position": 0, "policy": {"v": 1, "entry": ["  Ready  "], "done": [], "mode": "confirm"}},
            {"name": "Done", "position": 1},
        ]
        _, board = self.ok(_payload(columns=cols))
        todo = Column.objects.get(board=board, name="Todo")
        self.assertEqual(todo.policy["entry"], ["Ready"])
        self.assertEqual(todo.policy["mode"], "confirm")
        self.assertIsNone(Column.objects.get(board=board, name="Done").policy)

    def test_sub_columns_are_keyed_by_column_and_ordered(self):
        cols = [
            {"name": "Todo", "position": 0, "sub_columns": ["A", "B", "C"]},
            {"name": "Done", "position": 1, "sub_columns": ["X", "Y"]},
        ]
        _, board = self.ok(_payload(columns=cols))
        self.assertEqual(
            list(SubColumn.objects.filter(column__board=board).order_by("column__position", "position").values_list("column__name", "position", "name")),
            [("Todo", 0, "A"), ("Todo", 1, "B"), ("Todo", 2, "C"), ("Done", 0, "X"), ("Done", 1, "Y")],
        )

    def test_swimlane_row_limits_and_counted_columns_are_restored(self):
        sw = [{
            "name": "Lane", "position": 0, "wip_limit": 4, "weight_limit": 9,
            "limit_enforcement": "hard", "limit_columns": ["Done", "Todo", "Todo"],
        }, {"name": "Plain", "position": 1}]
        _, board = self.ok(_payload(swimlanes=sw))
        lane = Swimlane.objects.get(board=board, name="Lane")
        cols = {c.name: c.pk for c in Column.objects.filter(board=board)}
        self.assertEqual((lane.wip_limit, lane.weight_limit, lane.limit_enforcement), (4, 9, "hard"))
        self.assertEqual(lane.limit_column_ids, sorted([cols["Todo"], cols["Done"]]))
        plain = Swimlane.objects.get(board=board, name="Plain")
        self.assertEqual((plain.wip_limit, plain.weight_limit, plain.limit_enforcement, plain.limit_column_ids), (None, None, None, None))


class CardStateTests(_ImportCase):
    def _card(self, **extra):
        return {"title": "C", "column": "Todo", "swimlane": "Lane", **extra}

    def test_absent_priority_and_gates_default(self):
        _, board = self.ok(_payload(cards=[self._card()]))
        card = Card.objects.get(board=board)
        self.assertEqual((card.priority, card.gates_passed), ("medium", 0))

    def test_gates_passed_is_restored_on_a_staged_column(self):
        cols = [{"name": "Todo", "position": 0, "sub_columns": ["A", "B", "C"]}, {"name": "Done", "position": 1}]
        _, board = self.ok(_payload(columns=cols, cards=[self._card(gates_passed=2)]))
        self.assertEqual(Card.objects.get(board=board).gates_passed, 2)

    def test_blocked_state_is_restored_with_a_stripped_reason(self):
        card = self._card(blocked_at="2026-03-01T10:00:00Z", blocked_reason="  waiting on legal  ")
        _, board = self.ok(_payload(cards=[card]))
        restored = Card.objects.get(board=board)
        self.assertEqual(restored.blocked_at, datetime.datetime(2026, 3, 1, 10, 0, tzinfo=datetime.timezone.utc))
        self.assertEqual(restored.blocked_reason, "waiting on legal")
        self.assertEqual(CardBlock.objects.filter(card=restored, unblocked_at=None).count(), 1)

    def test_unblocked_card_has_no_blocked_state(self):
        _, board = self.ok(_payload(cards=[self._card()]))
        restored = Card.objects.get(board=board)
        self.assertIsNone(restored.blocked_at)
        self.assertFalse(restored.blocked_reason)


class ChecklistAssigneeTests(_ImportCase):
    def setUp(self):
        super().setUp()
        self.mate = User.objects.create_user(username="Mate2513", password="pass")
        shared = Board.objects.create(name="Shared", owner=self.user)
        for u in (self.user, self.mate):
            BoardMembership.objects.get_or_create(board=shared, user=u, defaults={"role": "member"})

    def _card(self, items):
        return {"title": "C", "column": "Todo", "swimlane": "Lane", "checklist": items}

    def test_known_assignee_is_resolved_and_unknown_is_counted(self):
        items = [
            {"text": "a", "assignee": "mate2513", "due_date": "2026-05-04"},
            {"text": "b", "assignee": "ghost"},
            {"text": "c", "assignee": "ghost2", "due_date": ""},
            {"text": "d"},
        ]
        resp, board = self.ok(_payload(cards=[self._card(items)]))
        rows = list(CardChecklist.objects.filter(card__board=board).order_by("position"))
        self.assertEqual([r.assignee_id for r in rows], [self.mate.pk, None, None, None])
        self.assertEqual(rows[0].due_date, datetime.date(2026, 5, 4))
        self.assertEqual([r.due_date for r in rows[1:]], [None, None, None])
        self.assertEqual(resp.data["import_summary"]["skipped"]["assignees"], 2)

    def test_known_assignee_alone_skips_nothing(self):
        resp, _ = self.ok(_payload(cards=[self._card([{"text": "a", "assignee": "mate2513"}])]))
        self.assertEqual(resp.data["import_summary"]["skipped"]["assignees"], 0)

    def test_checklist_off_ignores_assignees(self):
        resp, board = self.ok(
            _payload(cards=[self._card([{"text": "a", "assignee": "mate2513"}])]), {"checklist": False}
        )
        self.assertFalse(CardChecklist.objects.filter(card__board=board).exists())


class CommentAttributionTests(_ImportCase):
    def test_comment_author_is_kept_as_text_only(self):
        card = {"title": "C", "column": "Todo", "swimlane": "Lane", "comments": [
            {"body": "hi", "author": "alice"},
            {"body": "orig", "author": "bob", "imported_from_username": "carol"},
        ]}
        _, board = self.ok(_payload(cards=[card]))
        rows = list(CardComment.objects.filter(card__board=board).order_by("id"))
        self.assertEqual([r.imported_from_username for r in rows], ["alice", "carol"])
        self.assertEqual({r.author_id for r in rows}, {self.user.pk})


class GateTransitionTests(_ImportCase):
    def _gt(self, **extra):
        return {"kind": "pass", "cause": "move", "column": "Todo", "sub_column": "B",
                "from_index": 1, "to_index": 2, "reason": "ok", "actor": "zed",
                "created_at": "2026-02-03T04:05:06Z", **extra}

    def _import(self, transitions, movements=None):
        cols = [{"name": "Todo", "position": 0, "sub_columns": ["A", "B", "C"]}, {"name": "Done", "position": 1}]
        card = {"title": "C", "column": "Todo", "swimlane": "Lane", "gate_transitions": transitions}
        if movements is not None:
            card["movements"] = movements
        _, board = self.ok(_payload(columns=cols, cards=[card]))
        return board, list(CardGateTransition.objects.filter(board_id=board.pk).order_by("id"))

    def test_fields_are_restored_exactly(self):
        board, [row] = self._import([self._gt()])
        col = Column.objects.get(board=board, name="Todo")
        sub = SubColumn.objects.get(column=col, name="B")
        self.assertEqual(
            (row.kind, row.cause, row.column_id, row.column_name, row.column_uid),
            ("pass", "move", col.pk, "Todo", col.uid),
        )
        self.assertEqual((row.sub_column_name, row.sub_column_uid), ("B", sub.uid))
        self.assertEqual((row.from_index, row.to_index, row.reason), (1, 2, "ok"))
        self.assertEqual((row.imported_from_username, row.actor_id), ("zed", self.user.pk))
        self.assertEqual(row.created_at, datetime.datetime(2026, 2, 3, 4, 5, 6, tzinfo=datetime.timezone.utc))
        self.assertEqual(row.card_title, "C")

    def test_each_valid_kind_and_cause_is_kept(self):
        _, rows = self._import([
            self._gt(kind=kind, cause=cause)
            for kind in ("pass", "reopen")
            for cause in ("move", "stage_edited", "import")
        ])
        self.assertEqual(
            sorted((r.kind, r.cause) for r in rows),
            sorted((k, c) for k in ("pass", "reopen") for c in ("move", "stage_edited", "import")),
        )

    def test_invalid_kind_rows_are_skipped_but_later_rows_survive(self):
        for bad in ("Passed", None, 5, ["pass"], "pass "):
            _, rows = self._import([self._gt(kind=bad), self._gt(reason="kept")])
            self.assertEqual([r.reason for r in rows], ["kept"], bad)

    def test_invalid_cause_becomes_import(self):
        for bad in ("Move", None, "move ", 5):
            _, [row] = self._import([self._gt(cause=bad)])
            self.assertEqual(row.cause, "import", bad)
        no_cause = self._gt()
        del no_cause["cause"]
        _, [row] = self._import([no_cause])
        self.assertEqual(row.cause, "import")

    def test_absent_column_sub_column_and_numbers_use_blank_defaults(self):
        _, [row] = self._import([{"kind": "pass"}])
        self.assertIsNone(row.column_id)
        self.assertEqual(
            (row.column_name, row.column_uid, row.sub_column_name, row.sub_column_uid),
            ("", "", "", ""),
        )
        self.assertEqual((row.from_index, row.to_index, row.reason), (0, 0, ""))
        self.assertEqual(row.imported_from_username, "")

    def test_unknown_column_keeps_its_name_but_no_uid(self):
        _, [row] = self._import([self._gt(column="Gone", sub_column="B")])
        self.assertIsNone(row.column_id)
        self.assertEqual((row.column_name, row.column_uid, row.sub_column_name, row.sub_column_uid), ("Gone", "", "B", ""))

    def test_known_column_with_unknown_sub_column_has_no_sub_uid(self):
        _, [row] = self._import([self._gt(sub_column="Zzz")])
        self.assertEqual((row.sub_column_name, row.sub_column_uid), ("Zzz", ""))

    def test_missing_created_at_is_import_time(self):
        gt = self._gt()
        del gt["created_at"]
        before = datetime.datetime.now(datetime.timezone.utc)
        _, [row] = self._import([gt])
        self.assertGreaterEqual(row.created_at, before - datetime.timedelta(seconds=5))
        self.assertLessEqual(row.created_at, datetime.datetime.now(datetime.timezone.utc))

    def test_movement_index_links_only_in_range_integers(self):
        mvs = [{"from_column": "Todo", "to_column": "Done"}, {"from_column": "Done", "to_column": "Todo"}]
        _, rows = self._import(
            [self._gt(movement_index=i, reason=str(i)) for i in (0, 1, 2, None)], movements=mvs,
        )
        mv_ids = list(CardMovement.objects.filter(card__title="C").order_by("id").values_list("pk", flat=True))
        self.assertEqual(len(mv_ids), 2)
        links = {r.reason: r.movement_id for r in rows}
        self.assertEqual(links["0"], mv_ids[0])
        self.assertEqual(links["1"], mv_ids[1])
        self.assertEqual(links["2"], None)
        self.assertEqual(links["None"], None)

    def test_single_movement_links_index_zero_only(self):
        mvs = [{"from_column": "Todo", "to_column": "Done"}]
        _, rows = self._import(
            [self._gt(movement_index=0, reason="0"), self._gt(movement_index=1, reason="1")], movements=mvs
        )
        by_reason = {r.reason: r.movement_id for r in rows}
        self.assertIsNotNone(by_reason["0"])
        self.assertIsNone(by_reason["1"])

    def test_history_off_drops_gate_rows(self):
        cols = [{"name": "Todo", "position": 0, "sub_columns": ["A", "B"]}, {"name": "Done", "position": 1}]
        card = {"title": "C", "column": "Todo", "swimlane": "Lane", "gate_transitions": [self._gt()]}
        _, board = self.ok(_payload(columns=cols, cards=[card]), {"history": False})
        self.assertFalse(CardGateTransition.objects.filter(board_id=board.pk).exists())


class DeletedCardHistoryTests(_ImportCase):
    def _entry(self, **extra):
        return {
            "card_uid": "abcdef0123456789", "card_title": "Gone card",
            "movements": [{"from_column": "Todo", "to_column": "Done", "moved_at": "2026-01-02T03:04:05Z",
                           "moved_by": "dave"}],
            "activities": [
                {"event_type": "title_change", "from_value": "a", "to_value": "b",
                 "created_at": "2026-01-03T03:04:05Z", "actor": "erin"},
                {"event_type": "not_a_type", "from_value": "x"},
                {"from_value": "no-type"},
                {"event_type": ["x"]},
                {"event_type": "description_change", "from_value": "kept-after-skip"},
            ],
            **extra,
        }

    def test_rows_are_restored_with_identity_and_timestamps(self):
        _, board = self.ok(_payload(deleted_card_history=[self._entry()]))
        [mv] = CardMovement.objects.filter(board=board, card__isnull=True)
        self.assertEqual((mv.card_uid, mv.card_title, mv.board_id), ("abcdef0123456789", "Gone card", board.pk))
        self.assertEqual(mv.moved_at, datetime.datetime(2026, 1, 2, 3, 4, 5, tzinfo=datetime.timezone.utc))
        self.assertEqual((mv.from_column_name, mv.to_column_name, mv.imported_from_username), ("Todo", "Done", "dave"))
        acts = list(CardActivity.objects.filter(board_id=board.pk, card__isnull=True).order_by("id"))
        self.assertEqual([a.event_type for a in acts], ["title_change", "description_change"])
        self.assertEqual((acts[0].card_uid, acts[0].card_title, acts[0].board_id), ("abcdef0123456789", "Gone card", board.pk))
        self.assertEqual(acts[0].created_at, datetime.datetime(2026, 1, 3, 3, 4, 5, tzinfo=datetime.timezone.utc))
        self.assertEqual((acts[0].from_value, acts[0].to_value, acts[0].imported_from_username), ("a", "b", "erin"))
        self.assertEqual(acts[1].from_value, "kept-after-skip")

    def test_entry_without_identity_keys_gets_blank_snapshot(self):
        entry = {"movements": [{"from_column": "Todo", "to_column": "Done"}],
                 "activities": [{"event_type": "title_change"}]}
        _, board = self.ok(_payload(deleted_card_history=[entry]))
        mv = CardMovement.objects.get(board=board, card__isnull=True)
        act = CardActivity.objects.get(board_id=board.pk, card__isnull=True)
        self.assertEqual((mv.card_uid, mv.card_title, act.card_uid, act.card_title), ("", "", "", ""))

    def test_history_off_drops_deleted_card_rows(self):
        _, board = self.ok(_payload(deleted_card_history=[self._entry()]), {"history": False})
        self.assertFalse(CardMovement.objects.filter(board=board).exists())
        self.assertFalse(CardActivity.objects.filter(board_id=board.pk, card__isnull=True).exists())

    def test_live_card_activity_with_invalid_types_is_skipped(self):
        card = {"title": "C", "column": "Todo", "swimlane": "Lane", "activities": [
            {"event_type": "bogus"}, {"event_type": ["x"]}, {"event_type": "title_change", "from_value": "k"},
        ]}
        _, board = self.ok(_payload(cards=[card]))
        kept = CardActivity.objects.filter(card__board=board, from_value="k")
        self.assertEqual(kept.count(), 1)
        self.assertFalse(CardActivity.objects.filter(card__board=board, event_type="bogus").exists())


class SchemaVersionAndPriorityTests(_ImportCase):
    def test_schema_version_must_be_an_integer(self):
        for bad in ("2", 1.0, True, None):
            self.bad(_payload(schema_version=bad), "'schema_version' must be an integer.")

    def test_priority_is_restored_and_invalid_falls_back_to_medium(self):
        cards = [
            {"title": f"P{i}", "column": "Todo", "swimlane": "Lane", "priority": p}
            for i, p in enumerate(("high", "low", "urgent!", ["high"]))
        ]
        _, board = self.ok(_payload(cards=cards))
        got = dict(Card.objects.filter(board=board).values_list("title", "priority"))
        self.assertEqual(got, {"P0": "high", "P1": "low", "P2": "medium", "P3": "medium"})

    def test_auto_checklist_activity_carries_the_card_snapshot(self):
        card = {"title": "Snap", "column": "Todo", "swimlane": "Lane", "checklist": [{"text": "t"}]}
        _, board = self.ok(_payload(cards=[card]))
        restored = Card.objects.get(board=board)
        act = CardActivity.objects.get(card=restored, event_type="checklist_item_added")
        self.assertEqual((act.board_id, act.card_uid, act.card_title), (board.pk, restored.uid, "Snap"))
