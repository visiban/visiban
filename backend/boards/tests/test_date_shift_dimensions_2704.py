"""``shift_board_dates`` moves the dimension dates an export carries (#2651, #2703, #2704).

A shifted import must keep the spacing between a plan's target date, the
dimension's value change time, the history row that recorded the target date
and the card's own dates, so none of them is left on the source dates.
"""
from django.test import SimpleTestCase

from boards.services.date_shift import shift_board_dates


def _export():
    return {
        "custom_fields": [{"name": "Security", "field_type": "dropdown"}],
        "cards": [{
            "due_date": "2026-01-10",
            "custom_field_values": {"Security": "Pending"},
            "custom_field_values_changed_at": {
                "Security": "2026-01-02T09:30:00+00:00", "Legal": "not a date",
            },
            "dimension_plans": {
                "Security": {"owner": "kim", "next_action": "Book review", "target_date": "2026-01-15"},
                "Legal": {"owner": None, "next_action": "Chase", "target_date": None},
                "Broken": "not a plan",
            },
            "activities": [
                {
                    "event_type": "dimension_target_date_changed", "item_text": "Security",
                    "from_value": "", "to_value": "2026-01-15", "created_at": "2026-01-03T10:00:00+00:00",
                },
                {
                    "event_type": "dimension_next_action_changed", "item_text": "Security",
                    "from_value": "", "to_value": "2026-01-15", "created_at": "2026-01-03T10:00:00+00:00",
                },
            ],
        }],
    }


class ShiftDimensionDatesTests(SimpleTestCase):
    def test_dimension_dates_move_by_the_same_offset_as_the_card(self):
        card = shift_board_dates(_export(), 10)["cards"][0]
        self.assertEqual(card["due_date"], "2026-01-20")
        self.assertEqual(card["dimension_plans"]["Security"]["target_date"], "2026-01-25")
        self.assertIsNone(card["dimension_plans"]["Legal"]["target_date"])
        self.assertEqual(card["dimension_plans"]["Broken"], "not a plan")
        self.assertEqual(card["custom_field_values_changed_at"]["Security"], "2026-01-12T09:30:00+00:00")
        # A malformed value is left for the import validators, never a 500.
        self.assertEqual(card["custom_field_values_changed_at"]["Legal"], "not a date")
        target_row, action_row = card["activities"]
        self.assertEqual((target_row["from_value"], target_row["to_value"]), ("", "2026-01-25"))
        self.assertEqual(target_row["created_at"], "2026-01-13T10:00:00+00:00")
        # A next action is free text: never parsed as a date, even when it looks like one.
        self.assertEqual(action_row["to_value"], "2026-01-15")

    def test_negative_shift_moves_them_backward(self):
        card = shift_board_dates(_export(), -5)["cards"][0]
        self.assertEqual(card["dimension_plans"]["Security"]["target_date"], "2026-01-10")
        self.assertEqual(card["custom_field_values_changed_at"]["Security"], "2025-12-28T09:30:00+00:00")
        self.assertEqual(card["activities"][0]["to_value"], "2026-01-10")

    def test_absent_or_malformed_containers_are_left_alone(self):
        data = {"cards": [{"dimension_plans": ["x"], "custom_field_values_changed_at": "x"}, {}]}
        shift_board_dates(data, 3)
        self.assertEqual(data["cards"][0], {"dimension_plans": ["x"], "custom_field_values_changed_at": "x"})
