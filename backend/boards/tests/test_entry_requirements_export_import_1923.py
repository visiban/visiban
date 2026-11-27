"""#1923: entry requirements through JSON export and import.

Requirements travel by field and field set name plus ``entry_enforcement``;
the assignee-override switch rides along. Unknown names are skipped with a
warning, malformed rows are a 400, imports are exempt from enforcement, and no
``CardOverride`` is imported.
"""

import io
import json
from unittest.mock import patch

from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, CardOverride, Column, ColumnEntryRequirement,
    CustomFieldDefinition, CustomFieldSet, Swimlane,
)

PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"


class EntryRequirementsExportImportTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(username="eri_admin", password="pass")
        self.board = Board.objects.create(name="Source", owner=self.admin, allow_assignee_override=True)
        BoardMembership.objects.create(board=self.board, user=self.admin, role=BoardMembership.Role.ADMIN)
        self.src = Column.objects.create(board=self.board, name="Discovery", position=0, allow_card_creation=True)
        self.dst = Column.objects.create(board=self.board, name="Proposal", position=1)
        Swimlane.objects.create(board=self.board, name="Enterprise", position=0)
        self.amount = CustomFieldDefinition.objects.create(
            board=self.board, name="Amount", field_type="number", position=0,
        )
        self.champion = CustomFieldDefinition.objects.create(
            board=self.board, name="Champion", field_type="text", position=1,
        )
        self.meddic = CustomFieldSet.objects.create(board=self.board, name="MEDDIC", position=0)
        CustomFieldDefinition.objects.filter(pk=self.champion.pk).update(field_set=self.meddic)
        ColumnEntryRequirement.objects.create(
            column=self.dst, field_definition=self.amount, operator="gt", operand="50000.5", position=0,
        )
        ColumnEntryRequirement.objects.create(
            column=self.dst, field_set=self.meddic, operator="set_complete", position=1,
        )
        self.dst.entry_enforcement = "block"
        self.dst.save(update_fields=["entry_enforcement"])
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def _export(self):
        r = self.client.get(f"/api/v1/boards/{self.board.id}/export/?format=json")
        self.assertEqual(r.status_code, 200)
        return json.loads(r.content)

    def _import(self, data):
        f = io.BytesIO(json.dumps(data).encode())
        f.name = "board.json"
        with patch(PATCH_BROADCAST):
            return self.client.post("/api/v1/boards/import/", {"file": f}, format="multipart")

    def test_export_carries_requirements_by_name(self):
        data = self._export()
        self.assertEqual(data["schema_version"], 2)
        self.assertIs(data["allow_assignee_override"], True)
        discovery, proposal = data["columns"]
        self.assertEqual((discovery["entry_enforcement"], discovery["entry_requirements"]), (None, []))
        self.assertEqual(proposal["entry_enforcement"], "block")
        self.assertEqual(proposal["entry_requirements"], [
            {"field": "Amount", "field_set": None, "operator": "gt", "operand": "50000.5"},
            {"field": None, "field_set": "MEDDIC", "operator": "set_complete", "operand": None},
        ])

    def test_round_trip_restores_requirements_mode_and_switch(self):
        r = self._import(self._export())
        self.assertEqual(r.status_code, 201, r.data)
        self.assertNotIn("warnings", r.data["import_summary"])
        board = Board.objects.get(pk=r.data["id"])
        self.assertTrue(board.allow_assignee_override)
        dst = board.columns.get(name="Proposal")
        self.assertEqual(dst.entry_enforcement, "block")
        reqs = list(dst.entry_requirements.order_by("position"))
        self.assertEqual([x.operator for x in reqs], ["gt", "set_complete"])
        self.assertEqual(reqs[0].field_definition.name, "Amount")
        self.assertEqual(reqs[0].field_definition.board_id, board.pk)
        self.assertEqual(str(reqs[0].operand), "50000.500000")
        self.assertEqual(reqs[1].field_set.name, "MEDDIC")
        self.assertEqual(reqs[1].field_set.board_id, board.pk)
        self.assertIsNone(board.columns.get(name="Discovery").entry_enforcement)

    def test_older_file_without_the_keys_imports_with_enforcement_off(self):
        data = self._export()
        del data["allow_assignee_override"]
        for col in data["columns"]:
            del col["entry_enforcement"], col["entry_requirements"]
        r = self._import(data)
        self.assertEqual(r.status_code, 201, r.data)
        board = Board.objects.get(pk=r.data["id"])
        self.assertFalse(board.allow_assignee_override)
        self.assertFalse(ColumnEntryRequirement.objects.filter(column__board=board).exists())
        self.assertFalse(board.columns.exclude(entry_enforcement=None).exists())

    def test_unknown_names_are_skipped_with_a_warning(self):
        data = self._export()
        data["columns"][1]["entry_requirements"][0]["field"] = "Nope"
        r = self._import(data)
        self.assertEqual(r.status_code, 201, r.data)
        [warning] = r.data["import_summary"]["warnings"]
        self.assertIn("Proposal", warning)
        self.assertIn("Nope", warning)
        dst = Board.objects.get(pk=r.data["id"]).columns.get(name="Proposal")
        self.assertEqual(dst.entry_requirements.get().operator, "set_complete")
        self.assertEqual(dst.entry_enforcement, "block")

    def test_invalid_operator_for_field_type_is_skipped_with_a_warning(self):
        data = self._export()
        # "min_count" is a known operator but not a number-field one; the PUT refuses it.
        data["columns"][1]["entry_requirements"][0]["operator"] = "min_count"
        data["columns"][1]["entry_requirements"][0]["operand"] = 2
        r = self._import(data)
        self.assertEqual(r.status_code, 201, r.data)
        [warning] = r.data["import_summary"]["warnings"]
        self.assertIn("Proposal", warning)
        dst = Board.objects.get(pk=r.data["id"]).columns.get(name="Proposal")
        self.assertEqual(dst.entry_requirements.get().operator, "set_complete")

    def test_min_count_operand_below_one_or_fractional_is_skipped(self):
        CustomFieldDefinition.objects.create(
            board=self.board, name="Tags", field_type="multi_select", position=2, choices_json=["a", "b"],
        )
        for bad in (0, 0.5, -3):
            with self.subTest(operand=bad):
                data = self._export()
                data["columns"][1]["entry_requirements"][0]["operator"] = "min_count"
                data["columns"][1]["entry_requirements"][0]["field"] = "Tags"
                data["columns"][1]["entry_requirements"][0]["operand"] = bad
                r = self._import(data)
                self.assertEqual(r.status_code, 201, r.data)
                self.assertEqual(len(r.data["import_summary"]["warnings"]), 1)

    def test_a_column_with_every_requirement_skipped_imports_with_enforcement_off(self):
        data = self._export()
        for req in data["columns"][1]["entry_requirements"]:
            if req["field"]:
                req["field"] = "Nope"
            else:
                req["field_set"] = "Nope"
        r = self._import(data)
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(len(r.data["import_summary"]["warnings"]), 2)
        dst = Board.objects.get(pk=r.data["id"]).columns.get(name="Proposal")
        self.assertIsNone(dst.entry_enforcement)
        self.assertFalse(dst.entry_requirements.exists())

    def test_import_is_exempt_from_enforcement_and_imports_no_override_log(self):
        """Rule 14: a card already past an unmet Block column imports as it was."""
        Card.objects.create(
            board=self.board, column=self.dst, swimlane=self.board.swimlanes.get(), title="Past the gate",
            created_by=self.admin, position=0,
        )
        CardOverride.objects.create(
            board=self.board, kind="entry_requirements", actor=self.admin, reason="because", unmet=[],
        )
        data = self._export()
        self.assertNotIn("card_overrides", json.dumps(data))
        r = self._import(data)
        self.assertEqual(r.status_code, 201, r.data)
        board = Board.objects.get(pk=r.data["id"])
        self.assertEqual(board.cards.get().column.name, "Proposal")
        self.assertFalse(CardOverride.objects.filter(board=board).exists())

    def test_malformed_entries_are_a_400(self):
        bad_cases = {
            "mode": lambda d: d["columns"][1].update(entry_enforcement="strict"),
            "not a list": lambda d: d["columns"][1].update(entry_requirements="x"),
            "over cap": lambda d: d["columns"][1].update(entry_requirements=[
                {"field": "Amount", "operator": "filled"}] * (ColumnEntryRequirement.MAX_PER_COLUMN + 1)),
            "entry not an object": lambda d: d["columns"][1].update(entry_requirements=["x"]),
            "unknown operator": lambda d: d["columns"][1]["entry_requirements"][0].update(operator="eq"),
            "both targets": lambda d: d["columns"][1]["entry_requirements"][0].update(field_set="MEDDIC"),
            "set_complete with a field": lambda d: d["columns"][1]["entry_requirements"][1].update(field="Amount"),
            "no target": lambda d: d["columns"][1]["entry_requirements"][0].update(field=None),
            "blank name": lambda d: d["columns"][1]["entry_requirements"][0].update(field=" "),
            "missing operand": lambda d: d["columns"][1]["entry_requirements"][0].update(operand=None),
            "operand not numeric": lambda d: d["columns"][1]["entry_requirements"][0].update(operand="lots"),
            "operand boolean": lambda d: d["columns"][1]["entry_requirements"][0].update(operand=True),
            "operand too large": lambda d: d["columns"][1]["entry_requirements"][0].update(operand="1e20"),
            "operand not ignored": lambda d: d["columns"][1]["entry_requirements"][1].update(operand="1"),
            "switch": lambda d: d.update(allow_assignee_override="yes"),
        }
        for name, mutate in bad_cases.items():
            with self.subTest(name):
                data = self._export()
                mutate(data)
                before = Board.objects.count()
                r = self._import(data)
                self.assertEqual(r.status_code, 400, r.content)
                self.assertEqual(Board.objects.count(), before)

    def test_numeric_operand_is_accepted(self):
        data = self._export()
        data["columns"][1]["entry_requirements"][0]["operand"] = 100
        r = self._import(data)
        self.assertEqual(r.status_code, 201, r.data)
        req = Board.objects.get(pk=r.data["id"]).columns.get(name="Proposal").entry_requirements.get(operator="gt")
        self.assertEqual(int(req.operand), 100)
