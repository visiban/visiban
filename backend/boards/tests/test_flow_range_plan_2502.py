"""The range loader's movement term stays uncorrelated and bounded to the board (#2502).

#2425 narrowed every range metric with ``flow_metrics.can_affect_range``, whose
movement term was a correlated ``EXISTS (... card_id = cards.id ...)`` inside an
``OR``. PostgreSQL cannot make that a semi-join, and with it in the filter the
planner read the movements by walking every board's rows in
``card_movements_card_id`` (151,674 rows read to return 24,919 on the nightly
fixture), so wip-age p95 went 364 -> 531 ms on a board the narrowing could not
prune at all. The query count never changed, so a query-count test could not see
it; these tests pin the statement shape instead, plus the cards it keeps.

Narrowed on purpose for #2444 (recorded in docs/development/nightly-load-test.md):
the guard used to fail ANY card_movements alias compared to an outer card row.
Cumulative flow now finds each card's few deciding rows with scalar ``LIMIT 1``
probes in the card query's SELECT list, each one walk of the (card, moved_at, id)
index, so the database reads a few index entries per card instead of its whole
history. That is a different plan shape from #2502's: a SELECT-list scalar is
evaluated once per output row and stops at its first match, while a correlated
EXISTS/IN in a filter (worst under an OR) is what the planner could not turn into
a semi-join. So the guard now allows a correlation only inside a subquery that is
a SELECT-list item (opened right after ``SELECT`` or ``,``), ends in ``LIMIT 1``
and is named with ``AS``; a correlation anywhere else, a WHERE-clause EXISTS, IN
or scalar comparison above all, still fails. The negative controls below build
the #2502 shape and its relatives and prove the guard still catches them.
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
# a card_movements alias compared to an outer card row, the top-level "cards" or
# a card alias of another subquery level (Django gives each level its own
# letter: U0 inside, V0 around it). A join inside one level (U0 = U1) is not
# a correlation, so the two sides' letters must differ.
_OUTER_CARD_REF = re.compile(r'(?P<inner>[A-Z])\d+\."card_id"\s*=\s*\(?(?:"cards"|(?P<outer>[A-Z])\d+)\."id"\)?')
_SELECT_ITEM_END = re.compile(r'\s+LIMIT\s+1\s*$', re.IGNORECASE)


def _enclosing_subquery(sql, at):
    """``(start, end)`` of the innermost ``(SELECT ...)`` around ``at``: the indices of its parentheses."""
    depth, start = 0, None
    for i in range(at, -1, -1):
        if sql[i] == ")":
            depth += 1
        elif sql[i] == "(":
            if depth == 0 and sql[i + 1:].lstrip().upper().startswith("SELECT"):
                start = i
                break
            depth = max(depth - 1, 0)
    if start is None:
        return None
    depth = 0
    for j in range(start, len(sql)):
        depth += {"(": 1, ")": -1}.get(sql[j], 0)
        if depth == 0:
            return start, j
    return None


def forbidden_correlations(sql):
    """Each correlation to an outer card row that is not a SELECT-list ``LIMIT 1`` scalar (#2502, #2444).

    Allowed: ``SELECT (SELECT ... WHERE U0."card_id" = (V0."id") ... LIMIT 1) AS "x"``
    (or after ``,``). Anything else is returned: a correlated EXISTS or IN in a
    filter, a scalar compared in a WHERE, a SELECT-list subquery without LIMIT 1.
    """
    found = []
    for match in _OUTER_CARD_REF.finditer(sql):
        if match["outer"] is not None and match["outer"] == match["inner"]:
            continue
        span = _enclosing_subquery(sql, match.start())
        if span is not None:
            start, end = span
            opener = sql[:start].rstrip()
            select_item = opener.upper().endswith("SELECT") or opener.endswith(",")
            limited = _SELECT_ITEM_END.search(sql[start + 1:end]) is not None
            named = sql[end + 1:].lstrip().upper().startswith("AS ")
            if select_item and limited and named:
                continue
        found.append(match.group(0))
    return found


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
        """The #2502 shape: a correlated EXISTS over card_movements, or any correlation outside a SELECT-list LIMIT 1 probe, fails here."""
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
                    self.assertEqual(forbidden_correlations(sql), [], sql)

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


class NarrowedGuardControlTests(FlowFixture):
    """The narrowed guard (#2444) still fails the #2502 shape and its relatives, and allows only the probe."""

    def sql_of(self, queryset):
        with CaptureQueriesContext(connection) as ctx:
            list(queryset)
        return ctx.captured_queries[-1]["sql"]

    def recent(self, **extra):
        return CardMovement.objects.filter(card=OuterRef("pk"), moved_at__gte=self.ago(30), **extra)

    def test_the_2502_shape_still_fails(self):
        """A correlated EXISTS inside an OR in the filter: the plan regression itself."""
        sql = self.sql_of(Card.objects.filter(Q(Exists(self.recent())) | Q(archived_at__isnull=True)))
        self.assertTrue(_CORRELATED_MOVEMENTS.search(sql), sql)
        self.assertTrue(forbidden_correlations(sql), sql)

    def test_a_correlated_exists_or_in_in_any_filter_fails(self):
        for queryset in (
            Card.objects.filter(Exists(self.recent())),
            Card.objects.exclude(Exists(self.recent())),
            Card.objects.filter(id__in=self.recent().values("card_id")),
        ):
            with self.subTest(sql=str(queryset.query)):
                self.assertTrue(forbidden_correlations(self.sql_of(queryset)))

    def test_filtering_on_a_select_list_probe_fails(self):
        """Django repeats an annotation in the WHERE it is filtered on: that copy is a WHERE correlation."""
        probe = self.recent().order_by("-moved_at", "-id").values("id")[:1]
        sql = self.sql_of(Card.objects.annotate(row_id=probe).filter(row_id__isnull=False).values("row_id"))
        self.assertEqual(len(forbidden_correlations(sql)), 1, sql)

    def test_an_unlimited_select_list_subquery_fails(self):
        from django.db.models import Subquery

        sql = self.sql_of(Card.objects.annotate(row_id=Subquery(self.recent().order_by().values("id"))).values("row_id"))
        self.assertTrue(forbidden_correlations(sql), sql)

    def test_a_select_list_limit_1_probe_is_allowed_at_any_nesting(self):
        probe = self.recent().order_by("-moved_at", "-id").values("id")[:1]
        top = Card.objects.order_by().annotate(row_id=probe).values("row_id")
        nested = CardMovement.objects.filter(id__in=top.union(top)).values("id")
        for sql in (self.sql_of(top), self.sql_of(nested)):
            with self.subTest(sql=sql):
                self.assertTrue(_OUTER_CARD_REF.search(sql), sql)
                self.assertEqual(forbidden_correlations(sql), [], sql)
