"""/analytics/ reads one window of history, once (#2427, #2451).

``fixtures/analytics_2427_pinned.json`` was generated from the pre-change ``analytics()``
(``boards/views/analytics.py`` at origin/main, before #2427) with the pinned clock ``NOW``
below, by running this module's ``_pinned_responses()`` against that code. It must keep
passing on both the old and the new view.
"""
import datetime
import json
import os
from unittest import mock

from django.db import connection
from django.db.models import Q
from django.test.utils import CaptureQueriesContext

from boards.models import Card, CardBlock, CardMovement
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

    def test_history_is_read_once(self):
        """The heatmap's figures come off the flow load's one movement read (#2427, #2451).

        #2427 released the flow history before the heatmap read the window's
        cards and movements again; #2451 removed that second read. One
        ``load_board_flow``, one top-level query on the movements table, and
        no correlated movement subquery on the card read.
        """
        self._archived_history_fixture()
        with mock.patch.object(flow_metrics, "load_board_flow", wraps=flow_metrics.load_board_flow) as load, \
                CaptureQueriesContext(connection) as ctx:
            self._body(365)
        self.assertEqual(load.call_count, 1)
        table = CardMovement._meta.db_table
        reads = [q["sql"] for q in ctx.captured_queries if q["sql"].split(" FROM ", 1)[-1].startswith(f'"{table}"')]
        self.assertEqual(len(reads), 1, reads)
        card_table = Card._meta.db_table
        card_reads = [q["sql"] for q in ctx.captured_queries if q["sql"].split(" FROM ", 1)[-1].startswith(f'"{card_table}"')]
        # The flow load's card read selects no per-card movement annotation
        # (the four correlated subqueries are gone); movements appear only in
        # its WHERE narrowing.
        self.assertTrue(card_reads)
        self.assertTrue(all(f'"{table}"' not in sql.split(" FROM ", 1)[0] for sql in card_reads), card_reads)


    def test_a_live_done_card_idle_since_before_the_buffer_is_not_loaded(self):
        """It adds nothing to the heatmap, so the single load leaves its history out (#2451)."""
        self._archived_history_fixture()
        a, _b = self.lanes
        idle = self._card(a, "idle_done", [(self.todo, 60), (self.doing, 50), (self.done, 40)])
        recent = self._card(a, "recent_done", [(self.todo, 12), (self.doing, 11), (self.done, 10)])
        loaded = []
        real = flow_metrics.load_recent_dwell

        def spy(*a, **k):
            flow = real(*a, **k)
            loaded.extend(card.id for card in flow.cards)
            return flow

        with mock.patch.object(flow_metrics, "load_recent_dwell", side_effect=spy):
            body = self._body(7)  # a 14-day buffer
        self.assertNotIn(idle.id, loaded)
        self.assertIn(recent.id, loaded)
        # And the answer is the one a load of every live card gives.
        real_q = flow_metrics.load_recent_dwell

        def every_live(*a, also_matching=None, **k):
            return real_q(*a, also_matching=Q(archived_at__isnull=True), **k)

        with mock.patch.object(flow_metrics, "load_recent_dwell", side_effect=every_live):
            self.assertEqual(self._body(7), body)


# Keep pytest from collecting the parent's tests a second time under this module.
del _Shape
