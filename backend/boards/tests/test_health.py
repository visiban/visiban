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
    def test_readiness_200_degraded_on_cache_failure(self, mock_set):
        """A Valkey outage must not unready the pod (#1465): 200, status degraded."""
        mock_set.side_effect = Exception("Redis connection refused")
        with self.assertLogs("boards.views.health", level="WARNING") as logs:
            resp = self.client.get("/api/health/readiness/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.json(), {"status": "degraded"})
        self.assertTrue(any("cache" in r.getMessage() for r in logs.records))

    @patch("django.db.backends.base.base.BaseDatabaseWrapper.ensure_connection")
    @patch("django.core.cache.cache.set")
    def test_readiness_503_when_db_down_even_if_cache_down(self, mock_set, mock_ensure):
        """DB failure still fails readiness; the cache is not named in errors."""
        mock_ensure.side_effect = Exception("DB connection refused")
        mock_set.side_effect = Exception("Redis connection refused")
        resp = self.client.get("/api/health/readiness/")
        self.assertEqual(resp.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertEqual(
            resp.json(), {"status": "error", "errors": {"db": "unavailable"}}
        )

    @patch("django.db.backends.base.base.BaseDatabaseWrapper.ensure_connection")
    @patch("django.core.cache.cache.set")
    def test_readiness_failure_body_has_no_exception_text(self, mock_set, mock_ensure):
        """The anonymous failure response carries only component names and a fixed value."""
        mock_ensure.side_effect = Exception("host=10.1.2.3 port=5432 user=svc dbname=prod")
        mock_set.side_effect = Exception("redis://cache.internal:6379 refused")
        with self.assertLogs("boards.views.health", level="WARNING") as logs:
            resp = self.client.get("/api/health/readiness/")
        self.assertEqual(resp.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertEqual(
            resp.json(),
            {"status": "error", "errors": {"db": "unavailable"}},
        )
        # The detail goes to the server log, with the exception attached.
        logged = " ".join(str(r.exc_info[1]) for r in logs.records if r.exc_info)
        self.assertIn("10.1.2.3", logged)
        self.assertIn("cache.internal", logged)
        body = resp.content.decode()
        for fragment in ("10.1.2.3", "5432", "svc", "prod", "cache.internal", "6379"):
            self.assertNotIn(fragment, body)

    @patch("django.core.cache.cache.get")
    @patch("django.core.cache.cache.set")
    def test_readiness_makes_one_cache_round_trip(self, mock_set, mock_get):
        """One SET, no GET: each cache call can cost a full socket timeout when
        Valkey is black-holed, and the probe must answer inside 1 second (#1465)."""
        resp = self.client.get("/api/health/readiness/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.json(), {"status": "ok"})
        mock_set.assert_called_once()
        mock_get.assert_not_called()
