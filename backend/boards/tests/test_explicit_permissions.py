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
        r = self.client.get("/api/users/", {"search": "test"})
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_notification_list_requires_auth(self):
        r = self.client.get("/api/notifications/")
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_notification_mark_read_requires_auth(self):
        r = self.client.post("/api/notifications/mark-read/", {"all": True})
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_notification_unread_count_requires_auth(self):
        r = self.client.get("/api/notifications/unread-count/")
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_board_templates_requires_auth(self):
        r = self.client.get("/api/boards/templates/")
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_version_requires_auth(self):
        r = self.client.get("/api/version/")
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_serve_media_requires_auth(self):
        r = self.client.get("/media/attachments/test.txt")
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)
