"""Tests for per-swimlane analytics metrics and board movement history (#342, #344).

Covers:
- Summary endpoint returns active_cards, done_30d, avg_cycle_days per swimlane
- is_done column excluded from active_cards count
- done_30d counts only movement_type="move" into is_done columns
- avg_cycle_days computed correctly
- Movements endpoint returns paginated results
- Movements endpoint filter params: swimlane_id, to_column_id, assignee_id, moved_after, moved_before
- exclude_type=archived,unarchived filters system events
- Archive action creates CardMovement with movement_type="archived"
- Unarchive action creates CardMovement with movement_type="unarchived"
- ANALYTICS_EXTENSIONS=[] default returns empty extension_panels
- capabilities.movement_export is False by default
"""
import datetime

from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, CardMovement, Column, Swimlane,
)


class AnalyticsHistorySetup(TestCase):
    """Shared fixture factory for analytics/history tests."""

    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="pw")
        self.member = User.objects.create_user(username="member", password="pw")
        self.viewer = User.objects.create_user(username="viewer", password="pw")

        self.board = Board.objects.create(name="Test Board", owner=self.admin)
        BoardMembership.objects.create(board=self.board, user=self.admin, role="admin")
        BoardMembership.objects.create(board=self.board, user=self.member, role="member")
        BoardMembership.objects.create(board=self.board, user=self.viewer, role="viewer")

        self.col_todo = Column.objects.create(board=self.board, name="To Do", position=0, is_done=False)
        self.col_done = Column.objects.create(board=self.board, name="Done", position=1, is_done=True)
        self.swimlane = Swimlane.objects.create(board=self.board, name="Customer A", position=0)

        self.card = Card.objects.create(
            board=self.board, column=self.col_todo, swimlane=self.swimlane,
            title="Test Card", created_by=self.admin, position=0,
        )

    def _client_for(self, user):
        c = APIClient()
        c.force_authenticate(user=user)
        return c

    def _summary_url(self):
        return f"/api/boards/{self.board.pk}/summary/"

    def _movements_url(self):
        return f"/api/boards/{self.board.pk}/movements/"

    def _archive_url(self, card=None):
        card = card or self.card
        return f"/api/boards/{self.board.pk}/cards/{card.pk}/archive/"

    def _unarchive_url(self, card=None):
        card = card or self.card
        return f"/api/boards/{self.board.pk}/cards/{card.pk}/unarchive/"


class TestSummaryMetrics(AnalyticsHistorySetup):

    def test_active_cards_excludes_done_column(self):
        """Cards in is_done columns must not appear in active_cards."""
        # card is in col_todo (not done), so active_cards should be 1
        c = self._client_for(self.admin)
        resp = c.get(self._summary_url())
        self.assertEqual(resp.status_code, 200)
        row = resp.data["swimlanes"][0]
        self.assertEqual(row["active_cards"], 1)

        # Move card to done column — active_cards should drop to 0
        self.card.column = self.col_done
        self.card.save(update_fields=["column"])
        resp = c.get(self._summary_url())
        self.assertEqual(resp.data["swimlanes"][0]["active_cards"], 0)

    def test_active_cards_excludes_archived(self):
        """Archived cards must not appear in active_cards even if in non-done column."""
        self.card.archived_at = timezone.now()
        self.card.save(update_fields=["archived_at"])
        c = self._client_for(self.admin)
        resp = c.get(self._summary_url())
        self.assertEqual(resp.data["swimlanes"][0]["active_cards"], 0)

    def test_done_30d_counts_moves_into_done_column(self):
        """done_30d should count movement_type=move records into is_done columns."""
        CardMovement.objects.create(
            card=self.card,
            from_column=self.col_todo,
            from_column_name="To Do",
            to_column=self.col_done,
            to_column_name="Done",
            from_swimlane=self.swimlane,
            from_swimlane_name="Customer A",
            to_swimlane=self.swimlane,
            to_swimlane_name="Customer A",
            moved_by=self.admin,
            movement_type=CardMovement.MovementType.MOVE,
        )
        c = self._client_for(self.admin)
        resp = c.get(self._summary_url())
        self.assertEqual(resp.data["swimlanes"][0]["done_30d"], 1)

    def test_done_30d_excludes_system_events(self):
        """done_30d must not count archived/unarchived movement types."""
        CardMovement.objects.create(
            card=self.card,
            from_column=self.col_done,
            from_column_name="Done",
            to_column=self.col_done,
            to_column_name="Done",
            from_swimlane=self.swimlane,
            from_swimlane_name="Customer A",
            to_swimlane=self.swimlane,
            to_swimlane_name="Customer A",
            moved_by=self.admin,
            movement_type=CardMovement.MovementType.ARCHIVED,
        )
        c = self._client_for(self.admin)
        resp = c.get(self._summary_url())
        self.assertEqual(resp.data["swimlanes"][0]["done_30d"], 0)

    def test_avg_cycle_days_computed(self):
        """avg_cycle_days should reflect time from first move to first done move."""
        now = timezone.now()
        # First movement 2 days ago
        first_move = CardMovement.objects.create(
            card=self.card,
            from_column=None, from_column_name="",
            to_column=self.col_todo, to_column_name="To Do",
            from_swimlane=self.swimlane, from_swimlane_name="Customer A",
            to_swimlane=self.swimlane, to_swimlane_name="Customer A",
            moved_by=self.admin,
            movement_type=CardMovement.MovementType.MOVE,
        )
        # Backdate the first movement
        CardMovement.objects.filter(pk=first_move.pk).update(moved_at=now - datetime.timedelta(days=2))

        # Done movement now
        CardMovement.objects.create(
            card=self.card,
            from_column=self.col_todo, from_column_name="To Do",
            to_column=self.col_done, to_column_name="Done",
            from_swimlane=self.swimlane, from_swimlane_name="Customer A",
            to_swimlane=self.swimlane, to_swimlane_name="Customer A",
            moved_by=self.admin,
            movement_type=CardMovement.MovementType.MOVE,
        )

        c = self._client_for(self.admin)
        resp = c.get(self._summary_url())
        avg = resp.data["swimlanes"][0]["avg_cycle_days"]
        # Should be approximately 2 days (may differ by seconds in CI)
        self.assertIsNotNone(avg)
        self.assertAlmostEqual(avg, 2.0, delta=0.1)

    def test_avg_cycle_days_null_when_no_done_moves(self):
        """avg_cycle_days must be null when no cards have reached a done column."""
        c = self._client_for(self.admin)
        resp = c.get(self._summary_url())
        self.assertIsNone(resp.data["swimlanes"][0]["avg_cycle_days"])

    def test_extension_panels_empty_by_default(self):
        """ANALYTICS_EXTENSIONS not configured → extension_panels is an empty list."""
        c = self._client_for(self.admin)
        resp = c.get(self._summary_url())
        self.assertEqual(resp.data["extension_panels"], [])

    def test_capabilities_movement_export_false_by_default(self):
        """capabilities.movement_export must be False in OSS (no MOVEMENT_EXPORT_BACKENDS)."""
        c = self._client_for(self.admin)
        resp = c.get(f"/api/boards/{self.board.pk}/full/")
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(resp.data["capabilities"]["movement_export"])

    @override_settings(MOVEMENT_EXPORT_BACKENDS=["some.backend.Class"])
    def test_capabilities_movement_export_true_when_configured(self):
        """capabilities.movement_export must be True when MOVEMENT_EXPORT_BACKENDS is set."""
        c = self._client_for(self.admin)
        resp = c.get(f"/api/boards/{self.board.pk}/full/")
        self.assertTrue(resp.data["capabilities"]["movement_export"])


class TestMovementsEndpoint(AnalyticsHistorySetup):

    def _make_movement(self, movement_type=CardMovement.MovementType.MOVE, days_ago=0):
        mv = CardMovement.objects.create(
            card=self.card,
            from_column=self.col_todo, from_column_name="To Do",
            to_column=self.col_done, to_column_name="Done",
            from_swimlane=self.swimlane, from_swimlane_name="Customer A",
            to_swimlane=self.swimlane, to_swimlane_name="Customer A",
            moved_by=self.admin,
            movement_type=movement_type,
        )
        if days_ago:
            CardMovement.objects.filter(pk=mv.pk).update(
                moved_at=timezone.now() - datetime.timedelta(days=days_ago)
            )
        return mv

    def test_returns_paginated_results(self):
        """Movements endpoint returns count, offset, page_size, and results."""
        self._make_movement()
        c = self._client_for(self.admin)
        resp = c.get(self._movements_url())
        self.assertEqual(resp.status_code, 200)
        self.assertIn("count", resp.data)
        self.assertIn("offset", resp.data)
        self.assertIn("page_size", resp.data)
        self.assertIn("results", resp.data)
        self.assertEqual(resp.data["page_size"], 50)

    def test_results_include_card_title_and_uid(self):
        """Each result must include card_title and card_uid."""
        self._make_movement()
        c = self._client_for(self.admin)
        resp = c.get(self._movements_url())
        result = resp.data["results"][0]
        self.assertEqual(result["card_title"], "Test Card")
        self.assertIn("card_uid", result)

    def test_filter_by_swimlane_id(self):
        """swimlane_id param filters movements to that swimlane's cards."""
        other_lane = Swimlane.objects.create(board=self.board, name="Other", position=1)
        other_card = Card.objects.create(
            board=self.board, column=self.col_todo, swimlane=other_lane,
            title="Other Card", created_by=self.admin, position=0,
        )
        # Movement for other_card
        CardMovement.objects.create(
            card=other_card,
            from_column=self.col_todo, from_column_name="To Do",
            to_column=self.col_done, to_column_name="Done",
            from_swimlane=other_lane, from_swimlane_name="Other",
            to_swimlane=other_lane, to_swimlane_name="Other",
            moved_by=self.admin,
            movement_type=CardMovement.MovementType.MOVE,
        )
        self._make_movement()

        c = self._client_for(self.admin)
        resp = c.get(self._movements_url(), {"swimlane_id": self.swimlane.pk})
        for result in resp.data["results"]:
            self.assertEqual(result["card_title"], "Test Card")

    def test_filter_by_to_column_id(self):
        """to_column_id param filters movements by destination column."""
        self._make_movement()  # to col_done
        c = self._client_for(self.admin)
        resp = c.get(self._movements_url(), {"to_column_id": self.col_todo.pk})
        self.assertEqual(resp.data["count"], 0)

        resp = c.get(self._movements_url(), {"to_column_id": self.col_done.pk})
        self.assertEqual(resp.data["count"], 1)

    def test_filter_by_assignee_id(self):
        """assignee_id param filters movements to cards assigned to that user."""
        self.card.assignee = self.member
        self.card.save(update_fields=["assignee"])
        self._make_movement()

        c = self._client_for(self.admin)
        resp = c.get(self._movements_url(), {"assignee_id": self.viewer.pk})
        self.assertEqual(resp.data["count"], 0)

        resp = c.get(self._movements_url(), {"assignee_id": self.member.pk})
        self.assertEqual(resp.data["count"], 1)

    def test_exclude_type_filters_system_events(self):
        """exclude_type=archived,unarchived removes archive/unarchive movements."""
        self._make_movement(movement_type=CardMovement.MovementType.MOVE)
        self._make_movement(movement_type=CardMovement.MovementType.ARCHIVED)
        self._make_movement(movement_type=CardMovement.MovementType.UNARCHIVED)

        c = self._client_for(self.admin)
        resp = c.get(self._movements_url(), {"exclude_type": "archived,unarchived"})
        self.assertEqual(resp.data["count"], 1)
        self.assertEqual(resp.data["results"][0]["movement_type"], "move")

    def test_default_date_range_last_30_days(self):
        """Without date params, only movements from the last 30 days are returned."""
        self._make_movement(days_ago=10)
        self._make_movement(days_ago=40)  # outside default range

        c = self._client_for(self.admin)
        resp = c.get(self._movements_url())
        self.assertEqual(resp.data["count"], 1)

    def test_viewer_can_read_movements(self):
        """Viewer role has read access to movement history."""
        self._make_movement()
        c = self._client_for(self.viewer)
        resp = c.get(self._movements_url())
        self.assertEqual(resp.status_code, 200)

    def test_unauthenticated_denied(self):
        """Unauthenticated requests are rejected."""
        c = APIClient()
        resp = c.get(self._movements_url())
        self.assertEqual(resp.status_code, 403)


class TestArchiveUnarchiveMovements(AnalyticsHistorySetup):

    def test_archive_creates_archived_movement(self):
        """Archiving a card must create a CardMovement with movement_type=archived."""
        c = self._client_for(self.member)
        resp = c.post(self._archive_url())
        self.assertEqual(resp.status_code, 200)

        movement = CardMovement.objects.filter(
            card=self.card,
            movement_type=CardMovement.MovementType.ARCHIVED,
        ).first()
        self.assertIsNotNone(movement)
        self.assertEqual(movement.from_column, self.col_todo)
        self.assertEqual(movement.to_column, self.col_todo)
        self.assertEqual(movement.moved_by, self.member)

    def test_archive_idempotent_no_duplicate_movement(self):
        """Archiving an already-archived card must not create another movement."""
        self.card.archived_at = timezone.now()
        self.card.save(update_fields=["archived_at"])
        initial_count = CardMovement.objects.filter(
            card=self.card, movement_type=CardMovement.MovementType.ARCHIVED
        ).count()

        c = self._client_for(self.member)
        c.post(self._archive_url())

        final_count = CardMovement.objects.filter(
            card=self.card, movement_type=CardMovement.MovementType.ARCHIVED
        ).count()
        self.assertEqual(initial_count, final_count)

    def test_unarchive_creates_unarchived_movement(self):
        """Unarchiving a card must create a CardMovement with movement_type=unarchived."""
        self.card.archived_at = timezone.now()
        self.card.save(update_fields=["archived_at"])

        c = self._client_for(self.member)
        resp = c.post(self._unarchive_url())
        self.assertEqual(resp.status_code, 200)

        movement = CardMovement.objects.filter(
            card=self.card,
            movement_type=CardMovement.MovementType.UNARCHIVED,
        ).first()
        self.assertIsNotNone(movement)
        self.assertEqual(movement.from_column, self.col_todo)
        self.assertEqual(movement.to_column, self.col_todo)
        self.assertEqual(movement.moved_by, self.member)

    def test_unarchive_idempotent_no_duplicate_movement(self):
        """Unarchiving an active card must not create a spurious unarchived movement."""
        # card.archived_at is already None
        initial_count = CardMovement.objects.filter(
            card=self.card, movement_type=CardMovement.MovementType.UNARCHIVED
        ).count()

        c = self._client_for(self.member)
        c.post(self._unarchive_url())

        final_count = CardMovement.objects.filter(
            card=self.card, movement_type=CardMovement.MovementType.UNARCHIVED
        ).count()
        self.assertEqual(initial_count, final_count)
