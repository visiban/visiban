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
        cards["wip"].labels.add(self.label)
        cards["recent"].labels.add(self.label)
        # Imported long ago with no creation row, archived without an event.
        imported = self.card(self.done, created=500, archived=400)
        self.row(imported, self.doing, self.done, 450)
        cards["imported_old"] = imported
        # Created recently by an import but archived "before" it (bad data).
        odd = self.card(self.backlog, created=3, archived=300)
        cards["created_recent_archived_old"] = odd
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

    def test_old_archived_history_is_not_loaded(self):
        cards = self.aged_board()
        flow_range = fm.rolling_range(90, now=self.now)
        narrowed = fm.load_range_flow(self.board, flow_range, now=self.now)
        full = fm.load_board_flow(self.board, now=self.now)
        loaded = {card.uid for card in narrowed.cards}
        self.assertLess(len(narrowed.cards), len(full.cards) / 3)
        for kept in ("recent", "wip", "untouched", "archived_recent", "archived_no_event", "future",
                     "created_recent_archived_old", "old"):
            self.assertIn(cards[kept].uid, loaded, kept)
        for skipped in ("archived_old", "imported_old"):
            self.assertNotIn(cards[skipped].uid, loaded, skipped)

    def test_cumulative_flow_counts_skipped_finished_work_in_its_band(self):
        self.aged_board()
        flow_range = fm.rolling_range(90, now=self.now)
        flow = fm.load_cumulative_flow(self.board, flow_range, now=self.now)
        # 48 archived done cards from the generations, the imported one and the
        # restored one; the generations archived outside done leave the diagram.
        self.assertEqual(flow.settled_placements, {self.done.uid: 50})
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
