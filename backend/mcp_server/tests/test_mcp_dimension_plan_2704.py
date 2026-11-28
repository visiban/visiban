"""MCP ``set_dimension_plan`` write tool and the card's ``dimension_plans`` (#2704).

The tool speaks MCP's vocabulary (#512): the dimension is named by field name
and the owner by username, never by an internal id.
"""
from boards.models import CardActivity, CardDimensionPlan, CustomFieldDefinition
from boards.tests.conftest import _make_board, _make_card, _make_column, _make_swimlane, _make_user

from .test_mcp_crud import CrudToolsTestCase


class SetDimensionPlanToolTests(CrudToolsTestCase):
    def setUp(self):
        super().setUp()
        self.dim = CustomFieldDefinition.objects.create(
            board=self.board, name="Security", field_type="dropdown",
            choices_json=["Pending", "Approved"], is_dimension=True, position=0,
        )
        self.card = _make_card(self.column, self.swimlane, title="Plan me")

    def test_sets_the_plan_records_history_and_returns_the_card_with_the_plan(self):
        result = self._call(
            "set_dimension_plan", self.write_token, card_id=self.card.id, field="Security",
            owner=self.user.username.upper(), next_action="Book review", target_date="2026-12-01",
        )
        self.assertEqual(result["id"], self.card.id)
        plan = CardDimensionPlan.objects.get(card=self.card)
        self.assertEqual((plan.owner_id, plan.next_action, str(plan.target_date)),
                         (self.user.id, "Book review", "2026-12-01"))
        self.assertEqual(len(result["dimension_plans"]), 1)
        returned = result["dimension_plans"][0]
        self.assertEqual(returned["field"], {"id": self.dim.id, "uid": self.dim.uid, "name": "Security"})
        self.assertEqual(returned["owner"], {"username": self.user.username, "display_name": self.user.display_name})
        self.assertNotIn("id", returned["owner"])
        self.assertEqual((returned["next_action"], returned["target_date"]), ("Book review", "2026-12-01"))
        self.assertEqual(
            CardActivity.objects.filter(card=self.card, event_type__startswith="dimension_").count(), 3,
        )
        # list_cards carries the same shape, so an agent can discover the field name.
        listed = self._call("list_cards", self.write_token, board_id=self.board.id)
        row = next(c for c in listed if c["id"] == self.card.id)
        self.assertEqual(row["dimension_plans"], result["dimension_plans"])
        # A full replace: omitted arguments clear, all empty removes the plan.
        cleared = self._call("set_dimension_plan", self.write_token, card_id=self.card.id, field="Security")
        self.assertEqual(cleared["dimension_plans"], [])
        self.assertFalse(CardDimensionPlan.objects.exists())

    def test_empty_owner_leaves_the_plan_without_an_owner(self):
        result = self._call(
            "set_dimension_plan", self.write_token, card_id=self.card.id, field="Security",
            owner="", next_action="Chase",
        )
        self.assertIsNone(result["dimension_plans"][0]["owner"])
        self.assertIsNone(CardDimensionPlan.objects.get(card=self.card).owner_id)

    def test_empty_target_date_clears_it_and_a_malformed_one_is_still_refused(self):
        self._call(
            "set_dimension_plan", self.write_token, card_id=self.card.id, field="Security",
            next_action="Chase", target_date="2026-12-01",
        )
        result = self._call(
            "set_dimension_plan", self.write_token, card_id=self.card.id, field="Security",
            next_action="Chase", target_date="",
        )
        self.assertIsNone(result["dimension_plans"][0]["target_date"])
        self.assertIsNone(CardDimensionPlan.objects.get(card=self.card).target_date)
        # All three empty removes the plan, as documented.
        gone = self._call(
            "set_dimension_plan", self.write_token, card_id=self.card.id, field="Security",
            owner="", next_action="", target_date="",
        )
        self.assertEqual(gone["dimension_plans"], [])
        bad = self._call(
            "set_dimension_plan", self.write_token, card_id=self.card.id, field="Security",
            target_date="not-a-date",
        )
        self.assertEqual(bad["error"]["code"], "validation_error")
        self.assertIn("target_date", bad["error"]["errors"])

    def test_non_dimension_unknown_or_other_board_field_is_not_found(self):
        CustomFieldDefinition.objects.create(board=self.board, name="Notes", field_type="text", position=1)
        other_board = _make_board(_make_user("other2704"), name="Other")
        _make_column(other_board, name="C", order=0)
        _make_swimlane(other_board, name="S", order=0)
        CustomFieldDefinition.objects.create(
            board=other_board, name="Legal", field_type="dropdown",
            choices_json=["A"], is_dimension=True, position=0,
        )
        for name in ("Notes", "Legal", "Nope", "security"):
            result = self._call(
                "set_dimension_plan", self.write_token, card_id=self.card.id, field=name,
                next_action="x",
            )
            self.assertEqual(result["error"]["code"], "object_not_found", (name, result))
        self.assertFalse(CardDimensionPlan.objects.exists())

    def test_owner_who_is_not_an_assignable_member_is_a_validation_error(self):
        stranger = _make_user("stranger2704")
        viewer = self._add_member("viewer")
        inactive = self._add_member("member")
        inactive.is_active = False
        inactive.save(update_fields=["is_active"])
        for username in (stranger.username, viewer.username, inactive.username, "no-such-user"):
            result = self._call(
                "set_dimension_plan", self.write_token, card_id=self.card.id, field="Security",
                owner=username,
            )
            self.assertEqual(result["error"]["code"], "validation_error", (username, result))
            self.assertEqual(
                result["error"]["errors"], {"owner": ["No assignable board member has this username."]}, username,
            )
        self.assertFalse(CardDimensionPlan.objects.exists())

    def test_nul_in_field_or_owner_is_a_validation_error(self):
        for argument in ("field", "owner"):
            arguments = {"card_id": self.card.id, "field": "Security", argument: "Sec\x00"}
            result = self._call("set_dimension_plan", self.write_token, **arguments)
            self.assertEqual(result["error"]["code"], "validation_error", (argument, result))
            self.assertIn(argument, result["error"]["errors"])

    def test_viewer_is_denied(self):
        viewer = self._add_member("viewer")
        result = self._call(
            "set_dimension_plan", self._pat(viewer), card_id=self.card.id, field="Security",
            next_action="x",
        )
        self.assertEqual(result["error"]["code"], "permission_denied")
        self.assertFalse(CardDimensionPlan.objects.exists())

    def test_member_is_denied_on_a_card_someone_else_created(self):
        member = self._add_member("member")
        self.assertNotEqual(self.card.created_by_id, member.id)
        result = self._call(
            "set_dimension_plan", self._pat(member), card_id=self.card.id, field="Security",
            next_action="x",
        )
        self.assertEqual(result["error"]["code"], "permission_denied", result)
        self.assertFalse(CardDimensionPlan.objects.exists())
        self.assertFalse(CardActivity.objects.filter(card=self.card, event_type__startswith="dimension_").exists())

    def test_member_may_plan_a_card_they_created(self):
        member = self._add_member("member")
        own = _make_card(self.column, self.swimlane, title="Mine", created_by=member, position=1)
        result = self._call(
            "set_dimension_plan", self._pat(member), card_id=own.id, field="Security",
            owner=member.username, next_action="Mine to do",
        )
        self.assertEqual(result["dimension_plans"][0]["owner"]["username"], member.username)
