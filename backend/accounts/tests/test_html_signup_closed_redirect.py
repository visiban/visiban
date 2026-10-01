"""Regression tests for #1324: /accounts/signup/ must redirect, not render allauth's page.

In CLOSED and INVITE_ONLY modes ``RegistrationAdapter.is_open_for_signup``
returns False, which made allauth's signup view render its stock, unstyled
``account/signup_closed.html``. ``VisibanSignupView`` redirects to the SPA
with an ``auth_error`` code instead, for GET and POST alike. The adapter
itself must keep returning a plain boolean for its other callers.
"""
from django.conf import settings
from django.test import Client, TestCase

from accounts.adapter import RegistrationAdapter, invalidate_registration_mode_cache
from accounts.models import SiteSetting, User


def _set_mode(mode):
    s = SiteSetting.get()
    s.registration_mode = mode
    s.save()
    invalidate_registration_mode_cache()


class HtmlSignupClosedRedirectTests(TestCase):
    def setUp(self):
        invalidate_registration_mode_cache()
        self.addCleanup(invalidate_registration_mode_cache)
        self.client = Client()
        self.payload = {
            "username": "newperson",
            "email": "newperson@example.com",
            "password1": "S3cure-Pass-phrase!",
            "password2": "S3cure-Pass-phrase!",
        }

    def _assert_redirect(self, resp, code):
        self.assertEqual(resp.status_code, 302)
        self.assertEqual(resp.url, f"{settings.LOGIN_REDIRECT_URL}?auth_error={code}")

    def test_closed_get_redirects(self):
        _set_mode(SiteSetting.RegistrationMode.CLOSED)
        self._assert_redirect(self.client.get("/accounts/signup/"), "signup_closed")

    def test_closed_post_redirects_and_creates_no_user(self):
        _set_mode(SiteSetting.RegistrationMode.CLOSED)
        self._assert_redirect(self.client.post("/accounts/signup/", self.payload), "signup_closed")
        self.assertFalse(User.objects.filter(username="newperson").exists())

    def test_invite_only_get_redirects(self):
        _set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        self._assert_redirect(self.client.get("/accounts/signup/"), "invite_required")

    def test_invite_only_post_redirects_and_creates_no_user(self):
        _set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        self._assert_redirect(self.client.post("/accounts/signup/", self.payload), "invite_required")
        self.assertFalse(User.objects.filter(username="newperson").exists())

    def test_open_mode_unchanged(self):
        _set_mode(SiteSetting.RegistrationMode.OPEN)
        resp = self.client.get("/accounts/signup/")
        self.assertEqual(resp.status_code, 200)
        self.assertNotIn("auth_error", resp.get("Location", ""))
        self.assertNotIn("account/signup_closed.html", [t.name for t in resp.templates])

    def test_adapter_still_returns_plain_boolean(self):
        """Headless/social callers use the boolean and do not catch ImmediateHttpResponse."""
        from django.test import RequestFactory

        request = RequestFactory().get("/")
        for mode, expected in (
            (SiteSetting.RegistrationMode.CLOSED, False),
            (SiteSetting.RegistrationMode.INVITE_ONLY, False),
            (SiteSetting.RegistrationMode.OPEN, True),
        ):
            _set_mode(mode)
            self.assertIs(RegistrationAdapter().is_open_for_signup(request), expected)
