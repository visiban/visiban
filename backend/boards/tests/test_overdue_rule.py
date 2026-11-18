"""The one overdue rule, pinned against the fixture the frontend reads too (#2313).

``fixtures/overdue_rule_cases.json`` holds the cases; ``frontend/src/test/
overdueRule.test.ts`` runs the same file through ``utils/cardUrgency.ts``. A
change to the rule on one side only fails one of the two suites.
"""

import datetime
import json
from pathlib import Path
from unittest.mock import patch

from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from boards.card_signals import overdue_signal_q, signal_today
from boards.models import Card, Swimlane
from boards.services.health_compute import lane_counts
from boards.tests.conftest import _make_board, _make_card, _make_column, _make_user

CASES = json.loads((Path(__file__).parent / "fixtures" / "overdue_rule_cases.json").read_text())["cases"]


def _instant(value):
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))


class OverdueRuleFixtureTests(TestCase):
    def setUp(self):
        self.board = _make_board(_make_user())
        self.open_col = _make_column(self.board, "Doing", 0)
        self.done_col = _make_column(self.board, "Done", 1, is_done=True)

    def _card(self, case, lane):
        return _make_card(
            self.done_col if case["done"] else self.open_col,
            lane,
            due_date=datetime.date.fromisoformat(case["due_date"]) if case["due_date"] else None,
            archived_at=_instant(case["now"]) - datetime.timedelta(days=1) if case["archived"] else None,
        )

    def test_fixture_covers_the_edge_cases(self):
        names = {c["name"] for c in CASES}
        self.assertGreaterEqual(len(names), 10)
        self.assertTrue(any(c["done"] for c in CASES))
        self.assertTrue(any(c["archived"] for c in CASES))
        self.assertTrue(any(c["tz"] != "UTC" for c in CASES))

    def test_every_case_matches_the_signal_and_auto_health(self):
        for index, case in enumerate(CASES):
            with self.subTest(case["name"]):
                lane = Swimlane.objects.create(board=self.board, name=f"Lane {index}", position=index)
                card = self._card(case, lane)
                with (
                    patch("django.utils.timezone.now", return_value=_instant(case["now"])),
                    override_settings(INSTANCE_TIMEZONE=case["tz"]),
                ):
                    signalled = Card.objects.filter(overdue_signal_q(signal_today()), pk=card.pk).exists()
                    counted = lane_counts(self.board).get(lane.pk, {}).get("overdue", 0)
                self.assertEqual(signalled, case["overdue"])
                self.assertEqual(counted, 1 if case["overdue"] else 0)


class SiteConfigInstanceTimezoneTests(TestCase):
    def test_default_is_utc(self):
        self.assertEqual(APIClient().get("/api/v1/auth/site-config/").json()["instance_timezone"], "UTC")

    @override_settings(INSTANCE_TIMEZONE="Asia/Tokyo")
    def test_serves_the_configured_zone_anonymously(self):
        resp = APIClient().get("/api/v1/auth/site-config/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["instance_timezone"], "Asia/Tokyo")
