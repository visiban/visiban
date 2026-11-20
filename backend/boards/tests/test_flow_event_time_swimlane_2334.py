"""Swimlane groups are dated by the sample, not by the card's current swimlane (#2334).

A sample counts under the swimlane the card was in at the moment the sample is
dated by: completion for cycle time, throughput and the Swimlanes view's
finished numbers; now for WIP age and ``in_progress``; for dwell, the swimlane
the card left the column from (just before the visit's end); each second for
blocked share. Counts follow the instant, time follows where it was spent. The ``swimlane_id`` filter, the summary
rollup, the heatmap and the card directory stay on the current swimlane
(decisions.md, ADR #1532 "Filters", dated #2334 note).
"""
from unittest import mock

from boards.models import Card, CardBlock, CardMovement, Swimlane
from boards.services import flow_metrics as fm
from boards.tests.test_flow_metrics import (
    GROUPED_METRICS, MOVE, GroupingFixture, _group_size, _size, _strip_grouping,
)


class EventTimeFixture(GroupingFixture):
    def setUp(self):
        super().setUp()
        self.third_lane = Swimlane.objects.create(board=self.board, name="Third", position=2)

    def history(self, *steps):
        """A card from ``(column, days_ago, lane)`` steps; the first is its creation.

        A step that keeps the column and changes the lane is a swimlane-only
        move, as ``move_card`` writes one. The card ends where the last step is.
        """
        column, days, lane = steps[-1]
        card = self.card(column, created=steps[0][1], lane=lane)
        previous_column, previous_lane = None, None
        for column, days, lane in steps:
            self.lane_row(card, previous_column, column, days, previous_lane, lane)
            previous_column, previous_lane = column, lane
        return card

    def lane_row(self, card, source, target, days_ago, source_lane, target_lane, *, target_lane_name=None):
        mv = CardMovement.objects.create(
            card=card,
            from_column=source, from_column_name=source.name if source else "",
            from_column_uid=source.uid if source else "",
            to_column=target, to_column_name=target.name, to_column_uid=target.uid,
            from_swimlane=source_lane, to_swimlane=target_lane,
            to_swimlane_name=target_lane_name if target_lane_name is not None else (target_lane.name if target_lane else ""),
            moved_by=self.user, movement_type=MOVE,
        )
        CardMovement.objects.filter(pk=mv.pk).update(moved_at=self.ago(days_ago))
        return mv

    def finished_then_moved(self, cycle=13, *, done_ago=3, moved_ago=1, lane=None, to=None):
        """Finished in ``lane`` after ``cycle`` days in progress, then moved to ``to`` in Done."""
        lane, to = lane or self.lane, to or self.other_lane
        start = done_ago + cycle
        return self.history(
            (self.backlog, start + 5, lane), (self.doing, start, lane), (self.done, done_ago, lane),
            (self.done, moved_ago, to),
        )

    def group(self, body, lane):
        return next((g for g in body["grouping"]["groups"] if g["key"] == str(lane.id)), None)

    def get_at_now(self, metric, **params):
        with mock.patch("django.utils.timezone.now", return_value=self.now):
            return self.get(metric, **params)

    def comparison(self):
        return fm.swimlane_comparison(
            self.flow(), self.last(90), list(self.board.swimlanes.order_by("position", "id")),
        )

    def comparison_row(self, body, lane):
        return next(row for row in body["swimlanes"] if row["id"] == lane.id)


class CompletionAnchorTests(EventTimeFixture):
    def test_card_moved_lane_after_completion_counts_under_completion_lane(self):
        """The #2334 acceptance test: both swimlanes' numbers, by completion lane."""
        moved = [self.finished_then_moved(13) for _ in range(5)]
        native = [
            self.history((self.backlog, 20, self.other_lane), (self.doing, 6, self.other_lane),
                         (self.done, 3, self.other_lane))
            for _ in range(5)
        ]
        body = self.get_at_now("cycle-time", group_by="swimlane")
        lane, other = self.group(body, self.lane), self.group(body, self.other_lane)
        self.assertEqual((lane["sample_size"], lane["percentiles"]["p50"]), (5, 13.0))
        self.assertEqual((other["sample_size"], other["percentiles"]["p50"]), (5, 3.0))
        keys = {s["card_uid"]: s["group_keys"] for s in body["samples"]}
        for card in moved:
            self.assertEqual(keys[card.uid], [str(self.lane.id)])
        for card in native:
            self.assertEqual(keys[card.uid], [str(self.other_lane.id)])
        # The moved cards are in other_lane now; nothing about them says so in the samples.
        self.assertTrue(all(Card.objects.get(pk=c.pk).swimlane_id == self.other_lane.id for c in moved))

    def test_swimlane_comparison_finished_median_follow_completion_lane_in_progress_follows_current(self):
        for _ in range(5):
            self.finished_then_moved(13)
        for _ in range(5):
            self.history((self.backlog, 20, self.other_lane), (self.doing, 6, self.other_lane),
                         (self.done, 3, self.other_lane))
        # In progress in lane, then moved to other_lane: in_progress is a count of now.
        self.history((self.backlog, 20, self.lane), (self.doing, 10, self.lane), (self.doing, 2, self.other_lane))
        body = self.comparison()
        lane, other = self.comparison_row(body, self.lane), self.comparison_row(body, self.other_lane)
        self.assertEqual((lane["finished"], lane["median_days"], lane["in_progress"]), (5, 13.0, 0))
        self.assertEqual((other["finished"], other["median_days"], other["in_progress"]), (5, 3.0, 1))
        self.assertEqual(body["board"]["finished"], 10)
        self.assertEqual(sum(p["sample_size"] for p in lane["rolling_median"][-1:]), 5)

    def test_throughput_by_group_counts_completion_lane(self):
        moved = self.finished_then_moved(13)
        body = self.get_at_now("throughput", group_by="swimlane")
        counts = {}
        for sample in body["samples"]:
            for entry in sample["by_group"]:
                if moved.uid in entry["card_uids"]:
                    counts[entry["key"]] = counts.get(entry["key"], 0) + entry["count"]
        self.assertEqual(counts, {str(self.lane.id): 1})
        self.assertEqual(self.group(body, self.lane)["total"], 1)
        self.assertIsNone(self.group(body, self.other_lane))


class CurrentAnchorTests(EventTimeFixture):
    def test_wip_age_group_is_current_lane(self):
        card = self.history((self.backlog, 20, self.lane), (self.doing, 10, self.lane), (self.doing, 2, self.other_lane))
        body = self.get_at_now("wip-age", group_by="swimlane")
        sample = next(s for s in body["samples"] if s["card_uid"] == card.uid)
        self.assertEqual(sample["group_keys"], [str(self.other_lane.id)])
        self.assertEqual(self.group(body, self.other_lane)["sample_size"], 1)


class VisitEndAnchorTests(EventTimeFixture):
    def test_dwell_visit_attributed_to_lane_at_visit_end_when_lane_changes_mid_stay(self):
        self.history(
            (self.backlog, 30, self.lane), (self.doing, 20, self.lane), (self.doing, 15, self.other_lane),
            (self.review, 10, self.other_lane), (self.done, 5, self.other_lane),
        )
        body = self.get_at_now("dwell", group_by="swimlane")

        def sizes(lane):
            return {c["column_name"]: c["sample_size"] for c in self.group(body, lane)["columns"] if c["sample_size"]}

        # Backlog ended in lane; the Doing stay ended after the move, so it is
        # other_lane's at its full length; Review was all in other_lane.
        self.assertEqual(sizes(self.lane), {"Backlog": 1})
        self.assertEqual(sizes(self.other_lane), {"Doing": 1, "Review": 1})
        doing = next(c for c in self.group(body, self.other_lane)["columns"] if c["column_name"] == "Doing")
        self.assertEqual(doing["sample_size"], 1)
        self.assertEqual(body["grouping"]["excluded"], 0)
        self.assertEqual(sum(g["sample_size"] for g in body["grouping"]["groups"]), body["sample_size"])

    def test_diagonal_move_out_of_a_column_counts_the_stay_under_the_lane_it_left(self):
        """One movement that changes column and swimlane ends a stay spent in the first (#2334).

        The Doing stay was all in lane; the move that ended it is the row that
        took the card to other_lane, so reading that row's destination would
        move all 10 days to other_lane. Five cards, so the median is reported.
        """
        for _ in range(5):
            self.history((self.backlog, 30, self.lane), (self.doing, 20, self.lane), (self.review, 10, self.other_lane))
        body = self.get_at_now("dwell", group_by="swimlane")

        def doing(lane):
            group = self.group(body, lane)
            return next((c for c in group["columns"] if c["column_name"] == "Doing"), None) if group else None

        self.assertEqual(doing(self.lane)["sample_size"], 5)
        self.assertEqual(doing(self.lane)["percentiles"]["p50"], 10.0)
        other = doing(self.other_lane)
        self.assertEqual(other["sample_size"] if other else 0, 0)
        self.assertEqual(body["grouping"]["excluded"], 0)

    def test_lane_before_reads_the_row_before_a_moment_and_falls_back_to_current(self):
        """``lane_before`` excludes a change dated at the moment; absent input is the current lane (#1075)."""
        flow = fm.CardFlow(
            id=1, uid="x", title="x", swimlane_id=7, assignee_id=None, created_at=self.now,
            archived_at=None, blocked_at=None, column_uid="c",
        )
        self.assertEqual((flow.lane_before(self.now), flow.lane_before(None)), (7, 7))
        card = self.history((self.backlog, 20, self.lane), (self.doing, 10, self.other_lane))
        loaded = next(c for c in self.flow().cards if c.id == card.id)
        self.assertEqual(loaded.lane_before(self.ago(25)), self.lane.id)
        self.assertEqual(loaded.lane_before(self.ago(20)), self.lane.id)
        self.assertEqual(loaded.lane_before(self.ago(10)), self.lane.id)
        self.assertEqual(loaded.lane_at(self.ago(10)), self.other_lane.id)
        self.assertEqual(loaded.lane_before(self.ago(5)), self.other_lane.id)
        self.assertEqual(loaded.lane_before(None), self.other_lane.id)


class BlockedShareTests(EventTimeFixture):
    def test_blocked_share_splits_across_a_lane_change(self):
        # In progress from 20 days ago; in lane until 10 days ago, other_lane since.
        card = self.history((self.backlog, 30, self.lane), (self.doing, 20, self.lane), (self.doing, 10, self.other_lane))
        CardBlock.objects.create(card=card, board=self.board, reason="Vendor", blocked_at=self.ago(12), unblocked_at=self.ago(2))
        body = self.comparison()
        lane, other = self.comparison_row(body, self.lane), self.comparison_row(body, self.other_lane)
        # lane: 2 of 10 days blocked; other_lane: 8 of 10.
        self.assertAlmostEqual(lane["blocked_share"], 0.2, places=4)
        self.assertAlmostEqual(other["blocked_share"], 0.8, places=4)
        self.assertEqual((lane["in_progress"], other["in_progress"]), (0, 1))

    def test_a_card_that_never_changed_lane_keeps_its_whole_window(self):
        card = self.history((self.backlog, 30, self.lane), (self.doing, 20, self.lane))
        CardBlock.objects.create(card=card, board=self.board, reason="Vendor", blocked_at=self.ago(12), unblocked_at=self.ago(2))
        self.assertAlmostEqual(self.comparison_row(self.comparison(), self.lane)["blocked_share"], 0.5, places=4)

    def test_diagonal_move_into_done_counts_finished_at_completion_and_blocked_time_where_spent(self):
        """Counts follow the swimlane at their instant; time follows where it was spent (#2334).

        In progress in lane for 12 days, blocked 4 of them, then one move into
        Done in other_lane: the finish is other_lane's, the blocked time lane's.
        """
        card = self.history((self.backlog, 20, self.lane), (self.doing, 15, self.lane), (self.done, 3, self.other_lane))
        CardBlock.objects.create(card=card, board=self.board, reason="Vendor", blocked_at=self.ago(11), unblocked_at=self.ago(7))
        body = self.comparison()
        lane, other = self.comparison_row(body, self.lane), self.comparison_row(body, self.other_lane)
        self.assertEqual((other["finished"], other["blocked_share"]), (1, None))
        self.assertEqual(lane["finished"], 0)
        self.assertAlmostEqual(lane["blocked_share"], 0.3333, places=4)
        self.assertEqual(body["board"]["finished"], 1)
        # The Doing stay is dwell time, so it is lane's too.
        dwell = self.get_at_now("dwell", group_by="swimlane")

        def doing_size(lane):
            group = self.group(dwell, lane)
            return next((c["sample_size"] for c in group["columns"] if c["column_name"] == "Doing"), 0) if group else 0

        self.assertEqual((doing_size(self.lane), doing_size(self.other_lane)), (1, 0))


class RankingAndOverlapTests(EventTimeFixture):
    def two_lane_card(self):
        """Finished in lane, moved to other_lane, reopened there and still in progress."""
        return self.history(
            (self.backlog, 30, self.lane), (self.doing, 20, self.lane), (self.done, 10, self.lane),
            (self.done, 8, self.other_lane), (self.doing, 6, self.other_lane), (self.review, 4, self.other_lane),
        )

    def test_ranking_counts_a_card_active_in_two_lanes_in_both(self):
        self.two_lane_card()
        self.wip(lane=self.other_lane)
        self.wip(lane=self.third_lane)
        self.wip(lane=self.third_lane)
        # Active cards: other_lane 2 (the moved card, in progress there, and a
        # wip card), third 2, lane 1 (the moved card's completion). A tie keeps
        # board order. Counting the moved card once, in its current lane, would
        # leave lane out of the ranking altogether.
        for metric in GROUPED_METRICS:
            with self.subTest(metric=metric):
                body = self.get_at_now(metric, group_by="swimlane")
                self.assertEqual(
                    [g["key"] for g in body["grouping"]["groups"]],
                    [str(self.other_lane.id), str(self.third_lane.id), str(self.lane.id)],
                )

    def test_overlapping_stays_false_for_swimlane_after_lane_change(self):
        self.two_lane_card()
        for metric in GROUPED_METRICS:
            with self.subTest(metric=metric):
                body = self.get_at_now(metric, group_by="swimlane")
                self.assertIs(body["grouping"]["overlapping"], False)
                self.assertEqual(
                    sum(_group_size(metric, g) for g in body["grouping"]["groups"]) + body["grouping"]["excluded"],
                    _size(metric, body),
                )


class MissingHistoryTests(EventTimeFixture):
    def test_deleted_lane_history_is_excluded_not_reassigned(self):
        card = self.finished_then_moved(13, lane=self.third_lane, to=self.other_lane)
        self.third_lane.delete()
        body = self.get_at_now("cycle-time", group_by="swimlane")
        self.assertEqual(next(s for s in body["samples"] if s["card_uid"] == card.uid)["group_keys"], [])
        self.assertEqual(body["grouping"]["excluded"], 1)
        self.assertIsNone(self.group(body, self.other_lane))
        comparison = self.comparison()
        self.assertEqual(self.comparison_row(comparison, self.other_lane)["finished"], 0)
        # Still a board completion: the board median covers every swimlane.
        self.assertEqual(comparison["board"]["finished"], 1)

    def test_lane_change_without_movement_falls_back_to_current_lane(self):
        card = self.history((self.backlog, 20, self.lane), (self.doing, 16, self.lane), (self.done, 3, self.lane))
        # A queryset update (or the admin) writes no movement: the history's last
        # swimlane is not the card's, so the current one stands for all of it.
        Card.objects.filter(pk=card.pk).update(swimlane=self.other_lane)
        flow = self.flow()
        loaded = next(c for c in flow.cards if c.id == card.id)
        self.assertEqual(loaded.lanes, [])
        self.assertEqual(loaded.lane_at(loaded.completion_at), self.other_lane.id)
        body = self.get_at_now("cycle-time", group_by="swimlane")
        self.assertEqual(body["samples"][0]["group_keys"], [str(self.other_lane.id)])
        self.assertEqual(self.comparison_row(self.comparison(), self.other_lane)["finished"], 1)

    def test_imported_row_with_unmatched_lane_is_excluded(self):
        """The importer writes FK None and keeps the name when no swimlane matches (import_export.py)."""
        card = self.card(self.done, created=25, lane=self.other_lane)
        self.lane_row(card, None, self.backlog, 25, None, None, target_lane_name="Acme (gone)")
        self.lane_row(card, self.backlog, self.doing, 16, None, None, target_lane_name="Acme (gone)")
        self.lane_row(card, self.doing, self.done, 3, None, None, target_lane_name="Acme (gone)")
        self.lane_row(card, self.done, self.done, 1, None, self.other_lane)
        loaded = next(c for c in self.flow().cards if c.id == card.id)
        self.assertIsNone(loaded.lane_at(loaded.completion_at))
        body = self.get_at_now("cycle-time", group_by="swimlane")
        self.assertEqual(body["samples"][0]["group_keys"], [])
        self.assertEqual(body["grouping"]["excluded"], 1)
        self.assertEqual(self.comparison_row(self.comparison(), self.other_lane)["finished"], 0)

    def test_lane_at_with_empty_timeline_returns_current_lane(self):
        """Absent input (#1075): no timeline never means no swimlane."""
        flow = fm.CardFlow(
            id=1, uid="x", title="x", swimlane_id=7, assignee_id=None, created_at=self.now,
            archived_at=None, blocked_at=None, column_uid="c",
        )
        self.assertEqual(flow.lanes, [])
        self.assertEqual(flow.lane_at(self.now), 7)
        self.assertEqual(flow.lane_at(None), 7)
        self.assertEqual(flow.lane_spans(), [(None, None, 7)])
        # A card with no movements at all loads the same way.
        card = self.card(self.backlog, lane=self.other_lane)
        loaded = next(c for c in self.flow().cards if c.id == card.id)
        self.assertEqual((loaded.lanes, loaded.lane_at(self.now)), ([], self.other_lane.id))

    def test_lane_at_reads_the_timeline_and_before_its_first_row_the_earliest_lane(self):
        card = self.history((self.backlog, 20, self.lane), (self.backlog, 10, self.other_lane))
        loaded = next(c for c in self.flow().cards if c.id == card.id)
        self.assertEqual(loaded.lane_at(self.ago(25)), self.lane.id)
        self.assertEqual(loaded.lane_at(self.ago(15)), self.lane.id)
        self.assertEqual(loaded.lane_at(self.ago(10)), self.other_lane.id)
        self.assertEqual(loaded.lane_at(self.ago(5)), self.other_lane.id)
        self.assertEqual(
            loaded.lane_spans(),
            [(None, self.ago(10), self.lane.id), (self.ago(10), None, self.other_lane.id)],
        )


class ScopeTests(EventTimeFixture):
    def test_swimlane_filter_still_selects_by_current_lane(self):
        card = self.finished_then_moved(13)
        self.assertEqual(self.get_at_now("cycle-time", swimlane_id=self.lane.id)["sample_size"], 0)
        body = self.get_at_now("cycle-time", swimlane_id=self.other_lane.id, group_by="swimlane")
        self.assertEqual([s["card_uid"] for s in body["samples"]], [card.uid])
        # Selected by its current swimlane, grouped by the one it finished in.
        self.assertEqual(body["samples"][0]["group_keys"], [str(self.lane.id)])

    def test_summary_rollup_and_heatmap_unchanged_by_lane_change(self):
        card = self.history(
            (self.backlog, 20, self.lane), (self.doing, 16, self.lane), (self.review, 6, self.lane),
            (self.done, 3, self.lane), (self.done, 1, self.other_lane),
        )
        flow = self.flow()
        rollup = fm.swimlane_completion_rollup(flow)
        self.assertEqual(rollup[self.other_lane.id]["velocity_7d"], 1)
        self.assertNotIn(self.lane.id, rollup)
        heatmap = fm.completed_dwell_by_swimlane(flow, self.last(30))
        self.assertEqual(set(heatmap), {self.other_lane.id})
        directory = fm.card_directory(flow, [card.uid])
        self.assertEqual([row["swimlane"]["id"] for row in directory], [self.other_lane.id])

    def test_ungrouped_payload_unchanged_by_lane_change(self):
        self.finished_then_moved(13)
        self.history((self.backlog, 30, self.lane), (self.doing, 20, self.lane), (self.doing, 10, self.other_lane))
        self.history(
            (self.backlog, 30, self.lane), (self.doing, 20, self.lane), (self.doing, 15, self.other_lane),
            (self.review, 10, self.other_lane), (self.done, 5, self.other_lane),
        )
        for metric in GROUPED_METRICS:
            with self.subTest(metric=metric):
                self.assertEqual(
                    _strip_grouping(self.get_at_now(metric, group_by="swimlane")), self.get_at_now(metric),
                )

    def test_label_grouping_still_reads_current_values_at_every_anchor(self):
        label = self.board.labels.create(name="red")
        card = self.finished_then_moved(13)
        card.labels.add(label)
        body = self.get_at_now("cycle-time", group_by="label")
        self.assertEqual(body["samples"][0]["group_keys"], [str(label.id)])
