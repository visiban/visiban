"""Tests for the MCP flow-metrics tools, board_flow_metrics and aging_cards (#1151).

The numbers come from the #448 flow service; these tests pin that the tools
call it with the same inputs as the REST analytics endpoints (so the two agree),
that they validate and authorize at the boundary, and that the payload and the
query count do not grow with the board.

Time is frozen by patching ``django.utils.timezone.now``: the tools and the REST
views both read the wall clock, and a drift of a second would turn the exact
percentile assertions into flakes.
"""
from unittest import mock

import pytest
from django.conf import settings

if not settings.MCP_SERVER_ENABLED:  # pragma: no cover - exercised only in the flagged CI job
    pytest.skip(
        "MCP server disabled; set MCP_SERVER_ENABLED=true to run these.",
        allow_module_level=True,
    )

from django.core.cache import cache
from django.db import connection
from django.test import override_settings
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from accounts.models import SCOPE_MCP_READ, SCOPE_READ, PersonalAccessToken, User
from boards.models import Board, BoardMembership, Card, CardBlock, Column, Swimlane
from boards.tests.test_flow_metrics import FlowFixture
from mcp_server import tools
from mcp_server.context import reset_current_user, set_current_user

from .test_mcp import McpTestCase, _parse_sse


class McpFlowFixture(FlowFixture):
    """The flow service's board and history builder, called through the tool functions."""

    def setUp(self):
        super().setUp()
        self._clock = mock.patch("django.utils.timezone.now", return_value=self.now)
        self._clock.start()
        self.addCleanup(self._clock.stop)

    def call(self, tool, user=None, **arguments):
        token = set_current_user(user or self.user)
        try:
            return getattr(tools, tool)(**arguments)
        finally:
            reset_current_user(token)

    def member(self, role, name=None):
        user = User.objects.create_user(username=name or f"flow_{role}", password="pw")
        BoardMembership.objects.create(board=self.board, user=user, role=role)
        return user

    def seed_completed(self):
        """Seven cards done in the last week with cycle times of 1..7 days (lane A: 1-4, lane B: 5-7).

        Each was created 25 days ago in Backlog, moved to Doing ``i + 2`` days ago and
        done 2 days ago, so it also leaves a closed Doing visit of ``i`` days and a
        closed Backlog visit of ``23 - i`` days.
        """
        for i in range(1, 8):
            lane = self.lane if i <= 4 else self.other_lane
            self.path(self.backlog, 25, self.doing, i + 2, self.done, 2, lane=lane)


class BoardFlowMetricsTests(McpFlowFixture):
    def test_numbers_on_a_seeded_board(self):
        self.seed_completed()
        # Two cards in progress, one blocked for a day (a manual block still open).
        self.path(self.backlog, 12, self.doing, 10)
        blocked = self.path(self.backlog, 12, self.review, 3)
        CardBlock.objects.create(
            card=blocked, board=self.board, column=self.review, reason="Waiting", blocked_at=self.ago(1),
        )
        Card.objects.filter(pk=blocked.pk).update(blocked_at=self.ago(1))

        result = self.call("board_flow_metrics", board_id=self.board.id)

        self.assertNotIn("error", result)
        self.assertEqual((result["window_days"], result["swimlane_id"]), (90, None))
        cycle = result["cycle_time"]
        self.assertEqual(cycle["sample_size"], 7)
        self.assertEqual(cycle["percentiles"]["p50"], 4)
        self.assertEqual(cycle["percentiles"]["p85"], 6)
        self.assertIsNone(cycle["percentiles"]["p95"])  # needs 20 samples
        wip = {c["column_name"]: c for c in result["wip"]["columns"]}
        self.assertEqual({k: v["count"] for k, v in wip.items()}, {"Backlog": 0, "Doing": 1, "Review": 1})
        self.assertEqual(wip["Doing"]["column_id"], self.doing.id)
        self.assertEqual(wip["Doing"]["column_uid"], self.doing.uid)
        self.assertEqual(result["throughput"]["period"], "week")
        self.assertEqual(result["throughput"]["total"], sum(w["count"] for w in result["throughput"]["weeks"]))
        self.assertEqual(result["blocked"]["total"]["blocks"], 1)
        self.assertEqual(result["blocked"]["days_per_column"]["Review"], 1)

    def test_matches_the_rest_endpoints_for_the_same_inputs(self):
        self.seed_completed()
        client = APIClient()
        client.force_authenticate(self.user)
        for swimlane in (None, self.lane):
            with self.subTest(swimlane=swimlane and swimlane.name):
                params = {"days": 30}
                kwargs = {}
                if swimlane:
                    params["swimlane_id"] = swimlane.id
                    kwargs["swimlane_id"] = swimlane.id
                base = f"/api/v1/boards/{self.board.pk}/metrics"
                rest_cycle = client.get(f"{base}/cycle-time/", params).json()
                rest_throughput = client.get(f"{base}/throughput/", {**params, "period": "week"}).json()
                rest_wip = client.get(f"{base}/wip-age/", params).json()

                result = self.call("board_flow_metrics", board_id=self.board.id, window_days=30, **kwargs)

                self.assertEqual(result["cycle_time"]["percentiles"], rest_cycle["percentiles"])
                self.assertEqual(result["cycle_time"]["sample_size"], rest_cycle["sample_size"])
                self.assertEqual(result["throughput"]["total"], rest_throughput["total"])
                self.assertEqual(result["throughput"]["median"], rest_throughput["median"])
                self.assertEqual(
                    [(w["start"], w["count"]) for w in result["throughput"]["weeks"]],
                    [(s["start"], s["count"]) for s in rest_throughput["samples"]],
                )
                self.assertEqual(
                    {c["column_uid"] for c in result["wip"]["columns"]},
                    {c["column_uid"] for c in rest_wip["columns"]},
                )

    def test_payload_keys_are_a_subset_of_rest_and_carry_no_per_card_lists(self):
        self.seed_completed()
        result = self.call("board_flow_metrics", board_id=self.board.id)
        self.assertLessEqual(
            set(result["cycle_time"]), {"definition", "sample_size", "excluded_incomplete_history", "percentiles", "samples", "cards"},
        )
        self.assertNotIn("samples", result["cycle_time"])
        self.assertNotIn("cards", result["cycle_time"])
        for week in result["throughput"]["weeks"]:
            self.assertEqual(set(week), {"start", "count"})
        for column in result["wip"]["columns"]:
            self.assertNotIn("card_uids", column)

    def test_swimlane_cut_changes_the_numbers(self):
        self.seed_completed()
        everything = self.call("board_flow_metrics", board_id=self.board.id)
        lane_a = self.call("board_flow_metrics", board_id=self.board.id, swimlane_id=self.lane.id)
        lane_b = self.call("board_flow_metrics", board_id=self.board.id, swimlane_id=self.other_lane.id)
        self.assertEqual(
            (everything["cycle_time"]["sample_size"], lane_a["cycle_time"]["sample_size"], lane_b["cycle_time"]["sample_size"]),
            (7, 4, 3),
        )
        self.assertEqual(lane_a["swimlane_id"], self.lane.id)

    def test_window_bounds_which_completions_count(self):
        self.seed_completed()
        # Completions were 2 days ago; a 1-day window sees none of them.
        self.assertEqual(
            self.call("board_flow_metrics", board_id=self.board.id, window_days=1)["cycle_time"]["sample_size"], 0,
        )

    def test_blocked_time_uses_the_requested_window(self):
        card = self.path(self.backlog, 30, self.doing, 25)
        CardBlock.objects.create(
            card=card, board=self.board, column=self.doing, reason="Old",
            blocked_at=self.ago(20), unblocked_at=self.ago(15),
        )
        short = self.call("board_flow_metrics", board_id=self.board.id, window_days=10)
        longer = self.call("board_flow_metrics", board_id=self.board.id, window_days=30)
        self.assertEqual(short["blocked"]["total"]["blocks"], 0)
        self.assertEqual(longer["blocked"]["total"]["blocks"], 1)
        self.assertAlmostEqual(longer["blocked"]["total"]["days"], 5)

    def test_default_window_is_ninety_days(self):
        self.seed_completed()
        # A completion 60 days ago is inside the default window and outside 30 days.
        self.path(self.backlog, 70, self.doing, 65, self.done, 60)
        default = self.call("board_flow_metrics", board_id=self.board.id)
        self.assertEqual(default["window_days"], 90)
        self.assertEqual(default["cycle_time"]["sample_size"], 8)
        self.assertEqual(
            self.call("board_flow_metrics", board_id=self.board.id, window_days=30)["cycle_time"]["sample_size"], 7,
        )
        self.assertIsNotNone(default["throughput"]["median"])  # twelve whole weeks

    def test_empty_board_is_all_nulls_and_zeros(self):
        result = self.call("board_flow_metrics", board_id=self.board.id)
        self.assertEqual(result["cycle_time"]["sample_size"], 0)
        self.assertEqual(result["cycle_time"]["percentiles"], {"p50": None, "p85": None, "p95": None})
        self.assertEqual(result["throughput"]["total"], 0)
        self.assertEqual(result["throughput"]["median"], 0)  # twelve whole weeks of zero
        self.assertTrue(all(c["count"] == 0 for c in result["wip"]["columns"]))
        self.assertEqual(result["blocked"]["total"]["blocks"], 0)

    def test_bad_arguments_are_validation_errors(self):
        for field, value in (
            ("window_days", 0), ("window_days", -3), ("window_days", 366), ("window_days", True),
            ("swimlane_id", 0), ("swimlane_id", 2**40), ("swimlane_id", self.lane.id + 10_000),
        ):
            with self.subTest(field=field, value=value):
                result = self.call("board_flow_metrics", board_id=self.board.id, **{field: value})
                self.assertEqual(result["error"]["code"], "validation_error")
                self.assertIn(field, result["error"]["errors"])

    def test_a_swimlane_of_another_board_is_refused_like_a_missing_one(self):
        other = Board.objects.create(name="Elsewhere", owner=self.user)
        BoardMembership.objects.create(board=other, user=self.user, role="admin")
        foreign = Swimlane.objects.create(board=other, name="Foreign", position=0)
        result = self.call("board_flow_metrics", board_id=self.board.id, swimlane_id=foreign.id)
        missing = self.call("board_flow_metrics", board_id=self.board.id, swimlane_id=foreign.id + 10_000)
        self.assertEqual(result, missing)
        self.assertEqual(result["error"]["code"], "validation_error")
        self.assertNotIn("cycle_time", result)

    def test_viewer_may_read_and_non_member_gets_the_not_found_of_a_missing_board(self):
        viewer = self.member("viewer")
        self.assertNotIn("error", self.call("board_flow_metrics", user=viewer, board_id=self.board.id))

        outsider = User.objects.create_user(username="flow_outsider", password="pw")
        denied = self.call("board_flow_metrics", user=outsider, board_id=self.board.id)
        missing = self.call("board_flow_metrics", user=outsider, board_id=self.board.id + 10_000)
        self.assertEqual(denied["error"]["code"], "board_not_found")
        self.assertEqual(denied, missing)

    def test_every_board_role_may_read(self):
        for role in ("member", "collaborator", "viewer"):
            with self.subTest(role=role):
                user = self.member(role)
                self.assertNotIn("error", self.call("board_flow_metrics", user=user, board_id=self.board.id))
                self.assertNotIn("error", self.call("aging_cards", user=user, board_id=self.board.id))

    def test_a_non_member_with_bad_arguments_still_gets_board_not_found(self):
        # The board is authorized before any argument is looked at, so a probe of
        # swimlane ids or bad values cannot reveal anything to an outsider.
        outsider = User.objects.create_user(username="flow_prober", password="pw")
        for swimlane_id in (self.lane.id, self.lane.id + 10_000):
            denied = self.call(
                "board_flow_metrics", user=outsider, board_id=self.board.id,
                window_days=0, swimlane_id=swimlane_id,
            )
            self.assertEqual(denied["error"]["code"], "board_not_found")
        denied = self.call("aging_cards", user=outsider, board_id=self.board.id, percentile=100)
        self.assertEqual(denied["error"]["code"], "board_not_found")

    def test_query_count_does_not_grow_with_the_cards(self):
        def count():
            with CaptureQueriesContext(connection) as ctx:
                self.call("board_flow_metrics", board_id=self.board.id)
            return len(ctx.captured_queries)

        self.path(self.backlog, 12, self.doing, 10)
        few = count()
        for _ in range(12):
            self.path(self.backlog, 25, self.doing, 5, self.done, 2)
            self.path(self.backlog, 12, self.review, 3)
        self.assertEqual(count(), few)


class AgingCardsTests(McpFlowFixture):
    def seed_aging(self):
        """Doing p85 is 7 days and Backlog p85 is 21; Review has no history.

        The archived card closes a 19-day Doing visit and a 20-day Backlog visit inside the
        history window, which is why Doing has eight samples (1..7 and 19), not seven.
        """
        self.seed_completed()
        self.assignee = User.objects.create_user(username="aging_owner", password="pw")
        self.slow = self.path(self.backlog, 12, self.doing, 10)
        Card.objects.filter(pk=self.slow.pk).update(assignee=self.assignee)
        self.blocked = self.path(self.backlog, 12, self.doing, 8, lane=self.other_lane)
        Card.objects.filter(pk=self.blocked.pk).update(blocked_at=self.ago(1))
        self.fresh = self.path(self.backlog, 12, self.doing, 5)
        self.stuck_backlog = self.path(self.backlog, 33)
        self.in_review = self.path(self.backlog, 20, self.review, 15)  # no Review history: no threshold
        self.archived = self.path(self.backlog, 40, self.doing, 20, archived=1)

    def test_flags_only_cards_past_their_columns_threshold_worst_first(self):
        self.seed_aging()
        result = self.call("aging_cards", board_id=self.board.id)

        self.assertNotIn("error", result)
        self.assertEqual((result["percentile"], result["history_days"]), (85, 90))
        # Ratio to the column's threshold, descending: 33/21, 10/7, 8/7.
        self.assertEqual([c["id"] for c in result["cards"]], [self.stuck_backlog.id, self.slow.id, self.blocked.id])
        self.assertEqual((result["total"], result["truncated"]), (3, False))
        first = result["cards"][1]
        self.assertAlmostEqual(first["value_days"], 10)
        self.assertNotIn("age_days", first)  # ADR #1532: never a field called age
        self.assertAlmostEqual(first["threshold_days"], 7)
        self.assertEqual(first["uid"], self.slow.uid)
        self.assertEqual(first["column"], {"id": self.doing.id, "uid": self.doing.uid, "name": "Doing"})
        self.assertEqual(first["swimlane"], {"id": self.lane.id, "name": "Lane"})
        self.assertEqual(first["assignee"], {"username": "aging_owner", "display_name": self.assignee.display_name})
        self.assertFalse(first["blocked"])
        by_id = {c["id"]: c for c in result["cards"]}
        self.assertTrue(by_id[self.blocked.id]["blocked"])
        self.assertEqual(by_id[self.blocked.id]["swimlane"]["name"], "Other")
        self.assertIsNone(by_id[self.blocked.id]["assignee"])

    def test_worst_first_is_by_ratio_to_threshold_not_by_absolute_age(self):
        self.seed_completed()  # Doing p85 is 6 days, Backlog p85 is 21
        older = self.path(self.backlog, 22)  # 22 days, ratio ~1.05
        relatively_worse = self.path(self.backlog, 12, self.doing, 9)  # 9 days, ratio 1.5
        result = self.call("aging_cards", board_id=self.board.id)
        self.assertEqual([c["id"] for c in result["cards"]], [relatively_worse.id, older.id])

    def test_history_covers_ninety_days_not_thirty(self):
        self.seed_completed()
        # Five 20-day Doing stays that closed 60 days ago: only a 90-day history sees them.
        for _ in range(5):
            self.path(self.backlog, 85, self.doing, 80, self.done, 60)
        doing = next(
            c for c in self.call("aging_cards", board_id=self.board.id)["columns"] if c["column_name"] == "Doing"
        )
        self.assertEqual(doing["sample_size"], 12)
        self.assertAlmostEqual(doing["threshold_days"], 20)

    def test_columns_explain_a_null_threshold(self):
        self.seed_aging()
        columns = {c["column_name"]: c for c in self.call("aging_cards", board_id=self.board.id)["columns"]}
        self.assertEqual(set(columns), {"Backlog", "Doing", "Review"})  # done columns never appear
        self.assertAlmostEqual(columns["Doing"]["threshold_days"], 7)
        self.assertEqual(columns["Doing"]["sample_size"], 8)
        self.assertIsNone(columns["Review"]["threshold_days"])
        self.assertEqual(columns["Review"]["sample_size"], 0)
        self.assertEqual(columns["Doing"]["column_id"], self.doing.id)

    def test_lower_percentile_flags_more_cards(self):
        self.seed_aging()
        p50 = self.call("aging_cards", board_id=self.board.id, percentile=50)
        self.assertIn(self.fresh.id, [c["id"] for c in p50["cards"]])  # 5 days > Doing p50 of 4
        self.assertNotIn(self.fresh.id, [c["id"] for c in self.call("aging_cards", board_id=self.board.id)["cards"]])

    def test_archived_and_done_cards_are_never_flagged(self):
        self.seed_aging()
        ids = [c["id"] for c in self.call("aging_cards", board_id=self.board.id, percentile=1)["cards"]]
        self.assertNotIn(self.archived.id, ids)
        done_ids = set(Card.objects.filter(column__is_done=True).values_list("id", flat=True))
        self.assertFalse(done_ids & set(ids))

    def test_result_is_capped_and_says_so(self):
        self.seed_aging()
        with mock.patch.object(tools, "_AGING_MAX_ROWS", 2):
            result = self.call("aging_cards", board_id=self.board.id)
        self.assertEqual((len(result["cards"]), result["total"], result["truncated"], result["limit"]), (2, 3, True, 2))
        self.assertEqual([c["id"] for c in result["cards"]], [self.stuck_backlog.id, self.slow.id])

    def test_empty_board(self):
        result = self.call("aging_cards", board_id=self.board.id)
        self.assertEqual((result["cards"], result["total"], result["truncated"]), ([], 0, False))
        self.assertTrue(all(c["threshold_days"] is None for c in result["columns"]))

    def test_bad_percentile_is_a_validation_error(self):
        for value in (0, 100, -1, True):
            with self.subTest(value=value):
                result = self.call("aging_cards", board_id=self.board.id, percentile=value)
                self.assertEqual(result["error"]["code"], "validation_error")
                self.assertIn("percentile", result["error"]["errors"])

    def test_viewer_may_read_and_non_member_gets_the_not_found_of_a_missing_board(self):
        self.assertNotIn("error", self.call("aging_cards", user=self.member("viewer"), board_id=self.board.id))
        outsider = User.objects.create_user(username="aging_outsider", password="pw")
        denied = self.call("aging_cards", user=outsider, board_id=self.board.id)
        self.assertEqual(denied["error"]["code"], "board_not_found")
        self.assertEqual(denied, self.call("aging_cards", user=outsider, board_id=self.board.id + 10_000))

    def test_query_count_does_not_grow_with_the_cards(self):
        def count():
            with CaptureQueriesContext(connection) as ctx:
                self.call("aging_cards", board_id=self.board.id)
            return len(ctx.captured_queries)

        self.seed_aging()
        few = count()
        for i in range(10):
            card = self.path(self.backlog, 12, self.doing, 9 + i)
            owner = User.objects.create_user(username=f"aging_owner_{i}", password="pw")
            Card.objects.filter(pk=card.pk).update(assignee=owner)
            self.path(self.backlog, 40, lane=self.other_lane)
        self.assertEqual(count(), few)


class FlowToolsTransportTests(McpTestCase):
    """Through the real transport: registration, scope, and the compute throttle."""

    def setUp(self):
        super().setUp()
        self.board = Board.objects.create(name="Transport", owner=self.user)
        BoardMembership.objects.create(board=self.board, user=self.user, role="admin")
        Column.objects.create(board=self.board, name="Backlog", position=0)
        Swimlane.objects.create(board=self.board, name="General", position=0)

    def _result(self, body):
        payload = _parse_sse(body)
        self.assertNotIn("error", payload, payload)
        return payload["result"]

    def test_both_tools_work_with_an_mcp_read_token(self):
        for name, args in (("board_flow_metrics", {}), ("aging_cards", {})):
            with self.subTest(tool=name):
                status, body = self._tools_call(name, self.raw_token, {"board_id": self.board.id, **args})
                self.assertEqual(status, 200)
                result = self._result(body)
                self.assertFalse(result["isError"])
                self.assertNotIn("error", result["structuredContent"]["result"])

    def test_a_domain_error_is_an_error_result(self):
        status, body = self._tools_call("aging_cards", self.raw_token, {"board_id": self.board.id, "percentile": 100})
        result = self._result(body)
        self.assertTrue(result["isError"])
        self.assertEqual(result["structuredContent"]["result"]["error"]["code"], "validation_error")

    def test_a_token_without_mcp_read_is_refused_at_the_transport(self):
        _, raw = PersonalAccessToken.generate(self.user, "rest-only", scopes=[SCOPE_READ])
        for name in ("board_flow_metrics", "aging_cards"):
            status, _ = self._tools_call(name, raw, {"board_id": self.board.id})
            self.assertIn(status, (401, 403), name)

    def test_non_member_cannot_read_the_board(self):
        other = User.objects.create_user(username="flow_transport_other", password="pw")
        _, raw = PersonalAccessToken.generate(other, "mcp", scopes=[SCOPE_MCP_READ])
        for name in ("board_flow_metrics", "aging_cards"):
            status, body = self._tools_call(name, raw, {"board_id": self.board.id})
            self.assertEqual(status, 200)
            self.assertEqual(self._result(body)["structuredContent"]["result"]["error"]["code"], "board_not_found")

    def test_both_tools_spend_the_compute_bucket(self):
        for name in ("board_flow_metrics", "aging_cards"):
            with self.subTest(tool=name), override_settings(
                MCP_THROTTLE_READ_RATE="9999/min", MCP_THROTTLE_COMPUTE_RATE="1/min",
            ):
                cache.clear()
                args = {"board_id": self.board.id}
                _, body = self._tools_call(name, self.raw_token, args)
                self.assertNotIn("error", self._result(body)["structuredContent"]["result"])
                _, body = self._tools_call(name, self.raw_token, args)
                self.assertEqual(self._result(body)["structuredContent"]["result"]["error"]["code"], "throttled")

