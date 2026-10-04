"""Selective board import: the ``options`` field of ``POST /boards/import/`` (#119).

Each flag must gate both the rows it names *and* the activity rows the importer
auto-generates for them (LABEL_CHANGE for labels, CHECKLIST_ITEM_ADDED for
checklist items), otherwise a "skipped" element still leaves a trace on the card.
"""

import io
import json

from django.test import TestCase
from drf_spectacular.generators import SchemaGenerator
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from groups.models import Group
from boards import broadcast as _broadcast
from boards.models import (
    Board, BoardEvent, BoardMembership, Card, CardActivity, CardChecklist, CardComment, CardMovement,
    Column, Label, Swimlane,
)

_URL = "/api/v1/boards/import/"
_ALL_ON = {"labels": True, "cards": True, "comments": True, "checklist": True, "history": True}
_NO_SKIPS = {
    "cards": 0, "comments": 0, "checklist_items": 0, "label_refs": 0,
    "movements": 0, "activities": 0,
}


def _json_file(data, filename="board.json"):
    f = io.BytesIO(json.dumps(data).encode("utf-8"))
    f.name = filename
    return f


def _csv_file(content, filename="board.csv"):
    f = io.BytesIO(content.encode("utf-8"))
    f.name = filename
    return f


def _board_data():
    """Two cards, each with labels, comments, checklist items, movements and activities."""
    def card(title, assignee, labels, weight=1):
        return {
            "title": title,
            "column": "To Do",
            "swimlane": "General",
            "assignee": assignee,
            "labels": labels,
            "weight": weight,
            "comments": [{"body": "c1"}, {"body": "c2"}],
            "checklist": [{"text": "a"}, {"text": "b"}, {"text": "c"}],
            "movements": [{"from_column": "To Do", "to_column": "Done", "moved_by": "alice"}],
            "activities": [
                {"event_type": "priority_change", "from_value": "low", "to_value": "high"},
                # Unknown event types are dropped by the importer regardless of
                # options, so they never count as "skipped".
                {"event_type": "not_a_real_event"},
            ],
        }

    return {
        "name": "Selective",
        "columns": [{"name": "To Do", "position": 0}, {"name": "Done", "position": 1}],
        "swimlanes": [{"name": "General", "position": 0}],
        "labels": [{"name": "Bug", "color": "#EF4444"}, {"name": "Feature", "color": "#3B82F6"}],
        "cards": [
            # A non-default weight makes the importer record a WEIGHT_CHANGE entry.
            card("One", "alice", ["Bug", "Feature"], weight=3),
            # "Ghost" is not a defined label: dropped regardless, never counted.
            card("Two", "nobody-by-this-name", ["Bug", "Ghost"]),
        ],
    }


class _ImportOptionsBase(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="importer", password="pass")
        self.alice = User.objects.create_user(username="alice", password="pass")
        self.client.force_authenticate(self.user)

    def _post(self, data=None, options=None, file=None):
        payload = {"file": file or _json_file(data or _board_data())}
        if options is not None:
            payload["options"] = options if isinstance(options, str) else json.dumps(options)
        return self.client.post(_URL, payload, format="multipart")

    def _board(self, resp):
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.data)
        return Board.objects.get(pk=resp.data["id"])

    def _counts(self, board):
        return {
            "columns": Column.objects.filter(board=board).count(),
            "swimlanes": Swimlane.objects.filter(board=board).count(),
            "labels": Label.objects.filter(board=board).count(),
            "cards": Card.objects.filter(board=board).count(),
            "card_labels": Card.labels.through.objects.filter(card__board=board).count(),
            "comments": CardComment.objects.filter(card__board=board).count(),
            "checklist": CardChecklist.objects.filter(card__board=board).count(),
            "movements": CardMovement.objects.filter(card__board=board).count(),
            "label_change": CardActivity.objects.filter(
                card__board=board, event_type=CardActivity.EventType.LABEL_CHANGE).count(),
            "checklist_added": CardActivity.objects.filter(
                card__board=board, event_type=CardActivity.EventType.CHECKLIST_ITEM_ADDED).count(),
            "imported_activities": CardActivity.objects.filter(
                card__board=board, event_type=CardActivity.EventType.PRIORITY_CHANGE).count(),
            "weight_change": CardActivity.objects.filter(
                card__board=board, event_type=CardActivity.EventType.WEIGHT_CHANGE).count(),
        }


class ImportOptionsDefaultTests(_ImportOptionsBase):
    FULL = {
        "columns": 2, "swimlanes": 1, "labels": 2, "cards": 2, "card_labels": 3,
        "comments": 4, "checklist": 6, "movements": 2, "label_change": 2,
        "checklist_added": 6, "imported_activities": 2, "weight_change": 1,
    }

    def _row_snapshot(self, board):
        """Content of every imported row, without ids or timestamps."""
        return {
            "labels": sorted(Label.objects.filter(board=board).values_list("name", "color")),
            "cards": sorted(Card.objects.filter(board=board).values_list(
                "title", "assignee__username", "weight", "priority")),
            "comments": sorted(CardComment.objects.filter(card__board=board).values_list(
                "card__title", "body", "author__username")),
            "checklist": sorted(CardChecklist.objects.filter(card__board=board).values_list(
                "card__title", "text", "position")),
            "activities": sorted(CardActivity.objects.filter(card__board=board).values_list(
                "card__title", "event_type", "from_value", "to_value", "actor__username")),
            "movements": sorted(CardMovement.objects.filter(card__board=board).values_list(
                "card__title", "from_column_name", "to_column_name", "moved_by__username")),
        }

    def test_no_options_imports_everything(self):
        resp = self._post()
        board = self._board(resp)
        self.assertEqual(self._counts(board), self.FULL)
        self.assertEqual(resp.data["import_summary"]["options_applied"], _ALL_ON)
        self.assertEqual(resp.data["import_summary"]["skipped"], _NO_SKIPS)

    def test_no_options_matches_explicit_all_true_and_empty_object(self):
        baseline = self._row_snapshot(self._board(self._post()))
        for options in (_ALL_ON, {}, ""):
            with self.subTest(options=options):
                self.assertEqual(self._row_snapshot(self._board(self._post(options=options))), baseline)

    def test_board_body_stays_at_top_level(self):
        resp = self._post()
        self.assertEqual(resp.data["name"], "Imported: Selective")
        self.assertIn("id", resp.data)
        self.assertNotIn("board", resp.data)


class ImportOptionsFlagTests(_ImportOptionsBase):
    def test_labels_off(self):
        resp = self._post(options={"labels": False})
        c = self._counts(self._board(resp))
        self.assertEqual((c["labels"], c["card_labels"], c["label_change"]), (0, 0, 0))
        self.assertEqual((c["cards"], c["comments"], c["checklist"]), (2, 4, 6))
        # Bug+Feature on card One, Bug on card Two; the undefined "Ghost" is not counted.
        self.assertEqual(resp.data["import_summary"]["skipped"]["label_refs"], 3)

    def test_checklist_off(self):
        resp = self._post(options={"checklist": False})
        c = self._counts(self._board(resp))
        self.assertEqual((c["checklist"], c["checklist_added"]), (0, 0))
        self.assertEqual((c["comments"], c["label_change"], c["movements"]), (4, 2, 2))
        self.assertEqual(resp.data["import_summary"]["skipped"]["checklist_items"], 6)

    def test_comments_off(self):
        resp = self._post(options={"comments": False})
        c = self._counts(self._board(resp))
        self.assertEqual(c["comments"], 0)
        self.assertEqual((c["checklist"], c["movements"]), (6, 2))
        self.assertEqual(resp.data["import_summary"]["skipped"]["comments"], 4)

    def test_history_off(self):
        resp = self._post(options={"history": False})
        c = self._counts(self._board(resp))
        self.assertEqual((c["movements"], c["imported_activities"], c["weight_change"]), (0, 0, 0))
        # Label/checklist auto-activities follow their own options, not history.
        self.assertEqual((c["label_change"], c["checklist_added"]), (2, 6))
        skipped = resp.data["import_summary"]["skipped"]
        self.assertEqual((skipped["movements"], skipped["activities"]), (2, 2))

    def test_weight_change_entry_follows_history(self):
        on = self._counts(self._board(self._post(options={"comments": False})))
        self.assertEqual(on["weight_change"], 1)
        off = self._counts(self._board(self._post(options={"history": False})))
        self.assertEqual(off["weight_change"], 0)
        self.assertEqual(off["cards"], 2)

    def test_cards_off_imports_structure_and_labels_only(self):
        resp = self._post(options={"cards": False})
        c = self._counts(self._board(resp))
        self.assertEqual((c["columns"], c["swimlanes"], c["labels"]), (2, 1, 2))
        for key in ("cards", "card_labels", "comments", "checklist", "movements",
                    "label_change", "checklist_added", "imported_activities", "weight_change"):
            self.assertEqual(c[key], 0, key)
        summary = resp.data["import_summary"]
        self.assertEqual(summary["options_applied"], {
            "labels": True, "cards": False, "comments": False, "checklist": False, "history": False,
        })
        self.assertEqual(summary["skipped"], {
            "cards": 2, "comments": 4, "checklist_items": 6, "label_refs": 3,
            "movements": 2, "activities": 2,
        })
        self.assertEqual(resp.data["card_count"], 0)

    def test_dependents_explicitly_false_with_cards_off_is_valid(self):
        resp = self._post(options={"cards": False, "comments": False, "checklist": False, "history": False})
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

    def test_everything_off_is_structure_only(self):
        resp = self._post(options={"cards": False, "labels": False})
        c = self._counts(self._board(resp))
        self.assertEqual((c["columns"], c["swimlanes"], c["labels"], c["cards"]), (2, 1, 0, 0))

    def test_event_payload_carries_import_options(self):
        with self.captureOnCommitCallbacks(execute=False):
            resp = self._post(options={"history": False})
        event = BoardEvent.objects.get(board_id=resp.data["id"], event=_broadcast.EVT_BOARD_CREATED)
        self.assertEqual(event.data["import_options"], {**_ALL_ON, "history": False})
        self.assertEqual(event.data["name"], "Imported: Selective")

    def test_event_payload_carries_default_import_options(self):
        with self.captureOnCommitCallbacks(execute=False):
            resp = self._post()
        event = BoardEvent.objects.get(board_id=resp.data["id"], event=_broadcast.EVT_BOARD_CREATED)
        self.assertEqual(event.data["import_options"], _ALL_ON)


class ImportOptionsValidationTests(_ImportOptionsBase):
    def _assert_400(self, options, file=None, fragment=None):
        before = Board.objects.count()
        resp = self._post(options=options, file=file)
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST, resp.data)
        self.assertIn("detail", resp.data)
        if fragment:
            self.assertIn(fragment, resp.data["detail"])
        self.assertEqual(Board.objects.count(), before)

    def test_explicit_contradiction_is_rejected(self):
        self._assert_400({"cards": False, "comments": True}, fragment="comments")
        self._assert_400({"cards": False, "history": True, "checklist": True}, fragment="require 'cards'")

    def test_unknown_key_is_rejected(self):
        self._assert_400({"members": False}, fragment="members")

    def test_non_bool_values_are_rejected(self):
        for value in ("false", 0, 1, None, [], {}):
            with self.subTest(value=value):
                self._assert_400({"labels": value}, fragment="labels")

    def test_malformed_json_is_rejected(self):
        self._assert_400("{labels: false", fragment="not valid JSON")

    def test_non_object_is_rejected(self):
        for raw in ("[]", "true", '"labels"', "3"):
            with self.subTest(raw=raw):
                self._assert_400(raw, fragment="JSON object")

    def test_csv_rejects_json_only_keys(self):
        for key in ("comments", "checklist", "history"):
            with self.subTest(key=key):
                self._assert_400(
                    {key: False}, file=_csv_file("Title,Column,Swimlane\nA,To Do,General\n"),
                    fragment=key,
                )


class ImportOptionsCSVTests(_ImportOptionsBase):
    CSV = (
        "Title,Column,Swimlane,Labels\n"
        'A,To Do,General,"Bug,Feature"\n'
        "B,Done,General,Bug\n"
        "C,Done,General,\n"
    )

    def test_csv_labels_off(self):
        resp = self._post(options={"labels": False}, file=_csv_file(self.CSV))
        c = self._counts(self._board(resp))
        self.assertEqual((c["cards"], c["labels"], c["card_labels"], c["label_change"]), (3, 0, 0, 0))
        self.assertEqual(resp.data["import_summary"]["skipped"], {**_NO_SKIPS, "label_refs": 3})

    def test_csv_cards_off(self):
        resp = self._post(options={"cards": False}, file=_csv_file(self.CSV))
        c = self._counts(self._board(resp))
        self.assertEqual((c["columns"], c["swimlanes"], c["labels"], c["cards"]), (2, 1, 2, 0))
        summary = resp.data["import_summary"]
        self.assertEqual(summary["skipped"], {**_NO_SKIPS, "cards": 3, "label_refs": 3})
        self.assertEqual(summary["options_applied"], {
            "labels": True, "cards": False, "comments": False, "checklist": False, "history": False,
        })

    def test_csv_no_options_imports_everything(self):
        resp = self._post(file=_csv_file(self.CSV))
        c = self._counts(self._board(resp))
        self.assertEqual((c["cards"], c["labels"], c["card_labels"], c["label_change"]), (3, 2, 3, 2))
        self.assertEqual(resp.data["import_summary"], {"options_applied": _ALL_ON, "skipped": _NO_SKIPS})


class ImportOptionsAccessTests(_ImportOptionsBase):
    """Options change what is imported, never who can reach the new board."""

    CSV = "Title,Column,Swimlane,Labels\nA,To Do,General,Bug\n"
    ALL_OFF_JSON = {"labels": False, "cards": False, "comments": False, "checklist": False, "history": False}
    ALL_OFF_CSV = {"labels": False, "cards": False}

    def _assert_importer_is_admin(self, resp):
        board = self._board(resp)
        self.assertTrue(BoardMembership.objects.filter(
            board=board, user=self.user, role=BoardMembership.Role.ADMIN,
        ).exists())
        self.assertEqual(board.owner, self.user)

    def test_json_partial_imports_keep_importer_admin(self):
        for options in ({"cards": False}, self.ALL_OFF_JSON):
            with self.subTest(options=options):
                self._assert_importer_is_admin(self._post(options=options))

    def test_csv_partial_imports_keep_importer_admin(self):
        for options in ({"cards": False}, self.ALL_OFF_CSV):
            with self.subTest(options=options):
                self._assert_importer_is_admin(self._post(options=options, file=_csv_file(self.CSV)))

    def test_non_member_of_group_gets_403_with_valid_options(self):
        outsider_owner = User.objects.create_user(username="owner", password="pass")
        group = Group.objects.create(name="Private", owner=outsider_owner)
        before = Board.objects.count()
        resp = self.client.post(_URL, {
            "file": _json_file(_board_data()),
            "group_id": group.pk,
            "options": json.dumps({"cards": False}),
        }, format="multipart")
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(Board.objects.count(), before)

    def test_invalid_options_create_no_board(self):
        before = Board.objects.count()
        for raw in ("{bad", "[]", json.dumps({"x": True}), json.dumps({"cards": "no"})):
            with self.subTest(raw=raw):
                resp = self._post(options=raw)
                self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Board.objects.count(), before)


class ImportSchemaTests(TestCase):
    def test_schema_declares_201_and_400_and_options(self):
        schema = SchemaGenerator().get_schema(request=None, public=True)
        op = schema["paths"][_URL]["post"]
        self.assertIn("201", op["responses"])
        self.assertIn("400", op["responses"])
        self.assertNotIn("200", op["responses"])
        props = op["requestBody"]["content"]["multipart/form-data"]["schema"]["properties"]
        self.assertEqual(set(props), {"file", "name", "group_id", "options"})
