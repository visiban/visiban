"""Forced-change gates and password finalization on the session HTML surfaces (#1551).

Registry Rules 1 and 3 (``docs/development/security-invariants.md``):

- ``visiban.middleware.PendingAccountActionMiddleware`` applies the
  forced-change gates to allauth's pages under ``/accounts/`` and to the Django
  admin under ``/admin/``, with the exemptions decided on the resolved view
  (#1561; the per-route table is in ``test_auth_entry_points.py``).
- Each web, API and Django admin route that sets a password applies the shared follow-up in
  ``accounts.credentials`` in the same transaction as the save: allauth's HTML
  change, set and reset-by-key forms (``accounts.forms``, with allauth's
  password signals as an idempotent backstop), the REST reset-confirm
  serializer and the Django admin's per-user password form.
"""

from unittest import mock

from allauth.account import signals as allauth_signals
from allauth.account.forms import default_token_generator
from allauth.account.utils import user_pk_to_url_str
from django.contrib import admin
from django.core.cache import cache
from django.test import Client, TestCase, override_settings
from django.urls import path as url_path
from rest_framework.authtoken.models import Token
from rest_framework.test import APIClient

from accounts import credentials
from accounts.checks import (
    check_frontend_url_outside_pending_action_gate,
    check_pending_action_extra_gated_prefixes,
)
from accounts.models import PersonalAccessToken, User
from visiban.middleware import PENDING_ACTION_REFUSAL, is_pending_action_gated_path

FRONTEND = "https://app.example.test"
SPA_SETTINGS = f"{FRONTEND}/settings"
CURRENT = "Current-Passw0rd!"  # gitleaks:allow -- test-only fixture password, not a credential
NEW = "Brand-New-Passw0rd!"  # gitleaks:allow -- test-only fixture password, not a credential
OTHER = "Another-Passw0rd!9"  # gitleaks:allow -- test-only fixture password, not a credential

# Admin and allauth pages render templates that reference static files; the
# manifest storage needs collectstatic, which tests do not run.
PLAIN_STATIC = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
}


def _user(username, *, staff=False, password=CURRENT, **flags):
    user = User.objects.create_user(
        username=username, email=f"{username}@example.com", password=password
    )
    if staff:
        user.is_staff = True
        user.is_superuser = True
    for name, value in flags.items():
        setattr(user, name, value)
    user.save()
    return user


def _with_credentials(user):
    PersonalAccessToken.generate(user, "cli")
    PersonalAccessToken.generate(user, "ci")
    Token.objects.create(user=user)
    return user


def _logged_in(user):
    client = Client()
    client.force_login(user)
    return client


def _is_logged_in(client):
    return "_auth_user_id" in client.session


def _session_is_valid(client):
    """True if the client's session still authenticates (password hash unchanged)."""
    return client.get("/api/v1/auth/me/").status_code == 200


# ---------------------------------------------------------------------------
# Layer 1: the middleware
# ---------------------------------------------------------------------------

GATED_GET_PATHS = (
    "/accounts/password/change/",
    "/accounts/password/set/",
    "/accounts/email/",
    "/accounts/3rdparty/",
    "/accounts/reauthenticate/",
    "/admin/",
    "/admin/login/",
)


@override_settings(FRONTEND_URL=FRONTEND, STORAGES=PLAIN_STATIC)
class PendingUserIsGatedTests(TestCase):
    flags = {"must_change_password": True}

    def setUp(self):
        cache.clear()
        self.user = _with_credentials(_user("pending", staff=True, **self.flags))
        self.client = _logged_in(self.user)

    def test_get_redirects_to_the_spa(self):
        for path in GATED_GET_PATHS:
            with self.subTest(path=path):
                r = self.client.get(path)
                self.assertEqual(r.status_code, 302)
                self.assertEqual(r["Location"], FRONTEND)

    def test_head_redirects_to_the_spa(self):
        r = self.client.head("/accounts/email/")
        self.assertEqual(r.status_code, 302)
        self.assertEqual(r["Location"], FRONTEND)

    def test_no_slash_form_is_gated_too(self):
        r = self.client.get("/admin")
        self.assertEqual(r.status_code, 302)
        self.assertEqual(r["Location"], FRONTEND)

    def test_write_is_refused_and_changes_nothing(self):
        before = User.objects.get(pk=self.user.pk).password
        for path, body in (
            (
                "/accounts/password/change/",
                {"oldpassword": CURRENT, "password1": NEW, "password2": NEW},
            ),
            ("/accounts/password/set/", {"password1": NEW, "password2": NEW}),
            ("/accounts/email/", {"action_add": "", "email": "added@example.com"}),
            ("/accounts/3rdparty/", {"account": "1"}),
            ("/admin/", {}),
        ):
            with self.subTest(path=path):
                r = self.client.post(path, body)
                self.assertEqual(r.status_code, 403)
                # A fixed message: it does not say which change is pending.
                self.assertEqual(r.content.decode(), PENDING_ACTION_REFUSAL)
        self.user.refresh_from_db()
        self.assertEqual(self.user.password, before)
        self.assertEqual(self.user.personal_access_tokens.count(), 2)
        self.assertFalse(
            self.user.emailaddress_set.filter(email="added@example.com").exists()
        )

    def test_response_does_not_echo_next(self):
        r = self.client.get("/accounts/email/?next=/evil/")
        self.assertEqual(r["Location"], FRONTEND)

    def test_redirect_target_is_not_gated(self):
        """Following the redirect cannot loop back into the gate."""
        r = self.client.get("/accounts/password/change/")
        self.assertFalse(
            is_pending_action_gated_path(r["Location"].replace(FRONTEND, "") or "/")
        )

    @override_settings(FRONTEND_URL="http://testserver/")
    def test_same_origin_redirect_is_a_single_hop(self):
        r = self.client.get("/accounts/email/")
        self.assertEqual(r["Location"], "http://testserver/")
        follow = self.client.get("/")
        self.assertNotEqual(follow.status_code, 302)

    def test_sso_round_trip_is_not_gated_for_an_authenticated_pending_user(self):
        """Sign-in views pass; a connect attempt is refused by the adapter instead."""
        for path in ("/accounts/google/login/", "/accounts/google/login/callback/"):
            with self.subTest(path=path):
                r = self.client.get(path)
                self.assertNotEqual(r.get("Location"), FRONTEND)
                self.assertNotEqual(r.status_code, 403)

    def test_other_provider_views_stay_gated(self):
        r = self.client.get("/accounts/google/login/token/")
        self.assertEqual(r.status_code, 302)
        self.assertEqual(r["Location"], FRONTEND)
        self.assertEqual(self.client.post("/accounts/google/login/token/").status_code, 403)

    def test_confirm_email_link_reaches_the_spa_with_its_key(self):
        r = self.client.get("/accounts/confirm-email/abc:def/")
        self.assertEqual(r.status_code, 302)
        self.assertTrue(r["Location"].endswith("/confirm-email/abc:def"), r["Location"])

    def test_signup_redirect_override_is_gated_in_one_hop(self):
        r = self.client.get("/accounts/3rdparty/signup/")
        self.assertEqual(r.status_code, 302)
        self.assertEqual(r["Location"], FRONTEND)

    def test_password_reset_pages_are_reachable(self):
        for path in ("/accounts/password/reset/", "/accounts/password/reset/done/"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 200)

    def test_reset_by_key_clears_the_pending_password_change(self):
        """The emailed key works while signed in, as it does signed out."""
        r = self.client.get(
            f"/accounts/password/reset/key/{user_pk_to_url_str(self.user)}-"
            f"{default_token_generator.make_token(self.user)}/"
        )
        self.assertEqual(r.status_code, 302)
        self.assertNotEqual(r["Location"], FRONTEND)
        r = self.client.post(r["Location"], {"password1": NEW, "password2": NEW})
        self.assertNotEqual(r.status_code, 403)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(NEW))
        self.assertFalse(self.user.must_change_password)
        self.assertEqual(self.user.personal_access_tokens.count(), 0)

    def test_exempt_views_match_by_resolved_view(self):
        """Exemption follows the resolved view."""
        # allauth's reset-by-key key accepts slashes, so this path is still the
        # reset view (an invalid-link page), never the email view it spells.
        r = self.client.post(
            "/accounts/password/reset/key/1-x/../../../email/",
            {"action_add": "", "email": "second-address@example.com"},
        )
        self.assertEqual(r.resolver_match.view_name, "account_reset_password_from_key")
        for path in (
            "/accounts/logout/../email/",
            "/accounts/password/reset/done/x/",
            "/admin/logout/x/",
            "/admin/logoutx/",
        ):
            with self.subTest(path=path):
                r = self.client.post(path, {"action_add": "", "email": "second-address@example.com"})
                self.assertIn(r.status_code, (403, 404), r.status_code)
        self.assertFalse(
            self.user.emailaddress_set.filter(email="second-address@example.com").exists()
        )

    def test_encoded_and_doubled_slash_paths_reach_no_view(self):
        for path in ("//admin/", "//accounts/email/", "/ADMIN/", "/Accounts/email/"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 404)
        r = self.client.get("/%61dmin/")
        self.assertEqual(r["Location"], FRONTEND)

    def test_inactive_and_error_pages_are_reachable(self):
        for path in (
            "/accounts/inactive/",
            "/accounts/3rdparty/login/cancelled/",
            "/accounts/3rdparty/login/error/",
        ):
            with self.subTest(path=path):
                self.assertNotEqual(self.client.get(path).get("Location"), FRONTEND)

    def test_admin_password_form_for_another_user_is_refused(self):
        target = _user("target")
        before = target.password
        url = f"/admin/accounts/user/{target.pk}/password/"
        self.assertEqual(self.client.get(url)["Location"], FRONTEND)
        r = self.client.post(
            url, {"password1": NEW, "password2": NEW, "usable_password": "true"}
        )
        self.assertEqual(r.status_code, 403)
        target.refresh_from_db()
        self.assertEqual(target.password, before)

    def test_allauth_logout_ends_the_session(self):
        r = self.client.post("/accounts/logout/")
        self.assertNotEqual(r.status_code, 403)
        self.assertFalse(_is_logged_in(self.client))

    def test_admin_logout_ends_the_session(self):
        r = self.client.post("/admin/logout/")
        self.assertNotEqual(r.status_code, 403)
        self.assertFalse(_is_logged_in(self.client))

    def test_routes_outside_the_gate_are_untouched(self):
        self.assertEqual(self.client.get("/api/v1/auth/me/").status_code, 200)
        self.assertEqual(self.client.get("/api/health/liveness/").status_code, 200)
        for path in ("/static/x.css", "/administrators/", "/accountsx/"):
            with self.subTest(path=path):
                r = self.client.get(path)
                self.assertNotEqual(r.get("Location"), FRONTEND)
                self.assertNotEqual(r.status_code, 302)


class PendingUsernameUserIsGatedTests(PendingUserIsGatedTests):
    """The same matrix with only the username flag set."""

    flags = {"must_change_username": True}


@override_settings(FRONTEND_URL=FRONTEND, STORAGES=PLAIN_STATIC)
class NonPendingAndAnonymousPassTests(TestCase):
    def setUp(self):
        cache.clear()

    def test_non_pending_user_reaches_the_pages(self):
        client = _logged_in(_user("normal", staff=True))
        for path in ("/accounts/email/", "/admin/"):
            with self.subTest(path=path):
                self.assertEqual(client.get(path).status_code, 200)

    def test_password_change_and_set_pages_go_to_the_spa_settings(self):
        user = _with_credentials(_user("normal", staff=True))
        before = user.password
        client = _logged_in(user)
        for path in (
            "/accounts/password/change/",
            "/accounts/password/set/",
            "/accounts/password/change",
        ):
            with self.subTest(path=path):
                r = client.get(path, follow=False)
                if path.endswith("/"):
                    self.assertEqual(r.status_code, 302)
                    self.assertEqual(r["Location"], SPA_SETTINGS)
                else:
                    # APPEND_SLASH sends it to the slashed route above.
                    self.assertEqual(r.status_code, 301)
        # Every method redirects and nothing is read from the body.
        for path, body in (
            ("/accounts/password/change/", {"oldpassword": CURRENT, "password1": NEW, "password2": NEW}),
            ("/accounts/password/set/", {"password1": NEW, "password2": NEW}),
        ):
            with self.subTest(path=path, method="POST"):
                r = client.post(path, body)
                self.assertEqual(r.status_code, 302)
                self.assertEqual(r["Location"], SPA_SETTINGS)
        user.refresh_from_db()
        self.assertEqual(user.password, before)
        self.assertEqual(user.personal_access_tokens.count(), 2)

    def test_allauth_reverse_still_lands_on_the_redirect(self):
        from django.urls import reverse

        self.assertEqual(reverse("account_change_password"), "/accounts/password/change/")
        self.assertEqual(reverse("account_set_password"), "/accounts/password/set/")

    def test_anonymous_reaches_the_login_pages(self):
        client = Client()
        for path in ("/accounts/login/", "/admin/login/"):
            with self.subTest(path=path):
                self.assertEqual(client.get(path).status_code, 200)

    def test_anonymous_sso_callback_is_not_gated(self):
        r = Client().get("/accounts/google/login/callback/")
        self.assertNotEqual(r.get("Location"), FRONTEND)


@override_settings(
    FRONTEND_URL=FRONTEND,
    STORAGES=PLAIN_STATIC,
    PENDING_ACTION_EXTRA_GATED_PREFIXES=("/sso/",),
)
class ExtraGatedPrefixTests(TestCase):
    """``PENDING_ACTION_EXTRA_GATED_PREFIXES`` extends the gate with the same rules."""

    def setUp(self):
        self.client = _logged_in(_user("extra", must_change_password=True))

    def test_extra_prefix_is_gated(self):
        for path in ("/sso/", "/sso/start/", "/sso"):
            with self.subTest(path=path):
                r = self.client.get(path)
                self.assertEqual(r.status_code, 302)
                self.assertEqual(r["Location"], FRONTEND)
        self.assertEqual(self.client.post("/sso/start/").status_code, 403)

    def test_lookalike_is_not_gated(self):
        for path in ("/ssox/", "/ssoadmin/"):
            with self.subTest(path=path):
                self.assertNotEqual(self.client.get(path).get("Location"), FRONTEND)

    def test_builtin_prefixes_and_logout_exemption_are_unchanged(self):
        self.assertEqual(self.client.get("/admin/")["Location"], FRONTEND)
        self.client.post("/accounts/logout/")
        self.assertFalse(_is_logged_in(self.client))

    @override_settings(
        PENDING_ACTION_EXTRA_GATED_PREFIXES=("/", "sso/", "/sso", "//x/")
    )
    def test_malformed_entries_are_ignored_and_reported(self):
        self.assertFalse(is_pending_action_gated_path("/api/v1/auth/me/"))
        self.assertFalse(is_pending_action_gated_path("/sso/"))
        errors = check_pending_action_extra_gated_prefixes(None)
        self.assertEqual([e.id for e in errors], ["accounts.E004"] * 4)

    def test_well_formed_entries_pass_the_check(self):
        self.assertEqual(check_pending_action_extra_gated_prefixes(None), [])

    @override_settings(PENDING_ACTION_EXTRA_GATED_PREFIXES="/sso/")
    def test_a_single_string_is_one_prefix(self):
        self.assertTrue(is_pending_action_gated_path("/sso/x/"))
        self.assertFalse(is_pending_action_gated_path("/s/"))
        self.assertEqual(check_pending_action_extra_gated_prefixes(None), [])


class FrontendUrlSystemCheckTests(TestCase):
    def test_frontend_url_under_a_gated_prefix_fails(self):
        for url in (
            "https://x.test/accounts/",
            "https://x.test/admin",
            "https://x.test/admin/spa/",
        ):
            with self.subTest(url=url), override_settings(FRONTEND_URL=url):
                errors = check_frontend_url_outside_pending_action_gate(None)
                self.assertEqual([e.id for e in errors], ["accounts.E003"])

    def test_frontend_url_elsewhere_passes(self):
        for url in (
            "https://x.test",
            "https://x.test/",
            "https://x.test/app/",
            "http://localhost:5173",
        ):
            with self.subTest(url=url), override_settings(FRONTEND_URL=url):
                self.assertEqual(
                    check_frontend_url_outside_pending_action_gate(None), []
                )


# ---------------------------------------------------------------------------
# Layer 2: finalization on the web, API and Django admin password routes
# ---------------------------------------------------------------------------


def _redeem_reset_on_allauth_html_page(user, password=NEW, key=None):
    client = Client()
    uid = user_pk_to_url_str(user)
    key = key or default_token_generator.make_token(user)
    r = client.get(f"/accounts/password/reset/key/{uid}-{key}/")
    assert r.status_code == 302, r.status_code
    return client.post(r["Location"], {"password1": password, "password2": password})


def _allauth_password_views_urlconf():
    """Project URLs with allauth's own change/set views mounted ahead of the redirects.

    The project redirects ``/accounts/password/change/`` and ``/set/`` to the
    SPA (#1561), but the allauth forms configured in ``ACCOUNT_FORMS`` must
    still finalize if allauth's views are reached some other way, so these
    tests mount them directly.
    """
    from allauth.account import views as allauth_views

    from visiban import urls as project_urls

    return [
        url_path("accounts/password/change/", allauth_views.password_change),
        url_path("accounts/password/set/", allauth_views.password_set),
        *project_urls.urlpatterns,
    ]


urlpatterns = _allauth_password_views_urlconf()


@override_settings(STORAGES=PLAIN_STATIC, ROOT_URLCONF=__name__)
class AllauthFinalizationTests(TestCase):
    def setUp(self):
        cache.clear()

    def test_password_change_revokes_pats_and_keeps_the_session(self):
        user = _with_credentials(_user("changer"))
        client = _logged_in(user)
        with mock.patch.object(
            credentials,
            "finalize_password_change",
            wraps=credentials.finalize_password_change,
        ) as spy:
            r = client.post(
                "/accounts/password/change/",
                {"oldpassword": CURRENT, "password1": NEW, "password2": NEW},
            )
        self.assertEqual(r.status_code, 302)
        # Adapter hook, the form, and the idempotent signal backstop.
        self.assertEqual(spy.call_count, 3)
        user.refresh_from_db()
        self.assertTrue(user.check_password(NEW))
        self.assertEqual(user.personal_access_tokens.count(), 0)
        # The DRF Token is revoked on reset and admin-set passwords only.
        self.assertTrue(Token.objects.filter(user=user).exists())
        self.assertTrue(_session_is_valid(client))

    def test_password_set_for_a_social_only_account_revokes_pats(self):
        user = _user("social")
        user.set_unusable_password()
        user.save()
        _with_credentials(user)
        client = _logged_in(user)
        with mock.patch.object(
            credentials,
            "finalize_password_change",
            wraps=credentials.finalize_password_change,
        ) as spy:
            r = client.post(
                "/accounts/password/set/", {"password1": NEW, "password2": NEW}
            )
        self.assertEqual(r.status_code, 302)
        # Adapter hook, the form, and the idempotent signal backstop.
        self.assertEqual(spy.call_count, 3)
        user.refresh_from_db()
        self.assertTrue(user.check_password(NEW))
        self.assertEqual(user.personal_access_tokens.count(), 0)

    def test_reset_by_key_clears_the_flag_and_revokes_pats_and_token(self):
        user = _with_credentials(_user("resetter", must_change_password=True))
        with mock.patch.object(
            credentials,
            "finalize_password_change",
            wraps=credentials.finalize_password_change,
        ) as spy:
            r = _redeem_reset_on_allauth_html_page(user)
        self.assertEqual(r.status_code, 302)
        # Adapter hook, the form, and the idempotent signal backstop.
        self.assertEqual(spy.call_count, 3)
        user.refresh_from_db()
        self.assertTrue(user.check_password(NEW))
        self.assertFalse(user.must_change_password)
        self.assertEqual(user.personal_access_tokens.count(), 0)
        self.assertFalse(Token.objects.filter(user=user).exists())

    def test_reset_by_key_leaves_the_username_flag(self):
        user = _user("uflag", must_change_username=True)
        _redeem_reset_on_allauth_html_page(user)
        user.refresh_from_db()
        self.assertTrue(user.must_change_username)

    def _assert_unchanged(self, user):
        user.refresh_from_db()
        self.assertTrue(user.check_password(CURRENT))
        self.assertEqual(user.personal_access_tokens.count(), 2)
        self.assertTrue(Token.objects.filter(user=user).exists())

    def test_change_rolls_back_when_finalization_fails(self):
        user = _with_credentials(_user("failing"))
        client = _logged_in(user)
        with mock.patch.object(
            credentials, "finalize_password_change", side_effect=RuntimeError("boom")
        ):
            with self.assertRaises(RuntimeError):
                client.post(
                    "/accounts/password/change/",
                    {"oldpassword": CURRENT, "password1": NEW, "password2": NEW},
                )
        self._assert_unchanged(user)

    def test_set_rolls_back_when_finalization_fails(self):
        user = _user("failset")
        user.set_unusable_password()
        user.save()
        _with_credentials(user)
        client = _logged_in(user)
        with mock.patch.object(
            credentials, "finalize_password_change", side_effect=RuntimeError("boom")
        ):
            with self.assertRaises(RuntimeError):
                client.post(
                    "/accounts/password/set/", {"password1": NEW, "password2": NEW}
                )
        user.refresh_from_db()
        self.assertFalse(user.has_usable_password())
        self.assertEqual(user.personal_access_tokens.count(), 2)

    def test_reset_by_key_rolls_back_and_the_link_stays_usable(self):
        user = _with_credentials(_user("failreset", must_change_password=True))
        key = default_token_generator.make_token(user)
        with mock.patch.object(
            credentials, "finalize_password_reset", side_effect=RuntimeError("boom")
        ):
            with self.assertRaises(RuntimeError):
                _redeem_reset_on_allauth_html_page(user, key=key)
        self._assert_unchanged(user)
        self.assertTrue(user.must_change_password)
        # The password did not change, so the same link still works.
        r = _redeem_reset_on_allauth_html_page(user, key=key)
        self.assertEqual(r.status_code, 302)
        user.refresh_from_db()
        self.assertTrue(user.check_password(NEW))
        self.assertEqual(user.personal_access_tokens.count(), 0)


class AllauthFormFinalizationTests(TestCase):
    """The project's allauth forms finalize on save, called directly.

    Over HTTP the middleware keeps a pending user away from these pages, so the
    flag-clearing half of the follow-up is checked on the forms themselves.
    """

    def test_change_form_clears_the_flag_and_revokes_pats(self):
        from accounts.forms import VisibanChangePasswordForm

        user = _with_credentials(_user("formchange", must_change_password=True))
        form = VisibanChangePasswordForm(
            data={"oldpassword": CURRENT, "password1": NEW, "password2": NEW}, user=user
        )
        self.assertTrue(form.is_valid(), form.errors)
        form.save()
        user.refresh_from_db()
        self.assertTrue(user.check_password(NEW))
        self.assertFalse(user.must_change_password)
        self.assertEqual(user.personal_access_tokens.count(), 0)

    def test_set_form_clears_the_flag_and_revokes_pats(self):
        from accounts.forms import VisibanSetPasswordForm

        user = _user("formset", must_change_password=True)
        user.set_unusable_password()
        user.save()
        _with_credentials(user)
        form = VisibanSetPasswordForm(
            data={"password1": NEW, "password2": NEW}, user=user
        )
        self.assertTrue(form.is_valid(), form.errors)
        form.save()
        user.refresh_from_db()
        self.assertTrue(user.check_password(NEW))
        self.assertFalse(user.must_change_password)
        self.assertEqual(user.personal_access_tokens.count(), 0)


class RestResetConfirmFinalizationTests(TestCase):
    def setUp(self):
        cache.clear()

    def test_reset_confirm_clears_flag_and_revokes_pats_and_token(self):
        user = _with_credentials(_user("restreset", must_change_password=True))
        with mock.patch("accounts.serializers.clear_login_lockout") as lockout:
            r = APIClient().post(
                "/api/v1/auth/password/reset/confirm/",
                {
                    "uid": user_pk_to_url_str(user),
                    "token": default_token_generator.make_token(user),
                    "new_password1": NEW,
                    "new_password2": NEW,
                },
            )
        self.assertEqual(r.status_code, 200)
        lockout.assert_called_once()
        user.refresh_from_db()
        self.assertTrue(user.check_password(NEW))
        self.assertFalse(user.must_change_password)
        self.assertEqual(user.personal_access_tokens.count(), 0)
        self.assertFalse(Token.objects.filter(user=user).exists())

    def test_invalid_token_changes_nothing(self):
        user = _with_credentials(_user("badtoken", must_change_password=True))
        r = APIClient().post(
            "/api/v1/auth/password/reset/confirm/",
            {
                "uid": user_pk_to_url_str(user),
                "token": "nope",
                "new_password1": NEW,
                "new_password2": NEW,
            },
        )
        self.assertEqual(r.status_code, 400)
        user.refresh_from_db()
        self.assertTrue(user.must_change_password)
        self.assertEqual(user.personal_access_tokens.count(), 2)
        self.assertTrue(Token.objects.filter(user=user).exists())


class SpaPathsFinalizeExactlyOnceTests(TestCase):
    """The SPA routes call the helper themselves and send no allauth password signal."""

    def setUp(self):
        cache.clear()
        self.receiver = mock.Mock()
        for signal in (
            allauth_signals.password_changed,
            allauth_signals.password_set,
            allauth_signals.password_reset,
        ):
            signal.connect(self.receiver, dispatch_uid=f"test-spy-{id(signal)}")
            self.addCleanup(signal.disconnect, dispatch_uid=f"test-spy-{id(signal)}")

    def _client(self, user):
        client = APIClient()
        client.force_authenticate(user)
        return client

    def test_change_password_view(self):
        user = _with_credentials(_user("spa1", must_change_password=True))
        with mock.patch(
            "accounts.views.finalize_password_change",
            wraps=credentials.finalize_password_change,
        ) as spy:
            r = self._client(user).post(
                "/api/v1/auth/change-password/",
                {"current_password": CURRENT, "new_password": NEW},
                format="json",
            )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(spy.call_count, 1)
        self.receiver.assert_not_called()

    def test_token_revoking_password_change_view(self):
        user = _with_credentials(_user("spa2", must_change_password=True))
        with mock.patch(
            "accounts.views.finalize_password_change",
            wraps=credentials.finalize_password_change,
        ) as spy:
            r = self._client(user).post(
                "/api/v1/auth/password/change/",
                {"old_password": CURRENT, "new_password1": NEW, "new_password2": NEW},
                format="json",
            )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(spy.call_count, 1)
        self.receiver.assert_not_called()

    def test_rest_reset_confirm(self):
        user = _with_credentials(_user("spa3"))
        with mock.patch.object(
            credentials,
            "finalize_password_change",
            wraps=credentials.finalize_password_change,
        ) as spy:
            r = APIClient().post(
                "/api/v1/auth/password/reset/confirm/",
                {
                    "uid": user_pk_to_url_str(user),
                    "token": default_token_generator.make_token(user),
                    "new_password1": NEW,
                    "new_password2": NEW,
                },
            )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(spy.call_count, 1)
        self.receiver.assert_not_called()


class TimingEqualizationFinalizesNothingTests(TestCase):
    def test_unknown_login_hashes_without_finalizing(self):
        from accounts.backends import EmailBackend

        bystander = _with_credentials(_user("bystander"))
        with mock.patch.object(credentials, "finalize_password_change") as spy:
            self.assertIsNone(
                EmailBackend().authenticate(
                    None, email="nobody@example.com", password="x"
                )
            )
        spy.assert_not_called()
        self.assertEqual(bystander.personal_access_tokens.count(), 2)


# ---------------------------------------------------------------------------
# Django admin
# ---------------------------------------------------------------------------


@override_settings(FRONTEND_URL=FRONTEND, STORAGES=PLAIN_STATIC)
class DjangoAdminPasswordTests(TestCase):
    def setUp(self):
        cache.clear()
        self.staff = _with_credentials(_user("staffer", staff=True))
        self.client = _logged_in(self.staff)

    def _url(self, user):
        return f"/admin/accounts/user/{user.pk}/password/"

    def test_setting_another_users_password_forces_a_change_and_revokes(self):
        target = _with_credentials(_user("target"))
        target_client = _logged_in(target)
        self.assertTrue(_session_is_valid(target_client))

        r = self.client.post(
            self._url(target),
            {"password1": NEW, "password2": NEW, "usable_password": "true"},
        )
        self.assertEqual(r.status_code, 302)

        target.refresh_from_db()
        self.assertTrue(target.check_password(NEW))
        self.assertTrue(target.must_change_password)
        self.assertEqual(target.personal_access_tokens.count(), 0)
        self.assertFalse(Token.objects.filter(user=target).exists())
        self.assertFalse(_session_is_valid(target_client))
        # The actor is unaffected.
        self.assertTrue(_session_is_valid(self.client))
        self.assertEqual(self.staff.personal_access_tokens.count(), 2)

    def test_disabling_another_users_password_also_revokes(self):
        target = _with_credentials(_user("target2"))
        r = self.client.post(
            self._url(target), {"usable_password": "false", "unset-password": "1"}
        )
        self.assertEqual(r.status_code, 302)
        target.refresh_from_db()
        self.assertFalse(target.has_usable_password())
        self.assertEqual(target.personal_access_tokens.count(), 0)
        self.assertFalse(Token.objects.filter(user=target).exists())
        # No forced change: that would ask the owner to create the password
        # the administrator just removed.
        self.assertFalse(target.must_change_password)

    def test_setting_own_password_is_a_self_service_change(self):
        r = self.client.post(
            self._url(self.staff),
            {"password1": NEW, "password2": NEW, "usable_password": "true"},
        )
        self.assertEqual(r.status_code, 302)
        self.staff.refresh_from_db()
        self.assertTrue(self.staff.check_password(NEW))
        self.assertEqual(self.staff.personal_access_tokens.count(), 0)
        # The DRF Token is revoked on reset and admin-set passwords only.
        self.assertTrue(Token.objects.filter(user=self.staff).exists())
        self.assertTrue(_session_is_valid(self.client))

    def test_get_and_invalid_post_have_no_side_effects(self):
        target = _with_credentials(_user("target3"))
        before = target.password
        self.assertEqual(self.client.get(self._url(target)).status_code, 200)
        r = self.client.post(
            self._url(target),
            {"password1": NEW, "password2": OTHER, "usable_password": "true"},
        )
        self.assertEqual(r.status_code, 200)
        target.refresh_from_db()
        self.assertEqual(target.password, before)
        self.assertFalse(target.must_change_password)
        self.assertEqual(target.personal_access_tokens.count(), 2)
        self.assertTrue(Token.objects.filter(user=target).exists())

    def test_admin_password_change_page_redirects_to_the_spa(self):
        before = self.staff.password
        for path in ("/admin/password_change/", "/admin/password_change/done/"):
            with self.subTest(path=path):
                r = self.client.get(path)
                self.assertEqual(r.status_code, 302)
                self.assertEqual(r["Location"], SPA_SETTINGS)
        r = self.client.post(
            "/admin/password_change/",
            {"old_password": CURRENT, "new_password1": NEW, "new_password2": NEW},
        )
        self.assertEqual(r.status_code, 302)
        self.assertEqual(r["Location"], SPA_SETTINGS)
        self.staff.refresh_from_db()
        self.assertEqual(self.staff.password, before)

    def test_user_added_in_admin_must_change_password(self):
        r = self.client.post(
            "/admin/accounts/user/add/",
            {
                "username": "fromadmin",
                "password1": NEW,
                "password2": NEW,
                "usable_password": "true",
            },
        )
        self.assertEqual(
            r.status_code, 302, getattr(r, "context", None) and r.context.get("errors")
        )
        self.assertTrue(User.objects.get(username="fromadmin").must_change_password)

    def test_user_added_in_admin_without_a_password_is_not_forced(self):
        r = self.client.post(
            "/admin/accounts/user/add/",
            {"username": "nopassword", "usable_password": "false"},
        )
        self.assertEqual(r.status_code, 302)
        added = User.objects.get(username="nopassword")
        self.assertFalse(added.has_usable_password())
        self.assertFalse(added.must_change_password)

    def test_editing_a_user_in_admin_does_not_set_the_flag(self):
        target = _user("edited")
        admin.site._registry[User].save_model(
            mock.Mock(user=self.staff), target, None, True
        )
        target.refresh_from_db()
        self.assertFalse(target.must_change_password)
