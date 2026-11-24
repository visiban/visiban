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
    """#2506: ``load_recent_dwell`` (summary/analytics, the MCP analytics tool) had
    the same correlated ``EXISTS`` in an ``OR``. On a two-board PostgreSQL 17
    fixture its history read went from 19,273 buffers (a merge semi join over
    the whole ``card_movements_card_id`` index, every board's cards scanned in
    ``cards_pkey``) to 2,111, keeping the same cards."""

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
        """The pre-#2506 correlated predicate, kept here only as the reference set."""
        moved = CardMovement.objects.filter(
            card=OuterRef("pk"), moved_at__gte=self.flow_range.start, moved_at__lte=self.flow_range.end,
        )
        rule = (
            (Q(archived_at__isnull=True) & ~Q(column__is_done=True))
            | Q(archived_at__gte=self.flow_range.start)
            | Exists(moved)
        )
        return set(Card.objects.filter(board=self.board).filter(rule).values_list("pk", flat=True))

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

    def test_dwell_ignores_another_boards_recent_movement(self):
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
