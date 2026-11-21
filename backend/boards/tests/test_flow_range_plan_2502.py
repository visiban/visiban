"""The range loader's movement term stays uncorrelated and bounded to the board (#2502).

#2425 narrowed every range metric with ``flow_metrics.can_affect_range``, whose
movement term was a correlated ``EXISTS (... card_id = cards.id ...)`` inside an
``OR``. PostgreSQL cannot make that a semi-join, and with it in the filter the
planner read the movements by walking every board's rows in
``card_movements_card_id`` (151,674 rows read to return 24,919 on the nightly
fixture), so wip-age p95 went 364 -> 531 ms on a board the narrowing could not
prune at all. The query count never changed, so a query-count test could not see
it; these tests pin the statement shape instead, plus the cards it keeps.
"""
import re

from django.db import connection
from django.test.utils import CaptureQueriesContext

from boards.models import Board, Card, Column, Swimlane
from boards.services import flow_metrics as fm
from boards.tests.test_flow_metrics import FlowFixture

_CORRELATED_MOVEMENTS = re.compile(r'EXISTS\s*\(\s*SELECT[^()]*FROM\s+"card_movements"', re.IGNORECASE)
# The correlation itself, however the subquery is phrased (EXISTS, IN, a scalar):
# a card_movements alias compared to the outer cards row.
_OUTER_CARD_REF = re.compile(r'U\d+\."card_id"\s*=\s*\(?"cards"\."id"\)?')


class RangeLoadPlanShapeTests(FlowFixture):
    def setUp(self):
        super().setUp()
        self.flow_range = fm.rolling_range(30, now=self.now)
        # Live, archived inside the range, created inside it, archived long ago
        # with a recent movement (only the movement term keeps it), and finished
        # work the range load skips.
        self.live = self.path(self.backlog, 60, self.doing, 40)
        self.recent_archive = self.path(self.backlog, 60, self.done, 20, archived=10)
        self.recent_create = self.path(self.backlog, 5, self.done, 3, archived=2)
        self.late_row = self.path(self.backlog, 300, self.done, 200, archived=150)
        self.row(self.late_row, self.done, self.done, 4)
        self.old = self.path(self.backlog, 300, self.done, 200, archived=150)

    def range_queries(self, loader=fm.load_range_flow):
        with CaptureQueriesContext(connection) as ctx:
            flow = loader(self.board, self.flow_range, now=self.now)
        return flow, [q["sql"] for q in ctx.captured_queries]

    def test_no_range_load_statement_correlates_card_movements_to_the_card(self):
        """The #2502 shape: a correlated EXISTS over card_movements in any statement fails here."""
        for loader in (fm.load_range_flow, fm.load_cumulative_flow):
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
