"""Mutation-gap tests for the export, CSV and Trello side of import_export.py (#2515).

Each assertion pins exact output (keys, values, messages, constants) so that a
string-literal, comparison or operator mutant of the weekly mutmut run (#1384)
fails here. Pure helpers are called directly; the export and import views go
through the API.
"""
import datetime
import io
import json
import os
import time
from types import SimpleNamespace
from unittest.mock import patch

from django.core.cache import cache
from django.test import SimpleTestCase
from django.utils import timezone

from boards.models import (
    BoardMembership, Card, CardActivity, CardBlock, CardGateTransition, CardMovement,
    CustomFieldDefinition,
)
from boards.tests.test_card_movement_retention import _BoardFixture
from boards.tests.test_import_history_attribution import URL as IMPORT_URL, _file
from boards.views import import_export as ie


class ModuleConstantTests(SimpleTestCase):
    def test_export_role_rank(self):
        R = BoardMembership.Role
        self.assertEqual(
            ie._EXPORT_ROLE_RANK,
            {R.VIEWER: 0, R.COLLABORATOR: 1, R.MEMBER: 2, R.ADMIN: 3},
        )

    def test_limits_and_patterns(self):
        self.assertEqual(ie._IMPORTED_NAME_MAX_SUFFIX, 12)
        self.assertEqual(ie._IMPORT_ACTIONS, frozenset({"import_board", "import_trello"}))
        self.assertEqual(ie._IMPORT_MAX_CHILDREN_PER_CARD["blocks"], 1000)
        self.assertEqual(ie._IMPORT_MAX_CHILDREN_PER_CARD["gate_transitions"], 2000)
        self.assertEqual(ie._IMPORT_MAX_DELETED_CARDS, 10000)
        self.assertEqual(ie._IMPORTED_FROM_MAX_LENGTH, 150)
        self.assertEqual(ie._CARD_UID_RE.pattern, "[0-9a-f]{16}")
        self.assertIsNotNone(ie._CARD_UID_RE.fullmatch("0123456789abcdef"))
        self.assertIsNone(ie._CARD_UID_RE.fullmatch("0123456789abcde"))
        self.assertIsNone(ie._CARD_UID_RE.fullmatch("0123456789abcdeg"))


class ExportTimestampTests(SimpleTestCase):
    NOW = datetime.datetime(2026, 1, 1, 23, 30, tzinfo=datetime.timezone.utc)

    def _stamp(self, user):
        with patch("django.utils.timezone.now", return_value=self.NOW):
            return ie._export_timestamp(user)

    def test_profile_timezone_is_used(self):
        self.assertEqual(self._stamp(SimpleNamespace(timezone="Asia/Tokyo")), "20260102-0830")

    def test_blank_and_unknown_timezone_fall_back_to_utc_not_local(self):
        old = os.environ.get("TZ")
        os.environ["TZ"] = "Asia/Tokyo"
        time.tzset()
        try:
            self.assertEqual(self._stamp(SimpleNamespace(timezone="")), "20260101-2330")
            self.assertEqual(self._stamp(SimpleNamespace(timezone="No/SuchZone")), "20260101-2330")
            self.assertEqual(self._stamp(SimpleNamespace(timezone="Asia/Tokyo")), "20260102-0830")
        finally:
            if old is None:
                os.environ.pop("TZ", None)
            else:
                os.environ["TZ"] = old
            time.tzset()


class PureHelperTests(SimpleTestCase):
    def test_blank(self):
        for value in ("", "  ", None, 5, [], {}):
            self.assertTrue(ie._blank(value), value)
        for value in ("a", " a ", "0"):
            self.assertFalse(ie._blank(value), value)

    def test_cap_warnings_boundary(self):
        twenty = [f"w{i}" for i in range(20)]
        self.assertEqual(ie._cap_warnings(twenty), twenty)
        twenty_one = twenty + ["w20"]
        self.assertEqual(ie._cap_warnings(twenty_one), twenty + ["…and 1 more"])

    def test_import_color_counts_each_rejected_color(self):
        skipped = {"colors": 2}
        self.assertEqual(ie._import_color({"color": "not-a-color"}, "#111111", skipped), "#111111")
        self.assertEqual(skipped, {"colors": 3})
        self.assertEqual(ie._import_color({}, "#222222", skipped), "#222222")
        self.assertEqual(skipped, {"colors": 3})

    def test_csv_custom_columns(self):
        card, lane, error, warnings = ie._csv_custom_columns([
            "Title", "Custom:", "Swimlane Custom:", "Custom:   ", "Custom: A", "Swimlane Custom: B",
        ])
        self.assertEqual(card, [("Custom: A", "A")])
        self.assertEqual(lane, [("Swimlane Custom: B", "B")])
        self.assertIsNone(error)
        self.assertEqual(warnings, [
            "Skipped column 'Custom:': the field name is empty.",
            "Skipped column 'Swimlane Custom:': the field name is empty.",
            "Skipped column 'Custom:   ': the field name is empty.",
        ])

    def test_csv_custom_columns_duplicate_header_error_names_the_kind(self):
        _, _, error, _ = ie._csv_custom_columns(["Custom: A", "Custom: A"])
        self.assertEqual(str(error), "Duplicate custom field CSV headers: Custom: A")

    def test_swimlane_values_from_rows(self):
        rows = [
            {"Swimlane": "", "Swimlane Custom: A": "ignored", "Swimlane Custom: B": "ignored"},
            {"Swimlane": "L", "Swimlane Custom: A": "", "Swimlane Custom: B": "b1"},
            {"Swimlane": "L", "Swimlane Custom: A": "a1", "Swimlane Custom: B": "b2"},
            {"Swimlane": "L", "Swimlane Custom: A": "a1", "Swimlane Custom: B": "b3"},
        ]
        values, warnings = ie._swimlane_values_from_rows(
            rows, [("Swimlane Custom: A", "A"), ("Swimlane Custom: B", "B")],
        )
        self.assertEqual(values, {"L": {"B": "b1", "A": "a1"}})
        self.assertEqual(warnings, ["Swimlane 'L' field 'B' has conflicting values; kept 'b1'."])

    def test_csv_cell_value_warnings(self):
        definition = SimpleNamespace(name="F")
        warnings = []
        self.assertIsNone(ie._csv_cell_value(definition, "a\x00b", "h", "Card 'X'", warnings))
        self.assertIsNone(ie._csv_cell_value(
            definition, "x" * (CustomFieldDefinition.MAX_VALUE_LENGTH + 1), "h", "Card 'X'", warnings,
        ))
        self.assertEqual(warnings, [
            "Card 'X' field 'F': value dropped (contains a NUL byte).",
            f"Card 'X' field 'F': value dropped (over {CustomFieldDefinition.MAX_VALUE_LENGTH} characters).",
        ])

    def test_csv_cell_value_not_accepted(self):
        definition = CustomFieldDefinition(name="N", field_type=CustomFieldDefinition.FieldType.NUMBER)
        warnings = []
        self.assertIsNone(ie._csv_cell_value(definition, "abc", "h", "Swimlane 'S'", warnings))
        self.assertEqual(warnings, ["Swimlane 'S' field 'N': value dropped (not accepted)."])

    def test_csv_custom_field_cell_checkbox_and_formula(self):
        T = CustomFieldDefinition.FieldType
        checkbox = SimpleNamespace(field_type=T.CHECKBOX)
        text = SimpleNamespace(field_type=T.TEXT)
        self.assertEqual(ie._csv_custom_field_cell(checkbox, "true"), "true")
        self.assertEqual(ie._csv_custom_field_cell(checkbox, "false"), "false")
        formula = ie._sanitize_csv_field("=cmd")
        self.assertNotEqual(formula, "=cmd")
        self.assertEqual(ie._csv_custom_field_cell(checkbox, "=cmd"), formula)
        self.assertEqual(ie._csv_custom_field_cell(text, "=cmd"), formula)

    def test_board_rows(self):
        data = {
            "columns": [{"sub_columns": [1, 2], "tracks": [1, 2, 3, 4]}],
            "swimlanes": [{"not_applicable_tracks": ["a", "b", "c"]}],
            "labels": [],
        }
        self.assertEqual(ie._board_rows(data), 3 + 1 + 1 + (2 + 4) + 3)

    def test_card_rows(self):
        self.assertEqual(ie._card_rows({"gate_transitions": [1, 2, 3]}), 1 + 3 + 2)
        self.assertEqual(ie._card_rows({"gate_transitions": [1, 2, 3], "blocks": [1]}), 1 + 1 + 3 + 2)

    def test_card_usernames_reads_every_child_list(self):
        card = {
            "assignee": "a",
            "checklist": [{"assignee": "c"}, {"assignee": ""}, {"assignee": 5}],
            "movements": [{"moved_by": "m"}],
            "activities": [{"actor": "x"}],
            "blocks": [{"blocked_by": "b", "unblocked_by": "u"}],
            "gate_transitions": [{"actor": "g"}],
        }
        self.assertEqual(list(ie._card_usernames(card)), [
            ("assignee", "a"), ("assignee", "c"), ("moved_by", "m"), ("actor", "x"),
            ("blocked_by", "b"), ("unblocked_by", "u"), ("actor", "g"),
        ])

    def test_fill_activity_snapshots(self):
        retained = SimpleNamespace(card_id=None, board_id="keep", card_uid="keep", card_title="keep")
        live = SimpleNamespace(card_id=5, board_id=None, card_uid="", card_title="")
        card = SimpleNamespace(board_id=9, uid="u" * 16, title="T")
        ie._fill_activity_snapshots([retained, live], {5: card})
        self.assertEqual((retained.board_id, retained.card_uid, retained.card_title), ("keep",) * 3)
        self.assertEqual((live.board_id, live.card_uid, live.card_title), (9, "u" * 16, "T"))
        via_attr = SimpleNamespace(card_id=5, card=card, board_id=None, card_uid="", card_title="")
        ie._fill_activity_snapshots([via_attr])
        self.assertEqual((via_attr.board_id, via_attr.card_uid, via_attr.card_title), (9, "u" * 16, "T"))

    def test_nullable_item_text(self):
        self.assertIsNone(ie._nullable_item_text(None))
        self.assertIsNone(ie._nullable_item_text("fine"))
        self.assertIsNotNone(ie._nullable_item_text(5))

    def test_write_guard_logs_unknown_line_when_no_importer_frame(self):
        with self.assertLogs(ie.logger, level="WARNING") as logs, patch.object(
            ie.traceback, "extract_tb", return_value=[],
        ):
            with self.assertRaises(Exception):
                with ie._json_import_write_guard():
                    raise ValueError("boom")
        self.assertIn("(unknown line)", logs.output[0])


class ExportJsonContentTests(_BoardFixture):
    def _export(self, **params):
        resp = self.client.get(f"/api/v1/boards/{self.board.pk}/export/", {"format": "json", **params})
        self.assertEqual(resp.status_code, 200, resp.content)
        return json.loads(resp.content)

    def test_blocks_gates_and_row_limit_columns(self):
        card = self._card("History card")
        t0 = timezone.now().replace(microsecond=0) - datetime.timedelta(days=3)
        # The later block is created first: export order is by time, not pk.
        late = CardBlock.objects.create(
            card=card, board=self.board, card_uid=card.uid, card_title=card.title,
            blocked_at=t0 + datetime.timedelta(hours=5), blocked_by=self.owner, reason="late",
            column_name="Done", imported_from_username="src",
        )
        early = CardBlock.objects.create(
            card=card, board=self.board, card_uid=card.uid, card_title=card.title,
            blocked_at=t0, blocked_by=self.owner, reason="early",
            unblocked_at=t0 + datetime.timedelta(hours=1), unblocked_by=self.owner,
            resolution="fixed", column_name="To Do",
        )
        mv = CardMovement.objects.create(
            card=card, board=self.board, card_uid=card.uid, card_title=card.title,
            from_column=self.col_todo, to_column=self.col_done, moved_by=self.owner,
            moved_at=t0,
        )
        g_late = CardGateTransition.objects.create(
            card=card, board=self.board, card_uid=card.uid, card_title=card.title,
            column=self.col_done, column_name="Done", sub_column_name="Review",
            kind="open", from_index=1, to_index=2, reason="late gate", cause="move",
            actor=self.owner, created_at=t0 + datetime.timedelta(hours=9), movement=mv,
            imported_from_username="gsrc",
        )
        g_early = CardGateTransition.objects.create(
            card=card, board=self.board, card_uid=card.uid, card_title=card.title,
            column=self.col_todo, column_name="To Do", sub_column_name="Dev",
            kind="pass", from_index=0, to_index=1, reason="early gate", cause="move",
            created_at=t0,
        )
        self.swim.limit_column_ids = [self.col_done.pk, 99999]
        self.swim.save()
        from boards.models import Swimlane
        Swimlane.objects.create(board=self.board, name="Stale", position=1, limit_column_ids=[99999])
        Swimlane.objects.create(board=self.board, name="Unset", position=2)

        data = self._export()
        [exported] = [c for c in data["cards"] if c["title"] == "History card"]
        self.assertEqual(exported["blocks"], [
            {
                "blocked_at": early.blocked_at.isoformat(), "blocked_by": "owner", "reason": "early",
                "unblocked_at": early.unblocked_at.isoformat(), "unblocked_by": "owner",
                "resolution": "fixed", "column": "To Do", "imported_from_username": None,
            },
            {
                "blocked_at": late.blocked_at.isoformat(), "blocked_by": "owner", "reason": "late",
                "unblocked_at": None, "unblocked_by": None,
                "resolution": late.resolution, "column": "Done", "imported_from_username": "src",
            },
        ])
        self.assertEqual(exported["gate_transitions"], [
            {
                "kind": "pass", "from_index": 0, "to_index": 1, "column": "To Do",
                "sub_column": "Dev", "reason": "early gate", "cause": "move", "actor": None,
                "created_at": g_early.created_at.isoformat(), "imported_from_username": None,
                "movement_index": None,
            },
            {
                "kind": "open", "from_index": 1, "to_index": 2, "column": "Done",
                "sub_column": "Review", "reason": "late gate", "cause": "move", "actor": "owner",
                "created_at": g_late.created_at.isoformat(), "imported_from_username": "gsrc",
                "movement_index": 0,
            },
        ])
        limits = {s["name"]: s["limit_columns"] for s in data["swimlanes"]}
        self.assertEqual(limits, {"General": ["Done"], "Stale": None, "Unset": None})


class DeletedCardHistoryExportTests(_BoardFixture):
    def _export(self):
        resp = self.client.get(f"/api/v1/boards/{self.board.pk}/export/", {"format": "json"})
        self.assertEqual(resp.status_code, 200, resp.content)
        return json.loads(resp.content)

    def _orphan_move(self, uid, title, at):
        # moved_at is auto_now_add, so pin the clock for the insert.
        with patch("django.utils.timezone.now", return_value=at):
            return CardMovement.objects.create(
                card=None, board=self.board, card_uid=uid, card_title=title,
                to_column=self.col_done, moved_by=self.owner,
            )

    def test_entries_use_newest_title_and_sort_by_earliest_row(self):
        now = timezone.now().replace(microsecond=0)
        past = now - datetime.timedelta(days=10)
        far = now + datetime.timedelta(days=3650)
        # Card "p": a single movement far in the future. Card "q": one older
        # movement and one activity. q's earliest row precedes p's, though
        # activities are read after movements.
        self._orphan_move("p" * 16, "P title", far)
        self._orphan_move("a" * 16, "Old name", past)
        self._orphan_move("a" * 16, "Newer name", past + datetime.timedelta(days=1))
        # Equal timestamps: the later row wins the title (>=, not >).
        tie = past + datetime.timedelta(days=2)
        self._orphan_move("b" * 16, "Tie first", tie)
        self._orphan_move("b" * 16, "Tie second", tie)
        act = CardActivity.objects.create(
            card=None, board=self.board, card_uid="a" * 16, card_title="Newest name",
            event_type=CardActivity.EventType.TITLE_CHANGE, actor=self.owner,
        )
        live = self._card("Live")
        CardMovement.objects.create(
            card=live, board=self.board, card_uid=live.uid, card_title="Live",
            to_column=self.col_done, moved_by=self.owner,
        )
        history = self._export()["deleted_card_history"]
        self.assertEqual([e["card_uid"] for e in history], ["a" * 16, "b" * 16, "p" * 16])
        by_uid = {e["card_uid"]: e for e in history}
        self.assertEqual(list(by_uid["a" * 16]), ["card_uid", "card_title", "movements", "activities"])
        self.assertEqual(by_uid["a" * 16]["card_title"], "Newest name")
        self.assertEqual(by_uid["b" * 16]["card_title"], "Tie second")
        self.assertEqual(len(by_uid["a" * 16]["movements"]), 2)
        self.assertEqual(len(by_uid["a" * 16]["activities"]), 1)
        self.assertEqual(by_uid["a" * 16]["activities"][0]["created_at"], act.created_at.isoformat())
        self.assertEqual(by_uid["a" * 16]["movements"][0]["moved_at"], past.isoformat())

    def test_live_card_movement_with_deleted_column_uses_snapshot_2052(self):
        card = self._card("Live")
        Card.objects.filter(pk=card.pk).update(column=self.col_done)
        CardMovement.objects.create(
            card=card, board=self.board, card_uid=card.uid, card_title="Live",
            from_column=self.col_todo, to_column=self.col_done, moved_by=self.owner,
            from_column_name="To Do", to_column_name="Done",
        )
        self.col_todo.delete()
        [exported] = [c for c in self._export()["cards"] if c["title"] == "Live"]
        self.assertEqual(exported["movements"][0]["from_column"], "To Do")
        self.assertEqual(exported["movements"][0]["to_column"], "Done")

    def test_deleted_column_snapshot_round_trips_through_import_2052(self):
        from django.core.cache import cache

        card = self._card("RT")
        Card.objects.filter(pk=card.pk).update(column=self.col_done)
        CardMovement.objects.create(
            card=card, board=self.board, card_uid=card.uid, card_title="RT",
            from_column=self.col_todo, to_column=self.col_done, moved_by=self.owner,
            from_column_name="To Do", to_column_name="Done",
        )
        self.col_todo.delete()
        data = self._export()
        data["name"] = "Round trip"
        cache.clear()
        resp = self.client.post(IMPORT_URL, {"file": _file(data)}, format="multipart")
        self.assertEqual(resp.status_code, 201, resp.content)
        imported = CardMovement.objects.filter(
            board_id=resp.json()["id"], card_title="RT", from_column_name="To Do",
        )
        self.assertEqual(imported.count(), 1)
        self.assertEqual(imported.get().to_column_name, "Done")

    def test_csv_history_uses_snapshot_for_deleted_column_2052(self):
        card = self._card("Csv")
        Card.objects.filter(pk=card.pk).update(column=self.col_done)
        CardMovement.objects.create(
            card=card, board=self.board, card_uid=card.uid, card_title="Csv",
            from_column=self.col_todo, to_column=self.col_done, moved_by=self.owner,
            from_column_name="To Do", to_column_name="Done",
        )
        self.col_todo.delete()
        resp = self.client.get(f"/api/v1/boards/{self.board.pk}/export/", {"format": "csv"})
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertIn("|To Do|Done|", resp.content.decode())

    def test_live_card_movement_without_snapshot_stays_null(self):
        card = self._card("Live2")
        CardMovement.objects.create(
            card=card, board=self.board, card_uid=card.uid, card_title="Live2",
            from_column=None, to_column=self.col_done, moved_by=self.owner,
            to_column_name="Done",
        )
        [exported] = [c for c in self._export()["cards"] if c["title"] == "Live2"]
        self.assertIsNone(exported["movements"][0]["from_column"])


    def test_deleted_card_movement_falls_back_to_the_name_snapshots(self):
        CardMovement.objects.create(
            card=None, board=self.board, card_uid="d" * 16, card_title="Gone",
            from_column=self.col_todo, to_column=self.col_done, moved_by=self.owner,
            from_column_name="To Do", to_column_name="Done",
            from_swimlane_name="Old lane", to_swimlane_name="",
        )
        self.col_todo.delete()
        self.col_done.delete()
        [entry] = self._export()["deleted_card_history"]
        [mv] = entry["movements"]
        self.assertEqual(
            (mv["from_column"], mv["to_column"], mv["from_swimlane"], mv["to_swimlane"]),
            ("To Do", "Done", "Old lane", None),
        )


def _csv_file(text, name="board.csv"):
    f = io.BytesIO(text.encode("utf-8") if isinstance(text, str) else text)
    f.name = name
    return f


class _ImportFixture(_BoardFixture):
    def _post(self, f, **extra):
        cache.clear()
        return self.client.post(IMPORT_URL, {"file": f, **extra}, format="multipart")


class ImportBoardGapTests(_ImportFixture):
    def test_default_upload_cap_is_ten_megabytes(self):
        from django.conf import settings
        from django.core.files.uploadedfile import SimpleUploadedFile
        from django.test import override_settings

        with override_settings():
            del settings.MAX_UPLOAD_SIZE
            big = SimpleUploadedFile("big.json", b"x" * (10 * 1024 * 1024 + 1), "application/json")
            resp = self._post(big)
            self.assertEqual(resp.status_code, 400, resp.content)
            self.assertEqual(resp.json()["detail"], "File too large. Maximum size is 10 MB.")
            ok = self._post(_file({
                "name": "Small", "columns": [{"name": "A", "position": 0}],
                "swimlanes": [{"name": "L", "position": 0}], "labels": [], "cards": [],
            }))
            self.assertEqual(ok.status_code, 201, ok.content)

    def test_import_error_responses_are_declared_in_the_schema(self):
        from drf_spectacular.generators import SchemaGenerator

        schema = SchemaGenerator().get_schema(request=None, public=True)
        paths = schema["paths"]
        board_post = paths["/api/v1/boards/import/"]["post"]
        self.assertEqual(
            sorted(board_post["responses"]), ["201", "400", "401", "403", "404", "429"],
        )
        trello = paths["/api/v1/boards/import/trello/"]["post"]["responses"]
        self.assertEqual(sorted(trello), ["200", "201", "400", "401", "403", "404", "413", "429"])
        self.assertEqual(trello["200"]["description"], "Returned for ?dry_run=true.")
        self.assertEqual(trello["201"]["description"], "Returned for ?confirm=true.")
        history = paths["/api/v1/boards/{id}/export-history/"]["get"]["responses"]["200"]
        self.assertEqual(
            history["content"]["application/json"]["schema"],
            {"$ref": "#/components/schemas/PaginatedBoardExportLogList"},
        )


class CsvImportGapTests(_ImportFixture):
    HEADER = "Title,Column,Swimlane,Priority,Assignee,Weight,Due Date,Labels"

    def test_undecodable_file_is_invalid_file(self):
        resp = self._post(_csv_file(b"\xff\xfe\x00bad"))
        self.assertEqual(resp.status_code, 400, resp.content)
        self.assertEqual(resp.json()["code"], "invalid_file")
        self.assertTrue(resp.json()["detail"].startswith("Invalid CSV: "))

    def test_bad_custom_columns_name_the_list(self):
        long = "n" * 300
        resp = self._post(_csv_file(f"Title,Column,Swimlane,Custom: {long}\nT,C,S,v\n"))
        self.assertEqual(resp.status_code, 400, resp.content)
        self.assertTrue(resp.json()["detail"].startswith("'Custom columns' entry at index 0"), resp.json())
        resp = self._post(_csv_file(f"Title,Column,Swimlane,Swimlane Custom: {long}\nT,C,S,v\n"))
        self.assertEqual(resp.status_code, 400, resp.content)
        self.assertTrue(
            resp.json()["detail"].startswith("'Swimlane Custom columns' entry at index 0"), resp.json(),
        )

    def test_custom_columns_become_text_fields(self):
        resp = self._post(_csv_file("Title,Column,Swimlane,Custom: Env,Swimlane Custom: Site\nT,C,S,prod,eu\n"))
        self.assertEqual(resp.status_code, 201, resp.content)
        from boards.models import Board, SwimlaneCustomFieldDefinition
        board = Board.objects.get(pk=resp.json()["id"])
        [cf] = CustomFieldDefinition.objects.filter(board=board)
        self.assertEqual((cf.name, cf.field_type), ("Env", "text"))
        [sf] = SwimlaneCustomFieldDefinition.objects.filter(board=board)
        self.assertEqual((sf.name, sf.field_type), ("Site", "text"))

    def test_assignee_nul_is_rejected_by_name(self):
        resp = self._post(_csv_file(f"{self.HEADER}\nT,C,S,,bad\x00name,,,\n"))
        self.assertEqual(resp.status_code, 400, resp.content)
        self.assertEqual(resp.json()["detail"], "Row 2: Assignee contains a NUL byte.")

    def test_overlong_label_entry_is_reported_alone(self):
        long = "x" * 60
        resp = self._post(_csv_file(f"{self.HEADER}\nT,C,S,,,,,\"ok,{long}\"\n"))
        self.assertEqual(resp.status_code, 400, resp.content)
        self.assertEqual(
            resp.json()["detail"],
            f"Row 2: Labels entry exceeds 50 characters: {ie._bounded_text(long)!r}",
        )

    def test_invalid_explicit_name_is_invalid_name(self):
        resp = self._post(_csv_file(f"{self.HEADER}\nT,C,S,,,,,\n"), name="n" * 400)
        self.assertEqual(resp.status_code, 400, resp.content)
        self.assertEqual(resp.json()["code"], "invalid_name")
        self.assertTrue(resp.json()["detail"].startswith("'name' "), resp.json())

    def test_unknown_assignees_are_counted_per_row(self):
        text = f"{self.HEADER}\nA,C,S,,ghost,,,\nB,C,S,,ghost2,,,\nC,C,S,,,,,\n"
        resp = self._post(_csv_file(text))
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(resp.json()["import_summary"]["skipped"]["assignees"], 2)

    def test_defaults_priority_weight_and_warning_prefixes(self):
        text = (
            "Title,Column,Swimlane,Custom: F,Swimlane Custom: G\n"
            "My card,C,Lane one,a\x00b,c\x00d\n"
        )
        resp = self._post(_csv_file(text))
        self.assertEqual(resp.status_code, 201, resp.content)
        card = Card.objects.get(board_id=resp.json()["id"])
        self.assertEqual((card.priority, card.weight), ("medium", 1))
        warnings = resp.json()["import_summary"]["warnings"]
        self.assertIn("Card 'My card' field 'F': value dropped (contains a NUL byte).", warnings)
        self.assertIn("Swimlane 'Lane one' field 'G': value dropped (contains a NUL byte).", warnings)


class JsonImportHistoryGapTests(_ImportFixture):
    def _import(self, **card):
        data = {
            "name": "Hist",
            "columns": [{"name": "To Do", "position": 0}, {"name": "Done", "position": 1}],
            "swimlanes": [{"name": "General", "position": 0}],
            "labels": [],
            "cards": [{
                "title": "C", "column": "Done", "swimlane": "General", "position": 0, **card,
            }],
        }
        resp = self._post(_file(data))
        self.assertEqual(resp.status_code, 201, resp.content)
        from boards.models import Board
        return Board.objects.get(pk=resp.json()["id"])

    def test_movement_gate_counters_are_kept(self):
        board = self._import(movements=[{
            "from_column": "To Do", "to_column": "Done", "moved_by": "owner",
            "moved_at": "2024-03-04T05:06:07Z",
            "from_gates_passed": 1, "from_gates_open": 2, "to_gates_passed": 3,
        }])
        mv = CardMovement.objects.get(board=board)
        self.assertEqual((mv.from_gates_passed, mv.from_gates_open, mv.to_gates_passed), (1, 2, 3))

    def test_item_text_is_kept_only_for_item_text_event_types(self):
        item_type = sorted(CardActivity.ITEM_TEXT_EVENT_TYPES)[0]
        board = self._import(activities=[
            {"event_type": item_type, "from_value": "a", "to_value": "b", "actor": "owner",
             "created_at": "2024-03-04T06:00:00Z", "item_text": "Keep me"},
            {"event_type": "priority_change", "from_value": "low", "to_value": "high",
             "actor": "owner", "created_at": "2024-03-04T07:00:00Z", "item_text": "Drop me"},
        ])
        texts = {a.event_type: a.item_text for a in CardActivity.objects.filter(board=board)}
        self.assertEqual(texts[item_type], "Keep me")
        self.assertIsNone(texts["priority_change"])

    def test_block_rows_resolve_their_column(self):
        board = self._import(
            blocked_at="2024-03-05T00:00:00Z", blocked_reason="open now",
            blocks=[
                {"blocked_at": "2024-03-01T00:00:00Z", "unblocked_at": "2024-03-02T00:00:00Z",
                 "reason": "ghost col", "column": "Ghost"},
                {"blocked_at": "2024-03-03T00:00:00Z", "unblocked_at": "2024-03-04T00:00:00Z",
                 "reason": "no col"},
                {"blocked_at": "2024-03-05T00:00:00Z", "reason": "open now", "column": "To Do"},
            ],
        )
        todo = board.columns.get(name="To Do")
        done = board.columns.get(name="Done")
        rows = {b.reason: b for b in CardBlock.objects.filter(board=board)}
        ghost = rows["ghost col"]
        self.assertEqual((ghost.column, ghost.column_name, ghost.column_uid), (None, "Ghost", ""))
        nocol = rows["no col"]
        self.assertEqual((nocol.column_id, nocol.column_name, nocol.column_uid), (done.pk, "Done", done.uid))
        opened = rows["open now"]
        self.assertEqual((opened.column_id, opened.column_name, opened.column_uid), (todo.pk, "To Do", todo.uid))

    def test_open_block_without_a_history_entry_uses_the_cards_column(self):
        board = self._import(blocked_at="2024-03-05T00:00:00Z", blocked_reason="just blocked")
        done = board.columns.get(name="Done")
        [blk] = CardBlock.objects.filter(board=board)
        self.assertEqual((blk.column_id, blk.column_name, blk.column_uid), (done.pk, "Done", done.uid))


class TrelloImportGapTests(_BoardFixture):
    URL = "/api/v1/boards/import/trello/"

    def _upload(self, size_none=False, data=b"{}"):
        from django.core.files.uploadedfile import InMemoryUploadedFile, SimpleUploadedFile
        cache.clear()
        f = SimpleUploadedFile("t.json", data, "application/json")
        if size_none:
            with patch.object(InMemoryUploadedFile, "size", property(lambda s: None, lambda s, v: None)):
                return self.client.post(self.URL + "?dry_run=true", {"file": f}, format="multipart")
        return self.client.post(self.URL + "?dry_run=true", {"file": f}, format="multipart")

    def test_oversize_body_is_refused_even_when_the_reported_size_is_missing(self):
        from django.test import override_settings
        with override_settings(VISIBAN_IMPORT_MAX_SIZE=100):
            resp = self._upload(size_none=True, data=b"x" * 101)
        self.assertEqual(resp.status_code, 413, resp.content)

    def test_name_must_be_a_string(self):
        from django.core.files.uploadedfile import SimpleUploadedFile
        from django.http.request import QueryDict
        from django.utils.datastructures import MultiValueDict
        from rest_framework.parsers import DataAndFiles

        f = SimpleUploadedFile("t.json", b"{}", "application/json")
        data = QueryDict(mutable=True)
        data["name"] = 5
        parsed = DataAndFiles(data, MultiValueDict({"file": [f]}))
        # Stub the plan stage so the name check is reached: dry_run is off.
        from boards.services import trello_import as t
        with patch.object(ie.LimitedMultiPartParser, "parse", return_value=parsed), \
                patch.object(t, "parse_trello_export", return_value=object()), \
                patch.object(t, "parse_options", return_value=object()), \
                patch.object(t, "match_members", return_value=object()), \
                patch.object(t, "build_plan", return_value=SimpleNamespace(preview={})):
            cache.clear()
            resp = self.client.post(self.URL + "?confirm=true", {"file": f}, format="multipart")
        self.assertEqual(resp.status_code, 400, resp.content)
        self.assertEqual(resp.json(), {"detail": "'name' must be a string.", "code": "invalid_name"})
