"""/analytics/ holds one window of history at a time (#2427)."""
import datetime
import json
import os
import weakref
from unittest import mock

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

    def _body(self, days):
        self.url = f"/api/v1/boards/{self.board.pk}/analytics/?days={days}"
        r = self._get()
        self.assertEqual(r.status_code, 200)
        body = json.loads(r.content)
        for lane in body["swimlanes"]:
            lane.pop("id")
            for c in lane["stalled_cards"]:
                c.pop("id")
                c.pop("uid")
        return body

    def test_response_pinned_with_archived_history(self):
        self._archived_history_fixture()
        got = {str(d): self._body(d) for d in (30, 90, 365)}
        dump = os.environ.get("DUMP_2427")
        if dump:
            with open(dump, "w") as fh:
                json.dump(got, fh, sort_keys=True)
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
            if refs:
                released.append(refs[0]() is None)
            return real_base(*a, **k)

        with mock.patch.object(flow_metrics, "load_recent_dwell", side_effect=spy_load) as load, \
                mock.patch.object(flow_metrics, "_base_cards", side_effect=spy_base):
            self._body(365)
        self.assertEqual(load.call_count, 1)
        self.assertEqual(released, [True])


# Keep pytest from collecting the parent's tests a second time under this module.
del _Shape
