"""MCP ``set_dimension_plan`` write tool (#2704)."""
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

    def test_sets_the_plan_records_history_and_returns_the_card(self):
        result = self._call(
            "set_dimension_plan", self.write_token, card_id=self.card.id, field_id=self.dim.id,
            owner_id=self.user.id, next_action="Book review", target_date="2026-12-01",
        )
        self.assertEqual(result["id"], self.card.id)
        plan = CardDimensionPlan.objects.get(card=self.card)
        self.assertEqual((plan.owner_id, plan.next_action, str(plan.target_date)),
                         (self.user.id, "Book review", "2026-12-01"))
        self.assertEqual(
            CardActivity.objects.filter(card=self.card, event_type__startswith="dimension_").count(), 3,
        )
        # A full replace: omitted arguments clear, all empty removes the plan.
        self._call("set_dimension_plan", self.write_token, card_id=self.card.id, field_id=self.dim.id)
        self.assertFalse(CardDimensionPlan.objects.exists())

    def test_non_dimension_or_other_board_field_is_not_found(self):
        plain = CustomFieldDefinition.objects.create(board=self.board, name="Notes", field_type="text", position=1)
        other_board = _make_board(_make_user("other2704"), name="Other")
        _make_column(other_board, name="C", order=0)
        _make_swimlane(other_board, name="S", order=0)
        foreign = CustomFieldDefinition.objects.create(
            board=other_board, name="Security", field_type="dropdown",
            choices_json=["A"], is_dimension=True, position=0,
        )
        for field in (plain, foreign):
            result = self._call(
                "set_dimension_plan", self.write_token, card_id=self.card.id, field_id=field.id,
                next_action="x",
            )
            self.assertEqual(result["error"]["code"], "object_not_found", result)
        self.assertFalse(CardDimensionPlan.objects.exists())

    def test_owner_outside_the_board_is_a_validation_error(self):
        stranger = _make_user("stranger2704")
        result = self._call(
            "set_dimension_plan", self.write_token, card_id=self.card.id, field_id=self.dim.id,
            owner_id=stranger.id,
        )
        self.assertEqual(result["error"]["code"], "validation_error")
        self.assertIn("owner_id", result["error"]["errors"])

    def test_viewer_is_denied(self):
        viewer = self._add_member("viewer")
        result = self._call(
            "set_dimension_plan", self._pat(viewer), card_id=self.card.id, field_id=self.dim.id,
            next_action="x",
        )
        self.assertEqual(result["error"]["code"], "permission_denied")
        self.assertFalse(CardDimensionPlan.objects.exists())
