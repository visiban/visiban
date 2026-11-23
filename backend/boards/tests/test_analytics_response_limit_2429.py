"""``limit`` caps the per-card lists of the analytics responses (#2429).

On a 12k-card board the Overview transferred megabytes of per-card JSON: a
scatter of every sample, every attention item, every stalled card. ``limit``
is a new optional parameter; without it (or with ``limit=all``) every response
is exactly what it was. These tests pin the two promises that make the cap safe:

- every number a response states (sample sizes, percentiles, counts, totals) is
  computed from the whole set, so it is the same with and without ``limit``;
- the capped lists are subsets of the uncapped ones, keep the largest values,
  and say how much was cut.
"""
import datetime
from unittest import mock

from django.test import SimpleTestCase

from boards.models import Card
from boards.services import flow_metrics as fm
from boards.tests.test_flow_metrics import EndpointFixture
from boards.tests.test_flow_range_narrowing_2425 import AgedBoardMixin

NEW_KEYS = {"sampled", "samples_total", "items_total", "past_p85_count", "sample_count", "stalled_cards_total"}


def _keys(value):
    """Every dict key anywhere in a JSON value."""
    if isinstance(value, dict):
        return set(value) | {k for v in value.values() for k in _keys(v)}
    if isinstance(value, list):
        return {k for v in value for k in _keys(v)}
    return set()


class DownsampleTests(SimpleTestCase):
    def samples(self, n):
        # Values deliberately out of order so "largest" is not "last".
        return [{"id": i, "value_days": float((i * 7919) % 101)} for i in range(n)]

    def test_no_limit_or_a_short_list_is_returned_unchanged(self):
        samples = self.samples(10)
        self.assertEqual(fm.downsample(samples, None), (samples, False))
        self.assertEqual(fm.downsample(samples, 10), (samples, False))
        self.assertEqual(fm.downsample([], 3), ([], False))

    def test_cuts_to_the_limit_in_original_order_keeping_the_largest(self):
        samples = self.samples(1000)
        kept, sampled = fm.downsample(samples, 40)
        self.assertTrue(sampled)
        self.assertEqual(len(kept), 40)
        ids = [s["id"] for s in kept]
        self.assertEqual(ids, sorted(ids))  # original order
        largest = sorted(samples, key=lambda s: (-s["value_days"], s["id"]))[: 40 // fm.DOWNSAMPLE_OUTLIER_SHARE]
        self.assertTrue({s["id"] for s in largest} <= set(ids))
        # Deterministic: the same input picks the same dots.
        self.assertEqual(fm.downsample(samples, 40)[0], kept)

    def test_a_limit_below_the_outlier_share_still_fills_the_limit(self):
        for limit in (1, 2, 3, 5):
            with self.subTest(limit=limit):
                kept, sampled = fm.downsample(self.samples(50), limit)
                self.assertTrue(sampled)
                self.assertEqual(len(kept), limit)
                self.assertEqual(len({s["id"] for s in kept}), limit)


class ResponseLimitTests(AgedBoardMixin, EndpointFixture):
    LIMIT = 3

    def setUp(self):
        super().setUp()
        # Pinned to midday for the reason RangeNarrowingEquivalenceTests.setUp gives.
        self.now = datetime.datetime(2026, 11, 18, 12, 0, tzinfo=datetime.timezone.utc)
        self.aged_board()
        # Enough live, aging, unmoved work that every capped list is longer than the limit.
        for i in range(8):
            self.path(self.backlog, 40 + i, self.doing, 30 + i)

    def get(self, metric, params=None, status=200):
        with mock.patch("django.utils.timezone.now", return_value=self.now):
            resp = self.client.get(self.url(metric), params or {})
        self.assertEqual(resp.status_code, status, resp.content)
        return resp.json()

    def pair(self, metric, params=None):
        params = params or {}
        return self.get(metric, params), self.get(metric, {**params, "limit": str(self.LIMIT)})

    def test_without_limit_or_with_all_the_response_is_unchanged(self):
        for metric in ("cycle-time", "throughput", "wip-age", "attention", "overview"):
            with self.subTest(metric=metric):
                plain = self.get(metric)
                self.assertFalse(_keys(plain) & NEW_KEYS)
                self.assertEqual(self.get(metric, {"limit": "all"}), plain)

    def test_cycle_time_numbers_are_unchanged_by_sampling(self):
        for params in ({}, {"group_by": "swimlane"}, {"days": "365"}):
            with self.subTest(params=params):
                full, capped = self.pair("cycle-time", params)
                self.assertGreater(len(full["samples"]), self.LIMIT)
                for key in ("sample_size", "percentiles", "excluded_incomplete_history", "definition", "grouping"):
                    self.assertEqual(capped.get(key), full.get(key), key)
                self.assertEqual(capped["samples_total"], len(full["samples"]))
                self.assertTrue(capped["sampled"])
                self.assertEqual(len(capped["samples"]), self.LIMIT)
                for sample in capped["samples"]:
                    self.assertIn(sample, full["samples"])
                longest = max(full["samples"], key=lambda s: s["value_days"])
                self.assertIn(longest, capped["samples"])
                self.assertEqual({c["uid"] for c in capped["cards"]}, {s["card_uid"] for s in capped["samples"]})

    def test_a_limit_above_the_sample_count_says_nothing_was_cut(self):
        full = self.get("cycle-time")
        capped = self.get("cycle-time", {"limit": str(len(full["samples"]))})
        self.assertFalse(capped["sampled"])
        self.assertEqual(capped["samples"], full["samples"])
        self.assertEqual(capped["samples_total"], len(full["samples"]))

    def test_wip_age_counts_come_from_the_whole_set(self):
        full, capped = self.pair("wip-age", {"group_by": "label"})
        self.assertGreater(len(full["samples"]), self.LIMIT)
        for key in ("sample_size", "cycle_time_percentiles", "excluded_incomplete_history", "grouping"):
            self.assertEqual(capped[key], full[key], key)
        p85 = full["cycle_time_percentiles"]["p85"]
        past = [s for s in full["samples"] if p85 is not None and s["value_days"] > p85]
        self.assertEqual(capped["past_p85_count"], len(past))
        for column, full_column in zip(capped["columns"], full["columns"]):
            self.assertEqual(column["wip_count"], full_column["wip_count"])
            uid = column["column_uid"]
            self.assertEqual(column["sample_count"], sum(s["column_uid"] == uid for s in full["samples"]))
            self.assertEqual(column["past_p85_count"], sum(s["column_uid"] == uid for s in past))
        self.assertTrue(capped["sampled"])
        self.assertEqual(capped["samples_total"], len(full["samples"]))
        self.assertEqual(len(capped["samples"]), self.LIMIT)
        self.assertIn(max(full["samples"], key=lambda s: s["value_days"]), capped["samples"])

    def test_throughput_counts_are_whole_and_uid_lists_are_cut(self):
        full, capped = self.pair("throughput", {"group_by": "swimlane", "period": "day", "days": "365"})
        for key in ("total", "median", "completed_in_range", "grouping"):
            self.assertEqual(capped[key], full[key], key)
        cut = False
        for sample, full_sample in zip(capped["samples"], full["samples"]):
            self.assertEqual(sample["count"], full_sample["count"])
            self.assertEqual(sample["card_uids"], full_sample["card_uids"][: self.LIMIT])
            cut |= len(full_sample["card_uids"]) > self.LIMIT
            for group, full_group in zip(sample["by_group"], full_sample["by_group"]):
                self.assertEqual(group["count"], full_group["count"])
                self.assertEqual(group["card_uids"], full_group["card_uids"][: self.LIMIT])
        self.assertEqual(capped["sampled"], cut)

    def test_throughput_cards_name_every_uid_by_group_names(self):
        # Each by_group list is cut on its own, so with limit=1 a group can keep
        # a card the period's top-level list dropped; `cards` must still name it.
        capped = self.get("throughput", {"group_by": "swimlane", "period": "day", "days": "365", "limit": "1"})
        top = {uid for sample in capped["samples"] for uid in sample["card_uids"]}
        grouped = {uid for sample in capped["samples"] for group in sample["by_group"] for uid in group["card_uids"]}
        self.assertTrue(grouped - top, "fixture no longer exercises a group-only uid")
        self.assertEqual({c["uid"] for c in capped["cards"]}, top | grouped)

    def test_throughput_with_one_uid_per_period_is_not_sampled(self):
        capped = self.get("throughput", {"limit": "1000"})
        self.assertFalse(capped["sampled"])
        self.assertEqual(capped["samples"], self.get("throughput")["samples"])

    def test_attention_keeps_the_oldest_items_and_states_the_total(self):
        full, capped = self.pair("attention")
        self.assertGreater(len(full["items"]), self.LIMIT)
        self.assertEqual(capped["items"], full["items"][: self.LIMIT])
        self.assertEqual(capped["items_total"], len(full["items"]))
        self.assertTrue(capped["sampled"])
        self.assertEqual(capped["cycle_time_percentiles"], full["cycle_time_percentiles"])
        self.assertEqual({c["uid"] for c in capped["cards"]}, {i["card_uid"] for i in capped["items"]})

    def test_overview_sections_match_their_endpoints_under_the_same_limit(self):
        params = {"limit": str(self.LIMIT), "group_by": "swimlane"}
        overview = self.get("overview", params)
        for section, metric in (
            ("cycle_time", "cycle-time"), ("throughput", "throughput"), ("wip_age", "wip-age"),
            ("attention", "attention"), ("dwell", "dwell"), ("blocked", "blocked"),
            ("cumulative_flow", "cumulative-flow"),
        ):
            with self.subTest(section=section):
                self.assertEqual(overview[section], self.get(metric, params))

    def test_a_bad_limit_is_refused_in_the_query_param_shape(self):
        for bad in ("0", "-1", "abc", "1.5", "ALL", str(2**63)):
            for metric in ("cycle-time", "throughput", "wip-age", "attention", "overview"):
                with self.subTest(limit=bad, metric=metric):
                    body = self.get(metric, {"limit": bad}, status=400)
                    self.assertEqual(body["code"], "invalid_query_param")
                    self.assertIn("limit", body["detail"])


    def test_endpoints_with_nothing_to_cap_still_ignore_limit(self):
        # `limit` is only on the capping endpoints' serializers: the others treat
        # it as any unknown parameter, as before 1.3, even an invalid value.
        for metric in ("dwell", "cumulative-flow", "swimlanes", "blocked"):
            plain = self.get(metric)
            for value in ("0", "abc", "3"):
                with self.subTest(metric=metric, limit=value):
                    self.assertEqual(self.get(metric, {"limit": value}), plain)


class AnalyticsStalledLimitTests(EndpointFixture):
    def setUp(self):
        super().setUp()
        self.board.staleness_threshold_days = 1
        self.board.save(update_fields=["staleness_threshold_days"])
        for i in range(6):
            card = Card.objects.create(board=self.board, column=self.backlog, swimlane=self.lane, title=f"s{i}")
            # Different ages so "longest unmoved" is well defined.
            Card.objects.filter(pk=card.pk).update(created_at=self.now - datetime.timedelta(days=10 + i * 3))

    def get(self, params, status=200):
        resp = self.client.get(f"/api/v1/boards/{self.board.pk}/analytics/", params)
        self.assertEqual(resp.status_code, status, resp.content)
        return resp.json()

    def lane_row(self, body):
        return next(sw for sw in body["swimlanes"] if sw["id"] == self.lane.id)

    def test_stalled_cards_keep_the_longest_unmoved_and_state_the_total(self):
        full = self.get({"days": "90"})
        self.assertFalse(_keys(full) & NEW_KEYS)
        self.assertEqual(self.get({"days": "90", "limit": "all"}), full)
        capped = self.get({"days": "90", "limit": "2"})
        stalled, capped_row = self.lane_row(full)["stalled_cards"], self.lane_row(capped)
        self.assertEqual(len(stalled), 6)
        self.assertEqual(capped_row["stalled_cards_total"], 6)
        oldest = sorted(stalled, key=lambda c: -c["days_since_move_exact"])[:2]
        self.assertEqual(
            sorted(c["id"] for c in capped_row["stalled_cards"]), sorted(c["id"] for c in oldest),
        )
        # The usual order is kept among the survivors.
        self.assertEqual(capped_row["stalled_cards"], [c for c in stalled if c in oldest])
        self.assertTrue(capped["sampled"])
        for key in ("board_medians", "blocked", "columns"):
            self.assertEqual(capped[key], full[key])
        # Every other swimlane field is untouched by the cut.
        drop = {"stalled_cards", "stalled_cards_total"}
        self.assertEqual(
            {k: v for k, v in capped_row.items() if k not in drop},
            {k: v for k, v in self.lane_row(full).items() if k not in drop},
        )

    def test_the_cut_is_across_swimlanes_not_per_swimlane(self):
        for i in range(2):
            card = Card.objects.create(board=self.board, column=self.backlog, swimlane=self.other_lane, title=f"o{i}")
            # Older than every card in self.lane.
            Card.objects.filter(pk=card.pk).update(created_at=self.now - datetime.timedelta(days=60 + i))
        capped = self.get({"days": "90", "limit": "3"})
        rows = {sw["id"]: sw for sw in capped["swimlanes"]}
        self.assertEqual(len(rows[self.other_lane.id]["stalled_cards"]), 2)
        self.assertEqual(len(rows[self.lane.id]["stalled_cards"]), 1)
        self.assertEqual(rows[self.lane.id]["stalled_cards_total"], 6)
        self.assertEqual(rows[self.other_lane.id]["stalled_cards_total"], 2)
        self.assertEqual(sum(len(sw["stalled_cards"]) for sw in capped["swimlanes"]), 3)
        self.assertTrue(capped["sampled"])

    def test_a_limit_the_list_fits_in_is_not_sampled(self):
        capped = self.get({"days": "90", "limit": "50"})
        self.assertFalse(capped["sampled"])
        self.assertEqual(self.lane_row(capped)["stalled_cards_total"], 6)

    def test_a_bad_limit_is_refused(self):
        body = self.get({"limit": "0"}, status=400)
        self.assertEqual(body["code"], "invalid_query_param")

