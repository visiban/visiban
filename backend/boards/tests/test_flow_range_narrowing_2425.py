"""Range metrics load only the cards that can change the range (#2425, #2426, #2427).

Every ``metrics/*`` endpoint used to replay the board's whole lifetime history,
so its cost grew with the board's age. Now each loads only the cards
``flow_metrics.can_affect_range`` keeps. These tests pin the claim that makes
that safe: on a board with years of archived history outside the window, every
response is byte-for-byte what the unnarrowed load returns, for every range,
filter and grouping, and the old history is really left out.
"""
import datetime
from unittest import mock

from boards.models import CardBlock, CardMovement, Card, Column, Label, SubColumn
from boards.services import flow_metrics as fm
from boards.tests import test_flow_metrics
from boards.tests.test_flow_metrics import ARCHIVED, UNARCHIVED, EndpointFixture, FlowFixture


def _full_range_load(board, flow_range, *, now, swimlane_id=None, label_id=None, columns=None):
    """The pre-#2425 load: every card the filter selects, with its whole history."""
    return fm.load_board_flow(board, swimlane_id=swimlane_id, label_id=label_id, now=now, columns=columns)


class AgedBoardMixin:
    """``NarrowedLoadTests.mixed_board`` plus years of archived generations and the odd histories."""

    def aged_board(self):
        cards = test_flow_metrics.NarrowedLoadTests.mixed_board(self)
        self.label = Label.objects.create(board=self.board, name="Bug", color="#ff0000")
        legacy = Column.objects.create(board=self.board, name="Legacy", position=6)
        # Three years of finished, archived work: done, then archived a little later.
        for quarter in range(1, 13):
            base = 90 * quarter + 30
            for lane in (self.lane, self.other_lane):
                old = self.path(self.backlog, base + 40, self.doing, base + 20, self.done, base, archived=base - 5, lane=lane)
                old.labels.add(self.label)
                self.path(self.backlog, base + 30, self.doing, base + 10, archived=base - 2, lane=lane)
                # Through a column that was later deleted, then done.
                self.path(self.backlog, base + 20, legacy, base + 10, self.done, base + 5, archived=base, lane=lane)
        # Done 6h before a 90-day window opens (after the midnight its first day
        # buckets from), then archived: only range_boundary's midnight clause
        # keeps it, and its done count lands in the first bucket.
        self.path(self.backlog, 95, self.doing, 92, self.done, 90.25, archived=90.2)
        cards["wip"].labels.add(self.label)
        cards["recent"].labels.add(self.label)
        # Imported long ago with no creation row, archived without an event.
        imported = self.card(self.done, created=500, archived=400)
        self.row(imported, self.doing, self.done, 450)
        cards["imported_old"] = imported
        # Created recently by an import but archived "before" it (bad data).
        odd = self.card(self.backlog, created=3, archived=300)
        cards["created_recent_archived_old"] = odd
        # Archived long ago but with a movement dated inside the window: only
        # the movement clause keeps it.
        moved = self.card(self.done, created=300, archived=200)
        self.row(moved, self.doing, self.done, 250)
        self.row(moved, self.done, self.done, 10)
        cards["moved_in_range_archived_old"] = moved
        # Finished and archived long ago, never moved at all (no rows).
        cards["no_movements_old"] = self.card(self.done, created=500, archived=400)
        # Restored then archived again, all long ago.
        restored = self.path(self.backlog, 400, self.doing, 380, self.done, 370, archived=360)
        self.row(restored, self.done, self.done, 350, UNARCHIVED)
        self.row(restored, self.done, self.done, 340, ARCHIVED)
        Card.objects.filter(pk=restored.pk).update(archived_at=self.ago(340))
        # A done entry dated after now: excluded in every range.
        future = self.path(self.backlog, 300, self.doing, 290)
        CardMovement.objects.create(
            card=future, from_column=self.doing, from_column_uid=self.doing.uid, from_column_name="Doing",
            to_column=self.done, to_column_uid=self.done.uid, to_column_name="Done", moved_by=self.user,
            to_swimlane=future.swimlane,
        )
        CardMovement.objects.filter(card=future, to_column=self.done).update(moved_at=self.now + datetime.timedelta(days=2))
        cards["future"] = future
        # The same, on a card archived long ago: only the movement clause keeps
        # it, and it counts in excluded_incomplete_history in every range.
        future_old = self.path(self.backlog, 300, self.doing, 290, archived=280)
        CardMovement.objects.create(
            card=future_old, from_column=self.doing, from_column_uid=self.doing.uid, from_column_name="Doing",
            to_column=self.done, to_column_uid=self.done.uid, to_column_name="Done", moved_by=self.user,
            to_swimlane=future_old.swimlane,
        )
        CardMovement.objects.filter(card=future_old, to_column=self.done).update(
            moved_at=self.now + datetime.timedelta(days=2),
        )
        cards["future_archived_old"] = future_old
        # Blocks inside and outside the window.
        CardBlock.objects.create(card=cards["wip"], board=self.board, reason="api", blocked_at=self.ago(5))
        CardBlock.objects.create(
            card=cards["recent"], board=self.board, reason="old", blocked_at=self.ago(30), unblocked_at=self.ago(25),
        )
        # A column deleted after the history was written.
        legacy.delete()
        return cards


class RangeNarrowingEquivalenceTests(AgedBoardMixin, EndpointFixture):
    """Every range endpoint answers exactly as the whole-history load does."""

    METRIC_PARAMS = {
        "cycle-time": [{}, {"group_by": "swimlane"}, {"group_by": "label"}],
        "throughput": [{}, {"period": "day"}, {"group_by": "label"}],
        "cumulative-flow": [{}],
        "wip-age": [{}, {"group_by": "swimlane"}],
        "dwell": [{}, {"group_by": "swimlane"}, {"group_by": "label"}],
        "attention": [{}],
        "swimlanes": [{}],
    }
    RANGES = [{"days": "1"}, {"days": "7"}, {"days": "30"}, {"days": "90"}, {"days": "365"}]

    def get(self, metric, params):
        with mock.patch("django.utils.timezone.now", return_value=self.now):
            resp = self.client.get(self.url(metric), params)
        self.assertEqual(resp.status_code, 200, resp.content)
        return resp.json()

    def assert_same(self, metric, params):
        narrowed = self.get(metric, params)
        with (
            mock.patch.object(fm, "load_range_flow", _full_range_load),
            mock.patch.object(fm, "load_cumulative_flow", _full_range_load),
        ):
            full = self.get(metric, params)
        self.assertEqual(narrowed, full)

    def test_every_endpoint_range_and_filter_matches_the_full_replay(self):
        self.aged_board()
        today = self.now.date()
        ranges = [
            *self.RANGES,
            {"from_date": (today - datetime.timedelta(days=60)).isoformat()},
            {
                "from_date": (today - datetime.timedelta(days=400)).isoformat(),
                "to_date": (today - datetime.timedelta(days=200)).isoformat(),
            },
        ]
        filters = [{}, {"swimlane_id": str(self.other_lane.pk)}, {"label_id": str(self.label.pk)}]
        for metric, variants in self.METRIC_PARAMS.items():
            for variant in variants:
                for window in ranges:
                    for flt in filters:
                        if metric == "swimlanes" and "swimlane_id" in flt:
                            continue
                        params = {**variant, **window, **flt}
                        with self.subTest(metric=metric, params=params):
                            self.assert_same(metric, params)

    def test_every_endpoint_loads_through_the_narrowed_loader(self):
        """A view reverting to ``load_board_flow`` would still match the full replay, so pin the call itself."""
        self.aged_board()
        full_count = len(fm.load_board_flow(self.board, now=self.now).cards)
        for metric in self.METRIC_PARAMS:
            loader = "load_cumulative_flow" if metric == "cumulative-flow" else "load_range_flow"
            loaded = []

            def spy(*args, _real=getattr(fm, loader), **kwargs):
                flow = _real(*args, **kwargs)
                loaded.append(len(flow.cards))
                return flow

            with self.subTest(metric=metric):
                with mock.patch.object(fm, loader, side_effect=spy) as patched:
                    self.get(metric, {"days": "90"})
                self.assertEqual(patched.call_count, 1)
                self.assertEqual(len(loaded), 1)
                self.assertLess(loaded[0], full_count / 3)

    def test_old_archived_history_is_not_loaded(self):
        cards = self.aged_board()
        flow_range = fm.rolling_range(90, now=self.now)
        narrowed = fm.load_range_flow(self.board, flow_range, now=self.now)
        full = fm.load_board_flow(self.board, now=self.now)
        loaded = {card.uid for card in narrowed.cards}
        self.assertLess(len(narrowed.cards), len(full.cards) / 3)
        for kept in ("recent", "wip", "untouched", "archived_recent", "archived_no_event", "future", "future_archived_old",
                     "created_recent_archived_old", "moved_in_range_archived_old", "old"):
            self.assertIn(cards[kept].uid, loaded, kept)
        for skipped in ("archived_old", "imported_old", "no_movements_old"):
            self.assertNotIn(cards[skipped].uid, loaded, skipped)

    def test_cumulative_flow_counts_skipped_finished_work_in_its_band(self):
        self.aged_board()
        flow_range = fm.rolling_range(90, now=self.now)
        flow = fm.load_cumulative_flow(self.board, flow_range, now=self.now)
        # 48 archived done cards from the generations, the imported one, the
        # restored one and the one with no movement rows; the generations
        # archived outside done leave the diagram. The midnight-clause card and
        # the moved one are loaded, not settled.
        self.assertEqual(flow.settled_placements, {self.done.uid: 51})
        full = fm.cumulative_flow(fm.load_board_flow(self.board, now=self.now), flow_range)
        self.assertEqual(fm.cumulative_flow(flow, flow_range), full)


class RangeNarrowingServiceTests(AgedBoardMixin, FlowFixture):
    """The service functions the endpoints call, on a fixed clock, including the edges a request cannot reach."""

    def test_every_metric_matches_the_full_replay(self):
        self.aged_board()
        full = fm.load_board_flow(self.board, now=self.now)
        lanes = list(self.board.swimlanes.order_by("position", "id"))
        for days in (1, 7, 30, 90, 120, 365):
            flow_range = fm.rolling_range(days, now=self.now)
            narrowed = fm.load_range_flow(self.board, flow_range, now=self.now)
            with self.subTest(days=days):
                self.assertEqual(fm.lead_time(narrowed, flow_range), fm.lead_time(full, flow_range))
                self.assertEqual(fm.cycle_time(narrowed, flow_range), fm.cycle_time(full, flow_range))
                for period in ("day", "week"):
                    self.assertEqual(fm.throughput(narrowed, flow_range, period), fm.throughput(full, flow_range, period))
                self.assertEqual(fm.completed_dwell(narrowed, flow_range), fm.completed_dwell(full, flow_range))
                self.assertEqual(fm.current_dwell(narrowed), fm.current_dwell(full))
                self.assertEqual(fm.age(narrowed, flow_range), fm.age(full, flow_range))
                self.assertEqual(fm.wip(narrowed), fm.wip(full))
                self.assertEqual(
                    fm.needs_attention(narrowed, flow_range, stalled_days=7),
                    fm.needs_attention(full, flow_range, stalled_days=7),
                )
                self.assertEqual(
                    fm.swimlane_comparison(narrowed, flow_range, lanes),
                    fm.swimlane_comparison(full, flow_range, lanes),
                )

    def test_a_range_with_no_live_or_recent_card_keeps_the_gate_index(self):
        """Only old archived cards: the narrowed load selects none, and dwell still reports the gated stage."""
        build = Column.objects.create(board=self.board, name="Build", position=5)
        for i, name in enumerate(("Work", "Wait")):
            SubColumn.objects.create(column=build, position=i, name=name)
        self.path(self.backlog, 300, build, 200, self.done, 150, archived=140)
        flow_range = fm.rolling_range(30, now=self.now)
        narrowed = fm.load_range_flow(self.board, flow_range, now=self.now)
        full = fm.load_board_flow(self.board, now=self.now)
        self.assertEqual(narrowed.cards, [])
        self.assertEqual(set(narrowed.gate_last), set(full.gate_last))
        self.assertEqual(fm.completed_dwell(narrowed, flow_range), fm.completed_dwell(full, flow_range))

    def test_an_empty_board_stays_empty(self):
        flow_range = fm.rolling_range(30, now=self.now)
        narrowed = fm.load_cumulative_flow(self.board, flow_range, now=self.now)
        self.assertEqual(narrowed.gate_last, {})
        self.assertEqual(
            fm.cumulative_flow(narrowed, flow_range),
            fm.cumulative_flow(fm.load_board_flow(self.board, now=self.now), flow_range),
        )

    def test_another_boards_cards_stay_out_of_both_loads(self):
        """The range load and the folded skipped cards read only this board's cards."""
        from boards.models import Board, Swimlane

        self.path(self.backlog, 300, self.doing, 200, self.done, 150, archived=140)
        other = Board.objects.create(name="Other", owner=self.user)
        other_done = Column.objects.create(board=other, name="Done", position=0, is_done=True)
        other_lane = Swimlane.objects.create(board=other, name="L", position=0)
        for days in (3, 300):
            card = Card.objects.create(
                board=other, column=other_done, swimlane=other_lane, title="x", created_by=self.user, position=0,
            )
            Card.objects.filter(pk=card.pk).update(created_at=self.ago(days), archived_at=self.ago(days - 1))
            self.row(card, None, other_done, days)
        flow_range = fm.rolling_range(30, now=self.now)
        flow = fm.load_cumulative_flow(self.board, flow_range, now=self.now)
        self.assertEqual(flow.cards, [])
        self.assertEqual(flow.settled_placements, {self.done.uid: 1})


class CumulativeFlowRaceTests(AgedBoardMixin, FlowFixture):
    def test_a_movement_for_a_card_outside_the_skipped_set_is_ignored(self):
        """A card restored between the row query and the movement query streams movements but is not in ``cards``."""
        self.path(self.backlog, 300, self.doing, 200, self.done, 150, archived=140)
        stray = self.path(self.backlog, 5, self.doing, 2)
        real = fm._movement_rows

        def with_stray(qs):
            rows = list(real(qs))
            return rows + [(stray.pk, rows[0][1])] if rows else rows

        flow_range = fm.rolling_range(30, now=self.now)
        with mock.patch.object(fm, "_movement_rows", with_stray):
            flow = fm.load_cumulative_flow(self.board, flow_range, now=self.now)
        self.assertEqual(flow.settled_placements, {self.done.uid: 1})
