"""Tests for the socialaccount_signup safety-net redirect (#1321).

Covers both triggers of allauth's ``redirect_to_signup`` (see
``allauth.socialaccount.internal.flows.signup.process_auto_signup_email``):
an OAuth-provided email that collides with an existing account, and a
provider that returns no email at all. Both land on
``GET /accounts/3rdparty/signup/`` with a pending SocialLogin stashed in the
session — before this fix, allauth's own stock ``signup.html`` template
rendered there (confirmed by manual repro, see the MR description), letting
a user edit the pre-filled email and create a duplicate account.
"""
from django.test import Client, RequestFactory, TestCase

from accounts.models import User
from allauth.account.models import EmailAddress
from allauth.socialaccount.adapter import get_adapter
from allauth.socialaccount.internal.flows.signup import (
    get_pending_signup,
    process_auto_signup_email,
    process_signup,
    redirect_to_signup,
)
from allauth.socialaccount.models import SocialAccount, SocialLogin


def _make_sociallogin(email):
    """Build an unsaved SocialLogin for a GitHub account, as allauth would
    construct one mid-callback, before any user/account row is saved.

    ``email_addresses`` — not ``user.email`` — is what
    ``process_auto_signup_email`` actually reads to decide whether to
    auto-signup or fall through to ``redirect_to_signup``, so it must be
    populated the same way a real provider payload would populate it: empty
    when the provider returned no email at all, one entry otherwise.
    """
    rf = RequestFactory()
    req = rf.get("/accounts/github/login/callback/")
    provider = get_adapter().get_provider(req, "github")
    new_user = User(username="", email=email)
    account = SocialAccount(provider="github", uid="99999", extra_data={})
    email_addresses = [EmailAddress(email=email, verified=True, primary=True)] if email else []
    sociallogin = SocialLogin(user=new_user, account=account, email_addresses=email_addresses)
    sociallogin.provider = provider
    return sociallogin


def _client_with_pending_signup(sociallogin):
    """A test Client whose session already holds a pending SocialLogin,
    exactly as allauth.internal.flows.signup.redirect_to_signup stashes one
    before bouncing the browser to socialaccount_signup."""
    client = Client()
    session = client.session
    session["socialaccount_sociallogin"] = sociallogin.serialize()
    session.save()
    client.cookies["sessionid"] = session.session_key
    return client, session


class ProcessAutoSignupEmailTriggerTests(TestCase):
    """Proves both #1321 triggers at the decision-logic level, not just at
    the routing/view level.

    ``process_auto_signup_email`` is the allauth function that decides
    whether to auto-signup or return ``auto_signup=False`` (which
    ``process_signup`` then turns into a ``redirect_to_signup`` call — see
    that function's docstring / signup.py:115). Testing it directly proves
    the two trigger conditions genuinely produce a fall-through under this
    repo's live settings (``ACCOUNT_SIGNUP_FIELDS`` requiring ``email*``,
    default ``ACCOUNT_PREVENT_ENUMERATION``), rather than only proving the
    override view behaves correctly once *some* SocialLogin lands in the
    session — which the tests below this class already cover, but which
    would pass even if the two trigger conditions were confused with each
    other or with a third, unrelated case.
    """

    def test_colliding_email_does_not_auto_signup(self):
        User.objects.create_user(username="existing", email="collide@example.com", password="x")
        sociallogin = _make_sociallogin("collide@example.com")
        req = RequestFactory().get("/accounts/github/login/callback/")

        auto_signup, resp = process_auto_signup_email(req, sociallogin)

        self.assertFalse(auto_signup)
        self.assertIsNone(resp)  # None means "fall through to redirect_to_signup", not a direct response.

    def test_no_email_from_provider_does_not_auto_signup(self):
        sociallogin = _make_sociallogin("")
        self.assertEqual(sociallogin.email_addresses, [])  # provider genuinely returned no email
        req = RequestFactory().get("/accounts/github/login/callback/")

        auto_signup, resp = process_auto_signup_email(req, sociallogin)

        self.assertFalse(auto_signup)
        self.assertIsNone(resp)

    def test_unique_email_does_auto_signup(self):
        """Control: a non-colliding email must NOT trigger the fall-through,
        so the two tests above are shown to depend on the actual trigger
        condition rather than on process_auto_signup_email always returning
        False."""
        sociallogin = _make_sociallogin("brand-new@example.com")
        req = RequestFactory().get("/accounts/github/login/callback/")

        auto_signup, resp = process_auto_signup_email(req, sociallogin)

        self.assertTrue(auto_signup)
        self.assertIsNone(resp)


class SocialSignupRedirectViewTests(TestCase):
    """Direct tests of the override view at accounts/3rdparty/signup/."""

    def test_email_collision_redirects_to_frontend_with_oauth_failed(self):
        User.objects.create_user(username="existing", email="collide@example.com", password="x")
        sociallogin = _make_sociallogin("collide@example.com")
        client, session = _client_with_pending_signup(sociallogin)

        resp = client.get("/accounts/3rdparty/signup/")

        self.assertEqual(resp.status_code, 302)
        self.assertIn("auth_error=oauth_failed", resp["Location"])
        # Does NOT render allauth's stock form (no 200, no HTML body).
        self.assertNotIn(b"<form", resp.content)

    def test_no_email_from_provider_redirects_to_frontend_with_oauth_failed(self):
        sociallogin = _make_sociallogin("")
        client, session = _client_with_pending_signup(sociallogin)

        resp = client.get("/accounts/3rdparty/signup/")

        self.assertEqual(resp.status_code, 302)
        self.assertIn("auth_error=oauth_failed", resp["Location"])

    def test_clears_pending_sociallogin_from_session(self):
        sociallogin = _make_sociallogin("collide@example.com")
        client, session = _client_with_pending_signup(sociallogin)
        self.assertIn("socialaccount_sociallogin", client.session)

        client.get("/accounts/3rdparty/signup/")

        self.assertNotIn("socialaccount_sociallogin", client.session)

    def test_direct_navigation_with_no_pending_signup_is_still_safe(self):
        """A user hitting the URL directly (no pending SocialLogin in the
        session at all) must not 500 or fall through to allauth's own view."""
        client = Client()

        resp = client.get("/accounts/3rdparty/signup/")

        self.assertEqual(resp.status_code, 302)
        self.assertIn("auth_error=oauth_failed", resp["Location"])

    def test_post_is_rejected_not_forwarded_to_allauth_form(self):
        """Only GET is implemented, so a POST — whether freshly crafted or
        replayed from a pre-fix cached copy of allauth's stock HTML form —
        must 405 rather than reach SignupView.form_valid and create a user."""
        sociallogin = _make_sociallogin("collide@example.com")
        client, session = _client_with_pending_signup(sociallogin)

        resp = client.post("/accounts/3rdparty/signup/", {"email": "other@example.com"})

        self.assertEqual(resp.status_code, 405)
        self.assertFalse(User.objects.filter(email="other@example.com").exists())


class RedirectToSignupIntegrationTests(TestCase):
    """Exercises allauth's own redirect_to_signup() to confirm the override
    is reached the same way a real OAuth callback would reach it."""

    def test_redirect_to_signup_target_resolves_to_the_override(self):
        sociallogin = _make_sociallogin("collide@example.com")
        rf = RequestFactory()
        request = rf.get("/accounts/github/login/callback/")
        request.session = self.client.session

        response = redirect_to_signup(request, sociallogin)
        request.session.save()

        # redirect_to_signup stashes the pending signup and points the browser
        # at the named `socialaccount_signup` URL — which the fix now
        # overrides at the routing layer, not by changing this allauth call.
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.url, "/accounts/3rdparty/signup/")
        self.assertIsNotNone(get_pending_signup(request))

        client = Client()
        session = client.session
        for key, value in request.session.items():
            session[key] = value
        session.save()
        client.cookies["sessionid"] = session.session_key

        followed = client.get(response.url)
        self.assertEqual(followed.status_code, 302)
        self.assertIn("auth_error=oauth_failed", followed["Location"])
