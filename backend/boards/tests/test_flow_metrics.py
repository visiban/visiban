"""The flow metric service and its REST endpoints (#448, ADR #1532).

The edge-case and missing-history tests follow the tables in
``docs/architecture/decisions.md`` § Flow metric definitions row by row, so a
change to the record has one obvious place to land.
"""
import datetime
import random
from unittest import mock
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
    Board, BoardMembership, Card, CardBlock, CardMovement, CardParentLink, CardRelation, Column, CustomFieldDefinition,
    CustomFieldValue, Label, Swimlane, SwimlaneCustomFieldDefinition, SwimlaneCustomFieldValue,
)
from boards.serializers import _annotate_column_entered_at
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
        # The commitment-point variants (#2050) are quoted the same way.
        quoted = [*fm.DEFINITIONS.items(), *(("commitment_" + k, v) for k, v in fm.COMMITMENT_DEFINITIONS.items())]
        for metric, definition in quoted:
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

    def test_completed_in_range_counts_the_partial_weeks_and_matches_the_cycle_time_window(self):
        # #2288: now is Wed 2026-07-15 12:00, so the last 30 days hold four
        # whole weeks (Mon 06-15 to Sun 07-12) plus Mon 07-13 to now.
        for days_ago in (1, 7, 20, 29):  # Tue 07-14 is in no whole week
            self.path(self.backlog, 60, self.doing, 50, self.done, days_ago)
        # Mon 06-15 06:00: inside the first whole week's bucket day, before the
        # rolling start (06-15 12:00), so cycle time leaves it out too.
        self.path(self.backlog, 60, self.doing, 50, self.done, 30.25)
        # Mon 07-13 12:00: in the dropped partial week, so it is in the range
        # count and the cycle time sample but not in the whole-week total.
        self.path(self.backlog, 60, self.doing, 50, self.done, 2)
        flow = self.flow()
        payload = fm.throughput(flow, self.last(30))
        self.assertEqual(payload["total"], 4)
        self.assertEqual(payload["completed_in_range"], 5)
        self.assertEqual(payload["completed_in_range"], fm.cycle_time(flow, self.last(30))["sample_size"])
        hits = {s["start"]: s["count"] for s in payload["samples"]}
        self.assertEqual(hits["2026-06-15"], 2)  # 06-15 06:00 and 06-16

    def test_completed_in_range_can_exceed_the_cycle_time_sample(self):
        # #2288 owner decision: it counts every first completion in the range,
        # including a card with no creation movement (incomplete history), which
        # has no start and so no cycle time.
        self.path(self.backlog, 60, self.doing, 50, self.done, 3)
        orphan = self.card(self.done, created=12)
        self.row(orphan, self.backlog, self.done, 2)
        flow = self.flow()
        completed = fm.throughput(flow, self.last(30))["completed_in_range"]
        cycle = fm.cycle_time(flow, self.last(30))
        self.assertEqual(completed, 2)
        self.assertEqual(cycle["sample_size"], 1)
        self.assertGreater(completed, cycle["sample_size"])

    def test_completed_in_range_differs_from_total_unless_the_range_is_whole_weeks(self):
        # A completion every day for 60 days: the whole-week total covers
        # 7 x weeks days, the range count every completion inside [start, now).
        for days_ago in range(60):
            self.path(self.backlog, 90, self.doing, 80, self.done, days_ago + 0.5)
        for days in (7, 14, 30, 45):
            with self.subTest(days=days):
                flow_range = self.last(days)
                payload = fm.throughput(self.flow(), flow_range)
                self.assertEqual(payload["total"], 7 * len(payload["samples"]))
                self.assertEqual(payload["completed_in_range"], days)
                # Wednesday's ranges never start on a Monday, so they never agree.
                self.assertLess(payload["total"], payload["completed_in_range"])

    def test_completed_in_range_follows_a_from_to_range(self):
        # 2026-06-29 is a Monday and 2026-07-12 a Sunday: whole weeks, so both agree.
        for days_ago in (3, 5, 10, 16):  # Sun 07-12 12:00, 07-10, 07-05, 06-29
            self.path(self.backlog, 60, self.doing, 50, self.done, days_ago)
        whole = fm.throughput(self.flow(), fm.date_range(datetime.date(2026, 6, 29), datetime.date(2026, 7, 12), now=self.now))
        self.assertEqual((whole["total"], whole["completed_in_range"]), (4, 4))
        # Starting on Tuesday drops the week of 06-29 from total only.
        partial = fm.throughput(self.flow(), fm.date_range(datetime.date(2026, 6, 30), datetime.date(2026, 7, 12), now=self.now))
        self.assertEqual((partial["total"], partial["completed_in_range"]), (2, 3))


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

    def test_bottleneck_never_names_the_intake_column(self):
        # Six cards arrive in Backlog; three sit in Review from before the window.
        for _ in range(6):
            self.path(self.backlog, 5)
        for _ in range(3):
            self.path(self.backlog, 40, self.review, 30)
        self.assertEqual(fm.cumulative_flow(self.flow(), self.last(10))["bottleneck_column_uid"], None)

    def test_growing_backlog_and_growing_review_names_review(self):
        for _ in range(6):
            self.path(self.backlog, 5)
        for _ in range(2):
            self.path(self.backlog, 20, self.review, 5)
        payload = fm.cumulative_flow(self.flow(), self.last(10))
        self.assertEqual(payload["bottleneck_column_uid"], self.review.uid)

    def test_a_tie_across_three_columns_goes_to_the_earliest_non_intake_column(self):
        qa = Column.objects.create(board=self.board, name="QA", position=5)
        self.path(self.backlog, 20, qa, 2)
        self.path(self.backlog, 20, self.review, 2)
        self.path(self.backlog, 20, self.doing, 2)
        for _ in range(4):
            self.path(self.backlog, 5)  # the intake grows most and still never counts
        self.assertEqual(fm.cumulative_flow(self.flow(), self.last(10))["bottleneck_column_uid"], self.doing.uid)

    def test_a_board_with_one_not_done_column_has_no_bottleneck(self):
        Column.objects.filter(pk__in=[self.doing.pk, self.review.pk]).update(is_done=True)
        for _ in range(3):
            self.path(self.backlog, 5)
        self.assertIsNone(fm.cumulative_flow(self.flow(), self.last(10))["bottleneck_column_uid"])

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

    def test_archived_at_before_a_later_movement_keeps_the_stops_in_time_order(self):
        """An admin's archived_at can predate a movement the card still has."""
        card = self.path(self.backlog, 10, self.doing, 2)
        Card.objects.filter(pk=card.pk).update(archived_at=self.ago(6))
        flow = self.flow()
        moments = [moment for moment, _ in flow.cards[0].placements]
        self.assertEqual(moments, sorted(moments))
        payload = fm.cumulative_flow(flow, self.last(12))
        # Archived in Backlog on 07-09, so off the diagram from then on, moved or not.
        self.assertEqual(self.counts(payload, "2026-07-08")[self.backlog.uid], 1)
        self.assertEqual(self.counts(payload, "2026-07-09")[self.backlog.uid], 0)
        self.assertEqual(self.counts(payload, "2026-07-14")[self.doing.uid], 0)

    def test_created_at_after_the_first_movement_does_not_send_a_card_back(self):
        card = self.card(self.done, created=1)
        self.row(card, self.doing, self.done, 5)
        payload = fm.cumulative_flow(self.flow(), self.last(12))
        self.assertEqual(self.counts(payload, "2026-07-14")[self.done.uid], 1)
        self.assertEqual(self.counts(payload, "2026-07-14")[self.doing.uid], 0)

    def test_day_cards_match_the_day_counts_on_random_histories(self):
        """Seeded. Rows, created_at and archived_at land in any order, as imports allow."""
        rnd = random.Random(1532)
        columns = [self.backlog, self.doing, self.review, self.done]
        for _ in range(60):
            card = self.card(rnd.choice(columns), created=rnd.randint(0, 12))
            at = rnd.choice([None, *columns])
            for _ in range(rnd.randint(0, 4)):
                target = rnd.choice(columns)
                self.row(card, at, target, rnd.randint(0, 12), rnd.choices([MOVE, ARCHIVED, UNARCHIVED], [6, 1, 1])[0])
                at = target
            if rnd.random() < 0.4:
                Card.objects.filter(pk=card.pk).update(archived_at=self.ago(rnd.randint(0, 12)))
        flow = self.flow()
        payload = fm.cumulative_flow(flow, self.last(12))
        for day in payload["days"]:
            cards = fm.cumulative_flow_cards(flow, datetime.date.fromisoformat(day["date"]))
            for column in cards["columns"]:
                key = column["column_uid"] or fm.NULL_BAND_KEY
                self.assertEqual(len(column["card_uids"]), day["counts"][key], (day["date"], key))

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
    def test_columns_carry_the_live_wip_count_whatever_the_card_history(self):
        # #2287: five cards that never left Backlog have no age, and one with
        # no history at all is excluded, but all six sit in their columns
        # against the WIP limit, as the column header counts them.
        for _ in range(5):
            self.path(self.backlog, 10)
        self.card(self.doing, created=12)  # no movement rows
        started = self.path(self.backlog, 10, self.doing, 4)
        self.path(self.backlog, 10, self.doing, 4, archived=1)
        self.path(self.backlog, 10, self.doing, 4, self.done, 1)
        flow = self.flow()
        payload = fm.age(flow, self.last())
        self.assertEqual(payload["excluded_incomplete_history"], 1)
        self.assertEqual([s["card_uid"] for s in payload["samples"]], [started.uid])
        counts = {c["column_uid"]: c["wip_count"] for c in payload["columns"]}
        self.assertEqual(counts, {self.backlog.uid: 5, self.doing.uid: 2, self.review.uid: 0})
        self.assertEqual(counts, {c["column_uid"]: c["count"] for c in fm.wip(flow)["columns"]})

    def test_wip_count_follows_the_swimlane_and_label_filters(self):
        self.path(self.backlog, 10)
        self.path(self.backlog, 10, lane=self.other_lane)
        labeled = self.path(self.backlog, 10, lane=self.other_lane)
        label = Label.objects.create(board=self.board, name="Bug", color="#ff0000")
        labeled.labels.add(label)
        def backlog_count(**filters):
            columns = fm.age(self.flow(**filters), self.last())["columns"]
            return next(c["wip_count"] for c in columns if c["column_uid"] == self.backlog.uid)
        self.assertEqual(backlog_count(), 3)
        self.assertEqual(backlog_count(swimlane_id=self.other_lane.id), 2)
        self.assertEqual(backlog_count(label_id=label.id), 1)

    def test_sample_carries_the_drawer_fields_in_column_order(self):
        card = self.path(self.backlog, 10, self.doing, 8, self.review, 2)
        sample = self.by_card(fm.age(self.flow(), self.last()))[card.uid]
        self.assertEqual(sample["column_uid"], self.review.uid)
        self.assertEqual(sample["value_days"], 8)
        self.assertEqual(
            sample["dwell_by_column"],
            [
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
                {"column_uid": self.doing.uid, "value_days": 3},
                {"column_uid": None, "value_days": 5},
            ],
        )

    def test_dwell_total_equals_age_and_leaves_out_time_before_the_age_clock(self):
        # Created 10 days ago, picked up 8 days ago: the 2 days in Backlog precede the age.
        card = self.path(self.backlog, 10, self.doing, 8)
        sample = self.by_card(fm.age(self.flow(), self.last()))[card.uid]
        self.assertEqual(sample["value_days"], 8)
        self.assertEqual(sample["dwell_by_column"], [{"column_uid": self.doing.uid, "value_days": 8}])
        self.assertAlmostEqual(sum(d["value_days"] for d in sample["dwell_by_column"]), sample["value_days"])

    def test_dwell_after_a_reopen_counts_only_the_current_cycle(self):
        card = self.path(self.backlog, 20, self.doing, 15, self.done, 10, self.review, 5)
        sample = self.by_card(fm.age(self.flow(), self.last()))[card.uid]
        self.assertEqual(sample["value_days"], 5)
        self.assertEqual(sample["dwell_by_column"], [{"column_uid": self.review.uid, "value_days": 5}])

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


class ColumnEnteredAtParityTests(FlowFixture):
    """The two implementations of "the start of the open visit" must agree (#459's ADR note).

    A card read needs it as a subquery in the main SELECT (``_annotate_column_entered_at``),
    and the service computes visits from loaded rows. Same movement histories, same
    answer, or the overlay and the dashboard disagree about one card.
    """

    def setUp(self):
        super().setUp()
        # The annotation reads the wall clock, so history is relative to it here.
        self.now = timezone.now()

    def assert_agree(self, minimum_entered=1):
        from_sql = {
            card.id: card._column_entered_at
            for card in _annotate_column_entered_at(Card.objects.filter(board=self.board))
        }
        from_service = fm.column_entered_at(fm.load_board_flow(self.board, now=timezone.now()))
        differences = {
            card_id: (value, from_service.get(card_id))
            for card_id, value in from_sql.items()
            if value != from_service.get(card_id)
        }
        self.assertEqual(differences, {})
        self.assertGreaterEqual(len(from_service), minimum_entered, "no card exercised the agreement")

    def test_adversarial_histories_agree(self):
        # Reopens.
        self.path(self.backlog, 20, self.doing, 15, self.done, 10, self.review, 5)
        self.path(self.done, 10, self.doing, 5)
        self.path(self.backlog, 20, self.done, 15, self.doing, 5, self.done, 1)
        # Swimlane-only moves do not reset it.
        lane_move = self.path(self.backlog, 20, self.doing, 15)
        self.row(lane_move, self.doing, self.doing, 3)
        # Archive and restore, with and without events.
        self.path(self.backlog, 20, self.doing, 15, archived=2)
        restored = self.path(self.backlog, 20, self.doing, 15)
        self.row(restored, self.doing, self.doing, 8, ARCHIVED)
        self.row(restored, self.doing, self.doing, 4, UNARCHIVED)
        restore_only = self.path(self.backlog, 20, self.doing, 15)
        self.row(restore_only, self.doing, self.doing, 4, UNARCHIVED)
        archived_quietly = self.path(self.backlog, 20, self.doing, 15)
        Card.objects.filter(pk=archived_quietly.pk).update(archived_at=self.ago(1))
        unarchived_quietly = self.path(self.backlog, 20, self.doing, 15)
        self.row(unarchived_quietly, self.doing, self.doing, 4, ARCHIVED)
        # Ties on moved_at: id breaks them, in both directions.
        tied = self.path(self.backlog, 20, self.doing, 5, self.review, 5)
        back_again = self.path(self.backlog, 20, self.doing, 5, self.backlog, 5)
        self.assertTrue(tied and back_again)
        # A column deleted and recreated under one name is a different column.
        old = Column.objects.create(board=self.board, name="Old", position=9)
        passed_through = self.path(self.backlog, 20, old, 10, self.doing, 5)
        stranded = self.path(self.backlog, 20, old, 10)
        Card.objects.filter(pk=stranded.pk).update(column=self.backlog)
        old.delete()
        recreated = Column.objects.create(board=self.board, name="Old", position=9)
        Card.objects.filter(pk=stranded.pk).update(column=recreated)
        self.assertTrue(passed_through)
        name_only = self.card(recreated, created=20)
        mv = self.row(name_only, None, recreated, 10)
        CardMovement.objects.filter(pk=mv.pk).update(to_column=None, to_column_uid="", to_column_name="Old")
        # Changed without a movement, no creation row, unknown source, misdated.
        edited = self.path(self.backlog, 20, self.doing, 15)
        Card.objects.filter(pk=edited.pk).update(column=self.review)
        self.card(self.doing, created=20)
        no_creation = self.card(self.doing, created=20)
        self.row(no_creation, self.backlog, self.doing, 5)
        unknown_source = self.card(self.doing, created=20)
        self.row(unknown_source, None, self.backlog, 10)
        self.row(unknown_source, None, self.doing, 5)
        misdated = self.path(self.backlog, 20, self.doing, 10)
        self.row(misdated, self.doing, self.review, -3)
        Card.objects.filter(pk=misdated.pk).update(column=self.review)
        self.assert_agree(minimum_entered=5)

    def test_random_histories_agree(self):
        """Seeded, so a failure reproduces. Rows are often inconsistent on purpose."""
        rnd = random.Random(448)
        columns = [self.backlog, self.doing, self.review, self.done, self.released]
        for _ in range(120):
            current = rnd.choice(columns)
            card = self.card(current, created=rnd.randint(1, 40))
            at = None
            for _ in range(rnd.randint(0, 6)):
                target = rnd.choice(columns) if rnd.random() < 0.9 else None
                source = at if rnd.random() < 0.9 else rnd.choice(columns)
                kind = rnd.choices([MOVE, ARCHIVED, UNARCHIVED], [8, 1, 1])[0]
                day = rnd.choice([1, 2, 3, 3, 5, 8, 13, 21, -1])  # repeats tie; -1 is misdated
                self.row(card, source, target, day, kind)
                if target is not None:
                    at = target
            if at is not None and rnd.random() < 0.8:
                Card.objects.filter(pk=card.pk).update(column=at)
            if rnd.random() < 0.15:
                Card.objects.filter(pk=card.pk).update(archived_at=self.ago(rnd.randint(1, 30)))
        self.assert_agree()


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
        # Archived with no event row (the Django admin, or an import): its visit
        # closes at archived_at, the only sign of it in the window.
        quiet = self.path(self.backlog, 200, self.doing, 150)
        Card.objects.filter(pk=quiet.pk).update(archived_at=self.ago(2))
        cards["archived_no_event"] = quiet
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
        for name in ("wip", "untouched", "archived_recent", "recent", "old_then_released", "archived_no_event"):
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

    def test_a_recreated_column_does_not_inherit_blocked_time_by_name(self):
        """A name never matches a current column (ADR "Current column")."""
        old = Column.objects.create(board=self.board, name="Old", position=9)
        card = self.path(self.backlog, 20, self.doing, 15)
        CardBlock.objects.create(
            card=card, board=self.board, column=old, column_name="Old", column_uid=old.uid,
            reason="Vendor", blocked_at=self.ago(5), unblocked_at=self.ago(3),
        )
        old.delete()
        Column.objects.create(board=self.board, name="Old", position=9)
        result = fm.blocked_time(self.flow(), self.last(30))
        self.assertEqual(result["days_per_column"]["Old"], 0)
        self.assertEqual(result["seconds_per_column"]["Old"], 0)
        self.assertEqual(result["blocks_per_column"]["Old"], 0)
        # Still real time: it counts in the total and under its reason.
        self.assertEqual(result["top_reasons"][0]["reason"], "Vendor")
        self.assertEqual(result["total"], {"days": 2, "seconds": 172800, "blocks": 1})

    def test_total_holds_what_columns_and_capped_reasons_cannot(self):
        gone = Column.objects.create(board=self.board, name="Gone", position=9)
        card = self.path(self.backlog, 20, self.doing, 15)
        for n in range(fm.TOP_BLOCK_REASONS + 2):
            self.block(card, f"Reason {n}", 10, 9)
        CardBlock.objects.create(
            card=card, board=self.board, column=gone, column_name="Gone", column_uid=gone.uid,
            reason="In a column that goes away", blocked_at=self.ago(9), unblocked_at=self.ago(8),
        )
        gone.delete()
        result = fm.blocked_time(self.flow(), self.last(30))
        self.assertEqual(len(result["top_reasons"]), fm.TOP_BLOCK_REASONS)
        self.assertEqual(result["blocks_per_column"]["Doing"], fm.TOP_BLOCK_REASONS + 2)
        self.assertEqual(result["total"]["blocks"], fm.TOP_BLOCK_REASONS + 3)
        self.assertEqual(result["total"]["days"], fm.TOP_BLOCK_REASONS + 3)

    def test_the_total_is_zero_with_no_blocks(self):
        self.assertEqual(fm.blocked_time(self.flow(), self.last(30))["total"], {"days": 0, "seconds": 0, "blocks": 0})

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


GROUPING_ONLY_KEYS = {"grouping", "group_keys", "by_group"}
# The #2429 cap's keys are documented but present only with `limit`.
LIMIT_ONLY_KEYS = {"sampled", "samples_total", "items_total", "past_p85_count", "sample_count"}
# Malformed period parameters every flow endpoint refuses the same way, the swimlane comparison included.
BAD_RANGE_PARAMS = (
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
)
METRICS = ("cycle-time", "throughput", "cumulative-flow", "wip-age", "dwell", "blocked", "attention", "overview")


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
            for params in (*BAD_RANGE_PARAMS, {"swimlane_id": "abc"}, {"swimlane_id": str(2**70)}, {"label_id": "-1"}):
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
        self.assertEqual(body["cards"][0]["swimlane"], {"id": self.lane.id, "name": "Lane"})

    def test_directory_names_each_cards_current_swimlane(self):
        # The column drawer's oldest card shows its swimlane (#2283): the lane the
        # card is in now, as the swimlane filter reads it, archived cards included.
        here = self.path(self.backlog, 20, self.doing, 16)
        moved = self.path(self.backlog, 20, self.doing, 12, lane=self.other_lane)
        gone = self.path(self.backlog, 20, self.doing, 16, self.done, 10, archived=2, lane=self.other_lane)
        Swimlane.objects.filter(pk=self.other_lane.pk).update(name="Renamed")
        lanes = {}
        for metric in ("wip-age", "cycle-time"):
            for card in self.client.get(self.url(metric)).json()["cards"]:
                lanes[card["uid"]] = card["swimlane"]
        self.assertEqual(lanes, {
            here.uid: {"id": self.lane.id, "name": "Lane"},
            moved.uid: {"id": self.other_lane.id, "name": "Renamed"},
            gone.uid: {"id": self.other_lane.id, "name": "Renamed"},
        })

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

    def test_wip_age_columns_report_unstarted_cards_over_the_limit(self):
        # #2287: a WIP limit of 3 on a Backlog of five cards that never moved.
        Column.objects.filter(pk=self.backlog.pk).update(wip_limit=3)
        for _ in range(5):
            self.path(self.backlog, 10)
        body = self.client.get(self.url("wip-age")).json()
        self.assertEqual(body["sample_size"], 0)
        backlog = next(c for c in body["columns"] if c["column_uid"] == self.backlog.uid)
        self.assertEqual(backlog["wip_count"], 5)

    def test_throughput_reports_completed_in_range(self):
        # Pin the clock to mid-week: with the wall clock, a run in the first 12 hours of a
        # Monday UTC puts "0.5 days ago" in the previous (whole) week and total becomes 1.
        self.now = datetime.datetime(2026, 11, 18, 12, 0, tzinfo=datetime.timezone.utc)
        self.path(self.backlog, 20, self.doing, 16, self.done, 0.5)
        with mock.patch("django.utils.timezone.now", return_value=self.now):
            body = self.client.get(self.url("throughput"), {"days": 30}).json()
        self.assertEqual(body["total"], 0)  # today is never in a whole week
        self.assertEqual(body["completed_in_range"], 1)

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
    # dwell reads no more than cumulative flow; blocked adds CardBlock and
    # CardRelation; attention adds CardRelation and the directory (#2260).
    BUDGET = {
        "cycle-time": 16, "throughput": 16, "cumulative-flow": 14, "wip-age": 20,
        "dwell": 14, "blocked": 18, "attention": 18,
        # All seven from one load (#2426): one range load plus the settled-band
        # pass, the blocks, relations and directories, doubled the same way.
        "overview": 26,
    }

    def seed(self, n):
        owner = User.objects.create_user(username=f"flow_load_{n}", password="pw")
        for i in range(n):
            card = self.path(self.backlog, 20, self.doing, 16, self.done, 3)
            Card.objects.filter(pk=card.pk).update(assignee=owner)
            wip = self.path(self.backlog, 20, self.doing, 10 + i % 3)
            # Assigned, so attention's directory runs its assignee query at both sizes.
            Card.objects.filter(pk=wip.pk).update(assignee=owner if i % 2 else self.user)
            CardBlock.objects.create(card=wip, board=self.board, reason="r", blocked_at=self.ago(1))
            # Mirrored as block_card does, so attention's block_reason is read at both sizes (#2281).
            Card.objects.filter(pk=wip.pk).update(blocked_at=self.ago(1), blocked_reason="r")

    def count(self, metric, **params):
        with CaptureQueriesContext(connection) as ctx:
            resp = self.client.get(self.url(metric), params)
        self.assertEqual(resp.status_code, 200)
        if metric == "attention":
            # An empty list would skip the relation and directory queries this guards.
            self.assertTrue(resp.json()["items"])
            self.assertTrue(any(card["assignee"] for card in resp.json()["cards"]))
            self.assertTrue(any(item["block_reason"] for item in resp.json()["items"]))
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

    # The cumulative-flow day drill-down (`?date=`, #2444) is a different read
    # from the range: the board and its role, the columns, the cards and their
    # deciding rows, and the directory's assignees. Measured at 5 on SQLite and
    # pinned exactly, since the growth check above already fails on any drift.
    # It is not in METRICS, so pinned here.
    DAY_BUDGET = 5

    def test_cumulative_flow_day_drill_down_stays_within_budget_and_does_not_grow(self):
        day = (self.now - datetime.timedelta(days=2)).date().isoformat()
        self.seed(3)
        baseline = self.count("cumulative-flow", date=day)
        self.seed(12)
        scaled = self.count("cumulative-flow", date=day)
        self.assertEqual(scaled, baseline, "the day drill-down grew with the board")
        self.assertLessEqual(scaled, self.DAY_BUDGET)


# ── #2260: flow numbers for the Analytics redesign ─────────────────────────


class ColumnFlowTests(FlowFixture):
    """Cumulative flow's per-column entered/left and start/end counts (#2260)."""

    def columns(self, payload):
        return {c["column_uid"]: c for c in payload["columns"]}

    def cfd(self, flow_range=None):
        return fm.cumulative_flow(self.flow(), flow_range or self.last(30))

    def assert_identity(self, payload):
        for column in payload["columns"]:
            with self.subTest(column=column["column_name"]):
                self.assertEqual(
                    column["end_count"] - column["start_count"], column["entered"] - column["left"],
                )

    def test_entered_minus_left_is_the_change_in_count_on_random_histories(self):
        rng = random.Random(2260)
        gone = Column.objects.create(board=self.board, name="Gone", position=9)
        moves_to = [self.backlog, self.doing, self.review, self.done, self.released, gone]
        for _ in range(40):
            t = rng.uniform(1, 60)
            card = self.card(self.backlog, created=t)
            self.row(card, None, self.backlog, t)
            current, archived_at = self.backlog, None
            for _ in range(rng.randint(0, 7)):
                t = max(0.6, t - rng.uniform(0, 9))
                roll = rng.random()
                if archived_at is None and roll < 0.15:
                    self.row(card, current, current, t, ARCHIVED)
                    archived_at = t
                elif archived_at is not None and roll < 0.4:
                    self.row(card, current, current, t, UNARCHIVED)
                    archived_at = None
                elif archived_at is None:
                    target = rng.choice(moves_to)
                    if target != current:
                        self.row(card, current, target, t)
                        current = target
            if current == gone:
                self.row(card, gone, self.doing, 0.5)
                current = self.doing
            Card.objects.filter(pk=card.pk).update(
                column=current, archived_at=self.ago(archived_at) if archived_at is not None else None,
            )
        gone.delete()
        flow = self.flow()
        day = (self.now - datetime.timedelta(days=20)).date()
        for flow_range in (self.last(30), self.last(7), self.last(2), self.last(90), fm.date_range(day, day + datetime.timedelta(days=9), now=self.now)):
            with self.subTest(flow_range=flow_range):
                payload = fm.cumulative_flow(flow, flow_range)
                self.assert_identity(payload)
                self.assertGreater(sum(c["entered"] for c in payload["columns"]), 0)

    def test_a_same_day_bounce_counts_both_ways_and_nets_to_zero(self):
        card = self.path(self.backlog, 40, self.doing, 35)
        self.row(card, self.doing, self.review, 5.3)
        self.row(card, self.review, self.doing, 5.2)
        columns = self.columns(self.cfd())
        self.assertEqual((columns[self.review.uid]["entered"], columns[self.review.uid]["left"]), (1, 1))
        self.assertEqual((columns[self.doing.uid]["entered"], columns[self.doing.uid]["left"]), (1, 1))
        self.assertEqual(columns[self.doing.uid]["start_count"], columns[self.doing.uid]["end_count"])

    def test_archiving_outside_done_leaves_and_in_done_does_not(self):
        self.path(self.backlog, 40, self.doing, 35, archived=5)
        self.path(self.backlog, 40, self.doing, 35, self.done, 10, archived=5)
        columns = self.columns(self.cfd())
        self.assertEqual(columns[self.doing.uid]["left"], 2)  # one archived, one finished
        self.assertEqual((columns[self.done.uid]["entered"], columns[self.done.uid]["left"]), (1, 0))
        self.assertEqual(columns[self.done.uid]["end_count"], 1)
        self.assert_identity(self.cfd())

    def test_restoring_enters_the_band_again(self):
        card = self.card(self.doing, created=40)
        self.row(card, None, self.backlog, 40)
        self.row(card, self.backlog, self.doing, 35)
        self.row(card, self.doing, self.doing, 10, ARCHIVED)
        self.row(card, self.doing, self.doing, 5, UNARCHIVED)
        doing = self.columns(self.cfd())[self.doing.uid]
        self.assertEqual((doing["entered"], doing["left"], doing["start_count"], doing["end_count"]), (1, 1, 1, 1))

    def test_a_move_into_a_deleted_column_enters_the_null_band_and_deleted_to_deleted_does_not(self):
        first = Column.objects.create(board=self.board, name="Gone 1", position=8)
        second = Column.objects.create(board=self.board, name="Gone 2", position=9)
        card = self.path(self.backlog, 40, self.doing, 35)
        self.row(card, self.doing, first, 6)
        self.row(card, first, second, 4)
        first.delete()
        second.delete()
        columns = self.columns(self.cfd())
        self.assertEqual((columns[None]["entered"], columns[None]["left"]), (1, 0))
        self.assertEqual(columns[self.doing.uid]["left"], 1)
        self.assert_identity(self.cfd())

    def test_a_card_created_inside_the_range_enters_and_one_created_before_is_counted_at_the_start(self):
        self.path(self.backlog, 10)
        self.path(self.backlog, 40)
        backlog = self.columns(self.cfd())[self.backlog.uid]
        self.assertEqual((backlog["start_count"], backlog["end_count"], backlog["entered"]), (1, 2, 1))

    def test_rates_are_per_week_of_change_unrounded(self):
        for _ in range(3):
            self.path(self.backlog, 40, self.doing, 3)
        doing = self.columns(self.cfd(self.last(8)))[self.doing.uid]
        # Eight whole days hold seven days of change: one week.
        self.assertEqual((doing["entered"], doing["entered_per_week"], doing["left_per_week"]), (3, 3.0, 0.0))
        doing = self.columns(self.cfd(self.last(10)))[self.doing.uid]
        self.assertEqual(doing["entered_per_week"], 3 * 7 / 9)

    def test_one_day_has_counts_but_no_change_and_no_rate(self):
        self.path(self.backlog, 40, self.doing, 1)
        doing = self.columns(self.cfd(self.last(1)))[self.doing.uid]
        self.assertEqual((doing["start_count"], doing["end_count"], doing["entered"], doing["left"]), (1, 1, 0, 0))
        self.assertIsNone(doing["entered_per_week"])
        self.assertIsNone(doing["left_per_week"])

    def test_no_whole_day_has_null_counts(self):
        self.path(self.backlog, 40, self.doing, 1)
        today = self.now.date()
        payload = self.cfd(fm.date_range(today, today, now=self.now))
        self.assertEqual(payload["days"], [])
        for column in payload["columns"]:
            self.assertEqual(
                [column[k] for k in ("start_count", "end_count", "entered", "left", "entered_per_week", "left_per_week")],
                [None, None, 0, 0, None, None],
            )

    # ── #2307: the done band's rate counts first completions ──

    def test_moving_between_done_columns_counts_one_completion(self):
        self.path(self.backlog, 40, self.doing, 20, self.done, 10, self.released, 5)
        payload = self.cfd()
        columns = self.columns(payload)
        # Each done column saw the card enter, so their sum would say two.
        self.assertEqual((columns[self.done.uid]["entered"], columns[self.released.uid]["entered"]), (1, 1))
        self.assertEqual(payload["completed"], 1)

    def test_a_reopened_card_finishing_again_counts_once(self):
        self.path(self.backlog, 40, self.doing, 20, self.done, 10, self.doing, 8, self.done, 6)
        payload = self.cfd()
        self.assertEqual(self.columns(payload)[self.done.uid]["entered"], 2)
        self.assertEqual(payload["completed"], 1)

    def test_a_card_first_finished_before_the_range_is_not_a_completion_in_it(self):
        self.path(self.backlog, 60, self.doing, 50, self.done, 40, self.released, 5)
        payload = self.cfd()
        self.assertEqual(self.columns(payload)[self.released.uid]["entered"], 1)
        self.assertEqual(payload["completed"], 0)

    def test_a_card_created_in_done_inside_the_range_is_a_completion(self):
        self.path(self.done, 5)
        payload = self.cfd()
        self.assertEqual(payload["completed"], 1)
        self.assertEqual(payload["completed"], self.columns(payload)[self.done.uid]["entered"])

    def test_completed_per_week_uses_the_entered_rate_window(self):
        for _ in range(3):
            self.path(self.backlog, 40, self.doing, 20, self.done, 3, self.released, 2)
        payload = self.cfd(self.last(8))
        self.assertEqual((payload["completed"], payload["completed_per_week"]), (3, 3.0))
        self.assertEqual(self.cfd(self.last(10))["completed_per_week"], 3 * 7 / 9)

    def test_completed_rate_is_null_without_two_whole_days(self):
        self.path(self.backlog, 40, self.doing, 20, self.done, 1)
        payload = self.cfd(self.last(1))
        self.assertEqual((payload["completed"], payload["completed_per_week"]), (0, None))
        today = self.now.date()
        payload = self.cfd(fm.date_range(today, today, now=self.now))
        self.assertEqual((payload["completed"], payload["completed_per_week"]), (0, None))


class ThroughputStartedTests(FlowFixture):
    """Throughput's per-period ``started`` (#2260)."""

    def started_on(self, payload, days_ago):
        day = self.ago(days_ago).date()
        for sample in payload["samples"]:
            first = datetime.date.fromisoformat(sample["start"])
            if first <= day < first + datetime.timedelta(days=7 if payload["period"] == "week" else 1):
                return sample["started"]
        return None

    def test_a_start_lands_in_the_period_of_its_cycle_start(self):
        self.path(self.backlog, 20, self.doing, 16, self.done, 3)
        self.path(self.backlog, 20, self.doing, 9)
        payload = fm.throughput(self.flow(), self.last(30))
        self.assertEqual(self.started_on(payload, 16), 1)
        self.assertEqual(self.started_on(payload, 9), 1)
        self.assertEqual(sum(s["started"] for s in payload["samples"]), 2)
        daily = fm.throughput(self.flow(), self.last(30), "day")
        self.assertEqual(self.started_on(daily, 16), 1)

    def test_a_reopen_is_not_a_start_and_an_archived_card_still_counts(self):
        self.path(self.backlog, 20, self.doing, 16, self.done, 10, self.doing, 5)
        self.path(self.backlog, 20, self.doing, 9, self.done, 4, archived=2)
        payload = fm.throughput(self.flow(), self.last(30), "day")
        self.assertEqual(self.started_on(payload, 5), 0)
        self.assertEqual(sum(s["started"] for s in payload["samples"]), 2)

    def test_only_whole_weeks_count(self):
        # Now is Wednesday 2026-07-15; ten days hold one whole ISO week, 07-06..07-12.
        self.path(self.backlog, 20, self.doing, 10)  # Sunday 07-05, before it
        self.path(self.backlog, 20, self.doing, 7)  # Wednesday 07-08, inside it
        self.path(self.backlog, 20, self.doing, 2)  # Monday 07-13, a partial week
        payload = fm.throughput(self.flow(), self.last(10))
        self.assertEqual([(s["start"], s["started"]) for s in payload["samples"]], [("2026-07-06", 1)])

    def test_a_card_with_no_creation_movement_finishes_but_never_starts(self):
        card = self.card(self.done, created=30)
        self.row(card, self.backlog, self.doing, 20)
        self.row(card, self.doing, self.done, 10)
        payload = fm.throughput(self.flow(), self.last(30))
        self.assertEqual(payload["total"], 1)
        self.assertEqual(sum(s["started"] for s in payload["samples"]), 0)


class ColumnDwellTests(FlowFixture):
    def test_per_column_percentiles_follow_the_sample_size_rule(self):
        for _ in range(4):
            self.path(self.backlog, 20, self.doing, 10, self.review, 5)
        payload = fm.column_dwell(self.flow(), self.last(30))
        self.assertEqual(set(payload), {"definition", "sample_size", "excluded_incomplete_history", "columns"})
        doing = {c["column_uid"]: c for c in payload["columns"]}[self.doing.uid]
        self.assertEqual(doing["sample_size"], 4)
        self.assertIsNone(doing["percentiles"]["p50"])
        for _ in range(3):
            self.path(self.backlog, 20, self.doing, 10, self.review, 5)
        payload = fm.column_dwell(self.flow(), self.last(30))
        doing = {c["column_uid"]: c for c in payload["columns"]}[self.doing.uid]
        self.assertEqual(doing["percentiles"]["p85"], 5)
        self.assertEqual([c["column_uid"] for c in payload["columns"]], [self.backlog.uid, self.doing.uid, self.review.uid])
        full = fm.completed_dwell(self.flow(), self.last(30))
        self.assertEqual(payload["columns"], full["columns"])
        self.assertEqual(payload["sample_size"], full["sample_size"])


class BlockedSummaryTests(FlowFixture):
    def block(self, card, reason, start, end=None, column=None):
        column = column or self.doing
        return CardBlock.objects.create(
            card=card, board=self.board, column=column, column_name=column.name, column_uid=column.uid,
            reason=reason, blocked_at=self.ago(start), unblocked_at=self.ago(end) if end is not None else None,
        )

    def summary(self, flow_range=None, **filters):
        return fm.blocked_summary(fm.load_live_wip(self.board, now=self.now, **filters), flow_range or self.last(30))

    def test_a_date_range_that_ended_in_the_past_clips_blocks_to_its_end(self):
        card = self.path(self.backlog, 40, self.doing, 35)
        self.block(card, "Vendor", 20, 5)
        to_day = self.ago(10).date()
        flow_range = fm.date_range(self.ago(30).date(), to_day, now=self.now)
        expected = (flow_range.end - self.ago(20)).total_seconds() / fm.SECONDS_PER_DAY
        self.assertEqual(expected, 10.5)
        self.assertEqual(self.summary(flow_range)["total"]["days"], expected)
        self.assertEqual(fm.blocked_time(self.flow(), flow_range)["total"]["seconds"], int(expected * fm.SECONDS_PER_DAY))
        # A rolling range ends at now and is unchanged.
        self.assertEqual(self.summary()["total"]["days"], 15)

    def test_columns_by_uid_and_reasons_ranked_by_days(self):
        card = self.path(self.backlog, 40, self.doing, 35)
        self.block(card, "Long", 10, 5)
        self.block(card, "short", 4, 3, column=self.review)
        self.block(card, "Short ", 3, 2, column=self.review)
        payload = self.summary()
        self.assertEqual([c["column_uid"] for c in payload["columns"]], [c.uid for c in (self.backlog, self.doing, self.review, self.done, self.released)])
        by_uid = {c["column_uid"]: c for c in payload["columns"]}
        self.assertEqual((by_uid[self.doing.uid]["days"], by_uid[self.doing.uid]["blocks"]), (5, 1))
        self.assertEqual((by_uid[self.review.uid]["days"], by_uid[self.review.uid]["blocks"]), (2, 2))
        self.assertEqual([(r["reason"], r["days"], r["blocks"]) for r in payload["reasons"]], [("Long", 5, 1), ("Short", 2, 2)])
        self.assertEqual(payload["reason_count"], 2)
        self.assertEqual(payload["total"], {"days": 7, "blocks": 3})
        # The /analytics/ shape still ranks by count.
        self.assertEqual(fm.blocked_time(self.flow(), self.last(30))["top_reasons"][0]["reason"], "Short")

    def test_reason_count_reports_reasons_past_the_cap(self):
        card = self.path(self.backlog, 40, self.doing, 35)
        for n in range(fm.TOP_BLOCK_REASONS + 2):
            self.block(card, f"Reason {n}", 10, 9)
        payload = self.summary()
        self.assertEqual(len(payload["reasons"]), fm.TOP_BLOCK_REASONS)
        self.assertEqual(payload["reason_count"], fm.TOP_BLOCK_REASONS + 2)
        self.assertEqual(payload["total"]["blocks"], fm.TOP_BLOCK_REASONS + 2)

    def test_swimlane_and_label_filters(self):
        label = Label.objects.create(board=self.board, name="T")
        here = self.path(self.backlog, 20, self.doing, 15)
        there = self.path(self.backlog, 20, self.doing, 15, lane=self.other_lane)
        there.labels.add(label)
        self.block(here, "Here", 5, 3)
        self.block(there, "There", 5, 4)
        Card.objects.filter(pk=there.pk).update(blocked_at=self.ago(1))
        by_lane = self.summary(swimlane_id=self.lane.id)
        self.assertEqual(([r["reason"] for r in by_lane["reasons"]], by_lane["blocked_now"]), (["Here"], 0))
        by_label = self.summary(label_id=label.id)
        self.assertEqual(([r["reason"] for r in by_label["reasons"]], by_label["blocked_now"]), (["There"], 1))

    def mixed_board(self):
        live = self.path(self.backlog, 40, self.doing, 35)
        finished = self.path(self.backlog, 40, self.doing, 35, self.done, 3)
        archived = self.path(self.backlog, 40, self.doing, 35, archived=2)
        blocker = self.path(self.backlog, 40)
        by_relation = self.path(self.backlog, 40, self.review, 20)
        CardRelation.objects.create(from_card=blocker, to_card=by_relation, relation_type=CardRelation.Type.BLOCKS)
        for card in (live, finished, archived):
            self.block(card, f"On {card.pk}", 10, 4)
            Card.objects.filter(pk=card.pk).update(blocked_at=self.ago(1))
        self.block(archived, "Open on an archived card", 6)
        return live, by_relation

    def test_the_narrowed_load_gives_the_full_load_answer(self):
        self.mixed_board()
        for flow_range in (self.last(30), self.last(5)):
            with self.subTest(flow_range=flow_range):
                self.assertEqual(self.summary(flow_range), fm.blocked_summary(self.flow(), flow_range))
        self.assertEqual(self.summary()["blocked_now"], 2)

    def test_blocked_now_matches_the_attention_items_marked_blocked(self):
        self.mixed_board()
        for filters in ({}, {"swimlane_id": self.lane.id}, {"swimlane_id": self.other_lane.id}):
            with self.subTest(filters=filters):
                attention = fm.needs_attention(self.flow(**filters), self.last(30), stalled_days=7)
                marked = [i for i in attention["items"] if "blocked" in i["reasons"]]
                self.assertEqual(self.summary(**filters)["blocked_now"], len(marked))


class NeedsAttentionTests(FlowFixture):
    def finish_seven(self):
        """Seven two-day cycle times, so the p85 exists and is exactly 2."""
        for _ in range(7):
            self.path(self.backlog, 20, self.doing, 12, self.done, 10)

    def attention(self, stalled_days=7, **filters):
        return fm.needs_attention(self.flow(**filters), self.last(30), stalled_days=stalled_days)

    def items(self, **kwargs):
        return {i["card_uid"]: i for i in self.attention(**kwargs)["items"]}

    def test_a_card_with_every_reason_is_listed_once(self):
        self.finish_seven()
        card = self.path(self.backlog, 40, self.doing, 30)
        Card.objects.filter(pk=card.pk).update(blocked_at=self.ago(1))
        payload = self.attention()
        self.assertEqual(payload["cycle_time_percentiles"]["p85"], 2)
        self.assertEqual(payload["stalled_threshold_days"], 7)
        self.assertEqual(payload["definition"], fm.DEFINITIONS["needs_attention"])
        self.assertEqual([i["card_uid"] for i in payload["items"]], [card.uid])
        item = payload["items"][0]
        self.assertEqual(item["reasons"], ["blocked", "past_p85", "stalled"])
        self.assertEqual(
            (item["column_uid"], item["swimlane_id"], item["age_days"], item["unmoved_days"]),
            (self.doing.uid, self.lane.id, 30, 30),
        )

    def test_a_backlog_card_with_no_cycle_start_is_stalled_with_no_age(self):
        self.finish_seven()
        card = self.path(self.backlog, 20)
        item = self.items()[card.uid]
        self.assertEqual((item["reasons"], item["age_days"], item["unmoved_days"]), (["stalled"], None, 20))

    def plan(self, card, *, released_days_ago=None):
        """Make ``card`` a planned child (#2371), optionally released that many days ago."""
        parent = self.card(self.doing, created=1, title="Parent")
        return CardParentLink.objects.create(
            parent=parent, child=card, needed_at_column=self.doing,
            planned_released_at=self.ago(released_days_ago) if released_days_ago is not None else None,
        )

    def test_a_planned_child_is_never_stalled(self):
        """#2554: a planned child in To do is not stalled however long it sat; its twin is."""
        planned = self.path(self.backlog, 40)
        twin = self.path(self.backlog, 40)
        self.plan(planned)
        items = self.items(stalled_days=14)
        self.assertNotIn(planned.uid, items)
        self.assertEqual(items[twin.uid]["reasons"], ["stalled"])

    def test_a_planned_child_with_no_movement_rows_is_never_stalled(self):
        card = self.card(self.backlog, created=200)
        self.plan(card)
        self.assertNotIn(card.uid, self.items(stalled_days=14))

    def test_a_released_child_is_measured_from_its_release(self):
        """#2554: same rule as is_stale: the clock is the later of last move and release."""
        recent = self.path(self.backlog, 40)
        self.plan(recent, released_days_ago=3)
        old = self.path(self.backlog, 40)
        self.plan(old, released_days_ago=20)
        items = self.items(stalled_days=14)
        self.assertNotIn(recent.uid, items)
        self.assertEqual((items[old.uid]["reasons"], items[old.uid]["unmoved_days"]), (["stalled"], 20))

    def test_a_release_older_than_the_last_move_does_not_extend_the_clock(self):
        card = self.path(self.backlog, 40, self.doing, 5)
        self.plan(card, released_days_ago=30)
        self.assertNotIn(card.uid, self.items(stalled_days=14))

    def test_a_planned_child_can_still_be_blocked(self):
        card = self.path(self.backlog, 40)
        self.plan(card)
        Card.objects.filter(pk=card.pk).update(blocked_at=self.ago(2))
        self.assertEqual(self.items(stalled_days=14)[card.uid]["reasons"], ["blocked"])

    def test_a_card_with_no_movement_rows_is_stalled_from_its_creation(self):
        """#2291: imported or legacy data has no live movement, so unmoved time counts from created_at."""
        card = self.card(self.doing, created=200)
        item = self.items(stalled_days=14)[card.uid]
        self.assertEqual((item["reasons"], item["age_days"], item["unmoved_days"]), (["stalled"], None, 200))

    def test_a_card_with_no_movement_rows_follows_the_strict_threshold(self):
        at_threshold = self.card(self.doing, created=14, title="At")
        past_threshold = self.card(self.doing, created=15, title="Past")
        recent = self.card(self.doing, created=3, title="Recent")
        items = self.items(stalled_days=14)
        self.assertNotIn(at_threshold.uid, items)
        self.assertNotIn(recent.uid, items)
        self.assertEqual(items[past_threshold.uid]["reasons"], ["stalled"])

    def test_an_imported_card_with_incomplete_history_is_stalled_never_past_p85(self):
        self.finish_seven()
        card = self.card(self.doing, created=30)
        self.row(card, self.backlog, self.doing, 25)
        item = self.items()[card.uid]
        self.assertEqual((item["reasons"], item["age_days"]), (["stalled"], None))

    def test_no_p85_means_no_past_p85(self):
        card = self.path(self.backlog, 40, self.doing, 30)
        payload = self.attention()
        self.assertIsNone(payload["cycle_time_percentiles"]["p85"])
        self.assertEqual(payload["items"][0]["reasons"], ["stalled"])
        self.assertEqual(payload["items"][0]["card_uid"], card.uid)

    def test_both_comparisons_are_strict(self):
        self.finish_seven()
        at_p85 = self.path(self.backlog, 5, self.doing, 2)
        past_p85 = self.path(self.backlog, 5, self.doing, 2.5)
        items = self.items()
        self.assertNotIn(at_p85.uid, items)
        self.assertEqual(items[past_p85.uid]["reasons"], ["past_p85"])
        self.assertEqual(items[past_p85.uid]["unmoved_days"], 2.5)
        stalled = self.path(self.backlog, 10)
        self.assertNotIn(stalled.uid, self.items(stalled_days=10))
        self.assertEqual(self.items(stalled_days=9)[stalled.uid]["reasons"], ["stalled"])

    def test_order_is_age_with_nulls_last_then_unmoved_then_id(self):
        old = self.path(self.backlog, 40, self.doing, 30)
        younger = self.path(self.backlog, 40, self.doing, 20)
        backlog_long = self.path(self.backlog, 25)
        backlog_short = self.path(self.backlog, 15)
        tie = self.path(self.backlog, 15)
        imported = self.card(self.doing, created=30)  # no movement at all: unmoved counts from created_at (#2291)
        Card.objects.filter(pk=imported.pk).update(blocked_at=self.ago(1))
        self.assertEqual(
            [i["card_uid"] for i in self.attention()["items"]],
            [old.uid, younger.uid, imported.uid, backlog_long.uid, backlog_short.uid, tie.uid],
        )
        item = self.items()[imported.uid]
        self.assertEqual((item["reasons"], item["age_days"], item["unmoved_days"]), (["blocked", "stalled"], None, 30))

    def test_archived_and_done_cards_are_never_listed(self):
        self.path(self.backlog, 40, self.doing, 30, archived=20)
        self.path(self.backlog, 40, self.doing, 30, self.done, 20)
        self.assertEqual(self.attention()["items"], [])

    def test_a_future_dated_movement_is_ignored(self):
        card = self.path(self.backlog, 40, self.doing, 30)
        self.row(card, self.doing, self.review, -2)
        self.assertEqual(self.items()[card.uid]["unmoved_days"], 30)

    def blocked_card(self, reason):
        card = self.path(self.backlog, 40, self.doing, 30)
        Card.objects.filter(pk=card.pk).update(blocked_at=self.ago(1), blocked_reason=reason)
        return card

    def test_a_manual_block_carries_its_reason_trimmed(self):
        card = self.blocked_card("  waiting on security review\n")
        self.assertEqual(self.items()[card.uid]["block_reason"], "waiting on security review")

    def test_a_block_with_no_text_has_a_null_reason_never_empty(self):
        for reason in ("", "   ", "\t\n"):
            with self.subTest(reason=reason):
                card = self.blocked_card(reason)
                item = self.items()[card.uid]
                self.assertIn("blocked", item["reasons"])
                self.assertIsNone(item["block_reason"])

    def test_a_card_that_is_not_blocked_has_a_null_reason(self):
        card = self.path(self.backlog, 20)
        # A reason left on the row with blocked_at clear is not a block.
        Card.objects.filter(pk=card.pk).update(blocked_reason="stale text")
        item = self.items()[card.uid]
        self.assertEqual((item["reasons"], item["block_reason"]), (["stalled"], None))

    def test_a_relation_block_alone_has_no_reason_and_a_manual_one_wins(self):
        blocker = self.path(self.backlog, 2)
        by_relation = self.path(self.backlog, 40, self.doing, 30)
        both = self.blocked_card("vendor")
        for target in (by_relation, both):
            CardRelation.objects.create(from_card=blocker, to_card=target, relation_type=CardRelation.Type.BLOCKS)
        items = self.items()
        self.assertEqual((items[by_relation.uid]["reasons"][0], items[by_relation.uid]["block_reason"]), ("blocked", None))
        self.assertEqual(items[both.uid]["block_reason"], "vendor")

    def test_a_stale_reason_with_no_blocked_at_is_not_a_block_reason(self):
        # "blocked" comes from the relation, so the reason clause passes and only
        # the blocked_at guard keeps the leftover text off the item.
        blocker = self.path(self.backlog, 2)
        card = self.path(self.backlog, 40, self.doing, 30)
        CardRelation.objects.create(from_card=blocker, to_card=card, relation_type=CardRelation.Type.BLOCKS)
        Card.objects.filter(pk=card.pk).update(blocked_at=None, blocked_reason="stale")
        item = self.items()[card.uid]
        self.assertIn("blocked", item["reasons"])
        self.assertIsNone(item["block_reason"])


class FlowRedesignEndpointTests(EndpointFixture):
    """The three #2260 endpoints over HTTP, and their documented shapes."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.schema = SchemaGenerator().get_schema(request=None, public=True)

    def assert_documented(self, component, obj):
        documented = set(self.schema["components"]["schemas"][component]["properties"])
        # The #2265 breakdown keys are documented but present only with group_by, the #2429 ones only with limit.
        self.assertEqual(set(obj), documented - ((GROUPING_ONLY_KEYS | LIMIT_ONLY_KEYS) - set(obj)), component)

    def test_a_user_who_must_change_their_password_is_refused(self):
        self.user.must_change_password = True
        self.user.save(update_fields=["must_change_password"])
        for metric in ("dwell", "blocked", "attention", "overview"):
            with self.subTest(metric=metric):
                self.assertEqual(self.client.get(self.url(metric)).status_code, 403)

    def test_every_new_payload_carries_exactly_its_documented_fields(self):
        for _ in range(7):
            self.path(self.backlog, 20, self.doing, 12, self.done, 10)
        card = self.path(self.backlog, 40, self.doing, 30)
        CardBlock.objects.create(
            card=card, board=self.board, column=self.doing, column_name="Doing", column_uid=self.doing.uid,
            reason="Vendor", blocked_at=self.ago(5),
        )
        Card.objects.filter(pk=card.pk).update(blocked_at=self.ago(5), blocked_reason="Vendor")
        dwell = self.client.get(self.url("dwell")).json()
        self.assert_documented("FlowDwell", dwell)
        self.assert_documented("FlowDwellColumn", dwell["columns"][0])
        blocked = self.client.get(self.url("blocked")).json()
        self.assert_documented("FlowBlocked", blocked)
        self.assert_documented("FlowBlockedTotal", blocked["total"])
        self.assert_documented("FlowBlockedColumn", blocked["columns"][0])
        self.assert_documented("FlowBlockedReason", blocked["reasons"][0])
        self.assertEqual(blocked["blocked_now"], 1)
        attention = self.client.get(self.url("attention")).json()
        self.assert_documented("FlowAttention", attention)
        self.assert_documented("FlowAttentionItem", attention["items"][0])
        self.assertEqual(attention["items"][0]["block_reason"], "Vendor")
        self.assertEqual([c["uid"] for c in attention["cards"]], [card.uid])
        cfd = self.client.get(self.url("cumulative-flow")).json()
        self.assert_documented("FlowCumulativeFlowColumn", cfd["columns"][0])
        self.assert_documented("FlowCumulativeFlowColumn", cfd["columns"][-1])
        throughput = self.client.get(self.url("throughput")).json()
        self.assert_documented("FlowThroughputSample", throughput["samples"][0])
        overview = self.client.get(self.url("overview")).json()
        self.assert_documented("FlowOverview", overview)
        # With `limit` (#2429) every capped section carries all of its documented keys.
        capped = self.client.get(self.url("overview"), {"limit": "1"}).json()
        for section, component in (
            ("cycle_time", "FlowCycleTime"), ("throughput", "FlowThroughput"),
            ("wip_age", "FlowWipAge"), ("attention", "FlowAttention"),
        ):
            with self.subTest(section=section):
                self.assert_documented(component, capped[section])
                self.assertIn("sampled", capped[section])
        self.assert_documented("FlowWipAgeColumn", capped["wip_age"]["columns"][0])
        self.assertIn("past_p85_count", capped["wip_age"]["columns"][0])

    def test_attention_uses_the_board_staleness_threshold(self):
        self.board.staleness_threshold_days = 3
        self.board.save(update_fields=["staleness_threshold_days"])
        card = self.path(self.backlog, 20, self.doing, 5)
        body = self.client.get(self.url("attention")).json()
        self.assertEqual(body["stalled_threshold_days"], 3)
        self.assertEqual([i["card_uid"] for i in body["items"]], [card.uid])

    def test_blocked_reads_the_filters_and_the_date_range(self):
        here = self.path(self.backlog, 40, self.doing, 35)
        there = self.path(self.backlog, 40, self.doing, 35, lane=self.other_lane)
        for card, reason in ((here, "Here"), (there, "There")):
            CardBlock.objects.create(
                card=card, board=self.board, column=self.doing, column_name="Doing", column_uid=self.doing.uid,
                reason=reason, blocked_at=self.ago(20), unblocked_at=self.ago(5),
            )
        body = self.client.get(self.url("blocked"), {"swimlane_id": self.other_lane.id}).json()
        self.assertEqual([r["reason"] for r in body["reasons"]], ["There"])
        to_day = self.ago(10).date()
        ranged = self.client.get(
            self.url("blocked"), {"from_date": self.ago(30).date().isoformat(), "to_date": to_day.isoformat()},
        ).json()
        end = datetime.datetime.combine(to_day + datetime.timedelta(days=1), datetime.time(), tzinfo=datetime.timezone.utc)
        self.assertAlmostEqual(ranged["total"]["days"], 2 * (end - self.ago(20)).total_seconds() / fm.SECONDS_PER_DAY)


# ── #2265: flow metrics grouped by swimlane, label or a card field ─────────

GROUPED_METRICS = ("cycle-time", "throughput", "wip-age", "dwell")


def _size(metric, body):
    """The number a grouping reconciles with, in the endpoint's own unit."""
    return body["total"] if metric == "throughput" else body["sample_size"]


def _group_size(metric, group):
    return group["total"] if metric == "throughput" else group["sample_size"]


def _strip_grouping(body):
    body = {k: v for k, v in body.items() if k != "grouping"}
    if "samples" in body:
        body["samples"] = [
            {k: v for k, v in sample.items() if k not in ("group_keys", "by_group")} for sample in body["samples"]
        ]
    return body


class GroupingFixture(EndpointFixture):
    def get(self, metric, **params):
        if metric == "throughput":
            # Whole days, so completions a few days ago are counted whatever the weekday.
            params.setdefault("period", "day")
        resp = self.client.get(self.url(metric), params)
        self.assertEqual(resp.status_code, 200, resp.content)
        return resp.json()

    def lanes(self, n):
        """``n`` swimlanes, the fixture's two first."""
        lanes = [self.lane, self.other_lane]
        for position in range(2, n):
            lanes.append(Swimlane.objects.create(board=self.board, name=f"Lane {position}", position=position))
        return lanes[:n]

    def wip(self, lane=None):
        return self.path(self.backlog, 20, self.doing, 10, lane=lane)

    def completed(self, lane=None):
        return self.path(self.backlog, 20, self.doing, 16, self.done, 3, lane=lane)

    def field(self, field_type=CustomFieldDefinition.FieldType.DROPDOWN, choices=(), board=None):
        # Name and position are unique per board.
        n = CustomFieldDefinition.objects.count()
        return CustomFieldDefinition.objects.create(
            board=board or self.board, name=f"Field {n}", position=n, field_type=field_type,
            choices_json=list(choices),
        )

    def value(self, card, definition, value):
        CustomFieldValue.objects.create(card=card, field_definition=definition, value=value)


class GroupingShapeTests(GroupingFixture):
    def seed_mixed(self):
        lanes = self.lanes(3)
        team = self.field(choices=["Red", "Blue"])
        red, blue = Label.objects.create(board=self.board, name="red"), Label.objects.create(board=self.board, name="blue")
        for i in range(9):
            card = (self.completed if i % 2 else self.wip)(lane=lanes[i % 3])
            if i % 3:
                self.value(card, team, ["Red", "Blue"][i % 2])
            if i % 4 == 0:
                card.labels.add(red)
            if i % 3 == 0:
                card.labels.add(blue)
        return team

    def test_grouping_only_adds_keys_to_the_ungrouped_response(self):
        team = self.seed_mixed()
        with mock.patch("django.utils.timezone.now", return_value=self.now):
            for metric in GROUPED_METRICS:
                plain = self.get(metric)
                self.assertNotIn("grouping", plain)
                for params in ({"group_by": "swimlane"}, {"group_by": "label"},
                               {"group_by": "custom_field", "group_by_field_id": team.id}):
                    with self.subTest(metric=metric, **params):
                        grouped = self.get(metric, **params)
                        self.assertIn("grouping", grouped)
                        self.assertEqual(_strip_grouping(grouped), plain)

    def test_endpoints_that_do_not_break_down_ignore_group_by(self):
        team = self.seed_mixed()
        with mock.patch("django.utils.timezone.now", return_value=self.now):
            for metric in ("cumulative-flow", "blocked", "attention"):
                with self.subTest(metric=metric):
                    self.assertEqual(
                        self.get(metric, group_by="custom_field", group_by_field_id=team.id), self.get(metric),
                    )

    def relane(self, card, lane, days_ago):
        """A swimlane-only move ``days_ago``, written as ``move_card`` writes one."""
        Card.objects.filter(pk=card.pk).update(swimlane=lane)
        card.refresh_from_db()
        self.row(card, card.column, card.column, days_ago)

    def test_swimlane_and_field_groups_reconcile_with_the_ungrouped_totals(self):
        team = self.seed_mixed()
        # Cards that changed swimlane (#2334): after completing, while in
        # progress, and mid-stay before completing. Groups are dated by the
        # sample, and every sample still sits in exactly one group.
        lanes = list(self.board.swimlanes.order_by("position"))
        self.relane(self.completed(lane=lanes[0]), lanes[1], 1)
        self.relane(self.wip(lane=lanes[0]), lanes[2], 5)
        mid_stay = self.path(self.backlog, 20, self.doing, 16, lane=lanes[2])
        self.relane(mid_stay, lanes[0], 10)
        Card.objects.filter(pk=mid_stay.pk).update(column=self.done)
        mid_stay.refresh_from_db()
        self.row(mid_stay, self.doing, self.done, 3)
        for metric in GROUPED_METRICS:
            for params in ({"group_by": "swimlane"}, {"group_by": "custom_field", "group_by_field_id": team.id}):
                with self.subTest(metric=metric, **params):
                    body = self.get(metric, **params)
                    grouping = body["grouping"]
                    self.assertEqual(
                        sum(_group_size(metric, g) for g in grouping["groups"]) + grouping["excluded"],
                        _size(metric, body),
                    )
        field_grouping = self.get("wip-age", group_by="custom_field", group_by_field_id=team.id)["grouping"]
        self.assertEqual((field_grouping["by"], field_grouping["field_id"]), ("custom_field", team.id))
        self.assertGreater(field_grouping["excluded"], 0)

    def test_grouped_bodies_match_their_published_schema(self):
        schema = SchemaGenerator().get_schema(request=None, public=True)
        team = self.seed_mixed()
        for metric in GROUPED_METRICS:
            path = f"/api/v1/boards/{{id}}/metrics/{metric}/"
            fragment = schema["paths"][path]["get"]["responses"]["200"]["content"]["application/json"]["schema"]
            combined = _openapi3_nullable_to_jsonschema({**fragment, "components": schema["components"]})
            for params in ({"group_by": "label"}, {"group_by": "custom_field", "group_by_field_id": team.id}):
                with self.subTest(metric=metric, **params):
                    body = self.get(metric, **params)
                    jsonschema.validate(instance=body, schema=combined)
                    prefix = {"cycle-time": "FlowCycleTime", "throughput": "FlowThroughput",
                              "wip-age": "FlowWipAge", "dwell": "FlowDwell"}[metric]
                    components = schema["components"]["schemas"]
                    self.assertEqual(set(body["grouping"]), set(components[f"{prefix}Grouping"]["properties"]))
                    self.assertEqual(set(body["grouping"]["groups"][0]), set(components[f"{prefix}Group"]["properties"]))
                    if metric == "throughput":
                        self.assertEqual(set(body["samples"][0]), set(components["FlowThroughputSample"]["properties"]))
                        self.assertEqual(
                            set(body["samples"][0]["by_group"][0]),
                            set(components["FlowThroughputGroupCount"]["properties"]),
                        )

    def test_only_the_four_breakdown_endpoints_document_the_group_parameters(self):
        schema = SchemaGenerator().get_schema(request=None, public=True)
        for metric in METRICS:
            with self.subTest(metric=metric):
                operation = schema["paths"][f"/api/v1/boards/{{id}}/metrics/{metric}/"]["get"]
                names = {p["name"] for p in operation["parameters"] if p["in"] == "query"}
                # The overview passes group_by on to its four breakdown sections (#2426).
                expected = metric in GROUPED_METRICS or metric == "overview"
                self.assertEqual({"group_by", "group_by_field_id"} <= names, expected)
                self.assertEqual(bool(names & {"group_by", "group_by_field_id"}), expected)


class GroupingRankingTests(GroupingFixture):
    def test_a_completion_on_the_first_bucket_day_is_not_excluded(self):
        # A rolling range starts at ``now - N days`` but throughput buckets from
        # that day's midnight, so this completion is a sample before ``start``.
        self.now = datetime.datetime(2026, 7, 15, 12, 0, tzinfo=datetime.timezone.utc)
        lanes = self.lanes(2)
        self.wip(lane=lanes[0])
        self.path(self.backlog, 40, self.doing, 35, self.done, 30.25, lane=lanes[1])
        with mock.patch("django.utils.timezone.now", return_value=self.now):
            plain = self.get("throughput", days=30)
            grouped = self.get("throughput", days=30, group_by="swimlane")
        self.assertEqual(plain["total"], 1)
        grouping = grouped["grouping"]
        self.assertEqual(grouping["excluded"], 0, grouping)
        by_key = {g["key"]: g for g in grouping["groups"]}
        self.assertEqual(by_key[str(lanes[1].id)]["total"], 1)
        counted = sum(c["count"] for s in grouped["samples"] for c in s["by_group"])
        self.assertEqual(counted, plain["total"])

    def test_a_lane_of_never_started_cards_is_not_ranked(self):
        # Backlog cards that never moved are samples on no endpoint, so they must
        # not take a named slot and push a lane with real WIP into Other.
        lanes = self.lanes(6)
        for _ in range(10):
            self.path(self.backlog, 20, lane=lanes[0])
        for lane, count in zip(lanes[1:], (5, 4, 3, 2, 1)):
            for _ in range(count):
                self.wip(lane=lane)
        expected = [str(lane.id) for lane in lanes[1:]]
        for metric in GROUPED_METRICS:
            groups = self.get(metric, group_by="swimlane")["grouping"]["groups"]
            self.assertEqual([g["key"] for g in groups], expected, metric)
            self.assertNotIn(None, [g["key"] for g in groups], metric)

    def test_more_than_five_groups_collapse_into_other_last(self):
        lanes = self.lanes(7)
        for index, lane in enumerate(lanes):
            for _ in range(7 - index):
                self.wip(lane=lane)
        self.completed(lane=lanes[0])
        self.completed(lane=lanes[0])
        self.completed(lane=lanes[6])
        body = self.get("wip-age", group_by="swimlane")
        groups = body["grouping"]["groups"]
        self.assertEqual([g["key"] for g in groups], [str(lane.id) for lane in lanes[:5]] + [None])
        self.assertEqual([g["name"] for g in groups], [lane.name for lane in lanes[:5]] + [None])
        self.assertEqual(groups[0]["member_keys"], [str(lanes[0].id)])
        self.assertEqual(groups[-1]["member_keys"], [str(lanes[5].id), str(lanes[6].id)])
        self.assertEqual([g["sample_size"] for g in groups], [7, 6, 5, 4, 3, 3])
        uid_lane = {card.uid: str(card.swimlane_id) for card in Card.objects.filter(board=self.board)}
        for sample in body["samples"]:
            self.assertEqual(sample["group_keys"], [uid_lane[sample["card_uid"]]])
        throughput = self.get("throughput", group_by="swimlane")
        self.assertEqual([g["key"] for g in throughput["grouping"]["groups"]], [g["key"] for g in groups])
        self.assertEqual([g["total"] for g in throughput["grouping"]["groups"]], [2, 0, 0, 0, 0, 1])
        for sample in throughput["samples"]:
            self.assertEqual([entry["key"] for entry in sample["by_group"]], [g["key"] for g in groups])
            self.assertEqual(sum(entry["count"] for entry in sample["by_group"]), sample["count"])
        dwell = self.get("dwell", group_by="swimlane")
        top_columns = [c["column_uid"] for c in dwell["columns"]]
        for group in dwell["grouping"]["groups"]:
            self.assertEqual([c["column_uid"] for c in group["columns"]], top_columns)
            self.assertEqual(set(group["columns"][0]), set(dwell["columns"][0]))

    def test_exactly_six_groups_leave_one_member_in_other(self):
        lanes = self.lanes(6)
        for index, lane in enumerate(lanes):
            for _ in range(6 - index):
                self.wip(lane=lane)
        groups = self.get("wip-age", group_by="swimlane")["grouping"]["groups"]
        self.assertEqual(len(groups), 6)
        self.assertEqual(groups[-1]["member_keys"], [str(lanes[5].id)])

    def test_groups_without_active_cards_are_left_out_and_ties_break_by_position_or_name(self):
        lanes = self.lanes(3)
        self.wip(lane=lanes[1])
        self.wip(lane=lanes[0])
        old = self.path(self.backlog, 300, self.doing, 290, self.done, 280, lane=lanes[2])
        self.assertIsNotNone(old)
        groups = self.get("cycle-time", group_by="swimlane")["grouping"]["groups"]
        self.assertEqual([g["key"] for g in groups], [str(lanes[0].id), str(lanes[1].id)])
        beta, alpha = Label.objects.create(board=self.board, name="beta"), Label.objects.create(board=self.board, name="Alpha")
        for label in (beta, alpha):
            self.wip().labels.add(label)
        groups = self.get("wip-age", group_by="label")["grouping"]["groups"]
        self.assertEqual([g["name"] for g in groups], ["Alpha", "beta"])

    def test_a_group_active_only_through_wip_is_listed_with_size_zero_on_cycle_time(self):
        lanes = self.lanes(2)
        for _ in range(5):
            self.completed(lane=lanes[0])
        self.wip(lane=lanes[1])
        groups = {g["key"]: g for g in self.get("cycle-time", group_by="swimlane")["grouping"]["groups"]}
        self.assertEqual(groups[str(lanes[1].id)]["sample_size"], 0)
        self.assertEqual(groups[str(lanes[1].id)]["percentiles"], {"p50": None, "p85": None, "p95": None})
        self.assertEqual(groups[str(lanes[0].id)]["sample_size"], 5)

    def test_group_percentiles_follow_the_sample_size_rule(self):
        team = self.field(choices=["a", "b", "c", "d"])
        for choice, n in (("a", 4), ("b", 5), ("c", 7), ("d", 20)):
            for _ in range(n):
                self.value(self.completed(), team, choice)
        body = self.get("cycle-time", group_by="custom_field", group_by_field_id=team.id)
        groups = {g["key"]: g for g in body["grouping"]["groups"]}
        self.assertEqual([g["key"] for g in body["grouping"]["groups"]], ["d", "c", "b", "a"])
        nulls = {key: [p for p, v in groups[key]["percentiles"].items() if v is None] for key in groups}
        self.assertEqual(nulls, {"a": ["p50", "p85", "p95"], "b": ["p85", "p95"], "c": ["p95"], "d": []})
        self.assertEqual({k: g["sample_size"] for k, g in groups.items()}, {"a": 4, "b": 5, "c": 7, "d": 20})
        self.assertEqual(groups["d"]["name"], "d")

    def test_swimlane_filter_with_swimlane_grouping_leaves_one_group(self):
        lanes = self.lanes(2)
        for lane in lanes:
            self.wip(lane=lane)
            self.completed(lane=lane)
        for metric in GROUPED_METRICS:
            with self.subTest(metric=metric):
                body = self.get(metric, group_by="swimlane", swimlane_id=lanes[1].id)
                self.assertEqual([g["key"] for g in body["grouping"]["groups"]], [str(lanes[1].id)])


class GroupingLabelAndFieldTests(GroupingFixture):
    def test_a_card_counts_once_per_label_group_and_once_in_other(self):
        labels = [Label.objects.create(board=self.board, name=f"L{i}") for i in range(7)]
        for index, label in enumerate(labels[:5]):
            for _ in range(10 - index):
                self.wip().labels.add(label)
        multi = self.wip()
        multi.labels.add(labels[0], labels[5], labels[6])
        self.wip().labels.add(labels[5])
        unlabeled = self.wip()
        # The same shapes among completed cards, for the three other endpoints.
        multi_done = self.completed()
        multi_done.labels.add(labels[0], labels[5], labels[6])
        self.completed().labels.add(labels[5])
        self.completed()
        body = self.get("wip-age", group_by="label")
        grouping = body["grouping"]
        other = grouping["groups"][-1]
        self.assertEqual(other["key"], None)
        self.assertEqual(set(other["member_keys"]), {str(labels[5].id), str(labels[6].id)})
        self.assertEqual(other["sample_size"], 2)
        self.assertEqual(grouping["excluded"], 1)
        samples = self.by_card(body)
        self.assertEqual(samples[unlabeled.uid]["group_keys"], [])
        self.assertEqual(
            set(samples[multi.uid]["group_keys"]), {str(labels[0].id), str(labels[5].id), str(labels[6].id)},
        )
        # Each unit counts once per distinct group its card lands in: the
        # multi-label card is in L0 and in Other, so each of its units adds one
        # over the ungrouped total. Dwell counts closed visits: the completed one has two,
        # the in-progress one its closed backlog visit.
        extra = {"cycle-time": 1, "throughput": 1, "wip-age": 1, "dwell": 3}
        for metric in GROUPED_METRICS:
            with self.subTest(metric=metric):
                grouped = self.get(metric, group_by="label")
                plain = self.get(metric)
                self.assertEqual(
                    sum(_group_size(metric, g) for g in grouped["grouping"]["groups"]),
                    _size(metric, plain) - grouped["grouping"]["excluded"] + extra[metric],
                )

    def test_labels_of_another_board_are_never_read(self):
        stranger = Board.objects.create(name="Elsewhere", owner=self.user)
        foreign = Label.objects.create(board=stranger, name="foreign")
        card = self.wip()
        # Not reachable through the UI; guards the label__board filter.
        card.labels.add(foreign)
        grouping = self.get("wip-age", group_by="label")["grouping"]
        self.assertEqual(grouping["groups"], [])
        self.assertEqual(grouping["excluded"], 1)

    def test_an_orphan_dropdown_value_is_excluded(self):
        team = self.field(choices=["Red"])
        self.value(self.wip(), team, "Red")
        self.value(self.wip(), team, "Removed choice")
        grouping = self.get("wip-age", group_by="custom_field", group_by_field_id=team.id)["grouping"]
        self.assertEqual([(g["key"], g["name"], g["sample_size"]) for g in grouping["groups"]], [("Red", "Red", 1)])
        self.assertEqual(grouping["excluded"], 1)

    def test_checkbox_groups_read_the_stored_value_and_a_missing_row_is_excluded(self):
        flag = self.field(CustomFieldDefinition.FieldType.CHECKBOX)
        self.value(self.wip(), flag, "false")
        self.value(self.wip(), flag, "false")
        self.value(self.wip(), flag, "true")
        self.value(self.wip(), flag, "maybe")
        self.wip()
        grouping = self.get("wip-age", group_by="custom_field", group_by_field_id=flag.id)["grouping"]
        self.assertEqual(
            [(g["key"], g["name"], g["sample_size"]) for g in grouping["groups"]],
            [("false", None, 2), ("true", None, 1)],
        )
        self.assertEqual(grouping["excluded"], 2)


class GroupingValidationTests(GroupingFixture):
    def bad(self, metric, **params):
        resp = self.client.get(self.url(metric), params)
        self.assertEqual(resp.status_code, 400, resp.content)
        self.assertEqual(resp.json()["code"], "invalid_query_param")
        return resp.json()

    def test_every_unusable_field_id_gets_one_identical_answer(self):
        stranger = Board.objects.create(name="Elsewhere", owner=self.user)
        ids = {
            "other_board": self.field(choices=["x"], board=stranger).id,
            "text": self.field(CustomFieldDefinition.FieldType.TEXT).id,
            "multi_select": self.field(CustomFieldDefinition.FieldType.MULTI_SELECT, choices=["x"]).id,
        }
        ids["nonexistent"] = max(ids.values()) + 1000
        ids = {"nonexistent": ids.pop("nonexistent"), **ids}
        for metric in GROUPED_METRICS:
            bodies = {
                name: self.bad(metric, group_by="custom_field", group_by_field_id=pk) for name, pk in ids.items()
            }
            with self.subTest(metric=metric):
                self.assertEqual(len({str(body) for body in bodies.values()}), 1, bodies)
                self.assertTrue(bodies["text"]["detail"].startswith("group_by_field_id: "))

    def test_group_by_and_field_id_must_go_together(self):
        team = self.field(choices=["x"])
        for metric in GROUPED_METRICS:
            with self.subTest(metric=metric):
                self.bad(metric, group_by_field_id=team.id)
                self.bad(metric, group_by="label", group_by_field_id=team.id)
                self.bad(metric, group_by="custom_field")
                self.bad(metric, group_by="assignee")
                self.bad(metric, group_by="custom_field", group_by_field_id=0)

    def test_grouping_keeps_the_board_permission(self):
        team = self.field(choices=["x"])
        outsider = User.objects.create_user(username="flow_group_outsider", password="pw")
        viewer = User.objects.create_user(username="flow_group_viewer", password="pw")
        BoardMembership.objects.create(board=self.board, user=viewer, role="viewer")
        params = {"group_by": "custom_field", "group_by_field_id": team.id}
        for user, status in ((outsider, 404), (viewer, 200)):
            client = APIClient()
            client.force_authenticate(user)
            for metric in GROUPED_METRICS:
                with self.subTest(user=user.username, metric=metric):
                    self.assertEqual(client.get(self.url(metric), params).status_code, status)
        for metric in GROUPED_METRICS:
            with self.subTest(anonymous=metric):
                self.assertIn(APIClient().get(self.url(metric), params).status_code, (401, 403))


class GroupedQueryCountTests(GroupingFixture):
    """Grouping adds one query (two for a custom field), flat in cards (#2265)."""

    VARIANTS = {"swimlane": 1, "label": 1, "custom_field": 2}

    def setUp(self):
        super().setUp()
        self.all_lanes = self.lanes(7)
        self.all_labels = [Label.objects.create(board=self.board, name=f"Q{i}") for i in range(7)]
        self.team = self.field(choices=[f"c{i}" for i in range(7)])
        self.seeded = 0

    def seed(self, n):
        for _ in range(n):
            for make, lane in ((self.completed, self.seeded), (self.wip, self.seeded + 3)):
                card = make(lane=self.all_lanes[lane % 7])
                card.labels.add(self.all_labels[self.seeded % 7], self.all_labels[(self.seeded + 1) % 7])
                self.value(card, self.team, f"c{self.seeded % 7}")
                self.seeded += 1

    def params(self, by):
        return {"group_by": by, **({"group_by_field_id": self.team.id} if by == "custom_field" else {})}

    def count(self, metric, **params):
        with CaptureQueriesContext(connection) as ctx:
            body = self.get(metric, **params)
        return len(ctx), body

    def test_grouped_endpoints_add_a_fixed_number_of_queries(self):
        self.seed(4)
        baseline = {}
        for metric in GROUPED_METRICS:
            plain, _ = self.count(metric)
            for by, extra in self.VARIANTS.items():
                with self.subTest(metric=metric, by=by):
                    queries, body = self.count(metric, **self.params(by))
                    # Six groups, so the "Other" path runs too.
                    self.assertEqual(len(body["grouping"]["groups"]), 6)
                    self.assertIsNone(body["grouping"]["groups"][-1]["key"])
                    self.assertEqual(queries, plain + extra)
                    baseline[metric, by] = queries
        self.seed(12)
        for metric in GROUPED_METRICS:
            for by in self.VARIANTS:
                with self.subTest(metric=metric, by=by, size="large"):
                    self.assertEqual(self.count(metric, **self.params(by))[0], baseline[metric, by])


# ── #2266: per-swimlane comparison ─────────────────────────────────────────


class SwimlaneComparisonTests(EndpointFixture):
    """``metrics/swimlanes``: numbers, 20% / 10-card boundaries, trend, blocked share, access."""

    def get(self, **params):
        resp = self.client.get(self.url("swimlanes"), params)
        self.assertEqual(resp.status_code, 200, resp.content)
        return resp.json()

    def lane_row(self, body, lane):
        return next(row for row in body["swimlanes"] if row["id"] == lane.id)

    def finish(self, lane, cycle, n=1, done_ago=5):
        """``n`` cards that finished ``done_ago`` days ago after exactly ``cycle`` days in progress."""
        return [
            self.path(self.backlog, cycle + done_ago + 10, self.doing, cycle + done_ago, self.done, done_ago, lane=lane)
            for _ in range(n)
        ]

    def anchor(self):
        """30 cards at exactly 10 days in a third lane, so the board median is 10 for lanes of up to 10 cards."""
        anchor = Swimlane.objects.create(board=self.board, name="Anchor", position=2)
        self.finish(anchor, 10, 30)
        return anchor

    def test_percentiles_match_a_manual_calculation(self):
        for cycle in (1, 2, 3, 4, 5, 6, 7):
            self.finish(self.lane, cycle)
        body = self.get()
        row = self.lane_row(body, self.lane)
        # Nearest rank: p50 = ceil(.5 * 7) = 4th value, p85 = ceil(.85 * 7) = 6th.
        self.assertEqual((row["finished"], row["median_days"], row["p85_days"]), (7, 4.0, 6.0))
        self.assertEqual(body["board"], {"finished": 7, "median_days": 4.0, "p85_days": 6.0})
        empty = self.lane_row(body, self.other_lane)
        self.assertEqual((empty["finished"], empty["median_days"], empty["status"], empty["trend"]), (0, None, None, None))

    def test_withholding_below_five_and_between_five_and_seven(self):
        self.finish(self.lane, 3, 4)
        self.finish(self.other_lane, 3, 6)
        body = self.get()
        few, some = self.lane_row(body, self.lane), self.lane_row(body, self.other_lane)
        self.assertEqual((few["median_days"], few["p85_days"], few["status"], few["trend"]), (None, None, None, None))
        self.assertEqual((some["median_days"], some["p85_days"], some["status"]), (3.0, None, None))

    def test_status_boundary_is_strictly_more_than_twenty_percent(self):
        self.anchor()
        for cycle, expected in ((13, "slower"), (12, "in_line"), (10, "in_line"), (8, "in_line"), (7, "faster")):
            with self.subTest(cycle=cycle):
                Card.objects.filter(swimlane=self.lane).delete()
                self.finish(self.lane, cycle, 10)
                body = self.get()
                self.assertEqual(body["board"]["median_days"], 10.0)
                self.assertEqual(self.lane_row(body, self.lane)["status"], expected)

    def test_status_needs_ten_finished_cards(self):
        self.anchor()
        self.finish(self.lane, 13, 9)
        row = self.lane_row(self.get(), self.lane)
        self.assertEqual((row["finished"], row["median_days"], row["status"]), (9, 13.0, None))
        self.finish(self.lane, 13)
        self.assertEqual(self.lane_row(self.get(), self.lane)["status"], "slower")

    def test_constants_are_returned(self):
        body = self.get()
        self.assertEqual((body["status_threshold_pct"], body["status_min_finished"]), (20, 10))

    def trend_for(self, first_cycle, last_cycle, n=5):
        Card.objects.filter(swimlane=self.lane).delete()
        # days=40: windows are 20 days wide, the first covers 40-20 days ago, the last 20-0.
        self.finish(self.lane, first_cycle, n, done_ago=30)
        self.finish(self.lane, last_cycle, n, done_ago=5)
        row = self.lane_row(self.get(days=40), self.lane)
        self.assertEqual(len(row["rolling_median"]), 8)
        return row["trend"]

    def test_trend_boundary_and_values(self):
        self.assertEqual(self.trend_for(10, 12), {"direction": "steady", "first_days": 10.0, "last_days": 12.0})
        self.assertEqual(self.trend_for(10, 13)["direction"], "slower")
        self.assertEqual(self.trend_for(10, 8)["direction"], "steady")
        self.assertEqual(self.trend_for(10, 7), {"direction": "faster", "first_days": 10.0, "last_days": 7.0})

    def test_trend_is_null_when_an_end_window_has_too_few_cards(self):
        self.assertIsNone(self.trend_for(10, 12, n=4))

    def test_trend_needs_five_cards_in_each_end_window_so_nine_is_null_and_ten_is_not(self):
        self.finish(self.lane, 10, 5, done_ago=30)
        self.finish(self.lane, 12, 4, done_ago=5)
        row = self.lane_row(self.get(days=40), self.lane)
        self.assertEqual(row["finished"], 9)
        self.assertIsNone(row["trend"])
        self.finish(self.lane, 12, 1, done_ago=5)
        row = self.lane_row(self.get(days=40), self.lane)
        self.assertEqual(row["finished"], 10)
        self.assertEqual(row["trend"], {"direction": "steady", "first_days": 10.0, "last_days": 12.0})

    def test_trend_stays_inside_the_period(self):
        self.finish(self.lane, 3, 5, done_ago=30)
        row = self.lane_row(self.get(days=40), self.lane)
        start = timezone.now() - datetime.timedelta(days=40)
        first = datetime.datetime.fromisoformat(row["rolling_median"][0]["at"])
        self.assertAlmostEqual((first - start).total_seconds(), 20 * 86400, delta=5)

    def test_in_progress_and_blocked_share(self):
        done = self.path(self.backlog, 30, self.doing, 20, self.done, 10, lane=self.lane)
        wip = self.path(self.backlog, 30, self.doing, 8, lane=self.lane)
        block = lambda card, begin, end: CardBlock.objects.create(  # noqa: E731
            card=card, board=self.board, reason="r", blocked_at=self.ago(begin), unblocked_at=self.ago(end),
        )
        block(done, 27, 25)  # in the backlog: neither side counts it
        block(done, 15, 12)  # 3 of the card's 10 in-progress days
        block(done, 14, 13)  # overlaps the one above: counted once
        block(done, 8, 6)    # after it finished: not counted
        # wip: 8 in-progress days, none blocked. Lane total: 3 blocked of 18.
        row = self.lane_row(self.get(), self.lane)
        self.assertEqual(row["in_progress"], 1)
        self.assertAlmostEqual(row["blocked_share"], 3 / 18, places=3)
        self.assertIsNone(self.lane_row(self.get(), self.other_lane)["blocked_share"])
        self.assertEqual(wip.swimlane_id, self.lane.id)

    def test_bad_period_values_answer_the_one_bad_parameter_shape(self):
        for params in (*BAD_RANGE_PARAMS, {"label_id": "-1"}):
            with self.subTest(params=params):
                resp = self.client.get(self.url("swimlanes"), params)
                self.assertEqual(resp.status_code, 400, resp.content)
                self.assertEqual(resp.json()["code"], "invalid_query_param")
                self.assertIsInstance(resp.json()["detail"], str)

    def test_a_label_on_another_board_is_refused_like_a_missing_one(self):
        other = Board.objects.create(name="Other", owner=self.user)
        foreign = Label.objects.create(board=other, name="Foreign")
        on_other = self.client.get(self.url("swimlanes"), {"label_id": foreign.id})
        missing = self.client.get(self.url("swimlanes"), {"label_id": 999_999})
        self.assertEqual(on_other.status_code, 400, on_other.content)
        self.assertEqual(on_other.json(), missing.json())
        self.assertEqual(on_other.json()["code"], "invalid_query_param")

    def test_a_400_matches_its_published_schema(self):
        bad = self.client.get(self.url("swimlanes"), {"days": 0})
        self.assertEqual(bad.status_code, 400)
        schema = SchemaGenerator().get_schema(request=None, public=True)
        operation = schema["paths"]["/api/v1/boards/{id}/metrics/swimlanes/"]["get"]
        fragment = operation["responses"]["400"]["content"]["application/json"]["schema"]
        jsonschema.validate(
            instance=bad.json(), schema=_openapi3_nullable_to_jsonschema({**fragment, "components": schema["components"]}),
        )

    def test_a_user_who_must_change_their_password_is_refused(self):
        self.user.must_change_password = True
        self.user.save(update_fields=["must_change_password"])
        self.assertEqual(self.client.get(self.url("swimlanes")).status_code, 403)

    def test_a_reopened_cards_time_after_the_reopen_counts_toward_blocked_share(self):
        # Pins the rule in decisions.md (#2297): blocked share counts every round
        # of work, the one after a reopen included, as age and in_progress do.
        card = self.path(self.backlog, 30, self.doing, 15, self.done, 10, self.review, 5, lane=self.lane)
        block = lambda begin, end: CardBlock.objects.create(  # noqa: E731
            card=card, board=self.board, reason="r", blocked_at=self.ago(begin), unblocked_at=self.ago(end),
        )
        block(14, 13)  # 1 of the 5 days before the first completion
        block(8, 6)    # while done, between the rounds: counts on neither side
        block(4, 2)    # 2 of the 5 days since the reopen
        row = self.lane_row(self.get(), self.lane)
        self.assertEqual(row["in_progress"], 1)
        self.assertAlmostEqual(row["blocked_share"], 3 / 10, places=3)

    def test_a_round_after_a_reopen_ends_at_the_next_completion(self):
        card = self.path(
            self.backlog, 30, self.doing, 20, self.done, 15, self.review, 10, self.done, 6, lane=self.lane,
        )
        CardBlock.objects.create(
            card=card, board=self.board, reason="r", blocked_at=self.ago(9), unblocked_at=self.ago(2),
        )
        # Rounds: 20->15 (5 days) and 10->6 (4 days). The block counts 9->6 only.
        row = self.lane_row(self.get(), self.lane)
        self.assertEqual(row["in_progress"], 0)
        self.assertAlmostEqual(row["blocked_share"], 3 / 9, places=3)

    def test_rolling_windows_of_a_date_range_ending_today_stop_at_now(self):
        today = timezone.now().date()
        body = self.get(from_date=(today - datetime.timedelta(days=39)).isoformat(), to_date=today.isoformat())
        last = datetime.datetime.fromisoformat(self.lane_row(body, self.lane)["rolling_median"][-1]["at"])
        self.assertLessEqual(last, timezone.now())
        self.assertAlmostEqual((timezone.now() - last).total_seconds(), 0, delta=60)

    def test_label_filter_applies_and_swimlane_filter_is_ignored(self):
        label = Label.objects.create(board=self.board, name="L")
        cards = self.finish(self.lane, 3, 5) + self.finish(self.other_lane, 4, 5)
        for card in cards[:5]:
            card.labels.add(label)
        body = self.get(label_id=label.id)
        self.assertEqual(self.lane_row(body, self.lane)["finished"], 5)
        self.assertEqual(self.lane_row(body, self.other_lane)["finished"], 0)
        both = self.get(swimlane_id=self.lane.id)
        self.assertEqual(len(both["swimlanes"]), 2)
        self.assertEqual(self.lane_row(both, self.other_lane)["finished"], 5)

    def test_group_lanes_by_a_swimlane_field(self):
        field = SwimlaneCustomFieldDefinition.objects.create(
            board=self.board, name="Region", position=0, field_type=CustomFieldDefinition.FieldType.DROPDOWN,
            choices_json=["EU", "US"],
        )
        SwimlaneCustomFieldValue.objects.create(swimlane=self.lane, field_definition=field, value="US")
        SwimlaneCustomFieldValue.objects.create(swimlane=self.other_lane, field_definition=field, value="gone")
        body = self.get(group_by_field_id=field.id)
        self.assertEqual(body["grouping"]["groups"], [{"key": "EU", "name": "EU"}, {"key": "US", "name": "US"}])
        self.assertEqual(self.lane_row(body, self.lane)["group"], "US")
        self.assertIsNone(self.lane_row(body, self.other_lane)["group"])
        plain = self.get()
        self.assertIsNone(plain["grouping"])
        self.assertIsNone(self.lane_row(plain, self.lane)["group"])

    def test_admin_only_field_cannot_be_grouped_by_non_admins(self):
        field = SwimlaneCustomFieldDefinition.objects.create(
            board=self.board, name="Tier", position=0, field_type=CustomFieldDefinition.FieldType.DROPDOWN,
            choices_json=["gold"], is_admin_only=True,
        )
        SwimlaneCustomFieldValue.objects.create(swimlane=self.lane, field_definition=field, value="gold")
        member = User.objects.create_user(username="flow_member3", password="pw")
        BoardMembership.objects.create(board=self.board, user=member, role="viewer")
        client = APIClient()
        client.force_authenticate(member)
        resp = client.get(self.url("swimlanes"), {"group_by_field_id": field.id})
        self.assertEqual(resp.status_code, 400)
        self.assertNotIn("gold", resp.content.decode())
        self.assertEqual(self.get(group_by_field_id=field.id)["grouping"]["field_id"], field.id)

    def test_site_admin_may_group_by_an_admin_only_field(self):
        field = SwimlaneCustomFieldDefinition.objects.create(
            board=self.board, name="Tier", position=0, field_type=CustomFieldDefinition.FieldType.DROPDOWN,
            choices_json=["gold"], is_admin_only=True,
        )
        SwimlaneCustomFieldValue.objects.create(swimlane=self.lane, field_definition=field, value="gold")
        site_admin = User.objects.create_user(
            username="flow_site_admin", password="pw", is_site_admin=True, can_access_all_content=True,
        )
        member = User.objects.create_user(username="flow_member4", password="pw")
        BoardMembership.objects.create(board=self.board, user=member, role="member")
        site_client, member_client = APIClient(), APIClient()
        site_client.force_authenticate(site_admin)
        member_client.force_authenticate(member)
        resp = site_client.get(self.url("swimlanes"), {"group_by_field_id": field.id})
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["grouping"]["field_id"], field.id)
        self.assertEqual(self.lane_row(resp.json(), self.lane)["group"], "gold")
        self.assertEqual(member_client.get(self.url("swimlanes"), {"group_by_field_id": field.id}).status_code, 400)

    def test_invalid_filters_are_400(self):
        card_field = CustomFieldDefinition.objects.create(
            board=self.board, name="Card f", position=0, field_type=CustomFieldDefinition.FieldType.DROPDOWN,
            choices_json=["a"],
        )
        other = Board.objects.create(name="Other", owner=self.user)
        foreign = SwimlaneCustomFieldDefinition.objects.create(
            board=other, name="F", position=0, field_type=CustomFieldDefinition.FieldType.DROPDOWN, choices_json=["a"],
        )
        text = SwimlaneCustomFieldDefinition.objects.create(
            board=self.board, name="T", position=0, field_type=CustomFieldDefinition.FieldType.TEXT,
        )
        for params in (
            {"label_id": 999999}, {"days": 0}, {"group_by_field_id": card_field.id},
            {"group_by_field_id": foreign.id}, {"group_by_field_id": text.id}, {"group_by_field_id": "x"},
        ):
            with self.subTest(params=params):
                self.assertEqual(self.client.get(self.url("swimlanes"), params).status_code, 400)

    def test_access_matches_cycle_time(self):
        viewer = User.objects.create_user(username="flow_viewer2", password="pw")
        BoardMembership.objects.create(board=self.board, user=viewer, role="viewer")
        client = APIClient()
        client.force_authenticate(viewer)
        self.assertEqual(client.get(self.url("swimlanes")).status_code, 200)
        outsider = APIClient()
        outsider.force_authenticate(User.objects.create_user(username="flow_out2", password="pw"))
        self.assertEqual(outsider.get(self.url("swimlanes")).status_code, 404)
        self.assertIn(APIClient().get(self.url("swimlanes")).status_code, (401, 403))
        self.assertEqual(self.client.post(self.url("swimlanes"), {}, format="json").status_code, 405)

    def count(self, **params):
        with CaptureQueriesContext(connection) as ctx:
            self.get(**params)
        return len(ctx)

    def test_query_count_is_flat_in_lanes_and_cards(self):
        field = SwimlaneCustomFieldDefinition.objects.create(
            board=self.board, name="Region", position=0, field_type=CustomFieldDefinition.FieldType.DROPDOWN,
            choices_json=["EU"],
        )

        def seed(n, start):
            for i in range(n):
                lane = Swimlane.objects.create(board=self.board, name=f"L{start + i}", position=10 + start + i)
                card = self.finish(lane, 3 + i % 4)[0]
                CardBlock.objects.create(card=card, board=self.board, reason="r", blocked_at=self.ago(8))
                SwimlaneCustomFieldValue.objects.create(swimlane=lane, field_definition=field, value="EU")

        seed(3, 0)
        plain, grouped = self.count(), self.count(group_by_field_id=field.id)
        # The field lookup in the serializer, then the values.
        self.assertEqual(grouped, plain + 2)
        seed(12, 3)
        self.assertEqual(self.count(), plain)
        self.assertEqual(self.count(group_by_field_id=field.id), grouped)

    def test_response_matches_its_published_schema(self):
        self.finish(self.lane, 3, 8)
        body = self.get()
        schema = SchemaGenerator().get_schema(request=None, public=True)
        operation = schema["paths"]["/api/v1/boards/{id}/metrics/swimlanes/"]["get"]
        fragment = operation["responses"]["200"]["content"]["application/json"]["schema"]
        jsonschema.validate(
            instance=body, schema=_openapi3_nullable_to_jsonschema({**fragment, "components": schema["components"]}),
        )
        names = {p["name"] for p in operation["parameters"] if p["in"] == "query"}
        self.assertTrue({"days", "from_date", "to_date", "label_id", "group_by_field_id"} <= names)
        self.assertNotIn("swimlane_id", names)


class AnalyticsEdgeCaseTests(FlowFixture):
    """#2297: rounding before thresholds, sort order, boundaries, p0, unions."""

    def test_p0_is_the_minimum_not_the_maximum(self):
        self.assertEqual(fm.percentile([1, 2, 3, 4, 5], 0), 1)

    def test_samples_in_one_second_sort_by_time_not_by_their_iso_strings(self):
        whole = self.path(self.backlog, 20, self.doing, 10, self.done, 2)
        half = self.path(self.backlog, 20, self.doing, 10, self.done, 2)
        instant = self.ago(2).replace(microsecond=0)
        CardMovement.objects.filter(card=whole, to_column=self.done).update(moved_at=instant)
        # As strings "...:00.500000Z" (half) sorts before "...:00Z" (whole),
        # though it is half a second later.
        CardMovement.objects.filter(card=half, to_column=self.done).update(
            moved_at=instant + datetime.timedelta(microseconds=500_000),
        )
        flow = self.flow()
        for metric in (fm.cycle_time, fm.lead_time):
            with self.subTest(metric=metric.__name__):
                self.assertEqual([s["card_uid"] for s in metric(flow, self.last())["samples"]], [whole.uid, half.uid])
        dwell = [s["card_uid"] for s in fm.completed_dwell(flow, self.last())["samples"] if s["column_uid"] == self.doing.uid]
        self.assertEqual(dwell, [whole.uid, half.uid])

    def test_a_completion_exactly_at_the_range_start_counts_and_at_its_end_does_not(self):
        at_start = self.path(self.backlog, 40, self.doing, 35, self.done, 30)
        at_end = self.path(self.backlog, 40, self.doing, 35, self.done, 0)
        uids = {s["card_uid"] for s in fm.cycle_time(self.flow(), self.last(30))["samples"]}
        self.assertIn(at_start.uid, uids)
        self.assertNotIn(at_end.uid, uids)

    def test_a_first_move_at_the_creation_instant_still_starts_the_cycle(self):
        card = self.path(self.backlog, 10, self.doing, 10, self.done, 5)
        flow = self.flow()
        self.assertEqual(self.by_card(fm.cycle_time(flow, self.last()))[card.uid]["value_days"], 5.0)
        self.assertEqual(self.by_card(fm.lead_time(flow, self.last()))[card.uid]["value_days"], 5.0)

    def test_union_seconds_counts_overlap_and_nesting_once(self):
        t = lambda d: self.ago(d)  # noqa: E731
        self.assertEqual(fm._union_seconds([(t(10), t(5)), (t(8), t(6)), (t(7), t(2))]), 8 * 86400)
        self.assertEqual(fm._union_seconds([(t(10), t(9)), (t(5), t(4))]), 2 * 86400)
        self.assertEqual(fm._union_seconds([]), 0.0)

    def test_blocked_summary_counts_a_deleted_columns_block_in_the_total_only(self):
        temp = Column.objects.create(board=self.board, name="Temp", position=9)
        card = self.path(self.backlog, 40, self.doing, 35)
        CardBlock.objects.create(
            card=card, board=self.board, column=temp, column_name=temp.name, column_uid=temp.uid,
            reason="Gone", blocked_at=self.ago(10), unblocked_at=self.ago(8),
        )
        temp.delete()
        payload = fm.blocked_summary(fm.load_live_wip(self.board, now=self.now), self.last(30))
        self.assertEqual(payload["total"], {"days": 2, "blocks": 1})
        self.assertEqual(sum(c["blocks"] for c in payload["columns"]), 0)
        self.assertEqual([(r["reason"], r["days"]) for r in payload["reasons"]], [("Gone", 2)])

    def test_one_sided_date_ranges(self):
        from boards.views.analytics import FlowMetricsQuerySerializer

        today = timezone.now().date()
        only_to = FlowMetricsQuerySerializer(data={"to_date": "2026-05-31"}, context={"board": self.board})
        self.assertTrue(only_to.is_valid(), only_to.errors)
        span = only_to.validated_data["to_date"] - only_to.validated_data["from_date"]
        self.assertEqual(span.days + 1, 90)
        only_from = FlowMetricsQuerySerializer(
            data={"from_date": (today - datetime.timedelta(days=9)).isoformat()}, context={"board": self.board},
        )
        self.assertTrue(only_from.is_valid(), only_from.errors)
        self.assertEqual(only_from.validated_data["to_date"], today)


class AnalyticsRoundingTests(FlowFixture):
    """#2297: the /analytics/ outlier flags, velocity and stalled days."""

    def setUp(self):
        super().setUp()
        self.now = timezone.now()

    analytics = HeatmapRecomputeTests.analytics

    def test_outlier_flags_compare_the_unrounded_mean(self):
        self.path(self.backlog, 20, self.doing, 6.96)
        row = self.analytics()
        self.assertEqual(row["age_avg_days_per_column"]["Doing"], 7.0)
        self.assertFalse(row["age_is_outlier"]["Doing"])
        self.path(self.backlog, 20, self.doing, 7.2)
        self.assertTrue(self.analytics()["age_is_outlier"]["Doing"])

    def warning_cells(self, mode, cases, **board_fields):
        """One lane and one card per case, so each cell's mean is that card's dwell."""
        Board.objects.filter(pk=self.board.pk).update(**board_fields)
        lanes = {}
        for label, steps in cases.items():
            position = Swimlane.objects.filter(board=self.board).count()
            lanes[label] = Swimlane.objects.create(board=self.board, name=f"{label} {position}", position=position)
            self.path(*steps, lane=lanes[label])
        client = APIClient()
        client.force_authenticate(self.user)
        resp = client.get(f"/api/v1/boards/{self.board.pk}/analytics/")
        self.assertEqual(resp.status_code, 200)
        rows = {s["id"]: s for s in resp.json()["swimlanes"]}
        return {
            label: (
                rows[lane.id][f"{mode}_avg_days_per_column"]["Doing"],
                rows[lane.id][f"{mode}_is_warning"]["Doing"],
                rows[lane.id][f"{mode}_is_outlier"]["Doing"],
            )
            for label, lane in lanes.items()
        }

    def test_warning_flag_compares_the_unrounded_mean_at_the_boundary(self):
        # Threshold 14 at 50% puts the yellow boundary at exactly 7 days (#2306).
        # Completed visits have fixed ends, so "at" is exactly 7.0, not 7.0 + drift.
        cells = self.warning_cells("throughput", {
            "under": (self.backlog, 30, self.doing, 16.96, self.done, 10),
            "at": (self.backlog, 30, self.doing, 17, self.done, 10),
            "over": (self.backlog, 30, self.doing, 17.2, self.done, 10),
            "stale": (self.backlog, 30, self.doing, 25, self.done, 10),
        }, staleness_threshold_days=14, stale_warning_pct=50)
        # 6.96 is served as 7.0, yet it never reached the boundary.
        self.assertEqual(cells["under"], (7.0, False, False))
        self.assertEqual(cells["at"], (7.0, True, False))
        self.assertEqual(cells["over"], (7.2, True, False))
        # At or over the threshold the cell is an outlier, never also a warning.
        self.assertEqual(cells["stale"], (15.0, False, True))

    def test_warning_flag_is_true_when_only_the_unrounded_mean_reaches_the_boundary(self):
        # Threshold 7 at 33% puts the boundary at 2.31; a raw 2.32 is served as 2.3,
        # which alone would read green (#2306).
        cells = self.warning_cells("age", {
            "raw": (self.backlog, 30, self.doing, 2.32),
        }, staleness_threshold_days=7, stale_warning_pct=33)
        self.assertEqual(cells["raw"], (2.3, True, False))

    def test_warning_flag_at_threshold_0_uses_the_one_day_floor(self):
        # Every cell is an outlier at threshold 0 (mean >= 0), yet the ratio divides
        # by max(1, 0): 0.6 days is in the 50% band, 0.3 is under it (#2306).
        cells = self.warning_cells("age", {
            "low": (self.backlog, 30, self.doing, 0.3),
            "mid": (self.backlog, 30, self.doing, 0.6),
        }, staleness_threshold_days=0, stale_warning_pct=50)
        self.assertEqual(cells["low"], (0.3, False, True))
        self.assertEqual(cells["mid"], (0.6, True, True))

    def heat_levels(self, mode, cases, **board_fields):
        """``{label: heat level}`` for one lane per case (#2331)."""
        Board.objects.filter(pk=self.board.pk).update(**board_fields)
        lanes = {}
        for label, steps in cases.items():
            position = Swimlane.objects.filter(board=self.board).count()
            lanes[label] = Swimlane.objects.create(board=self.board, name=f"{label} {position}", position=position)
            self.path(*steps, lane=lanes[label])
        client = APIClient()
        client.force_authenticate(self.user)
        rows = {s["id"]: s for s in client.get(f"/api/v1/boards/{self.board.pk}/analytics/").json()["swimlanes"]}
        return {label: rows[lane.id][f"{mode}_heat_level"]["Doing"] for label, lane in lanes.items()}

    def test_heat_level_at_threshold_0_applies_the_one_day_floor_to_red(self):
        # #2331: at threshold 0 every cell is an outlier (mean >= 0), and a raw
        # 0.96 is served as 1.0, so neither alone can say green. The served tier
        # compares the unrounded mean with max(1, 0) days.
        cells = self.heat_levels("age", {
            "under": (self.backlog, 30, self.doing, 0.96),
            "at": (self.backlog, 30, self.doing, 1.2),
        }, staleness_threshold_days=0, stale_warning_pct=0)
        self.assertEqual(cells, {"under": "ok", "at": "high"})

    def test_heat_level_at_threshold_0_keeps_the_warning_band(self):
        cells = self.heat_levels("throughput", {
            "ok": (self.backlog, 30, self.doing, 10.3, self.done, 10),
            "warning": (self.backlog, 30, self.doing, 10.96, self.done, 10),
            "high": (self.backlog, 30, self.doing, 11, self.done, 10),
        }, staleness_threshold_days=0, stale_warning_pct=50)
        self.assertEqual(cells, {"ok": "ok", "warning": "warning", "high": "high"})

    def test_heat_level_matches_the_flags_from_threshold_1_up(self):
        cells = self.heat_levels("throughput", {
            "under": (self.backlog, 30, self.doing, 16.96, self.done, 10),
            "at": (self.backlog, 30, self.doing, 17, self.done, 10),
            "stale": (self.backlog, 30, self.doing, 24, self.done, 10),
        }, staleness_threshold_days=14, stale_warning_pct=50)
        self.assertEqual(cells, {"under": "ok", "at": "warning", "stale": "high"})

    def test_age_warning_flag_uses_the_unrounded_current_dwell(self):
        cells = self.warning_cells("age", {
            "under": (self.backlog, 30, self.doing, 6.96),
            "over": (self.backlog, 30, self.doing, 7.2),
        }, staleness_threshold_days=14, stale_warning_pct=50)
        self.assertEqual(cells["under"], (7.0, False, False))
        self.assertEqual(cells["over"], (7.2, True, False))

    def test_warning_flag_is_off_at_0_and_empty_at_100(self):
        steps = {"high": (self.backlog, 30, self.doing, 23, self.done, 10)}
        self.assertEqual(
            self.warning_cells("throughput", steps, staleness_threshold_days=14, stale_warning_pct=0)["high"],
            (13.0, False, False),
        )
        self.assertEqual(
            self.warning_cells("throughput", steps, staleness_threshold_days=14, stale_warning_pct=100)["high"],
            (13.0, False, False),
        )

    def test_deal_velocity_leaves_out_cards_that_were_only_created(self):
        self.path(self.backlog, 3)
        self.path(self.backlog, 10, self.doing, 4)
        self.assertAlmostEqual(self.analytics()["deal_velocity_days"], 6.0, delta=0.1)

    def test_deal_velocity_counts_a_move_out_of_a_since_deleted_column(self):
        # CardMovement.from_column is SET_NULL, so the move's from_column_id
        # goes NULL with the column; it is still a real move (#2297).
        temp = Column.objects.create(board=self.board, name="Temp", position=9)
        self.path(temp, 10, self.doing, 4)
        temp.delete()
        self.assertAlmostEqual(self.analytics()["deal_velocity_days"], 6.0, delta=0.1)

    def test_stalled_cards_carry_unfloored_days(self):
        card = self.path(self.backlog, 20, self.doing, 7.9)
        stalled = next(s for s in self.analytics()["stalled_cards"] if s["id"] == card.id)
        self.assertEqual(stalled["days_since_move"], 7)
        self.assertEqual(stalled["days_since_move_exact"], 7.9)

    def plan_child(self, card, *, released_days_ago=None):
        parent = self.card(self.doing, created=1, title="Parent")
        CardParentLink.objects.create(
            parent=parent, child=card, needed_at_column=self.doing,
            planned_released_at=self.ago(released_days_ago) if released_days_ago is not None else None,
        )

    def test_a_planned_child_is_not_a_stalled_card(self):
        """#2554: the heatmap's stalled list shares Needs attention's planned rule."""
        planned = self.path(self.backlog, 40)
        twin = self.path(self.backlog, 40)
        self.plan_child(planned)
        ids = {s["id"] for s in self.analytics()["stalled_cards"]}
        self.assertNotIn(planned.id, ids)
        self.assertIn(twin.id, ids)

    def test_a_released_child_is_stalled_from_its_release(self):
        recent = self.path(self.backlog, 40)
        self.plan_child(recent, released_days_ago=1)
        old = self.path(self.backlog, 40)
        self.plan_child(old, released_days_ago=20)
        stalled = {s["id"]: s for s in self.analytics()["stalled_cards"]}
        self.assertNotIn(recent.id, stalled)
        self.assertEqual(stalled[old.id]["days_since_move"], 20)

    def test_needs_attention_endpoint_leaves_out_a_planned_child(self):
        """#2554 through REST: the view's attention list, not only the service."""
        planned = self.path(self.backlog, 40)
        twin = self.path(self.backlog, 40)
        self.plan_child(planned)
        client = APIClient()
        client.force_authenticate(self.user)
        resp = client.get(f"/api/v1/boards/{self.board.pk}/metrics/attention/")
        self.assertEqual(resp.status_code, 200, resp.content)
        uids = {i["card_uid"] for i in resp.json()["items"]}
        self.assertNotIn(planned.uid, uids)
        self.assertIn(twin.uid, uids)


class GroupingEdgeCaseTests(GroupingFixture):
    """#2297: the overlapping flag, checkbox groups, empty groups, per-group sizes."""

    def test_overlapping_is_true_only_when_a_card_is_in_two_groups(self):
        red, blue = Label.objects.create(board=self.board, name="red"), Label.objects.create(board=self.board, name="blue")
        self.wip().labels.add(red)
        self.wip().labels.add(blue)
        for metric in GROUPED_METRICS:
            with self.subTest(metric=metric, case="disjoint"):
                self.assertIs(self.get(metric, group_by="label")["grouping"]["overlapping"], False)
        self.wip().labels.add(red, blue)
        self.completed().labels.add(red, blue)
        for metric in GROUPED_METRICS:
            with self.subTest(metric=metric, case="shared"):
                self.assertIs(self.get(metric, group_by="label")["grouping"]["overlapping"], True)
                self.assertIs(self.get(metric, group_by="swimlane")["grouping"]["overlapping"], False)

    def test_overlapping_ignores_cards_that_finished_before_the_range(self):
        red, blue = Label.objects.create(board=self.board, name="red"), Label.objects.create(board=self.board, name="blue")
        self.wip().labels.add(red)
        old = self.path(self.backlog, 210, self.doing, 205, self.done, 200)
        old.labels.add(red, blue)
        for metric in GROUPED_METRICS:
            with self.subTest(metric=metric):
                body = self.get(metric, group_by="label", days=30)
                self.assertIs(body["grouping"]["overlapping"], False)

    def test_checkbox_groups_and_per_group_sample_sizes(self):
        flag = self.field(field_type=CustomFieldDefinition.FieldType.CHECKBOX)
        for _ in range(2):
            self.value(self.wip(), flag, "true")
        self.value(self.wip(), flag, "false")
        self.wip()
        grouping = self.get("wip-age", group_by="custom_field", group_by_field_id=flag.id)["grouping"]
        self.assertEqual(
            [(g["key"], g["name"], g["sample_size"]) for g in grouping["groups"]], [("true", None, 2), ("false", None, 1)],
        )
        self.assertEqual(grouping["excluded"], 1)

    def test_a_group_with_no_active_card_is_left_out(self):
        idle = self.lanes(3)[2]
        self.path(self.backlog, 5, lane=idle)  # never started: active on no endpoint
        self.wip(lane=self.lane)
        keys = [g["key"] for g in self.get("cycle-time", group_by="swimlane")["grouping"]["groups"]]
        self.assertEqual(keys, [str(self.lane.id)])
