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
from unittest.mock import MagicMock, patch

from django.core.cache import cache
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from boards.models import BoardMembership
from boards.tests.conftest import _make_board, _make_user
from git_lens import views
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
        # #1114: git_lens/views.py now calls record_board_event(), which defers
        # the publish through the boards.broadcast module-global rather than a
        # name git_lens/views.py imports directly.
        with patch("boards.broadcast.broadcast_board_event") as mock_bcast:
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
        with patch("boards.broadcast.broadcast_board_event") as mock_bcast:
            with self.captureOnCommitCallbacks(execute=True):
                self._client(self.owner).delete(self.url)
        mock_bcast.assert_called_once_with(
            self.board.id,
            "lens_connection.removed",
            {"board_id": self.board.id},
            event_id=mock_bcast.call_args[1]["event_id"],
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
        # Cooldown is keyed on (provider, repo, user) — the provider rate limit it
        # protects is shared by every board pointing at the same repo.
        cache.delete(f"git_lens:force:gitlab:g/p:{self.owner.id}")  # cooldown lapses
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

    @patch("git_lens.views.providers.get_provider")
    def test_novel_milestone_filters_cannot_loop_the_provider(self, mock_get_provider):
        """`milestone` is free text, so the cache key space is unbounded and every
        novel value is a COLD key that fetches — bypassing both the soft-TTL and the
        force-refresh cooldown (which only guards ?refresh=1). A per-(provider, repo,
        user) budget bounds upstream calls regardless of which path triggered them."""
        self._connect("gitlab")
        calls = {"n": 0}

        def counting(token, repo, config, filters):
            calls["n"] += 1
            return _fake_lens_data()

        mock_get_provider.return_value = counting
        last = None
        for i in range(views.LENS_FETCH_BUDGET + 6):
            last = self.client.get(self.url + f"?milestone=novel-{i}")
        self.assertEqual(calls["n"], views.LENS_FETCH_BUDGET)
        # No cached copy exists for a novel key, so the over-budget caller is told
        # to back off rather than being served someone else's board.
        self.assertEqual(last.status_code, status.HTTP_429_TOO_MANY_REQUESTS)
        self.assertEqual(last.data["code"], "fetch_budget_exhausted")

    @patch("git_lens.views.providers.get_provider")
    def test_novel_filter_values_cannot_loop_the_provider(self, mock_get_provider):
        """#1067's answer to the cache-key fan-out item, in executable form.

        Label and assignee are free text too, so they enlarge the reachable key
        space combinatorially. The existing per-(provider, repo, user) budget still
        bounds it, because minting a distinct cache key REQUIRES a cold fetch and
        the budget is spent before the provider is touched — so keys created can
        never exceed fetches allowed, no matter how many filter dimensions exist.
        That is why no second limiter was added. If a future filter dimension is
        added without this property, this test is what should fail."""
        self._connect("gitlab")
        calls = {"n": 0}

        def counting(token, repo, config, filters):
            calls["n"] += 1
            return _fake_lens_data()

        mock_get_provider.return_value = counting
        last = None
        for i in range(views.LENS_FETCH_BUDGET + 6):
            # A novel value on EVERY new dimension at once — the widest key space
            # a caller can reach through this endpoint.
            last = self.client.get(
                self.url + f"?labels=novel-{i}&assignee=who-{i}&milestone=m-{i}"
            )
        self.assertEqual(calls["n"], views.LENS_FETCH_BUDGET)
        self.assertEqual(last.status_code, status.HTTP_429_TOO_MANY_REQUESTS)
        self.assertEqual(last.data["code"], "fetch_budget_exhausted")

    @patch("git_lens.views.providers.get_provider")
    def test_rotating_repo_slug_cannot_mint_fresh_fetch_budgets(self, mock_get_provider):
        """The per-repo budget key contains repo_slug, and repo_slug is USER-MINTABLE:
        any authenticated user can create a board, become its admin, and PUT a new
        slug — minting a fresh 12-fetch budget for the cost of one request. A ceiling
        scoped on a value the caller chooses the cardinality of is no ceiling, so a
        second per-user budget across all repos backstops it. This matters most for
        GitLab, whose reads are anonymous and charged to the instance's own IP
        (#1067 security-review)."""
        conn = self._connect("gitlab")
        calls = {"n": 0}

        def counting(token, repo, config, filters):
            calls["n"] += 1
            return _fake_lens_data()

        mock_get_provider.return_value = counting
        last = None
        # Rotate the slug far more times than the per-user ceiling allows fetches.
        for repo_n in range(views.LENS_USER_FETCH_BUDGET + 10):
            conn.repo_slug = f"g/p{repo_n}"
            conn.save(update_fields=["repo_slug"])
            last = self.client.get(self.url)
        self.assertEqual(calls["n"], views.LENS_USER_FETCH_BUDGET)
        self.assertEqual(last.status_code, status.HTTP_429_TOO_MANY_REQUESTS)
        self.assertEqual(last.data["code"], "fetch_budget_exhausted")

    def test_cache_key_digest_is_not_truncated(self):
        """GitLab board keys carry no user scope, so they are shared instance-wide
        and a caller controls both sides of the hash comparison. A truncated digest
        makes multi-target second-preimage search cheap enough to plant an entry
        that serves attacker-chosen issue titles and URLs into another team's board.
        Keep the full digest — key length is free."""
        from git_lens.types import LensFilters
        from git_lens.views import _board_cache_key

        key = _board_cache_key("gitlab", "g/p", "status", "milestone", filters=LensFilters())
        self.assertEqual(len(key.rsplit(":", 1)[1]), 64)  # full sha256 hex

    @patch("git_lens.views.providers.get_provider")
    def test_label_order_and_duplicates_collapse_to_one_cache_key(self, mock_get_provider):
        """Labels are an unordered AND set, so ?labels=b,a and ?labels=a,b are the
        same question and must share one key — an unsorted key would mint two
        entries and two cold provider fetches for one filter, multiplying exactly
        the fan-out this change is bounding. Duplicates and padding collapse too."""
        self._connect("gitlab")
        calls = {"n": 0}

        def counting(token, repo, config, filters):
            calls["n"] += 1
            return _fake_lens_data()

        mock_get_provider.return_value = counting
        self.client.get(self.url + "?labels=bug,backend")
        self.client.get(self.url + "?labels=backend,bug")
        self.client.get(self.url + "?labels=%20backend%20,bug,bug,")
        self.assertEqual(calls["n"], 1)

    @patch("git_lens.views.providers.get_provider")
    def test_label_count_is_capped(self, mock_get_provider):
        self._connect("gitlab")
        seen = {}

        def capture(token, repo, config, filters):
            seen["labels"] = filters.labels
            return _fake_lens_data()

        mock_get_provider.return_value = capture
        self.client.get(self.url + "?labels=a,b,c,d,e,f,g,h")
        self.assertEqual(len(seen["labels"]), views.MAX_LENS_LABELS)
        # Deduping happens BEFORE the cap, so a repeated label is not a wasted slot.
        self.client.get(self.url + "?labels=z,z,z,z,z,y")
        self.assertEqual(seen["labels"], ("y", "z"))

    @patch("git_lens.views.providers.get_provider")
    def test_filter_values_containing_separators_do_not_collide(self, mock_get_provider):
        """The cache-key preimage is JSON, not a delimiter-joined string. Label and
        milestone titles legitimately contain '|' and ',' ("P1, urgent"), and with a
        hand-joined preimage two DIFFERENT filter sets collapse onto one digest —
        serving one viewer a board that answers somebody else's filter."""
        from git_lens.types import LensFilters
        from git_lens.views import _board_cache_key

        args = ("gitlab", "g/p", "status", "milestone")
        # One label literally containing a comma vs. two separate labels.
        one_label = _board_cache_key(*args, filters=LensFilters(labels=("a,b",)))
        two_labels = _board_cache_key(*args, filters=LensFilters(labels=("a", "b")))
        self.assertNotEqual(one_label, two_labels)
        # A milestone title that mimics the old delimiter grammar.
        spoofed = _board_cache_key(*args, filters=LensFilters(milestone="x|a=y"))
        plain = _board_cache_key(*args, filters=LensFilters(milestone="x", assignee="y"))
        self.assertNotEqual(spoofed, plain)

    @patch("git_lens.views.providers.get_provider")
    def test_filtered_entries_get_a_shorter_hard_ttl(self, mock_get_provider):
        """Filtered boards are the long tail of the key space and the whole resident
        footprint of the fan-out; the unfiltered board is the hot, genuinely shared
        entry and keeps the full window."""
        self._connect("gitlab")
        mock_get_provider.return_value = lambda token, repo, config, filters: _fake_lens_data()

        with patch("git_lens.views.cache.set", wraps=cache.set) as mock_set:
            self.client.get(self.url)
            self.assertEqual(mock_set.call_args.args[2], views.LENS_CACHE_HARD_TTL)
            self.client.get(self.url + "?labels=bug")
            self.assertEqual(
                mock_set.call_args.args[2], views.LENS_CACHE_FILTERED_HARD_TTL
            )
        self.assertLess(views.LENS_CACHE_FILTERED_HARD_TTL, views.LENS_CACHE_HARD_TTL)

    @patch("git_lens.views.providers.get_provider")
    def test_new_filters_reach_the_provider_and_are_optional(self, mock_get_provider):
        """Backward compatibility: every new param is optional with a no-filter
        default, so an existing client that sends none behaves exactly as before."""
        self._connect("gitlab")
        seen = {}

        def capture(token, repo, config, filters):
            seen["filters"] = filters
            return _fake_lens_data()

        mock_get_provider.return_value = capture
        self.client.get(self.url)
        self.assertEqual(seen["filters"].labels, ())
        self.assertIsNone(seen["filters"].assignee)
        self.assertFalse(seen["filters"].active)

        self.client.get(self.url + "?labels=bug&assignee=alice")
        self.assertEqual(seen["filters"].labels, ("bug",))
        self.assertEqual(seen["filters"].assignee, "alice")
        self.assertTrue(seen["filters"].active)

    @patch("git_lens.views.providers.get_provider")
    def test_blank_filter_values_are_treated_as_absent(self, mock_get_provider):
        """Fail-open: a shared link carrying empty filter params must render the
        unfiltered board, not a filter for the empty string (which would be its own
        cache key and its own cold fetch)."""
        self._connect("gitlab")
        calls = {"n": 0}

        def counting(token, repo, config, filters):
            calls["n"] += 1
            return _fake_lens_data()

        mock_get_provider.return_value = counting
        self.client.get(self.url)
        self.client.get(self.url + "?labels=&assignee=&milestone=&state=")
        self.client.get(self.url + "?labels=,,,&assignee=%20%20")
        self.assertEqual(calls["n"], 1)  # all three are the same unfiltered key

    @patch("git_lens.views.providers.get_provider")
    def test_overlong_filter_values_are_capped(self, mock_get_provider):
        """Cache-key hygiene + defense: each filter value is bounded at
        MAX_FILTER_VALUE_LEN before it reaches the provider or the cache key, so an
        absurdly long query value can't inflate the resident cache-key payload or
        get forwarded verbatim to the upstream provider request."""
        self._connect("gitlab")
        seen = {}

        def capture(token, repo, config, filters):
            seen["filters"] = filters
            return _fake_lens_data()

        mock_get_provider.return_value = capture
        over_limit = "x" * (views.MAX_FILTER_VALUE_LEN + 50)
        resp = self.client.get(
            self.url + f"?milestone={over_limit}&assignee={over_limit}&labels={over_limit}"
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(len(seen["filters"].milestone), views.MAX_FILTER_VALUE_LEN)
        self.assertEqual(len(seen["filters"].assignee), views.MAX_FILTER_VALUE_LEN)
        self.assertEqual(len(seen["filters"].labels[0]), views.MAX_FILTER_VALUE_LEN)

    @patch("git_lens.views.providers.get_provider")
    def test_invalid_state_value_fails_open(self, mock_get_provider):
        """An unrecognized `state` value is coerced to "no filter" rather than sent
        to the provider or baked into the cache key literally — the same fail-open
        contract `_parse_filters` documents for milestone/labels/assignee, and the
        same coercion already applied to the pivot-dim params just above it in the
        view. A shared link carrying a since-invalid state must still render."""
        self._connect("gitlab")
        seen = {}

        def capture(token, repo, config, filters):
            seen["filters"] = filters
            return _fake_lens_data()

        mock_get_provider.return_value = capture
        resp = self.client.get(self.url + "?state=bogus")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertIsNone(seen["filters"].state)
        self.assertFalse(seen["filters"].active)

    @patch("git_lens.views.providers.get_provider")
    def test_refresh_with_filters_refetches_the_filtered_key_not_unfiltered(
        self, mock_get_provider
    ):
        """?refresh=1 must revalidate the cache key the CURRENT request maps to —
        a filtered request forces a re-fetch of the FILTERED entry, never the
        unfiltered board it happens to share a repo with. Without this a Refresh
        click on a filtered view could look like a no-op (revalidating the wrong
        entry) or silently warm the unfiltered board instead of the one on screen."""
        self._connect("gitlab")
        calls = {"unfiltered": 0, "filtered": 0}

        def counting(token, repo, config, filters):
            calls["filtered" if filters.active else "unfiltered"] += 1
            return _fake_lens_data()

        mock_get_provider.return_value = counting
        self.client.get(self.url)                            # unfiltered cold fetch
        self.client.get(self.url + "?labels=bug")             # filtered cold fetch
        self.assertEqual(calls, {"unfiltered": 1, "filtered": 1})

        self.client.get(self.url + "?labels=bug&refresh=1")   # forces the FILTERED key
        self.assertEqual(calls, {"unfiltered": 1, "filtered": 2})

        # The unfiltered copy is untouched by a filtered refresh — still warm.
        self.client.get(self.url)
        self.assertEqual(calls, {"unfiltered": 1, "filtered": 2})

    @patch("git_lens.views.providers.get_provider")
    def test_over_budget_serves_stale_rather_than_429(self, mock_get_provider):
        """When a cached copy exists, an exhausted budget degrades to the stale copy
        — the board still renders. 429 is only for the cold-key case."""
        self._connect("gitlab")
        mock_get_provider.return_value = lambda token, repo, config, filters: _fake_lens_data()
        self.client.get(self.url)  # seed the cache for the unfiltered key
        cache.set(
            f"git_lens:budget:gitlab:g/p:{self.owner.id}",
            views.LENS_FETCH_BUDGET + 50,
            views.LENS_FETCH_BUDGET_WINDOW,
        )
        resp = self.client.get(self.url + "?refresh=1")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(len(resp.data["issues"]), 1)

    def test_lock_ttl_covers_worst_case_pipeline_fetch(self):
        """The single-flight lock must outlive the slowest fetch it guards, or it
        expires mid-fetch and a second caller dogpiles the provider.

        The worst case is a GitHub pipeline fetch with a milestone filter:
        MAX_PAGES issue pages, TWO aux paginations (branches + MRs), and ONE
        milestone-roster page (_github_milestone_map, added in #1067 when GitHub
        milestone filtering moved server-side).

        This test is the second, independent guard on the import-time assertion in
        views.py — which means the formula here has to track that one exactly. It
        has drifted before: the original counted only the issue pages, so it
        asserted 45 >= 30 and passed while the real worst case (70s) exceeded the
        45s lock. A formula that under-counts still passes today and silently stops
        guarding the next page-cap bump, which is the only failure this test exists
        to catch. Keep every outbound leg represented."""
        from git_lens import providers as _p
        from git_lens import views as _v

        worst = (_p.MAX_PAGES + 2 * _p.MAX_AUX_PAGES + 1) * _p.REQUEST_TIMEOUT
        self.assertGreaterEqual(
            _v.LENS_FETCH_LOCK_TTL, worst,
            "lock TTL must cover issue pages, both aux paginations, "
            "AND the GitHub milestone-roster page",
        )
        # Pin the two formulas together so a change to one without the other fails
        # here rather than quietly halving this test's value.
        self.assertEqual(worst, _v._WORST_CASE_FETCH_SECONDS)

    def test_filtered_cache_window_stays_inside_the_fetch_budget_window(self):
        """Capacity invariant behind the filtered-entry TTL (#1067 perf-check).

        Resident filtered entries per (user, repo) settle at roughly
        LENS_FETCH_BUDGET * (FILTERED_HARD_TTL / BUDGET_WINDOW) — entries expire
        faster than the budget refills them. That decay only holds while the
        filtered TTL is shorter than the budget window; invert them and the
        resident count grows toward the full budget instead. Nothing else asserts
        this, unlike the lock-TTL relationship, so a future tuning pass that
        shortens the budget window should fail here rather than silently triple the
        cache footprint."""
        self.assertLess(views.LENS_CACHE_FILTERED_HARD_TTL, views.LENS_FETCH_BUDGET_WINDOW)
        self.assertLess(views.LENS_CACHE_FILTERED_HARD_TTL, views.LENS_CACHE_HARD_TTL)

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

    @patch("git_lens.views._user_provider_token", return_value="ghtok")
    def test_github_milestone_roster_error_degrades_like_any_other_provider_error(
        self, _mock_token
    ):
        """The milestone title->number lookup (`_github_milestone_map`) is itself an
        upstream call, made BEFORE the issue fetch whenever a GitHub board is
        filtered by milestone title. A failure there (rate limit, auth, 5xx) must
        surface through the exact same LensError handling as a failure on the issue
        endpoint itself — a clean error response on a cold cache, never a 500 — and
        must never fall through to an issue request once resolution has failed."""
        self._connect("github")

        def boom(url, headers=None, params=None, timeout=None):
            self.assertTrue(
                url.endswith("/milestones"), "must fail before any issue request"
            )
            resp = MagicMock()
            resp.status_code = 403
            resp.headers = {}  # no X-RateLimit-Remaining -> abuse/secondary limit path
            return resp

        with patch("git_lens.providers.requests.get", side_effect=boom):
            resp = self.client.get(self.url + "?milestone=1.2")
        self.assertEqual(resp.status_code, status.HTTP_429_TOO_MANY_REQUESTS)
        self.assertEqual(resp.data["code"], "rate_limited")

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
    def test_unexpected_parse_error_degrades_to_stale_copy(self, mock_get_provider):
        """#1085: if a provider payload shape provider_fn didn't anticipate slips
        past normalization and raises TypeError/KeyError/AttributeError, the view
        must degrade to the stale copy (same as a LensError) instead of 500ing."""
        from git_lens.types import LensFilters
        from git_lens.views import _board_cache_key

        self._connect("gitlab")
        mock_get_provider.return_value = lambda token, repo, config, filters: _fake_lens_data()
        first = self.client.get(self.url)
        self.assertEqual(first.status_code, status.HTTP_200_OK)

        key = _board_cache_key("gitlab", "g/p", "status", "milestone", filters=LensFilters())
        entry = cache.get(key)
        entry["soft_expires"] = time.time() - 1
        cache.set(key, entry, 600)

        for exc in (
            TypeError("'int' object is not subscriptable"),
            KeyError(slice(None, 10, None)),
            AttributeError("'int' object has no attribute 'lower'"),
        ):
            def boom(token, repo, config, filters, _exc=exc):
                raise _exc

            mock_get_provider.return_value = boom
            resp = self.client.get(self.url)
            self.assertEqual(resp.status_code, status.HTTP_200_OK)  # stale, not 500
            self.assertEqual(resp.data["source"]["provider"], "gitlab")

    @patch("git_lens.views.providers.get_provider")
    def test_unexpected_parse_error_with_no_stale_copy_returns_502_not_500(self, mock_get_provider):
        """Same malformed-payload failure but on a cold cache (no stale copy to
        degrade to): must still return a clean error response, never a 500."""
        self._connect("gitlab")

        def boom(token, repo, config, filters):
            raise TypeError("'int' object is not subscriptable")

        mock_get_provider.return_value = boom
        resp = self.client.get(self.url)
        self.assertEqual(resp.status_code, status.HTTP_502_BAD_GATEWAY)
        self.assertEqual(resp.data["code"], "lens_error")

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
