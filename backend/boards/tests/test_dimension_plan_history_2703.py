"""Dimension plan edits are recorded in card history (#2703)."""
from boards.models import CardActivity, CardDimensionPlan, BoardMembership
from boards.tests.test_dimension_plans_1922 import _Base

ET = CardActivity.EventType
PLAN_EVENTS = (ET.DIMENSION_OWNER_CHANGED, ET.DIMENSION_NEXT_ACTION_CHANGED, ET.DIMENSION_TARGET_DATE_CHANGED)


class DimensionPlanHistoryTests(_Base):
    def rows(self):
        return list(
            CardActivity.objects.filter(card=self.card, event_type__in=PLAN_EVENTS)
            .order_by("pk").values_list("event_type", "from_value", "to_value", "item_text", "actor_id")
        )

    def test_first_plan_records_each_part_with_actor_and_dimension_name(self):
        owner = self.member("own2703", BoardMembership.Role.MEMBER)
        resp = self.client.put(self.url(), {
            "owner_id": owner.pk, "next_action": "Book review", "target_date": "2026-12-01",
        }, format="json")
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertEqual(self.rows(), [
            (ET.DIMENSION_OWNER_CHANGED, "", "own2703", "Security", self.admin.pk),
            (ET.DIMENSION_NEXT_ACTION_CHANGED, "", "Book review", "Security", self.admin.pk),
            (ET.DIMENSION_TARGET_DATE_CHANGED, "", "2026-12-01", "Security", self.admin.pk),
        ])

    def test_only_changed_parts_are_recorded_and_a_repeat_records_nothing(self):
        body = {"next_action": "A", "target_date": "2026-12-01"}
        self.client.put(self.url(), body, format="json")
        before = len(self.rows())
        self.client.put(self.url(), body, format="json")
        self.assertEqual(len(self.rows()), before)
        self.client.put(self.url(), {"next_action": "A", "target_date": "2026-12-09"}, format="json")
        self.assertEqual(self.rows()[-1][:3], (ET.DIMENSION_TARGET_DATE_CHANGED, "2026-12-01", "2026-12-09"))
        self.assertEqual(len(self.rows()), before + 1)

    def test_clearing_the_plan_records_the_old_values(self):
        self.client.put(self.url(), {"next_action": "A", "target_date": "2026-12-01"}, format="json")
        self.client.put(self.url(), {}, format="json")
        self.assertFalse(CardDimensionPlan.objects.exists())
        self.assertEqual([r[:3] for r in self.rows()[-2:]], [
            (ET.DIMENSION_NEXT_ACTION_CHANGED, "A", ""),
            (ET.DIMENSION_TARGET_DATE_CHANGED, "2026-12-01", ""),
        ])

    def test_reassigning_records_both_usernames(self):
        first = self.member("first2703", BoardMembership.Role.MEMBER)
        second = self.member("second2703", BoardMembership.Role.MEMBER)
        self.client.put(self.url(), {"owner_id": first.pk}, format="json")
        self.client.put(self.url(), {"owner_id": second.pk}, format="json")
        self.assertEqual(self.rows()[-1][:3], (ET.DIMENSION_OWNER_CHANGED, "first2703", "second2703"))

    def test_rows_show_on_the_timeline_field_group_with_item_text(self):
        self.client.put(self.url(), {"next_action": "Go"}, format="json")
        resp = self.client.get(
            f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/timeline/?event_type=field",
        )
        self.assertEqual(resp.status_code, 200, resp.data)
        entries = [e for e in resp.data["results"] if e["event_type"] == ET.DIMENSION_NEXT_ACTION_CHANGED]
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["data"]["item_text"], "Security")

    def test_item_text_survives_json_import(self):
        self.assertIn(ET.DIMENSION_NEXT_ACTION_CHANGED, CardActivity.ITEM_TEXT_EVENT_TYPES)
