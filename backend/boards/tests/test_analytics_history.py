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
        return f"/api/v1/boards/{self.board.pk}/summary/"

    def _movements_url(self):
        return f"/api/v1/boards/{self.board.pk}/movements/"

    def _archive_url(self, card=None):
        card = card or self.card
        return f"/api/v1/boards/{self.board.pk}/cards/{card.pk}/archive/"

    def _unarchive_url(self, card=None):
        card = card or self.card
        return f"/api/v1/boards/{self.board.pk}/cards/{card.pk}/unarchive/"

    def _analytics_url(self):
        return f"/api/v1/boards/{self.board.pk}/analytics/"


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
        resp = c.get(f"/api/v1/boards/{self.board.pk}/full/")
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(resp.data["capabilities"]["movement_export"])

    @override_settings(MOVEMENT_EXPORT_BACKENDS=["some.backend.Class"])
    def test_capabilities_movement_export_true_when_configured(self):
        """capabilities.movement_export must be True when MOVEMENT_EXPORT_BACKENDS is set."""
        from unittest.mock import patch
        dummy_backend = lambda board, qs, req: None  # noqa: E731
        with patch("boards.hooks.MOVEMENT_EXPORT_BACKENDS", [dummy_backend]):
            c = self._client_for(self.admin)
            resp = c.get(f"/api/v1/boards/{self.board.pk}/full/")
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

    def test_filter_by_moved_by_id(self):
        """moved_by_id param filters movements by the user who performed the move."""
        self._make_movement()  # moved_by=self.admin

        c = self._client_for(self.admin)
        resp = c.get(self._movements_url(), {"moved_by_id": self.viewer.pk})
        self.assertEqual(resp.data["count"], 0)

        resp = c.get(self._movements_url(), {"moved_by_id": self.admin.pk})
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

    def test_no_default_date_cutoff(self):
        """Without date params, all movements are returned regardless of age."""
        self._make_movement(days_ago=10)
        self._make_movement(days_ago=40)
        self._make_movement(days_ago=365)

        c = self._client_for(self.admin)
        resp = c.get(self._movements_url())
        self.assertEqual(resp.data["count"], 3)

    def test_viewer_can_read_movements(self):
        """Viewer role has read access to movement history."""
        self._make_movement()
        c = self._client_for(self.viewer)
        resp = c.get(self._movements_url())
        self.assertEqual(resp.status_code, 200)

    def test_unauthenticated_denied(self):
        """Unauthenticated requests are rejected with 401."""
        c = APIClient()
        resp = c.get(self._movements_url())
        self.assertEqual(resp.status_code, 401)


class TestArchiveUnarchiveMovements(AnalyticsHistorySetup):

    def test_archive_creates_archived_movement(self):
        """Archiving a card must create a CardMovement with movement_type=archived."""
        c = self._client_for(self.admin)
        resp = c.post(self._archive_url())
        self.assertEqual(resp.status_code, 200)

        movement = CardMovement.objects.filter(
            card=self.card,
            movement_type=CardMovement.MovementType.ARCHIVED,
        ).first()
        self.assertIsNotNone(movement)
        self.assertEqual(movement.from_column, self.col_todo)
        self.assertEqual(movement.to_column, self.col_todo)
        self.assertEqual(movement.moved_by, self.admin)

    def test_archive_idempotent_no_duplicate_movement(self):
        """Archiving an already-archived card must not create another movement."""
        self.card.archived_at = timezone.now()
        self.card.save(update_fields=["archived_at"])
        initial_count = CardMovement.objects.filter(
            card=self.card, movement_type=CardMovement.MovementType.ARCHIVED
        ).count()

        c = self._client_for(self.admin)
        c.post(self._archive_url())

        final_count = CardMovement.objects.filter(
            card=self.card, movement_type=CardMovement.MovementType.ARCHIVED
        ).count()
        self.assertEqual(initial_count, final_count)

    def test_unarchive_creates_unarchived_movement(self):
        """Unarchiving a card must create a CardMovement with movement_type=unarchived."""
        self.card.archived_at = timezone.now()
        self.card.save(update_fields=["archived_at"])

        c = self._client_for(self.admin)
        resp = c.post(self._unarchive_url())
        self.assertEqual(resp.status_code, 200)

        movement = CardMovement.objects.filter(
            card=self.card,
            movement_type=CardMovement.MovementType.UNARCHIVED,
        ).first()
        self.assertIsNotNone(movement)
        self.assertEqual(movement.from_column, self.col_todo)
        self.assertEqual(movement.to_column, self.col_todo)
        self.assertEqual(movement.moved_by, self.admin)

    def test_unarchive_idempotent_no_duplicate_movement(self):
        """Unarchiving an active card must not create a spurious unarchived movement."""
        # card.archived_at is already None
        initial_count = CardMovement.objects.filter(
            card=self.card, movement_type=CardMovement.MovementType.UNARCHIVED
        ).count()

        c = self._client_for(self.admin)
        c.post(self._unarchive_url())

        final_count = CardMovement.objects.filter(
            card=self.card, movement_type=CardMovement.MovementType.UNARCHIVED
        ).count()
        self.assertEqual(initial_count, final_count)


class TestAnalyticsDoneColumns(AnalyticsHistorySetup):
    """Analytics heatmap: done column dwell exclusion, stalled detection, done_columns field."""

    def _move(self, card, to_column, days_ago):
        """Create a CardMovement record as if it happened `days_ago` days in the past.

        moved_at uses auto_now_add so it cannot be passed to create(); we update
        it with a direct queryset call immediately after creation.
        """
        mv = CardMovement.objects.create(
            card=card,
            to_column=to_column,
            to_column_name=to_column.name,
            moved_by=self.admin,
        )
        moved_at = timezone.now() - datetime.timedelta(days=days_ago)
        CardMovement.objects.filter(pk=mv.pk).update(moved_at=moved_at)
        mv.refresh_from_db()
        return mv

    def test_done_columns_excluded_from_avg_days_per_column(self):
        """Done columns must not appear as keys in avg_days_per_column."""
        self._move(self.card, self.col_todo, days_ago=5)
        self._move(self.card, self.col_done, days_ago=2)

        c = self._client_for(self.admin)
        resp = c.get(self._analytics_url())
        self.assertEqual(resp.status_code, 200)

        sw = resp.data["swimlanes"][0]
        self.assertIn("To Do", sw["avg_days_per_column"])
        self.assertNotIn("Done", sw["avg_days_per_column"])

    def test_done_columns_field_in_response(self):
        """Response must include done_columns listing is_done column names."""
        c = self._client_for(self.admin)
        resp = c.get(self._analytics_url())
        self.assertEqual(resp.status_code, 200)
        self.assertIn("done_columns", resp.data)
        self.assertEqual(resp.data["done_columns"], ["Done"])

    def test_columns_field_unchanged_includes_done(self):
        """columns field must still include done column names for backward compat."""
        c = self._client_for(self.admin)
        resp = c.get(self._analytics_url())
        self.assertIn("To Do", resp.data["columns"])
        self.assertIn("Done", resp.data["columns"])

    def test_card_in_done_column_not_flagged_as_stalled(self):
        """A card whose last movement was into a done column must not appear in stalled_cards."""
        # Move card to done column 60 days ago — well past any staleness threshold.
        self._move(self.card, self.col_todo, days_ago=65)
        self._move(self.card, self.col_done, days_ago=60)

        c = self._client_for(self.admin)
        resp = c.get(self._analytics_url() + "?stalled_days=7")
        self.assertEqual(resp.status_code, 200)
        stalled_ids = [s["id"] for s in resp.data["swimlanes"][0]["stalled_cards"]]
        self.assertNotIn(self.card.pk, stalled_ids)

    def test_stalled_card_entry_includes_uid(self):
        """Each stalled_cards entry must include both id and uid so clients can
        address the card by its stable external identifier."""
        self._move(self.card, self.col_todo, days_ago=30)

        c = self._client_for(self.admin)
        resp = c.get(self._analytics_url() + "?stalled_days=7")
        self.assertEqual(resp.status_code, 200)
        stalled = resp.data["swimlanes"][0]["stalled_cards"]
        self.assertTrue(len(stalled) > 0, "Expected at least one stalled card")
        entry = next(s for s in stalled if s["id"] == self.card.pk)
        self.assertEqual(entry["uid"], self.card.uid)

    def test_active_column_dwell_still_tracked(self):
        """Dwell time in non-done columns must still be calculated correctly."""
        # Card spent 5 days in To Do, then moved to Done.
        self._move(self.card, self.col_todo, days_ago=5)
        self._move(self.card, self.col_done, days_ago=0)

        c = self._client_for(self.admin)
        resp = c.get(self._analytics_url() + "?days=30")
        self.assertEqual(resp.status_code, 200)
        avg = resp.data["swimlanes"][0]["avg_days_per_column"]["To Do"]
        self.assertIsNotNone(avg)
        self.assertAlmostEqual(avg, 5.0, delta=0.2)

    def test_board_with_no_done_columns_returns_empty_done_columns(self):
        """done_columns must be an empty list when no columns are marked done."""
        self.col_done.is_done = False
        self.col_done.save(update_fields=["is_done"])

        c = self._client_for(self.admin)
        resp = c.get(self._analytics_url())
        self.assertEqual(resp.data["done_columns"], [])


class TestAnalyticsWindowFilter(AnalyticsHistorySetup):
    """Analytics endpoint must exclude cards archived before the analysis window.

    Regression test for the pre-1.0 perf blocker where board.cards was
    fetched with no archive filter, loading all-time history into memory.
    """

    def test_card_archived_before_window_excluded_from_stalled(self):
        """A card archived long before the analysis window must not appear as stalled."""
        old_date = timezone.now() - datetime.timedelta(days=200)
        self.card.archived_at = old_date
        self.card.save(update_fields=["archived_at"])

        resp = self._client_for(self.admin).get(self._analytics_url() + "?days=30")
        self.assertEqual(resp.status_code, 200)
        stalled_ids = [
            c["id"]
            for lane in resp.data["swimlanes"]
            for c in lane.get("stalled_cards", [])
        ]
        self.assertNotIn(self.card.pk, stalled_ids)

    def test_card_archived_within_window_included(self):
        """A card archived within the analysis window should be included (dwell-time data)."""
        recent_date = timezone.now() - datetime.timedelta(days=5)
        self.card.archived_at = recent_date
        self.card.save(update_fields=["archived_at"])

        resp = self._client_for(self.admin).get(self._analytics_url() + "?days=30")
        self.assertEqual(resp.status_code, 200)
        # The endpoint must return 200 without error; the card is processed
        # without raising (it enters the cards_by_swimlane grouping)
        self.assertIn("swimlanes", resp.data)


class TestAnalyticsSummaryRbac(AnalyticsHistorySetup):
    """Non-members must receive 403 on /analytics/ and /summary/ (#702)."""

    def setUp(self):
        super().setUp()
        self.non_member = User.objects.create_user(username="stranger", password="pw")

    def test_non_member_cannot_access_analytics(self):
        c = self._client_for(self.non_member)
        resp = c.get(self._analytics_url())
        self.assertEqual(resp.status_code, 403)

    def test_non_member_cannot_access_summary(self):
        c = self._client_for(self.non_member)
        resp = c.get(self._summary_url())
        self.assertEqual(resp.status_code, 403)

    def test_non_member_cannot_access_movements(self):
        c = self._client_for(self.non_member)
        resp = c.get(self._movements_url())
        self.assertEqual(resp.status_code, 403)


class TestMovementsDeletedFk(AnalyticsHistorySetup):
    """CardMovement serialization must survive deleted column/swimlane FKs (#703).

    CardMovement denormalizes *_name and *_uid at write time precisely so that
    the history remains readable even after a column or swimlane is deleted.
    This test verifies that:
    - Denormalized name/uid fields are preserved after FK deletion
    - Null FK fields do not cause serialization errors
    - The response shape matches the documented contract
    """

    def test_movements_after_column_deleted(self):
        """Deleting a column must not break serialization of existing movements."""
        # Move the card to a safe column so deleting col_todo/col_done doesn't
        # cascade-delete the card (Card.column uses CASCADE).
        safe_col = Column.objects.create(
            board=self.board, name="Safe", position=99, allow_card_creation=True
        )
        self.card.column = safe_col
        self.card.save(update_fields=["column"])

        mv = CardMovement.objects.create(
            card=self.card,
            from_column=self.col_todo,
            from_column_name="To Do",
            from_column_uid=self.col_todo.uid,
            to_column=self.col_done,
            to_column_name="Done",
            to_column_uid=self.col_done.uid,
            from_swimlane=self.swimlane,
            from_swimlane_name="Customer A",
            from_swimlane_uid=self.swimlane.uid,
            to_swimlane=self.swimlane,
            to_swimlane_name="Customer A",
            to_swimlane_uid=self.swimlane.uid,
            moved_by=self.admin,
            movement_type=CardMovement.MovementType.MOVE,
        )
        todo_uid = self.col_todo.uid
        done_uid = self.col_done.uid

        # Delete the original columns — SET_NULL on CardMovement FK, card survives
        self.col_todo.delete()
        self.col_done.delete()

        c = self._client_for(self.admin)
        resp = c.get(self._movements_url())
        self.assertEqual(resp.status_code, 200)

        result = resp.data["results"][0]
        # FK fields are null after deletion
        self.assertIsNone(result["from_column"])
        self.assertIsNone(result["to_column"])
        # Denormalized name/uid fields are preserved
        self.assertEqual(result["from_column_name"], "To Do")
        self.assertEqual(result["from_column_uid"], todo_uid)
        self.assertEqual(result["to_column_name"], "Done")
        self.assertEqual(result["to_column_uid"], done_uid)

    def test_movements_after_swimlane_deleted(self):
        """Deleting a swimlane must not break serialization of existing movements."""
        # Move the card to a safe swimlane so deleting self.swimlane doesn't
        # cascade-delete the card (Card.swimlane uses CASCADE).
        safe_swim = Swimlane.objects.create(board=self.board, name="Safe", position=99)
        self.card.swimlane = safe_swim
        self.card.save(update_fields=["swimlane"])

        mv = CardMovement.objects.create(
            card=self.card,
            from_column=self.col_todo,
            from_column_name="To Do",
            from_column_uid=self.col_todo.uid,
            to_column=self.col_done,
            to_column_name="Done",
            to_column_uid=self.col_done.uid,
            from_swimlane=self.swimlane,
            from_swimlane_name="Customer A",
            from_swimlane_uid=self.swimlane.uid,
            to_swimlane=self.swimlane,
            to_swimlane_name="Customer A",
            to_swimlane_uid=self.swimlane.uid,
            moved_by=self.admin,
            movement_type=CardMovement.MovementType.MOVE,
        )
        swimlane_uid = self.swimlane.uid

        # Delete the original swimlane — SET_NULL on CardMovement FK, card survives
        self.swimlane.delete()

        c = self._client_for(self.admin)
        resp = c.get(self._movements_url())
        self.assertEqual(resp.status_code, 200)

        result = resp.data["results"][0]
        # FK fields are null after deletion
        self.assertIsNone(result["from_swimlane"])
        self.assertIsNone(result["to_swimlane"])
        # Denormalized name/uid fields are preserved
        self.assertEqual(result["from_swimlane_name"], "Customer A")
        self.assertEqual(result["from_swimlane_uid"], swimlane_uid)
        self.assertEqual(result["to_swimlane_name"], "Customer A")
        self.assertEqual(result["to_swimlane_uid"], swimlane_uid)
