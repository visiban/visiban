"""The range loader's movement term stays uncorrelated and bounded to the board (#2502).

#2425 narrowed every range metric with ``flow_metrics.can_affect_range``, whose
movement term was a correlated ``EXISTS (... card_id = cards.id ...)`` inside an
``OR``. PostgreSQL cannot make that a semi-join, and with it in the filter the
planner read the movements by walking every board's rows in
``card_movements_card_id`` (151,674 rows read to return 24,919 on the nightly
fixture), so wip-age p95 went 364 -> 531 ms on a board the narrowing could not
prune at all. The query count never changed, so a query-count test could not see
it; these tests pin the statement shape instead, plus the cards it keeps.
``load_recent_dwell`` had the same shape and is pinned the same way (#2506).
"""
import re

from django.db import connection
from django.db.models import Exists, OuterRef, Q
from django.test.utils import CaptureQueriesContext

from boards.models import Board, Card, CardMovement, Column, Swimlane
from boards.services import flow_metrics as fm
from boards.tests.test_flow_metrics import FlowFixture

_CORRELATED_MOVEMENTS = re.compile(r'EXISTS\s*\(\s*SELECT[^()]*FROM\s+"card_movements"', re.IGNORECASE)
# The correlation itself, however the subquery is phrased (EXISTS, IN, a scalar):
# a card_movements alias compared to the outer cards row.
_OUTER_CARD_REF = re.compile(r'U\d+\."card_id"\s*=\s*\(?"cards"\."id"\)?')


def _range_cards(case):
    """Shared by both shape suites, on a ``FlowFixture``."""
    case.flow_range = fm.rolling_range(30, now=case.now)
    # Live, archived inside the range, created inside it, archived long ago
    # with a recent movement (only the movement term keeps it), and finished
    # work the range load skips.
    case.live = case.path(case.backlog, 60, case.doing, 40)
    case.recent_archive = case.path(case.backlog, 60, case.done, 20, archived=10)
    case.recent_create = case.path(case.backlog, 5, case.done, 3, archived=2)
    case.late_row = case.path(case.backlog, 300, case.done, 200, archived=150)
    case.row(case.late_row, case.done, case.done, 4)
    case.old = case.path(case.backlog, 300, case.done, 200, archived=150)


def _old_dwell_rule_ids(board, flow_range):
    """The pre-#2506 correlated predicate, kept here only as the reference set."""
    moved = CardMovement.objects.filter(
        card=OuterRef("pk"), moved_at__gte=flow_range.start, moved_at__lte=flow_range.end,
    )
    rule = (
        (Q(archived_at__isnull=True) & ~Q(column__is_done=True))
        | Q(archived_at__gte=flow_range.start)
        | Exists(moved)
    )
    return set(Card.objects.filter(board=board).filter(rule).values_list("pk", flat=True))


class RangeLoadPlanShapeTests(FlowFixture):
    def setUp(self):
        super().setUp()
        _range_cards(self)

    def range_queries(self, loader=fm.load_range_flow):
        with CaptureQueriesContext(connection) as ctx:
            flow = loader(self.board, self.flow_range, now=self.now)
        return flow, [q["sql"] for q in ctx.captured_queries]

    def test_no_range_load_statement_correlates_card_movements_to_the_card(self):
        """The #2502 shape: a correlated EXISTS over card_movements in any statement fails here."""
        def day_loader(board, flow_range, *, now):
            # The drill-down reads one day; the plan shape rule is the same (#2444).
            return fm.load_cumulative_day(board, flow_range.last_day, now=now)

        day_loader.__name__ = "load_cumulative_day"
        for loader in (fm.load_range_flow, fm.load_cumulative_flow, day_loader):
            _, statements = self.range_queries(loader)
            movement_terms = [sql for sql in statements if 'FROM "cards"' in sql and '"card_movements"' in sql]
            with self.subTest(loader=loader.__name__):
                self.assertTrue(movement_terms, "the range predicate should read card_movements in a subquery")
                for sql in statements:
                    self.assertIsNone(_CORRELATED_MOVEMENTS.search(sql), sql)
                    self.assertIsNone(_OUTER_CARD_REF.search(sql), sql)

    def test_the_movement_subquery_reads_only_this_boards_cards(self):
        """Uncorrelated, so it must carry its own board bound, or it would read every board's movements."""
        _, statements = self.range_queries()
        # The card rows statement itself (the movement and gate reads embed it too).
        cards_statement = next(sql for sql in statements if sql.lstrip().startswith('SELECT "cards"."id"'))
        subquery = cards_statement[cards_statement.index('"card_movements"'):]
        self.assertRegex(subquery, r'INNER JOIN "cards" (U\d+ )?ON')
        self.assertRegex(subquery, rf'"board_id" = {self.board.pk}\b')

    def test_keeps_exactly_the_cards_the_rule_names(self):
        flow, _ = self.range_queries()
        self.assertEqual(
            {card.id for card in flow.cards},
            {self.live.pk, self.recent_archive.pk, self.recent_create.pk, self.late_row.pk},
        )
        self.assertEqual(fm.age(flow, self.flow_range), fm.age(self.flow(), self.flow_range))

    def test_another_boards_recent_movement_keeps_none_of_this_boards_old_cards(self):
        """The bound is the card's board: a recent movement elsewhere pulls in nothing here."""
        other = Board.objects.create(name="Other", owner=self.user)
        other_done = Column.objects.create(board=other, name="Done", position=0, is_done=True)
        other_lane = Swimlane.objects.create(board=other, name="L", position=0)
        stranger = Card.objects.create(
            board=other, column=other_done, swimlane=other_lane, title="x", created_by=self.user, position=0,
        )
        Card.objects.filter(pk=stranger.pk).update(created_at=self.ago(300), archived_at=self.ago(150))
        stranger.refresh_from_db()
        self.row(stranger, None, other_done, 1)
        flow, _ = self.range_queries()
        ids = {card.id for card in flow.cards}
        self.assertNotIn(stranger.pk, ids)
        self.assertNotIn(self.old.pk, ids)


class RecentDwellPlanShapeTests(FlowFixture):
    """#2506: ``load_recent_dwell`` (analytics, the MCP aging tool) had the
    same correlated ``EXISTS`` in an ``OR``. The rewrite to an uncorrelated,
    board-bounded ``IN`` keeps the same cards; these tests guard the shape and
    the card set. ``RecentDwellNarrowedMovementTests`` below guards the
    #2567 narrowing of that ``IN`` to the cards the other terms skip."""

    def setUp(self):
        super().setUp()
        # The same cards as the range tests: one only the movement term keeps.
        _range_cards(self)

    def dwell_queries(self, **kwargs):
        columns = list(self.board.columns.all())
        with CaptureQueriesContext(connection) as ctx:
            flow = fm.load_recent_dwell(self.board, self.flow_range, columns=columns, **kwargs)
        return flow, [q["sql"] for q in ctx.captured_queries]

    def _old_rule_ids(self):
        return _old_dwell_rule_ids(self.board, self.flow_range)

    def test_no_dwell_load_statement_correlates_card_movements_to_the_card(self):
        for kwargs in ({}, {"also_matching": Q(pk=self.old.pk)}):
            _, statements = self.dwell_queries(**kwargs)
            with self.subTest(**{k: True for k in kwargs}):
                self.assertTrue([sql for sql in statements if 'FROM "cards"' in sql and '"card_movements"' in sql])
                for sql in statements:
                    self.assertIsNone(_CORRELATED_MOVEMENTS.search(sql), sql)
                    self.assertIsNone(_OUTER_CARD_REF.search(sql), sql)

    def test_the_dwell_movement_subquery_reads_only_this_boards_cards(self):
        _, statements = self.dwell_queries()
        cards_statement = next(sql for sql in statements if sql.lstrip().startswith('SELECT "cards"."id"'))
        subquery = cards_statement[cards_statement.index('"card_movements"'):]
        self.assertRegex(subquery, r'INNER JOIN "cards" (U\d+ )?ON')
        self.assertRegex(subquery, rf'"board_id" = {self.board.pk}\b')

    def test_dwell_keeps_exactly_the_cards_the_old_correlated_rule_kept(self):
        # An archived-long-ago card with a movement in the range: only the movement term keeps it.
        self.assertIn(self.late_row.pk, self._old_rule_ids())
        flow, _ = self.dwell_queries()
        self.assertEqual({card.id for card in flow.cards}, self._old_rule_ids())
        self.assertNotIn(self.old.pk, {card.id for card in flow.cards})

    def test_dwell_with_also_matching_keeps_the_old_rules_cards_plus_the_extra_ones(self):
        # The union path: the extra Q is OR-ed onto the movement rule. The old
        # card matches neither the archive nor the movement term, so only
        # also_matching can bring it in; every other card must be unchanged.
        extra = Q(pk=self.old.pk)
        flow, _ = self.dwell_queries(also_matching=extra)
        expected = self._old_rule_ids() | {self.old.pk}
        self.assertEqual({card.id for card in flow.cards}, expected)
        self.assertIn(self.late_row.pk, {card.id for card in flow.cards})

    def test_dwell_card_set_is_unchanged_by_another_boards_recent_movement(self):
        # Proves only the card set: the outer ``board`` filter already excludes
        # the stranger, so this passes even without the subquery's
        # ``card__board`` bound (verified by removing it). That bound is
        # guarded by ``test_the_dwell_movement_subquery_reads_only_this_boards_cards``.
        other = Board.objects.create(name="Other", owner=self.user)
        other_done = Column.objects.create(board=other, name="Done", position=0, is_done=True)
        other_lane = Swimlane.objects.create(board=other, name="L", position=0)
        stranger = Card.objects.create(
            board=other, column=other_done, swimlane=other_lane, title="x", created_by=self.user, position=0,
        )
        Card.objects.filter(pk=stranger.pk).update(created_at=self.ago(300), archived_at=self.ago(150))
        stranger.refresh_from_db()
        self.row(stranger, None, other_done, 1)
        flow, _ = self.dwell_queries()
        self.assertEqual({card.id for card in flow.cards}, self._old_rule_ids())


class RecentDwellNarrowedMovementTests(FlowFixture):
    """#2567: the dwell movement term reads only the cards the other terms skip.

    The #2506 ``IN`` was bounded only by ``card__board``, so on the load-test
    board the planner read every board's movements in the range from
    ``card_movements_moved_at``. It now names only this board's cards archived
    before the range or live in a done column, the exact complement of the
    other two terms, so the kept set cannot change: these tests pin it against
    the old correlated rule with other boards' movements in the range, plus
    the narrowing itself.
    """

    def setUp(self):
        super().setUp()
        _range_cards(self)
        # Live in a done column: kept only by a movement in the range.
        self.done_recent = self.path(self.backlog, 60, self.done, 10)
        self.released_recent = self.path(self.doing, 40, self.released, 5)
        self.done_old = self.path(self.backlog, 90, self.done, 50)
        # Another board whose cards all moved inside the range, each one a
        # shape the movement term would keep on this board.
        other = Board.objects.create(name="Other", owner=self.user)
        other_doing = Column.objects.create(board=other, name="Doing", position=0)
        other_done = Column.objects.create(board=other, name="Done", position=1, is_done=True)
        other_lane = Swimlane.objects.create(board=other, name="L", position=0)
        self.strangers = []
        for column, archived in ((other_done, None), (other_done, 150), (other_doing, None)):
            stranger = Card.objects.create(
                board=other, column=column, swimlane=other_lane, title="x", created_by=self.user, position=0,
            )
            Card.objects.filter(pk=stranger.pk).update(
                created_at=self.ago(300), archived_at=self.ago(archived) if archived else None,
            )
            stranger.refresh_from_db()
            self.row(stranger, None, column, 3)
            self.strangers.append(stranger.pk)

    def dwell(self, **kwargs):
        columns = list(self.board.columns.order_by("position"))
        with CaptureQueriesContext(connection) as ctx:
            flow = fm.load_recent_dwell(self.board, self.flow_range, columns=columns, **kwargs)
        return {card.id for card in flow.cards}, [q["sql"] for q in ctx.captured_queries]

    def movement_subquery(self, statements):
        cards_statement = next(sql for sql in statements if sql.lstrip().startswith('SELECT "cards"."id"'))
        return cards_statement[cards_statement.index('"card_movements"'):]

    def test_keeps_exactly_the_old_rules_cards_with_other_boards_moving_in_range(self):
        expected = _old_dwell_rule_ids(self.board, self.flow_range)
        # Not vacuous: only the movement term keeps these three.
        self.assertTrue({self.late_row.pk, self.done_recent.pk, self.released_recent.pk} <= expected)
        self.assertNotIn(self.done_old.pk, expected)
        kept, _ = self.dwell()
        self.assertEqual(kept, expected)
        self.assertFalse(kept & set(self.strangers))

    def test_also_matching_keeps_the_old_rules_cards_plus_the_extra_ones(self):
        kept, _ = self.dwell(also_matching=Q(pk=self.done_old.pk))
        self.assertEqual(kept, _old_dwell_rule_ids(self.board, self.flow_range) | {self.done_old.pk})

    def test_the_movement_subquery_names_only_the_cards_the_other_terms_skip(self):
        _, statements = self.dwell()
        subquery = self.movement_subquery(statements)
        self.assertRegex(subquery, rf'"board_id" = {self.board.pk}\b')
        self.assertRegex(subquery, r'"archived_at" < ')
        # The ids come from a set, so their order inside IN (...) is not defined.
        in_match = re.search(r'"column_id" IN \(([^)]*)\)', subquery)
        self.assertIsNotNone(in_match, subquery)
        named = [int(x) for x in in_match.group(1).split(",")]
        self.assertEqual(len(named), 2, subquery)
        self.assertEqual(set(named), {self.done.pk, self.released.pk}, subquery)
        for sql in statements:
            self.assertIsNone(_OUTER_CARD_REF.search(sql), sql)

    def test_a_board_without_done_columns_narrows_to_archived_cards_only(self):
        # The live-in-done branch has no column to name. Every live card is
        # then kept by the first term, so the old rule's set still holds.
        Column.objects.filter(board=self.board).update(is_done=False)
        kept, statements = self.dwell()
        self.assertEqual(kept, _old_dwell_rule_ids(self.board, self.flow_range))
        self.assertIn(self.late_row.pk, kept)
        subquery = self.movement_subquery(statements)
        self.assertRegex(subquery, r'"archived_at" < ')
        self.assertNotRegex(subquery, r'"column_id" IN')


def _old_heatmap_extra(board, buffer_cutoff):
    """origin/main's heatmap ``also_matching`` term before #2579, as the reference."""
    return Q(archived_at__isnull=True) & Q(pk__in=CardMovement.objects.filter(
        card__board=board, card__archived_at__isnull=True, moved_at__gte=buffer_cutoff,
    ).values("card_id"))


class _BoardScopedFixture(FlowFixture):
    """Archived history, a legacy NULL-board row and done work (#2579, #2630)."""

    def setUp(self):
        super().setUp()
        _range_cards(self)
        self.flow_range = fm.rolling_range(30, now=self.now)
        # Archived generations: finished work quarters back, none in the range.
        self.generations = [
            self.path(self.backlog, 100 + g * 90, self.doing, 95 + g * 90, self.done, 90 + g * 90,
                      archived=85 + g * 90)
            for g in range(4)
        ]
        # Archived before the range, moved inside it by a row written before
        # migration 0080 (board NULL): only the NULL arm keeps it.
        self.legacy = self.path(self.backlog, 400, self.done, 300, archived=200)
        legacy_row = self.row(self.legacy, self.done, self.done, 6)
        CardMovement.objects.filter(pk=legacy_row.pk).update(board=None)
        self.done_recent = self.path(self.backlog, 60, self.done, 10)
        self.done_old = self.path(self.backlog, 90, self.done, 50)

    def columns(self):
        return list(self.board.columns.order_by("position"))

    def answers(self, flow):
        r = self.flow_range
        return (
            fm.current_dwell_by_swimlane(flow), fm.completed_dwell_by_swimlane(flow, r),
            fm.current_wait_by_swimlane(flow), fm.completed_wait_by_swimlane(flow, r),
            fm.blocked_time(flow, r), flow.gate_last,
        )

class RecentDwellBoardScopedMovementTests(_BoardScopedFixture):
    """#2579: the dwell movement term (and the heatmap's) also reads the movement's own board.

    On the aged nightly board the #2567 term still drove from the instance-wide
    ``card_movements_moved_at`` range scan. ``movements_on_board`` gives the
    planner the index-only ``movement_board_moved_card_idx`` path; it is
    redundant with ``card__board``, so the answers must not move. Pinned on a
    board with archived history (generations of finished work, one archived
    card that moved in the range, and a legacy row whose ``board`` is NULL)
    against the unnarrowed whole-board load.
    """

    def test_dwell_answers_match_the_whole_board_load(self):
        with CaptureQueriesContext(connection) as ctx:
            flow = fm.load_recent_dwell(self.board, self.flow_range, columns=self.columns())
        kept = {card.id for card in flow.cards}
        self.assertEqual(kept, _old_dwell_rule_ids(self.board, self.flow_range))
        self.assertIn(self.legacy.pk, kept)
        self.assertIn(self.late_row.pk, kept)
        self.assertFalse(kept & {c.pk for c in self.generations})
        whole = fm.load_board_flow(self.board, now=self.flow_range.end, columns=self.columns())
        self.assertEqual(self.answers(flow), self.answers(whole))
        cards_statement = next(
            q["sql"] for q in ctx.captured_queries if q["sql"].lstrip().startswith('SELECT "cards"."id"')
        )
        subquery = cards_statement[cards_statement.index('"card_movements"'):]
        # The movement's own board, not only the joined card's, in two UNION
        # arms: this board's rows and the legacy rows with no board.
        self.assertRegex(subquery, r'\bUNION\b')
        self.assertRegex(subquery, rf'U\d+\."board_id" = {self.board.pk}\b')
        self.assertRegex(subquery, r'U\d+\."board_id" IS NULL')

    def test_heatmap_extra_term_loads_the_same_cards(self):
        from boards.views.analytics import _heatmap_extra_term

        columns = self.columns()
        done_ids = {c.id for c in columns if c.is_done}
        buffer_cutoff = self.flow_range.start - (self.flow_range.end - self.flow_range.start)
        for label, done in (("done columns", done_ids), ("no done column", set())):
            with self.subTest(label):
                if not done:
                    Column.objects.filter(board=self.board).update(is_done=False)
                    columns = self.columns()
                old = fm.load_recent_dwell(
                    self.board, self.flow_range, columns=columns,
                    also_matching=_old_heatmap_extra(self.board, buffer_cutoff),
                )
                new = fm.load_recent_dwell(
                    self.board, self.flow_range, columns=columns,
                    also_matching=_heatmap_extra_term(self.board, buffer_cutoff, done),
                )
                self.assertEqual({c.id for c in new.cards}, {c.id for c in old.cards})
                self.assertEqual(self.answers(new), self.answers(old))
        self.assertIn(self.done_recent.pk, {c.id for c in old.cards})


def _old_range_rule(board, boundary):
    """``can_affect_range`` before #2630 (``card__board`` only), kept here as the reference."""
    moved = CardMovement.objects.filter(
        card__board=board, card__archived_at__lt=boundary, card__created_at__lt=boundary,
        moved_at__gte=boundary,
    ).values("card_id")
    return Q(archived_at__isnull=True) | Q(archived_at__gte=boundary) | Q(created_at__gte=boundary) | Q(pk__in=moved)


class RangeLoadBoardScopedMovementTests(_BoardScopedFixture):
    """#2630: ``can_affect_range`` reads movements through ``movements_on_board`` as well.

    Bounded only by ``card__board``, its movement term was served on the aged
    nightly board by an index read with only ``moved_at`` in the condition:
    every board's movements in the range (14,714 rows at 30 days, 50,248 at
    90). The movement's own ``board`` column makes it an index-only read of
    this board's slice. It is redundant with ``card__board``, so the kept set
    and every answer must stay what the old rule gave, including a legacy
    NULL-board row that only the second ``UNION`` arm keeps. Same fixture as
    the dwell suite: archived generations, a NULL-board row, done work.
    """

    def test_range_load_keeps_the_old_rules_cards_and_answers(self):
        boundary = fm.range_boundary(self.flow_range, self.now)
        reference = set(
            Card.objects.filter(board=self.board).filter(_old_range_rule(self.board, boundary))
            .values_list("pk", flat=True)
        )
        with CaptureQueriesContext(connection) as ctx:
            flow = fm.load_range_flow(self.board, self.flow_range, now=self.now, columns=self.columns())
        kept = {card.id for card in flow.cards}
        self.assertEqual(kept, reference)
        self.assertIn(self.legacy.pk, kept)
        self.assertIn(self.late_row.pk, kept)
        self.assertFalse(kept & {c.pk for c in self.generations})
        whole = fm.load_board_flow(self.board, now=self.now, columns=self.columns())
        r = self.flow_range
        for name, metric in (
            ("cycle_time", lambda f: fm.cycle_time(f, r)),
            ("age", lambda f: fm.age(f, r)),
            ("throughput", lambda f: fm.throughput(f, r, period="day")),
        ):
            with self.subTest(name):
                self.assertEqual(metric(flow), metric(whole))
        cards_statement = next(
            q["sql"] for q in ctx.captured_queries if q["sql"].lstrip().startswith('SELECT "cards"."id"')
        )
        subquery = cards_statement[cards_statement.index('"card_movements"'):]
        self.assertRegex(subquery, r'\bUNION\b')
        self.assertRegex(subquery, rf'U\d+\."board_id" = {self.board.pk}\b')
        self.assertRegex(subquery, r'U\d+\."board_id" IS NULL')

    def test_cumulative_flow_settled_cards_are_unchanged(self):
        """``load_cumulative_flow`` excludes the same predicate; the settled bands must not move."""
        flow = fm.load_cumulative_flow(self.board, self.flow_range, now=self.now, columns=self.columns())
        whole = fm.load_board_flow(self.board, now=self.now, columns=self.columns())
        self.assertEqual(fm.cumulative_flow(flow, self.flow_range), fm.cumulative_flow(whole, self.flow_range))
        boundary = fm.range_boundary(self.flow_range, self.now)
        settled = set(
            Card.objects.filter(board=self.board).exclude(_old_range_rule(self.board, boundary))
            .values_list("pk", flat=True)
        )
        self.assertEqual(sum(flow.settled_placements.values()), len(settled))
