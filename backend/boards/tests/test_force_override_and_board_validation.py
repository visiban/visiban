"""Tests for weight-limit force-override RBAC and BoardSerializer validation (#592).

Covers:
- Weight-limit force-override: Collaborator and Viewer sending force=true on a
  weight-exceeded move receive 403; Admin succeeds (Member 403 already covered
  in test_weight_enforcement.py — this file adds Collaborator and Viewer)
- BoardSerializer.validate_stale_warning_pct:
  - Valid value 50 passes
  - Boundary 0 is accepted (minimum allowed)
  - Value 100 is accepted (maximum allowed)
  - Value 101 is rejected with 400
  - Negative value is rejected with 400
  - Non-integer string "foo" is rejected with 400
"""

from unittest.mock import patch

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, Column, Swimlane
from boards.serializers import BoardSerializer


PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"


# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------

def _make_board(owner, enforce_weight=True):
    board = Board.objects.create(
        name="Force Override Board",
        owner=owner,
        enforce_weight_limits=enforce_weight,
    )
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    return board


# ---------------------------------------------------------------------------
# Force-override RBAC for weight-exceeded moves (#592)
# ---------------------------------------------------------------------------

class ForceOverrideRbacTests(TestCase):
    """Collaborator and Viewer must receive 403 when using force=true.

    Admin success is included as a positive baseline.  Member 403 is already
    asserted in test_weight_enforcement.py (test_non_admin_force_override_returns_403);
    this class adds Collaborator and Viewer to complete role coverage.
    """

    def setUp(self):
        self._broadcast_patcher = patch(PATCH_BROADCAST)
        self._broadcast_patcher.start()

        self.client = APIClient()
        self.admin = User.objects.create_user(username="fo_admin", password="pass")
        self.collaborator = User.objects.create_user(username="fo_collab", password="pass")
        self.viewer = User.objects.create_user(username="fo_viewer", password="pass")

        self.board = _make_board(self.admin)
        BoardMembership.objects.create(
            board=self.board, user=self.collaborator, role=BoardMembership.Role.COLLABORATOR
        )
        BoardMembership.objects.create(
            board=self.board, user=self.viewer, role=BoardMembership.Role.VIEWER
        )

        # col_src has no limit; col_dst has a weight budget of 5
        self.col_src = Column.objects.create(board=self.board, name="Source", position=0)
        self.col_dst = Column.objects.create(
            board=self.board, name="Destination", position=1, weight_limit=5
        )
        self.swimlane = Swimlane.objects.create(board=self.board, name="General", position=0)

        # Fill col_dst so it's already over budget
        Card.objects.create(
            board=self.board, column=self.col_dst, swimlane=self.swimlane,
            title="Filler", created_by=self.admin, position=0, weight=5,
        )
        # Card to move — weight 3 would push col_dst to 8 > 5
        self.card = Card.objects.create(
            board=self.board, column=self.col_src, swimlane=self.swimlane,
            title="Moving Card", created_by=self.admin, position=0, weight=3,
        )

    def tearDown(self):
        self._broadcast_patcher.stop()

    def _move_url(self):
        return f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/move/"

    def _force_payload(self):
        return {"column_id": self.col_dst.pk, "swimlane_id": self.swimlane.pk, "position": 0}

    def test_admin_force_override_succeeds(self):
        """Board admin with force=true bypasses a weight-exceeded column (200)."""
        self.client.force_authenticate(self.admin)
        resp = self.client.post(self._move_url() + "?force=true", self._force_payload())
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_collaborator_force_override_returns_403(self):
        """Collaborator cannot use force=true to bypass weight limits — 403."""
        self.client.force_authenticate(self.collaborator)
        resp = self.client.post(self._move_url() + "?force=true", self._force_payload())
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_viewer_force_override_returns_403(self):
        """Viewer cannot use force=true to bypass weight limits — 403."""
        self.client.force_authenticate(self.viewer)
        resp = self.client.post(self._move_url() + "?force=true", self._force_payload())
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)


# ---------------------------------------------------------------------------
# BoardSerializer.validate_stale_warning_pct (#592)
# ---------------------------------------------------------------------------

class BoardSerializerStaleWarningPctTests(TestCase):
    """Unit tests for validate_stale_warning_pct validation logic."""

    def setUp(self):
        self.owner = User.objects.create_user(username="board_val_owner", password="pass")
        self.board = Board.objects.create(name="Val Board", owner=self.owner)
        BoardMembership.objects.create(board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def _patch_board(self, value, format="json"):
        return self.client.patch(
            f"/api/v1/boards/{self.board.pk}/",
            {"stale_warning_pct": value},
            format=format,
        )

    def test_valid_value_50_passes(self):
        """stale_warning_pct=50 is a normal valid value — 200 response."""
        with patch(PATCH_BROADCAST):
            resp = self._patch_board(50)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.board.refresh_from_db()
        self.assertEqual(self.board.stale_warning_pct, 50)

    def test_boundary_0_is_accepted(self):
        """stale_warning_pct=0 is the lower boundary and must be accepted."""
        with patch(PATCH_BROADCAST):
            resp = self._patch_board(0)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.board.refresh_from_db()
        self.assertEqual(self.board.stale_warning_pct, 0)

    def test_boundary_100_is_accepted(self):
        """stale_warning_pct=100 is the upper boundary and must be accepted."""
        with patch(PATCH_BROADCAST):
            resp = self._patch_board(100)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.board.refresh_from_db()
        self.assertEqual(self.board.stale_warning_pct, 100)

    def test_value_101_is_rejected(self):
        """stale_warning_pct=101 exceeds the maximum — 400 response."""
        resp = self._patch_board(101)
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_negative_value_is_rejected(self):
        """Negative stale_warning_pct is not allowed — 400 response."""
        resp = self._patch_board(-1)
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_non_integer_string_is_rejected(self):
        """Non-integer string 'foo' is not a valid stale_warning_pct — 400 response."""
        resp = self._patch_board("foo")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_direct_serializer_validation_50_passes(self):
        """Direct serializer unit: validate_stale_warning_pct(50) returns 50."""
        s = BoardSerializer()
        result = s.validate_stale_warning_pct(50)
        self.assertEqual(result, 50)

    def test_direct_serializer_validation_rejects_101(self):
        """Direct serializer unit: validate_stale_warning_pct(101) raises ValidationError."""
        from rest_framework.exceptions import ValidationError
        s = BoardSerializer()
        with self.assertRaises(ValidationError):
            s.validate_stale_warning_pct(101)

    def test_direct_serializer_validation_rejects_negative(self):
        """Direct serializer unit: validate_stale_warning_pct(-5) raises ValidationError."""
        from rest_framework.exceptions import ValidationError
        s = BoardSerializer()
        with self.assertRaises(ValidationError):
            s.validate_stale_warning_pct(-5)
