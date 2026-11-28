"""Upper-bound entry requirements: ``lt`` ("is less than") and ``lte`` ("is at most") (#2718).

The pure comparisons are covered by the shared case table
(``frontend/src/test/fixtures/entry-requirements-cases.json``, asserted in
``test_entry_requirements_1923.SharedCaseTableTests``). This file covers the
server paths: the replace-all write, the three entry points (forward move,
create, restore), and the database rule.
"""

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError, transaction
from unittest.mock import patch

from boards.models import Card, ColumnEntryRequirement, CustomFieldDefinition, CustomFieldValue
from boards.services.entry_requirements import OPERATORS_BY_TYPE, condition_met

from .test_entry_requirements_1923 import PATCH_BROADCAST, _Fixture


class UpperBoundWriteTests(_Fixture):
    def _put(self, rows):
        url = f"/api/v1/boards/{self.board.pk}/columns/{self.dst.pk}/entry-requirements/"
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            return self._client(self.admin).put(url, {"requirements": rows}, format="json")

    def test_number_field_saves_lt_and_lte_with_their_operands(self):
        resp = self._put([
            {"field_uid": self.amount.uid, "operator": "lte", "operand": "20"},
            {"field_uid": self.amount.uid, "operator": "lt", "operand": "0.5"},
        ])
        self.assertEqual(resp.status_code, 200, resp.content)
        saved = [(r["operator"], r["operand"]) for r in resp.json()["entry_requirements"]]
        self.assertEqual(saved, [("lte", "20"), ("lt", "0.5")])

    def test_operand_less_upper_bound_is_refused(self):
        # The absent-input branch of _clean_operand: no operand is a 400, never a saved row.
        for operator in ("lt", "lte"):
            for body in ({}, {"operand": None}, {"operand": ""}, {"operand": "abc"}):
                with self.subTest(operator=operator, body=body):
                    resp = self._put([{"field_uid": self.amount.uid, "operator": operator, **body}])
                    self.assertEqual(resp.status_code, 400)
        self.assertFalse(ColumnEntryRequirement.objects.exists())

    def test_non_number_fields_refuse_lt_and_lte(self):
        text = CustomFieldDefinition.objects.create(board=self.board, name="Notes", field_type="text", position=1)
        multi = CustomFieldDefinition.objects.create(
            board=self.board, name="Tags", field_type="multi_select", position=2, choices_json=["a"],
        )
        for field in (text, multi):
            for operator in ("lt", "lte"):
                with self.subTest(field=field.field_type, operator=operator):
                    resp = self._put([{"field_uid": field.uid, "operator": operator, "operand": "1"}])
                    self.assertEqual(resp.status_code, 400)
        self.assertFalse(ColumnEntryRequirement.objects.exists())

    def test_number_type_error_lists_the_new_operators(self):
        resp = self._put([{"field_uid": self.amount.uid, "operator": "min_count", "operand": "1"}])
        self.assertEqual(resp.status_code, 400)
        self.assertIn("filled, gt, gte, lt, lte", str(resp.json()))


class UpperBoundEnforcementTests(_Fixture):
    def _set_amount(self, value, card=None):
        CustomFieldValue.objects.update_or_create(
            card=card or self.card, field_definition=self.amount, defaults={"value": value},
        )

    def test_forward_move_lte_passes_at_equal_and_lt_refuses_it(self):
        self._set_amount("20")
        req = self._require("block", operator="lte", operand=20)
        self.assertEqual(self._move(self.member).status_code, 200)
        # Back out, switch the rule to lt: the same value no longer passes.
        Card.objects.filter(pk=self.card.pk).update(column=self.src)
        req.operator = "lt"
        req.save(update_fields=["operator"])
        resp = self._move(self.member)
        self.assertEqual(resp.status_code, 409)
        self.assertEqual(resp.json()["unmet"][0]["operator"], "lt")
        self.assertEqual(resp.json()["unmet"][0]["operand"], "20")

    def test_forward_move_above_the_bound_is_refused(self):
        self._set_amount("20.5")
        self._require("block", operator="lte", operand=20)
        self.assertEqual(self._move(self.member).status_code, 409)

    def test_empty_value_fails_both_upper_bounds(self):
        for operator in ("lt", "lte"):
            with self.subTest(operator=operator):
                ColumnEntryRequirement.objects.all().delete()
                self._require("block", operator=operator, operand=20)
                resp = self._move(self.member)
                self.assertEqual(resp.status_code, 409)
                self.assertEqual(resp.json()["unmet"][0]["operator"], operator)

    def test_create_is_checked_against_an_upper_bound(self):
        self._require("block", operator="lte", operand=20)
        url = f"/api/v1/boards/{self.board.pk}/cards/"
        base = {"title": "New", "column": self.dst.pk, "swimlane": self.lane.pk}
        with patch(PATCH_BROADCAST):
            empty = self._client(self.member).post(url, base, format="json")
            above = self._client(self.member).post(url, {**base, "custom_field_values": [
                {"field_definition": self.amount.pk, "value": "21"},
            ]}, format="json")
            ok = self._client(self.member).post(url, {**base, "custom_field_values": [
                {"field_definition": self.amount.pk, "value": "20"},
            ]}, format="json")
        self.assertEqual(empty.status_code, 409)
        self.assertEqual(above.status_code, 409)
        self.assertEqual(ok.status_code, 201, ok.content)

    def test_restore_is_checked_against_an_upper_bound(self):
        self.card.column = self.dst
        self.card.archived_at = self.card.created_at
        self.card.save(update_fields=["column", "archived_at"])
        self._set_amount("25")
        self._require("block", operator="lt", operand=20)
        url = f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/unarchive/"
        with patch(PATCH_BROADCAST):
            refused = self._client(self.admin).post(url, {}, format="json")
        self.assertEqual(refused.status_code, 409)
        self._set_amount("19")
        with patch(PATCH_BROADCAST):
            ok = self._client(self.admin).post(url, {}, format="json")
        self.assertEqual(ok.status_code, 200, ok.content)


class UpperBoundRuleTests(_Fixture):
    def test_condition_met_upper_bounds(self):
        self.assertTrue(condition_met(operator="lte", operand="20", field_type="number", value="20"))
        self.assertFalse(condition_met(operator="lt", operand="20", field_type="number", value="20"))
        # A missing operand never passes (fail closed), like gt/gte.
        self.assertFalse(condition_met(operator="lte", operand=None, field_type="number", value="1"))

    def test_only_number_fields_accept_upper_bounds(self):
        for field_type, ops in OPERATORS_BY_TYPE.items():
            with self.subTest(field_type=field_type):
                self.assertEqual("lt" in ops and "lte" in ops, field_type == "number")

    def test_database_requires_an_operand_for_upper_bounds(self):
        for kw in (
            {"field_definition": self.amount, "operator": "lt"},
            {"field_definition": self.amount, "operator": "lte"},
        ):
            with self.subTest(kw=str(kw)), self.assertRaises((IntegrityError, DjangoValidationError)):
                with transaction.atomic():
                    ColumnEntryRequirement.objects.create(column=self.dst, **kw)
        ColumnEntryRequirement.objects.create(column=self.dst, field_definition=self.amount, operator="lte", operand=5)

    def test_operand_constraint_matches_operand_operators(self):
        constraint = next(
            c for c in ColumnEntryRequirement._meta.constraints if c.name == "entry_req_operand_iff_needed_v2"
        )
        def operator_lists(node):
            for child in node.children:
                if isinstance(child, tuple):
                    if child[0] == "operator__in":
                        yield frozenset(child[1])
                else:
                    yield from operator_lists(child)

        expected = frozenset(str(op) for op in ColumnEntryRequirement.OPERAND_OPERATORS)
        lists = list(operator_lists(constraint.condition))
        self.assertEqual(len(lists), 2)  # the "needs" and the "refuses" halves
        self.assertEqual(set(lists), {expected})
