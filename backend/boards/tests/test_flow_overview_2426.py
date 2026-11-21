"""``metrics/overview`` answers the whole Analytics overview from one history load (#2426).

The overview used to fire seven ``metrics/*`` requests per open, each loading
and replaying the same board history; on a board with years of archived work
that put several copies of it in one ``daphne`` process at once. These tests
pin the two claims the combined endpoint rests on: every section is exactly
what its own endpoint returns, for every range, filter, grouping and period,
and one open loads and replays the history once, in a fixed number of queries.
"""
import datetime
from unittest import mock

from django.db import connection
from django.test.utils import CaptureQueriesContext

from boards.services import flow_metrics as fm
from boards.tests.test_flow_metrics import EndpointFixture
from boards.tests.test_flow_range_narrowing_2425 import AgedBoardMixin

# Each overview section and the endpoint it must match.
SECTIONS = {
    "cycle_time": "cycle-time",
    "throughput": "throughput",
    "cumulative_flow": "cumulative-flow",
    "wip_age": "wip-age",
    "dwell": "dwell",
    "blocked": "blocked",
    "attention": "attention",
}


class FlowOverviewTests(AgedBoardMixin, EndpointFixture):
    """On the #2425 aged board: three years of archived generations plus the odd histories."""

    def setUp(self):
        super().setUp()
        # Pinned to midday for the reason RangeNarrowingEquivalenceTests.setUp gives.
        self.now = datetime.datetime(2026, 11, 18, 12, 0, tzinfo=datetime.timezone.utc)

    def get(self, metric, params):
        with mock.patch("django.utils.timezone.now", return_value=self.now):
            resp = self.client.get(self.url(metric), params)
        self.assertEqual(resp.status_code, 200, resp.content)
        return resp.json()

    def test_every_section_matches_its_own_endpoint(self):
        self.aged_board()
        today = self.now.date()
        ranges = [
            {"days": "1"}, {"days": "30"}, {"days": "90"}, {"days": "365"},
            {"from_date": (today - datetime.timedelta(days=60)).isoformat()},
            {
                "from_date": (today - datetime.timedelta(days=400)).isoformat(),
                "to_date": (today - datetime.timedelta(days=200)).isoformat(),
            },
        ]
        variants = [{}, {"group_by": "swimlane"}, {"group_by": "label"}, {"period": "day"}]
        filters = [{}, {"swimlane_id": str(self.other_lane.pk)}, {"label_id": str(self.label.pk)}]
        for variant in variants:
            for window in ranges:
                for flt in filters:
                    params = {**variant, **window, **flt}
                    overview = self.get("overview", params)
                    self.assertEqual(set(overview), set(SECTIONS))
                    for section, metric in SECTIONS.items():
                        # The single-metric endpoints ignore the parameters they do not take
                        # (group_by on cumulative-flow, period on dwell), as the overview does.
                        with self.subTest(section=section, params=params):
                            self.assertEqual(overview[section], self.get(metric, params))

    def test_one_open_loads_and_replays_the_history_once(self):
        """A new section that brings its own load fails here, not in production (#2426 acceptance)."""
        self.aged_board()
        loaded = []

        def spy(*args, _real=fm.load_cumulative_flow, **kwargs):
            flow = _real(*args, **kwargs)
            loaded.append(flow)
            return flow

        with (
            mock.patch.object(fm, "load_cumulative_flow", side_effect=spy),
            mock.patch.object(fm, "load_board_flow", wraps=fm.load_board_flow) as board_loads,
            mock.patch.object(fm, "load_live_wip", wraps=fm.load_live_wip) as live_loads,
            mock.patch.object(fm, "_analyze_card", wraps=fm._analyze_card) as replays,
        ):
            self.get("overview", {"days": "90", "group_by": "swimlane"})
        self.assertEqual(len(loaded), 1)
        self.assertEqual(board_loads.call_count, 1)
        self.assertEqual(live_loads.call_count, 0)
        # Each loaded card's history is replayed once, not once per chart.
        self.assertEqual(replays.call_count, len(loaded[0].cards))
        self.assertGreater(replays.call_count, 0)

    def test_the_query_count_does_not_grow_with_the_history(self):
        def count(params):
            with CaptureQueriesContext(connection) as ctx:
                self.get("overview", params)
            return len(ctx.captured_queries)

        variants = (("plain", {}), ("grouped", {"group_by": "label"}))
        self.aged_board()
        aged = {key: count(params) for key, params in variants}
        # Two more years of archived work, and more live and recent cards.
        for quarter in range(13, 21):
            base = 90 * quarter + 30
            self.path(self.backlog, base + 40, self.doing, base + 20, self.done, base, archived=base - 5)
        for days in (3, 6, 9):
            self.path(self.backlog, days + 20, self.doing, days + 10, self.done, days)
            self.path(self.backlog, days + 20, self.doing, days)
        older = {key: count(params) for key, params in variants}
        self.assertEqual(older, aged)
        # Pinned so a section that adds a query of its own is seen: the range
        # load (columns, commitment point, cards, movements, gate index and its
        # waits), the settled-band pass (cards, movements), the block rows, and
        # the request's auth and board lookups; group_by adds its key query.
        self.assertEqual(aged, {"plain": 12, "grouped": 13})
        # One range load, its settled-band pass, the block rows, the gate index
        # and the request's own auth and filter lookups: well under the seven
        # endpoints' combined count, which repeated the load for each chart.
        separate = 0
        for metric in SECTIONS.values():
            with CaptureQueriesContext(connection) as ctx:
                self.get(metric, {})
            separate += len(ctx.captured_queries)
        self.assertLess(aged["plain"], separate / 3)

    def test_access_matches_the_metric_endpoints(self):
        from boards.models import BoardMembership
        from django.contrib.auth import get_user_model
        from rest_framework.test import APIClient

        user_model = get_user_model()
        viewer = user_model.objects.create_user(username="overview_viewer", password="pw")
        BoardMembership.objects.create(board=self.board, user=viewer, role="viewer")
        outsider = user_model.objects.create_user(username="overview_outsider", password="pw")
        for user, status in ((viewer, 200), (outsider, 404)):
            client = APIClient()
            client.force_authenticate(user)
            with self.subTest(user=user.username):
                self.assertEqual(client.get(self.url("overview")).status_code, status)
        self.assertIn(APIClient().get(self.url("overview")).status_code, (401, 403))

    def test_a_bad_period_or_grouping_is_refused(self):
        for params in ({"period": "month"}, {"group_by": "nope"}, {"group_by": "custom_field"}, {"group_by_field_id": "1"}):
            with self.subTest(params=params):
                resp = self.client.get(self.url("overview"), params)
                self.assertEqual(resp.status_code, 400, resp.content)
                self.assertEqual(resp.json()["code"], "invalid_query_param")

    def test_a_card_field_on_another_board_is_refused_like_a_missing_one(self):
        from boards.models import Board, CustomFieldDefinition

        other = Board.objects.create(name="Other", owner=self.user)
        foreign = CustomFieldDefinition.objects.create(board=other, name="Tier", field_type="checkbox")
        on_other = self.client.get(self.url("overview"), {"group_by": "custom_field", "group_by_field_id": foreign.pk})
        missing = self.client.get(self.url("overview"), {"group_by": "custom_field", "group_by_field_id": 999_999})
        self.assertEqual(on_other.status_code, 400, on_other.content)
        self.assertEqual(on_other.json(), missing.json())
