"""A provider sign-in records what a first password needs (#1260).

Setting a first password on an account with no usable password needs a recent
provider sign-in to that account, recorded in the session
(``accounts.credentials.session_recently_signed_in_by_provider``). The route
cases live in ``test_password_change_auth_token.py``
(``_FirstPasswordSessionOnlyCases``); this file checks that the real sign-in
path writes the record the rule reads, so the rule and the login flow cannot
drift apart, and covers the helper's edge cases directly.

Driven at the ``complete_login`` level, as in ``test_social_connect_reauth.py``:
a real IdP round trip can't run in a test.
"""

import time

from allauth.account.internal.flows.login import AUTHENTICATION_METHODS_SESSION_KEY
from allauth.account.models import EmailAddress
from allauth.core import context as allauth_context
from allauth.socialaccount.adapter import get_adapter
from allauth.socialaccount.internal.flows.login import complete_login
from allauth.socialaccount.models import SocialAccount, SocialLogin
from django.conf import settings
from django.contrib.auth.models import AnonymousUser
from django.contrib.messages.storage.fallback import FallbackStorage
from django.contrib.sessions.middleware import SessionMiddleware
from django.core.cache import cache
from django.test import RequestFactory, TestCase, override_settings
from rest_framework import status
from rest_framework.test import APIClient

from accounts import credentials
from accounts.models import User

FRONTEND = "https://app.example.com"
PROVIDERS = {"github": {"APP": {"client_id": "gh-id", "secret": "gh-secret"}}}
NEW = "Brand-New-Passw0rd!"  # gitleaks:allow -- test-only fixture password, not a credential


def _anonymous_request():
    request = RequestFactory().get("/accounts/github/login/callback/")
    SessionMiddleware(lambda r: None).process_request(request)
    request.session.save()
    request.user = AnonymousUser()
    request._messages = FallbackStorage(request)
    return request


def _sociallogin(request, user, uid):
    """An existing identity's SocialLogin as allauth builds one mid-callback."""
    prov = get_adapter().get_provider(request, "github")
    account = SocialAccount(provider="github", uid=uid, extra_data={})
    addresses = [EmailAddress(email=user.email, verified=True, primary=True)]
    sociallogin = SocialLogin(user=User(username="", email=user.email), account=account, email_addresses=addresses)
    sociallogin.provider = prov
    sociallogin.state = {"process": "login"}
    return sociallogin


@override_settings(LOGIN_REDIRECT_URL=FRONTEND, SOCIALACCOUNT_PROVIDERS=PROVIDERS)
class ProviderSignInWritesRecordTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(username="ssoonly", email="ssoonly@example.com")
        self.user.set_unusable_password()
        self.user.save()
        EmailAddress.objects.create(user=self.user, email=self.user.email, verified=True, primary=True)
        SocialAccount.objects.create(user=self.user, provider="github", uid="gh-sso", extra_data={})

    def test_provider_sign_in_records_a_recent_sign_in_to_this_account(self):
        request = _anonymous_request()

        with allauth_context.request_context(request):
            complete_login(request, _sociallogin(request, self.user, "gh-sso"))

        self.assertEqual(request.user.pk, self.user.pk)
        records = request.session[AUTHENTICATION_METHODS_SESSION_KEY]
        self.assertEqual(records[-1]["method"], "socialaccount")
        self.assertEqual((records[-1]["provider"], records[-1]["uid"]), ("github", "gh-sso"))
        self.assertTrue(credentials.session_recently_signed_in_by_provider(request, self.user))

    def test_that_session_can_set_a_first_password(self):
        request = _anonymous_request()
        with allauth_context.request_context(request):
            complete_login(request, _sociallogin(request, self.user, "gh-sso"))
        request.session.save()
        client = APIClient()
        client.cookies[settings.SESSION_COOKIE_NAME] = request.session.session_key

        r = client.post("/api/v1/auth/change-password/", {"new_password": NEW}, format="json")

        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(NEW))


class SessionRecentlySignedInHelperTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="helper", email="helper@example.com")
        self.user.set_unusable_password()
        self.user.save()

    def test_request_without_a_session_is_not_recent(self):
        request = RequestFactory().post("/api/v1/auth/change-password/")
        self.assertFalse(credentials.session_recently_signed_in_by_provider(request, self.user))

    def test_unlinked_identity_is_not_recent_even_with_no_linked_accounts(self):
        request = _anonymous_request()
        request.session[AUTHENTICATION_METHODS_SESSION_KEY] = [
            {"method": "socialaccount", "at": time.time(), "provider": "github", "uid": "x"}
        ]
        self.assertFalse(credentials.session_recently_signed_in_by_provider(request, self.user))

    def test_malformed_records_are_ignored(self):
        request = _anonymous_request()
        request.session[AUTHENTICATION_METHODS_SESSION_KEY] = ["junk", {"method": "socialaccount"}]
        self.assertFalse(credentials.session_recently_signed_in_by_provider(request, self.user))

    def test_account_with_usable_password_is_never_asked(self):
        self.user.set_password(NEW)
        self.user.save()
        request = RequestFactory().post("/api/v1/auth/change-password/")
        self.assertFalse(credentials.first_password_requires_recent_login(request, self.user))


class RecentLoginRefusalSchemaTests(TestCase):
    """The 403 with ``code`` is in the OpenAPI contract on both routes (#1260)."""

    def test_both_routes_declare_the_403_with_an_optional_code(self):
        from drf_spectacular.generators import SchemaGenerator

        schema = SchemaGenerator().get_schema(request=None, public=True)
        for path in ("/api/v1/auth/change-password/", "/api/v1/auth/password/change/"):
            with self.subTest(path=path):
                body = schema["paths"][path]["post"]["responses"]["403"]["content"][
                    "application/json"
                ]["schema"]
                # #2181: a declared 403 is widened to anyOf [declared, {detail}] so DRF's own
                # code-less 403s validate. The declared (coded) schema is always the first branch.
                declared = body["anyOf"][0] if "anyOf" in body else body
                component = schema["components"]["schemas"][declared["$ref"].rsplit("/", 1)[-1]]
                self.assertEqual(set(component["properties"]), {"detail", "code"})
                self.assertEqual(component["required"], ["detail"])
