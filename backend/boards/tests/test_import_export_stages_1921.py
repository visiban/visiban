"""Gated stages and stage tracks through JSON export, import and templates (#1102, #1921).

Export carries sub-columns, tracks, lane exceptions, dimension field config,
``gates_passed`` and gate history; import restores them (gate history behind
the ``history`` option, attributed to the importer per Rule 5); a file from
before 1.3 without any of these keys still imports.
"""

import io
import json

from django.core.cache import cache
from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardTemplate, Card, CardGateTransition, Column, CustomFieldDefinition, StageTrack,
    SubColumn, Swimlane, SwimlaneTrackException,
)
from boards.tests.conftest import _make_board
from boards.utils import create_template_columns

URL = "/api/v1/boards/import/"


def _file(data):
    f = io.BytesIO(json.dumps(data).encode("utf-8"))
    f.name = "board.json"
    return f


class StageImportExportTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="owner1921ie", password="pass")
        self.client.force_authenticate(self.user)
        self.board = _make_board(self.user)
        self.stage = Column.objects.create(board=self.board, name="Build", position=0)
        self.done = Column.objects.create(board=self.board, name="Done", position=1)
        self.subs = [
            SubColumn.objects.create(column=self.stage, position=i, name=n)
            for i, n in enumerate(["Doing", "Review", "Ready"])
        ]
        self.lane = Swimlane.objects.create(board=self.board, name="Lane", position=0)
        self.dim = CustomFieldDefinition.objects.create(
            board=self.board, name="Security", field_type="dropdown",
            choices_json=["Done", "Not applicable"], is_dimension=True,
            choice_resolutions={"Done": "satisfied", "Not applicable": "not_applicable"},
        )
        StageTrack.objects.create(column=self.stage, field_definition=self.dim, position=0)
        SwimlaneTrackException.objects.create(swimlane=self.lane, field_definition=self.dim)
        self.card = Card.objects.create(
            board=self.board, column=self.stage, swimlane=self.lane, title="C",
            created_by=self.user, position=0, gates_passed=1,
        )
        CardGateTransition.objects.create(
            card=self.card, column=self.stage, column_name="Build", sub_column_name="Review",
            sub_column_uid=self.subs[1].uid, kind="pass", from_index=0, to_index=1,
            reason="looks good", actor=self.user,
        )

    def _export(self):
        resp = self.client.get(f"/api/v1/boards/{self.board.pk}/export/?format=json")
        self.assertEqual(resp.status_code, 200)
        return json.loads(resp.content)

    def _import(self, data, status_code=201, **extra):
        cache.clear()
        resp = self.client.post(URL, {"file": _file(data), **extra}, format="multipart")
        self.assertEqual(resp.status_code, status_code, resp.content)
        return resp

    def test_export_carries_stage_keys(self):
        data = self._export()
        build = next(c for c in data["columns"] if c["name"] == "Build")
        self.assertEqual(build["sub_columns"], ["Doing", "Review", "Ready"])
        self.assertEqual(build["tracks"], ["Security"])
        self.assertEqual(next(c for c in data["columns"] if c["name"] == "Done")["sub_columns"], [])
        self.assertEqual(data["swimlanes"][0]["not_applicable_tracks"], ["Security"])
        field = data["custom_fields"][0]
        self.assertTrue(field["is_dimension"])
        self.assertEqual(field["choice_resolutions"]["Done"], "satisfied")
        card = data["cards"][0]
        self.assertEqual(card["gates_passed"], 1)
        [gt] = card["gate_transitions"]
        self.assertEqual(
            (gt["kind"], gt["from_index"], gt["to_index"], gt["sub_column"], gt["actor"]),
            ("pass", 0, 1, "Review", "owner1921ie"),
        )

    def test_round_trip_restores_stage_structure_and_gate_history(self):
        data = self._export()
        board = Board.objects.get(pk=self._import(data).data["id"])
        stage = board.columns.get(name="Build")
        self.assertEqual(list(stage.sub_columns.values_list("name", flat=True)), ["Doing", "Review", "Ready"])
        field = board.custom_field_definitions.get(name="Security")
        self.assertTrue(field.is_dimension)
        self.assertEqual(field.choice_resolutions["Not applicable"], "not_applicable")
        self.assertEqual(list(stage.stage_tracks.values_list("field_definition", flat=True)), [field.pk])
        lane = board.swimlanes.get(name="Lane")
        self.assertTrue(SwimlaneTrackException.objects.filter(swimlane=lane, field_definition=field).exists())
        card = Card.objects.get(board=board)
        self.assertEqual(card.gates_passed, 1)
        gt = CardGateTransition.objects.get(card=card)
        # Rule 5: the importer is the actor; the file's name is kept as text.
        self.assertEqual((gt.actor, gt.imported_from_username), (self.user, "owner1921ie"))
        self.assertEqual((gt.board_id, gt.column_id, gt.sub_column_uid), (board.pk, stage.pk, stage.sub_columns.get(name="Review").uid))
        self.assertEqual((gt.kind, gt.cause, gt.reason), ("pass", "move", "looks good"))

    def test_history_off_skips_gate_rows_but_keeps_gates_passed(self):
        board = Board.objects.get(pk=self._import(self._export(), options=json.dumps({"history": False})).data["id"])
        card = Card.objects.get(board=board)
        self.assertEqual(card.gates_passed, 1)
        self.assertFalse(CardGateTransition.objects.filter(card=card).exists())

    def test_pre_13_file_without_stage_keys_imports(self):
        data = self._export()
        for col in data["columns"]:
            del col["sub_columns"], col["tracks"]
        del data["swimlanes"][0]["not_applicable_tracks"]
        for key in ("is_dimension", "choice_resolutions"):
            del data["custom_fields"][0][key]
        del data["cards"][0]["gates_passed"], data["cards"][0]["gate_transitions"]
        board = Board.objects.get(pk=self._import(data).data["id"])
        self.assertFalse(SubColumn.objects.filter(column__board=board).exists())
        self.assertEqual(Card.objects.get(board=board).gates_passed, 0)

    def test_invalid_stage_keys_are_400(self):
        cases = [
            (lambda d: d["columns"][0].update(sub_columns=["Only"]), "sub_columns"),
            (lambda d: d["columns"][0].update(sub_columns=["A", "A"]), "sub_columns"),
            (lambda d: d["columns"][0].update(tracks=["Nope"]), "not a dimension"),
            (lambda d: d["swimlanes"][0].update(not_applicable_tracks=[1]), "not_applicable_tracks"),
            (lambda d: d["cards"][0].update(gates_passed=3), "gates_passed"),
            (lambda d: d["cards"][0].update(column="Done", gates_passed=1), "gates_passed"),
            (lambda d: d["cards"][0].update(gates_passed=True), "gates_passed"),
            (lambda d: d["cards"][0]["gate_transitions"][0].update(actor=["x"]), "actor"),
            (lambda d: d["cards"][0]["gate_transitions"][0].update(created_at="nope"), "created_at"),
        ]
        before = Board.objects.count()
        for mutate, needle in cases:
            data = self._export()
            mutate(data)
            resp = self._import(data, status_code=400)
            self.assertIn(needle, resp.data["detail"])
        self.assertEqual(Board.objects.count(), before)

    def test_unknown_gate_kind_is_skipped_and_unknown_cause_becomes_import(self):
        data = self._export()
        gt = data["cards"][0]["gate_transitions"][0]
        data["cards"][0]["gate_transitions"] = [
            {**gt, "kind": "teleport"}, {**gt, "cause": ["x"]},
        ]
        board = Board.objects.get(pk=self._import(data).data["id"])
        [row] = CardGateTransition.objects.filter(board_id=board.pk)
        self.assertEqual(row.cause, "import")


class TemplateStageTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="tmpl1921", password="pass")

    def test_template_carries_sub_columns_and_tracks(self):
        template = BoardTemplate.objects.create(
            name="Stage template", slug="stage-template-1921", description="d",
            columns_json=[
                {"name": "Build", "sub_columns": ["Doing", "Review"], "tracks": ["Security", "Docs"]},
                {"name": "Ship", "sub_columns": ["Only one"], "tracks": ["Security", 7]},
                {"name": "Done", "is_done": True},
            ],
        )
        board = Board.objects.create(name="From stage template", owner=self.user)
        create_template_columns(board, template)
        build, ship = board.columns.get(name="Build"), board.columns.get(name="Ship")
        self.assertEqual(list(build.sub_columns.values_list("name", flat=True)), ["Doing", "Review"])
        # A single sub-column is not a stage: dropped, not a failed creation.
        self.assertFalse(ship.sub_columns.exists())
        fields = {f.name: f for f in board.custom_field_definitions.all()}
        self.assertEqual(set(fields), {"Security", "Docs"})
        self.assertTrue(all(f.is_dimension for f in fields.values()))
        self.assertEqual(
            list(build.stage_tracks.values_list("field_definition__name", flat=True)), ["Security", "Docs"],
        )
        # Shared by name: Ship's "Security" track is the same dimension.
        self.assertEqual(ship.stage_tracks.get().field_definition_id, fields["Security"].pk)
