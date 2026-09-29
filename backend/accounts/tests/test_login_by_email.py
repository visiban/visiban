"""#1206 — the login form says "Username or email", so email login must work,
and one account must have exactly one per-account lockout no matter which
identifier it is attacked by.

See ``accounts.backends`` for the resolution rules (username precedence,
case-insensitive unique email, fail-closed on a shared email) and
``accounts.adapter.RegistrationAdapter._get_login_attempts_cache_key`` for why
the lockout is keyed on the resolved account.
"""
from unittest.mock import patch

from django.conf import settings
from django.contrib.auth import hashers
from django.core.cache import cache
from django.test import RequestFactory, TestCase, override_settings
from rest_framework import status
from rest_framework.test import APIClient

from accounts.adapter import RegistrationAdapter, clear_login_lockout
from accounts.backends import EmailBackend, resolve_login_user
from accounts.models import User

PASSWORD = "correct-horse-battery-staple-1"  # gitleaks:allow -- test-only fixture password, not a credential
GENERIC_FAILURE = "Unable to log in with provided credentials."


class _LoginMixin:
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="email_login_user", email="Alice@Example.com", password=PASSWORD)
        # allauth's login_failed buckets live in Django's default cache.
        cache.clear()
        self.addCleanup(cache.clear)

    def _post(self, payload, ip="203.0.113.10"):
        return self.client.post(
            "/api/v1/auth/login/", payload, format="json", HTTP_X_FORWARDED_FOR=ip, REMOTE_ADDR=ip
        )

    def _login(self, identifier, password, ip="203.0.113.10"):
        return self._post({"username": identifier, "password": password}, ip)


class LoginByEmailTests(_LoginMixin, TestCase):
    def test_login_by_username_still_works(self):
        r = self._login("email_login_user", PASSWORD)
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assertIn("key", r.json())

    def test_login_by_email_in_username_field(self):
        r = self._login("Alice@Example.com", PASSWORD)
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assertIn("key", r.json())

    def test_login_by_email_is_case_insensitive(self):
        r = self._login("alice@example.COM", PASSWORD)
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)

    def test_login_by_email_in_email_field(self):
        r = self._post({"email": "alice@example.com", "password": PASSWORD})
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)

    def test_wrong_password_by_email_matches_unknown_identifier_response(self):
        """No enumeration: a known email with a wrong password and an unknown
        email get the byte-identical response."""
        known = self._login("alice@example.com", "wrong-password", ip="203.0.113.11")
        unknown = self._login("nobody@example.com", "wrong-password", ip="203.0.113.12")
        self.assertEqual(known.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(known.json(), unknown.json())
        self.assertIn(GENERIC_FAILURE, str(known.json()))

    def test_shared_email_fails_closed(self):
        """User.email is not unique at the DB level. An email shared by two
        accounts must log into neither — even with one account's correct
        password — and must look like any other failure."""
        User.objects.create_user(username="email_login_twin", email="alice@example.com", password="other-pass-123!")
        r = self._login("alice@example.com", PASSWORD)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
        self.assertIn(GENERIC_FAILURE, str(r.json()))
        # Username login is unaffected.
        r = self._login("email_login_user", PASSWORD)
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)

    def test_inactive_duplicate_does_not_make_email_ambiguous(self):
        """security-review finding: a deactivated account sharing the address
        must not block the live account's email login."""
        User.objects.create_user(
            username="email_login_stale", email="alice@example.com", password=PASSWORD, is_active=False
        )
        r = self._login("alice@example.com", PASSWORD)
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)

    def test_username_takes_precedence_over_another_accounts_email(self):
        """Usernames may contain "@". An identifier that IS a username always
        means that account, never another account whose email equals it."""
        User.objects.create_user(username="bob@example.com", email="", password="bobs-pass-123!")
        User.objects.create_user(username="carol", email="bob@example.com", password="carols-pass-123!")
        r = self._login("bob@example.com", "carols-pass-123!")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
        r = self._login("bob@example.com", "bobs-pass-123!", ip="203.0.113.13")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)

    def test_inactive_user_cannot_log_in_by_email(self):
        self.user.is_active = False
        self.user.save(update_fields=["is_active"])
        r = self._login("alice@example.com", PASSWORD)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
        self.assertIn(GENERIC_FAILURE, str(r.json()))

    def test_email_field_works_when_identifier_equals_the_account_username(self):
        """completeness-check finding (#1206): an identifier submitted via the
        `email` field that happens to equal the account's username (a username
        that is itself an email address) must still authenticate.

        ``EmailBackend`` defers to ``ModelBackend`` whenever the resolved
        account's username textually equals the identifier — correct when
        that identifier arrived via the `username` field (ModelBackend already
        checked it), but wrong when it arrived via `email`: ModelBackend's
        `authenticate()` returns immediately, without checking anything, when
        its `username` kwarg is None. Without the `username is not None` guard
        in `EmailBackend.authenticate()`, this deferral fires anyway and the
        login always fails, even with the correct password.
        """
        User.objects.create_user(username="dana@example.com", email="dana@example.com", password=PASSWORD)
        r = self._post({"email": "dana@example.com", "password": PASSWORD})
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        # Also confirm this doesn't regress the case-insensitive email path,
        # which happens to differ from the username by case (and so never hit
        # the buggy deferral, since `get_username() == identifier` is a
        # case-sensitive comparison).
        r = self._post({"email": "DANA@example.com", "password": PASSWORD}, ip="203.0.113.14")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)

    def test_model_backend_stays_first_for_existing_sessions(self):
        """Existing sessions record ModelBackend as their backend; it must stay
        listed or every user is logged out on upgrade."""
        self.assertEqual(
            settings.AUTHENTICATION_BACKENDS[:2],
            ["django.contrib.auth.backends.ModelBackend", "accounts.backends.EmailBackend"],
        )


class ResolveLoginUserTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="resolver", email="resolver@example.com", password=PASSWORD)

    def test_resolves_username_and_email(self):
        self.assertEqual(resolve_login_user("resolver"), self.user)
        self.assertEqual(resolve_login_user("RESOLVER@example.com"), self.user)

    def test_blank_and_unknown_resolve_to_none(self):
        User.objects.create_user(username="no_email_1", email="", password=PASSWORD)
        User.objects.create_user(username="no_email_2", email="", password=PASSWORD)
        self.assertIsNone(resolve_login_user(""))
        self.assertIsNone(resolve_login_user(None))
        self.assertIsNone(resolve_login_user("unknown@example.com"))


class ResolveLoginUserMemoizationTests(TestCase):
    """perf-check finding: one login request resolves the identifier in up to
    three places; with ``request`` passed, only the first one hits the DB."""

    def test_resolution_is_memoized_per_request_and_identifier(self):
        user = User.objects.create_user(username="memo_user", email="memo@example.com", password=PASSWORD)
        request = RequestFactory().post("/")
        with self.assertNumQueries(2):  # failed username lookup + email lookup
            self.assertEqual(resolve_login_user("memo@example.com", request), user)
        with self.assertNumQueries(0):
            self.assertEqual(resolve_login_user("memo@example.com", request), user)
        with self.assertNumQueries(1):  # a different identifier is resolved afresh
            self.assertEqual(resolve_login_user("memo_user", request), user)
        with self.assertNumQueries(2):  # no request -> no memoization
            resolve_login_user("memo@example.com")


class EmailBackendTimingTests(TestCase):
    """Every failed path runs exactly one password hash in EmailBackend (the
    ModelBackend ahead of it runs its own one), so failure timing does not
    reveal whether an identifier is a username, a known email, or unknown."""

    def setUp(self):
        User.objects.create_user(username="timing_user", email="timing@example.com", password=PASSWORD)
        User.objects.create_user(username="twin_a", email="shared@example.com", password=PASSWORD)
        User.objects.create_user(username="twin_b", email="shared@example.com", password=PASSWORD)

    def _hash_count(self, identifier):
        request = RequestFactory().post("/")
        with patch("django.contrib.auth.base_user.make_password", wraps=hashers.make_password) as mk, \
             patch("django.contrib.auth.base_user.check_password", wraps=hashers.check_password) as ck:
            self.assertIsNone(EmailBackend().authenticate(request, username=identifier, password="wrong-password"))
            return mk.call_count + ck.call_count

    def test_each_failure_path_costs_one_hash(self):
        for identifier in ("timing_user", "timing@example.com", "unknown@example.com", "shared@example.com"):
            with self.subTest(identifier=identifier):
                self.assertEqual(self._hash_count(identifier), 1)


class SingleLockoutAcrossIdentifiersTests(_LoginMixin, TestCase):
    """ACCOUNT_RATE_LIMITS["login_failed"] = "5/300s/key": failures by username
    and by email must accumulate into ONE per-account lockout, and a lockout
    tripped through either identifier must block the other. Each attempt comes
    from a distinct IP so the per-IP rate never interferes."""

    def test_failures_by_username_and_email_accumulate(self):
        for i, ident in enumerate(["email_login_user", "alice@example.com", "email_login_user",
                                   "ALICE@example.com", "email_login_user"]):
            r = self._login(ident, "wrong-password", ip=f"198.51.100.{i + 1}")
            self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
            self.assertNotIn("Too many", str(r.json()))
        for ident in ("email_login_user", "alice@example.com"):
            with self.subTest(identifier=ident):
                r = self._login(ident, PASSWORD, ip="198.51.100.99")
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
                self.assertIn("Too many", str(r.json()))

    def test_lockout_by_email_blocks_username(self):
        for i in range(5):
            self._login("alice@example.com", "wrong-password", ip=f"192.0.2.{i + 1}")
        r = self._login("email_login_user", PASSWORD, ip="192.0.2.99")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
        self.assertIn("Too many", str(r.json()))

    def test_lockout_by_username_blocks_email_field(self):
        for i in range(5):
            self._login("email_login_user", "wrong-password", ip=f"192.0.2.{i + 10}")
        r = self._post({"email": "alice@example.com", "password": PASSWORD}, ip="192.0.2.98")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
        self.assertIn("Too many", str(r.json()))

    def test_unknown_identifier_is_still_rate_limited(self):
        """Identifiers that resolve to no account keep allauth's own
        submitted-string key, so spraying one unknown email still locks."""
        for i in range(5):
            self._login("ghost@example.com", "wrong-password", ip=f"203.0.113.{i + 20}")
        r = self._login("ghost@example.com", "wrong-password", ip="203.0.113.99")
        self.assertIn("Too many", str(r.json()))

    def test_other_account_unaffected(self):
        other = User.objects.create_user(username="bystander_1206", email="by@example.com", password=PASSWORD)
        for i in range(5):
            self._login("alice@example.com", "wrong-password", ip=f"192.0.2.{i + 30}")
        r = self._login(other.email, PASSWORD, ip="192.0.2.97")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)

    def test_clear_login_lockout_clears_the_account_key(self):
        """Admin clear-lockout and password reset (#1203) share
        clear_login_lockout — it must clear the account-scoped bucket that
        email attempts now consume."""
        for i in range(5):
            self._login("alice@example.com", "wrong-password", ip=f"192.0.2.{i + 40}")
        request = RequestFactory().post("/")
        clear_login_lockout(request, self.user)
        for ident in ("alice@example.com", "email_login_user"):
            with self.subTest(identifier=ident):
                r = self._login(ident, PASSWORD, ip="192.0.2.96")
                self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)

    def test_lockout_key_is_account_scoped(self):
        request = RequestFactory().post("/")
        adapter = RegistrationAdapter(request)
        by_username = adapter._get_login_attempts_cache_key(request, username="email_login_user")
        by_email = adapter._get_login_attempts_cache_key(request, email="ALICE@example.com")
        by_email_in_username = adapter._get_login_attempts_cache_key(request, username="alice@example.com")
        self.assertEqual(by_username, by_email)
        self.assertEqual(by_username, by_email_in_username)
        self.assertTrue(by_username.endswith(f"#account:{self.user.pk}"))
        # The key never carries the email in the clear.
        self.assertNotIn("alice", by_username.lower())


class DemoModeEmailCarveOutTests(_LoginMixin, TestCase):
    def test_demo_account_by_email_is_exempt_from_lockout(self):
        """The published demo account's lockout carve-out (#1199) must also
        cover the demo account named by its email, now that email login
        resolves to the same account key."""
        User.objects.create_user(username="demovisitor", email="visitor@demo.example", password=PASSWORD)
        with override_settings(DEMO_MODE=True, DEMO_LOGIN_USERNAME="demovisitor"):
            for i in range(6):
                r = self._login("visitor@demo.example", "wrong-password", ip=f"192.0.2.{i + 50}")
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
            r = self._login("demovisitor", PASSWORD, ip="192.0.2.95")
            self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
            r = self._login("visitor@demo.example", PASSWORD, ip="192.0.2.94")
            self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
