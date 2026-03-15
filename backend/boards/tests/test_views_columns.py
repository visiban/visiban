"""Tests for ColumnViewSet, SwimlaneViewSet, LabelViewSet, and utility views."""
from unittest.mock import patch

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Column, Swimlane, Label, Notification


PATCH_BROADCAST = "boards.views.broadcast_board_event"


def _make_board(owner):
    board = Board.objects.create(name="B", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Col1", position=0, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="Swim1", position=0)
    return board, col, swim


# ---------------------------------------------------------------------------
# Columns
# ---------------------------------------------------------------------------

class ColumnCRUDTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="pass")
        self.board, self.col, _ = _make_board(self.admin)
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    @patch(PATCH_BROADCAST)
    def test_create_column(self, _):
        r = self.client.post(
            f"/api/boards/{self.board.id}/columns/",
            {"name": "Review", "color": "#FF0000"},
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertEqual(r.json()["name"], "Review")

    @patch(PATCH_BROADCAST)
    def test_update_column(self, _):
        r = self.client.patch(
            f"/api/boards/{self.board.id}/columns/{self.col.id}/",
            {"name": "Updated"},
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json()["name"], "Updated")

    @patch(PATCH_BROADCAST)
    def test_delete_column(self, _):
        r = self.client.delete(f"/api/boards/{self.board.id}/columns/{self.col.id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(Column.objects.filter(pk=self.col.id).exists())

    @patch(PATCH_BROADCAST)
    def test_reorder_columns(self, _):
        col2 = Column.objects.create(board=self.board, name="Col2", position=1)
        r = self.client.post(
            f"/api/boards/{self.board.id}/columns/reorder/",
            {"column_ids": [col2.id, self.col.id]},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_viewer_cannot_create_column(self):
        viewer = User.objects.create_user(username="viewer", password="pass")
        BoardMembership.objects.create(board=self.board, user=viewer, role=BoardMembership.Role.VIEWER)
        self.client.force_authenticate(viewer)
        r = self.client.post(
            f"/api/boards/{self.board.id}/columns/",
            {"name": "X"},
        )
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND])

    @patch(PATCH_BROADCAST)
    def test_create_column_after_deletion_avoids_position_collision(self, _):
        # Reproduces: IntegrityError on columns_board_id_position unique constraint.
        # count()-based position is wrong when positions have gaps after deletion.
        col2 = Column.objects.create(board=self.board, name="Col2", position=1)
        self.client.delete(f"/api/boards/{self.board.id}/columns/{self.col.id}/")
        # Board now has one column (col2 at position 1); count()=1 would collide with it.
        r = self.client.post(
            f"/api/boards/{self.board.id}/columns/",
            {"name": "New", "color": "#123456"},
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        new_pos = Column.objects.get(pk=r.json()["id"]).position
        self.assertGreater(new_pos, col2.position)


# ---------------------------------------------------------------------------
# Swimlanes
# ---------------------------------------------------------------------------

class SwimlaneCRUDTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="pass")
        self.board, _, self.swim = _make_board(self.admin)
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    @patch(PATCH_BROADCAST)
    def test_create_swimlane(self, _):
        r = self.client.post(
            f"/api/boards/{self.board.id}/swimlanes/",
            {"name": "Customer B", "color": "#00FF00"},
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertEqual(r.json()["name"], "Customer B")

    @patch(PATCH_BROADCAST)
    def test_update_swimlane(self, _):
        r = self.client.patch(
            f"/api/boards/{self.board.id}/swimlanes/{self.swim.id}/",
            {"name": "Renamed"},
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json()["name"], "Renamed")

    @patch(PATCH_BROADCAST)
    def test_delete_swimlane(self, _):
        r = self.client.delete(f"/api/boards/{self.board.id}/swimlanes/{self.swim.id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(Swimlane.objects.filter(pk=self.swim.id).exists())

    @patch(PATCH_BROADCAST)
    def test_reorder_swimlanes(self, _):
        swim2 = Swimlane.objects.create(board=self.board, name="Swim2", position=1)
        r = self.client.post(
            f"/api/boards/{self.board.id}/swimlanes/reorder/",
            {"swimlane_ids": [swim2.id, self.swim.id]},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)


# ---------------------------------------------------------------------------
# Labels
# ---------------------------------------------------------------------------

class LabelCRUDTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="pass")
        self.board, _, _ = _make_board(self.admin)
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    @patch(PATCH_BROADCAST)
    def test_create_label(self, _):
        r = self.client.post(
            f"/api/boards/{self.board.id}/labels/",
            {"name": "Bug", "color": "#FF0000"},
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertEqual(r.json()["name"], "Bug")

    @patch(PATCH_BROADCAST)
    def test_update_label(self, _):
        label = Label.objects.create(board=self.board, name="Bug", color="#F00")
        r = self.client.patch(
            f"/api/boards/{self.board.id}/labels/{label.id}/",
            {"name": "Feature"},
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json()["name"], "Feature")

    @patch(PATCH_BROADCAST)
    def test_delete_label(self, _):
        label = Label.objects.create(board=self.board, name="Bug", color="#F00")
        r = self.client.delete(f"/api/boards/{self.board.id}/labels/{label.id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(Label.objects.filter(pk=label.id).exists())

    def test_list_labels(self):
        Label.objects.create(board=self.board, name="Bug", color="#F00")
        Label.objects.create(board=self.board, name="Feature", color="#0F0")
        r = self.client.get(f"/api/boards/{self.board.id}/labels/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(len(r.json()["results"]), 2)


# ---------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------

class NotificationViewTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, _, _ = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.notif = Notification.objects.create(
            recipient=self.user,
            verb="Test notification",
            board=self.board,
        )

    def test_list_notifications(self):
        r = self.client.get("/api/notifications/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(len(r.json()), 1)
        self.assertEqual(r.json()[0]["verb"], "Test notification")

    def test_unread_count(self):
        r = self.client.get("/api/notifications/unread-count/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json()["count"], 1)

    def test_mark_read_by_ids(self):
        r = self.client.post(
            "/api/notifications/mark-read/",
            {"ids": [self.notif.id]},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.notif.refresh_from_db()
        self.assertTrue(self.notif.read)

    def test_mark_all_read(self):
        Notification.objects.create(recipient=self.user, verb="Second", board=self.board)
        r = self.client.post("/api/notifications/mark-read/", {"all": True}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        unread = Notification.objects.filter(recipient=self.user, read=False).count()
        self.assertEqual(unread, 0)

    def test_unread_count_after_mark_read(self):
        self.notif.read = True
        self.notif.save()
        r = self.client.get("/api/notifications/unread-count/")
        self.assertEqual(r.json()["count"], 0)


# ---------------------------------------------------------------------------
# Version
# ---------------------------------------------------------------------------

class VersionViewTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_version_returns_string(self):
        r = self.client.get("/api/version/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIn("version", r.json())
