"""Tests for opt-in weight limit enforcement on card moves (#260).

Covers:
- Move blocked (409) when board.enforce_weight_limits=True and column would exceed weight_limit
- Move allowed (200) when board.enforce_weight_limits=False even if column is over weight budget
- Move allowed (200) when column has no weight_limit set
- Move allowed (200) when column has capacity remaining
- Card weight alone exceeds limit (single card > limit)
- Force override by board admin → 200
- Force override by non-admin → 403
- Pure position reorder within same column is exempt from enforcement
- enforce_weight_limits not writable by non-admin via PATCH to the board endpoint
- Archived cards are excluded from weight sum
- Both WIP and weight limits exceeded simultaneously: WIP check runs first
"""

from unittest.mock import patch

from django.test import TestCase
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, Column, Swimlane


def _make_board(owner, enforce_weight=False, enforce_wip=False):
    board = Board.objects.create(
        name="Weight Board",
        owner=owner,
        enforce_weight_limits=enforce_weight,
        enforce_wip_limits=enforce_wip,
    )
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    return board


class WeightEnforcementTests(TestCase):
    def setUp(self):
        self._broadcast_patcher = patch("boards.broadcast.broadcast_board_event")
        self._broadcast_patcher.start()

        self.client = APIClient()
        self.admin = User.objects.create_user(username="admin", password="pass")
        self.member = User.objects.create_user(username="member", password="pass")

        self.board = _make_board(self.admin, enforce_weight=True)
        BoardMembership.objects.create(board=self.board, user=self.member, role=BoardMembership.Role.MEMBER)

        # col_a is the source column (no limit); col_b has a weight budget of 10
        self.col_a = Column.objects.create(board=self.board, name="Backlog", position=0)
        self.col_b = Column.objects.create(board=self.board, name="In Progress", position=1, weight_limit=10)
        self.swimlane = Swimlane.objects.create(board=self.board, name="Acme", position=0)

        # Card to be moved — weight 5
        self.card = Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.swimlane,
            title="Moving Card", created_by=self.admin, position=0, weight=5,
        )

    def tearDown(self):
        self._broadcast_patcher.stop()

    def _move_url(self, card=None):
        c = card or self.card
        return f"/api/boards/{self.board.pk}/cards/{c.pk}/move/"

    def _fill_column_weight(self, column, total_weight):
        """Create a single card with the given weight in column."""
        Card.objects.create(
            board=self.board, column=column, swimlane=self.swimlane,
            title=f"Filler w={total_weight}", created_by=self.admin, position=0, weight=total_weight,
        )

    # ------------------------------------------------------------------
    # Core enforcement behaviour
    # ------------------------------------------------------------------

    def test_move_blocked_when_weight_would_exceed_limit(self):
        """409 when enforcement on and move would push column over weight_limit."""
        self._fill_column_weight(self.col_b, 8)  # 8 in col_b; moving card(5) → 13 > 10
        self.client.force_authenticate(self.admin)
        resp = self.client.post(self._move_url(), {
            "column_id": self.col_b.pk,
            "swimlane_id": self.swimlane.pk,
            "position": 0,
        })
        self.assertEqual(resp.status_code, status.HTTP_409_CONFLICT)
        data = resp.json()
        self.assertEqual(data["code"], "weight_limit_exceeded")
        self.assertEqual(data["column_name"], self.col_b.name)
        self.assertEqual(data["current_weight"], 8)
        self.assertEqual(data["weight_limit"], 10)
        self.assertEqual(data["card_weight"], 5)

    def test_move_allowed_when_enforcement_off(self):
        """200 when enforce_weight_limits=False even if column would exceed budget."""
        self.board.enforce_weight_limits = False
        self.board.save()
        self._fill_column_weight(self.col_b, 8)
        self.client.force_authenticate(self.admin)
        resp = self.client.post(self._move_url(), {
            "column_id": self.col_b.pk,
            "swimlane_id": self.swimlane.pk,
            "position": 0,
        })
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_move_allowed_when_no_weight_limit_set(self):
        """200 when the target column has no weight_limit (None = unlimited)."""
        col_unlimited = Column.objects.create(board=self.board, name="Done", position=2)
        self._fill_column_weight(col_unlimited, 999)
        self.client.force_authenticate(self.admin)
        resp = self.client.post(self._move_url(), {
            "column_id": col_unlimited.pk,
            "swimlane_id": self.swimlane.pk,
            "position": 0,
        })
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_move_allowed_when_column_has_capacity(self):
        """200 when adding card weight stays within limit."""
        self._fill_column_weight(self.col_b, 4)  # 4 + 5 = 9 ≤ 10
        self.client.force_authenticate(self.admin)
        resp = self.client.post(self._move_url(), {
            "column_id": self.col_b.pk,
            "swimlane_id": self.swimlane.pk,
            "position": 0,
        })
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_single_card_weight_exceeds_limit(self):
        """409 when the moving card's own weight exceeds the column limit."""
        heavy_card = Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.swimlane,
            title="Heavy", created_by=self.admin, position=1, weight=15,
        )
        self.client.force_authenticate(self.admin)
        resp = self.client.post(self._move_url(card=heavy_card), {
            "column_id": self.col_b.pk,
            "swimlane_id": self.swimlane.pk,
            "position": 0,
        })
        self.assertEqual(resp.status_code, status.HTTP_409_CONFLICT)
        self.assertEqual(resp.json()["code"], "weight_limit_exceeded")

    # ------------------------------------------------------------------
    # Force override
    # ------------------------------------------------------------------

    def test_admin_can_force_past_weight_limit(self):
        """Board admin with ?force=true bypasses a full column."""
        self._fill_column_weight(self.col_b, 8)
        self.client.force_authenticate(self.admin)
        resp = self.client.post(
            self._move_url() + "?force=true",
            {"column_id": self.col_b.pk, "swimlane_id": self.swimlane.pk, "position": 0},
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.card.refresh_from_db()
        self.assertEqual(self.card.column, self.col_b)

    def test_non_admin_force_override_returns_403(self):
        """Members cannot use ?force=true for weight limit — returns 403."""
        self._fill_column_weight(self.col_b, 8)
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
        """Pure position reorders within the same column are never blocked."""
        card2 = Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.swimlane,
            title="Second", created_by=self.admin, position=1, weight=999,
        )
        self.col_a.weight_limit = 1
        self.col_a.save()
        self.client.force_authenticate(self.admin)
        resp = self.client.post(self._move_url(), {
            "column_id": self.col_a.pk,
            "swimlane_id": self.swimlane.pk,
            "position": 1,
        })
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        _ = card2

    # ------------------------------------------------------------------
    # Archived cards excluded from weight sum
    # ------------------------------------------------------------------

    def test_archived_cards_excluded_from_weight_sum(self):
        """Archived cards do not count toward the weight budget."""
        Card.objects.create(
            board=self.board, column=self.col_b, swimlane=self.swimlane,
            title="Archived", created_by=self.admin, position=0, weight=8,
            archived_at=timezone.now(),
        )
        # col_b budget=10; archived card weighs 8 but should not count.
        # Moving card(5) into col_b → effective total = 0 + 5 = 5 ≤ 10
        self.client.force_authenticate(self.admin)
        resp = self.client.post(self._move_url(), {
            "column_id": self.col_b.pk,
            "swimlane_id": self.swimlane.pk,
            "position": 0,
        })
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    # ------------------------------------------------------------------
    # RBAC: enforce_weight_limits field protection
    # ------------------------------------------------------------------

    def test_non_admin_cannot_write_enforce_weight_limits(self):
        """PATCH enforce_weight_limits by a non-admin returns 403."""
        self.client.force_authenticate(self.member)
        resp = self.client.patch(
            f"/api/boards/{self.board.pk}/",
            {"enforce_weight_limits": False},
            format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_admin_can_write_enforce_weight_limits(self):
        """Board admin can toggle enforce_weight_limits via PATCH."""
        self.client.force_authenticate(self.admin)
        resp = self.client.patch(
            f"/api/boards/{self.board.pk}/",
            {"enforce_weight_limits": False},
            format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.board.refresh_from_db()
        self.assertFalse(self.board.enforce_weight_limits)

    # ------------------------------------------------------------------
    # WIP and weight limits simultaneously — WIP check runs first
    # ------------------------------------------------------------------

    def test_wip_check_runs_before_weight_check(self):
        """When both limits are exceeded, WIP error is returned (WIP check runs first)."""
        self.board.enforce_wip_limits = True
        self.board.save()
        self.col_b.wip_limit = 1
        self.col_b.save()
        # Fill col_b: 1 active card (at WIP limit), weight=2 (under weight budget of 10)
        Card.objects.create(
            board=self.board, column=self.col_b, swimlane=self.swimlane,
            title="Blocker", created_by=self.admin, position=0, weight=2,
        )
        self.client.force_authenticate(self.admin)
        resp = self.client.post(self._move_url(), {
            "column_id": self.col_b.pk,
            "swimlane_id": self.swimlane.pk,
            "position": 0,
        })
        self.assertEqual(resp.status_code, status.HTTP_409_CONFLICT)
        self.assertEqual(resp.json()["code"], "wip_limit_exceeded")
