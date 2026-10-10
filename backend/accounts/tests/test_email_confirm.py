"""Tests for the email-confirm SPA redirect feature.

Covers:
- EmailConfirmRedirectView: redirect behaviour for valid keys and the
  _KEY_RE guard invoked directly (the URL regex uses the same character set,
  so truly garbage keys return 404 from the router before reaching the view)
- RegistrationAdapter.get_email_confirmation_url: correct frontend URL construction
- VerifyEmailThrottle: scope name and settings entry
"""
from unittest.mock import MagicMock

from django.test import Client, TestCase, RequestFactory, override_settings

from accounts.adapter import RegistrationAdapter
from accounts.views import EmailConfirmRedirectThrottle, EmailConfirmRedirectView, ResendEmailThrottle, VerifyEmailThrottle


# ---------------------------------------------------------------------------
# EmailConfirmRedirectView — HTTP-level redirect tests
# ---------------------------------------------------------------------------

@override_settings(LOGIN_REDIRECT_URL="http://localhost:5173")
class EmailConfirmRedirectViewTests(TestCase):
    """GET /api/v1/auth/registration/account-confirm-email/<key>/ redirect behaviour."""

    def setUp(self):
        self.client = Client()

    def test_valid_key_returns_302(self):
        """A well-formed allauth HMAC key produces a 302 response."""
        key = "Mg:1uABcd-SomeValidBase64Key"
        r = self.client.get(
            f"/api/v1/auth/registration/account-confirm-email/{key}/",
            follow=False,
        )
        self.assertEqual(r.status_code, 302)

    def test_valid_key_redirects_to_frontend_confirm_email_path(self):
        """The Location header points to the SPA /confirm-email/<key> route."""
        key = "Mg:1uABcd-SomeValidBase64Key"
        r = self.client.get(
            f"/api/v1/auth/registration/account-confirm-email/{key}/",
            follow=False,
        )
        self.assertEqual(r["Location"], f"http://localhost:5173/confirm-email/{key}")

    def test_key_containing_colon_and_hyphen_is_accepted(self):
        """Keys with colons and hyphens (allauth HMAC format) pass routing."""
        key = "3:1xYz-ABCDEFGHIJabcdefghij0123456789"
        r = self.client.get(
            f"/api/v1/auth/registration/account-confirm-email/{key}/",
            follow=False,
        )
        self.assertEqual(r.status_code, 302)
        self.assertIn(f"/confirm-email/{key}", r["Location"])

    def test_redirect_strips_trailing_slash_from_login_redirect_url(self):
        """LOGIN_REDIRECT_URL values with a trailing slash are normalised."""
        with self.settings(LOGIN_REDIRECT_URL="http://localhost:5173/"):
            key = "Mg:1uABcd-validkey"
            r = self.client.get(
                f"/api/v1/auth/registration/account-confirm-email/{key}/",
                follow=False,
            )
            self.assertEqual(r.status_code, 302)
            # Must not produce a double slash before /confirm-email/
            self.assertNotIn("//confirm-email", r["Location"])
            self.assertTrue(r["Location"].endswith(f"/confirm-email/{key}"))

    def test_falls_back_to_localhost_when_setting_is_none(self):
        """View uses http://localhost:5173 as default when LOGIN_REDIRECT_URL is None."""
        with self.settings(LOGIN_REDIRECT_URL=None):
            key = "Mg:1uABcd-fallback"
            r = self.client.get(
                f"/api/v1/auth/registration/account-confirm-email/{key}/",
                follow=False,
            )
            self.assertEqual(r.status_code, 302)
            self.assertIn("localhost:5173", r["Location"])

    def test_key_with_forbidden_characters_returns_404_from_router(self):
        """Characters outside [\w:\-] are rejected by the URL regex before reaching the view.

        The URL pattern constrains the key to [\w:\-]{1,200} so keys containing
        dots, slashes, @, etc. return 404 — the view's _KEY_RE guard is a
        defence-in-depth layer for the same character set.
        """
        # Django's test client URL-encodes path segments, so we build the path manually
        # and pass it raw. A dot in the key will not match the URL regex.
        r = self.client.get(
            "/api/v1/auth/registration/account-confirm-email/bad.key/",
            follow=False,
        )
        self.assertEqual(r.status_code, 404)


# ---------------------------------------------------------------------------
# EmailConfirmRedirectView — _KEY_RE guard tested directly via RequestFactory
# ---------------------------------------------------------------------------

@override_settings(LOGIN_REDIRECT_URL="http://localhost:5173")
class EmailConfirmRedirectViewKeyRegexTests(TestCase):
    """Unit-test the _KEY_RE guard on the view directly using RequestFactory.

    The URL router already restricts to [\w:\-], so the guard is defence-in-depth.
    These tests cover it by calling the view directly with a crafted key value.
    """

    def setUp(self):
        self.factory = RequestFactory()
        self.view = EmailConfirmRedirectView.as_view()

    def _get(self, key):
        request = self.factory.get(f"/api/v1/auth/registration/account-confirm-email/{key}/")
        return self.view(request, key=key)

    def test_key_matching_regex_redirects_to_confirm_email_path(self):
        response = self._get("Mg:1uABcd-validkey")
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response["Location"], "http://localhost:5173/confirm-email/Mg:1uABcd-validkey")

    def test_key_failing_regex_redirects_to_invalid(self):
        """A key containing a dot (outside [\w:\-]) redirects to /confirm-email/invalid."""
        response = self._get("../evil")
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response["Location"], "http://localhost:5173/confirm-email/invalid")

    def test_key_with_at_sign_redirects_to_invalid(self):
        response = self._get("bad@key")
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response["Location"], "http://localhost:5173/confirm-email/invalid")

    def test_empty_string_key_redirects_to_invalid(self):
        """An empty string does not match the regex and goes to /invalid."""
        response = self._get("")
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response["Location"], "http://localhost:5173/confirm-email/invalid")


# ---------------------------------------------------------------------------
# RegistrationAdapter.get_email_confirmation_url
# ---------------------------------------------------------------------------

@override_settings(LOGIN_REDIRECT_URL="http://app.example.com")
class RegistrationAdapterEmailConfirmUrlTests(TestCase):
    """get_email_confirmation_url returns the frontend SPA URL."""

    def setUp(self):
        self.adapter = RegistrationAdapter()
        self.request = MagicMock()

    def _make_emailconfirmation(self, key):
        """Minimal mock satisfying the interface the adapter reads."""
        mock_ec = MagicMock()
        mock_ec.key = key
        return mock_ec

    def test_returns_frontend_url_with_key(self):
        ec = self._make_emailconfirmation("Mg:1uABcd-somekey")
        url = self.adapter.get_email_confirmation_url(self.request, ec)
        self.assertEqual(url, "http://app.example.com/confirm-email/Mg:1uABcd-somekey")

    def test_trailing_slash_in_setting_is_stripped(self):
        with self.settings(LOGIN_REDIRECT_URL="http://app.example.com/"):
            ec = self._make_emailconfirmation("Mg:1uABcd-trailingslash")
            url = self.adapter.get_email_confirmation_url(self.request, ec)
            # Must not produce a double slash before /confirm-email/
            self.assertNotIn("//confirm-email", url)
            self.assertTrue(url.endswith("/confirm-email/Mg:1uABcd-trailingslash"))

    def test_falls_back_to_localhost_when_setting_is_none(self):
        with self.settings(LOGIN_REDIRECT_URL=None):
            ec = self._make_emailconfirmation("Mg:1uABcd-noconfig")
            url = self.adapter.get_email_confirmation_url(self.request, ec)
            self.assertIn("localhost:5173", url)
            self.assertTrue(url.endswith("/confirm-email/Mg:1uABcd-noconfig"))

    def test_different_keys_produce_different_urls(self):
        url_a = self.adapter.get_email_confirmation_url(
            self.request, self._make_emailconfirmation("key-alpha")
        )
        url_b = self.adapter.get_email_confirmation_url(
            self.request, self._make_emailconfirmation("key-beta")
        )
        self.assertNotEqual(url_a, url_b)
        self.assertTrue(url_a.endswith("/confirm-email/key-alpha"))
        self.assertTrue(url_b.endswith("/confirm-email/key-beta"))

    def test_url_is_a_string(self):
        ec = self._make_emailconfirmation("anykey")
        url = self.adapter.get_email_confirmation_url(self.request, ec)
        self.assertIsInstance(url, str)


# ---------------------------------------------------------------------------
# VerifyEmailThrottle — scope wiring
# ---------------------------------------------------------------------------

class VerifyEmailThrottleScopeTests(TestCase):
    """VerifyEmailThrottle must declare the correct scope and that scope must
    exist in DEFAULT_THROTTLE_RATES so operators can tune it."""

    def test_throttle_scope_is_verify_email(self):
        self.assertEqual(VerifyEmailThrottle.scope, "verify_email")

    def test_verify_email_scope_exists_in_settings(self):
        from django.conf import settings
        rates = settings.REST_FRAMEWORK.get("DEFAULT_THROTTLE_RATES", {})
        self.assertIn(
            "verify_email",
            rates,
            "verify_email must have an entry in DEFAULT_THROTTLE_RATES so it "
            "can be tuned by operators without a code change.",
        )

    def test_verify_email_view_is_wired_with_throttle(self):
        """The verify-email/ endpoint must use VerifyEmailThrottle.

        This is enforced via the throttle_classes kwarg in urls.py rather than
        on a view subclass, so we resolve the URL and inspect initkwargs.
        """
        from django.urls import resolve
        match = resolve("/api/v1/auth/registration/verify-email/")
        throttle_classes = match.func.initkwargs.get("throttle_classes", [])
        self.assertIn(
            VerifyEmailThrottle,
            throttle_classes,
            "VerifyEmailThrottle must be listed in the throttle_classes kwarg "
            "on the VerifyEmailView registered in urls.py.",
        )


# ---------------------------------------------------------------------------
# ResendEmailThrottle — scope wiring and behavior (#1552)
# ---------------------------------------------------------------------------

class ResendEmailThrottleTests(TestCase):
    URL = "/api/v1/auth/registration/resend-email/"

    def test_scope_and_rate_configured(self):
        from django.conf import settings
        self.assertEqual(ResendEmailThrottle.scope, "resend_email")
        self.assertIn("resend_email", settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"])

    def test_route_is_wired_with_throttle(self):
        from django.urls import resolve
        for path in (self.URL, self.URL.rstrip("/")):
            match = resolve(path)
            self.assertIn(ResendEmailThrottle, match.func.initkwargs.get("throttle_classes", []))

    def _assert_429_after_rate(self, client):
        from unittest.mock import patch
        from django.core.cache import cache

        cache.clear()
        with patch.object(ResendEmailThrottle, "get_rate", return_value="2/hour"), \
                patch.object(ResendEmailThrottle, "rate", None, create=True), \
                patch.object(ResendEmailThrottle, "num_requests", None, create=True), \
                patch.object(ResendEmailThrottle, "duration", None, create=True):
            for _ in range(2):
                r = client.post(self.URL, {"email": "nobody@example.com"}, format="json")
                self.assertEqual(r.status_code, 200)
            r = client.post(self.URL, {"email": "nobody@example.com"}, format="json")
            self.assertEqual(r.status_code, 429)
        cache.clear()

    def test_returns_429_after_rate_exceeded(self):
        from rest_framework.test import APIClient

        self._assert_429_after_rate(APIClient())

    def test_authenticated_caller_is_also_limited(self):
        from rest_framework.test import APIClient
        from accounts.models import User

        user = User.objects.create_user(username="resend_auth", email="auth@example.com", password="pw-12345-xyz")
        client = APIClient()
        client.force_authenticate(user=user)
        self._assert_429_after_rate(client)

    def test_invalid_email_format_is_400(self):
        from django.core.cache import cache
        from rest_framework.test import APIClient

        cache.clear()
        r = APIClient().post(self.URL, {"email": "not-an-email"}, format="json")
        self.assertEqual(r.status_code, 400)
        cache.clear()

    def test_response_is_constant_for_unverified_verified_and_unknown(self):
        from allauth.account.models import EmailAddress
        from django.core.cache import cache
        from rest_framework.test import APIClient
        from accounts.models import User

        cache.clear()
        for name, verified in (("unverified", False), ("verified", True)):
            u = User.objects.create_user(username=f"resend_{name}", email=f"{name}@example.com", password="pw-12345-xyz")
            EmailAddress.objects.create(user=u, email=u.email, verified=verified, primary=True)
        client = APIClient()
        responses = [
            client.post(self.URL, {"email": f"{n}@example.com"}, format="json")
            for n in ("unverified", "verified", "unknown")
        ]
        self.assertEqual({r.status_code for r in responses}, {200})
        self.assertEqual(len({str(r.json()) for r in responses}), 1)
        cache.clear()


# ---------------------------------------------------------------------------
# EmailConfirmRedirectThrottle — scope wiring
# ---------------------------------------------------------------------------

class EmailConfirmRedirectThrottleScopeTests(TestCase):
    """EmailConfirmRedirectThrottle must declare the correct scope, the scope
    must exist in DEFAULT_THROTTLE_RATES, and the view class must list the
    throttle so DRF applies it on every request (#754)."""

    def test_throttle_scope_is_email_confirm_redirect(self):
        self.assertEqual(EmailConfirmRedirectThrottle.scope, "email_confirm_redirect")

    def test_email_confirm_redirect_scope_exists_in_settings(self):
        from django.conf import settings
        rates = settings.REST_FRAMEWORK.get("DEFAULT_THROTTLE_RATES", {})
        self.assertIn(
            "email_confirm_redirect",
            rates,
            "email_confirm_redirect must have an entry in DEFAULT_THROTTLE_RATES "
            "so operators can tune it without a code change.",
        )

    def test_view_declares_throttle_class(self):
        """The throttle must be on the view class so DRF's dispatch pipeline
        invokes it. A plain Django View has no throttle pipeline — the whole
        point of the #754 fix is that this view is now an APIView."""
        self.assertIn(
            EmailConfirmRedirectThrottle,
            EmailConfirmRedirectView.throttle_classes,
            "EmailConfirmRedirectView.throttle_classes must include "
            "EmailConfirmRedirectThrottle; without it the redirect endpoint "
            "is unthrottled (the original #754 vulnerability).",
        )


# ---------------------------------------------------------------------------
# AllauthConfirmEmailOverrideTests — accounts/confirm-email/ URL override (#755)
# ---------------------------------------------------------------------------

@override_settings(LOGIN_REDIRECT_URL="http://localhost:5173")
class AllauthConfirmEmailOverrideTests(TestCase):
    """The allauth template-based ConfirmEmailView at accounts/confirm-email/<key>/
    must be overridden by EmailConfirmRedirectView before the allauth include.

    Without the override, hitting that URL raises ImproperlyConfigured because
    Visiban ships no allauth templates (it is a headless SPA). The re_path
    registered before path("accounts/", include("allauth.urls")) ensures the
    redirect view intercepts the request and sends the browser to the SPA (#755).
    """

    def setUp(self):
        self.client = Client()

    def test_allauth_confirm_email_url_redirects_to_spa(self):
        """GET /accounts/confirm-email/<key>/ returns 302 to the SPA confirm-email route."""
        key = "Mg:1uABcd-somekey"
        r = self.client.get(f"/accounts/confirm-email/{key}/", follow=False)
        self.assertEqual(r.status_code, 302)
        self.assertEqual(r["Location"], f"http://localhost:5173/confirm-email/{key}")

    def test_allauth_confirm_email_url_does_not_render_template(self):
        """The response must be a redirect, not a 500/ImproperlyConfigured error.

        Without the URL override allauth's ConfirmEmailView attempts to render
        a template that does not exist and raises ImproperlyConfigured (status 500).
        A non-500 redirect confirms the override is in place.
        """
        key = "Mg:1uABcd-somekey"
        r = self.client.get(f"/accounts/confirm-email/{key}/", follow=False)
        self.assertIn(r.status_code, (301, 302), "Expected a redirect, not a server error")
