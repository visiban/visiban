"""Integration tests for the lens API (models, views, RBAC, caching).

These require the git_lens app to be installed (so the table exists and the
routes are mounted), which only happens when GIT_LENS_ENABLED is set. They skip
cleanly otherwise so a plain local `pytest` run never errors on collection; CI
runs them with the flag enabled.
"""
import pytest
from django.conf import settings

if not settings.GIT_LENS_ENABLED:  # pragma: no cover - exercised only in the flagged CI job
    pytest.skip(
        "git_lens experiment disabled; set GIT_LENS_ENABLED=true to run these.",
        allow_module_level=True,
    )

import time
from unittest.mock import patch

from django.core.cache import cache
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from boards.models import BoardMembership
from boards.tests.conftest import _make_board, _make_user
from git_lens.models import LensConnection
from git_lens.types import LensAxis, LensData, NormalizedIssue


def _fake_lens_data():
    return LensData(
        columns=[LensAxis("open", "Open")],
        swimlanes=[LensAxis("v1", "v1")],
        issues=[NormalizedIssue(number=1, title="t", url="u", state="open",
                                column_keys=["open"], swimlane_keys=["v1"])],
        fetched_at="2026-06-06T00:00:00+00:00",
        source_provider="gitlab",
        source_repo="g/p",
        source_url="https://gitlab.com/g/p",
    )


class LensConnectionRBACTests(TestCase):
    def setUp(self):
        self.owner = _make_user("owner")
        self.member = _make_user("member")
        self.outsider = _make_user("outsider")
        self.board = _make_board(self.owner)
        BoardMembership.objects.create(
            board=self.board, user=self.member, role=BoardMembership.Role.MEMBER
        )
        self.url = f"/api/v1/git-lens/connections/{self.board.id}/"

    def _client(self, user):
        c = APIClient()
        c.force_authenticate(user)
        return c

    def test_admin_can_configure(self):
        resp = self._client(self.owner).put(
            self.url, {"provider": "gitlab", "repo_slug": "g/p"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data["provider"], "gitlab")
        self.assertTrue(LensConnection.objects.filter(board=self.board).exists())

    def test_member_cannot_configure(self):
        resp = self._client(self.member).put(
            self.url, {"provider": "gitlab", "repo_slug": "g/p"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_outsider_is_denied(self):
        # Mirrors the repo-wide board-access convention (get_board_for_user):
        # an existing board the user has no role on returns 403.
        resp = self._client(self.outsider).get(self.url)
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_member_can_read_connection(self):
        LensConnection.objects.create(
            board=self.board, provider="gitlab", repo_slug="g/p", created_by=self.owner
        )
        resp = self._client(self.member).get(self.url)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data["repo_slug"], "g/p")

    def test_get_404_when_no_connection(self):
        resp = self._client(self.owner).get(self.url)
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_admin_can_delete(self):
        LensConnection.objects.create(
            board=self.board, provider="gitlab", repo_slug="g/p", created_by=self.owner
        )
        resp = self._client(self.owner).delete(self.url)
        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(LensConnection.objects.filter(board=self.board).exists())

    def test_invalid_repo_slug_rejected(self):
        resp = self._client(self.owner).put(
            self.url, {"provider": "gitlab", "repo_slug": "no-slash"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_member_cannot_delete(self):
        LensConnection.objects.create(
            board=self.board, provider="gitlab", repo_slug="g/p", created_by=self.owner
        )
        resp = self._client(self.member).delete(self.url)
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        self.assertTrue(LensConnection.objects.filter(board=self.board).exists())

    def test_unauthenticated_denied(self):
        resp = APIClient().get(self.url)  # no force_authenticate
        self.assertIn(
            resp.status_code,
            (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN),
        )

    def test_path_injection_repo_slug_rejected(self):
        # ".." segments must be rejected so the slug can't collapse to a
        # different upstream API path (SSRF defense).
        resp = self._client(self.owner).put(
            self.url, {"provider": "github", "repo_slug": "a/../../user"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_github_requires_two_segments(self):
        resp = self._client(self.owner).put(
            self.url, {"provider": "github", "repo_slug": "group/sub/project"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_put_broadcasts_configured_event(self):
        with patch("git_lens.views.broadcast_board_event") as mock_bcast:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self._client(self.owner).put(
                    self.url, {"provider": "gitlab", "repo_slug": "g/p"}, format="json"
                )
            self.assertEqual(resp.status_code, status.HTTP_200_OK)
        mock_bcast.assert_called_once()
        args = mock_bcast.call_args[0]
        self.assertEqual(args[0], self.board.id)
        self.assertEqual(args[1], "lens_connection.configured")

    def test_delete_broadcasts_removed_event(self):
        LensConnection.objects.create(
            board=self.board, provider="gitlab", repo_slug="g/p", created_by=self.owner
        )
        with patch("git_lens.views.broadcast_board_event") as mock_bcast:
            with self.captureOnCommitCallbacks(execute=True):
                self._client(self.owner).delete(self.url)
        mock_bcast.assert_called_once_with(
            self.board.id, "lens_connection.removed", {"board_id": self.board.id}
        )


class LensBoardRenderTests(TestCase):
    def setUp(self):
        cache.clear()
        self.owner = _make_user("owner2")
        self.board = _make_board(self.owner)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        self.url = f"/api/v1/git-lens/board/{self.board.id}/"

    def _connect(self, provider="gitlab"):
        return LensConnection.objects.create(
            board=self.board, provider=provider, repo_slug="g/p", created_by=self.owner
        )

    def test_no_connection_returns_404(self):
        resp = self.client.get(self.url)
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    @patch("git_lens.views.providers.get_provider")
    def test_happy_path_returns_board(self, mock_get_provider):
        self._connect("gitlab")
        mock_get_provider.return_value = lambda token, repo, config: _fake_lens_data()
        resp = self.client.get(self.url)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data["source"]["provider"], "gitlab")
        self.assertEqual(len(resp.data["issues"]), 1)
        self.assertEqual(resp.data["columns"][0]["key"], "open")

    @patch("git_lens.views.providers.get_provider")
    def test_result_is_cached(self, mock_get_provider):
        self._connect("gitlab")
        calls = {"n": 0}

        def counting(token, repo, config):
            calls["n"] += 1
            return _fake_lens_data()

        mock_get_provider.return_value = counting
        self.client.get(self.url)
        self.client.get(self.url)
        self.assertEqual(calls["n"], 1)  # second call served from cache

    def test_github_without_token_returns_409(self):
        self._connect("github")
        resp = self.client.get(self.url)
        self.assertEqual(resp.status_code, status.HTTP_409_CONFLICT)
        self.assertEqual(resp.data["code"], "auth_required")

    @patch("git_lens.views.providers.get_provider")
    def test_rate_limit_passthrough(self, mock_get_provider):
        from git_lens import providers

        self._connect("gitlab")

        def boom(token, repo, config):
            raise providers.LensRateLimited(retry_after="60")

        mock_get_provider.return_value = boom
        resp = self.client.get(self.url)
        self.assertEqual(resp.status_code, status.HTTP_429_TOO_MANY_REQUESTS)
        self.assertEqual(resp.data["code"], "rate_limited")

    @patch("git_lens.views.providers.get_provider")
    def test_not_found_passthrough(self, mock_get_provider):
        from git_lens import providers

        self._connect("gitlab")

        def boom(token, repo, config):
            raise providers.LensNotFound("gone")

        mock_get_provider.return_value = boom
        resp = self.client.get(self.url)
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(resp.data["code"], "repo_not_found")

    def test_non_member_denied(self):
        outsider = _make_user("outsider2")
        client = APIClient()
        client.force_authenticate(outsider)
        self._connect("gitlab")
        resp = client.get(self.url)
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    @patch("git_lens.views.providers.get_provider")
    def test_invalid_pivot_override_coerced_to_stored(self, mock_get_provider):
        self._connect("gitlab")  # stored dims: status / milestone
        seen = {}

        def capture(token, repo, config):
            seen["column_dim"] = config.column_dim
            seen["swimlane_dim"] = config.swimlane_dim
            return _fake_lens_data()

        mock_get_provider.return_value = capture
        resp = self.client.get(self.url + "?column_dim=evil&swimlane_dim=label")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        # invalid column_dim falls back to stored "status"; valid swimlane kept
        self.assertEqual(seen["column_dim"], "status")
        self.assertEqual(seen["swimlane_dim"], "label")

    @patch("git_lens.views.providers.get_provider")
    def test_cache_is_shared_across_members(self, mock_get_provider):
        """The board cache is keyed per-repo, not per-user: two different members
        viewing the same board collapse to a single upstream fetch. This is the
        core API-politeness guarantee — without it, N members = N× the calls."""
        member = _make_user("member3")
        BoardMembership.objects.create(
            board=self.board, user=member, role=BoardMembership.Role.MEMBER
        )
        self._connect("gitlab")
        calls = {"n": 0}

        def counting(token, repo, config):
            calls["n"] += 1
            return _fake_lens_data()

        mock_get_provider.return_value = counting

        self.client.get(self.url)  # owner (cold → fetch)
        other = APIClient()
        other.force_authenticate(member)
        resp = other.get(self.url)  # different member → served from shared cache

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(calls["n"], 1)

    @patch("git_lens.views._user_provider_token", return_value="ghtok")
    @patch("git_lens.views.providers.get_provider")
    def test_github_cache_is_scoped_per_user(self, mock_get_provider, _mock_token):
        """GitHub reads use the viewer's OWN token (which may see repos other
        members can't), so the cache is scoped per user — two members do NOT share
        a copy. This preserves the privacy boundary the shared GitLab cache can't."""
        member = _make_user("member4")
        BoardMembership.objects.create(
            board=self.board, user=member, role=BoardMembership.Role.MEMBER
        )
        self._connect("github")
        calls = {"n": 0}

        def counting(token, repo, config):
            calls["n"] += 1
            return _fake_lens_data()

        mock_get_provider.return_value = counting

        self.client.get(self.url)  # owner
        other = APIClient()
        other.force_authenticate(member)
        other.get(self.url)  # different member → NOT served the owner's copy

        self.assertEqual(calls["n"], 2)

    @patch("git_lens.views.providers.get_provider")
    def test_serves_stale_copy_when_provider_errors_after_soft_expiry(self, mock_get_provider):
        """Stale-while-revalidate: once a soft-expired copy exists, a provider
        error (e.g. a transient rate-limit) degrades to the last good copy rather
        than failing the board — so a blip never retry-storms the provider."""
        from git_lens import providers
        from git_lens.views import _board_cache_key

        self._connect("gitlab")
        mock_get_provider.return_value = lambda token, repo, config: _fake_lens_data()
        first = self.client.get(self.url)
        self.assertEqual(first.status_code, status.HTTP_200_OK)

        # Force the cached copy past its soft-TTL so the next read revalidates.
        key = _board_cache_key("gitlab", "g/p", "status", "milestone")
        entry = cache.get(key)
        entry["soft_expires"] = time.time() - 1
        cache.set(key, entry, 600)

        def boom(token, repo, config):
            raise providers.LensRateLimited(retry_after="60")

        mock_get_provider.return_value = boom
        resp = self.client.get(self.url)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)  # stale, not 429
        self.assertEqual(resp.data["source"]["provider"], "gitlab")

    @patch("git_lens.views.providers.get_provider")
    def test_etag_conditional_get_returns_304(self, mock_get_provider):
        """A repeat GET carrying the prior ETag gets a 304 (no payload re-sent),
        bounding the client<->Visiban leg on top of the shared upstream cache."""
        self._connect("gitlab")
        mock_get_provider.return_value = lambda token, repo, config: _fake_lens_data()

        first = self.client.get(self.url)
        self.assertEqual(first.status_code, status.HTTP_200_OK)
        etag = first["ETag"]
        self.assertTrue(etag)

        second = self.client.get(self.url, HTTP_IF_NONE_MATCH=etag)
        self.assertEqual(second.status_code, status.HTTP_304_NOT_MODIFIED)
