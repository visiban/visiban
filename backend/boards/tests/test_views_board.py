"""Tests for BoardViewSet actions: full, summary, analytics, members, destroy."""
from unittest.mock import patch

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

import datetime

from django.utils import timezone

from accounts.models import User
from boards.models import Board, BoardMembership, Card, CardMovement, Column, Swimlane


PATCH_BROADCAST = "boards.views.broadcast_board_event"


def _make_board(owner, name="Board"):
    board = Board.objects.create(name=name, owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col, swim


class BoardDestroyTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.other = User.objects.create_user(username="other", password="pass")
        self.board, _, _ = _make_board(self.owner)
        self.client = APIClient()

    @patch(PATCH_BROADCAST)
    def test_owner_can_delete_board(self, _):
        self.client.force_authenticate(self.owner)
        r = self.client.delete(f"/api/boards/{self.board.id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(Board.objects.filter(pk=self.board.id).exists())

    def test_non_owner_cannot_delete_board(self):
        self.client.force_authenticate(self.other)
        r = self.client.delete(f"/api/boards/{self.board.id}/")
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND])


class BoardFullTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, self.swim = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_full_returns_board_structure(self):
        r = self.client.get(f"/api/boards/{self.board.id}/full/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        data = r.json()
        self.assertIn("columns", data)
        self.assertIn("swimlanes", data)
        self.assertIn("cards", data)

    def test_full_non_member_blocked(self):
        stranger = User.objects.create_user(username="stranger", password="pass")
        self.client.force_authenticate(stranger)
        r = self.client.get(f"/api/boards/{self.board.id}/full/")
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND])


class BoardSummaryTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, self.swim = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_summary_returns_swimlanes(self):
        r = self.client.get(f"/api/boards/{self.board.id}/summary/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        data = r.json()
        self.assertIn("swimlanes", data)
        self.assertEqual(len(data["swimlanes"]), 1)
        row = data["swimlanes"][0]
        self.assertIn("velocity_7d", row)
        self.assertIn("velocity_30d", row)
        self.assertIn("stage_distribution", row)

    def test_summary_counts_cards(self):
        Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="T", created_by=self.user, position=0,
        )
        r = self.client.get(f"/api/boards/{self.board.id}/summary/")
        row = r.json()["swimlanes"][0]
        self.assertEqual(row["total_cards"], 1)
        self.assertEqual(row["stage_distribution"]["Backlog"], 1)


class BoardAnalyticsTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, self.swim = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_analytics_returns_expected_keys(self):
        r = self.client.get(f"/api/boards/{self.board.id}/analytics/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        data = r.json()
        self.assertIn("swimlanes", data)
        self.assertIn("columns", data)

    def test_analytics_custom_days_param(self):
        r = self.client.get(f"/api/boards/{self.board.id}/analytics/?days=7")
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_analytics_stalled_days_param_is_ignored(self):
        """stalled_days is no longer a query param — it comes from the board setting."""
        r = self.client.get(f"/api/boards/{self.board.id}/analytics/?stalled_days=3")
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_analytics_non_integer_days_returns_400(self):
        r = self.client.get(f"/api/boards/{self.board.id}/analytics/?days=abc")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_analytics_zero_days_returns_400(self):
        r = self.client.get(f"/api/boards/{self.board.id}/analytics/?days=0")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_analytics_negative_days_returns_400(self):
        r = self.client.get(f"/api/boards/{self.board.id}/analytics/?days=-5")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_analytics_days_exceeds_cap_returns_400(self):
        r = self.client.get(f"/api/boards/{self.board.id}/analytics/?days=366")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("365", r.json()["detail"])

    def test_analytics_stalled_days_exceeds_cap_returns_400(self):
        r = self.client.get(f"/api/boards/{self.board.id}/analytics/?stalled_days=91")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("90", r.json()["detail"])

    def test_analytics_period_filter_affects_dwell_times(self):
        """Period window clamps dwell time so all periods show non-null heatmap data.

        A card that entered "Done" 60 days ago and is still there should:
        - Show ~5d dwell in "Backlog" for 90d (entered 65d ago, left 60d ago — within window)
        - Show null in "Backlog" for 7d (entire Backlog dwell was >7 days ago — skipped)
        - Show ~7d dwell in "Done" for 7d (clamped: entered 60d ago but window is 7d)
        - Show ~60d dwell in "Done" for 90d (full dwell since entry)
        """
        col2 = Column.objects.create(board=self.board, name="Done", position=1)
        card = Card.objects.create(
            board=self.board, column=col2, swimlane=self.swim,
            title="Old card", created_by=self.user, position=0,
        )
        # Creation movement 65 days ago (outside 7d and 30d windows, inside 90d)
        old_ts = timezone.now() - datetime.timedelta(days=65)
        mv = CardMovement.objects.create(
            card=card,
            from_column=None, to_column=self.col,
            from_column_name="", to_column_name=self.col.name,
            from_column_uid="", to_column_uid=self.col.uid,
            from_swimlane_name="", to_swimlane_name=self.swim.name,
            from_swimlane_uid="", to_swimlane_uid=self.swim.uid,
            moved_by=self.user,
        )
        CardMovement.objects.filter(pk=mv.pk).update(moved_at=old_ts)
        # Transition movement 60 days ago — card has been in "Done" ever since
        transition_ts = timezone.now() - datetime.timedelta(days=60)
        mv2 = CardMovement.objects.create(
            card=card,
            from_column=self.col, to_column=col2,
            from_column_name=self.col.name, to_column_name=col2.name,
            from_column_uid=self.col.uid, to_column_uid=col2.uid,
            from_swimlane=self.swim, to_swimlane=self.swim,
            from_swimlane_name=self.swim.name, to_swimlane_name=self.swim.name,
            from_swimlane_uid=self.swim.uid, to_swimlane_uid=self.swim.uid,
            moved_by=self.user,
        )
        CardMovement.objects.filter(pk=mv2.pk).update(moved_at=transition_ts)

        r7 = self.client.get(f"/api/boards/{self.board.id}/analytics/?days=7").json()
        r90 = self.client.get(f"/api/boards/{self.board.id}/analytics/?days=90").json()

        medians_7 = r7["board_medians"]
        medians_90 = r90["board_medians"]

        # Backlog dwell (65→60 days ago) is entirely outside the 7d window — null.
        self.assertIsNone(medians_7.get("Backlog"), "7d should exclude Backlog dwell that ended 60d ago")
        # Backlog dwell is inside the 90d window — non-null (~5 days).
        self.assertIsNotNone(medians_90.get("Backlog"), "90d should include the ~5d Backlog dwell")

        # Done dwell: card entered 60d ago and is still there.
        # 7d clamps entry to period_cutoff — dwell ≈ 7 days (non-null).
        self.assertIsNotNone(medians_7.get("Done"), "7d should show clamped dwell for card still in Done")
        # 90d uses full entry time — dwell ≈ 60 days.
        self.assertIsNotNone(medians_90.get("Done"), "90d should show full dwell for card still in Done")
        done_7 = medians_7["Done"]
        done_90 = medians_90["Done"]
        self.assertLess(done_7, done_90, "clamped 7d dwell should be less than unclamped 90d dwell")


class BoardMembersTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="pass")
        self.board, _, _ = _make_board(self.admin)
        self.target = User.objects.create_user(username="target", password="pass")
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    @patch(PATCH_BROADCAST)
    def test_admin_can_add_member(self, _):
        r = self.client.post(
            f"/api/boards/{self.board.id}/members/",
            {"user_id": self.target.id, "role": "member"},
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertTrue(
            BoardMembership.objects.filter(board=self.board, user=self.target).exists()
        )

    @patch(PATCH_BROADCAST)
    def test_admin_can_remove_member(self, _):
        BoardMembership.objects.create(board=self.board, user=self.target, role=BoardMembership.Role.MEMBER)
        r = self.client.delete(f"/api/boards/{self.board.id}/members/{self.target.id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(
            BoardMembership.objects.filter(board=self.board, user=self.target).exists()
        )

    def test_non_admin_cannot_add_member(self):
        viewer = User.objects.create_user(username="viewer", password="pass")
        BoardMembership.objects.create(board=self.board, user=viewer, role=BoardMembership.Role.VIEWER)
        self.client.force_authenticate(viewer)
        r = self.client.post(
            f"/api/boards/{self.board.id}/members/",
            {"user_id": self.target.id, "role": "member"},
        )
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_cannot_modify_site_admin_membership(self):
        site_admin = User.objects.create_user(username="sa", password="pass", is_site_admin=True)
        r = self.client.post(
            f"/api/boards/{self.board.id}/members/",
            {"user_id": site_admin.id, "role": "viewer"},
        )
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
