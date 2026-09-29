"""Tests for ColumnViewSet, SwimlaneViewSet, LabelViewSet, and utility views."""
import os
import subprocess
import sys
from unittest.mock import patch

from django.test import TestCase, override_settings
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Column, Swimlane, Label, Notification
from visiban.utils import normalize_app_version


PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"


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
            f"/api/v1/boards/{self.board.id}/columns/",
            {"name": "Review", "color": "#FF0000"},
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertEqual(r.json()["name"], "Review")

    @patch(PATCH_BROADCAST)
    def test_update_column(self, _):
        r = self.client.patch(
            f"/api/v1/boards/{self.board.id}/columns/{self.col.id}/",
            {"name": "Updated"},
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json()["name"], "Updated")

    @patch(PATCH_BROADCAST)
    def test_delete_column(self, _):
        r = self.client.delete(f"/api/v1/boards/{self.board.id}/columns/{self.col.id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(Column.objects.filter(pk=self.col.id).exists())

    @patch(PATCH_BROADCAST)
    def test_reorder_columns(self, _):
        col2 = Column.objects.create(board=self.board, name="Col2", position=1)
        r = self.client.post(
            f"/api/v1/boards/{self.board.id}/columns/reorder/",
            {"column_ids": [col2.id, self.col.id]},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_viewer_cannot_create_column(self):
        viewer = User.objects.create_user(username="viewer", password="pass")
        BoardMembership.objects.create(board=self.board, user=viewer, role=BoardMembership.Role.VIEWER)
        self.client.force_authenticate(viewer)
        r = self.client.post(
            f"/api/v1/boards/{self.board.id}/columns/",
            {"name": "X"},
        )
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND])

    @patch(PATCH_BROADCAST)
    def test_create_column_after_deletion_avoids_position_collision(self, _):
        # Reproduces: IntegrityError on columns_board_id_position unique constraint.
        # count()-based position is wrong when positions have gaps after deletion.
        col2 = Column.objects.create(board=self.board, name="Col2", position=1)
        self.client.delete(f"/api/v1/boards/{self.board.id}/columns/{self.col.id}/")
        # Board now has one column (col2 at position 1); count()=1 would collide with it.
        r = self.client.post(
            f"/api/v1/boards/{self.board.id}/columns/",
            {"name": "New", "color": "#123456"},
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        new_pos = Column.objects.get(pk=r.json()["id"]).position
        self.assertGreater(new_pos, col2.position)

    def test_create_column_duplicate_name_returns_400_not_500(self):
        # Reproduces #1166: IntegrityError on unique_together(board, name) at
        # perform_create previously reached the database unguarded.
        r = self.client.post(
            f"/api/v1/boards/{self.board.id}/columns/",
            {"name": self.col.name, "color": "#123456"},
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("name", r.json())

    @patch(PATCH_BROADCAST)
    def test_update_column_duplicate_name_returns_400_not_500(self, _):
        # Reproduces #1166: IntegrityError on unique_together(board, name) at
        # perform_update previously reached the database unguarded.
        col2 = Column.objects.create(board=self.board, name="Col2", position=1)
        r = self.client.patch(
            f"/api/v1/boards/{self.board.id}/columns/{col2.id}/",
            {"name": self.col.name},
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("name", r.json())

    @patch(PATCH_BROADCAST)
    def test_update_column_duplicate_position_returns_400_not_500(self, _):
        # Reproduces #1166: IntegrityError on unique_together(board, position) at
        # perform_update previously reached the database unguarded.
        col2 = Column.objects.create(board=self.board, name="Col2", position=1)
        r = self.client.patch(
            f"/api/v1/boards/{self.board.id}/columns/{col2.id}/",
            {"position": self.col.position},
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("position", r.json())

    def test_reorder_columns_with_non_integer_id_returns_400_not_500(self):
        # Reproduces #1166: ValueError from int("not-an-id") previously reached
        # the caller unguarded.
        r = self.client.post(
            f"/api/v1/boards/{self.board.id}/columns/reorder/",
            {"order": ["not-an-id"]},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("order", r.json())


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
            f"/api/v1/boards/{self.board.id}/swimlanes/",
            {"name": "Customer B", "color": "#00FF00"},
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertEqual(r.json()["name"], "Customer B")

    @patch(PATCH_BROADCAST)
    def test_update_swimlane(self, _):
        r = self.client.patch(
            f"/api/v1/boards/{self.board.id}/swimlanes/{self.swim.id}/",
            {"name": "Renamed"},
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json()["name"], "Renamed")

    @patch(PATCH_BROADCAST)
    def test_delete_swimlane(self, _):
        r = self.client.delete(f"/api/v1/boards/{self.board.id}/swimlanes/{self.swim.id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(Swimlane.objects.filter(pk=self.swim.id).exists())

    @patch(PATCH_BROADCAST)
    def test_reorder_swimlanes(self, _):
        swim2 = Swimlane.objects.create(board=self.board, name="Swim2", position=1)
        r = self.client.post(
            f"/api/v1/boards/{self.board.id}/swimlanes/reorder/",
            {"swimlane_ids": [swim2.id, self.swim.id]},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_reorder_swimlanes_with_non_integer_id_returns_400_not_500(self):
        # Reproduces #1166: ValueError from int("not-an-id") previously reached
        # the caller unguarded.
        r = self.client.post(
            f"/api/v1/boards/{self.board.id}/swimlanes/reorder/",
            {"order": ["not-an-id"]},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("order", r.json())

    def test_create_swimlane_duplicate_name_returns_400_not_500(self):
        # Reproduces #1276 (#1166 missed swimlanes): IntegrityError on
        # unique_together(board, name) at perform_create previously reached the
        # database unguarded.
        r = self.client.post(
            f"/api/v1/boards/{self.board.id}/swimlanes/",
            {"name": self.swim.name, "color": "#123456"},
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("name", r.json())

    @patch(PATCH_BROADCAST)
    def test_update_swimlane_duplicate_name_returns_400_not_500(self, _):
        # Reproduces #1276 (#1166 missed swimlanes): IntegrityError on
        # unique_together(board, name) at perform_update previously reached the
        # database unguarded.
        swim2 = Swimlane.objects.create(board=self.board, name="Swim2", position=1)
        r = self.client.patch(
            f"/api/v1/boards/{self.board.id}/swimlanes/{swim2.id}/",
            {"name": self.swim.name},
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("name", r.json())


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
            f"/api/v1/boards/{self.board.id}/labels/",
            {"name": "Bug", "color": "#FF0000"},
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertEqual(r.json()["name"], "Bug")

    @patch(PATCH_BROADCAST)
    def test_create_label_duplicate_name_returns_400_not_500(self, _):
        # Reproduces #1166: IntegrityError on unique_together(board, name) at
        # perform_create previously reached the database unguarded.
        Label.objects.create(board=self.board, name="Bug", color="#F00")
        r = self.client.post(
            f"/api/v1/boards/{self.board.id}/labels/",
            {"name": "Bug", "color": "#FF0000"},
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("name", r.json())

    @patch(PATCH_BROADCAST)
    def test_update_label(self, _):
        label = Label.objects.create(board=self.board, name="Bug", color="#F00")
        r = self.client.patch(
            f"/api/v1/boards/{self.board.id}/labels/{label.id}/",
            {"name": "Feature"},
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json()["name"], "Feature")

    @patch(PATCH_BROADCAST)
    def test_update_label_duplicate_name_returns_400_not_500(self, _):
        # Reproduces #1166: IntegrityError on unique_together(board, name) at
        # perform_update previously reached the database unguarded. The issue's
        # AC only listed POST, but perform_update was hardened the same way
        # since the same constraint applies to a rename.
        Label.objects.create(board=self.board, name="Bug", color="#F00")
        label2 = Label.objects.create(board=self.board, name="Feature", color="#0F0")
        r = self.client.patch(
            f"/api/v1/boards/{self.board.id}/labels/{label2.id}/",
            {"name": "Bug"},
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("name", r.json())

    @patch(PATCH_BROADCAST)
    def test_delete_label(self, _):
        label = Label.objects.create(board=self.board, name="Bug", color="#F00")
        r = self.client.delete(f"/api/v1/boards/{self.board.id}/labels/{label.id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(Label.objects.filter(pk=label.id).exists())

    def test_list_labels(self):
        Label.objects.create(board=self.board, name="Bug", color="#F00")
        Label.objects.create(board=self.board, name="Feature", color="#0F0")
        r = self.client.get(f"/api/v1/boards/{self.board.id}/labels/")
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
            action_type=Notification.ActionType.STALE,
        )

    def test_list_notifications(self):
        r = self.client.get("/api/v1/notifications/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(len(r.json()), 1)
        self.assertEqual(r.json()[0]["verb"], "Test notification")

    def test_unread_count(self):
        r = self.client.get("/api/v1/notifications/unread-count/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json()["count"], 1)

    def test_mark_read_by_ids(self):
        r = self.client.post(
            "/api/v1/notifications/mark-read/",
            {"ids": [self.notif.id]},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.notif.refresh_from_db()
        self.assertTrue(self.notif.read)

    def test_mark_all_read(self):
        Notification.objects.create(
            recipient=self.user, verb="Second", board=self.board,
            action_type=Notification.ActionType.STALE,
        )
        r = self.client.post("/api/v1/notifications/mark-read/", {"all": True}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        unread = Notification.objects.filter(recipient=self.user, read=False).count()
        self.assertEqual(unread, 0)

    def test_unread_count_after_mark_read(self):
        self.notif.read = True
        self.notif.save()
        r = self.client.get("/api/v1/notifications/unread-count/")
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
        r = self.client.get("/api/v1/version/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIn("version", r.json())

    @override_settings(APP_VERSION="1.1.0")
    def test_version_serves_bare_semver(self):
        """#1174 — settings.APP_VERSION is already normalized by the time the
        view reads it, so the view itself just needs to pass it through."""
        r = self.client.get("/api/v1/version/")
        self.assertEqual(r.json()["version"], "1.1.0")


class NormalizeAppVersionTests(TestCase):
    """#1174 — APP_VERSION doubles as the (v-prefixed) compose/Helm image
    tag operators pin in .env, but GET /api/v1/version/ promises bare
    semver (docs/api/version.md). override_settings can't exercise the
    strip itself (it sets the already-computed settings value directly,
    bypassing env parsing), so the normalizing helper is unit-tested here
    with the raw inputs it must handle."""

    def test_strips_leading_v(self):
        self.assertEqual(normalize_app_version("v1.1.0"), "1.1.0")

    def test_leaves_bare_version_unchanged(self):
        self.assertEqual(normalize_app_version("1.1.0"), "1.1.0")

    def test_leaves_dev_default_unchanged(self):
        self.assertEqual(normalize_app_version("dev"), "dev")

    def test_strips_leading_v_on_prerelease(self):
        self.assertEqual(normalize_app_version("v1.2.0-rc.1"), "1.2.0-rc.1")


class SettingsAppVersionWiringTests(TestCase):
    """#1174 — proves visiban/settings.py actually applies
    normalize_app_version() to the env value, not just that the helper
    works in isolation (NormalizeAppVersionTests above). The already-
    running test process imported settings.py long ago, and
    override_settings only overwrites the already-computed attribute, so
    neither can catch a dropped call at L634. Re-running django.setup()
    in a subprocess with a controlled APP_VERSION re-executes settings.py
    from scratch against it.

    Negative control (run by hand, not committed): removing the
    normalize_app_version(...) call at settings.py's APP_VERSION
    assignment makes this test fail — it prints "v9.9.9", not "9.9.9".
    """

    def test_settings_module_normalizes_app_version_from_env(self):
        from django.conf import settings as django_settings

        subprocess_env = {**os.environ, "APP_VERSION": "v9.9.9"}
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                "import django, os; "
                "os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'visiban.settings'); "
                "django.setup(); "
                "from django.conf import settings; "
                "print(settings.APP_VERSION)",
            ],
            cwd=str(django_settings.BASE_DIR),
            env=subprocess_env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(
            result.returncode, 0, f"subprocess failed: {result.stderr}"
        )
        self.assertEqual(
            result.stdout.strip(),
            "9.9.9",
            f"settings.py did not normalize APP_VERSION=v9.9.9 -- "
            f"stdout={result.stdout!r} stderr={result.stderr!r}",
        )
