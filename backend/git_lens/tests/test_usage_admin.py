"""Admin lens-usage endpoint (#1061): RBAC, board-outcome counters, bounds.

Requires GIT_LENS_ENABLED (routes and the git_lens app are only mounted then);
skips cleanly otherwise, like test_api.py. The flag-off 404 is covered in
test_metrics.py.
"""
import pytest
from django.conf import settings

if not settings.GIT_LENS_ENABLED:  # pragma: no cover - exercised only in the flagged CI job
    pytest.skip(
        "git_lens experiment disabled; set GIT_LENS_ENABLED=true to run these.",
        allow_module_level=True,
    )

import time
from unittest.mock import MagicMock, patch

from django.core.cache import cache
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.admin_views import _ADMIN_PERMISSIONS
from boards.tests.conftest import _make_board, _make_user
from git_lens import metrics, providers, views
from git_lens.models import LensConnection
from git_lens.tests.test_api import _fake_lens_data
from git_lens.types import LensConfig, LensFilters

USAGE_URL = "/api/v1/admin/git-lens/usage/"


class UsageEndpointRBACTests(TestCase):
    def setUp(self):
        cache.clear()
        self.admin = _make_user("usage_admin", is_site_admin=True)
        self.user = _make_user("usage_user")

    def _get(self, user=None):
        c = APIClient()
        if user is not None:
            c.force_authenticate(user)
        return c.get(USAGE_URL)

    def test_site_admin_can_read(self):
        resp = self._get(self.admin)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        for key in ("generated_at", "window_hours", "current_hour", "last_24h", "hourly", "bounds"):
            self.assertIn(key, resp.data)
        self.assertEqual(set(resp.data["last_24h"]), {"github", "gitlab"})

    def test_non_admin_is_forbidden(self):
        self.assertEqual(self._get(self.user).status_code, status.HTTP_403_FORBIDDEN)

    def test_anonymous_is_denied(self):
        self.assertIn(
            self._get().status_code,
            (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN),
        )

    def test_admin_with_pending_password_change_is_forbidden(self):
        self.admin.must_change_password = True
        self.admin.save()
        self.assertEqual(self._get(self.admin).status_code, status.HTTP_403_FORBIDDEN)

    def test_uses_the_shared_admin_permission_chain(self):
        self.assertIs(views.LensUsageAdminView.permission_classes, _ADMIN_PERMISSIONS)

    def test_is_read_only(self):
        c = APIClient()
        c.force_authenticate(self.admin)
        for method in (c.post, c.put, c.patch, c.delete):
            self.assertEqual(method(USAGE_URL, {}).status_code, status.HTTP_405_METHOD_NOT_ALLOWED)

    def test_reports_outbound_counts(self):
        metrics.record_outbound("gitlab", "issues", "ok", status_code=200, duration_ms=5, repo="g/p")
        metrics.record_outbound("gitlab", "issues", "rate_limited", status_code=429, duration_ms=5, repo="g/p")
        data = self._get(self.admin).data
        self.assertEqual(data["last_24h"]["gitlab"]["outbound_calls"], 2)
        self.assertEqual(data["current_hour"]["gitlab"]["outbound_by_kind"]["issues"]["rate_limited"], 1)
        self.assertEqual(sum(h["outbound_calls"]["gitlab"] for h in data["hourly"]), 2)


class BoundsTests(TestCase):
    def test_bounds_are_derived_from_live_constants(self):
        b = views.lens_bounds()
        self.assertEqual(b["fetch_budget_per_user_repo"], views.LENS_FETCH_BUDGET)
        self.assertEqual(b["fetch_budget_per_user"], views.LENS_USER_FETCH_BUDGET)
        self.assertEqual(
            b["max_outbound_calls_per_fetch"],
            providers.MAX_PAGES + 2 * providers.MAX_AUX_PAGES + 1,
        )
        self.assertEqual(
            b["max_outbound_calls_per_user_per_window"],
            views.LENS_USER_FETCH_BUDGET * b["max_outbound_calls_per_fetch"],
        )

    @patch("git_lens.providers.requests.get")
    def test_worst_case_fetch_makes_exactly_the_reported_number_of_calls(self, mock_get):
        """The reported per-fetch bound is tight: a GitHub pipeline fetch with a
        milestone filter against a repo where every page is full hits it exactly —
        and the counters record every one of those calls."""
        cache.clear()
        full_issues = [{"number": n, "title": "x"} for n in range(providers.PER_PAGE)]
        full_aux = [{"name": f"b{n}", "number": n} for n in range(providers.PER_PAGE)]

        def fake_get(url, **kwargs):
            if url.endswith("/milestones"):
                return MagicMock(status_code=200, headers={},
                                 json=MagicMock(return_value=[{"title": "m", "number": 1}]))
            data = full_issues if url.endswith("/issues") else full_aux
            return MagicMock(status_code=200, headers={}, json=MagicMock(return_value=data))

        mock_get.side_effect = fake_get
        providers.github_fetch(
            "tok", "o/r", LensConfig(column_dim="pipeline"), LensFilters(milestone="m")
        )
        bound = views.lens_bounds()["max_outbound_calls_per_fetch"]
        self.assertEqual(mock_get.call_count, bound)
        self.assertEqual(metrics.snapshot()["last_24h"]["github"]["outbound_calls"], bound)


class BoardOutcomeCounterTests(TestCase):
    """One board outcome per ``_serve_board`` return path."""

    def setUp(self):
        cache.clear()
        self.owner = _make_user("usage_owner")
        self.board = _make_board(self.owner)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        self.url = f"/api/v1/git-lens/board/{self.board.id}/"
        LensConnection.objects.create(
            board=self.board, provider="gitlab", repo_slug="g/p",
            column_dim="status", created_by=self.owner,
        )

    def _counts(self):
        return metrics.snapshot()["last_24h"]["gitlab"]["board_requests"]

    def _only(self, **expected):
        counts = self._counts()
        for outcome in metrics.BOARD_OUTCOMES:
            self.assertEqual(counts[outcome], expected.get(outcome, 0), outcome)

    def _expire_soft_ttl(self):
        key = views._board_cache_key("gitlab", "g/p", "status", "milestone", None, LensFilters())
        entry = cache.get(key)
        entry["soft_expires"] = time.time() - 1
        cache.set(key, entry, 600)
        return key

    @patch("git_lens.views.providers.get_provider")
    def test_fetched_then_cache_fresh(self, mock_get_provider):
        mock_get_provider.return_value = lambda *a: _fake_lens_data()
        self.client.get(self.url)
        self.client.get(self.url)
        self._only(fetched=1, cache_fresh=1)

    @patch("git_lens.views.providers.get_provider")
    def test_error_with_no_stale_copy(self, mock_get_provider):
        def boom(*a):
            raise providers.LensError("x")

        mock_get_provider.return_value = boom
        self.assertEqual(self.client.get(self.url).status_code, 502)
        self._only(error=1)

    @patch("git_lens.views.providers.get_provider")
    def test_error_degrades_to_stale(self, mock_get_provider):
        mock_get_provider.return_value = lambda *a: _fake_lens_data()
        self.client.get(self.url)
        self._expire_soft_ttl()

        def boom(*a):
            raise providers.LensRateLimited()

        mock_get_provider.return_value = boom
        self.assertEqual(self.client.get(self.url).status_code, 200)
        self._only(fetched=1, error_stale=1)

    @patch("git_lens.views.providers.get_provider")
    def test_stale_served_while_another_request_holds_the_lock(self, mock_get_provider):
        mock_get_provider.return_value = lambda *a: _fake_lens_data()
        self.client.get(self.url)
        key = self._expire_soft_ttl()
        cache.add(views._lock_key(key), "1", views.LENS_FETCH_LOCK_TTL)
        self.assertEqual(self.client.get(self.url).status_code, 200)
        self._only(fetched=1, cache_stale_locked=1)

    @patch("git_lens.views.providers.get_provider")
    def test_budget_exhausted_serves_stale(self, mock_get_provider):
        mock_get_provider.return_value = lambda *a: _fake_lens_data()
        self.client.get(self.url)
        self._exhaust_budget()
        self.client.get(self.url + "?refresh=1")
        self._only(fetched=1, budget_exhausted_stale=1)

    @patch("git_lens.views.providers.get_provider")
    def test_budget_exhausted_cold_key_is_429(self, mock_get_provider):
        mock_get_provider.return_value = lambda *a: _fake_lens_data()
        self._exhaust_budget()
        self.assertEqual(self.client.get(self.url).status_code, 429)
        self._only(budget_exhausted_429=1)

    def _exhaust_budget(self):
        cache.set(
            f"git_lens:budget:gitlab:g/p:{self.owner.id}",
            views.LENS_FETCH_BUDGET + 50,
            views.LENS_FETCH_BUDGET_WINDOW,
        )
