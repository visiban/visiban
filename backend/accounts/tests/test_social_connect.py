"""OAuth email collision -> "connect it for next time" (#1314).

Covers, at the ``pre_social_login`` hook level (a real IdP round trip can't
run in a test): the ``account_exists`` / ``account_exists_provider`` /
``provider_already_connected`` routing, every edge case the issue lists
(unverified IdP email, deactivated account, invite in flight, case-insensitive
match without +tag/dot normalization), the pending-connect prompt state, and
the list/disconnect endpoints.
"""
import time
from urllib.parse import parse_qs, urlparse

from allauth.account.models import EmailAddress
from allauth.core.exceptions import ImmediateHttpResponse
from allauth.socialaccount import signals
from allauth.socialaccount.adapter import get_adapter
from allauth.socialaccount.internal.flows.login import complete_login, pre_social_login
from allauth.socialaccount.models import SocialAccount, SocialLogin
from django.contrib.auth.models import AnonymousUser
from django.contrib.sessions.middleware import SessionMiddleware
from django.core.cache import cache
from django.test import RequestFactory, TestCase, override_settings
from rest_framework import status
from rest_framework.test import APIClient

from accounts.adapter import PENDING_INVITE_SESSION_KEY
from accounts.models import InviteLink, SiteSetting, User
from accounts.social_connect import (
    PENDING_CONNECT_SESSION_KEY,
    find_accounts_for_email,
    stash_pending_connect,
)

FRONTEND = "https://app.example.com"
PROVIDERS = {
    "google": {"APP": {"client_id": "g-id", "secret": "g-secret"}},
    "github": {"APP": {"client_id": "gh-id", "secret": "gh-secret"}},
    "gitlab": {"APP": {"client_id": "", "secret": ""}},
}
LIST_URL = "/api/v1/auth/me/connected-accounts/"
PENDING_URL = "/api/v1/auth/me/pending-connect/"


def _request(user=None):
    request = RequestFactory().get("/accounts/github/login/callback/")
    SessionMiddleware(lambda r: None).process_request(request)
    request.session.save()
    request.user = user or AnonymousUser()
    return request


def _sociallogin(request, email, *, verified=True, provider="github", uid="gh-1", process="login"):
    """An unsaved SocialLogin as allauth builds one mid-callback."""
    prov = get_adapter().get_provider(request, provider)
    account = SocialAccount(provider=provider, uid=uid, extra_data={})
    addresses = [EmailAddress(email=email, verified=verified, primary=True)] if email else []
    sociallogin = SocialLogin(user=User(username="", email=email), account=account, email_addresses=addresses)
    sociallogin.provider = prov
    sociallogin.state = {"process": process}
    return sociallogin


def _query(response):
    parsed = urlparse(response["Location"])
    return parsed.path, {k: v[0] for k, v in parse_qs(parsed.query).items()}


@override_settings(LOGIN_REDIRECT_URL=FRONTEND)
class EmailCollisionRoutingTests(TestCase):
    """pre_social_login: where a new OAuth identity with a taken email goes."""

    def _run(self, request, sociallogin):
        """Run allauth's own pre_social_login flow (lookup + adapter hook)."""
        with self.assertRaises(ImmediateHttpResponse) as ctx:
            pre_social_login(request, sociallogin)
        return _query(ctx.exception.response)

    def test_password_account_gets_account_exists_with_provider(self):
        User.objects.create_user(username="alice", email="alice@example.com", password="pw-123456789")
        request = _request()

        _, params = self._run(request, _sociallogin(request, "alice@example.com"))

        self.assertEqual(params, {"auth_error": "account_exists", "provider": "github"})

    def test_collision_stashes_pending_connect_for_the_matched_account(self):
        alice = User.objects.create_user(username="alice", email="alice@example.com", password="pw-123456789")
        request = _request()

        self._run(request, _sociallogin(request, "alice@example.com"))

        pending = request.session[PENDING_CONNECT_SESSION_KEY]
        self.assertEqual(pending["provider"], "github")
        self.assertEqual(pending["user_ids"], [alice.pk])
        self.assertGreater(pending["expires_at"], time.time() + 9 * 60)

    def test_match_is_case_insensitive(self):
        User.objects.create_user(username="alice", email="Alice@Example.COM", password="pw-123456789")
        request = _request()

        _, params = self._run(request, _sociallogin(request, "alice@example.com"))

        self.assertEqual(params["auth_error"], "account_exists")

    def test_plus_tags_and_dots_are_different_addresses(self):
        User.objects.create_user(username="alice", email="alice@gmail.com", password="pw-123456789")
        for other in ("alice+work@gmail.com", "a.lice@gmail.com"):
            request = _request()
            # No collision: the hook returns and allauth carries on to signup.
            self.assertIsNone(pre_social_login(request, _sociallogin(request, other)))
            self.assertNotIn(PENDING_CONNECT_SESSION_KEY, request.session)

    def test_admin_created_user_without_email_address_row_is_found(self):
        """allauth's assess_unique_email only reads EmailAddress rows; an
        admin-created account has none and must still be detected."""
        User.objects.create_user(username="made", email="made@example.com", password="pw-123456789")
        self.assertFalse(EmailAddress.objects.exists())
        request = _request()

        _, params = self._run(request, _sociallogin(request, "MADE@example.com"))

        self.assertEqual(params["auth_error"], "account_exists")

    def test_secondary_email_address_row_is_found(self):
        user = User.objects.create_user(username="bea", email="bea@primary.example", password="pw-123456789")
        EmailAddress.objects.create(user=user, email="bea@secondary.example", verified=True)
        self.assertEqual(list(find_accounts_for_email("BEA@secondary.example")), [user])

    def test_verified_idp_email_passwordless_account_names_via_provider(self):
        user = User.objects.create_user(username="carol", email="carol@example.com")
        user.set_unusable_password()
        user.save()
        SocialAccount.objects.create(user=user, provider="google", uid="g-9", extra_data={})
        request = _request()

        _, params = self._run(request, _sociallogin(request, "carol@example.com", verified=True))

        self.assertEqual(
            params, {"auth_error": "account_exists_provider", "provider": "github", "via": "google"}
        )

    def test_unverified_idp_email_never_names_the_via_provider(self):
        """Naming the provider an unverified address "signs in with" would leak
        it to anyone controlling a lax IdP — fall back to account_exists."""
        user = User.objects.create_user(username="carol", email="carol@example.com")
        user.set_unusable_password()
        user.save()
        SocialAccount.objects.create(user=user, provider="google", uid="g-9", extra_data={})
        request = _request()

        _, params = self._run(request, _sociallogin(request, "carol@example.com", verified=False))

        self.assertEqual(params, {"auth_error": "account_exists", "provider": "github"})

    def test_passwordless_account_with_no_other_provider_gets_account_exists(self):
        user = User.objects.create_user(username="dan", email="dan@example.com")
        user.set_unusable_password()
        user.save()
        request = _request()

        _, params = self._run(request, _sociallogin(request, "dan@example.com"))

        self.assertEqual(params["auth_error"], "account_exists")

    def test_multi_address_idp_uses_the_primary_address(self):
        """GitHub lists every address in API order; the primary one decides."""
        user = User.objects.create_user(username="carol", email="carol@example.com")
        user.set_unusable_password()
        user.save()
        SocialAccount.objects.create(user=user, provider="google", uid="g-9", extra_data={})
        request = _request()
        sociallogin = _sociallogin(request, "carol@example.com", verified=True)
        sociallogin.email_addresses = [
            EmailAddress(email="someone-else@example.com", verified=False, primary=False),
            EmailAddress(email="carol@example.com", verified=True, primary=True),
        ]

        _, params = self._run(request, sociallogin)

        self.assertEqual(params["auth_error"], "account_exists_provider")
        self.assertEqual(params["via"], "google")

    def test_unverified_secondary_listed_first_does_not_collide(self):
        User.objects.create_user(username="dora", email="dora@example.com", password="pw-123456789")
        request = _request()
        sociallogin = _sociallogin(request, "new-primary@example.com")
        sociallogin.email_addresses = [
            EmailAddress(email="dora@example.com", verified=False, primary=False),
            EmailAddress(email="new-primary@example.com", verified=True, primary=True),
        ]
        self.assertIsNone(pre_social_login(request, sociallogin))

    def test_deactivated_account_is_not_revealed(self):
        User.objects.create_user(
            username="gone", email="gone@example.com", password="pw-123456789", is_active=False
        )
        request = _request()

        _, params = self._run(request, _sociallogin(request, "gone@example.com"))

        self.assertEqual(params, {"auth_error": "oauth_failed"})
        self.assertNotIn(PENDING_CONNECT_SESSION_KEY, request.session)

    def test_no_collision_is_a_no_op(self):
        request = _request()
        self.assertIsNone(pre_social_login(request, _sociallogin(request, "new@example.com")))

    def test_no_email_from_idp_is_a_no_op(self):
        """Left to #1321's oauth_failed fallback."""
        request = _request()
        self.assertIsNone(pre_social_login(request, _sociallogin(request, "")))

    def test_existing_connected_identity_just_logs_in(self):
        alice = User.objects.create_user(username="alice", email="alice@example.com", password="pw-123456789")
        SocialAccount.objects.create(user=alice, provider="github", uid="gh-1", extra_data={})
        request = _request()

        self.assertIsNone(pre_social_login(request, _sociallogin(request, "alice@example.com")))


@override_settings(LOGIN_REDIRECT_URL=FRONTEND)
class SharedBrowserTests(TestCase):
    """The stash must never carry over to a different person on the same browser."""

    def setUp(self):
        cache.clear()
        self.victim = User.objects.create_user(username="victim", email="victim@example.com", password="pw-123456789")
        self.other = User.objects.create_user(username="other", email="other@example.com", password="pw-123456789")

    def _client_with_collision_stash(self):
        """Run a real collision through the adapter, then copy the resulting
        session into a test client — the browser the attempt was made in."""
        request = _request()
        sociallogin = _sociallogin(request, "victim@example.com", verified=False)
        sociallogin.account.extra_data = {"login": "attacker-gh"}
        with self.assertRaises(ImmediateHttpResponse):
            pre_social_login(request, sociallogin)
        client = APIClient()
        session = client.session
        for key, value in request.session.items():
            session[key] = value
        session.save()
        return client

    def test_collision_stash_names_the_attempting_provider_account(self):
        client = self._client_with_collision_stash()
        pending = client.session[PENDING_CONNECT_SESSION_KEY]
        self.assertEqual(pending["identity"], "attacker-gh")

    def test_stash_is_dropped_when_a_different_user_logs_in(self):
        """The attempt never completes; someone else signs in next in the same
        browser. The stash is gone and no prompt appears."""
        client = self._client_with_collision_stash()
        self.assertIn(PENDING_CONNECT_SESSION_KEY, client.session)

        r = client.post("/api/v1/auth/login/", {"username": "other", "password": "pw-123456789"})
        self.assertEqual(r.status_code, status.HTTP_200_OK)

        self.assertNotIn(PENDING_CONNECT_SESSION_KEY, client.session)
        body = client.get("/api/v1/auth/user/").json()
        self.assertIsNone(body["pending_connect_provider"])
        self.assertIsNone(body["pending_connect_identity"])

    def test_stash_survives_only_for_the_matched_account_and_names_the_identity(self):
        client = self._client_with_collision_stash()

        client.post("/api/v1/auth/login/", {"username": "victim", "password": "pw-123456789"})

        body = client.get("/api/v1/auth/user/").json()
        self.assertEqual(body["pending_connect_provider"], "github")
        # Shown in the prompt so an unfamiliar account can be declined.
        self.assertEqual(body["pending_connect_identity"], "attacker-gh")

    def test_logout_clears_the_stash(self):
        client = self._client_with_collision_stash()
        client.post("/api/v1/auth/login/", {"username": "victim", "password": "pw-123456789"})

        client.post("/api/v1/auth/logout/")
        client.post("/api/v1/auth/login/", {"username": "victim", "password": "pw-123456789"})

        self.assertIsNone(client.get("/api/v1/auth/user/").json()["pending_connect_provider"])

    def test_identity_falls_back_to_email_without_a_provider_username(self):
        request = _request()
        with self.assertRaises(ImmediateHttpResponse):
            pre_social_login(request, _sociallogin(request, "victim@example.com"))
        self.assertEqual(request.session[PENDING_CONNECT_SESSION_KEY]["identity"], "victim@example.com")


@override_settings(LOGIN_REDIRECT_URL=FRONTEND)
class InviteInFlightTests(TestCase):
    """account_exists beats invite_* and signup-closed, and keeps the invite."""

    def setUp(self):
        self.creator = User.objects.create_user(username="creator", password="pw-123456789")
        User.objects.create_user(username="alice", email="alice@example.com", password="pw-123456789")

    def _set_mode(self, mode):
        setting = SiteSetting.get()
        setting.registration_mode = mode
        setting.save()

    def test_account_exists_beats_expired_invite(self):
        from datetime import timedelta

        from django.utils import timezone

        self._set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        _, raw = InviteLink.generate(created_by=self.creator, expires_at=timezone.now() - timedelta(days=1))
        request = _request()
        request.session[PENDING_INVITE_SESSION_KEY] = raw

        response = complete_login(request, _sociallogin(request, "alice@example.com"))

        _, params = _query(response)
        self.assertEqual(params["auth_error"], "account_exists")
        # The invite is carried through, not consumed or discarded.
        self.assertEqual(request.session[PENDING_INVITE_SESSION_KEY], raw)

    def test_control_expired_invite_without_collision_still_reports_invite_expired(self):
        from datetime import timedelta

        from django.utils import timezone

        self._set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        _, raw = InviteLink.generate(created_by=self.creator, expires_at=timezone.now() - timedelta(days=1))
        request = _request()
        request.session[PENDING_INVITE_SESSION_KEY] = raw

        response = complete_login(request, _sociallogin(request, "brand-new@example.com"))

        _, params = _query(response)
        self.assertEqual(params["auth_error"], "invite_expired")

    def test_account_exists_beats_signup_closed(self):
        self._set_mode(SiteSetting.RegistrationMode.CLOSED)
        request = _request()

        response = complete_login(request, _sociallogin(request, "alice@example.com"))

        self.assertEqual(response.status_code, 302)
        _, params = _query(response)
        self.assertEqual(params["auth_error"], "account_exists")


@override_settings(LOGIN_REDIRECT_URL=FRONTEND)
class ConnectProcessTests(TestCase):
    """process=connect: refusing someone else's identity, and the redirect."""

    def setUp(self):
        self.alice = User.objects.create_user(username="alice", email="alice@example.com", password="pw-123456789")
        self.bob = User.objects.create_user(username="bob", email="bob@example.com", password="pw-123456789")

    def test_identity_connected_elsewhere_is_refused(self):
        SocialAccount.objects.create(user=self.bob, provider="github", uid="gh-1", extra_data={})
        request = _request(self.alice)

        with self.assertRaises(ImmediateHttpResponse) as ctx:
            pre_social_login(request, _sociallogin(request, "bob@example.com", process="connect"))

        path, params = _query(ctx.exception.response)
        self.assertEqual(path, "/settings")
        self.assertEqual(params, {"connect_error": "provider_already_connected", "provider": "github"})
        self.assertFalse(SocialAccount.objects.filter(user=self.alice).exists())

    def test_new_identity_connects_and_redirects_to_settings(self):
        request = _request(self.alice)
        from django.contrib.messages.storage.fallback import FallbackStorage

        request._messages = FallbackStorage(request)

        response = complete_login(request, _sociallogin(request, "whatever@example.com", process="connect"))

        path, params = _query(response)
        self.assertEqual(path, "/settings")
        self.assertEqual(params, {"connected": "github"})
        self.assertTrue(SocialAccount.objects.filter(user=self.alice, provider="github").exists())

    def test_connect_attempt_clears_pending_prompt_for_that_provider(self):
        request = _request(self.alice)
        stash_pending_connect(request, "github", [self.alice.pk])
        SocialAccount.objects.create(user=self.bob, provider="github", uid="gh-1", extra_data={})

        with self.assertRaises(ImmediateHttpResponse):
            pre_social_login(request, _sociallogin(request, "x@example.com", process="connect"))

        self.assertNotIn(PENDING_CONNECT_SESSION_KEY, request.session)

    def test_anonymous_connect_is_refused(self):
        request = _request()

        with self.assertRaises(ImmediateHttpResponse) as ctx:
            pre_social_login(request, _sociallogin(request, "x@example.com", process="connect"))

        _, params = _query(ctx.exception.response)
        self.assertEqual(params, {"auth_error": "oauth_failed"})

    def test_connect_does_not_run_collision_routing(self):
        """Connecting a provider whose email matches the user's own account
        must connect, not bounce to account_exists."""
        request = _request(self.alice)
        self.assertIsNone(
            pre_social_login(request, _sociallogin(request, "alice@example.com", process="connect"))
        )


class PendingConnectProviderFieldTests(TestCase):
    """CurrentUserSerializer.pending_connect_provider + its dismiss endpoint."""

    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(username="alice", email="alice@example.com", password="pw-123456789")
        self.client = APIClient()
        self.client.force_login(self.user)

    def _stash(self, **overrides):
        session = self.client.session
        data = {"provider": "github", "user_ids": [self.user.pk], "expires_at": time.time() + 600}
        data.update(overrides)
        session[PENDING_CONNECT_SESSION_KEY] = data
        session.save()

    def _field(self):
        return self.client.get("/api/v1/auth/user/").json()["pending_connect_provider"]

    def test_null_when_nothing_pending(self):
        self.assertIsNone(self._field())

    def test_reports_the_pending_provider(self):
        self._stash()
        self.assertEqual(self._field(), "github")
        # Reading it does not consume it (a background refetch must not dismiss).
        self.assertEqual(self._field(), "github")

    def test_also_on_auth_me(self):
        self._stash()
        self.assertEqual(self.client.get("/api/v1/auth/me/").json()["pending_connect_provider"], "github")

    def test_expired_stash_is_ignored(self):
        self._stash(expires_at=time.time() - 1)
        self.assertIsNone(self._field())

    def test_stash_for_another_account_is_ignored(self):
        """A different person signing in on a shared browser is never asked
        to connect a stranger's identity."""
        other = User.objects.create_user(username="bob", password="pw-123456789")
        self._stash(user_ids=[other.pk])
        self.assertIsNone(self._field())

    def test_already_connected_provider_is_not_offered(self):
        SocialAccount.objects.create(user=self.user, provider="github", uid="gh-1", extra_data={})
        self._stash()
        self.assertIsNone(self._field())

    def test_dismiss_clears_it(self):
        self._stash()
        response = self.client.delete(PENDING_URL)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertIsNone(response.json()["pending_connect_provider"])
        self.assertIsNone(self._field())

    def test_dismiss_is_idempotent(self):
        self.assertEqual(self.client.delete(PENDING_URL).status_code, status.HTTP_200_OK)

    def test_dismiss_requires_authentication(self):
        self.assertIn(
            APIClient().delete(PENDING_URL).status_code,
            (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN),
        )

    def test_survives_password_login(self):
        """The stash is written to an anonymous session during the OAuth
        callback; a normal password login afterwards must keep it."""
        client = APIClient()
        session = client.session
        session[PENDING_CONNECT_SESSION_KEY] = {
            "provider": "github", "user_ids": [self.user.pk], "expires_at": time.time() + 600,
        }
        session.save()

        r = client.post("/api/v1/auth/login/", {"username": "alice", "password": "pw-123456789"})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(client.get("/api/v1/auth/user/").json()["pending_connect_provider"], "github")


@override_settings(SOCIALACCOUNT_PROVIDERS=PROVIDERS)
class ConnectedAccountsEndpointTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(username="alice", email="alice@example.com", password="pw-123456789")
        self.client = APIClient()
        self.client.force_login(self.user)

    def test_lists_configured_providers_only(self):
        rows = self.client.get(LIST_URL).json()
        self.assertEqual([r["provider"] for r in rows], ["google", "github"])
        self.assertTrue(all(r["connected"] is False for r in rows))

    def test_connected_row_carries_email_and_date(self):
        SocialAccount.objects.create(
            user=self.user, provider="github", uid="gh-1", extra_data={"email": "a@gh.example"}
        )
        rows = {r["provider"]: r for r in self.client.get(LIST_URL).json()}
        self.assertTrue(rows["github"]["connected"])
        self.assertEqual(rows["github"]["email"], "a@gh.example")
        self.assertIn("connected_at", rows["github"])
        self.assertNotIn("uid", rows["github"])
        self.assertNotIn("extra_data", rows["github"])

    def test_connected_but_unconfigured_provider_is_still_listed(self):
        SocialAccount.objects.create(user=self.user, provider="gitlab", uid="gl-1", extra_data={})
        providers = [r["provider"] for r in self.client.get(LIST_URL).json()]
        self.assertEqual(providers, ["google", "github", "gitlab"])

    def test_list_is_only_the_requesting_users(self):
        bob = User.objects.create_user(username="bob", password="pw-123456789")
        SocialAccount.objects.create(user=bob, provider="github", uid="gh-bob", extra_data={})
        rows = {r["provider"]: r for r in self.client.get(LIST_URL).json()}
        self.assertFalse(rows["github"]["connected"])

    def test_list_requires_authentication(self):
        self.assertIn(
            APIClient().get(LIST_URL).status_code,
            (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN),
        )

    def test_disconnect_removes_and_fires_signal(self):
        SocialAccount.objects.create(user=self.user, provider="github", uid="gh-1", extra_data={})
        received = []

        def handler(sender, request, socialaccount, **kwargs):
            received.append(socialaccount.provider)

        signals.social_account_removed.connect(handler)
        try:
            response = self.client.delete(f"{LIST_URL}github/")
        finally:
            signals.social_account_removed.disconnect(handler)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertFalse(SocialAccount.objects.filter(user=self.user).exists())
        self.assertEqual(received, ["github"])
        rows = {r["provider"]: r for r in response.json()}
        self.assertFalse(rows["github"]["connected"])

    def test_cannot_remove_last_sign_in_method(self):
        self.user.set_unusable_password()
        self.user.save()
        self.client.force_login(self.user)
        SocialAccount.objects.create(user=self.user, provider="github", uid="gh-1", extra_data={})

        response = self.client.delete(f"{LIST_URL}github/")

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertTrue(response.json()["detail"])
        self.assertTrue(SocialAccount.objects.filter(user=self.user).exists())

    def test_passwordless_user_can_remove_one_of_two(self):
        self.user.set_unusable_password()
        self.user.save()
        self.client.force_login(self.user)
        SocialAccount.objects.create(user=self.user, provider="github", uid="gh-1", extra_data={})
        SocialAccount.objects.create(user=self.user, provider="google", uid="g-1", extra_data={})

        self.assertEqual(self.client.delete(f"{LIST_URL}github/").status_code, status.HTTP_200_OK)
        self.assertEqual(self.client.delete(f"{LIST_URL}google/").status_code, status.HTTP_400_BAD_REQUEST)
        self.assertTrue(SocialAccount.objects.filter(user=self.user, provider="google").exists())

    def test_cannot_disconnect_another_users_account(self):
        bob = User.objects.create_user(username="bob", password="pw-123456789")
        SocialAccount.objects.create(user=bob, provider="github", uid="gh-bob", extra_data={})

        response = self.client.delete(f"{LIST_URL}github/")

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertTrue(SocialAccount.objects.filter(user=bob).exists())

    def test_disconnect_requires_authentication(self):
        self.assertIn(
            APIClient().delete(f"{LIST_URL}github/").status_code,
            (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN),
        )
