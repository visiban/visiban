"""Tests for BoardViewSet actions: full, summary, analytics, members, destroy."""
from unittest.mock import patch

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Column, Swimlane, Card


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
        r = self.client.get(f"/api/boards/{self.board.id}/analytics/?days=7&stalled_days=3")
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_analytics_non_integer_days_returns_400(self):
        r = self.client.get(f"/api/boards/{self.board.id}/analytics/?days=abc")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_analytics_non_integer_stalled_days_returns_400(self):
        r = self.client.get(f"/api/boards/{self.board.id}/analytics/?stalled_days=xyz")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_analytics_zero_days_returns_400(self):
        r = self.client.get(f"/api/boards/{self.board.id}/analytics/?days=0")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_analytics_negative_days_returns_400(self):
        r = self.client.get(f"/api/boards/{self.board.id}/analytics/?days=-5")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_analytics_negative_stalled_days_returns_400(self):
        r = self.client.get(f"/api/boards/{self.board.id}/analytics/?stalled_days=-1")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)


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
