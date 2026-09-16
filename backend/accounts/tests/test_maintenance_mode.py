"""Tests for maintenance mode — instance-wide read-only switch (issue #783).

A note on authentication style, because it is load-bearing here and not a
stylistic choice. Three ways of authenticating a test client reach the
middleware differently, and picking the wrong one silently inverts what a test
proves:

* ``force_authenticate`` binds the user at the DRF *view* layer, so
  ``request.user`` is still ``AnonymousUser`` when the middleware runs. Use it
  for the non-admin cases, where the distinction does not matter.
* ``client.login()`` establishes a real session, so the middleware sees the
  user. This is the only way to exercise the session half of the admin
  exemption.
* ``client.credentials(HTTP_AUTHORIZATION="Token …")`` with a real PAT is the
  only way to exercise the token half — the middleware resolves the token
  itself, which is the whole reason a PAT-bearing admin is not locked out.

Because ``force_authenticate`` never reaches the middleware, a suite that used
only it would pass while a PAT-authenticated admin was locked out of their own
instance.
"""
from io import StringIO
from unittest import mock

from django.core.exceptions import ValidationError
from django.core.management import CommandError, call_command
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import (
    DEFAULT_MAINTENANCE_MESSAGE,
    MAINTENANCE_MESSAGE_MAX_LENGTH,
    PersonalAccessToken,
    SiteSetting,
    User,
    get_maintenance_message,
    get_maintenance_state,
    invalidate_maintenance_mode_cache,
)
from boards.models import Board, BoardMembership, Column, Swimlane
from visiban.middleware import MAINTENANCE_RETRY_AFTER_SECONDS, _is_exempt_path

PASSWORD = "maintpass123!"


def _set_maintenance(active, message=""):
    s = SiteSetting.get()
    s.maintenance_mode = active
    s.maintenance_message = message
    s.save(update_fields=["maintenance_mode", "maintenance_message"])
    return s


class MaintenanceModeBaseTest(TestCase):
    def setUp(self):
        # SiteSetting is a singleton cached across requests; a value cached by a
        # previous test would leak into this one.
        invalidate_maintenance_mode_cache()
        self.addCleanup(invalidate_maintenance_mode_cache)
        self.client = APIClient()
        self.member = User.objects.create_user(username="member", password=PASSWORD)
        self.admin = User.objects.create_user(username="siteadmin", password=PASSWORD)
        self.admin.is_site_admin = True
        self.admin.save(update_fields=["is_site_admin"])
        self.board = Board.objects.create(name="B", owner=self.member)
        BoardMembership.objects.create(
            board=self.board, user=self.member, role=BoardMembership.Role.ADMIN
        )
        BoardMembership.objects.create(
            board=self.board, user=self.admin, role=BoardMembership.Role.ADMIN
        )
        self.column = Column.objects.create(
            board=self.board, name="Backlog", position=0, allow_card_creation=True
        )
        self.swimlane = Swimlane.objects.create(board=self.board, name="General", position=0)

    def _cards_url(self):
        return f"/api/v1/boards/{self.board.pk}/cards/"

    def _card_payload(self, title="New card"):
        return {
            "title": title,
            "column": self.column.pk,
            "swimlane": self.swimlane.pk,
            "position": 0,
        }


class DefaultOffTests(MaintenanceModeBaseTest):
    """An install that never touches the toggle must behave exactly as before.

    This is the backward-compatibility argument for adding a 503 to every
    existing endpoint on a 1.x public API: the new rejection path is
    unreachable until an operator deliberately opts in.
    """

    def test_default_is_off(self):
        self.assertFalse(SiteSetting.get().maintenance_mode)
        self.assertEqual(SiteSetting.get().maintenance_message, "")

    def test_writes_succeed_by_default(self):
        self.client.force_authenticate(self.member)
        r = self.client.post(self._cards_url(), self._card_payload(), format="json")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)

    def test_state_helper_reports_inactive_by_default(self):
        self.assertEqual(get_maintenance_state(), (False, ""))


class WriteBlockingTests(MaintenanceModeBaseTest):
    def test_non_admin_write_returns_503_with_json_body(self):
        _set_maintenance(True)
        self.client.force_authenticate(self.member)
        r = self.client.post(self._cards_url(), self._card_payload(), format="json")
        self.assertEqual(r.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        body = r.json()
        self.assertEqual(body["code"], "maintenance_mode")
        self.assertEqual(body["detail"], DEFAULT_MAINTENANCE_MESSAGE)

    def test_custom_message_is_returned_in_the_503_body(self):
        _set_maintenance(True, "Upgrading to 1.2 — back at 14:00 UTC.")
        self.client.force_authenticate(self.member)
        r = self.client.post(self._cards_url(), self._card_payload(), format="json")
        self.assertEqual(r.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertEqual(r.json()["detail"], "Upgrading to 1.2 — back at 14:00 UTC.")

    def test_blank_message_falls_back_to_the_built_in_default(self):
        _set_maintenance(True, "   ")
        self.client.force_authenticate(self.member)
        r = self.client.post(self._cards_url(), self._card_payload(), format="json")
        self.assertEqual(r.json()["detail"], DEFAULT_MAINTENANCE_MESSAGE)

    def test_reads_still_work(self):
        """Maintenance mode is read-only mode, not an outage."""
        _set_maintenance(True)
        self.client.force_authenticate(self.member)
        r = self.client.get(self._cards_url())
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_patch_and_delete_are_blocked_too(self):
        self.client.force_authenticate(self.member)
        created = self.client.post(self._cards_url(), self._card_payload(), format="json")
        card_id = created.json()["id"]
        _set_maintenance(True)
        detail_url = f"{self._cards_url()}{card_id}/"
        patched = self.client.patch(detail_url, {"title": "Edited"}, format="json")
        self.assertEqual(patched.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        deleted = self.client.delete(detail_url)
        self.assertEqual(deleted.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)

    def test_put_is_blocked_too(self):
        """PUT is a write like PATCH/DELETE — SAFE_METHODS excludes it deliberately."""
        self.client.force_authenticate(self.member)
        created = self.client.post(self._cards_url(), self._card_payload(), format="json")
        card_id = created.json()["id"]
        _set_maintenance(True)
        detail_url = f"{self._cards_url()}{card_id}/"
        r = self.client.put(detail_url, self._card_payload("Replaced"), format="json")
        self.assertEqual(r.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)

    def test_options_is_never_blocked(self):
        """OPTIONS is in SAFE_METHODS — a preflight/introspection request must never 503."""
        _set_maintenance(True)
        r = self.client.options(self._cards_url())
        self.assertNotEqual(r.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)

    def test_anonymous_write_is_blocked(self):
        _set_maintenance(True)
        r = self.client.post(self._cards_url(), self._card_payload(), format="json")
        self.assertEqual(r.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)

    def test_503_advertises_retry_after(self):
        """So PAT and MCP clients back off instead of retry-storming."""
        _set_maintenance(True)
        self.client.force_authenticate(self.member)
        r = self.client.post(self._cards_url(), self._card_payload(), format="json")
        self.assertEqual(r["Retry-After"], str(MAINTENANCE_RETRY_AFTER_SECONDS))


class AdminExemptionTests(MaintenanceModeBaseTest):
    """Site admins with a real session keep full read/write access."""

    def test_admin_session_can_still_write(self):
        _set_maintenance(True)
        self.assertTrue(self.client.login(username="siteadmin", password=PASSWORD))
        r = self.client.post(self._cards_url(), self._card_payload(), format="json")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)

    def test_non_admin_session_is_still_blocked(self):
        """Guards the exemption in the other direction: it is admin-only."""
        _set_maintenance(True)
        self.assertTrue(self.client.login(username="member", password=PASSWORD))
        r = self.client.post(self._cards_url(), self._card_payload(), format="json")
        self.assertEqual(r.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)

    def test_can_access_all_content_does_not_grant_exemption(self):
        """Content visibility is not administrative authority."""
        self.member.can_access_all_content = True
        self.member.save(update_fields=["can_access_all_content"])
        _set_maintenance(True)
        self.assertTrue(self.client.login(username="member", password=PASSWORD))
        r = self.client.post(self._cards_url(), self._card_payload(), format="json")
        self.assertEqual(r.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)


class TokenAuthenticatedAdminTests(MaintenanceModeBaseTest):
    """A site admin must stay exempt through a PAT, not only through a cookie.

    AuthenticationMiddleware populates request.user from the session alone, so
    without the middleware's own token resolution a PAT-bearing admin would be
    locked out of their own instance — and nothing else in the suite would
    notice, because APIClient.force_authenticate never reaches middleware.
    """

    def _use_pat(self, user):
        _, raw = PersonalAccessToken.generate(user, "maintenance-test")
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {raw}")

    def test_admin_pat_can_write(self):
        _set_maintenance(True)
        self._use_pat(self.admin)
        r = self.client.post(self._cards_url(), self._card_payload(), format="json")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)

    def test_non_admin_pat_is_blocked(self):
        _set_maintenance(True)
        self._use_pat(self.member)
        r = self.client.post(self._cards_url(), self._card_payload(), format="json")
        self.assertEqual(r.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)

    def test_garbage_token_is_blocked_not_crashed(self):
        """An unresolvable credential must fail closed, never 500."""
        _set_maintenance(True)
        self.client.credentials(HTTP_AUTHORIZATION="Token vbn_not-a-real-token")
        r = self.client.post(self._cards_url(), self._card_payload(), format="json")
        self.assertEqual(r.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)


class NonExemptAuthPathTests(MaintenanceModeBaseTest):
    """Writes under /api/v1/auth/ that are real writes must still be blocked.

    Exempting the whole auth prefix would have been shorter and would have
    quietly let all three of these through.
    """

    def setUp(self):
        super().setUp()
        _set_maintenance(True)
        self.client.force_authenticate(self.member)

    def test_profile_patch_is_blocked(self):
        r = self.client.patch(
            "/api/v1/auth/user/", {"display_name": "New name"}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.member.refresh_from_db()
        self.assertNotEqual(self.member.display_name, "New name")

    def test_pat_creation_is_blocked(self):
        r = self.client.post("/api/v1/auth/tokens/", {"name": "new"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)

    def test_self_registration_is_blocked(self):
        r = self.client.post(
            "/api/v1/auth/registration/",
            {
                "username": "newcomer",
                "email": "newcomer@example.com",
                "password1": PASSWORD,
                "password2": PASSWORD,
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertFalse(User.objects.filter(username="newcomer").exists())


class NoLockoutTests(MaintenanceModeBaseTest):
    """The off switch must stay reachable. A mode you cannot exit is an outage."""

    def test_admin_can_turn_maintenance_off_while_it_is_on(self):
        _set_maintenance(True)
        self.assertTrue(self.client.login(username="siteadmin", password=PASSWORD))
        r = self.client.patch(
            "/api/v1/admin/settings/", {"maintenance_mode": False}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertFalse(r.json()["maintenance_mode"])
        self.assertFalse(SiteSetting.get().maintenance_mode)

    def test_admin_can_turn_maintenance_off_with_token_style_auth(self):
        """The recovery path must not depend on holding a browser session."""
        _set_maintenance(True)
        self.client.force_authenticate(self.admin)
        r = self.client.patch(
            "/api/v1/admin/settings/", {"maintenance_mode": False}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertFalse(SiteSetting.get().maintenance_mode)

    def test_login_still_works_while_maintenance_is_on(self):
        """Login is a POST; an admin locked out of their session must get back in."""
        _set_maintenance(True)
        r = self.client.post(
            "/api/v1/auth/login/",
            {"username": "siteadmin", "password": PASSWORD},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_non_admin_cannot_reach_the_off_switch(self):
        """The /api/v1/admin/ exemption must not become a privilege escalation.

        The prefix is exempt from the *maintenance* check only; IsSiteAdmin
        still guards it.
        """
        _set_maintenance(True)
        self.client.force_authenticate(self.member)
        r = self.client.patch(
            "/api/v1/admin/settings/", {"maintenance_mode": False}, format="json"
        )
        self.assertIn(
            r.status_code,
            [status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN],
        )
        self.assertTrue(SiteSetting.get().maintenance_mode)


class ImmediateEffectTests(MaintenanceModeBaseTest):
    """"No restart required" — the cache must not hold a stale decision."""

    def test_enabling_takes_effect_on_the_next_request(self):
        self.client.force_authenticate(self.member)
        first = self.client.post(self._cards_url(), self._card_payload("A"), format="json")
        self.assertEqual(first.status_code, status.HTTP_201_CREATED)
        _set_maintenance(True)
        second = self.client.post(self._cards_url(), self._card_payload("B"), format="json")
        self.assertEqual(second.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)

    def test_disabling_takes_effect_on_the_next_request(self):
        _set_maintenance(True)
        self.client.force_authenticate(self.member)
        blocked = self.client.post(self._cards_url(), self._card_payload("A"), format="json")
        self.assertEqual(blocked.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        _set_maintenance(False)
        allowed = self.client.post(self._cards_url(), self._card_payload("B"), format="json")
        self.assertEqual(allowed.status_code, status.HTTP_201_CREATED)

    def test_message_edit_takes_effect_without_toggling_the_mode(self):
        _set_maintenance(True, "First notice.")
        self.client.force_authenticate(self.member)
        self.assertEqual(
            self.client.post(self._cards_url(), self._card_payload(), format="json").json()["detail"],
            "First notice.",
        )
        _set_maintenance(True, "Second notice.")
        self.assertEqual(
            self.client.post(self._cards_url(), self._card_payload(), format="json").json()["detail"],
            "Second notice.",
        )


class ExemptPathTests(MaintenanceModeBaseTest):
    def test_health_probes_are_unaffected(self):
        """An orchestrator must not restart pods mid-maintenance-window."""
        _set_maintenance(True)
        for path in ("/api/health/liveness/", "/api/health/readiness/"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, status.HTTP_200_OK)

    def test_exempt_paths_do_not_read_maintenance_state(self):
        """The recovery path must not depend on the cache or the DB being healthy.

        During a rolling upgrade — new code live, migration 0027 not yet
        applied — reading the state raises. If that read happened before the
        exemption test, login and the admin off switch would 500 during exactly
        the window an operator needs them.
        """
        _set_maintenance(True)
        with mock.patch(
            "visiban.middleware.get_maintenance_state",
            side_effect=AssertionError("state must not be read for an exempt path"),
        ):
            r = self.client.post(
                "/api/v1/auth/login/",
                {"username": "siteadmin", "password": PASSWORD},
                format="json",
            )
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_every_enumerated_exempt_prefix_stays_writable(self):
        """Direct unit coverage of _is_exempt_path over the whole enumerated list.

        The list in visiban.middleware is deliberately enumerated rather than
        prefix-globbed, and each entry carries its own recovery-path or
        break-glass justification. A representative sub-path under every entry
        must resolve exempt, or a future edit that silently drops one goes
        unnoticed until an operator is locked out mid-incident.
        """
        exempt_paths = (
            "/api/v1/admin/settings/",
            "/api/v1/auth/login/",
            "/api/v1/auth/logout/",
            "/api/v1/auth/password/reset/",
            "/api/v1/auth/password/change/",
            "/api/v1/auth/change-password/",
            "/api/v1/auth/choose-username/",
            "/api/v1/auth/ws-ticket/",
            "/admin/login/",
            "/api/health/liveness/",
        )
        for path in exempt_paths:
            with self.subTest(path=path):
                self.assertTrue(_is_exempt_path(path), f"{path} must stay writable during maintenance")

    def test_admin_prefix_trailing_slash_is_not_satisfied_by_a_lookalike_path(self):
        """Guards the exact regression the trailing-slash comment in middleware.py calls out.

        `/api/v1/admin/` must not be satisfiable by a future `/api/v1/administrators/`
        endpoint — str.startswith() would otherwise match the shorter prefix.
        """
        self.assertFalse(_is_exempt_path("/api/v1/administrators/"))
        self.assertFalse(_is_exempt_path("/api/v1/administrators/1/"))

    def test_logout_is_reachable_during_maintenance(self):
        """Nobody should be trapped in a session they cannot end."""
        _set_maintenance(True)
        self.client.force_authenticate(self.member)
        r = self.client.post("/api/v1/auth/logout/")
        self.assertNotEqual(r.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)


class AllauthPathTests(MaintenanceModeBaseTest):
    """allauth mounts its whole tree at /accounts/, so only SSO login is exempt.

    A blanket "/accounts/" prefix would let unauthenticated callers create
    accounts and edit email addresses during a declared write freeze — writes
    into the very tables an operator is most likely to be migrating.
    """

    def setUp(self):
        super().setUp()
        _set_maintenance(True)

    def test_self_service_account_writes_are_blocked(self):
        for path in (
            "/accounts/signup/",
            "/accounts/email/",
            "/accounts/password/change/",
        ):
            with self.subTest(path=path):
                r = self.client.post(path, {})
                self.assertEqual(
                    r.status_code,
                    status.HTTP_503_SERVICE_UNAVAILABLE,
                    f"{path} must not be writable during maintenance",
                )

    def test_signup_creates_no_user(self):
        self.client.post(
            "/accounts/signup/",
            {
                "username": "sneaky",
                "email": "sneaky@example.com",
                "password1": PASSWORD,
                "password2": PASSWORD,
            },
        )
        self.assertFalse(User.objects.filter(username="sneaky").exists())

    def test_sso_login_paths_stay_exempt(self):
        """An SSO-only admin signed out mid-window must still be able to log in."""
        for path in (
            "/accounts/google/login/",
            "/accounts/google/login/callback/",
            "/accounts/oidc/keycloak/login/callback/",
        ):
            with self.subTest(path=path):
                self.assertTrue(
                    _is_exempt_path(path),
                    f"{path} is an SSO login path and must stay writable",
                )

    def test_non_login_allauth_paths_are_not_exempt(self):
        for path in (
            "/accounts/signup/",
            "/accounts/email/",
            "/accounts/password/change/",
            "/accounts/password/set/",
            "/accounts/3rdparty/",
            "/accounts/3rdparty/signup/",
            "/accounts/reauthenticate/",
        ):
            with self.subTest(path=path):
                self.assertFalse(
                    _is_exempt_path(path),
                    f"{path} is a write and must not be exempt",
                )


class AdminSettingsApiTests(MaintenanceModeBaseTest):
    def setUp(self):
        super().setUp()
        self.client.force_authenticate(self.admin)

    def test_get_exposes_the_new_fields(self):
        r = self.client.get("/api/v1/admin/settings/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertFalse(r.json()["maintenance_mode"])
        self.assertEqual(r.json()["maintenance_message"], "")

    def test_patch_sets_mode_and_message(self):
        r = self.client.patch(
            "/api/v1/admin/settings/",
            {"maintenance_mode": True, "maintenance_message": "Back at 5pm."},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        setting = SiteSetting.get()
        self.assertTrue(setting.maintenance_mode)
        self.assertEqual(setting.maintenance_message, "Back at 5pm.")

    def test_patch_does_not_disturb_unrelated_settings(self):
        """Partial update must not reset registration_mode / uploads_enabled."""
        before = SiteSetting.get()
        before.registration_mode = SiteSetting.RegistrationMode.INVITE_ONLY
        before.uploads_enabled = False
        before.save(update_fields=["registration_mode", "uploads_enabled"])
        self.client.patch(
            "/api/v1/admin/settings/", {"maintenance_mode": True}, format="json"
        )
        after = SiteSetting.get()
        self.assertEqual(after.registration_mode, SiteSetting.RegistrationMode.INVITE_ONLY)
        self.assertFalse(after.uploads_enabled)
        self.assertTrue(after.maintenance_mode)

    def test_message_is_length_bounded_at_the_serializer_boundary(self):
        r = self.client.patch(
            "/api/v1/admin/settings/",
            {"maintenance_message": "x" * 1001},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("maintenance_message", r.json())

    def test_message_is_not_rendered_as_html(self):
        """The notice is operator-supplied text and is stored verbatim.

        The SPA renders it as a text node, never via dangerouslySetInnerHTML;
        this pins that the backend does not silently transform it either.
        """
        raw = "<script>alert(1)</script>"
        self.client.patch(
            "/api/v1/admin/settings/",
            {"maintenance_mode": True, "maintenance_message": raw},
            format="json",
        )
        self.assertEqual(SiteSetting.get().maintenance_message, raw)


class CurrentUserSerializerTests(MaintenanceModeBaseTest):
    """The SPA reads banner state from GET /auth/user/."""

    def test_flags_absent_state_when_off(self):
        self.client.force_authenticate(self.member)
        body = self.client.get("/api/v1/auth/user/").json()
        self.assertFalse(body["maintenance_mode"])
        self.assertEqual(body["maintenance_message"], "")

    def test_flags_active_state_with_message(self):
        _set_maintenance(True, "Scheduled upgrade in progress.")
        self.client.force_authenticate(self.member)
        body = self.client.get("/api/v1/auth/user/").json()
        self.assertTrue(body["maintenance_mode"])
        self.assertEqual(body["maintenance_message"], "Scheduled upgrade in progress.")

    def test_default_message_is_substituted_server_side(self):
        """The client never needs a fallback string of its own."""
        _set_maintenance(True)
        self.client.force_authenticate(self.member)
        body = self.client.get("/api/v1/auth/user/").json()
        self.assertEqual(body["maintenance_message"], DEFAULT_MAINTENANCE_MESSAGE)

    def test_admin_sees_the_state_too(self):
        """Admins are exempt from the write block, not hidden from the notice."""
        _set_maintenance(True)
        self.client.force_authenticate(self.admin)
        body = self.client.get("/api/v1/auth/user/").json()
        self.assertTrue(body["maintenance_mode"])


class MaintenanceStateHelperTests(MaintenanceModeBaseTest):
    """Direct unit coverage of the cache-fronting helpers in accounts.models.

    MaintenanceModeMiddleware consults get_maintenance_state() on every
    request, so the cache-hit path is the hot path for every install on
    earth, on or off. A regression here silently turns back into a
    per-request SiteSetting query, which is the exact cost #783 was written
    to avoid.
    """

    def test_cache_miss_reads_the_database_and_populates_the_cache(self):
        _set_maintenance(True, "From the DB.")
        invalidate_maintenance_mode_cache()  # force a miss regardless of _set_maintenance's own save()
        with mock.patch(
            "accounts.models.SiteSetting.get", wraps=SiteSetting.get
        ) as spy:
            result = get_maintenance_state()
            self.assertEqual(spy.call_count, 1)
        self.assertEqual(result, (True, "From the DB."))

    def test_cache_hit_never_touches_the_database(self):
        _set_maintenance(True, "Cached.")
        get_maintenance_state()  # first call populates the cache
        with mock.patch(
            "accounts.models.SiteSetting.get",
            side_effect=AssertionError("cache hit must not read SiteSetting"),
        ):
            result = get_maintenance_state()
        self.assertEqual(result, (True, "Cached."))

    def test_get_maintenance_message_returns_default_for_empty_string(self):
        self.assertEqual(get_maintenance_message(""), DEFAULT_MAINTENANCE_MESSAGE)

    def test_get_maintenance_message_returns_default_for_whitespace_only(self):
        self.assertEqual(get_maintenance_message("   \n\t  "), DEFAULT_MAINTENANCE_MESSAGE)

    def test_get_maintenance_message_strips_surrounding_whitespace_from_a_real_message(self):
        """The stored value may carry incidental whitespace; the served notice must not."""
        self.assertEqual(get_maintenance_message("  Back at 5pm.  "), "Back at 5pm.")

    def test_get_maintenance_message_passes_through_a_real_message_unchanged(self):
        self.assertEqual(get_maintenance_message("Back at 5pm."), "Back at 5pm.")


class SiteSettingModelValidationTests(MaintenanceModeBaseTest):
    """The MaxLengthValidator on SiteSetting.maintenance_message is model-level,
    not just serializer-level — Django admin and management commands/shell
    sessions write the field directly and never go through the serializer.
    """

    def test_full_clean_rejects_a_message_over_the_cap(self):
        setting = SiteSetting.get()
        setting.maintenance_message = "x" * (MAINTENANCE_MESSAGE_MAX_LENGTH + 1)
        with self.assertRaises(ValidationError):
            setting.full_clean()

    def test_full_clean_accepts_a_message_exactly_at_the_cap(self):
        setting = SiteSetting.get()
        setting.maintenance_message = "x" * MAINTENANCE_MESSAGE_MAX_LENGTH
        setting.full_clean()  # must not raise

    def test_full_clean_accepts_a_blank_message(self):
        setting = SiteSetting.get()
        setting.maintenance_message = ""
        setting.full_clean()  # must not raise

    def test_save_does_not_enforce_the_validator(self):
        """.save() never calls full_clean() in Django — only a direct field write
        (management command, shell, Django admin ModelForm) enforces the cap, and
        each of those paths is responsible for calling full_clean()/is_valid()
        itself. This pins that .save() alone is not where the cap is enforced,
        so a future refactor that removes the command's own truncation call
        would not be silently protected by the model.
        """
        setting = SiteSetting.get()
        setting.maintenance_message = "x" * (MAINTENANCE_MESSAGE_MAX_LENGTH + 1)
        setting.save(update_fields=["maintenance_message"])  # does not raise
        setting.refresh_from_db()
        self.assertEqual(len(setting.maintenance_message), MAINTENANCE_MESSAGE_MAX_LENGTH + 1)


class ManagementCommandTests(MaintenanceModeBaseTest):
    """The break-glass path: clearing the flag without a working ingress."""

    def _run(self, *args):
        out = StringIO()
        call_command("maintenance_mode", *args, stdout=out)
        return out.getvalue()

    def test_reports_state_without_changing_it(self):
        output = self._run()
        self.assertIn("OFF", output)
        self.assertFalse(SiteSetting.get().maintenance_mode)

    def test_enables_and_disables(self):
        self._run("--on")
        self.assertTrue(SiteSetting.get().maintenance_mode)
        self._run("--off")
        self.assertFalse(SiteSetting.get().maintenance_mode)

    def test_sets_the_notice(self):
        self._run("--on", "--message", "Back by 14:00 UTC.")
        setting = SiteSetting.get()
        self.assertTrue(setting.maintenance_mode)
        self.assertEqual(setting.maintenance_message, "Back by 14:00 UTC.")

    def test_notice_is_truncated_to_the_cap(self):
        self._run("--message", "x" * 1500)
        self.assertEqual(
            len(SiteSetting.get().maintenance_message), MAINTENANCE_MESSAGE_MAX_LENGTH
        )

    def test_turning_it_off_takes_effect_immediately(self):
        """The whole point: no restart, and no waiting for the cache TTL."""
        _set_maintenance(True)
        self.client.force_authenticate(self.member)
        self.assertEqual(
            self.client.post(self._cards_url(), self._card_payload("A"), format="json").status_code,
            status.HTTP_503_SERVICE_UNAVAILABLE,
        )
        self._run("--off")
        self.assertEqual(
            self.client.post(self._cards_url(), self._card_payload("B"), format="json").status_code,
            status.HTTP_201_CREATED,
        )

    def test_on_and_off_are_mutually_exclusive(self):
        with self.assertRaises(CommandError):
            call_command("maintenance_mode", "--on", "--off")
