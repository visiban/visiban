"""Outbound-call observability for the lens (#1061): counters, log line, bounds.

Most of this module needs neither the DB nor the git_lens app installed (providers
and metrics import no models), so it runs in the main flag-off suite too. The one
route test here checks the FLAG-OFF behavior; the admin endpoint's flag-on tests
live in ``test_usage_admin.py``.
"""
import ast
import inspect
import logging
from datetime import datetime, timedelta, timezone as dt_timezone
from unittest import skipIf
from unittest.mock import MagicMock, patch

import requests
from django.conf import settings
from django.core.cache import cache
from django.test import SimpleTestCase, TestCase
from rest_framework.test import APIClient

from git_lens import metrics, providers
from git_lens.types import LensConfig, LensFilters


def _resp(json_data, status=200, headers=None):
    m = MagicMock()
    m.status_code = status
    m.json.return_value = json_data
    m.headers = headers or {}
    return m


def _out(snap, provider, kind, outcome, window="last_24h"):
    return snap[window][provider]["outbound_by_kind"][kind][outcome]


class OutboundLegCoverageTests(SimpleTestCase):
    """Every outbound leg must be counted — an uncounted leg under-reports."""

    def setUp(self):
        cache.clear()

    def test_every_outbound_call_goes_through_provider_get(self):
        """Structural guard: the only ``requests.get`` in providers.py is the one
        inside ``_provider_get``. A future leg added with a bare call fails here."""
        tree = ast.parse(inspect.getsource(providers))
        offenders = []
        for fn in ast.walk(tree):
            if not isinstance(fn, ast.FunctionDef) or fn.name == "_provider_get":
                continue
            for node in ast.walk(fn):
                if (
                    isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Attribute)
                    and node.func.attr in ("get", "post", "request", "head")
                    and isinstance(node.func.value, ast.Name)
                    and node.func.value.id == "requests"
                ):
                    offenders.append(f"{fn.name}:{node.lineno}")
        self.assertEqual(offenders, [])

    @patch("git_lens.providers.requests.get")
    def test_gitlab_pipeline_fetch_counts_every_leg(self, mock_get):
        mock_get.side_effect = [
            _resp([{"iid": 1, "title": "a", "state": "opened"}]),  # issues (short page)
            _resp([{"name": "1-a"}]),                               # branches
            _resp([]),                                              # open MRs
        ]
        providers.gitlab_fetch(None, "g/p", LensConfig(column_dim="pipeline"), LensFilters())
        snap = metrics.snapshot()
        self.assertEqual(_out(snap, "gitlab", "issues", "ok"), 1)
        self.assertEqual(_out(snap, "gitlab", "branches", "ok"), 1)
        self.assertEqual(_out(snap, "gitlab", "merge_requests", "ok"), 1)
        self.assertEqual(snap["last_24h"]["gitlab"]["outbound_calls"], mock_get.call_count)
        self.assertEqual(snap["current_hour"]["gitlab"]["outbound_calls"], 3)
        self.assertEqual(snap["last_24h"]["github"]["outbound_calls"], 0)

    @patch("git_lens.providers.requests.get")
    def test_github_milestone_pipeline_fetch_counts_every_leg(self, mock_get):
        mock_get.side_effect = [
            _resp([{"title": "1.2", "number": 7}]),        # milestone roster
            _resp([{"number": 1, "title": "a"}]),          # issues
            _resp([]),                                     # branches
            _resp([]),                                     # pulls
        ]
        providers.github_fetch(
            "tok", "o/r", LensConfig(column_dim="pipeline"), LensFilters(milestone="1.2")
        )
        snap = metrics.snapshot()
        for kind in ("milestones", "issues", "branches", "merge_requests"):
            self.assertEqual(_out(snap, "github", kind, "ok"), 1, kind)
        self.assertEqual(snap["last_24h"]["github"]["outbound_calls"], mock_get.call_count)

    @patch("git_lens.providers.requests.get")
    def test_wrapper_is_a_pure_pass_through(self, mock_get):
        mock_get.return_value = _resp([])
        providers.gitlab_fetch(None, "g/p", LensConfig(column_dim="state"), LensFilters())
        args, kwargs = mock_get.call_args
        self.assertTrue(args[0].endswith("/issues"))
        self.assertEqual(kwargs["timeout"], providers.REQUEST_TIMEOUT)
        self.assertIn("params", kwargs)
        self.assertIn("headers", kwargs)


class OutboundOutcomeTests(SimpleTestCase):
    """Each upstream failure mode lands in its own outcome, and still raises."""

    def setUp(self):
        cache.clear()

    def _fetch_gitlab(self):
        providers.gitlab_fetch(None, "g/p", LensConfig(column_dim="state"), LensFilters())

    def _assert_outcome(self, response_or_exc, expected_exc, outcome):
        with patch("git_lens.providers.requests.get") as mock_get:
            if isinstance(response_or_exc, Exception):
                mock_get.side_effect = response_or_exc
            else:
                mock_get.return_value = response_or_exc
            with self.assertRaises(expected_exc):
                self._fetch_gitlab()
        self.assertEqual(_out(metrics.snapshot(), "gitlab", "issues", outcome), 1)

    def test_not_found(self):
        self._assert_outcome(_resp({}, 404), providers.LensNotFound, "not_found")

    def test_rate_limited(self):
        self._assert_outcome(_resp({}, 429), providers.LensRateLimited, "rate_limited")

    def test_auth_error(self):
        self._assert_outcome(_resp({}, 401), providers.LensAuthError, "auth_error")

    def test_http_error(self):
        self._assert_outcome(_resp({}, 500), providers.LensError, "http_error")

    def test_network_error(self):
        self._assert_outcome(
            requests.ConnectionError("boom"), requests.RequestException, "network_error"
        )

    @patch("git_lens.providers.requests.get")
    def test_github_403_without_remaining_is_rate_limited(self, mock_get):
        mock_get.return_value = _resp({}, 403)
        with self.assertRaises(providers.LensRateLimited):
            providers.github_fetch("tok", "o/r", LensConfig(column_dim="state"), LensFilters())
        self.assertEqual(_out(metrics.snapshot(), "github", "issues", "rate_limited"), 1)


class OutboundLogLineTests(SimpleTestCase):
    def setUp(self):
        cache.clear()

    @patch("git_lens.providers.requests.get")
    def test_log_line_carries_fields_but_no_secrets(self, mock_get):
        token = "ghp_SUPERSECRETTOKEN123"
        assignee = "alice.private@example.com"
        mock_get.return_value = _resp([])
        with self.assertLogs("git_lens.outbound", level="INFO") as logs:
            providers.github_fetch(
                token, "octo/repo", LensConfig(column_dim="state"),
                LensFilters(assignee=assignee, labels=("secret-label",)),
            )
        self.assertEqual(len(logs.records), 1)
        record = logs.records[0]
        message = record.getMessage()
        for field in ("provider=github", "kind=issues", "outcome=ok", "status=200",
                      "duration_ms=", "repo=octo/repo"):
            self.assertIn(field, message)
        self.assertEqual(record.lens_provider, "github")
        self.assertEqual(record.lens_repo, "octo/repo")
        haystack = message + repr(record.__dict__)
        for secret in (token, "Bearer", "Authorization", assignee, "secret-label", "api.github.com"):
            self.assertNotIn(secret, haystack)

    @patch("git_lens.providers.requests.get")
    def test_error_calls_are_logged_too(self, mock_get):
        mock_get.side_effect = requests.Timeout("slow")
        with self.assertLogs("git_lens.outbound", level="INFO") as logs:
            with self.assertRaises(requests.RequestException):
                providers.gitlab_fetch(None, "g/p", LensConfig(column_dim="state"), LensFilters())
        self.assertIn("outcome=network_error", logs.records[0].getMessage())
        self.assertIn("status=-", logs.records[0].getMessage())

    def test_outbound_logger_is_configured_to_emit_info(self):
        """Without an explicit LOGGING entry the root logger drops INFO and the log
        surface would ship silent."""
        self.assertIn("git_lens.outbound", settings.LOGGING["loggers"])
        self.assertTrue(logging.getLogger("git_lens.outbound").isEnabledFor(logging.INFO))


class MetricsStoreTests(SimpleTestCase):
    def setUp(self):
        cache.clear()

    def test_cache_failure_never_breaks_the_request_path(self):
        with patch.object(metrics.cache, "add", side_effect=ConnectionError("valkey down")):
            metrics.record_board("gitlab", "fetched")  # must not raise
            metrics.record_outbound("gitlab", "issues", "ok", status_code=200,
                                    duration_ms=1, repo="g/p")

    def test_snapshot_degrades_to_zeros_when_cache_read_fails(self):
        with patch.object(metrics.cache, "get_many", side_effect=ConnectionError("down")):
            snap = metrics.snapshot()
        self.assertEqual(snap["last_24h"]["gitlab"]["outbound_calls"], 0)

    def test_unknown_labels_do_not_mint_new_keys(self):
        """Label sets are closed enums; the key space stays a constant."""
        with patch.object(metrics, "_incr") as mock_incr:
            metrics.record_board("bitbucket", "weird")
            metrics.record_outbound("gitlab", "wiki", "teapot", status_code=418,
                                    duration_ms=1, repo="g/p")
        keys = [c.args[0] for c in mock_incr.call_args_list]
        self.assertEqual(len(keys), 2)
        for k in keys:
            self.assertNotIn("bitbucket", k)
            self.assertNotIn("wiki", k)
            self.assertNotIn("teapot", k)

    def test_window_is_24_hourly_buckets_and_old_buckets_drop_out(self):
        now = datetime(2026, 9, 27, 12, 30, tzinfo=dt_timezone.utc)
        with patch.object(metrics, "_now", return_value=now - timedelta(hours=3)):
            metrics.record_board("gitlab", "fetched")
        with patch.object(metrics, "_now", return_value=now - timedelta(hours=30)):
            metrics.record_board("gitlab", "fetched")  # outside the window
        with patch.object(metrics, "_now", return_value=now):
            metrics.record_board("gitlab", "cache_fresh")
        snap = metrics.snapshot(now)
        self.assertEqual(len(snap["hourly"]), 24)
        self.assertEqual(snap["last_24h"]["gitlab"]["board_requests"]["fetched"], 1)
        self.assertEqual(snap["last_24h"]["gitlab"]["board_requests"]["cache_fresh"], 1)
        self.assertEqual(snap["current_hour"]["gitlab"]["board_requests"]["fetched"], 0)
        # Oldest first; the last entry is the current hour.
        self.assertEqual(snap["hourly"][-1]["hour"], "2026-09-27T12:00:00+00:00")


@skipIf(settings.GIT_LENS_ENABLED, "flag-off behavior; the flag-on job covers the live route")
class UsageRouteDormantWhenFlagOffTests(TestCase):
    def test_admin_usage_route_is_not_mounted(self):
        from boards.tests.conftest import _make_user

        admin = _make_user("lensadmin_off", is_site_admin=True)
        client = APIClient()
        client.force_authenticate(admin)
        self.assertEqual(client.get("/api/v1/admin/git-lens/usage/").status_code, 404)
