"""Tests for API version negotiation (#679, #680).

Covers:
- GET /api/v2/boards/ returns HTTP 406 Not Acceptable (unsupported version)
- GET /api/v1/boards/ returns the OffsetCountPagination envelope with correct
  defaults: count (int), offset=0, page_size=50, results (list)
"""

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient, APIRequestFactory

from accounts.models import User
from boards.models import Board, BoardMembership
from visiban.urls import UnsupportedVersionView


class ApiVersioningTests(TestCase):
    """Version negotiation via URLPathVersioning."""

    def setUp(self):
        self.user = User.objects.create_user(username="ver_user", password="pass")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_unsupported_version_returns_406(self):
        """#679 — authenticated /api/v2/boards/ returns HTTP 406 (unsupported version)."""
        r = self.client.get("/api/v2/boards/")
        self.assertEqual(r.status_code, status.HTTP_406_NOT_ACCEPTABLE)

    def test_unsupported_version_unauthenticated_returns_401(self):
        """#990 — unauthenticated callers must not learn the version-negotiation
        message; they get 401 like every other authenticated endpoint.
        """
        anon = APIClient()
        r = anon.get("/api/v2/boards/")
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_v1_boards_returns_pagination_envelope(self):
        """#680 — /api/v1/boards/ wraps results in the OffsetCountPagination envelope."""
        # Create a board so results is non-empty (easier to assert structure)
        board = Board.objects.create(name="Test Board", owner=self.user)
        BoardMembership.objects.create(board=board, user=self.user, role=BoardMembership.Role.ADMIN)

        r = self.client.get("/api/v1/boards/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)

        data = r.json()
        self.assertIn("count", data)
        self.assertIn("offset", data)
        self.assertIn("page_size", data)
        self.assertIn("results", data)

        # Default pagination values
        self.assertEqual(data["offset"], 0)
        self.assertEqual(data["page_size"], 50)

        # results must be a list
        self.assertIsInstance(data["results"], list)

    def test_v1_boards_count_matches_results_length_for_small_set(self):
        """When total boards fit in a single page, count equals len(results)."""
        board = Board.objects.create(name="Single Board", owner=self.user)
        BoardMembership.objects.create(board=board, user=self.user, role=BoardMembership.Role.ADMIN)

        r = self.client.get("/api/v1/boards/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        data = r.json()
        self.assertEqual(data["count"], len(data["results"]))

    def test_v1_boards_unauthenticated_returns_401(self):
        """Unauthenticated request to a versioned endpoint returns 401."""
        anon = APIClient()
        r = anon.get("/api/v1/boards/")
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)
