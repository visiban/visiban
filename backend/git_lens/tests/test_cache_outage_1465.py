"""The lens board during a Valkey/Redis outage (#1465).

The lens's fetch budgets, force-refresh cooldown and single-flight lock all live
in the cache. With the cache unreachable they cannot be consulted, so the board
read must make NO upstream fetch and answer a clean 503, never a 500 and never
an unbounded fetch. A fetch that already happened (budget spent) is still served
when only the cache write after it fails.

Like test_api.py these need the git_lens app installed (GIT_LENS_ENABLED).
"""
import pytest
from django.conf import settings

if not settings.GIT_LENS_ENABLED:  # pragma: no cover - exercised only in the flagged CI job
    pytest.skip(
        "git_lens experiment disabled; set GIT_LENS_ENABLED=true to run these.",
        allow_module_level=True,
    )

from unittest.mock import patch

import redis
from django.core.cache import cache
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from boards.tests.conftest import _make_board, _make_user
from git_lens import providers
from git_lens.models import LensConnection
from git_lens.tests.test_api import _fake_lens_data
from visiban import cache_outage

# Same fixture as boards/tests/test_cache_outage_1465.py: port 1 refuses at once.
UNREACHABLE_REDIS_CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.redis.RedisCache",
        "LOCATION": "redis://127.0.0.1:1/1",
        "OPTIONS": {"socket_connect_timeout": 0.5, "socket_timeout": 0.5},
    }
}


class _LensOutageBase(TestCase):
    def setUp(self):
        cache_outage._last_warned.clear()
        self.addCleanup(cache_outage._last_warned.clear)
        self.owner = _make_user("lens-outage-owner")
        self.board = _make_board(self.owner)
        LensConnection.objects.create(
            board=self.board, provider="gitlab", repo_slug="g/p",
            column_dim="status", created_by=self.owner,
        )
        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        self.url = f"/api/v1/git-lens/board/{self.board.id}/"


@override_settings(CACHES=UNREACHABLE_REDIS_CACHES)
class LensBoardDuringCacheOutageTests(_LensOutageBase):
    def _assert_unavailable_without_fetch(self, url):
        calls = []

        def fetch(token, repo, config, filters):  # pragma: no cover - must not run
            calls.append(repo)
            return _fake_lens_data()

        with patch("git_lens.views.providers.get_provider", return_value=fetch), \
                self.assertLogs("visiban.cache_outage", level="WARNING"):
            resp = self.client.get(url)
        self.assertEqual(resp.status_code, 503)
        self.assertEqual(resp.data["code"], "lens_unavailable")
        # The budgets could not be consulted, so the provider was never called.
        self.assertEqual(calls, [])

    def test_fixture_really_is_an_outage(self):
        with self.assertRaises(redis.exceptions.ConnectionError):
            cache.get("anything")

    def test_board_read_is_503_and_makes_no_upstream_fetch(self):
        self._assert_unavailable_without_fetch(self.url)

    def test_force_refresh_is_503_and_makes_no_upstream_fetch(self):
        self._assert_unavailable_without_fetch(self.url + "?refresh=1")


class LensBoardCacheWriteFailureTests(_LensOutageBase):
    def setUp(self):
        super().setUp()
        cache.clear()

    def test_a_budgeted_fetch_is_served_when_the_cache_write_fails(self):
        with patch("git_lens.views.providers.get_provider", return_value=lambda *a: _fake_lens_data()), \
                patch("git_lens.views.cache.set", side_effect=redis.exceptions.ConnectionError("down")), \
                patch("git_lens.views.cache.delete", side_effect=redis.exceptions.ConnectionError("down")), \
                self.assertLogs("visiban.cache_outage", level="WARNING"):
            resp = self.client.get(self.url)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.data["issues"]), 1)


class GithubMilestoneMapCacheOutageTests(TestCase):
    """The milestone map runs inside an already-budgeted fetch: a cache outage is a miss."""

    def setUp(self):
        cache_outage._last_warned.clear()
        self.addCleanup(cache_outage._last_warned.clear)

    def test_cache_outage_falls_through_to_one_provider_call(self):
        class _Resp:
            @staticmethod
            def json():
                return [{"title": "v1", "number": 3}]

        with patch.object(providers.cache, "get", side_effect=redis.exceptions.ConnectionError("down")), \
                patch.object(providers.cache, "set", side_effect=redis.exceptions.ConnectionError("down")), \
                patch.object(providers, "_provider_get", return_value=_Resp()) as get, \
                self.assertLogs("visiban.cache_outage", level="WARNING"):
            mapping, complete = providers._github_milestone_map("o/r", {}, "tok", "o/r")
        self.assertEqual(mapping, {"v1": 3})
        self.assertTrue(complete)
        get.assert_called_once()
