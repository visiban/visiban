"""Verify that views with explicit permission_classes reject unauthenticated requests (#518).

Each view listed in issue #518 previously relied on the global DRF default
permission classes. These tests confirm that the explicit declarations work
correctly by asserting 401 for unauthenticated callers.
"""

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient


class ExplicitPermissionClassesTests(TestCase):
    """Unauthenticated requests to views that now declare explicit permission_classes must return 401."""

    def setUp(self):
        self.client = APIClient()

    def test_user_search_requires_auth(self):
        r = self.client.get("/api/v1/users/", {"search": "test"})
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_notification_list_requires_auth(self):
        r = self.client.get("/api/v1/notifications/")
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_notification_mark_read_requires_auth(self):
        r = self.client.post("/api/v1/notifications/mark-read/", {"all": True})
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_notification_unread_count_requires_auth(self):
        r = self.client.get("/api/v1/notifications/unread-count/")
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_board_templates_requires_auth(self):
        r = self.client.get("/api/v1/boards/templates/")
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_version_requires_auth(self):
        r = self.client.get("/api/v1/version/")
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_serve_media_requires_auth(self):
        r = self.client.get("/media/attachments/test.txt")
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_board_viewset_declares_explicit_permission_classes(self):
        """BoardViewSet must enumerate the global default permission chain
        explicitly so future @action overrides can't silently drop the
        pending-change gates (#989).
        """
        from boards.views.boards import BoardViewSet
        from rest_framework.permissions import IsAuthenticated
        from visiban.permissions import (
            MustNotHavePendingPasswordChange,
            MustNotHavePendingUsernameChange,
        )
        self.assertIn(IsAuthenticated, BoardViewSet.permission_classes)
        self.assertIn(MustNotHavePendingPasswordChange, BoardViewSet.permission_classes)
        self.assertIn(MustNotHavePendingUsernameChange, BoardViewSet.permission_classes)

    def test_group_viewset_declares_explicit_permission_classes(self):
        """GroupViewSet must enumerate the global default permission chain
        explicitly so future @action overrides can't silently drop the
        pending-change gates (#989).
        """
        from groups.views import GroupViewSet
        from rest_framework.permissions import IsAuthenticated
        from visiban.permissions import (
            MustNotHavePendingPasswordChange,
            MustNotHavePendingUsernameChange,
        )
        self.assertIn(IsAuthenticated, GroupViewSet.permission_classes)
        self.assertIn(MustNotHavePendingPasswordChange, GroupViewSet.permission_classes)
        self.assertIn(MustNotHavePendingUsernameChange, GroupViewSet.permission_classes)

    def test_unsupported_version_requires_auth(self):
        """/api/vN/ for N != 1 returned 406 unauthenticated; #990 gates it on auth."""
        r = self.client.get("/api/v2/anything/")
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_board_scoped_viewsets_declare_explicit_permission_classes(self):
        """CardViewSet, ColumnViewSet, SwimlaneViewSet, and LabelViewSet must
        enumerate the global default permission chain explicitly (#1050) — the
        same hardening applied to BoardViewSet in #989 — so an accidental change
        to DEFAULT_PERMISSION_CLASSES cannot silently drop the auth gate on these
        high-value board-scoped resources without a visible diff.
        """
        from boards.views.cards import CardViewSet
        from boards.views.columns import ColumnViewSet
        from boards.views.swimlanes import SwimlaneViewSet
        from boards.views.labels import LabelViewSet
        from rest_framework.permissions import IsAuthenticated
        from visiban.permissions import (
            MustNotHavePendingPasswordChange,
            MustNotHavePendingUsernameChange,
        )
        for viewset in (CardViewSet, ColumnViewSet, SwimlaneViewSet, LabelViewSet):
            self.assertIn(IsAuthenticated, viewset.permission_classes, viewset.__name__)
            self.assertIn(MustNotHavePendingPasswordChange, viewset.permission_classes, viewset.__name__)
            self.assertIn(MustNotHavePendingUsernameChange, viewset.permission_classes, viewset.__name__)
