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

    def _move(self, from_column, to_column, moved_at):
        """A movement of self.card at moved_at; from_column=None makes it the creation row."""
        mv = CardMovement.objects.create(
            card=self.card,
            from_column=from_column, from_column_name=from_column.name if from_column else "",
            to_column=to_column, to_column_name=to_column.name,
            from_swimlane=self.swimlane, from_swimlane_name="Customer A",
            to_swimlane=self.swimlane, to_swimlane_name="Customer A",
            moved_by=self.admin,
            movement_type=CardMovement.MovementType.MOVE,
        )
        # Queryset update: CardMovement.save() refuses an existing row (#1469).
        CardMovement.objects.filter(pk=mv.pk).update(moved_at=moved_at)

    def test_avg_cycle_days_computed(self):
        """avg_cycle_days runs from the first pull out of the creation column to
        the first done entry (#448); before it started at the creation movement."""
        now = timezone.now()
        col_doing = Column.objects.create(board=self.board, name="Doing", position=2)
        self._move(None, self.col_todo, now - datetime.timedelta(days=9))
        self._move(self.col_todo, col_doing, now - datetime.timedelta(days=2))
        self._move(col_doing, self.col_done, now - datetime.timedelta(hours=1))
        Card.objects.filter(pk=self.card.pk).update(column=self.col_done)

        c = self._client_for(self.admin)
        resp = c.get(self._summary_url())
        avg = resp.data["swimlanes"][0]["avg_cycle_days"]
        # Should be approximately 2 days (may differ by seconds in CI)
        self.assertIsNotNone(avg)
        self.assertAlmostEqual(avg, 1.96, delta=0.1)

    def test_avg_cycle_days_null_for_a_card_moved_straight_to_done(self):
        """A zero-length cycle is bookkeeping: the card counts toward velocity, not cycle time."""
        now = timezone.now()
        self._move(None, self.col_todo, now - datetime.timedelta(days=9))
        self._move(self.col_todo, self.col_done, now - datetime.timedelta(hours=1))
        Card.objects.filter(pk=self.card.pk).update(column=self.col_done)

        row = self._client_for(self.admin).get(self._summary_url()).data["swimlanes"][0]
        self.assertIsNone(row["avg_cycle_days"])
        self.assertEqual(row["velocity_7d"], 1)

    def test_velocity_counts_a_card_once_when_it_moves_between_done_columns(self):
        """Done → Released is not a new completion; before #448 it counted twice."""
        now = timezone.now()
        col_released = Column.objects.create(board=self.board, name="Released", position=2, is_done=True)
        self._move(None, self.col_todo, now - datetime.timedelta(days=9))
        self._move(self.col_todo, self.col_done, now - datetime.timedelta(days=3))
        self._move(self.col_done, col_released, now - datetime.timedelta(days=1))
        Card.objects.filter(pk=self.card.pk).update(column=col_released)

        row = self._client_for(self.admin).get(self._summary_url()).data["swimlanes"][0]
        self.assertEqual((row["velocity_7d"], row["velocity_30d"], row["done_30d"]), (1, 1, 1))

    def test_velocity_keeps_a_card_archived_after_its_completion(self):
        """Archiving finished work does not unfinish it; before #448 it left the count."""
        now = timezone.now()
        self._move(None, self.col_todo, now - datetime.timedelta(days=9))
        self._move(self.col_todo, self.col_done, now - datetime.timedelta(days=3))
        Card.objects.filter(pk=self.card.pk).update(column=self.col_done, archived_at=now)

        row = self._client_for(self.admin).get(self._summary_url()).data["swimlanes"][0]
        self.assertEqual(row["velocity_7d"], 1)

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

    def test_valid_extension_panel_passes_through_unchanged(self):
        """A registered panel dict is returned verbatim in extension_panels (#1770)."""
        from boards import hooks as _hooks

        panel = {
            "id": "p1",
            "title": "Panel",
            "type": "stats",
            "data": {"items": [{"label": "A", "value": 1}]},
        }

        def _good_panel(board, request):
            return panel

        _hooks.ANALYTICS_EXTENSIONS.append(_good_panel)
        try:
            c = self._client_for(self.admin)
            resp = c.get(self._summary_url())
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.data["extension_panels"], [panel])
        finally:
            _hooks.ANALYTICS_EXTENSIONS.remove(_good_panel)

    def _summary_with_panels(self, *panels_or_fns):
        """Register callables returning each value, GET the summary, always unregister."""
        from boards import hooks as _hooks

        fns = [(lambda board, request, _v=v: _v) for v in panels_or_fns]
        _hooks.ANALYTICS_EXTENSIONS.extend(fns)
        try:
            return self._client_for(self.admin).get(self._summary_url())
        finally:
            for fn in fns:
                _hooks.ANALYTICS_EXTENSIONS.remove(fn)

    def test_invalid_extension_panels_are_dropped_not_500(self):
        """NaN, inf, unserializable and non-dict panels are dropped; the rest renders (#1770).

        DRF's renderer raises on these after the view returns, so without the
        per-panel check the whole summary (swimlanes included) would 500.
        """
        good = {"id": "ok", "title": "OK", "type": "stats", "data": {"items": [{"label": "A", "value": 1}]}}
        bad = [
            {"id": "nan", "title": "t", "type": "stats", "data": {"items": [{"label": "A", "value": float("nan")}]}},
            {"id": "inf", "title": "t", "type": "stats", "data": {"items": [{"label": "A", "value": float("inf")}]}},
            {"id": "obj", "title": "t", "type": "stats", "data": {"items": [object()]}},
            ["not", "a", "dict"],
            None,
        ]
        resp = self._summary_with_panels(bad[0], bad[1], bad[2], bad[3], bad[4], good)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["extension_panels"], [good])
        self.assertEqual(len(resp.data["swimlanes"]), 1)

    def test_lone_surrogate_panels_are_dropped_not_500(self):
        """A lone surrogate passes ensure_ascii json.dumps but crashes the UTF-8 renderer (#1770)."""
        good = {"id": "ok", "title": "OK", "type": "stats", "data": {"items": [{"label": "A", "value": 1}]}}
        bad = [
            {"id": "t", "title": "bad \ud800", "type": "stats", "data": {"items": []}},
            {"id": "n", "title": "t", "type": "stats", "data": {"items": [{"label": "A", "value": "x\udc00"}]}},
            {"id": "k", "title": "t", "type": "stats", "data": {"\ud800": 1}},
        ]
        resp = self._summary_with_panels(*bad, good)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["extension_panels"], [good])
        self.assertEqual(len(resp.data["swimlanes"]), 1)

    def test_valid_unicode_panel_passes_through_unchanged(self):
        panel = {"id": "u", "title": "Risk \U0001F680 \u4e2d\u6587", "type": "stats", "data": {"items": [{"label": "\u00e9", "value": "\u65e5\u672c"}]}}
        resp = self._summary_with_panels(panel)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["extension_panels"], [panel])

    def test_drop_warning_never_includes_exception_text(self):
        from boards import hooks as _hooks

        def _raises(board, request):
            raise RuntimeError("SECRET-EXC-TEXT")

        _hooks.ANALYTICS_EXTENSIONS.append(_raises)
        try:
            with self.assertLogs("boards.views.analytics", level="WARNING") as cm:
                resp = self._client_for(self.admin).get(self._summary_url())
        finally:
            _hooks.ANALYTICS_EXTENSIONS.remove(_raises)
        self.assertEqual(resp.status_code, 200)
        self.assertNotIn("SECRET", "\n".join(cm.output))
        self.assertIsNone(cm.records[0].exc_info)

        class _Unserializable:
            def __repr__(self):
                return "SECRET-REPR"

        with self.assertLogs("boards.views.analytics", level="WARNING") as cm:
            self._summary_with_panels({"id": "x", "title": "t", "data": {"v": _Unserializable()}})
        self.assertNotIn("SECRET", "\n".join(cm.output))
        self.assertIsNone(cm.records[0].exc_info)

    def test_generator_in_panel_is_not_exhausted_by_validation(self):
        panel = {"id": "g", "title": "G", "type": "stats", "data": {"items": (x for x in [{"label": "A", "value": 1}])}}
        resp = self._summary_with_panels(panel)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["extension_panels"][0]["data"]["items"], [{"label": "A", "value": 1}])

    def test_dropped_panel_warning_never_logs_panel_contents(self):
        secret = {"id": "s", "title": "SECRET-TITLE", "type": "stats", "data": {"items": [float("nan")]}}
        with self.assertLogs("boards.views.analytics", level="WARNING") as cm:
            self._summary_with_panels(secret)
        self.assertNotIn("SECRET", "\n".join(cm.output))

    def test_faulty_extension_panel_returns_200_with_empty_panels(self):
        """A raising ANALYTICS_EXTENSIONS callable must not crash the summary endpoint (#904).

        The per-callable try/except must catch the exception, log a warning, and
        continue — the response must still be HTTP 200 with extension_panels: [].
        """
        from boards import hooks as _hooks

        def _bad_panel(board, request):
            raise RuntimeError("simulated extension failure")

        _hooks.ANALYTICS_EXTENSIONS.append(_bad_panel)
        try:
            c = self._client_for(self.admin)
            resp = c.get(self._summary_url())
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.data["extension_panels"], [])
        finally:
            _hooks.ANALYTICS_EXTENSIONS.remove(_bad_panel)

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
    """Callers with no access to the board must receive 404 on /analytics/ and /summary/ (#702)."""

    def setUp(self):
        super().setUp()
        self.non_member = User.objects.create_user(username="stranger", password="pw")

    def test_non_member_cannot_access_analytics(self):
        c = self._client_for(self.non_member)
        resp = c.get(self._analytics_url())
        self.assertEqual(resp.status_code, 404)

    def test_non_member_cannot_access_summary(self):
        c = self._client_for(self.non_member)
        resp = c.get(self._summary_url())
        self.assertEqual(resp.status_code, 404)

    def test_non_member_cannot_access_movements(self):
        c = self._client_for(self.non_member)
        resp = c.get(self._movements_url())
        self.assertEqual(resp.status_code, 404)


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

        CardMovement.objects.create(
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

        CardMovement.objects.create(
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


class TestMovementExportGate(AnalyticsHistorySetup):
    """``?export=`` honors ``export_min_role`` and writes an audit row (#1432)."""

    def _export(self, user, fmt="csv", response=None):
        from unittest.mock import MagicMock, patch
        from django.http import HttpResponse

        backend = MagicMock(return_value=response or HttpResponse("ok"))
        with patch("boards.hooks.MOVEMENT_EXPORT_BACKENDS", [backend]):
            resp = self._client_for(user).get(f"{self._movements_url()}?export={fmt}")
        return resp, backend

    def test_below_min_role_refused_without_dispatch_or_log(self):
        from boards.models import BoardExportLog

        self.board.export_min_role = "admin"
        self.board.save()
        resp, backend = self._export(self.viewer)
        self.assertEqual(resp.status_code, 403)
        self.assertEqual(resp.data["code"], "export_restricted")
        self.assertEqual(resp.data["min_role"], "admin")
        backend.assert_not_called()
        self.assertEqual(BoardExportLog.objects.count(), 0)

    def test_unrecognized_threshold_refused_as_admin_only(self):
        """#1725 — a stored value outside the allowed set reports ``admin``."""
        from boards.models import Board

        Board.objects.filter(pk=self.board.pk).update(export_min_role="admins")
        resp, backend = self._export(self.member)
        self.assertEqual(resp.status_code, 403)
        self.assertEqual(resp.data["min_role"], "admin")
        backend.assert_not_called()

    def test_allowed_role_dispatches_and_logs_once(self):
        from boards.models import BoardExportLog

        self.board.export_min_role = "member"
        self.board.save()
        resp, backend = self._export(self.member, "xlsx")
        self.assertEqual(resp.status_code, 200)
        backend.assert_called_once()
        log = BoardExportLog.objects.get()
        self.assertEqual(log.board_id, self.board.pk)
        self.assertEqual(log.actor_id, self.member.pk)
        self.assertEqual(log.role_at_export, "member")
        self.assertEqual(log.export_format, "movements_xlsx")

    def test_default_threshold_lets_viewer_export(self):
        from boards.models import BoardExportLog

        resp, backend = self._export(self.viewer)
        self.assertEqual(resp.status_code, 200)
        backend.assert_called_once()
        self.assertEqual(BoardExportLog.objects.count(), 1)

    def test_owner_bypasses_threshold(self):
        self.board.export_min_role = "admin"
        self.board.save()
        resp, _ = self._export(self.admin)
        self.assertEqual(resp.status_code, 200)

    def test_long_format_is_truncated_for_log(self):
        from boards.models import BoardExportLog

        self._export(self.member, "x" * 60)
        self.assertEqual(len(BoardExportLog.objects.get().export_format), 20)

    def test_no_backend_registered_is_unchanged(self):
        """OSS path: ?export= falls through to the JSON page, no audit row."""
        from boards.models import BoardExportLog

        self.board.export_min_role = "admin"
        self.board.save()
        resp = self._client_for(self.viewer).get(f"{self._movements_url()}?export=csv")
        self.assertEqual(resp.status_code, 200)
        self.assertIn("results", resp.data)
        self.assertEqual(BoardExportLog.objects.count(), 0)

    def test_format_is_normalized_for_log(self):
        from boards.models import BoardExportLog

        self._export(self.member, " XLSX ")
        self.assertEqual(BoardExportLog.objects.get().export_format, "movements_xlsx")

    def test_failed_backend_response_writes_no_log(self):
        from django.http import HttpResponse
        from boards.models import BoardExportLog

        resp, backend = self._export(self.member, response=HttpResponse("no", status=500))
        self.assertEqual(resp.status_code, 500)
        backend.assert_called_once()
        self.assertEqual(BoardExportLog.objects.count(), 0)

    def test_site_admin_bypasses_threshold_and_is_logged(self):
        from boards.models import BoardExportLog

        self.board.export_min_role = "admin"
        self.board.save()
        site = User.objects.create_user(username="site", password="pw", can_access_all_content=True)
        resp, _ = self._export(site)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(BoardExportLog.objects.get().role_at_export, "site_admin")

    def test_group_inherited_admin_meets_threshold(self):
        from boards.models import BoardExportLog
        from groups.models import Group, GroupMembership

        group = Group.objects.create(name="G", owner=self.admin)
        self.board.group = group
        self.board.export_min_role = "admin"
        self.board.save()
        gadmin = User.objects.create_user(username="gadmin", password="pw")
        GroupMembership.objects.create(group=group, user=gadmin, role=GroupMembership.Role.ADMIN)
        resp, backend = self._export(gadmin)
        self.assertEqual(resp.status_code, 200)
        backend.assert_called_once()
        self.assertEqual(BoardExportLog.objects.count(), 1)

    def test_group_inherited_non_admin_refused(self):
        from groups.models import Group, GroupMembership

        group = Group.objects.create(name="G", owner=self.admin)
        self.board.group = group
        self.board.export_min_role = "admin"
        self.board.save()
        gmember = User.objects.create_user(username="gmember", password="pw")
        GroupMembership.objects.create(group=group, user=gmember, role=GroupMembership.Role.MEMBER)
        resp, backend = self._export(gmember)
        self.assertEqual(resp.status_code, 403)
        backend.assert_not_called()

    def test_export_is_throttled_but_plain_reads_are_not(self):
        from unittest.mock import patch
        from django.core.cache import cache
        from boards.models import BoardExportLog

        cache.clear()
        with patch("boards.views.import_export.BoardExportThrottle.get_rate", return_value="1/hour"):
            first, _ = self._export(self.member)
            second, backend = self._export(self.member)
            plain = [self._client_for(self.member).get(self._movements_url()) for _ in range(3)]
        cache.clear()
        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 429)
        backend.assert_not_called()
        self.assertTrue(all(r.status_code == 200 for r in plain))
        self.assertEqual(BoardExportLog.objects.count(), 1)
