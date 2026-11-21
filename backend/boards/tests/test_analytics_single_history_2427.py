"""/analytics/ holds one window of history at a time (#2427).

``fixtures/analytics_2427_pinned.json`` was generated from the pre-change ``analytics()``
(``boards/views/analytics.py`` at origin/main, before #2427) with the pinned clock ``NOW``
below, by running this module's ``_pinned_responses()`` against that code. It must keep
passing on both the old and the new view.
"""
import datetime
import gc
import json
import os
import weakref
from unittest import mock

from boards.models import Card, CardBlock
from boards.services import flow_metrics
from boards.tests.test_analytics_query_shape_1884 import AnalyticsQueryShapeTests as _Shape

NOW = datetime.datetime(2026, 11, 1, 12, 0, tzinfo=datetime.timezone.utc)


class AnalyticsSingleHistoryTests(_Shape):
    """Reuses the #1884 fixture helpers; only the tests below run (parent tests are shadowed)."""

    test_response_is_pinned_for_a_fixture_board = None
    test_query_count_does_not_scale_with_cards = None
    test_card_query_does_not_load_description = None

    def _archived_history_fixture(self):
        self._fixture()
        a, b = self.lanes
        # Archived generations well outside a 90-day window, inside 365.
        for i, ago in enumerate((100, 200, 300, 400)):
            self._card(a, f"old{i}", [(self.todo, ago + 20), (self.doing, ago + 10), (self.done, ago)],
                       archived_days_ago=ago - 1)
        self._card(b, "oldwip", [(self.todo, 250), (self.doing, 240)], archived_days_ago=230)
        # Manual blocks (with reasons) so the blocked_time section is non-zero.
        for title, reason, start, end in (
            ("a1", "Waiting on customer", 15, 10),
            ("a2", "Waiting on customer", 45, 35),
            ("b2", "Vendor outage", 80, 70),
            ("old1", "Legal review", 290, 280),
        ):
            card = Card.objects.get(board=self.board, title=title)
            CardBlock.objects.create(
                board=self.board, card=card, card_uid=card.uid, card_title=card.title,
                blocked_at=NOW - datetime.timedelta(days=start),
                unblocked_at=NOW - datetime.timedelta(days=end),
                reason=reason, column=card.column, column_name=card.column.name,
                column_uid=card.column.uid,
            )

    def _body(self, days, extra=""):
        self.url = f"/api/v1/boards/{self.board.pk}/analytics/?days={days}{extra}"
        r = self._get()
        self.assertEqual(r.status_code, 200)
        body = json.loads(r.content)
        for lane in body["swimlanes"]:
            lane.pop("id")
            for c in lane["stalled_cards"]:
                c.pop("id")
                c.pop("uid")
        return body

    def _pinned_responses(self):
        got = {str(d): self._body(d) for d in (30, 90, 365)}
        got["90_lane_A"] = self._body(90, f"&swimlane_id={self.lanes[0].pk}")
        got["365_lane_B"] = self._body(365, f"&swimlane_id={self.lanes[1].pk}")
        return got

    def test_response_pinned_with_archived_history(self):
        self._archived_history_fixture()
        got = self._pinned_responses()
        # Guard the pin itself: the moved blocked_time call must be exercised.
        self.assertGreater(got["365"]["blocked"]["total"]["seconds"], 0, "fixture has no blocked time")
        self.assertTrue(got["365"]["blocked"]["top_reasons"])
        with open(os.path.join(os.path.dirname(__file__), "fixtures", "analytics_2427_pinned.json")) as fh:
            self.assertEqual(got, json.load(fh))

    def test_history_is_loaded_once_and_released_before_heatmap_load(self):
        self._archived_history_fixture()
        refs = []
        real_load = flow_metrics.load_recent_dwell

        def spy_load(*a, **k):
            flow = real_load(*a, **k)
            refs.append(weakref.ref(flow))
            return flow

        released = []
        real_base = flow_metrics._base_cards

        def spy_base(*a, **k):
            # load_recent_dwell itself calls _base_cards (flow_metrics.py ~1077); the spy
            # skips that call only because ``refs`` is still empty at that point.
            if refs:
                gc.collect()
                released.append(refs[0]() is None)
            return real_base(*a, **k)

        with mock.patch.object(flow_metrics, "load_recent_dwell", side_effect=spy_load) as load, \
                mock.patch.object(flow_metrics, "_base_cards", side_effect=spy_base):
            self._body(365)
        self.assertEqual(load.call_count, 1)
        self.assertTrue(released, "no _base_cards call after the history load")
        # The property: the history is gone by the first _base_cards call after the load.
        self.assertTrue(released[0], "flow history still alive at the first post-load _base_cards call")
        # Separate, count-only guard: today the heatmap load makes exactly one such call.
        self.assertEqual(len(released), 1)


# Keep pytest from collecting the parent's tests a second time under this module.
del _Shape
