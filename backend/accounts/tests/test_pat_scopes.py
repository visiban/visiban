"""Scope matrix for personal access tokens — issue #1110.

The scope vocabulary is STRICTLY NON-HIERARCHICAL. Most of this file exists to
pin that down: for every pair of scopes there is a test asserting one does not
satisfy the other. A convenience implication added later must break something
here.

Three token states are exercised throughout, and they are NOT the same:

    scopes IS NULL  — legacy. Full REST authority (hard backward-compat
                      requirement), never an mcp:* surface.
    scopes == []    — an explicit grant of nothing. Denied everywhere.
    scopes == [...] — exactly those scopes.

Per #1075, every guard also gets an absent-input test: the branch where the
guard's input is missing must deny, not wave through.
"""
from django.test import TestCase
from django.urls import get_resolver
from rest_framework import status
from rest_framework.permissions import BasePermission
from rest_framework.test import APIClient, APIRequestFactory, APITestCase
from rest_framework.views import APIView

from accounts.authentication import (
    ADMIN_API_PREFIX,
    LEGACY_SCOPE_LABEL,
    baseline_scopes_for,
)
from accounts.models import (
    PAT_DEFAULT_SCOPES,
    PAT_SCOPES,
    SCOPE_ADMIN,
    SCOPE_MCP_READ,
    SCOPE_MCP_WRITE,
    SCOPE_READ,
    SCOPE_WRITE,
    PersonalAccessToken,
    User,
)
from accounts.permissions import IsSiteAdmin, TokenHasScope


def make_user(username="scopeuser", **kwargs):
    return User.objects.create_user(username=username, password="ScopePass123!", **kwargs)


def make_admin(username="scopeadmin"):
    user = make_user(username)
    user.is_site_admin = True
    user.save(update_fields=["is_site_admin"])
    return user


def auth(raw_token):
    return {"HTTP_AUTHORIZATION": f"Token {raw_token}"}


class ScopeVocabularyTests(TestCase):
    """The vocabulary itself is part of the contract."""

    def test_vocabulary_is_exactly_the_five_documented_scopes(self):
        self.assertEqual(
            set(PAT_SCOPES),
            {"read", "write", "admin", "mcp:read", "mcp:write"},
        )

    def test_default_scopes_exclude_admin_and_mcp(self):
        """A token created without an explicit request must not get admin or mcp."""
        self.assertNotIn(SCOPE_ADMIN, PAT_DEFAULT_SCOPES)
        self.assertNotIn(SCOPE_MCP_READ, PAT_DEFAULT_SCOPES)
        self.assertNotIn(SCOPE_MCP_WRITE, PAT_DEFAULT_SCOPES)

    def test_generate_without_scopes_creates_a_legacy_token(self):
        pat, _ = PersonalAccessToken.generate(make_user(), "ci")
        self.assertIsNone(pat.scopes)
        self.assertTrue(pat.is_legacy)

    def test_empty_list_is_not_legacy(self):
        """[] and None must never be conflated — [] is a grant of nothing."""
        pat, _ = PersonalAccessToken.generate(make_user(), "ci", scopes=[])
        self.assertFalse(pat.is_legacy)
        self.assertEqual(pat.scopes, [])


class BaselineResolutionTests(TestCase):
    """The path/method baseline resolver, in isolation."""

    def test_safe_method_requires_read_only(self):
        self.assertEqual(baseline_scopes_for("/api/v1/boards/", "GET"), {SCOPE_READ})

    def test_unsafe_method_requires_write_only(self):
        self.assertEqual(baseline_scopes_for("/api/v1/boards/", "POST"), {SCOPE_WRITE})

    def test_admin_path_composes_with_the_verb_scope(self):
        """admin is a surface grant; it does not replace the verb grant."""
        self.assertEqual(
            baseline_scopes_for(f"{ADMIN_API_PREFIX}users/", "GET"),
            {SCOPE_ADMIN, SCOPE_READ},
        )
        self.assertEqual(
            baseline_scopes_for(f"{ADMIN_API_PREFIX}users/", "POST"),
            {SCOPE_ADMIN, SCOPE_WRITE},
        )

    def test_unknown_method_denies(self):
        """Absent/unrecognised input must fail closed, not default to read (#1075)."""
        self.assertIsNone(baseline_scopes_for("/api/v1/boards/", "TRACE"))
        self.assertIsNone(baseline_scopes_for("/api/v1/boards/", ""))

    def test_no_baseline_ever_requires_an_mcp_scope(self):
        """Nothing on the REST surface may demand mcp — and so nothing grants it."""
        for method in ("GET", "POST", "PATCH", "DELETE"):
            for path in ("/api/v1/boards/", f"{ADMIN_API_PREFIX}users/"):
                required = baseline_scopes_for(path, method)
                self.assertFalse(required & {SCOPE_MCP_READ, SCOPE_MCP_WRITE})


class ScopeMatrixRestTests(APITestCase):
    """Each scope against safe / unsafe / admin requests over real endpoints."""

    def setUp(self):
        self.client = APIClient()
        self.user = make_user()

    def _token(self, scopes, user=None):
        _, raw = PersonalAccessToken.generate(user or self.user, "agent", scopes=scopes)
        return raw

    # ── read ──────────────────────────────────────────────────────────────

    def test_read_scope_allows_safe_request(self):
        r = self.client.get("/api/v1/boards/", **auth(self._token([SCOPE_READ])))
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_read_scope_denies_unsafe_request(self):
        r = self.client.post(
            "/api/v1/boards/", {"name": "B"}, **auth(self._token([SCOPE_READ]))
        )
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    # ── write ─────────────────────────────────────────────────────────────

    def test_write_scope_allows_unsafe_request(self):
        r = self.client.post(
            "/api/v1/boards/", {"name": "B"}, **auth(self._token([SCOPE_WRITE]))
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)

    def test_write_does_not_imply_read(self):
        """No hierarchy: a write-only token cannot GET."""
        r = self.client.get("/api/v1/boards/", **auth(self._token([SCOPE_WRITE])))
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_read_does_not_imply_write(self):
        r = self.client.patch(
            "/api/v1/auth/me/", {"display_name": "x"}, **auth(self._token([SCOPE_READ]))
        )
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    # ── admin ─────────────────────────────────────────────────────────────

    def test_admin_route_requires_admin_scope(self):
        admin = make_admin()
        raw = self._token([SCOPE_READ, SCOPE_WRITE], user=admin)
        r = self.client.get("/api/v1/admin/settings/", **auth(raw))
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_admin_scope_allows_admin_route(self):
        admin = make_admin()
        raw = self._token([SCOPE_ADMIN, SCOPE_READ], user=admin)
        r = self.client.get("/api/v1/admin/settings/", **auth(raw))
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_admin_does_not_imply_read(self):
        """admin alone must not open a plain GET — it is a surface, not a verb."""
        admin = make_admin()
        r = self.client.get("/api/v1/boards/", **auth(self._token([SCOPE_ADMIN], user=admin)))
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_admin_does_not_imply_write(self):
        admin = make_admin()
        r = self.client.post(
            "/api/v1/boards/", {"name": "B"}, **auth(self._token([SCOPE_ADMIN], user=admin))
        )
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_admin_scope_on_non_admin_user_still_denied_by_rbac(self):
        """The scope grants nothing the user does not already have."""
        r = self.client.get(
            "/api/v1/admin/settings/", **auth(self._token([SCOPE_ADMIN, SCOPE_READ]))
        )
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    # ── mcp:* ─────────────────────────────────────────────────────────────

    def test_mcp_read_alone_reaches_no_rest_endpoint(self):
        """mcp scopes are not REST scopes — no implication in either direction."""
        raw = self._token([SCOPE_MCP_READ])
        self.assertEqual(
            self.client.get("/api/v1/boards/", **auth(raw)).status_code,
            status.HTTP_403_FORBIDDEN,
        )

    def test_mcp_write_does_not_satisfy_rest_write(self):
        raw = self._token([SCOPE_MCP_WRITE])
        r = self.client.post("/api/v1/boards/", {"name": "B"}, **auth(raw))
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    # ── [] ────────────────────────────────────────────────────────────────

    def test_empty_scope_list_denies_everything(self):
        raw = self._token([])
        self.assertEqual(
            self.client.get("/api/v1/boards/", **auth(raw)).status_code,
            status.HTTP_403_FORBIDDEN,
        )
        self.assertEqual(
            self.client.post("/api/v1/boards/", {"name": "B"}, **auth(raw)).status_code,
            status.HTTP_403_FORBIDDEN,
        )

    # ── error shape ───────────────────────────────────────────────────────

    def test_scope_failure_is_403_not_401(self):
        """A scope problem is an authority problem; 401 would make clients retry forever."""
        r = self.client.get("/api/v1/boards/", **auth(self._token([SCOPE_WRITE])))
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_denial_message_never_echoes_the_tokens_own_scopes(self):
        r = self.client.get("/api/v1/boards/", **auth(self._token([SCOPE_WRITE])))
        detail = r.json()["detail"]
        self.assertIn("read", detail)
        self.assertNotIn("write", detail)


class LegacyTokenCompatibilityTests(APITestCase):
    """scopes IS NULL must behave EXACTLY as before #1110 on REST."""

    def setUp(self):
        self.client = APIClient()
        self.user = make_user()
        _, self.raw = PersonalAccessToken.generate(self.user, "legacy-ci")

    def test_legacy_token_can_read(self):
        r = self.client.get("/api/v1/boards/", **auth(self.raw))
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_legacy_token_can_write(self):
        r = self.client.post("/api/v1/boards/", {"name": "B"}, **auth(self.raw))
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)

    def test_legacy_token_can_reach_admin_routes_for_a_site_admin(self):
        admin = make_admin("legacyadmin")
        _, raw = PersonalAccessToken.generate(admin, "legacy-admin")
        r = self.client.get("/api/v1/admin/settings/", **auth(raw))
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_legacy_token_can_still_mint_and_revoke_tokens(self):
        """Backward compatibility: today's behavior is preserved for legacy tokens."""
        r = self.client.post("/api/v1/auth/tokens/", {"name": "new"}, **auth(self.raw))
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        new_id = r.json()["id"]
        r = self.client.delete(f"/api/v1/auth/tokens/{new_id}/", **auth(self.raw))
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)

    def test_legacy_token_is_rejected_where_an_mcp_scope_is_required(self):
        """The one place legacy authority stops."""
        pat = PersonalAccessToken.objects.get(name="legacy-ci")
        self.assertFalse(
            TokenHasScope().has_permission(
                _request_with(pat), _view_requiring([SCOPE_MCP_READ])
            )
        )

    def test_legacy_token_records_the_legacy_audit_label(self):
        self.client.get("/api/v1/boards/", **auth(self.raw))
        pat = PersonalAccessToken.objects.get(name="legacy-ci")
        self.assertEqual(pat.last_used_scope, LEGACY_SCOPE_LABEL)


class PatManagementPrivilegeEscalationTests(APITestCase):
    """A scoped token must never be able to widen itself (the #1110 headline hole)."""

    def setUp(self):
        self.client = APIClient()
        self.user = make_user()

    def test_read_scoped_token_cannot_mint_a_token(self):
        _, raw = PersonalAccessToken.generate(self.user, "agent", scopes=[SCOPE_READ])
        r = self.client.post(
            "/api/v1/auth/tokens/",
            {"name": "escalated", "scopes": [SCOPE_ADMIN, SCOPE_WRITE]},
            **auth(raw),
        )
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(self.user.personal_access_tokens.count(), 1)

    def test_write_scoped_token_cannot_mint_a_token(self):
        _, raw = PersonalAccessToken.generate(self.user, "agent", scopes=[SCOPE_WRITE])
        r = self.client.post("/api/v1/auth/tokens/", {"name": "x"}, **auth(raw))
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_admin_scoped_token_cannot_mint_a_token(self):
        admin = make_admin("mintadmin")
        _, raw = PersonalAccessToken.generate(
            admin, "agent", scopes=[SCOPE_ADMIN, SCOPE_WRITE]
        )
        r = self.client.post("/api/v1/auth/tokens/", {"name": "x"}, **auth(raw))
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_scoped_token_cannot_revoke_a_token(self):
        pat, raw = PersonalAccessToken.generate(self.user, "agent", scopes=[SCOPE_WRITE])
        r = self.client.delete(f"/api/v1/auth/tokens/{pat.id}/", **auth(raw))
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertTrue(PersonalAccessToken.objects.filter(pk=pat.pk).exists())

    def test_read_scoped_token_may_list_tokens(self):
        """Listing is a read; only minting and revoking are closed off."""
        _, raw = PersonalAccessToken.generate(self.user, "agent", scopes=[SCOPE_READ])
        r = self.client.get("/api/v1/auth/tokens/", **auth(raw))
        self.assertEqual(r.status_code, status.HTTP_200_OK)


class SessionAuthUnaffectedTests(APITestCase):
    """The blast-radius invariant: SPA traffic must not notice any of this."""

    def setUp(self):
        self.client = APIClient()
        self.user = make_user()

    def test_session_user_can_read(self):
        self.client.force_authenticate(self.user)
        self.assertEqual(
            self.client.get("/api/v1/boards/").status_code, status.HTTP_200_OK
        )

    def test_session_user_can_write(self):
        self.client.force_authenticate(self.user)
        r = self.client.post("/api/v1/boards/", {"name": "B"})
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)

    def test_session_admin_can_reach_admin_routes(self):
        self.client.force_authenticate(make_admin("sessionadmin"))
        self.assertEqual(
            self.client.get("/api/v1/admin/settings/").status_code, status.HTTP_200_OK
        )

    def test_session_user_can_mint_tokens(self):
        self.client.force_authenticate(self.user)
        r = self.client.post("/api/v1/auth/tokens/", {"name": "ci"})
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)

    def test_session_user_is_not_blocked_by_an_mcp_requirement(self):
        """request.auth is None for session auth — TokenHasScope must no-op."""
        request = APIRequestFactory().get("/api/v1/boards/")
        request.auth = None
        self.assertTrue(
            TokenHasScope().has_permission(request, _view_requiring([SCOPE_MCP_READ]))
        )


class ForcedChangeEndpointsStayReachableTests(APITestCase):
    """/auth/user/ must stay reachable under a pending forced change.

    Regression guard for a bug introduced while wiring TokenHasScope (#1110):
    the dj-rest-auth UserDetailsView override initially also declared the
    MustNotHavePending* gates. That endpoint is how the SPA *discovers*
    must_change_password / must_change_username — useAuth bootstraps through it
    and LoginPage re-fetches it after login — so gating it on those flags locked
    the affected user out of the flow that clears them: login succeeded, the
    follow-up fetch 403'd, and the forced-change modal never rendered.

    Only the scope gate belongs on these endpoints. This scenario had no
    coverage anywhere in the suite before #1110.
    """

    def setUp(self):
        self.client = APIClient()

    def _user_with(self, **flags):
        user = make_user("forced")
        for field, value in flags.items():
            setattr(user, field, value)
        user.save(update_fields=list(flags))
        return user

    def test_pending_password_change_can_still_fetch_current_user(self):
        user = self._user_with(must_change_password=True)
        self.client.force_authenticate(user)
        r = self.client.get("/api/v1/auth/user/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertTrue(r.json()["must_change_password"])

    def test_pending_username_change_can_still_fetch_current_user(self):
        user = self._user_with(must_change_username=True)
        self.client.force_authenticate(user)
        r = self.client.get("/api/v1/auth/user/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertTrue(r.json()["must_change_username"])

    def test_both_flags_set_can_still_fetch_current_user(self):
        user = self._user_with(must_change_password=True, must_change_username=True)
        self.client.force_authenticate(user)
        self.assertEqual(
            self.client.get("/api/v1/auth/user/").status_code, status.HTTP_200_OK
        )

    def test_pending_change_still_blocks_an_ordinary_endpoint(self):
        """The gates must still apply everywhere they did before."""
        user = self._user_with(must_change_password=True)
        self.client.force_authenticate(user)
        self.assertEqual(
            self.client.get("/api/v1/boards/").status_code, status.HTTP_403_FORBIDDEN
        )

    def test_pat_on_current_user_endpoint_still_needs_the_read_scope(self):
        """Dropping the pending-change gates must not drop the scope gate too."""
        user = make_user("scopedforced")
        _, raw = PersonalAccessToken.generate(user, "a", scopes=[SCOPE_WRITE])
        r = self.client.get("/api/v1/auth/user/", **auth(raw))
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_pat_with_read_scope_reaches_the_current_user_endpoint(self):
        user = make_user("scopedok")
        _, raw = PersonalAccessToken.generate(user, "a", scopes=[SCOPE_READ])
        r = self.client.get("/api/v1/auth/user/", **auth(raw))
        self.assertEqual(r.status_code, status.HTTP_200_OK)


class PasswordChangeRevokesTokensOnBothRoutesTests(APITestCase):
    """"Password change revokes all tokens" must hold on EVERY password route.

    Two endpoints can change a password: Visiban's own
    /api/v1/auth/change-password/ and dj-rest-auth's /api/v1/auth/password/change/.
    Only the first enforced the revocation invariant that
    PersonalAccessToken documents and that the docs tell users to rely on for
    cutting off a leaked token, so the guarantee held or not depending on which
    URL the caller happened to find. Flagged by the #1110 security review.
    """

    def setUp(self):
        self.client = APIClient()
        self.user = make_user("pwuser")
        self.client.force_authenticate(self.user)

    def test_visiban_change_password_route_revokes_tokens(self):
        PersonalAccessToken.generate(self.user, "a", scopes=[SCOPE_READ])
        r = self.client.post("/api/v1/auth/change-password/", {
            "current_password": "ScopePass123!",
            "new_password": "BrandNewPass456!",
        })
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(self.user.personal_access_tokens.count(), 0)

    def test_dj_rest_auth_password_change_route_also_revokes_tokens(self):
        PersonalAccessToken.generate(self.user, "a", scopes=[SCOPE_READ])
        PersonalAccessToken.generate(self.user, "b", scopes=[SCOPE_MCP_READ])
        r = self.client.post("/api/v1/auth/password/change/", {
            "new_password1": "BrandNewPass456!",
            "new_password2": "BrandNewPass456!",
        })
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(self.user.personal_access_tokens.count(), 0)

    def test_a_failed_password_change_does_not_revoke_tokens(self):
        """Only a successful change revokes — a rejected one must be inert."""
        PersonalAccessToken.generate(self.user, "a", scopes=[SCOPE_READ])
        r = self.client.post("/api/v1/auth/password/change/", {
            "new_password1": "x",
            "new_password2": "y",
        })
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(self.user.personal_access_tokens.count(), 1)


class RevokedMidRequestTests(APITestCase):
    """A token deleted between resolution and the usage write must 401, not 500."""

    def test_token_revoked_after_resolution_is_rejected_cleanly(self):
        from accounts.authentication import (
            InvalidPersonalAccessToken,
            record_token_usage,
        )

        user = make_user("raceuser")
        pat, _ = PersonalAccessToken.generate(user, "a", scopes=[SCOPE_READ])
        # Simulate the race: the row is gone by the time the UPDATE lands.
        PersonalAccessToken.objects.filter(pk=pat.pk).delete()
        with self.assertRaises(InvalidPersonalAccessToken):
            record_token_usage(pat, SCOPE_READ)


class TokenHasScopeAbsentInputTests(TestCase):
    """#1075: every guard needs a test for the branch where its input is absent."""

    def setUp(self):
        self.user = make_user()

    def test_no_auth_object_is_a_no_op(self):
        request = APIRequestFactory().get("/api/v1/boards/")
        request.auth = None
        self.assertTrue(TokenHasScope().has_permission(request, _view_requiring(None)))

    def test_non_pat_auth_object_is_a_no_op(self):
        """A DRF TokenAuthentication key must not be treated as a PAT."""
        request = APIRequestFactory().get("/api/v1/boards/")
        request.auth = "9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b"
        self.assertTrue(TokenHasScope().has_permission(request, _view_requiring(None)))

    def test_object_that_merely_looks_like_a_pat_is_not_accepted(self):
        """Duck-typing here would be the fail-open shape #1075 exists to remove."""

        class NotAToken:
            scopes = [SCOPE_MCP_READ]

        request = APIRequestFactory().get("/api/v1/boards/")
        request.auth = NotAToken()
        # A no-op (True) is correct: it is not a PAT, so PAT scoping does not
        # apply. What must NOT happen is its `scopes` being read as authority.
        self.assertTrue(
            TokenHasScope().has_permission(request, _view_requiring([SCOPE_MCP_READ]))
        )

    def test_view_without_required_scopes_attribute_does_not_crash(self):
        pat, _ = PersonalAccessToken.generate(self.user, "a", scopes=[SCOPE_READ])
        view = APIView()
        self.assertTrue(TokenHasScope().has_permission(_request_with(pat), view))

    def test_empty_scope_list_denies_even_with_no_requirement(self):
        pat, _ = PersonalAccessToken.generate(self.user, "a", scopes=[])
        self.assertFalse(
            TokenHasScope().has_permission(_request_with(pat), _view_requiring(None))
        )

    def test_required_scopes_is_all_of_not_any_of(self):
        pat, _ = PersonalAccessToken.generate(self.user, "a", scopes=[SCOPE_MCP_READ])
        view = _view_requiring([SCOPE_MCP_READ, SCOPE_MCP_WRITE])
        self.assertFalse(TokenHasScope().has_permission(_request_with(pat), view))

    def test_all_required_scopes_present_allows(self):
        pat, _ = PersonalAccessToken.generate(
            self.user, "a", scopes=[SCOPE_MCP_READ, SCOPE_MCP_WRITE]
        )
        view = _view_requiring([SCOPE_MCP_READ, SCOPE_MCP_WRITE])
        self.assertTrue(TokenHasScope().has_permission(_request_with(pat), view))

    def test_admin_scope_does_not_satisfy_an_mcp_requirement(self):
        pat, _ = PersonalAccessToken.generate(self.user, "a", scopes=[SCOPE_ADMIN])
        self.assertFalse(
            TokenHasScope().has_permission(
                _request_with(pat), _view_requiring([SCOPE_MCP_READ])
            )
        )

    def test_site_admin_gated_view_adds_the_admin_requirement(self):
        """The class-introspection half of the admin-surface union."""
        pat, _ = PersonalAccessToken.generate(self.user, "a", scopes=[SCOPE_READ])
        view = _view_gated_by(IsSiteAdmin)
        self.assertFalse(TokenHasScope().has_permission(_request_with(pat), view))

        pat2, _ = PersonalAccessToken.generate(
            self.user, "b", scopes=[SCOPE_READ, SCOPE_ADMIN]
        )
        self.assertTrue(TokenHasScope().has_permission(_request_with(pat2), view))

    def test_site_admin_subclass_is_also_detected(self):
        class StricterSiteAdmin(IsSiteAdmin):
            pass

        pat, _ = PersonalAccessToken.generate(self.user, "a", scopes=[SCOPE_READ])
        self.assertFalse(
            TokenHasScope().has_permission(
                _request_with(pat), _view_gated_by(StricterSiteAdmin)
            )
        )


class AdminSurfaceUnionConformanceTests(TestCase):
    """The two admin signals must agree across the whole URLconf.

    Path prefix and IsSiteAdmin introspection are a union, so disagreement fails
    closed rather than open — but a disagreement still means one of the two has
    drifted, and that is a finding. Today they agree exactly; this test is here
    to notice the day they stop.
    """

    def test_every_site_admin_gated_route_lives_under_the_admin_prefix(self):
        mismatches = []
        for pattern, path in _iter_api_routes():
            if getattr(pattern.callback, "cls", None) is None:
                continue
            gated = any(
                isinstance(p, type) and issubclass(p, IsSiteAdmin)
                for p in (_effective_permission_classes(pattern) or ())
            )
            under_prefix = path.startswith(ADMIN_API_PREFIX.lstrip("/"))
            if gated != under_prefix:
                mismatches.append(f"{path} (IsSiteAdmin={gated}, under_prefix={under_prefix})")
        self.assertEqual(
            mismatches,
            [],
            "Admin-surface signals disagree; the scope baseline in "
            "PATAuthentication and TokenHasScope no longer cover the same routes:\n"
            + "\n".join(mismatches),
        )


class PermissionChainConformanceTests(TestCase):
    """Every authenticated API route must declare TokenHasScope.

    Replaces the hand-enumerated style of boards/tests/test_explicit_permissions.py
    for this gate. That file lists viewsets by name, which is exactly why the
    missing MustNotHavePendingUsernameChange on the admin endpoints survived
    unnoticed until #1110. A view added tomorrow is covered by this test
    automatically; it would not be covered by a named assertion.
    """

    # There is deliberately NO exemption allowlist. Anonymous routes are already
    # excluded structurally below — by `authentication_classes = []` (no
    # credential can reach them) or by an AllowAny-only chain — which is a
    # property of the route itself rather than a name somebody remembered to
    # maintain. Every authenticated route under api/ currently passes with no
    # exemptions at all, under every combination of GIT_LENS_ENABLED and
    # MCP_SERVER_ENABLED.
    #
    # An earlier draft of this test carried a suffix allowlist. It was removed
    # because it was both dead and actively harmful: suffix matching meant
    # "version/" would have silently exempted the authenticated /api/v1/version/
    # route, masking exactly the kind of regression this test exists to catch.
    # If a genuinely anonymous route ever needs an entry here, prefer making its
    # anonymity explicit on the view (authentication_classes = []) over adding a
    # name to a list.

    def test_every_authenticated_route_declares_token_has_scope(self):
        missing = []
        for pattern, path in _iter_api_routes():
            view_cls = getattr(pattern.callback, "cls", None)
            if view_cls is None:
                continue
            perms = _effective_permission_classes(pattern) or ()
            auth_classes = getattr(view_cls, "authentication_classes", None)
            # authentication_classes = [] -> no credential can reach this view.
            if auth_classes is not None and len(auth_classes) == 0:
                continue
            # permission_classes = [] or [AllowAny] -> anonymous surface.
            if not perms or all(
                p.__name__ == "AllowAny" for p in perms if isinstance(p, type)
            ):
                continue
            if any(p is TokenHasScope for p in perms):
                continue
            missing.append(f"{path} -> {view_cls.__name__}")

        self.assertEqual(
            missing,
            [],
            "These authenticated routes do not declare TokenHasScope, so a "
            "personal access token bypasses per-view scope checks on them:\n"
            + "\n".join(missing),
        )

    def test_admin_permission_chain_includes_both_pending_change_gates(self):
        """Regression guard for the drift found by the #1110 architect review."""
        from accounts.admin_views import _ADMIN_PERMISSIONS
        from visiban.permissions import (
            MustNotHavePendingPasswordChange,
            MustNotHavePendingUsernameChange,
        )

        self.assertIn(IsSiteAdmin, _ADMIN_PERMISSIONS)
        self.assertIn(MustNotHavePendingPasswordChange, _ADMIN_PERMISSIONS)
        self.assertIn(MustNotHavePendingUsernameChange, _ADMIN_PERMISSIONS)
        self.assertIn(TokenHasScope, _ADMIN_PERMISSIONS)


class TokenCreateApiScopeTests(APITestCase):
    """POST/GET /api/v1/auth/tokens/ expose and validate `scopes`."""

    def setUp(self):
        self.client = APIClient()
        self.user = make_user()
        self.client.force_authenticate(self.user)
        self.url = "/api/v1/auth/tokens/"

    def test_create_defaults_to_explicit_scopes_never_null(self):
        r = self.client.post(self.url, {"name": "ci"})
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertEqual(r.json()["scopes"], PAT_DEFAULT_SCOPES)
        self.assertIsNotNone(PersonalAccessToken.objects.get(name="ci").scopes)

    def test_create_accepts_an_explicit_scope_list(self):
        r = self.client.post(
            self.url, {"name": "agent", "scopes": [SCOPE_MCP_READ]}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertEqual(r.json()["scopes"], [SCOPE_MCP_READ])

    def test_create_rejects_an_unknown_scope(self):
        r = self.client.post(
            self.url, {"name": "agent", "scopes": ["superuser"]}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("superuser", r.json()["detail"])
        self.assertEqual(PersonalAccessToken.objects.count(), 0)

    def test_create_rejects_an_empty_scope_list(self):
        """A token with no authority is a footgun, not a feature."""
        r = self.client.post(self.url, {"name": "agent", "scopes": []}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_create_deduplicates_and_canonicalises_order(self):
        r = self.client.post(
            self.url,
            {"name": "agent", "scopes": [SCOPE_WRITE, SCOPE_READ, SCOPE_WRITE]},
            format="json",
        )
        self.assertEqual(r.json()["scopes"], [SCOPE_READ, SCOPE_WRITE])

    def test_list_exposes_scopes(self):
        PersonalAccessToken.generate(self.user, "a", scopes=[SCOPE_READ])
        r = self.client.get(self.url)
        self.assertEqual(r.json()[0]["scopes"], [SCOPE_READ])

    def test_list_exposes_null_scopes_for_a_legacy_token(self):
        """The TypeScript interface types this as `string[] | null` for this reason."""
        PersonalAccessToken.generate(self.user, "legacy")
        r = self.client.get(self.url)
        self.assertIsNone(r.json()[0]["scopes"])

    def test_response_never_includes_the_raw_token_on_list(self):
        PersonalAccessToken.generate(self.user, "a", scopes=[SCOPE_READ])
        for token in self.client.get(self.url).json():
            self.assertNotIn("token", token)

    def test_last_used_scope_is_never_exposed_by_the_api(self):
        """Audit metadata, not client-facing state."""
        PersonalAccessToken.generate(self.user, "a", scopes=[SCOPE_READ])
        self.assertNotIn("last_used_scope", self.client.get(self.url).json()[0])


class ScopeAuditTrailTests(APITestCase):
    """"Record the scope actually presented, not a constant."""

    def setUp(self):
        self.client = APIClient()
        self.user = make_user()

    def test_records_the_satisfied_requirement_for_a_safe_request(self):
        pat, raw = PersonalAccessToken.generate(
            self.user, "a", scopes=[SCOPE_READ, SCOPE_WRITE]
        )
        self.client.get("/api/v1/boards/", **auth(raw))
        pat.refresh_from_db()
        self.assertEqual(pat.last_used_scope, SCOPE_READ)

    def test_records_a_different_value_for_an_unsafe_request(self):
        """If this were a constant, these two tests would agree."""
        pat, raw = PersonalAccessToken.generate(
            self.user, "a", scopes=[SCOPE_READ, SCOPE_WRITE]
        )
        self.client.post("/api/v1/boards/", {"name": "B"}, **auth(raw))
        pat.refresh_from_db()
        self.assertEqual(pat.last_used_scope, SCOPE_WRITE)

    def test_records_the_composed_admin_requirement(self):
        admin = make_admin("auditadmin")
        pat, raw = PersonalAccessToken.generate(
            admin, "a", scopes=[SCOPE_ADMIN, SCOPE_READ]
        )
        self.client.get("/api/v1/admin/settings/", **auth(raw))
        pat.refresh_from_db()
        self.assertEqual(pat.last_used_scope, "admin read")

    def test_last_used_at_is_still_recorded(self):
        pat, raw = PersonalAccessToken.generate(self.user, "a", scopes=[SCOPE_READ])
        self.client.get("/api/v1/boards/", **auth(raw))
        pat.refresh_from_db()
        self.assertIsNotNone(pat.last_used_at)

    def test_a_denied_request_does_not_record_a_scope_it_did_not_have(self):
        pat, raw = PersonalAccessToken.generate(self.user, "a", scopes=[SCOPE_READ])
        self.client.post("/api/v1/boards/", {"name": "B"}, **auth(raw))
        pat.refresh_from_db()
        self.assertIsNone(pat.last_used_scope)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _request_with(pat):
    request = APIRequestFactory().get("/api/v1/boards/")
    request.auth = pat
    return request


def _view_requiring(scopes):
    view = APIView()
    if scopes is not None:
        view.required_scopes = scopes
    return view


def _view_gated_by(permission_class: type[BasePermission]):
    view = APIView()
    view.permission_classes = [permission_class]
    return view


def _normalize(path: str) -> str:
    """Strip regex anchors so re_path and path() spellings compare equal."""
    return path.replace("^", "").replace("?$", "").replace("$", "")


def _iter_api_routes():
    """Yield (url_pattern, full_path) for every reachable route under api/.

    Deduplicated on the normalized path keeping the FIRST occurrence, because
    that is how Django resolves: several overrides in visiban/urls.py are
    registered ahead of a dj_rest_auth include that also declares the same
    path, and the shadowed pattern is never reached. Walking it anyway would
    report a view no request can land on.
    """
    def walk(patterns, prefix=""):
        for pattern in patterns:
            if hasattr(pattern, "url_patterns"):
                yield from walk(pattern.url_patterns, prefix + str(pattern.pattern))
            else:
                yield pattern, prefix + str(pattern.pattern)

    seen = set()
    for pattern, path in walk(get_resolver().url_patterns):
        if not path.startswith("api/"):
            continue
        normalized = _normalize(path)
        if normalized in seen:
            continue
        seen.add(normalized)
        yield pattern, normalized


def _effective_permission_classes(pattern):
    """Resolve the permission classes a request to this route actually gets.

    ``as_view(permission_classes=[...])`` stores an initkwarg rather than
    setting the class attribute, so reading the class alone reports the
    third-party default and misses the override. Reading only the class is the
    guard-degrades-to-wrong-answer shape this file is about.
    """
    initkwargs = getattr(pattern.callback, "initkwargs", None) or {}
    if "permission_classes" in initkwargs:
        return initkwargs["permission_classes"]
    view_cls = getattr(pattern.callback, "cls", None)
    return getattr(view_cls, "permission_classes", None)


class WSTicketScopeTests(APITestCase):
    """The WebSocket ticket endpoint is where a PAT's scope meets realtime (#1109 × #1110).

    The WS middleware accepts tickets and nothing else — never a PAT — so this
    endpoint is the only place a token's authority is checked before it reaches
    the socket. If it ever stopped enforcing scope, every scoped token would
    hold unscoped realtime access and no other test in this file would notice.
    """

    def setUp(self):
        self.client = APIClient()
        self.user = make_user()

    def _token(self, scopes):
        _, raw = PersonalAccessToken.generate(self.user, "agent", scopes=scopes)
        return raw

    def test_write_scope_can_mint_a_ticket(self):
        r = self.client.post("/api/v1/auth/ws-ticket/", **auth(self._token([SCOPE_WRITE])))
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertIn("ticket", r.data)

    def test_read_only_token_cannot_mint_a_ticket(self):
        """Minting is a POST, so the path/method baseline requires `write`.

        Documented rather than merely observed: a read-only integration cannot
        currently use the realtime stream. Changing that means adding a path
        exception to baseline_scopes_for(), which is a deliberate design
        decision and not something to arrive at by accident.
        """
        r = self.client.post("/api/v1/auth/ws-ticket/", **auth(self._token([SCOPE_READ])))
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_empty_scope_token_cannot_mint_a_ticket(self):
        r = self.client.post("/api/v1/auth/ws-ticket/", **auth(self._token([])))
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_legacy_token_can_still_mint_a_ticket(self):
        """scopes IS NULL keeps full REST authority — backward compatibility."""
        r = self.client.post("/api/v1/auth/ws-ticket/", **auth(self._token(None)))
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
