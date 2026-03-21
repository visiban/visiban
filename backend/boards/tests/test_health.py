"""Tests for LivenessView and ReadinessView health-check endpoints."""
from unittest.mock import patch

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient


class LivenessViewTests(TestCase):
    """GET /api/health/liveness/ returns 200 unconditionally."""

    def setUp(self):
        self.client = APIClient()

    def test_liveness_returns_200(self):
        resp = self.client.get("/api/health/liveness/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.json(), {"status": "ok"})

    def test_liveness_no_auth_required(self):
        """Liveness probe must work without any authentication token."""
        resp = self.client.get("/api/health/liveness/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)


class ReadinessViewTests(TestCase):
    """GET /api/health/readiness/ checks DB and Redis; returns 200 or 503."""

    def setUp(self):
        self.client = APIClient()

    def test_readiness_ok_when_db_and_cache_healthy(self):
        """Returns 200 {"status": "ok"} when both DB and cache are reachable."""
        resp = self.client.get("/api/health/readiness/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.json()["status"], "ok")

    def test_readiness_no_auth_required(self):
        """Readiness probe must work without any authentication token."""
        resp = self.client.get("/api/health/readiness/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    @patch("django.db.backends.base.base.BaseDatabaseWrapper.ensure_connection")
    def test_readiness_503_on_db_failure(self, mock_ensure):
        """Returns 503 with errors.db set when the database is unreachable."""
        mock_ensure.side_effect = Exception("DB connection refused")
        resp = self.client.get("/api/health/readiness/")
        self.assertEqual(resp.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        data = resp.json()
        self.assertEqual(data["status"], "error")
        self.assertIn("db", data["errors"])

    @patch("django.core.cache.cache.set")
    def test_readiness_503_on_cache_failure(self, mock_set):
        """Returns 503 with errors.redis set when the cache backend is unreachable."""
        mock_set.side_effect = Exception("Redis connection refused")
        resp = self.client.get("/api/health/readiness/")
        self.assertEqual(resp.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        data = resp.json()
        self.assertEqual(data["status"], "error")
        self.assertIn("redis", data["errors"])
