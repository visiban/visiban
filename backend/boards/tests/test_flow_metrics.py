"""The flow metric service and its REST endpoints (#448, ADR #1532).

The edge-case and missing-history tests follow the tables in
``docs/architecture/decisions.md`` § Flow metric definitions row by row, so a
change to the record has one obvious place to land.
"""
import datetime
from pathlib import Path

import jsonschema
from django.conf import settings
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from drf_spectacular.generators import SchemaGenerator
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, CardBlock, CardMovement, CardRelation, Column, Label, Swimlane,
)
from boards.services import flow_metrics as fm
from boards.tests.test_move_schema_contract import _openapi3_nullable_to_jsonschema

MOVE = CardMovement.MovementType.MOVE
ARCHIVED = CardMovement.MovementType.ARCHIVED
UNARCHIVED = CardMovement.MovementType.UNARCHIVED


class FlowFixture(TestCase):
    """A Backlog / Doing / Review / Done / Released board and a history builder."""

    def setUp(self):
        # Fixed mid-Wednesday, far from a day or week edge, so nothing depends
        # on when the suite runs.
        self.now = datetime.datetime(2026, 7, 15, 12, 0, tzinfo=datetime.timezone.utc)
        self.user = User.objects.create_user(username="flow_owner", password="pw")
        self.board = Board.objects.create(name="Flow", owner=self.user)
        BoardMembership.objects.create(board=self.board, user=self.user, role="admin")
        self.backlog = Column.objects.create(board=self.board, name="Backlog", position=0)
        self.doing = Column.objects.create(board=self.board, name="Doing", position=1)
        self.review = Column.objects.create(board=self.board, name="Review", position=2)
        self.done = Column.objects.create(board=self.board, name="Done", position=3, is_done=True)
        self.released = Column.objects.create(board=self.board, name="Released", position=4, is_done=True)
        self.lane = Swimlane.objects.create(board=self.board, name="Lane", position=0)
        self.other_lane = Swimlane.objects.create(board=self.board, name="Other", position=1)

    def ago(self, days):
        return self.now - datetime.timedelta(days=days)

    def card(self, column=None, *, created=None, archived=None, lane=None, title="Card"):
        card = Card.objects.create(
            board=self.board, column=column or self.backlog, swimlane=lane or self.lane,
            title=title, created_by=self.user, position=Card.objects.count(),
        )
        # auto_now_add: the real value is only settable by a queryset update.
        Card.objects.filter(pk=card.pk).update(
            created_at=self.ago(created if created is not None else 100),
            archived_at=self.ago(archived) if archived is not None else None,
        )
        card.refresh_from_db()
        return card

    def row(self, card, source, target, days_ago, kind=MOVE):
        """One movement row; a Column writes the FK and both snapshots, None writes none."""
        mv = CardMovement.objects.create(
            card=card,
            from_column=source, from_column_name=source.name if source else "",
            from_column_uid=source.uid if source else "",
            to_column=target, to_column_name=target.name if target else "",
            to_column_uid=target.uid if target else "",
            to_swimlane=card.swimlane, moved_by=self.user, movement_type=kind,
        )
        # Queryset update: CardMovement.save() refuses an existing row (#1469).
        CardMovement.objects.filter(pk=mv.pk).update(moved_at=self.ago(days_ago))
        return mv

    def path(self, *steps, archived=None, lane=None):
        """A native card: ``path(backlog, 10, doing, 5, done, 1)`` is created then moved."""
        columns, days = steps[0::2], steps[1::2]
        card = self.card(columns[-1], created=days[0], archived=archived, lane=lane)
        self.row(card, None, columns[0], days[0])
        for source, target, day in zip(columns, columns[1:], days[1:]):
            self.row(card, source, target, day)
        if archived is not None:
            self.row(card, columns[-1], columns[-1], archived, ARCHIVED)
        return card

    def flow(self, **filters):
        return fm.load_board_flow(self.board, now=self.now, **filters)

    def last(self, days=30):
        return fm.rolling_range(days, now=self.now)

    def by_card(self, payload):
        return {s["card_uid"]: s for s in payload["samples"]}


class DefinitionTests(TestCase):
    def test_docs_quote_every_definition_verbatim(self):
        """ADR "Changes handed to #448" item 11: the record, the docs and the API say one thing."""
        docs = Path(settings.BASE_DIR).parent / "docs"
        if not docs.is_dir():
            self.skipTest("docs/ is not in this checkout (a backend-only image)")
        pages = [(docs / page).read_text() for page in ("architecture/decisions.md", "features/analytics.md")]
        for metric, definition in fm.DEFINITIONS.items():
            for page in pages:
                with self.subTest(metric=metric):
                    self.assertIn(definition, page)


class PercentileTests(TestCase):
    def test_rank_is_the_integer_nearest_rank(self):
        self.assertEqual(fm.percentile_rank(50, 4), 2)
        self.assertEqual(fm.percentile_rank(85, 7), 6)
        self.assertEqual(fm.percentile_rank(95, 20), 19)
        # float8 percentile_disc rounds this one up to 56; the integer rank does not.
        self.assertEqual(fm.percentile_rank(55, 100), 55)

    def test_each_percentile_appears_at_its_own_floor(self):
        for n, expected in (
            (4, (None, None, None)),
            (5, (3, None, None)),
            (6, (3, None, None)),
            (7, (4, 6, None)),
            (19, (10, 17, None)),
            (20, (10, 17, 19)),
        ):
            with self.subTest(n=n):
                result = fm.percentiles(list(range(1, n + 1)))
                self.assertEqual((result["p50"], result["p85"], result["p95"]), expected)

    def test_values_are_real_samples_and_input_order_does_not_matter(self):
        self.assertEqual(fm.percentiles([9.5, 1.25, 3.0, 2.0, 8.0])["p50"], 3.0)

    def test_the_minimum_lives_in_one_constant(self):
        self.assertEqual(fm.MIN_PERCENTILE_SAMPLE_SIZE, 5)


class EdgeCaseTableTests(FlowFixture):
    """ADR § Edge cases, one test per row."""

    def assert_row(self, card, lead=None, cycle=None, age=None, dwell=None, throughput=True):
        flow = self.flow()
        window = self.last(365)
        leads = self.by_card(fm.lead_time(flow, window))
        cycles = self.by_card(fm.cycle_time(flow, window))
        ages = self.by_card(fm.age(flow, window))
        self.assertEqual(leads[card.uid]["value_days"] if card.uid in leads else None, lead, "lead time")
        self.assertEqual(cycles[card.uid]["value_days"] if card.uid in cycles else None, cycle, "cycle time")
        self.assertEqual(ages[card.uid]["value_days"] if card.uid in ages else None, age, "age")
        weeks = fm.throughput(flow, window, "day")
        counted = sum(s["card_uids"].count(card.uid) for s in weeks["samples"])
        self.assertEqual(counted, 1 if throughput else 0, "throughput")
        if dwell is not None:
            completed = [
                (s["column_uid"], s["value_days"]) for s in fm.completed_dwell(flow, window)["samples"]
                if s["card_uid"] == card.uid
            ]
            current = [
                (s["column_uid"], s["value_days"]) for s in fm.current_dwell(flow)["samples"]
                if s["card_uid"] == card.uid
            ]
            self.assertEqual(completed + current, dwell, "dwell")

    def test_work_doing_done(self):
        card = self.path(self.backlog, 10, self.doing, 6, self.done, 1)
        self.assert_row(
            card, lead=9, cycle=5,
            dwell=[(self.backlog.uid, 4), (self.doing.uid, 5)],
        )

    def test_work_straight_to_done(self):
        card = self.path(self.backlog, 10, self.done, 1)
        self.assert_row(card, lead=9, dwell=[(self.backlog.uid, 9)])

    def test_straight_to_done_then_reopened_gets_no_cycle_time_from_later_work(self):
        card = self.path(self.backlog, 10, self.done, 7, self.doing, 3, self.done, 1)
        self.assert_row(card, lead=3, dwell=[(self.backlog.uid, 3), (self.doing.uid, 2)])
        self.assertTrue(self.by_card(fm.lead_time(self.flow(), self.last()))[card.uid]["reopened"])

    def test_reopened_card_keeps_its_first_completion(self):
        card = self.path(self.backlog, 20, self.doing, 15, self.done, 10, self.review, 5, self.done, 1)
        self.assert_row(
            card, lead=10, cycle=5,
            dwell=[(self.backlog.uid, 5), (self.doing.uid, 5), (self.review.uid, 4)],
        )
        sample = self.by_card(fm.cycle_time(self.flow(), self.last()))[card.uid]
        self.assertTrue(sample["reopened"])

    def test_age_runs_from_the_reopen_while_a_card_is_open_again(self):
        card = self.path(self.backlog, 20, self.doing, 15, self.done, 10, self.review, 5)
        self.assert_row(
            card, lead=10, cycle=5, age=5,
            dwell=[(self.backlog.uid, 5), (self.doing.uid, 5), (self.review.uid, 5)],
        )

    def test_created_in_done_stays(self):
        card = self.path(self.done, 3)
        self.assert_row(card, dwell=[])

    def test_created_in_done_then_reopened(self):
        card = self.path(self.done, 10, self.doing, 5, self.done, 1)
        self.assert_row(card, dwell=[(self.doing.uid, 4)])

    def test_created_in_done_and_reopened_has_age_from_the_reopen(self):
        card = self.path(self.done, 10, self.doing, 5)
        self.assert_row(card, age=5, dwell=[(self.doing.uid, 5)])

    def test_never_moved(self):
        card = self.path(self.backlog, 10)
        self.assert_row(card, throughput=False, dwell=[(self.backlog.uid, 10)])

    def test_moved_back_to_the_creation_column_keeps_age_running(self):
        card = self.path(self.backlog, 10, self.doing, 7, self.backlog, 2)
        self.assert_row(
            card, age=7, throughput=False,
            dwell=[(self.backlog.uid, 3), (self.doing.uid, 5), (self.backlog.uid, 2)],
        )

    def test_archived_in_a_work_column(self):
        card = self.path(self.backlog, 10, self.doing, 6, archived=2)
        self.assert_row(card, throughput=False, dwell=[(self.backlog.uid, 4), (self.doing.uid, 4)])

    def test_completed_then_archived(self):
        card = self.path(self.backlog, 10, self.done, 5, archived=2)
        self.assert_row(card, lead=5, dwell=[(self.backlog.uid, 5)])

    def test_admin_edit_to_done_without_a_movement(self):
        card = self.path(self.backlog, 10, self.doing, 6)
        Card.objects.filter(pk=card.pk).update(column=self.done)
        self.assert_row(card, throughput=False, dwell=[(self.backlog.uid, 4)])

    def test_admin_sets_archived_at_without_an_event(self):
        card = self.path(self.backlog, 10, self.doing, 6)
        Card.objects.filter(pk=card.pk).update(archived_at=self.ago(2))
        self.assert_row(card, throughput=False, dwell=[(self.backlog.uid, 4), (self.doing.uid, 4)])

    def test_deleted_and_recreated_column_is_never_credited(self):
        old_review = Column.objects.create(board=self.board, name="Old Review", position=9)
        card = self.path(self.backlog, 10, old_review, 6, self.done, 1)
        uid = old_review.uid
        old_review.delete()
        recreated = Column.objects.create(board=self.board, name="Old Review", position=9)
        self.assert_row(card, lead=9, cycle=5, dwell=[(self.backlog.uid, 4), (None, 5)])
        dwell = fm.completed_dwell(self.flow(), self.last())
        column = next(c for c in dwell["columns"] if c["column_uid"] == recreated.uid)
        self.assertEqual(column["sample_size"], 0)
        self.assertNotEqual(recreated.uid, uid)

    def test_deleted_column_never_keeps_its_done_flag(self):
        shipped = Column.objects.create(board=self.board, name="Shipped", position=9, is_done=True)
        card = self.path(self.backlog, 10, shipped, 5)
        # Move it off first: deleting a column cascades to the cards still in it.
        Card.objects.filter(pk=card.pk).update(column=self.backlog)
        shipped.delete()
        # The FK is gone, the snapshot uid is not a current column: no completion.
        self.assertIsNone(self.flow().cards[0].completion_at)

    def test_a_done_flag_applies_to_the_past_when_it_is_set(self):
        card = self.path(self.backlog, 10, self.doing, 6, self.review, 2)
        Column.objects.filter(pk=self.review.pk).update(is_done=True)
        self.assert_row(card, lead=8, cycle=4)

    def test_moving_between_done_columns_is_not_a_new_completion(self):
        card = self.path(self.backlog, 10, self.doing, 6, self.done, 4, self.released, 1)
        self.assert_row(card, lead=6, cycle=2)

    def test_swimlane_only_move_is_not_a_transition_and_does_not_split_a_visit(self):
        card = self.path(self.backlog, 10, self.doing, 6)
        self.row(card, self.doing, self.doing, 3)
        self.assert_row(card, age=6, throughput=False, dwell=[(self.backlog.uid, 4), (self.doing.uid, 6)])

    def test_restoring_starts_a_new_visit_and_excludes_the_archived_period(self):
        card = self.path(self.backlog, 10, self.doing, 8)
        self.row(card, self.doing, self.doing, 6, ARCHIVED)
        self.row(card, self.doing, self.doing, 2, UNARCHIVED)
        self.assert_row(
            card, age=8, throughput=False,
            dwell=[(self.backlog.uid, 2), (self.doing.uid, 2), (self.doing.uid, 2)],
        )


class MissingHistoryTableTests(FlowFixture):
    """ADR § Missing history."""

    def test_no_creation_movement(self):
        card = self.card(self.done, created=12)
        self.row(card, self.backlog, self.done, 2)
        flow = self.flow()
        self.assertEqual(self.by_card(fm.lead_time(flow, self.last()))[card.uid]["value_days"], 10)
        self.assertEqual(self.by_card(fm.cycle_time(flow, self.last())), {})
        self.assertEqual(fm.cycle_time(flow, self.last())["excluded_incomplete_history"], 1)
        self.assertEqual(fm.throughput(flow, self.last(), "day")["total"], 1)

    def test_card_with_no_history_at_all_counts_in_wip_but_not_in_age(self):
        card = self.card(self.doing, created=12)
        flow = self.flow()
        self.assertEqual(fm.age(flow, self.last())["sample_size"], 0)
        self.assertEqual(fm.age(flow, self.last())["excluded_incomplete_history"], 1)
        wip = {c["column_uid"]: c for c in fm.wip(flow)["columns"]}
        self.assertEqual(wip[self.doing.uid]["card_uids"], [card.uid])
        self.assertEqual(wip[self.doing.uid]["count"], 1)

    def test_import_whose_history_names_a_deleted_column(self):
        card = self.card(self.done, created=12)
        self.row(card, None, self.backlog, 10)
        self.row(card, self.backlog, None, 6)  # the destination lost its name
        self.row(card, None, self.done, 2)  # and so did the source here
        flow = self.flow()
        self.assertFalse(flow.cards[0].complete_history)
        self.assertEqual(self.by_card(fm.cycle_time(flow, self.last())), {})
        # The visit to Backlog has no closing transition and no current column.
        dwell = [s for s in fm.completed_dwell(flow, self.last())["samples"] if s["card_uid"] == card.uid]
        self.assertEqual(dwell, [])
        self.assertEqual(fm.current_dwell(flow)["excluded_incomplete_history"], 1)

    def test_creation_row_that_lost_its_column_uses_created_at_for_lead_time(self):
        card = self.card(self.done, created=12)
        self.row(card, None, None, 10)
        self.row(card, self.doing, self.done, 2)
        flow = self.flow()
        self.assertEqual(self.by_card(fm.lead_time(flow, self.last()))[card.uid]["value_days"], 10)
        self.assertFalse(flow.cards[0].has_creation)

    def test_broken_continuity_excludes_cycle_time_but_keeps_lead_time_and_throughput(self):
        card = self.card(self.done, created=12)
        self.row(card, None, self.backlog, 12)
        self.row(card, self.backlog, self.doing, 8)
        self.row(card, self.review, self.done, 2)  # left from a column it was never in
        flow = self.flow()
        self.assertEqual(self.by_card(fm.lead_time(flow, self.last()))[card.uid]["value_days"], 10)
        cycle = fm.cycle_time(flow, self.last())
        self.assertEqual(cycle["sample_size"], 0)
        self.assertEqual(cycle["excluded_incomplete_history"], 1)
        self.assertEqual(fm.throughput(flow, self.last(), "day")["total"], 1)
        # Doing's visit closed by a movement leaving Review: not measured, and said so.
        dwell = fm.completed_dwell(flow, self.last())
        self.assertEqual([s["column_uid"] for s in dwell["samples"]], [self.backlog.uid])
        self.assertEqual(dwell["excluded_incomplete_history"], 1)

    def test_broken_history_that_could_never_have_a_cycle_time_is_not_an_exclusion(self):
        self.card(self.done, created=12)
        card = Card.objects.get()
        self.row(card, None, self.backlog, 12)
        self.row(card, self.backlog, self.done, 2)
        Card.objects.filter(pk=card.pk).update(column=self.released)  # broken, but straight to done
        cycle = fm.cycle_time(self.flow(), self.last())
        self.assertEqual((cycle["sample_size"], cycle["excluded_incomplete_history"]), (0, 0))

    def test_archived_at_without_an_event_breaks_continuity_for_cycle_time(self):
        card = self.path(self.backlog, 10, self.doing, 6, self.done, 2)
        Card.objects.filter(pk=card.pk).update(archived_at=self.ago(1))
        self.assertFalse(self.flow().cards[0].complete_history)

    def test_future_dated_movement_is_ignored_and_makes_history_incomplete(self):
        card = self.path(self.backlog, 10, self.doing, 6)
        self.row(card, self.doing, self.review, -3)
        Card.objects.filter(pk=card.pk).update(column=self.review)
        flow = self.flow()
        self.assertFalse(flow.cards[0].complete_history)
        self.assertEqual(fm.age(flow, self.last())["sample_size"], 0)
        # The Doing visit is open, in a column that is not the card's: excluded.
        current = fm.current_dwell(flow)
        self.assertEqual(current["sample_size"], 0)
        self.assertEqual(current["excluded_incomplete_history"], 1)

    def test_future_dated_completion_is_counted_as_excluded_not_lost(self):
        card = self.path(self.backlog, 10, self.doing, 6)
        self.row(card, self.doing, self.done, -3)
        Card.objects.filter(pk=card.pk).update(column=self.done)
        flow = self.flow()
        self.assertEqual(fm.throughput(flow, self.last(), "day")["total"], 0)
        self.assertEqual(fm.cycle_time(flow, self.last())["excluded_incomplete_history"], 1)
        self.assertEqual(fm.lead_time(flow, self.last())["excluded_incomplete_history"], 1)

    def test_negative_lead_time_is_dropped_and_counted_never_clamped(self):
        card = self.card(self.done, created=1)
        self.row(card, self.backlog, self.done, 5)
        lead = fm.lead_time(self.flow(), self.last())
        self.assertEqual((lead["sample_size"], lead["excluded_incomplete_history"]), (0, 1))

    def test_negative_visit_is_dropped_and_counted(self):
        card = self.path(self.backlog, 10, self.doing, 6)
        Card.objects.filter(pk=card.pk).update(archived_at=self.ago(8))
        dwell = fm.completed_dwell(self.flow(), self.last())
        self.assertEqual(dwell["excluded_incomplete_history"], 1)
        self.assertEqual([s["column_uid"] for s in dwell["samples"]], [self.backlog.uid])

    def test_hard_deleted_card_is_left_out_of_everything(self):
        card = self.path(self.backlog, 10, self.doing, 6, self.done, 2)
        card.delete()
        self.assertTrue(CardMovement.objects.filter(card__isnull=True).exists())
        flow = self.flow()
        self.assertEqual(fm.cycle_time(flow, self.last())["sample_size"], 0)
        self.assertEqual(fm.throughput(flow, self.last(), "day")["total"], 0)
        self.assertEqual(sum(fm.cumulative_flow(flow, self.last())["days"][-1]["counts"].values()), 0)


class ColumnKeyTests(FlowFixture):
    def test_name_only_row_never_matches_a_current_column(self):
        """A name snapshot of a current column's name is still a different column."""
        card = self.card(self.done, created=12)
        self.row(card, None, self.backlog, 10)
        mv = self.row(card, self.backlog, None, 6)
        CardMovement.objects.filter(pk=mv.pk).update(to_column_name="Done")
        flow = self.flow()
        self.assertIsNone(flow.cards[0].completion_at)

    def test_fk_supplies_the_key_when_the_uid_snapshot_is_empty(self):
        card = self.path(self.backlog, 10, self.doing, 6, self.done, 2)
        CardMovement.objects.filter(card=card).update(from_column_uid="", to_column_uid="")
        self.assertEqual(self.by_card(fm.cycle_time(self.flow(), self.last()))[card.uid]["value_days"], 4)

    def test_snapshot_uid_wins_over_the_fk(self):
        card = self.path(self.backlog, 10, self.doing, 6, self.done, 2)
        CardMovement.objects.filter(card=card, to_column=self.done).update(to_column=self.review)
        self.assertEqual(self.by_card(fm.cycle_time(self.flow(), self.last()))[card.uid]["value_days"], 4)


class WindowTests(FlowFixture):
    def test_rolling_range_is_half_open_on_samples_and_whole_days_on_buckets(self):
        window = fm.rolling_range(7, now=self.now)
        self.assertEqual(window.start, self.ago(7))
        self.assertEqual(window.end, self.now)
        self.assertEqual(window.first_day, datetime.date(2026, 7, 8))
        self.assertEqual(window.last_day, datetime.date(2026, 7, 14))
        self.assertFalse(window.contains(self.now))
        self.assertTrue(window.contains(self.ago(7)))

    def test_date_range_is_inclusive_at_both_ends_and_today_is_never_a_bucket(self):
        window = fm.date_range(datetime.date(2026, 7, 1), datetime.date(2026, 7, 15), now=self.now)
        self.assertEqual(window.end, datetime.datetime(2026, 7, 16, tzinfo=datetime.timezone.utc))
        self.assertEqual(window.last_day, datetime.date(2026, 7, 14))

    def test_a_sample_belongs_to_the_window_of_its_completion(self):
        inside = self.path(self.backlog, 100, self.doing, 90, self.done, 5)
        outside = self.path(self.backlog, 100, self.doing, 90, self.done, 45)
        samples = self.by_card(fm.cycle_time(self.flow(), self.last(30)))
        self.assertIn(inside.uid, samples)
        self.assertNotIn(outside.uid, samples)
        self.assertEqual(samples[inside.uid]["value_days"], 85)

    def test_age_is_a_snapshot_and_only_the_zones_move_with_the_range(self):
        for i in range(7):
            self.path(self.backlog, 100, self.doing, 90, self.done, 40 + i)
        wip = self.path(self.backlog, 100, self.doing, 80)
        flow = self.flow()
        narrow = fm.age(flow, self.last(30))
        wide = fm.age(flow, self.last(90))
        self.assertEqual(self.by_card(narrow)[wip.uid], self.by_card(wide)[wip.uid])
        self.assertIsNone(narrow["cycle_time_percentiles"]["p50"])
        self.assertIsNotNone(wide["cycle_time_percentiles"]["p50"])

    def test_filters_read_the_card_current_swimlane_and_labels(self):
        label = Label.objects.create(board=self.board, name="L")
        here = self.path(self.backlog, 10, self.doing, 6, self.done, 2)
        there = self.path(self.backlog, 10, self.doing, 6, self.done, 2, lane=self.other_lane)
        there.labels.add(label)
        self.assertEqual(list(self.by_card(fm.cycle_time(self.flow(swimlane_id=self.lane.id), self.last()))), [here.uid])
        self.assertEqual(list(self.by_card(fm.cycle_time(self.flow(label_id=label.id), self.last()))), [there.uid])
        self.assertEqual(self.flow(swimlane_id=self.lane.id, label_id=label.id).cards, [])


class ThroughputTests(FlowFixture):
    def test_weeks_are_whole_iso_weeks_inside_the_window(self):
        # 2026-07-15 is a Wednesday; the 30 days before it hold four whole weeks.
        payload = fm.throughput(self.flow(), self.last(30))
        self.assertEqual(payload["period"], "week")
        self.assertEqual(
            [s["start"] for s in payload["samples"]],
            ["2026-06-15", "2026-06-22", "2026-06-29", "2026-07-06"],
        )

    def test_median_needs_five_whole_weeks_and_a_quiet_week_lowers_it(self):
        self.assertIsNone(fm.throughput(self.flow(), self.last(30))["median"])
        monday = datetime.date(2026, 7, 6)
        for weeks_back in (0, 1, 2):
            for _ in range(3):
                day = monday - datetime.timedelta(weeks=weeks_back)
                self.path(self.backlog, 200, self.doing, 150, self.done, (self.now.date() - day).days)
        payload = fm.throughput(self.flow(), self.last(90))
        self.assertEqual(payload["total"], 9)
        # Twelve whole weeks, nine of them empty: the nearest-rank p50 is 0.
        self.assertEqual(len(payload["samples"]), 12)
        self.assertEqual(payload["median"], 0)

    def test_counts_each_card_once_in_the_period_of_its_first_completion(self):
        card = self.path(
            self.backlog, 40, self.doing, 30, self.done, 9, self.review, 8, self.done, 2,
        )
        days = fm.throughput(self.flow(), self.last(30), "day")
        hits = [s["start"] for s in days["samples"] if card.uid in s["card_uids"]]
        self.assertEqual(hits, ["2026-07-06"])

    def test_today_is_never_a_bucket(self):
        self.path(self.backlog, 10, self.done, 0.1)
        self.assertEqual(fm.throughput(self.flow(), self.last(7), "day")["total"], 0)


class CumulativeFlowTests(FlowFixture):
    def counts(self, payload, date):
        return next(d["counts"] for d in payload["days"] if d["date"] == date)

    def test_daily_counts_follow_the_movement_history(self):
        self.path(self.backlog, 10, self.doing, 5, self.done, 2)
        payload = fm.cumulative_flow(self.flow(), self.last(12))
        # 10 days ago is 07-05; moved to Doing 07-10; done 07-13.
        self.assertEqual(self.counts(payload, "2026-07-04")[self.backlog.uid], 0)
        self.assertEqual(self.counts(payload, "2026-07-05")[self.backlog.uid], 1)
        self.assertEqual(self.counts(payload, "2026-07-10")[self.doing.uid], 1)
        self.assertEqual(self.counts(payload, "2026-07-10")[self.backlog.uid], 0)
        self.assertEqual(self.counts(payload, "2026-07-14")[self.done.uid], 1)

    def test_the_last_day_is_yesterday_and_every_column_has_a_count(self):
        payload = fm.cumulative_flow(self.flow(), self.last(3))
        self.assertEqual([d["date"] for d in payload["days"]], ["2026-07-12", "2026-07-13", "2026-07-14"])
        self.assertEqual(
            [c["column_uid"] for c in payload["columns"]],
            [c.uid for c in (self.backlog, self.doing, self.review, self.done, self.released)] + [None],
        )
        self.assertIn(fm.NULL_BAND_KEY, payload["days"][0]["counts"])

    def test_archiving_in_a_work_column_leaves_the_diagram_from_that_day(self):
        self.path(self.backlog, 10, self.doing, 6, archived=3)
        payload = fm.cumulative_flow(self.flow(), self.last(10))
        self.assertEqual(self.counts(payload, "2026-07-11")[self.doing.uid], 1)
        self.assertEqual(self.counts(payload, "2026-07-12")[self.doing.uid], 0)

    def test_archiving_in_a_done_column_stays_counted(self):
        self.path(self.backlog, 10, self.done, 6, archived=3)
        payload = fm.cumulative_flow(self.flow(), self.last(10))
        self.assertEqual(self.counts(payload, "2026-07-14")[self.done.uid], 1)

    def test_archived_at_without_an_event_also_leaves_the_diagram(self):
        card = self.path(self.backlog, 10, self.doing, 6)
        Card.objects.filter(pk=card.pk).update(archived_at=self.ago(3))
        payload = fm.cumulative_flow(self.flow(), self.last(10))
        self.assertEqual(self.counts(payload, "2026-07-12")[self.doing.uid], 0)

    def test_restoring_brings_a_card_back(self):
        card = self.path(self.backlog, 10, self.doing, 6)
        self.row(card, self.doing, self.doing, 4, ARCHIVED)
        self.row(card, self.doing, self.doing, 2, UNARCHIVED)
        payload = fm.cumulative_flow(self.flow(), self.last(10))
        self.assertEqual(self.counts(payload, "2026-07-12")[self.doing.uid], 0)
        self.assertEqual(self.counts(payload, "2026-07-13")[self.doing.uid], 1)

    def test_card_without_creation_movement_starts_in_its_first_source(self):
        card = self.card(self.done, created=8)
        self.row(card, self.doing, self.done, 2)
        payload = fm.cumulative_flow(self.flow(), self.last(10))
        self.assertEqual(self.counts(payload, "2026-07-07")[self.doing.uid], 1)
        self.assertEqual(self.counts(payload, "2026-07-14")[self.done.uid], 1)

    def test_card_with_no_movements_starts_in_its_current_column(self):
        self.card(self.review, created=4)
        payload = fm.cumulative_flow(self.flow(), self.last(10))
        self.assertEqual(self.counts(payload, "2026-07-10")[self.review.uid], 0)
        self.assertEqual(self.counts(payload, "2026-07-11")[self.review.uid], 1)

    def test_deleted_columns_share_one_null_band(self):
        gone = Column.objects.create(board=self.board, name="Gone", position=9)
        self.path(self.backlog, 10, gone, 6, self.doing, 1)
        gone.delete()
        payload = fm.cumulative_flow(self.flow(), self.last(10))
        self.assertEqual(self.counts(payload, "2026-07-12")[fm.NULL_BAND_KEY], 1)
        self.assertEqual(self.counts(payload, "2026-07-14")[fm.NULL_BAND_KEY], 0)
        self.assertEqual(self.counts(payload, "2026-07-14")[self.doing.uid], 1)

    def test_a_card_older_than_the_window_is_counted_from_its_first_day(self):
        self.path(self.backlog, 60)
        payload = fm.cumulative_flow(self.flow(), self.last(3))
        self.assertEqual(payload["days"][0]["counts"][self.backlog.uid], 1)

    def test_bottleneck_is_the_not_done_column_that_grew_most(self):
        for _ in range(2):
            self.path(self.backlog, 20, self.doing, 2)
        self.path(self.backlog, 20, self.review, 2)
        for _ in range(5):
            self.path(self.backlog, 20, self.done, 2)  # done grows most, and never counts
        self.assertEqual(fm.cumulative_flow(self.flow(), self.last(10))["bottleneck_column_uid"], self.doing.uid)

    def test_bottleneck_tie_goes_to_the_earlier_column(self):
        self.path(self.backlog, 20, self.review, 2)
        self.path(self.backlog, 20, self.doing, 2)
        self.assertEqual(fm.cumulative_flow(self.flow(), self.last(10))["bottleneck_column_uid"], self.doing.uid)

    def test_no_bottleneck_when_nothing_grew(self):
        self.path(self.backlog, 20)
        self.path(self.backlog, 20, self.done, 2)
        self.assertIsNone(fm.cumulative_flow(self.flow(), self.last(10))["bottleneck_column_uid"])

    def test_no_bottleneck_and_no_days_before_any_whole_day_exists(self):
        window = fm.date_range(self.now.date(), self.now.date(), now=self.now)
        payload = fm.cumulative_flow(self.flow(), window)
        self.assertEqual(payload["days"], [])
        self.assertIsNone(payload["bottleneck_column_uid"])

    def test_day_cards_match_the_day_counts(self):
        gone = Column.objects.create(board=self.board, name="Gone", position=9)
        self.path(self.backlog, 10, self.doing, 5, self.done, 2)
        self.path(self.backlog, 10, gone, 3, self.doing, 1)
        self.path(self.backlog, 9, self.review, 6, archived=4)
        self.card(self.review, created=7)
        gone.delete()
        flow = self.flow()
        payload = fm.cumulative_flow(flow, self.last(12))
        for day in payload["days"]:
            cards = fm.cumulative_flow_cards(flow, datetime.date.fromisoformat(day["date"]))
            for column in cards["columns"]:
                key = column["column_uid"] or fm.NULL_BAND_KEY
                self.assertEqual(len(column["card_uids"]), day["counts"][key], (day["date"], key))


class AgeResponseTests(FlowFixture):
    def test_sample_carries_the_drawer_fields_in_column_order(self):
        card = self.path(self.backlog, 10, self.doing, 8, self.review, 2)
        sample = self.by_card(fm.age(self.flow(), self.last()))[card.uid]
        self.assertEqual(sample["column_uid"], self.review.uid)
        self.assertEqual(sample["value_days"], 8)
        self.assertEqual(
            sample["dwell_by_column"],
            [
                {"column_uid": self.backlog.uid, "value_days": 2},
                {"column_uid": self.doing.uid, "value_days": 6},
                {"column_uid": self.review.uid, "value_days": 2},
            ],
        )
        self.assertFalse(sample["is_blocked"])
        self.assertEqual(sample["blocked_days"], 0)

    def test_dwell_by_column_sums_visits_and_reports_deleted_columns_as_null(self):
        gone = Column.objects.create(board=self.board, name="Gone", position=9)
        card = self.path(self.backlog, 10, self.doing, 8, gone, 7, self.doing, 2)
        gone.delete()
        sample = self.by_card(fm.age(self.flow(), self.last()))[card.uid]
        self.assertEqual(
            sample["dwell_by_column"],
            [
                {"column_uid": self.backlog.uid, "value_days": 2},
                {"column_uid": self.doing.uid, "value_days": 3},
                {"column_uid": None, "value_days": 5},
            ],
        )

    def test_samples_are_ordered_by_column_then_oldest_first(self):
        young = self.path(self.backlog, 10, self.doing, 2)
        old = self.path(self.backlog, 10, self.doing, 8)
        later = self.path(self.backlog, 10, self.review, 1)
        order = [s["card_uid"] for s in fm.age(self.flow(), self.last())["samples"]]
        self.assertEqual(order, [old.uid, young.uid, later.uid])

    def test_columns_list_the_not_done_columns_even_when_empty(self):
        payload = fm.age(self.flow(), self.last())
        self.assertEqual([c["column_name"] for c in payload["columns"]], ["Backlog", "Doing", "Review"])

    def test_manual_block_is_reported_and_never_subtracted(self):
        card = self.path(self.backlog, 10, self.doing, 8)
        CardBlock.objects.create(
            card=card, board=self.board, reason="Vendor",
            blocked_at=self.ago(5), unblocked_at=self.ago(4),
        )
        CardBlock.objects.create(card=card, board=self.board, reason="Customer", blocked_at=self.ago(1))
        Card.objects.filter(pk=card.pk).update(blocked_at=self.ago(1))
        sample = self.by_card(fm.age(self.flow(), self.last()))[card.uid]
        self.assertEqual(sample["value_days"], 8)
        self.assertEqual(sample["blocked_days"], 2)
        self.assertTrue(sample["is_blocked"])

    def test_a_block_is_clipped_to_the_age_period(self):
        card = self.path(self.backlog, 10, self.doing, 3)
        CardBlock.objects.create(
            card=card, board=self.board, reason="Old", blocked_at=self.ago(9), unblocked_at=self.ago(2),
        )
        self.assertEqual(self.by_card(fm.age(self.flow(), self.last()))[card.uid]["blocked_days"], 1)

    def test_relation_block_makes_a_card_blocked_unless_its_blocker_is_archived(self):
        card = self.path(self.backlog, 10, self.doing, 8)
        blocker = self.path(self.backlog, 10)
        CardRelation.objects.create(from_card=blocker, to_card=card, relation_type=CardRelation.Type.BLOCKS)
        self.assertTrue(self.by_card(fm.age(self.flow(), self.last()))[card.uid]["is_blocked"])
        Card.objects.filter(pk=blocker.pk).update(archived_at=self.ago(1))
        self.assertFalse(self.by_card(fm.age(self.flow(), self.last()))[card.uid]["is_blocked"])


class ColumnEnteredAtTests(FlowFixture):
    def test_start_of_the_open_visit_and_only_when_measured(self):
        moving = self.path(self.backlog, 10, self.doing, 4)
        self.row(moving, self.doing, self.doing, 1)  # a swimlane-only move does not reset it
        finished = self.path(self.backlog, 10, self.done, 4)
        archived = self.path(self.backlog, 10, archived=1)
        edited = self.path(self.backlog, 10, self.doing, 4)
        Card.objects.filter(pk=edited.pk).update(column=self.review)
        restored = self.path(self.backlog, 10)
        self.row(restored, self.backlog, self.backlog, 5, ARCHIVED)
        self.row(restored, self.backlog, self.backlog, 3, UNARCHIVED)
        entered = fm.column_entered_at(self.flow())
        self.assertEqual(entered[moving.id], self.ago(4))
        self.assertEqual(entered[restored.id], self.ago(3))
        for card in (finished, archived, edited):
            self.assertNotIn(card.id, entered)


class NarrowedLoadTests(FlowFixture):
    """summary and analytics skip cards that cannot change their answer, and only those."""

    def mixed_board(self):
        """Every case near a window's edge, on two swimlanes."""
        cards = {
            "recent": self.path(self.backlog, 40, self.doing, 20, self.done, 5),
            "recent_other_lane": self.path(self.backlog, 40, self.doing, 20, self.done, 6, lane=self.other_lane),
            "straight": self.path(self.backlog, 40, self.done, 3),
            "created_done": self.path(self.done, 2),
            "old": self.path(self.backlog, 200, self.doing, 150, self.done, 90),
            "old_then_released": self.path(self.backlog, 200, self.doing, 150, self.done, 90, self.released, 2),
            "reopened_recently": self.path(self.backlog, 200, self.doing, 150, self.done, 90, self.review, 2),
            "archived_after_done": self.path(self.backlog, 40, self.doing, 20, self.done, 4, archived=1),
            "archived_old": self.path(self.backlog, 200, self.doing, 150, archived=100),
            "archived_recent": self.path(self.backlog, 200, self.doing, 150, archived=2),
            "wip": self.path(self.backlog, 40, self.doing, 20),
            "untouched": self.path(self.backlog, 60),
        }
        no_uid = self.path(self.backlog, 40, self.doing, 20, self.done, 7)
        CardMovement.objects.filter(card=no_uid).update(to_column_uid="", from_column_uid="")
        cards["fk_only"] = no_uid
        broken = self.card(self.done, created=40)
        self.row(broken, None, self.backlog, 40)
        self.row(broken, self.review, self.done, 3)
        cards["broken"] = broken
        return cards

    def test_completion_rollup_matches_the_full_replay(self):
        self.mixed_board()
        narrowed = fm.load_recent_completions(self.board, self.last(30), columns=list(self.board.columns.order_by("position")))
        self.assertEqual(
            fm.swimlane_completion_rollup(narrowed),
            fm.swimlane_completion_rollup(self.flow()),
        )

    def test_completion_load_skips_old_work_and_keeps_a_later_entry_whole(self):
        cards = self.mixed_board()
        narrowed = fm.load_recent_completions(self.board, self.last(30), columns=list(self.board.columns.order_by("position")))
        loaded = {card.uid for card in narrowed.cards}
        self.assertNotIn(cards["old"].uid, loaded)
        self.assertNotIn(cards["wip"].uid, loaded)
        self.assertNotIn(cards["reopened_recently"].uid, loaded)
        self.assertIn(cards["fk_only"].uid, loaded)
        # A second done entry in the window loads the card, whose first completion
        # is older: it must not count, which takes its whole history to know.
        kept = next(card for card in narrowed.cards if card.uid == cards["old_then_released"].uid)
        self.assertEqual(kept.completion_at, self.ago(90))

    def test_a_board_with_no_done_column_loads_nothing(self):
        Column.objects.filter(board=self.board, is_done=True).update(is_done=False)
        self.path(self.backlog, 10, self.doing, 5)
        columns = list(self.board.columns.order_by("position"))
        with self.assertNumQueries(0):
            flow = fm.load_recent_completions(self.board, self.last(30), columns=columns)
        self.assertEqual(flow.cards, [])

    def test_dwell_matches_the_full_replay(self):
        self.mixed_board()
        columns = list(self.board.columns.order_by("position"))
        for days in (1, 7, 30, 120):
            with self.subTest(days=days):
                window = self.last(days)
                narrowed = fm.load_recent_dwell(self.board, window, columns=columns)
                full = self.flow()
                self.assertEqual(fm.completed_dwell_by_swimlane(narrowed, window), fm.completed_dwell_by_swimlane(full, window))
                self.assertEqual(fm.current_dwell_by_swimlane(narrowed), fm.current_dwell_by_swimlane(full))

    def test_dwell_load_skips_finished_work_older_than_the_window(self):
        cards = self.mixed_board()
        columns = list(self.board.columns.order_by("position"))
        loaded = {card.uid for card in fm.load_recent_dwell(self.board, self.last(30), columns=columns).cards}
        self.assertNotIn(cards["old"].uid, loaded)
        self.assertNotIn(cards["archived_old"].uid, loaded)
        for name in ("wip", "untouched", "archived_recent", "recent", "old_then_released"):
            self.assertIn(cards[name].uid, loaded, name)


class CompletionRollupTests(FlowFixture):
    def rollup(self):
        return fm.swimlane_completion_rollup(self.flow())[self.lane.id]

    def test_a_card_without_complete_history_counts_toward_velocity_not_cycle_time(self):
        """Its cycle start cannot be trusted once continuity broke (ADR "Missing history")."""
        card = self.path(self.backlog, 20, self.doing, 10, self.done, 2)
        Card.objects.filter(pk=card.pk).update(column=self.released)
        row = self.rollup()
        self.assertEqual((row["velocity_7d"], row["velocity_30d"]), (1, 1))
        self.assertIsNone(row["avg_cycle_days"])

    def test_the_mean_is_over_cards_completed_in_thirty_days_and_rounded(self):
        self.path(self.backlog, 20, self.doing, 10, self.done, 2)
        self.path(self.backlog, 20, self.doing, 10, self.done, 5)
        self.path(self.backlog, 90, self.doing, 80, self.done, 40)
        row = self.rollup()
        self.assertEqual((row["velocity_7d"], row["velocity_30d"]), (2, 2))
        self.assertEqual(row["avg_cycle_days"], 6.5)


class BlockedMetricTests(FlowFixture):
    """ADR "Blocked time" belongs to the service, so #1151 needs no second implementation."""

    def block(self, card, reason, start, end=None):
        return CardBlock.objects.create(
            card=card, board=self.board, column=self.doing, column_name="Doing", column_uid=self.doing.uid,
            reason=reason, blocked_at=self.ago(start), unblocked_at=self.ago(end) if end is not None else None,
        )

    def test_blocked_time_sums_inside_the_range_per_column_and_reason(self):
        card = self.path(self.backlog, 20, self.doing, 15)
        self.block(card, "Vendor", 10, 8)
        self.block(card, "vendor ", 40, 5)
        result = fm.blocked_time(self.flow(), self.last(30))
        self.assertEqual(result["days_per_column"]["Doing"], 27)
        self.assertEqual(result["blocks_per_column"]["Doing"], 2)
        self.assertEqual(result["top_reasons"][0]["count"], 2)

    def test_a_swimlane_or_label_filter_reaches_blocked_time(self):
        label = Label.objects.create(board=self.board, name="T")
        here = self.path(self.backlog, 20, self.doing, 15)
        there = self.path(self.backlog, 20, self.doing, 15, lane=self.other_lane)
        there.labels.add(label)
        self.block(here, "Here", 5, 3)
        self.block(there, "There", 5, 4)
        by_lane = fm.blocked_time(self.flow(swimlane_id=self.lane.id), self.last(30))
        self.assertEqual([r["reason"] for r in by_lane["top_reasons"]], ["Here"])
        by_label = fm.blocked_time(self.flow(label_id=label.id), self.last(30))
        self.assertEqual([r["reason"] for r in by_label["top_reasons"]], ["There"])

    def test_a_filter_leaves_out_a_deleted_card_with_no_swimlane_to_match(self):
        gone = self.path(self.backlog, 20, self.doing, 15)
        self.block(gone, "Gone", 5, 3)
        gone.delete()
        self.assertEqual(fm.blocked_time(self.flow(), self.last(30))["top_reasons"][0]["reason"], "Gone")
        self.assertEqual(fm.blocked_time(self.flow(swimlane_id=self.lane.id), self.last(30))["top_reasons"], [])

    def test_current_dwell_names_blocked_cards(self):
        manual = self.path(self.backlog, 20, self.doing, 15)
        Card.objects.filter(pk=manual.pk).update(blocked_at=self.ago(1))
        by_relation = self.path(self.backlog, 20, self.doing, 15)
        clear = self.path(self.backlog, 20)
        CardRelation.objects.create(from_card=clear, to_card=by_relation, relation_type=CardRelation.Type.BLOCKS)
        samples = self.by_card(fm.current_dwell(self.flow()))
        self.assertTrue(samples[manual.uid]["is_blocked"])
        self.assertTrue(samples[by_relation.uid]["is_blocked"])
        self.assertFalse(samples[clear.uid]["is_blocked"])

    def test_no_cards_needs_no_query(self):
        with self.assertNumQueries(0):
            self.assertEqual(fm.blocked_card_ids(self.flow_stub(), []), set())

    def flow_stub(self):
        return fm.BoardFlow(
            board=self.board, now=self.now, columns=[], cards=[], done_uids=set(), current_uids=set(),
        )


class HeatmapRecomputeTests(FlowFixture):
    """ADR "Changes handed to #448" items 5-7: the Analytics view reads visits."""

    def analytics(self, **params):
        client = APIClient()
        client.force_authenticate(self.user)
        resp = client.get(f"/api/v1/boards/{self.board.pk}/analytics/", params)
        self.assertEqual(resp.status_code, 200)
        return next(s for s in resp.json()["swimlanes"] if s["id"] == self.lane.id)

    def real_ago(self, days):
        return timezone.now() - datetime.timedelta(days=days)

    def setUp(self):
        super().setUp()
        self.now = timezone.now()

    def test_swimlane_move_does_not_reset_current_dwell(self):
        card = self.path(self.backlog, 10, self.doing, 6)
        self.row(card, self.doing, self.doing, 1)
        self.assertAlmostEqual(self.analytics()["age_avg_days_per_column"]["Doing"], 6.0, delta=0.1)

    def test_swimlane_move_does_not_split_a_completed_visit(self):
        card = self.path(self.backlog, 10, self.doing, 8)
        self.row(card, self.doing, self.doing, 5)
        self.row(card, self.doing, self.done, 2)
        Card.objects.filter(pk=card.pk).update(column=self.done)
        row = self.analytics()
        self.assertEqual(row["throughput_card_count_per_column"]["Doing"], 1)
        self.assertAlmostEqual(row["throughput_avg_days_per_column"]["Doing"], 6.0, delta=0.1)

    def test_archived_period_is_not_dwell_and_adds_no_near_zero_visit(self):
        card = self.path(self.backlog, 20, self.doing, 15)
        self.row(card, self.doing, self.doing, 10, ARCHIVED)
        self.row(card, self.doing, self.doing, 5, UNARCHIVED)
        self.row(card, self.doing, self.done, 2)
        Card.objects.filter(pk=card.pk).update(column=self.done)
        row = self.analytics()
        self.assertEqual(row["throughput_card_count_per_column"]["Doing"], 2)
        self.assertAlmostEqual(row["throughput_avg_days_per_column"]["Doing"], 4.0, delta=0.1)

    def test_a_visit_keeps_its_true_start_before_the_old_prefetch_buffer(self):
        card = self.path(self.backlog, 300, self.doing, 200)
        self.row(card, self.doing, self.done, 2)
        Card.objects.filter(pk=card.pk).update(column=self.done)
        row = self.analytics(days=7)
        self.assertAlmostEqual(row["throughput_avg_days_per_column"]["Doing"], 198.0, delta=0.1)

    def test_recreated_column_inherits_neither_visits_nor_done_flag(self):
        old_done = Column.objects.create(board=self.board, name="Shipped", position=9, is_done=True)
        card = self.path(self.backlog, 10, old_done, 5)
        old_done.delete()
        Column.objects.create(board=self.board, name="Shipped", position=9, is_done=False)
        Card.objects.filter(pk=card.pk).update(column=self.backlog)
        row = self.analytics()
        self.assertEqual(row["throughput_card_count_per_column"]["Shipped"], 0)
        self.assertIsNone(row["age_avg_days_per_column"]["Shipped"])


class EndpointFixture(FlowFixture):
    def setUp(self):
        super().setUp()
        # The endpoints read the wall clock, so history is relative to it here.
        self.now = timezone.now()
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def url(self, metric):
        return f"/api/v1/boards/{self.board.pk}/metrics/{metric}/"


METRICS = ("cycle-time", "throughput", "cumulative-flow", "wip-age")


class EndpointAccessTests(EndpointFixture):
    def test_viewer_may_read_every_metric(self):
        viewer = User.objects.create_user(username="flow_viewer", password="pw")
        BoardMembership.objects.create(board=self.board, user=viewer, role="viewer")
        client = APIClient()
        client.force_authenticate(viewer)
        for metric in METRICS:
            with self.subTest(metric=metric):
                self.assertEqual(client.get(self.url(metric)).status_code, 200)

    def test_non_member_gets_the_same_404_as_a_missing_board(self):
        outsider = User.objects.create_user(username="flow_outsider", password="pw")
        client = APIClient()
        client.force_authenticate(outsider)
        for metric in METRICS:
            with self.subTest(metric=metric):
                self.assertEqual(client.get(self.url(metric)).status_code, 404)

    def test_anonymous_is_refused(self):
        for metric in METRICS:
            with self.subTest(metric=metric):
                self.assertIn(APIClient().get(self.url(metric)).status_code, (401, 403))

    def test_only_get_is_allowed(self):
        for metric in METRICS:
            with self.subTest(metric=metric):
                self.assertEqual(self.client.post(self.url(metric), {}, format="json").status_code, 405)


class EndpointValidationTests(EndpointFixture):
    def assert_bad(self, metric, **params):
        resp = self.client.get(self.url(metric), params)
        self.assertEqual(resp.status_code, 400, resp.content)
        self.assertEqual(resp.json()["code"], "invalid_query_param")
        self.assertIsInstance(resp.json()["detail"], str)

    def test_bad_values_answer_the_one_bad_parameter_shape(self):
        for metric in METRICS:
            for params in (
                {"from_date": "nope"},
                {"to_date": "2026-02-30"},
                {"from_date": "2026-05-02", "to_date": "2026-05-01"},
                {"from_date": "2020-01-01", "to_date": "2026-05-01"},
                {"from_date": "0001-01-01"},
                {"to_date": "9999-12-31"},
                {"days": "0"},
                {"days": "366"},
                {"days": "abc"},
                {"days": "30", "from_date": "2026-05-01"},
                {"swimlane_id": "abc"},
                {"swimlane_id": str(2**70)},
                {"label_id": "-1"},
            ):
                with self.subTest(metric=metric, params=params):
                    self.assert_bad(metric, **params)

    def test_a_swimlane_or_label_on_another_board_is_refused_like_a_missing_one(self):
        other = Board.objects.create(name="Other", owner=self.user)
        foreign_lane = Swimlane.objects.create(board=other, name="Foreign", position=0)
        foreign_label = Label.objects.create(board=other, name="Foreign")
        for metric in METRICS:
            with self.subTest(metric=metric):
                on_other = self.client.get(self.url(metric), {"swimlane_id": foreign_lane.id}).json()
                missing = self.client.get(self.url(metric), {"swimlane_id": 999_999}).json()
                self.assertEqual(on_other, missing)
                self.assert_bad(metric, swimlane_id=foreign_lane.id)
                self.assert_bad(metric, label_id=foreign_label.id)

    def test_throughput_period_must_be_known(self):
        self.assert_bad("throughput", period="month")

    def test_cumulative_flow_date_must_be_a_past_whole_day(self):
        self.assert_bad("cumulative-flow", date="not-a-date")
        self.assert_bad("cumulative-flow", date=self.now.date().isoformat())
        self.assert_bad("cumulative-flow", date=(self.now.date() + datetime.timedelta(days=1)).isoformat())


class EndpointResponseTests(EndpointFixture):
    def test_empty_board_returns_empty_data_not_errors(self):
        cycle = self.client.get(self.url("cycle-time")).json()
        self.assertEqual(cycle["sample_size"], 0)
        self.assertEqual(cycle["samples"], [])
        self.assertEqual(cycle["percentiles"], {"p50": None, "p85": None, "p95": None})
        self.assertEqual(cycle["cards"], [])
        self.assertEqual(cycle["definition"], fm.DEFINITIONS["cycle_time"])
        throughput = self.client.get(self.url("throughput")).json()
        self.assertEqual(throughput["total"], 0)
        self.assertEqual(throughput["median"], 0)  # at least twelve quiet weeks is a real zero
        cfd = self.client.get(self.url("cumulative-flow")).json()
        self.assertEqual(len(cfd["days"]), fm.DEFAULT_RANGE_DAYS)
        self.assertIsNone(cfd["bottleneck_column_uid"])
        age = self.client.get(self.url("wip-age")).json()
        self.assertEqual(age["sample_size"], 0)

    def test_board_with_cards_but_no_movements_reports_them_as_excluded_only(self):
        self.card(self.doing)
        age = self.client.get(self.url("wip-age")).json()
        self.assertEqual((age["sample_size"], age["excluded_incomplete_history"]), (0, 1))
        self.assertEqual(self.client.get(self.url("cycle-time")).json()["sample_size"], 0)

    def test_cycle_time_sample_and_directory(self):
        owner = User.objects.create_user(username="flow_assignee", password="pw", display_name="Pat")
        card = self.path(self.backlog, 10, self.doing, 6, self.done, 2)
        Card.objects.filter(pk=card.pk).update(assignee=owner, title="Ship it")
        body = self.client.get(self.url("cycle-time")).json()
        sample = body["samples"][0]
        self.assertEqual(sample["card_uid"], card.uid)
        self.assertAlmostEqual(sample["value_days"], 4, places=3)
        self.assertTrue(sample["end"].endswith("Z"))
        self.assertIs(sample["reopened"], False)
        self.assertEqual(body["cards"][0]["uid"], card.uid)
        self.assertEqual(body["cards"][0]["id"], card.id)
        self.assertEqual(body["cards"][0]["title"], "Ship it")
        self.assertIs(body["cards"][0]["archived"], False)
        self.assertEqual(
            sorted(body["cards"][0]["assignee"]), ["avatar_url", "display_name", "id", "username"],
        )

    def test_percentiles_are_null_with_their_sample_size_below_the_floor(self):
        for _ in range(4):
            self.path(self.backlog, 10, self.doing, 6, self.done, 2)
        body = self.client.get(self.url("cycle-time")).json()
        self.assertEqual(body["sample_size"], 4)
        self.assertEqual(body["percentiles"], {"p50": None, "p85": None, "p95": None})
        self.path(self.backlog, 10, self.doing, 6, self.done, 2)
        body = self.client.get(self.url("cycle-time")).json()
        self.assertIsNotNone(body["percentiles"]["p50"])
        self.assertIsNone(body["percentiles"]["p85"])

    def test_default_range_is_ninety_days(self):
        inside = self.path(self.backlog, 200, self.doing, 150, self.done, 80)
        self.path(self.backlog, 200, self.doing, 150, self.done, 100)
        body = self.client.get(self.url("cycle-time")).json()
        self.assertEqual([s["card_uid"] for s in body["samples"]], [inside.uid])
        # 90 whole days hold twelve whole ISO weeks, or twelve and a bit: never fewer.
        self.assertGreaterEqual(len(self.client.get(self.url("throughput")).json()["samples"]), 12)

    def test_date_range_limits_samples_to_those_days(self):
        inside = self.path(self.backlog, 200, self.doing, 150, self.done, 10)
        self.path(self.backlog, 200, self.doing, 150, self.done, 40)
        day = (self.now - datetime.timedelta(days=10)).date().isoformat()
        body = self.client.get(self.url("cycle-time"), {"from_date": day, "to_date": day}).json()
        self.assertEqual([s["card_uid"] for s in body["samples"]], [inside.uid])
        cfd = self.client.get(self.url("cumulative-flow"), {"from_date": day, "to_date": day}).json()
        self.assertEqual([d["date"] for d in cfd["days"]], [day])

    def test_open_ended_dates_fill_in_the_default_length(self):
        day = (self.now - datetime.timedelta(days=30)).date()
        cfd = self.client.get(self.url("cumulative-flow"), {"to_date": day.isoformat()}).json()
        self.assertEqual(len(cfd["days"]), fm.DEFAULT_RANGE_DAYS)
        self.assertEqual(cfd["days"][-1]["date"], day.isoformat())
        cfd = self.client.get(self.url("cumulative-flow"), {"from_date": day.isoformat()}).json()
        self.assertEqual(cfd["days"][0]["date"], day.isoformat())
        self.assertEqual(len(cfd["days"]), 30)

    def test_swimlane_and_label_filters_reach_every_metric(self):
        label = Label.objects.create(board=self.board, name="Tagged")
        kept = self.path(self.backlog, 20, self.doing, 16, lane=self.other_lane)
        kept.labels.add(label)
        self.path(self.backlog, 20, self.doing, 16)
        for params in ({"swimlane_id": self.other_lane.id}, {"label_id": label.id}):
            with self.subTest(params=params):
                age = self.client.get(self.url("wip-age"), params).json()
                self.assertEqual([s["card_uid"] for s in age["samples"]], [kept.uid])
                cfd = self.client.get(self.url("cumulative-flow"), params).json()
                self.assertEqual(cfd["days"][-1]["counts"][self.doing.uid], 1)

    def test_throughput_period_and_card_directory(self):
        card = self.path(self.backlog, 20, self.doing, 16, self.done, 3)
        body = self.client.get(self.url("throughput"), {"period": "day", "days": 7}).json()
        self.assertEqual(body["period"], "day")
        self.assertEqual(len(body["samples"]), 7)
        self.assertEqual(body["total"], 1)
        self.assertEqual([c["uid"] for c in body["cards"]], [card.uid])

    def test_cumulative_flow_date_lists_the_cards_behind_the_day(self):
        card = self.path(self.backlog, 20, self.doing, 16)
        day = (self.now - datetime.timedelta(days=2)).date().isoformat()
        body = self.client.get(self.url("cumulative-flow"), {"date": day}).json()
        self.assertEqual(body["date"], day)
        by_column = {c["column_uid"]: c["card_uids"] for c in body["columns"]}
        self.assertEqual(by_column[self.doing.uid], [card.uid])
        self.assertEqual(by_column[None], [])
        self.assertEqual([c["uid"] for c in body["cards"]], [card.uid])

    def test_wip_age_directory_marks_nothing_archived(self):
        card = self.path(self.backlog, 20, self.doing, 16)
        body = self.client.get(self.url("wip-age")).json()
        self.assertEqual(body["cards"][0]["uid"], card.uid)
        self.assertEqual(body["cards"][0]["assignee"], None)

    def test_directory_flags_an_archived_card(self):
        card = self.path(self.backlog, 20, self.doing, 16, self.done, 10, archived=2)
        body = self.client.get(self.url("cycle-time")).json()
        self.assertEqual(body["cards"][0]["uid"], card.uid)
        self.assertIs(body["cards"][0]["archived"], True)


class EndpointSchemaTests(EndpointFixture):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.schema = SchemaGenerator().get_schema(request=None, public=True)

    def assert_matches(self, metric, status_code, body):
        path = f"/api/v1/boards/{{id}}/metrics/{metric}/"
        operation = self.schema["paths"][path]["get"]
        fragment = operation["responses"][str(status_code)]["content"]["application/json"]["schema"]
        combined = _openapi3_nullable_to_jsonschema({**fragment, "components": self.schema["components"]})
        jsonschema.validate(instance=body, schema=combined)

    def test_every_response_matches_its_published_schema(self):
        owner = User.objects.create_user(username="flow_schema", password="pw")
        card = self.path(self.backlog, 20, self.doing, 16, self.done, 3, self.review, 2)
        Card.objects.filter(pk=card.pk).update(assignee=owner)
        self.path(self.backlog, 20, self.doing, 16)
        for metric in METRICS:
            with self.subTest(metric=metric):
                resp = self.client.get(self.url(metric))
                self.assertEqual(resp.status_code, 200)
                self.assert_matches(metric, 200, resp.json())
                bad = self.client.get(self.url(metric), {"days": 0})
                self.assertEqual(bad.status_code, 400)
                self.assert_matches(metric, 400, bad.json())
        day = (self.now - datetime.timedelta(days=2)).date().isoformat()
        self.assert_matches("cumulative-flow", 200, self.client.get(self.url("cumulative-flow"), {"date": day}).json())

    def test_every_endpoint_documents_its_filters(self):
        for metric in METRICS:
            with self.subTest(metric=metric):
                operation = self.schema["paths"][f"/api/v1/boards/{{id}}/metrics/{metric}/"]["get"]
                names = {p["name"] for p in operation["parameters"] if p["in"] == "query"}
                self.assertTrue({"days", "from_date", "to_date", "swimlane_id", "label_id"} <= names)


class EndpointQueryCountTests(EndpointFixture):
    """The perf guard: query count is flat in cards, movements and days (#448)."""

    # auth + board + role + columns + cards + movements, plus age's two and the
    # directory's one. Doubled, as test_query_counts does, for framework overhead.
    BUDGET = {"cycle-time": 16, "throughput": 16, "cumulative-flow": 14, "wip-age": 20}

    def seed(self, n):
        owner = User.objects.create_user(username=f"flow_load_{n}", password="pw")
        for i in range(n):
            card = self.path(self.backlog, 20, self.doing, 16, self.done, 3)
            Card.objects.filter(pk=card.pk).update(assignee=owner)
            wip = self.path(self.backlog, 20, self.doing, 10 + i % 3)
            CardBlock.objects.create(card=wip, board=self.board, reason="r", blocked_at=self.ago(1))

    def count(self, metric):
        with CaptureQueriesContext(connection) as ctx:
            resp = self.client.get(self.url(metric))
        self.assertEqual(resp.status_code, 200)
        return len(ctx)

    def test_each_endpoint_stays_within_budget_and_does_not_grow(self):
        self.seed(3)
        baseline = {metric: self.count(metric) for metric in METRICS}
        self.seed(12)
        for metric in METRICS:
            with self.subTest(metric=metric):
                scaled = self.count(metric)
                self.assertEqual(scaled, baseline[metric], f"{metric} grew with the board")
                self.assertLessEqual(scaled, self.BUDGET[metric])
