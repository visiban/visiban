"""The summary's per-cell and blocked counts come from one grouped scan (#2432).

``GET /boards/{id}/summary/`` used to scan the board's live cards twice: once
for the ``(swimlane, column)`` counts and once for ``blocked_by_swimlane``. Both
now come from one ``GROUP BY swimlane, column`` with a filtered ``COUNT`` for
the blocked cards, and ``blocked_cards`` sums only the non-done cells. These
tests pin that the response is unchanged (against the old two-query rule, kept
here only as the reference) and that the summary issues exactly one query fewer.
"""
from unittest.mock import patch

from django.db import connection
from django.db.models import Count, Exists, F, OuterRef, Q
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from boards.models import Card, CardRelation
from boards.tests.conftest import _make_board, _make_card, _make_column, _make_swimlane, _make_user

# The summary's statements on this fixture after #2432: one fewer than before,
# because the blocked count no longer has its own scan. If this moves, say why
# in the commit; never raise it to absorb a per-swimlane or per-cell query.
SUMMARY_QUERIES = 6


def _old_blocked_by_swimlane(board, done_column_ids):
    """The pre-#2432 second scan, kept here only as the reference."""
    relation_blocked = Exists(CardRelation.objects.filter(
        to_card=OuterRef("pk"),
        relation_type=CardRelation.Type.BLOCKS,
        from_card__archived_at__isnull=True,
        from_card__board_id=F("to_card__board_id"),
    ))
    return dict(
        board.cards.filter(archived_at__isnull=True)
        .exclude(column_id__in=done_column_ids)
        .filter(Q(blocked_at__isnull=False) | Q(relation_blocked))
        .values("swimlane_id")
        .annotate(cnt=Count("id"))
        .values_list("swimlane_id", "cnt")
    )


def _old_counts(board):
    """The pre-#2432 per-cell scan, the reference for the count fields."""
    counts = {}
    for row in board.cards.filter(archived_at__isnull=True).values("swimlane_id", "column_id").annotate(cnt=Count("id")):
        counts.setdefault(row["swimlane_id"], {})[row["column_id"]] = row["cnt"]
    return counts


class SummaryGroupedCountsTests(TestCase):
    def setUp(self):
        patcher = patch("boards.broadcast.broadcast_board_event")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.owner = _make_user("sum2432")
        self.board = _make_board(self.owner)
        self.doing = _make_column(self.board, name="Doing", order=0)
        self.review = _make_column(self.board, name="Review", order=1)
        self.done = _make_column(self.board, name="Done", order=2, is_done=True)
        self.lane_a = _make_swimlane(self.board, name="A", order=0)
        self.lane_b = _make_swimlane(self.board, name="B", order=1)
        self.lane_c = _make_swimlane(self.board, name="C", order=2)  # done cards only
        self.lane_d = _make_swimlane(self.board, name="D", order=3)  # empty
        now = timezone.now()

        def card(column, lane, title, **fields):
            c = _make_card(column, lane, title=title)
            if fields:
                Card.objects.filter(pk=c.pk).update(**fields)
            return c

        def blocks(blocker, blocked):
            CardRelation.objects.create(from_card=blocker, to_card=blocked, relation_type=CardRelation.Type.BLOCKS)

        # Lane A: manual, relation, both, two blockers on one card, a plain card.
        card(self.doing, self.lane_a, "manual", blocked_at=now, blocked_reason="x")
        plain = card(self.doing, self.lane_a, "plain")
        by_relation = card(self.review, self.lane_a, "relation")
        blocks(plain, by_relation)
        both = card(self.review, self.lane_a, "both", blocked_at=now, blocked_reason="x")
        blocks(plain, both)
        twice = card(self.doing, self.lane_a, "twice")
        blocks(plain, twice)
        blocks(by_relation, twice)
        # Lane B: blockers that must not count (archived, off-board), an
        # archived blocked card, and blocked cards in the done column.
        archived_blocker = card(self.doing, self.lane_b, "archived blocker", archived_at=now)
        by_archived = card(self.doing, self.lane_b, "by archived")
        blocks(archived_blocker, by_archived)
        other = _make_board(self.owner, name="Other")
        stranger = _make_card(_make_column(other), _make_swimlane(other), title="stranger")
        by_stranger = card(self.review, self.lane_b, "by stranger")
        blocks(stranger, by_stranger)
        card(self.review, self.lane_b, "archived and blocked", archived_at=now, blocked_at=now, blocked_reason="x")
        card(self.done, self.lane_b, "done manual", blocked_at=now, blocked_reason="x")
        done_by_relation = card(self.done, self.lane_b, "done relation")
        blocks(plain, done_by_relation)
        card(self.doing, self.lane_b, "counted", blocked_at=now, blocked_reason="x")
        # Lane C: a blocked card, but only in the done column.
        card(self.done, self.lane_c, "done only", blocked_at=now, blocked_reason="x")

        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def summary(self):
        resp = self.client.get(f"/api/v1/boards/{self.board.id}/summary/")
        self.assertEqual(resp.status_code, 200, resp.data)
        return resp

    def test_blocked_cards_match_the_old_separate_scan(self):
        rows = {row["id"]: row for row in self.summary().data["swimlanes"]}
        reference = _old_blocked_by_swimlane(self.board, {self.done.id})
        for lane in (self.lane_a, self.lane_b, self.lane_c, self.lane_d):
            with self.subTest(lane=lane.name):
                self.assertEqual(rows[lane.id]["blocked_cards"], reference.get(lane.id, 0))
        # Not vacuous: every case above lands where the old rule put it.
        self.assertEqual(
            [rows[lane.id]["blocked_cards"] for lane in (self.lane_a, self.lane_b, self.lane_c, self.lane_d)],
            [4, 1, 0, 0],
        )

    def test_count_fields_match_the_old_per_cell_scan(self):
        counts = _old_counts(self.board)
        for row in self.summary().data["swimlanes"]:
            cells = counts.get(row["id"], {})
            with self.subTest(lane=row["name"]):
                self.assertEqual(row["total_cards"], sum(cells.values()))
                self.assertEqual(row["active_cards"], sum(cells.values()) - cells.get(self.done.id, 0))
                self.assertEqual(
                    row["stage_distribution"],
                    {"Doing": cells.get(self.doing.id, 0), "Review": cells.get(self.review.id, 0),
                     "Done": cells.get(self.done.id, 0)},
                )
                self.assertLessEqual(row["blocked_cards"], row["active_cards"])

    def test_a_board_with_no_done_column_counts_every_live_blocked_card(self):
        # The done-column guard on the relation probe is skipped when there
        # are no done columns; the count must still be the old rule's.
        self.done.is_done = False
        self.done.save(update_fields=["is_done"])
        rows = {row["id"]: row for row in self.summary().data["swimlanes"]}
        reference = _old_blocked_by_swimlane(self.board, set())
        self.assertEqual(rows[self.lane_b.id]["blocked_cards"], reference[self.lane_b.id])
        self.assertEqual(rows[self.lane_b.id]["blocked_cards"], 3)  # + done manual, done relation
        self.assertEqual(rows[self.lane_c.id]["blocked_cards"], 1)

    def test_summary_reads_the_cards_once_for_counts_and_blocked(self):
        with CaptureQueriesContext(connection) as ctx:
            self.summary()
        statements = [q["sql"] for q in ctx.captured_queries]
        self.assertEqual(len(statements), SUMMARY_QUERIES, "\n".join(statements))
        # Exactly one grouped read of the board's cards, and it carries the
        # blocked probe: the old per-swimlane blocked scan was a second one.
        grouped = [sql for sql in statements if 'FROM "cards"' in sql and "GROUP BY" in sql]
        self.assertEqual(len(grouped), 1, "\n".join(statements))
        self.assertIn('"card_relations"', grouped[0])
        self.assertIn('"cards"."column_id"', grouped[0].split("FROM")[0])
