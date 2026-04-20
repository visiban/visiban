"""Tests for archived card stale scan exclusion and analytics query-count budget (#593).

Covers:
- Archived card stale scan exclusion: an archived card with a backdated last
  movement generates zero notifications when notify_stale_cards runs
- Analytics query-count budget: seeding 5 columns × 10 swimlanes × 3 cards
  with 5 CardMovements per card and asserting GET /api/v1/boards/{id}/analytics/
  stays within a fixed budget; doubling movements must not increase the count
"""

import datetime

from django.core.management import call_command
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, CardMovement, Column, Notification, Swimlane,
)


# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------

def _make_board(owner):
    board = Board.objects.create(name="Test Board", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    return board


def _make_movement(card, to_column, to_swimlane, user, days_ago=0):
    """Create a CardMovement and optionally backdate its moved_at timestamp."""
    mv = CardMovement.objects.create(
        card=card,
        from_column=None, from_column_name="",
        to_column=to_column, to_column_name=to_column.name,
        from_swimlane=None, from_swimlane_name="",
        to_swimlane=to_swimlane, to_swimlane_name=to_swimlane.name,
        moved_by=user,
    )
    if days_ago:
        backdated = timezone.now() - datetime.timedelta(days=days_ago)
        CardMovement.objects.filter(pk=mv.pk).update(moved_at=backdated)
        mv.refresh_from_db()
    return mv


# ---------------------------------------------------------------------------
# Archived card stale scan exclusion (#593)
# ---------------------------------------------------------------------------

class ArchivedCardStaleScanTests(TestCase):
    """notify_stale_cards must skip archived cards entirely."""

    def setUp(self):
        # notif_due_soon=True so the owner is eligible for notifications
        self.owner = User.objects.create_user(
            username="scan_owner", password="pass", notif_due_soon=True,
        )
        self.board = _make_board(self.owner)
        self.threshold = self.board.staleness_threshold_days  # default 7

        self.col = Column.objects.create(
            board=self.board, name="Backlog", position=0, allow_card_creation=True,
        )
        self.swim = Swimlane.objects.create(board=self.board, name="General", position=0)

    def test_archived_card_generates_no_stale_notification(self):
        """An archived card whose last movement is beyond the staleness threshold
        must not generate a notification when notify_stale_cards runs."""
        card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Stale But Archived", created_by=self.owner, position=0,
        )
        # Backdate last movement beyond the threshold
        _make_movement(card, self.col, self.swim, self.owner, days_ago=self.threshold + 5)

        # Archive the card
        card.archived_at = timezone.now()
        card.save(update_fields=["archived_at"])

        call_command("notify_stale_cards", verbosity=0)

        notif_count = Notification.objects.filter(
            card=card, recipient=self.owner,
        ).count()
        self.assertEqual(
            notif_count, 0,
            "notify_stale_cards should not create notifications for archived cards.",
        )

    def test_active_stale_card_still_generates_notification(self):
        """Active (non-archived) stale card must still generate a notification.

        This is a positive control: if archived exclusion broke active card
        processing entirely, this test would catch the regression.
        """
        card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Stale Active", created_by=self.owner, position=1,
        )
        _make_movement(card, self.col, self.swim, self.owner, days_ago=self.threshold + 5)
        # card.archived_at is None — card remains active

        call_command("notify_stale_cards", verbosity=0)

        notif_count = Notification.objects.filter(
            card=card, recipient=self.owner,
        ).count()
        self.assertEqual(
            notif_count, 1,
            "notify_stale_cards must still notify for active stale cards.",
        )

    def test_mixed_board_only_active_cards_notified(self):
        """When one archived stale card and one active stale card coexist on the
        same board, only the active card generates a notification."""
        active_card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Active Stale", created_by=self.owner, position=0,
        )
        archived_card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Archived Stale", created_by=self.owner, position=1,
        )

        _make_movement(active_card, self.col, self.swim, self.owner, days_ago=self.threshold + 3)
        _make_movement(archived_card, self.col, self.swim, self.owner, days_ago=self.threshold + 3)

        archived_card.archived_at = timezone.now()
        archived_card.save(update_fields=["archived_at"])

        call_command("notify_stale_cards", verbosity=0)

        self.assertEqual(
            Notification.objects.filter(card=active_card, recipient=self.owner).count(), 1,
        )
        self.assertEqual(
            Notification.objects.filter(card=archived_card, recipient=self.owner).count(), 0,
        )


# ---------------------------------------------------------------------------
# Analytics query-count budget (#593)
# ---------------------------------------------------------------------------

def _seed_analytics_board(owner, n_cols=5, n_lanes=10, cards_per_cell=3, movements_per_card=5):
    """Seed a board with n_cols × n_lanes × cards_per_cell cards, each with
    movements_per_card CardMovement records spread across the last 30 days.

    Returns (board, cols, lanes, all_cards).
    """
    board = _make_board(owner)
    cols = [
        Column.objects.create(board=board, name=f"Col {i}", position=i)
        for i in range(n_cols)
    ]
    lanes = [
        Swimlane.objects.create(board=board, name=f"Lane {i}", position=i)
        for i in range(n_lanes)
    ]
    all_cards = []
    for col in cols:
        for lane in lanes:
            for n in range(cards_per_cell):
                card = Card.objects.create(
                    board=board, column=col, swimlane=lane,
                    title=f"Card {n}", created_by=owner, position=n,
                )
                for m in range(movements_per_card):
                    mv = CardMovement.objects.create(
                        card=card,
                        to_column=col, to_column_name=col.name,
                        to_swimlane=lane, to_swimlane_name=lane.name,
                        moved_by=owner,
                    )
                    # Spread movements evenly across the last 30 days
                    days_ago = m * 3 + 1
                    CardMovement.objects.filter(pk=mv.pk).update(
                        moved_at=timezone.now() - datetime.timedelta(days=days_ago)
                    )
                all_cards.append(card)
    return board, cols, lanes, all_cards


class AnalyticsQueryCountBudgetTests(TestCase):
    """GET /api/v1/boards/{id}/analytics/ must not issue per-card or per-swimlane queries.

    Budget: a generous ceiling measured at 2× the observed minimum for the
    seeded dataset.  The important invariant is that doubling the number of
    CardMovement records must not increase the query count — that would
    indicate an N+1 on the movements queryset.
    """

    # Analytics aggregates in Python after a small fixed set of DB queries.
    # Measured ~8 queries on a cold fixture; 25 gives generous CI headroom.
    BUDGET = 25

    def setUp(self):
        self.owner = User.objects.create_user(username="analytics_owner", password="pass")
        self.board, self.cols, self.lanes, self.cards = _seed_analytics_board(
            self.owner, n_cols=5, n_lanes=10, cards_per_cell=3, movements_per_card=5,
        )
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def _analytics_url(self):
        return f"/api/v1/boards/{self.board.pk}/analytics/"

    def _run(self):
        return self.client.get(self._analytics_url())

    def test_analytics_within_query_budget(self):
        """analytics/ must complete within the fixed query budget."""
        with CaptureQueriesContext(connection) as ctx:
            resp = self._run()
        self.assertEqual(resp.status_code, 200)
        self.assertLessEqual(
            len(ctx), self.BUDGET,
            f"analytics/ used {len(ctx)} queries — budget is {self.BUDGET}. "
            "An N+1 was introduced; check prefetches and aggregations.",
        )

    def test_analytics_query_count_stable_after_doubling_movements(self):
        """Doubling CardMovement records must not increase the analytics/ query count.

        If the query count grows with more movements, that indicates the endpoint
        is issuing per-card or per-movement queries rather than using bulk aggregation.
        """
        baseline_count = None
        with CaptureQueriesContext(connection) as ctx:
            resp = self._run()
        self.assertEqual(resp.status_code, 200)
        baseline_count = len(ctx)

        # Double the movements for every card on the board
        for card in self.cards:
            col = card.column
            swim = card.swimlane
            for m in range(5):  # add 5 more movements per card
                mv = CardMovement.objects.create(
                    card=card,
                    to_column=col, to_column_name=col.name,
                    to_swimlane=swim, to_swimlane_name=swim.name,
                    moved_by=self.owner,
                )
                CardMovement.objects.filter(pk=mv.pk).update(
                    moved_at=timezone.now() - datetime.timedelta(days=m + 1)
                )

        with CaptureQueriesContext(connection) as ctx_doubled:
            resp2 = self._run()
        self.assertEqual(resp2.status_code, 200)
        doubled_count = len(ctx_doubled)

        self.assertEqual(
            baseline_count, doubled_count,
            f"analytics/ query count grew from {baseline_count} to {doubled_count} "
            "after doubling movements — N+1 regression detected.",
        )

    def test_analytics_response_shape(self):
        """analytics/ must return the expected top-level response shape."""
        resp = self._run()
        self.assertEqual(resp.status_code, 200)
        data = resp.data
        self.assertIn("columns", data)
        self.assertIn("swimlanes", data)
        # Each swimlane entry must have avg_days_per_column
        for lane in data["swimlanes"]:
            self.assertIn("avg_days_per_column", lane)
