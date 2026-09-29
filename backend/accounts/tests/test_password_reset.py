"""Tests for the password-reset flow: URL generation, OAuth-only user handling,
throttled endpoint, and confirm with valid/expired tokens."""
from unittest.mock import MagicMock, patch

from allauth.account.forms import default_token_generator
from allauth.account.utils import user_pk_to_url_str
from django.core.cache import cache
from django.test import Client, TestCase, override_settings
from rest_framework import status
from rest_framework.test import APIClient

from accounts.forms import VisibanPasswordResetForm, _frontend_url_generator
from accounts.models import User


class FrontendUrlGeneratorTests(TestCase):
    """_frontend_url_generator builds the correct SPA URL."""

    def _make_user(self):
        return User.objects.create_user(username="urltest", email="url@example.com", password="pass1")

    @override_settings(FRONTEND_URL="https://app.example.com")
    def test_url_uses_frontend_url(self):
        user = self._make_user()
        url = _frontend_url_generator(MagicMock(), user, "abc123-def456")
        uid = user_pk_to_url_str(user)
        self.assertEqual(url, f"https://app.example.com/reset-password/{uid}/abc123-def456")

    @override_settings(FRONTEND_URL="https://app.example.com/")
    def test_url_strips_trailing_slash(self):
        user = self._make_user()
        url = _frontend_url_generator(MagicMock(), user, "xyz-token")
        uid = user_pk_to_url_str(user)
        self.assertEqual(url, f"https://app.example.com/reset-password/{uid}/xyz-token")

    @override_settings(FRONTEND_URL="http://localhost:5173")
    def test_url_dev_default(self):
        user = self._make_user()
        url = _frontend_url_generator(MagicMock(), user, "tok-en")
        uid = user_pk_to_url_str(user)
        self.assertEqual(url, f"http://localhost:5173/reset-password/{uid}/tok-en")

    def test_url_reads_the_real_setting_without_an_override(self):
        """Regression: settings.FRONTEND_URL must actually exist (#356).

        ``_frontend_url_generator`` has always resolved it with
        ``getattr(settings, "FRONTEND_URL", "http://localhost:5173")``, but until
        #356 no setting was defined under that name — the env var was only ever
        read into LOGIN_REDIRECT_URL. So the getattr always took the localhost
        fallback and every production reset link pointed at a developer's laptop.
        Every test above masks that by injecting the setting with
        ``@override_settings``; this one deliberately does not, so the bug cannot
        come back unnoticed.
        """
        from django.conf import settings

        self.assertTrue(hasattr(settings, "FRONTEND_URL"))
        user = self._make_user()
        url = _frontend_url_generator(MagicMock(), user, "real-token")
        self.assertTrue(url.startswith(settings.FRONTEND_URL.rstrip("/")))
        self.assertEqual(settings.FRONTEND_URL, settings.LOGIN_REDIRECT_URL)


class OAuthOnlyPasswordResetTests(TestCase):
    """VisibanPasswordResetForm.save() sends the alternate email for OAuth-only users."""

    def test_oauth_only_user_gets_alternate_email(self):
        from allauth.socialaccount.models import SocialAccount

        user = User.objects.create_user(username="oauthuser", email="oauth@example.com")
        user.set_unusable_password()
        user.save()
        SocialAccount.objects.create(user=user, provider="google", uid="google-123", extra_data={})

        form = VisibanPasswordResetForm.__new__(VisibanPasswordResetForm)
        form.cleaned_data = {"email": "oauth@example.com"}
        form.users = [user]

        mock_adapter = MagicMock()
        request = MagicMock()

        with patch("accounts.forms.get_adapter", return_value=mock_adapter):
            form.save(request)

        # send_mail must be called with the no-password template.
        # All three args are positional: (template_prefix, email, context_dict).
        mock_adapter.send_mail.assert_called_once()
        args, _ = mock_adapter.send_mail.call_args
        self.assertEqual(args[0], "account/email/password_reset_no_password")
        self.assertEqual(args[2]["provider"], "Google")

    def test_regular_user_goes_through_standard_flow(self):
        user = User.objects.create_user(
            username="regular", email="regular@example.com", password="strongpass1"
        )

        form = VisibanPasswordResetForm.__new__(VisibanPasswordResetForm)
        form.cleaned_data = {"email": "regular@example.com"}
        form.users = [user]

        request = MagicMock()
        # super().save() is the actual AllAuthPasswordResetForm.save() — mock it
        with patch.object(
            VisibanPasswordResetForm.__bases__[0], "save", return_value=None
        ) as mock_super_save:
            form.save(request)
            mock_super_save.assert_called_once()


class PasswordResetEndpointTests(TestCase):
    """POST /api/v1/auth/password/reset/ — enumeration safety."""

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(
            username="alice", email="alice@example.com", password="strongpass1"
        )

    def _post_reset(self, email):
        # Patch VisibanPasswordResetForm.save to avoid sending real emails.
        with patch.object(VisibanPasswordResetForm, "save", return_value=None):
            return self.client.post(
                "/api/v1/auth/password/reset/", {"email": email}
            )

    def test_reset_request_returns_200_for_registered_email(self):
        r = self._post_reset("alice@example.com")
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_reset_request_returns_200_for_unknown_email(self):
        """Endpoint must not reveal whether an email is registered."""
        r = self._post_reset("nobody@example.com")
        self.assertEqual(r.status_code, status.HTTP_200_OK)


class PasswordResetConfirmTests(TestCase):
    """POST /api/v1/auth/password/reset/confirm/ — valid token, invalid token."""

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(
            username="bob", email="bob@example.com", password="oldpassword1"
        )

    def _make_confirm_payload(self, user=None):
        u = user or self.user
        # dj-rest-auth uses allauth's url_str_to_user_pk (base36) when allauth
        # is installed — must match or uid decoding returns 400.
        uid = user_pk_to_url_str(u)
        token = default_token_generator.make_token(u)
        return {
            "uid": uid,
            "token": token,
            "new_password1": "NewPass9876",
            "new_password2": "NewPass9876",
        }

    def test_confirm_with_valid_token_resets_password(self):
        payload = self._make_confirm_payload()
        r = self.client.post("/api/v1/auth/password/reset/confirm/", payload)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password("NewPass9876"))

    def test_confirm_with_invalid_token_returns_400(self):
        payload = self._make_confirm_payload()
        payload["token"] = "invalid-token-xyz"
        r = self.client.post("/api/v1/auth/password/reset/confirm/", payload)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_confirm_with_mismatched_passwords_returns_400(self):
        payload = self._make_confirm_payload()
        payload["new_password2"] = "DifferentPass9876"
        r = self.client.post("/api/v1/auth/password/reset/confirm/", payload)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_confirm_token_can_only_be_used_once(self):
        payload = self._make_confirm_payload()
        r1 = self.client.post("/api/v1/auth/password/reset/confirm/", payload)
        self.assertEqual(r1.status_code, status.HTTP_200_OK)
        # Second use of the same token must fail.
        r2 = self.client.post("/api/v1/auth/password/reset/confirm/", payload)
        self.assertEqual(r2.status_code, status.HTTP_400_BAD_REQUEST)


class PasswordResetThrottleStructureTests(TestCase):
    """Verify throttle classes are wired correctly and use IP-based (not anon-only) keys."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="throttle_user", email="throttle@example.com", password="strongpass1"
        )

    def test_password_reset_throttle_is_simple_rate_throttle(self):
        from rest_framework.throttling import SimpleRateThrottle, AnonRateThrottle
        from accounts.views import PasswordResetThrottle
        self.assertTrue(issubclass(PasswordResetThrottle, SimpleRateThrottle))
        self.assertFalse(issubclass(PasswordResetThrottle, AnonRateThrottle))

    def test_password_reset_throttle_key_is_not_none_for_authenticated_user(self):
        from accounts.views import PasswordResetThrottle
        throttle = PasswordResetThrottle()
        throttle.scope = "password_reset"
        request = MagicMock()
        request.user = self.user
        request.META = {"REMOTE_ADDR": "192.0.2.1"}
        key = throttle.get_cache_key(request, MagicMock())
        self.assertIsNotNone(key)
        self.assertIn("192.0.2.1", key)

    def test_password_reset_confirm_view_uses_confirm_throttle(self):
        from accounts.views import ThrottledPasswordResetConfirmView, PasswordResetConfirmThrottle
        throttle_classes = ThrottledPasswordResetConfirmView.throttle_classes
        self.assertIn(PasswordResetConfirmThrottle, throttle_classes)

    def test_password_reset_confirm_throttle_key_is_ip_based(self):
        from accounts.views import PasswordResetConfirmThrottle
        throttle = PasswordResetConfirmThrottle()
        throttle.scope = "password_reset_confirm"
        request = MagicMock()
        request.META = {"REMOTE_ADDR": "203.0.113.5"}
        key = throttle.get_cache_key(request, MagicMock())
        self.assertIsNotNone(key)
        self.assertIn("203.0.113.5", key)


class LoginThrottleStructureTests(TestCase):
    """#924 — verify the login throttle subclass and URL precedence so a
    future urls.py edit cannot silently drop the rate limit."""

    def test_login_throttle_is_simple_rate_throttle(self):
        from rest_framework.throttling import AnonRateThrottle, SimpleRateThrottle
        from accounts.views import LoginRateThrottle
        # SimpleRateThrottle (keyed on IP unconditionally) — not AnonRateThrottle
        # which skips authenticated requests and would let an attacker bypass
        # the limit by toggling auth state mid-attack.
        self.assertTrue(issubclass(LoginRateThrottle, SimpleRateThrottle))
        self.assertFalse(issubclass(LoginRateThrottle, AnonRateThrottle))

    def test_login_throttle_key_is_ip_based(self):
        from accounts.views import LoginRateThrottle
        throttle = LoginRateThrottle()
        request = MagicMock()
        request.META = {"REMOTE_ADDR": "198.51.100.7"}
        key = throttle.get_cache_key(request, MagicMock())
        self.assertIsNotNone(key)
        self.assertIn("198.51.100.7", key)

    def test_login_view_subclass_carries_throttle_class(self):
        from accounts.views import LoginRateThrottle, ThrottledLoginView
        self.assertIn(LoginRateThrottle, ThrottledLoginView.throttle_classes)

    def test_login_url_resolves_to_throttled_view(self):
        """``/api/v1/auth/login/`` must resolve to ThrottledLoginView, not the
        default dj-rest-auth LoginView.  A future urls.py reordering that
        broke the precedence would silently re-introduce the missing-scope
        gap reported in #924."""
        from django.urls import resolve
        from accounts.views import ThrottledLoginView
        match = resolve("/api/v1/auth/login/")
        view_cls = getattr(match.func, "view_class", None) or getattr(match.func, "cls", None)
        self.assertIs(view_cls, ThrottledLoginView)


class LoginPerAccountLockoutTests(TestCase):
    """#1199 — the allauth per-account ``login_failed`` lockout must actually
    engage on ``POST /api/v1/auth/login/``.

    Before #1199, dj-rest-auth's ``LoginSerializer.authenticate()`` called
    ``django.contrib.auth.authenticate()`` directly, which never reached
    allauth's ``pre_authenticate()`` / ``ratelimit.consume(action="login_failed")``
    hook. These tests exercise the real endpoint end-to-end and vary the source
    IP per attempt specifically to prove the lockout is keyed on the account,
    not the caller's IP (NUM_PROXIES=1, so the IP DRF/allauth resolve is the
    last hop of X-Forwarded-For) — a distributed attacker is exactly the gap
    #1199 closes.
    """

    PASSWORD = "correct-horse-battery-staple-1"  # gitleaks:allow -- test-only fixture password, not a credential

    def setUp(self):
        self.client = APIClient()
        self.victim = User.objects.create_user(
            username="lockout_victim", email="victim@example.com", password=self.PASSWORD
        )
        self.other = User.objects.create_user(
            username="lockout_other", email="other@example.com", password=self.PASSWORD
        )
        # allauth's ratelimit.consume() reads/writes Django's default cache
        # directly (not DRF's throttle cache) — clear it so no prior test's
        # login_failed usage bleeds into these, and clear again after so this
        # test's lockout state doesn't bleed into whatever runs next.
        cache.clear()
        self.addCleanup(cache.clear)

    def _post_login(self, username, password, ip):
        return self.client.post(
            "/api/v1/auth/login/",
            {"username": username, "password": password},
            format="json",
            HTTP_X_FORWARDED_FOR=ip,
            REMOTE_ADDR=ip,
        )

    def test_successful_login_still_works(self):
        r = self._post_login(self.other.username, self.PASSWORD, "203.0.113.1")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assertIn("key", r.json())

    def test_failed_attempts_from_many_ips_lock_the_account(self):
        # ACCOUNT_RATE_LIMITS["login_failed"] = "5/300s/key" — 5 failed attempts
        # exhausts the bucket. Each attempt comes from a distinct IP.
        for i in range(5):
            r = self._post_login(self.victim.username, "wrong-password", f"198.51.100.{i + 1}")
            self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)

        # A 6th attempt, from yet another new IP, with the CORRECT password —
        # must still be refused because the account (not the IP) is locked.
        r = self._post_login(self.victim.username, self.PASSWORD, "198.51.100.99")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
        detail = str(r.json())
        self.assertIn("Too many", detail)
        # No user-enumeration signal: the lockout message must not name the
        # account or otherwise differ from what an unknown username would get.
        self.assertNotIn(self.victim.username, detail)
        self.assertNotIn(self.victim.email, detail)

    def test_many_accounts_from_one_ip_trip_the_per_ip_limit(self):
        """Completeness-check re-check finding: allauth's per-IP rate
        ("10/m/ip") applies here too, not just on the HTML login view — the
        SPA endpoint now goes through the same rate-limited adapter (#1199).
        10 failed attempts across 10 *different* accounts, all from one IP,
        trip the per-IP bucket; an 11th attempt from that IP — even with a
        correct password, for an account that never itself failed — is also
        refused. This is a deliberate tradeoff to close single-IP,
        many-account credential stuffing against the SPA; it can briefly
        (up to the ~1-minute window) refuse a correct login sharing that IP
        (see docs/architecture/deployment.md's shared-NAT note)."""
        for i in range(10):
            User.objects.create_user(username=f"perip_spauser{i}", password=self.PASSWORD)
            r = self._post_login(f"perip_spauser{i}", "wrong-password", "10.10.10.10")
            self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)

        untouched = User.objects.create_user(username="perip_spauser_untouched", password=self.PASSWORD)
        r = self._post_login(untouched.username, self.PASSWORD, "10.10.10.10")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
        self.assertIn("Too many", str(r.json()))

    def test_demo_mode_published_account_is_exempt_from_lockout(self):
        """#1199 gate finding: the demo account's password is published to every
        visitor, so a per-account lockout on it protects nothing and is instead a
        repeatable DoS lever — 5 wrong passwords from anyone locks out every other
        visitor for 5 minutes. With DEMO_MODE on, the published account must keep
        working even after many failed attempts."""
        with override_settings(DEMO_MODE=True, DEMO_LOGIN_USERNAME="demovisitor"):
            User.objects.create_user(username="demovisitor", password=self.PASSWORD)
            for i in range(6):
                r = self._post_login("demovisitor", "wrong-password", f"192.0.2.{i + 1}")
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
            r = self._post_login("demovisitor", self.PASSWORD, "192.0.2.200")
            self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)

    def test_demo_mode_does_not_exempt_other_accounts(self):
        """The carve-out is scoped to DEMO_LOGIN_USERNAME only — every other
        account on a demo instance, including a real user's, keeps the full
        per-account lockout."""
        with override_settings(DEMO_MODE=True, DEMO_LOGIN_USERNAME="demovisitor"):
            for i in range(5):
                r = self._post_login(self.victim.username, "wrong-password", f"203.0.113.{i + 1}")
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
            r = self._post_login(self.victim.username, self.PASSWORD, "203.0.113.200")
            self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)

    def test_demo_username_locks_normally_when_demo_mode_is_off(self):
        """The carve-out only applies while DEMO_MODE is actually on — an
        install that merely reuses "visitor" as a real username, with demo mode
        off, gets the ordinary per-account lockout."""
        with override_settings(DEMO_MODE=False, DEMO_LOGIN_USERNAME="demovisitor"):
            User.objects.create_user(username="demovisitor", password=self.PASSWORD)
            for i in range(5):
                r = self._post_login("demovisitor", "wrong-password", f"198.18.0.{i + 1}")
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
            r = self._post_login("demovisitor", self.PASSWORD, "198.18.0.200")
            self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)

    def test_demo_carve_out_normalizes_case_and_whitespace(self):
        """#1199 completeness-check gap: the carve-out must match
        DEMO_LOGIN_USERNAME the same way allauth normalizes its own lockout
        key (lowercased), plus a strip — not an exact string match.

        The account itself is always logged into with its real, exact-case
        username ("demovisitor") — Django's username lookup is case-sensitive,
        so varying the *submitted* login's case would confound this with an
        unrelated "wrong username" failure. What actually needs to tolerate
        case/whitespace is DEMO_LOGIN_USERNAME itself (an operator-supplied
        env var), so that's what's varied here: removing either normalization
        step in ``_is_demo_account`` would make one of these configured values
        fail to recognize the real demo account and start failing this test.
        """
        User.objects.create_user(username="demovisitor", password=self.PASSWORD)
        for configured in ("DEMOVISITOR", " demovisitor ", "DemoVisitor"):
            with self.subTest(configured=configured):
                with override_settings(DEMO_MODE=True, DEMO_LOGIN_USERNAME=configured):
                    cache.clear()
                    for i in range(6):
                        r = self._post_login("demovisitor", "wrong-password", f"192.0.2.{i + 1}")
                        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
                    r = self._post_login("demovisitor", self.PASSWORD, "192.0.2.200")
                    self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)

    def test_empty_demo_login_username_exempts_nobody(self):
        """A misconfigured (empty/unset) DEMO_LOGIN_USERNAME must not
        accidentally exempt every account by comparing two empty strings —
        it should just never match, so the ordinary lockout still applies."""
        with override_settings(DEMO_MODE=True, DEMO_LOGIN_USERNAME=""):
            for i in range(5):
                r = self._post_login(self.victim.username, "wrong-password", f"203.0.113.{i + 10}")
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
            r = self._post_login(self.victim.username, self.PASSWORD, "203.0.113.201")
            self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)

    def test_other_account_is_unaffected_by_a_locked_account(self):
        for i in range(5):
            self._post_login(self.victim.username, "wrong-password", f"192.0.2.{i + 1}")
        # Confirm the victim account is indeed locked before checking isolation.
        locked = self._post_login(self.victim.username, self.PASSWORD, "192.0.2.99")
        self.assertEqual(locked.status_code, status.HTTP_400_BAD_REQUEST, locked.content)

        r = self._post_login(self.other.username, self.PASSWORD, "192.0.2.100")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assertIn("key", r.json())


class LoginLockoutEarlyRecoveryTests(TestCase):
    """#1203 — a successful password reset clears the per-account
    ``login_failed`` lockout early, instead of forcing a locked-out user to
    wait out the full 5-minute window even with their brand-new, correct
    password.

    Covers both identifier keys allauth's lockout can be keyed on
    (``ACCOUNT_LOGIN_METHODS = {"username", "email"}``) — see
    ``accounts.adapter.clear_login_lockout`` for why both must be cleared
    unconditionally.
    """

    PASSWORD = "correct-horse-battery-staple-1"  # gitleaks:allow -- test-only fixture password, not a credential
    NEW_PASSWORD = "NewPass9876"  # gitleaks:allow -- test-only fixture password, not a credential

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(
            username="lockout_reset_user", email="lockoutreset@example.com", password=self.PASSWORD
        )
        # Same reasoning as LoginPerAccountLockoutTests.setUp: allauth's
        # ratelimit.consume()/clear() read and write Django's default cache
        # directly, so it must be isolated per test.
        cache.clear()
        self.addCleanup(cache.clear)

    def _post_login(self, field, value, password, ip):
        return self.client.post(
            "/api/v1/auth/login/",
            {field: value, "password": password},
            format="json",
            HTTP_X_FORWARDED_FOR=ip,
            REMOTE_ADDR=ip,
        )

    def _lock_out_via(self, field, value, ip_prefix):
        for i in range(5):
            r = self._post_login(field, value, "wrong-password", f"{ip_prefix}.{i + 1}")
            self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
        # Confirm the account is actually locked (even the correct password is
        # refused) before testing recovery from it.
        locked = self._post_login(field, value, self.PASSWORD, f"{ip_prefix}.99")
        self.assertEqual(locked.status_code, status.HTTP_400_BAD_REQUEST, locked.content)

    def _reset_confirm_payload(self):
        uid = user_pk_to_url_str(self.user)
        token = default_token_generator.make_token(self.user)
        return {
            "uid": uid,
            "token": token,
            "new_password1": self.NEW_PASSWORD,
            "new_password2": self.NEW_PASSWORD,
        }

    def test_reset_clears_lockout_keyed_on_username(self):
        self._lock_out_via("username", self.user.username, "192.0.2")

        r = self.client.post("/api/v1/auth/password/reset/confirm/", self._reset_confirm_payload())
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)

        r = self._post_login("username", self.user.username, self.NEW_PASSWORD, "192.0.2.200")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)

    def test_reset_clears_lockout_keyed_on_email(self):
        self._lock_out_via("email", self.user.email, "198.51.100")

        r = self.client.post("/api/v1/auth/password/reset/confirm/", self._reset_confirm_payload())
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)

        # Since #1206 email login works (accounts.backends.EmailBackend), so
        # the reset must leave the user able to log in by email outright — not
        # merely "no longer rate-limited" as this test asserted before.
        r = self._post_login("email", self.user.email, self.NEW_PASSWORD, "198.51.100.200")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)

    def test_reset_does_not_clear_a_different_accounts_lockout(self):
        """The clear must be scoped to the resetting user — a locked-out
        bystander's lockout must survive an unrelated account's reset."""
        bystander = User.objects.create_user(
            username="lockout_bystander", email="bystander@example.com", password=self.PASSWORD
        )
        for i in range(5):
            r = self._post_login("username", bystander.username, "wrong-password", f"203.0.113.{i + 1}")
            self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)

        r = self.client.post("/api/v1/auth/password/reset/confirm/", self._reset_confirm_payload())
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)

        r = self._post_login("username", bystander.username, self.PASSWORD, "203.0.113.200")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)

    def test_reset_does_not_clear_the_per_ip_rate_limit(self):
        """The per-IP ``login_failed`` rate (10 failed attempts/minute, across
        ANY accounts — #1199) must survive a password reset completed from
        that same IP. allauth's own public ``ratelimit.clear()`` would clear
        BOTH configured rates for the action in one call, including the
        per-IP one computed from the reset request's own client IP — that
        would silently reopen the single-IP credential-stuffing gap #1199
        closed, every time anyone completes a reset. See
        ``accounts.adapter.clear_login_lockout``'s docstring for why this is
        scoped to the per-account (``/key``) rate only.
        """
        ip = "192.0.2.50"
        # Trip the per-IP bucket: 10 failed attempts across 10 different
        # accounts, all from the same IP the reset below is submitted from.
        for i in range(10):
            User.objects.create_user(username=f"perip_reset_user{i}", password=self.PASSWORD)
            r = self._post_login("username", f"perip_reset_user{i}", "wrong-password", ip)
            self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)

        r = self.client.post(
            "/api/v1/auth/password/reset/confirm/",
            self._reset_confirm_payload(),
            REMOTE_ADDR=ip,
            HTTP_X_FORWARDED_FOR=ip,
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)

        # The per-IP bucket must still be tripped: an 11th account that never
        # itself failed, logging in with its correct password from that same
        # IP, is still refused.
        untouched = User.objects.create_user(username="perip_reset_untouched", password=self.PASSWORD)
        r = self._post_login("username", untouched.username, self.PASSWORD, ip)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
        self.assertIn("Too many", str(r.json()))

    def test_failed_reset_attempt_does_not_clear_the_lockout(self):
        """security-review finding on #1203: an invalid/expired token must
        never reach ``VisibanPasswordResetConfirmSerializer.save()`` at all
        (dj-rest-auth's ``validate()`` raises before ``save()`` runs), so a
        rejected reset attempt must leave an existing lockout untouched —
        it must not become a way to clear a lockout without proving email
        access via a valid token."""
        self._lock_out_via("username", self.user.username, "198.18.0")

        payload = self._reset_confirm_payload()
        payload["token"] = "invalid-token-xyz"
        r = self.client.post("/api/v1/auth/password/reset/confirm/", payload)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)

        # Still locked out — including with the (unchanged) correct password.
        r = self._post_login("username", self.user.username, self.PASSWORD, "198.18.0.200")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
        self.assertIn("Too many", str(r.json()))


class AllauthHtmlLoginPerIpThrottleTests(TestCase):
    """#1199 completeness-check BLOCKER: allauth's own HTML login view,
    ``/accounts/login/`` (registered live via ``path("accounts/",
    include("allauth.urls"))``), is not behind ``ThrottledLoginView`` /
    ``LoginRateThrottle`` — that DRF throttle only wraps the SPA's
    ``/api/v1/auth/login/``. Before #1199, ``ACCOUNT_RATE_LIMITS["login_failed"]``
    was a bare ``"5/300s"``, which allauth happens to parse as a per-IP rate
    (no "/key" suffix), so this route was accidentally protected. Changing it
    to ``"5/300s/key"`` for the per-account fix removed that per-IP layer
    entirely, leaving this view an unlimited cross-account credential-stuffing
    oracle from a single IP (wrong password -> 200 re-render, right -> 302).
    ``ACCOUNT_RATE_LIMITS["login_failed"]`` is now ``"10/m/ip,5/300s/key"`` —
    both rates must allow a request through.
    """

    PASSWORD = "correct-horse-battery-staple-1"  # gitleaks:allow -- test-only fixture password, not a credential

    def setUp(self):
        # enforce_csrf_checks=False: this view renders and posts a real CSRF
        # token in normal use, but the throttle behavior under test doesn't
        # depend on CSRF at all, and disabling it keeps the test focused on
        # the rate limit rather than token plumbing.
        self.client = Client(enforce_csrf_checks=False)
        cache.clear()
        self.addCleanup(cache.clear)

    def _post_html_login(self, login, password, ip):
        return self.client.post(
            "/accounts/login/",
            {"login": login, "password": password},
            REMOTE_ADDR=ip,
        )

    def test_normal_login_still_works(self):
        User.objects.create_user(username="htmlloginuser", password=self.PASSWORD)
        r = self._post_html_login("htmlloginuser", self.PASSWORD, "203.0.113.50")
        self.assertEqual(r.status_code, 302, r.content)

    def test_many_accounts_from_one_ip_are_throttled(self):
        """The reviewer's probe: 12 failed attempts across 12 different
        accounts, all from one IP, then a real password for a 13th account
        from that same IP — must be refused. Before the fix this succeeded
        (302): unlimited cross-account credential stuffing from a single IP."""
        for i in range(12):
            User.objects.create_user(username=f"stuffuser{i}", password=self.PASSWORD)
            r = self._post_html_login(f"stuffuser{i}", "wrong-password", "198.51.100.200")
            self.assertEqual(r.status_code, 200, r.content)

        target = User.objects.create_user(username="stuffuser_target", password=self.PASSWORD)
        r = self._post_html_login(target.username, self.PASSWORD, "198.51.100.200")
        # Refused by the per-IP rate, not a login failure or a lockout on
        # `target` specifically — it never had a failed attempt of its own.
        self.assertNotEqual(r.status_code, 302, r.content)

    def test_five_failures_from_five_ips_still_locks_the_html_login_account(self):
        """The per-IP "10/m/ip" rate added alongside the per-account "/key"
        rate must not interfere with the #1199 per-account scenario: 5 failed
        attempts from 5 *different* IPs (well under the per-IP ceiling each)
        must still lock the account via the per-account rate, same as
        LoginPerAccountLockoutTests exercises against the SPA endpoint."""
        User.objects.create_user(username="fiveipsuser", password=self.PASSWORD)
        for i in range(5):
            r = self._post_html_login("fiveipsuser", "wrong-password", f"192.0.2.{i + 1}")
            self.assertEqual(r.status_code, 200, r.content)
        r = self._post_html_login("fiveipsuser", self.PASSWORD, "192.0.2.99")
        self.assertEqual(r.status_code, 200, r.content)
