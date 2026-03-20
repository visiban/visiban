"""Tests for opt-in WIP limit enforcement on card moves (#231).

Covers:
- Move blocked (409) when board.enforce_wip_limits=True and column is at limit
- Move allowed (200) when board.enforce_wip_limits=False even if column is at limit
- Move allowed (200) when column has no wip_limit set
- Move allowed (200) when column has capacity remaining
- Force override by board admin → 200
- Force override by non-admin → 403
- Pure position reorder within same column is exempt from enforcement
- enforce_wip_limits not writable by non-admin via PATCH to the board endpoint
- Archived cards are excluded from WIP count
"""

from unittest.mock import patch

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Column, Swimlane, Card
from django.utils import timezone


def _make_board(owner, enforce=False):
    board = Board.objects.create(name="WIP Board", owner=owner, enforce_wip_limits=enforce)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    return board


class WipEnforcementTests(TestCase):
    def setUp(self):
        self._broadcast_patcher = patch("boards.views.broadcast_board_event")
        self._broadcast_patcher.start()

        self.client = APIClient()
        self.admin = User.objects.create_user(username="admin", password="pass")
        self.member = User.objects.create_user(username="member", password="pass")

        self.board = _make_board(self.admin, enforce=True)
        BoardMembership.objects.create(board=self.board, user=self.member, role=BoardMembership.Role.MEMBER)

        # col_a is the source column (no limit); col_b has a WIP limit of 2
        self.col_a = Column.objects.create(board=self.board, name="Backlog", position=0)
        self.col_b = Column.objects.create(board=self.board, name="In Progress", position=1, wip_limit=2)
        self.swimlane = Swimlane.objects.create(board=self.board, name="Acme", position=0)

        # Card to be moved
        self.card = Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.swimlane,
            title="Moving Card", created_by=self.admin, position=0,
        )

    def tearDown(self):
        self._broadcast_patcher.stop()

    def _move_url(self, card=None):
        c = card or self.card
        return f"/api/boards/{self.board.pk}/cards/{c.pk}/move/"

    def _fill_column(self, column, count):
        """Create `count` active cards in `column` for the same board and swimlane."""
        for i in range(count):
            Card.objects.create(
                board=self.board, column=column, swimlane=self.swimlane,
                title=f"Filler {i}", created_by=self.admin, position=i,
            )

    # ------------------------------------------------------------------
    # Core enforcement behaviour
    # ------------------------------------------------------------------

    def test_move_blocked_when_at_wip_limit(self):
        """409 returned when enforcement is on and target column is at its limit."""
        self._fill_column(self.col_b, 2)  # col_b is now at limit=2
        self.client.force_authenticate(self.admin)
        resp = self.client.post(self._move_url(), {
            "column_id": self.col_b.pk,
            "swimlane_id": self.swimlane.pk,
            "position": 0,
        })
        self.assertEqual(resp.status_code, status.HTTP_409_CONFLICT)
        data = resp.json()
        self.assertEqual(data["code"], "wip_limit_exceeded")
        self.assertEqual(data["column_name"], self.col_b.name)
        self.assertEqual(data["current_count"], 2)
        self.assertEqual(data["wip_limit"], 2)

    def test_move_allowed_when_enforcement_off(self):
        """200 when enforce_wip_limits=False even if column is at or over its WIP limit."""
        self.board.enforce_wip_limits = False
        self.board.save()
        self._fill_column(self.col_b, 2)
        self.client.force_authenticate(self.admin)
        resp = self.client.post(self._move_url(), {
            "column_id": self.col_b.pk,
            "swimlane_id": self.swimlane.pk,
            "position": 0,
        })
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_move_allowed_when_no_wip_limit_set(self):
        """200 when the target column has no wip_limit (None = unlimited)."""
        col_unlimited = Column.objects.create(board=self.board, name="Done", position=2)
        self._fill_column(col_unlimited, 100)
        self.client.force_authenticate(self.admin)
        resp = self.client.post(self._move_url(), {
            "column_id": col_unlimited.pk,
            "swimlane_id": self.swimlane.pk,
            "position": 0,
        })
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_move_allowed_when_column_has_capacity(self):
        """200 when target column has room (count < wip_limit)."""
        self._fill_column(self.col_b, 1)  # 1 card; limit is 2
        self.client.force_authenticate(self.admin)
        resp = self.client.post(self._move_url(), {
            "column_id": self.col_b.pk,
            "swimlane_id": self.swimlane.pk,
            "position": 0,
        })
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    # ------------------------------------------------------------------
    # Force override
    # ------------------------------------------------------------------

    def test_admin_can_force_past_wip_limit(self):
        """Board admin with ?force=true bypasses a full column."""
        self._fill_column(self.col_b, 2)
        self.client.force_authenticate(self.admin)
        resp = self.client.post(
            self._move_url() + "?force=true",
            {"column_id": self.col_b.pk, "swimlane_id": self.swimlane.pk, "position": 0},
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.card.refresh_from_db()
        self.assertEqual(self.card.column, self.col_b)

    def test_non_admin_force_override_returns_403(self):
        """Members cannot use ?force=true — returns 403."""
        self._fill_column(self.col_b, 2)
        self.client.force_authenticate(self.member)
        resp = self.client.post(
            self._move_url() + "?force=true",
            {"column_id": self.col_b.pk, "swimlane_id": self.swimlane.pk, "position": 0},
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    # ------------------------------------------------------------------
    # Same-column reorder exemption
    # ------------------------------------------------------------------

    def test_reorder_within_same_column_is_exempt(self):
        """Pure position reorders within the same column are never blocked by WIP enforcement."""
        # Add a second card in col_a so we have something to reorder against
        card2 = Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.swimlane,
            title="Second", created_by=self.admin, position=1,
        )
        # Fill col_a to artificially exceed any hypothetical limit — enforcement
        # only applies when column_changed is True, so this should be 200.
        self.col_a.wip_limit = 1
        self.col_a.save()
        self.client.force_authenticate(self.admin)
        resp = self.client.post(self._move_url(), {
            "column_id": self.col_a.pk,
            "swimlane_id": self.swimlane.pk,
            "position": 1,
        })
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        _ = card2  # suppress unused-variable warning

    # ------------------------------------------------------------------
    # Archived cards excluded from count
    # ------------------------------------------------------------------

    def test_archived_cards_excluded_from_wip_count(self):
        """Archived cards do not count toward the WIP limit."""
        archived = Card.objects.create(
            board=self.board, column=self.col_b, swimlane=self.swimlane,
            title="Archived", created_by=self.admin, position=0,
            archived_at=timezone.now(),
        )
        active = Card.objects.create(
            board=self.board, column=self.col_b, swimlane=self.swimlane,
            title="Active", created_by=self.admin, position=1,
        )
        # col_b limit is 2; only 1 active card, so move should succeed
        self.client.force_authenticate(self.admin)
        resp = self.client.post(self._move_url(), {
            "column_id": self.col_b.pk,
            "swimlane_id": self.swimlane.pk,
            "position": 0,
        })
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        _ = archived, active  # suppress unused-variable warning

    # ------------------------------------------------------------------
    # RBAC: enforce_wip_limits field protection
    # ------------------------------------------------------------------

    def test_non_admin_cannot_write_enforce_wip_limits(self):
        """PATCH enforce_wip_limits by a non-admin returns 403."""
        self.client.force_authenticate(self.member)
        resp = self.client.patch(
            f"/api/boards/{self.board.pk}/",
            {"enforce_wip_limits": False},
            format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_admin_can_write_enforce_wip_limits(self):
        """Board admin can toggle enforce_wip_limits via PATCH."""
        self.client.force_authenticate(self.admin)
        resp = self.client.patch(
            f"/api/boards/{self.board.pk}/",
            {"enforce_wip_limits": False},
            format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.board.refresh_from_db()
        self.assertFalse(self.board.enforce_wip_limits)
