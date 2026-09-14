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
        # Explicit column_dim keeps these pivot/cache-key tests deterministic and
        # independent of the model default (which is "pipeline" — see
        # LensConnectionDefaultTests). Most render tests don't want the pipeline
        # enrichment fetch.
        return LensConnection.objects.create(
            board=self.board, provider=provider, repo_slug="g/p",
            column_dim="status", created_by=self.owner,
        )

    def test_new_connection_defaults_to_pipeline(self):
        # A new lens defaults to the opinionated pipeline view (not status, which
        # degrades to open/closed without status:: labels).
        conn = LensConnection.objects.create(
            board=self.board, provider="gitlab", repo_slug="g/p", created_by=self.owner
        )
        self.assertEqual(conn.column_dim, "pipeline")

    def test_no_connection_returns_404(self):
        resp = self.client.get(self.url)
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    @patch("git_lens.views.providers.get_provider")
    def test_happy_path_returns_board(self, mock_get_provider):
        self._connect("gitlab")
        mock_get_provider.return_value = lambda token, repo, config, filters: _fake_lens_data()
        resp = self.client.get(self.url)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data["source"]["provider"], "gitlab")
        self.assertEqual(len(resp.data["issues"]), 1)
        self.assertEqual(resp.data["columns"][0]["key"], "open")

    @patch("git_lens.views.providers.get_provider")
    def test_result_is_cached(self, mock_get_provider):
        self._connect("gitlab")
        calls = {"n": 0}

        def counting(token, repo, config, filters):
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

        def boom(token, repo, config, filters):
            raise providers.LensRateLimited(retry_after="60")

        mock_get_provider.return_value = boom
        resp = self.client.get(self.url)
        self.assertEqual(resp.status_code, status.HTTP_429_TOO_MANY_REQUESTS)
        self.assertEqual(resp.data["code"], "rate_limited")

    @patch("git_lens.views.providers.get_provider")
    def test_not_found_passthrough(self, mock_get_provider):
        from git_lens import providers

        self._connect("gitlab")

        def boom(token, repo, config, filters):
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

        def capture(token, repo, config, filters):
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

        def counting(token, repo, config, filters):
            calls["n"] += 1
            return _fake_lens_data()

        mock_get_provider.return_value = counting

        self.client.get(self.url)  # owner (cold → fetch)
        other = APIClient()
        other.force_authenticate(member)
        resp = other.get(self.url)  # different member → served from shared cache

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(calls["n"], 1)

    @patch("git_lens.views.providers.get_provider")
    def test_refresh_param_forces_refetch_past_warm_cache(self, mock_get_provider):
        """The Refresh button (?refresh=1) re-fetches even when the cached copy is
        still within its soft-TTL, so the user gets the latest issues."""
        self._connect("gitlab")
        calls = {"n": 0}

        def counting(token, repo, config, filters):
            calls["n"] += 1
            return _fake_lens_data()

        mock_get_provider.return_value = counting
        self.client.get(self.url)  # cold → fetch (1)
        self.client.get(self.url)  # warm cache → served, no fetch
        self.assertEqual(calls["n"], 1)
        self.client.get(self.url + "?refresh=1")  # force → re-fetch
        self.assertEqual(calls["n"], 2)

    @patch("git_lens.views.providers.get_provider")
    def test_force_refresh_is_rate_capped_per_user(self, mock_get_provider):
        """?refresh=1 bypasses the soft-TTL, so without a floor one member could
        drive a full upstream fetch on every request and burn the shared provider
        quota for the whole board. The single-flight lock only collapses
        CONCURRENT fetches — it does not bound frequency. Second force inside the
        cooldown must fall back to the normal cached read, not re-fetch."""
        self._connect("gitlab")
        calls = {"n": 0}

        def counting(token, repo, config, filters):
            calls["n"] += 1
            return _fake_lens_data()

        mock_get_provider.return_value = counting
        self.client.get(self.url)                     # cold → fetch (1)
        self.client.get(self.url + "?refresh=1")      # force → re-fetch (2)
        self.assertEqual(calls["n"], 2)
        resp = self.client.get(self.url + "?refresh=1")  # inside cooldown → no fetch
        self.assertEqual(calls["n"], 2)
        # Degrades to a normal read rather than erroring — the viewer still gets a
        # board, and the banner's "Synced X ago" stays truthful about its age.
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    @patch("git_lens.views.providers.get_provider")
    def test_force_refresh_allowed_again_after_cooldown(self, mock_get_provider):
        """The cap is a cooldown, not a one-shot: once it lapses, Refresh works."""
        self._connect("gitlab")
        calls = {"n": 0}

        def counting(token, repo, config, filters):
            calls["n"] += 1
            return _fake_lens_data()

        mock_get_provider.return_value = counting
        self.client.get(self.url + "?refresh=1")  # cold → fetch (1), claims cooldown
        self.assertEqual(calls["n"], 1)
        cache.delete(f"git_lens:force:{self.board.id}:{self.owner.id}")  # cooldown lapses
        self.client.get(self.url + "?refresh=1")  # force → re-fetch (2)
        self.assertEqual(calls["n"], 2)

    @patch("git_lens.views.providers.get_provider")
    def test_viewer_may_force_refresh(self, mock_get_provider):
        """Force-refresh is deliberately NOT role-gated. The lens is a read-only
        surface whose primary audience is viewers (#1062); a Refresh button that
        403s for them would break the persona the feature exists for. The abuse
        vector is frequency, and that is capped by the cooldown above — not by
        role. This test exists so a future 'harden the refresh endpoint' change
        has to consciously break it rather than silently regress the persona."""
        self._connect("gitlab")
        viewer = _make_user("lens_viewer")
        BoardMembership.objects.create(
            board=self.board, user=viewer, role=BoardMembership.Role.VIEWER
        )
        calls = {"n": 0}

        def counting(token, repo, config, filters):
            calls["n"] += 1
            return _fake_lens_data()

        mock_get_provider.return_value = counting
        c = APIClient()
        c.force_authenticate(viewer)
        resp = c.get(self.url + "?refresh=1")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(calls["n"], 1)  # the viewer's force actually fetched

    def test_lock_ttl_covers_worst_case_pipeline_fetch(self):
        """The single-flight lock must outlive the slowest fetch it guards, or it
        expires mid-fetch and a second caller dogpiles the provider. The worst case
        is the pipeline view: MAX_PAGES issue pages plus TWO aux paginations
        (branches + MRs). The original formula counted only the issue pages, so it
        asserted 45 >= 30 and passed while the real worst case (70s) exceeded the
        45s lock. Pipeline is now the default for new lenses, so this is the
        common path, not a corner."""
        from git_lens import providers as _p
        from git_lens import views as _v

        worst = (_p.MAX_PAGES + 2 * _p.MAX_AUX_PAGES) * _p.REQUEST_TIMEOUT
        self.assertGreaterEqual(
            _v.LENS_FETCH_LOCK_TTL, worst,
            "lock TTL must cover issue pages AND both aux paginations",
        )

    @patch("git_lens.views.providers.get_provider")
    def test_filtered_and_unfiltered_do_not_cross_serve(self, mock_get_provider):
        """Server-side filters change WHAT is fetched, so a filtered request must use
        a distinct cache key — never served the unfiltered copy (or vice versa)."""
        self._connect("gitlab")
        calls = {"n": 0}

        def counting(token, repo, config, filters):
            calls["n"] += 1
            return _fake_lens_data()

        mock_get_provider.return_value = counting
        self.client.get(self.url)                      # unfiltered → fetch (1)
        self.client.get(self.url + "?milestone=0.3")   # filtered → distinct key → fetch (2)
        self.client.get(self.url)                      # unfiltered again → served from cache
        self.assertEqual(calls["n"], 2)

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

        def counting(token, repo, config, filters):
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
        from git_lens.types import LensFilters
        from git_lens.views import _board_cache_key

        self._connect("gitlab")
        mock_get_provider.return_value = lambda token, repo, config, filters: _fake_lens_data()
        first = self.client.get(self.url)
        self.assertEqual(first.status_code, status.HTTP_200_OK)

        # Force the cached copy past its soft-TTL so the next read revalidates.
        # The view always passes a LensFilters (empty here), so the key must too.
        key = _board_cache_key("gitlab", "g/p", "status", "milestone", filters=LensFilters())
        entry = cache.get(key)
        entry["soft_expires"] = time.time() - 1
        cache.set(key, entry, 600)

        def boom(token, repo, config, filters):
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
        mock_get_provider.return_value = lambda token, repo, config, filters: _fake_lens_data()

        first = self.client.get(self.url)
        self.assertEqual(first.status_code, status.HTTP_200_OK)
        etag = first["ETag"]
        self.assertTrue(etag)

        second = self.client.get(self.url, HTTP_IF_NONE_MATCH=etag)
        self.assertEqual(second.status_code, status.HTTP_304_NOT_MODIFIED)
