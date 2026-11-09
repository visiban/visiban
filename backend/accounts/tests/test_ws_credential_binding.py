"""Unit tests for WebSocket credential binding (#1483).

A socket records the credential it was admitted with (``scope[
WS_CREDENTIAL_SCOPE_KEY]``), and the consumers' periodic re-check (#1477) calls
``load_live_ws_user`` to fail closed once that credential is revoked. These
cover the binding primitives one rule at a time; the end-to-end behavior
through the real ASGI stack is in ``test_ws_credential_revocation_e2e.py``.
"""
import asyncio
from datetime import timedelta
from importlib import import_module
from unittest.mock import patch

from django.conf import settings
from django.contrib.sessions.models import Session
from django.core.cache import cache
from django.test import TestCase, TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework import status
from rest_framework.authtoken.models import Token
from rest_framework.test import APIClient

from accounts.models import PersonalAccessToken, User
from accounts.tests.ws_cache_engine import OWN_CACHE
from accounts.tests.ws_helpers import bound_scope, login_session, session_ticket
from accounts.ws_auth import (
    CREDENTIAL_PAT,
    CREDENTIAL_SESSION,
    CREDENTIAL_TOKEN,
    WS_CREDENTIAL_SCOPE_KEY,
    TicketAuthMiddleware,
    _bind,
    _ticket_cache_key,
    consume_ws_ticket,
    issue_ws_ticket,
    load_live_ws_user,
    pat_credential,
    session_credential,
    token_credential,
    ws_credential_is_live,
)

WS_TICKET_URL = "/api/v1/auth/ws-ticket/"


class TicketMintingBindsTheCredentialTests(TestCase):
    """POST /auth/ws-ticket/ records which credential asked for the ticket."""

    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(username="bind_user", password="pass")
        self.client = APIClient()

    def _payload(self, ticket):
        return cache.get(_ticket_cache_key(ticket))

    def test_session_ticket_seals_the_session_key(self):
        self.client.force_login(self.user)
        session_key = self.client.cookies[settings.SESSION_COOKIE_NAME].value
        ticket = self.client.post(WS_TICKET_URL).json()["ticket"]

        payload = self._payload(ticket)
        self.assertEqual(payload["credential"]["kind"], CREDENTIAL_SESSION)
        # A cache reader must not be able to lift the session key out.
        self.assertNotIn(session_key, repr(payload))

    def test_pat_ticket_records_the_token_id(self):
        pat, raw = PersonalAccessToken.generate(self.user, "cli")
        ticket = self.client.post(WS_TICKET_URL, HTTP_AUTHORIZATION=f"Token {raw}").json()["ticket"]

        payload = self._payload(ticket)
        self.assertEqual(payload["credential"], {"kind": CREDENTIAL_PAT, "ref": pat.pk})
        self.assertNotIn(raw, repr(payload))

    def test_drf_token_ticket_records_only_a_digest(self):
        token = Token.objects.create(user=self.user)
        r = self.client.post(WS_TICKET_URL, HTTP_AUTHORIZATION=f"Token {token.key}")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)

        payload = self._payload(r.json()["ticket"])
        self.assertEqual(payload["credential"]["kind"], CREDENTIAL_TOKEN)
        self.assertNotIn(token.key, repr(payload))

    def test_request_with_no_revocable_credential_is_refused(self):
        """Fail closed: an authenticated request whose credential cannot be
        re-validated later gets no ticket (here: a forced auth, no session)."""
        self.client.force_authenticate(self.user)
        r = self.client.post(WS_TICKET_URL)
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_issue_requires_a_credential(self):
        with self.assertRaises(ValueError):
            issue_ws_ticket(self.user, None)
        with self.assertRaises(ValueError):
            issue_ws_ticket(self.user, {"kind": "carrier-pigeon", "ref": 1})

    def test_consume_still_returns_the_user_id(self):
        ticket, _ = session_ticket(self.user)
        self.assertEqual(consume_ws_ticket(ticket), self.user.id)


class CredentialLivenessTests(TestCase):
    """``ws_credential_is_live``: one rule per credential kind, all fail closed."""

    def setUp(self):
        self.user = User.objects.create_user(username="live_user", password="pass")

    def _fresh(self):
        return User.objects.get(pk=self.user.pk)

    def _change_password(self):
        user = self._fresh()
        user.set_password("Another-long-passphrase-1483")
        user.save(update_fields=["password"])

    # -- session -------------------------------------------------------------

    def test_live_session(self):
        cred = _bind(session_credential(login_session(self.user)), self.user)
        self.assertTrue(ws_credential_is_live(cred, self._fresh()))

    def test_deleted_session(self):
        """Logout (session.flush) and admin/session revocation both delete the row."""
        key = login_session(self.user)
        cred = _bind(session_credential(key), self.user)
        Session.objects.filter(session_key=key).delete()
        self.assertFalse(ws_credential_is_live(cred, self._fresh()))

    def test_expired_session(self):
        key = login_session(self.user)
        cred = _bind(session_credential(key), self.user)
        Session.objects.filter(session_key=key).update(expire_date=timezone.now() - timedelta(seconds=1))
        self.assertFalse(ws_credential_is_live(cred, self._fresh()))

    def test_session_belonging_to_another_user(self):
        other = User.objects.create_user(username="live_other", password="pass")
        cred = _bind(session_credential(login_session(other)), self.user)
        self.assertFalse(ws_credential_is_live(cred, self._fresh()))

    def test_session_after_password_change(self):
        cred = _bind(session_credential(login_session(self.user)), self.user)
        self._change_password()
        self.assertFalse(ws_credential_is_live(cred, self._fresh()))

    def test_anonymous_session_left_behind_by_logout(self):
        """A session that exists but no longer carries a login is not live."""
        store = import_module(settings.SESSION_ENGINE).SessionStore()
        store["unrelated"] = 1
        store.create()
        cred = _bind(session_credential(store.session_key), self.user)
        self.assertFalse(ws_credential_is_live(cred, self._fresh()))

    # -- personal access token ---------------------------------------------

    def test_live_pat(self):
        pat, _ = PersonalAccessToken.generate(self.user, "cli")
        self.assertTrue(ws_credential_is_live(_bind(pat_credential(pat), self.user), self._fresh()))

    def test_deleted_pat(self):
        pat, _ = PersonalAccessToken.generate(self.user, "cli")
        cred = _bind(pat_credential(pat), self.user)
        pat.delete()
        self.assertFalse(ws_credential_is_live(cred, self._fresh()))

    def test_expired_pat(self):
        pat, _ = PersonalAccessToken.generate(self.user, "cli")
        cred = _bind(pat_credential(pat), self.user)
        PersonalAccessToken.objects.filter(pk=pat.pk).update(expires_at=timezone.now() - timedelta(seconds=1))
        self.assertFalse(ws_credential_is_live(cred, self._fresh()))

    def test_another_users_pat_id(self):
        other = User.objects.create_user(username="pat_other", password="pass")
        pat, _ = PersonalAccessToken.generate(other, "cli")
        cred = _bind(pat_credential(pat), self.user)
        self.assertFalse(ws_credential_is_live(cred, self._fresh()))

    def test_pat_expiry_boundary_matches_rest(self):
        """The socket uses REST's expiry predicate: valid at the expiry instant
        itself, expired just after (``expires_at < now``)."""
        from accounts.authentication import pat_is_expired

        pat, _ = PersonalAccessToken.generate(self.user, "cli")
        at = timezone.now() + timedelta(hours=1)
        PersonalAccessToken.objects.filter(pk=pat.pk).update(expires_at=at)
        pat.refresh_from_db()
        cred = _bind(pat_credential(pat), self.user)
        for now, expired in ((at, False), (at + timedelta(microseconds=1), True)):
            with self.subTest(now=now), patch("accounts.authentication.timezone.now", return_value=now):
                self.assertEqual(pat_is_expired(pat), expired)
                self.assertEqual(ws_credential_is_live(cred, self._fresh()), not expired)

    # -- SECRET_KEY rotation ----------------------------------------------------

    def test_secret_key_rotation_fails_closed(self):
        """Without the old key as a fallback, no hash matches: the socket closes."""
        cred = _bind(session_credential(login_session(self.user)), self.user)
        with override_settings(SECRET_KEY="rotated-" + settings.SECRET_KEY, SECRET_KEY_FALLBACKS=[]):
            self.assertFalse(ws_credential_is_live(cred, self._fresh()))

    def test_secret_key_rotation_with_fallback_keeps_the_socket(self):
        old = settings.SECRET_KEY
        cred = _bind(session_credential(login_session(self.user)), self.user)
        with override_settings(SECRET_KEY="rotated-" + old, SECRET_KEY_FALLBACKS=[old]):
            self.assertTrue(ws_credential_is_live(cred, self._fresh()))

    # -- DRF token -------------------------------------------------------------

    def test_live_drf_token(self):
        token = Token.objects.create(user=self.user)
        self.assertTrue(ws_credential_is_live(_bind(token_credential(token), self.user), self._fresh()))

    def test_deleted_drf_token(self):
        token = Token.objects.create(user=self.user)
        cred = _bind(token_credential(token), self.user)
        token.delete()
        self.assertFalse(ws_credential_is_live(cred, self._fresh()))

    def test_reissued_drf_token(self):
        token = Token.objects.create(user=self.user)
        cred = _bind(token_credential(token), self.user)
        token.delete()
        Token.objects.create(user=self.user)
        self.assertFalse(ws_credential_is_live(cred, self._fresh()))

    def test_drf_token_after_password_change(self):
        """A password change closes the socket through the recorded auth hash alone.

        ``_change_password`` sets the password directly, without the
        ``finalize_password_change`` step that revokes the token, so this
        isolates the auth-hash check from token revocation."""
        token = Token.objects.create(user=self.user)
        cred = _bind(token_credential(token), self.user)
        self._change_password()
        self.assertTrue(Token.objects.filter(user=self.user).exists())
        self.assertFalse(ws_credential_is_live(cred, self._fresh()))

    # -- malformed ---------------------------------------------------------------

    def test_missing_or_malformed_credential_fails_closed(self):
        key = login_session(self.user)
        user = self._fresh()
        for cred in (
            None,
            {},
            "session",
            session_credential(key),  # no auth_hash recorded
            {**_bind(session_credential(key), self.user), "auth_hash": "forged"},
            {**_bind(session_credential(key), self.user), "kind": "carrier-pigeon"},
            {**_bind(session_credential(key), self.user), "ref": ""},
        ):
            with self.subTest(cred=cred):
                self.assertFalse(ws_credential_is_live(cred, user))

    def test_load_live_ws_user_needs_a_recorded_credential(self):
        self.assertIsNone(load_live_ws_user({"user": self.user}))
        self.assertEqual(load_live_ws_user({"user": self.user, **bound_scope(self.user)}), self.user)

    def test_load_live_ws_user_refuses_an_inactive_account(self):
        scope = {"user": self.user, **bound_scope(self.user)}
        User.objects.filter(pk=self.user.pk).update(is_active=False)
        self.assertIsNone(load_live_ws_user(scope))


CACHE_ENGINE = "django.contrib.sessions.backends.cache"
CACHED_DB_ENGINE = "django.contrib.sessions.backends.cached_db"
OWN_CACHE_ENGINE = "accounts.tests.ws_cache_engine"


class CacheSessionOutageTests(TestCase):
    """A cache-only session backend outage raises, it does not read as revoked (#2014).

    Django's cache SessionStore.load() swallows cache errors and returns {},
    which would close the socket with the final 4003. The liveness check reads
    the cache directly so the error reaches the consumer (which maps it to
    the reconnectable 4503, #2142); an absent session must still fail closed.
    """

    def setUp(self):
        self.user = User.objects.create_user(username="cache_sess_user", password="pass")

    def _fresh(self):
        return User.objects.get(pk=self.user.pk)

    @override_settings(SESSION_ENGINE=CACHE_ENGINE)
    def test_live_cache_session(self):
        cred = _bind(session_credential(login_session(self.user)), self.user)
        self.assertTrue(ws_credential_is_live(cred, self._fresh()))

    @override_settings(SESSION_ENGINE=CACHE_ENGINE)
    def test_absent_cache_session_is_a_denial(self):
        key = login_session(self.user)
        cred = _bind(session_credential(key), self.user)
        import_module(CACHE_ENGINE).SessionStore(session_key=key).delete()
        self.assertFalse(ws_credential_is_live(cred, self._fresh()))

    @override_settings(SESSION_ENGINE=CACHE_ENGINE)
    def test_cache_outage_raises_instead_of_reading_as_revoked(self):
        key = login_session(self.user)
        cred = _bind(session_credential(key), self.user)
        with patch("django.core.cache.backends.locmem.LocMemCache.get", side_effect=ConnectionError("cache down")):
            with self.assertRaises(ConnectionError):
                ws_credential_is_live(cred, self._fresh())

    @override_settings(SESSION_ENGINE=CACHE_ENGINE)
    def test_load_live_ws_user_propagates_a_cache_outage(self):
        """The consumers' entry point raises (they map any raise to 4503), it
        does not return None (which they map to the final 4003)."""
        scope = {"user": self.user, **bound_scope(self.user)}
        self.assertEqual(load_live_ws_user(scope), self.user)
        with patch("django.core.cache.backends.locmem.LocMemCache.get", side_effect=ConnectionError("cache down")):
            with self.assertRaises(ConnectionError):
                load_live_ws_user(scope)

    @override_settings(SESSION_ENGINE=OWN_CACHE_ENGINE)
    def test_reads_the_cache_the_store_uses_not_the_settings_alias(self):
        """A cache-engine subclass with its own cache: a live session must be
        found there (reading SESSION_CACHE_ALIAS instead would find nothing and
        close every socket with 4003), and an outage of *that* cache raises."""
        key = login_session(self.user)
        cred = _bind(session_credential(key), self.user)
        self.assertTrue(ws_credential_is_live(cred, self._fresh()))
        with patch.object(OWN_CACHE, "get", side_effect=ConnectionError("cache down")):
            with self.assertRaises(ConnectionError):
                ws_credential_is_live(cred, self._fresh())

    @override_settings(SESSION_ENGINE=CACHED_DB_ENGINE)
    def test_cached_db_does_not_misreport_a_cache_failure_as_revoked(self):
        """cached_db's load() reads the DB row when the cache get fails, so an
        outage is not read as a revoked session (it can still raise elsewhere)."""
        key = login_session(self.user)
        cred = _bind(session_credential(key), self.user)
        cache_get = "django.core.cache.backends.locmem.LocMemCache.get"
        with patch(cache_get, side_effect=ConnectionError("cache down")):
            self.assertTrue(ws_credential_is_live(cred, self._fresh()))
        Session.objects.filter(session_key=key).delete()
        with patch(cache_get, side_effect=ConnectionError("cache down")):
            self.assertFalse(ws_credential_is_live(cred, self._fresh()))


class _CapturingApp:
    def __init__(self):
        self.scope = None

    async def __call__(self, scope, receive, send):
        self.scope = scope


class _Session:
    def __init__(self, session_key):
        self.session_key = session_key


def _run(scope):
    inner = _CapturingApp()
    asyncio.run(TicketAuthMiddleware(inner)(scope, None, None))
    return inner.scope


class MiddlewareRecordsTheCredentialTests(TransactionTestCase):
    """TicketAuthMiddleware sets ``scope[WS_CREDENTIAL_SCOPE_KEY]`` on every path.

    TransactionTestCase for the same reason as test_ws_auth_middleware.py: the
    ticket path reaches the ORM through ``database_sync_to_async``.
    """

    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(username="mw_bind_user", password="pass")

    def test_cookie_handshake_records_the_session(self):
        key = login_session(self.user)
        scope = _run({"type": "websocket", "query_string": b"", "user": self.user, "session": _Session(key)})
        cred = scope[WS_CREDENTIAL_SCOPE_KEY]
        self.assertEqual(cred["kind"], CREDENTIAL_SESSION)
        self.assertEqual(cred["ref"], key)
        self.assertEqual(cred["auth_hash"], self.user.get_session_auth_hash())

    def test_ticket_handshake_records_the_minting_credential(self):
        key = login_session(self.user)
        ticket, _ = session_ticket(self.user, key)
        scope = _run({"type": "websocket", "query_string": f"ticket={ticket}".encode()})
        self.assertEqual(scope["user"].pk, self.user.pk)
        self.assertEqual(scope[WS_CREDENTIAL_SCOPE_KEY]["ref"], key)

    def test_ticket_minted_by_a_session_that_has_since_logged_out_is_refused(self):
        key = login_session(self.user)
        ticket, _ = session_ticket(self.user, key)
        Session.objects.filter(session_key=key).delete()
        scope = _run({"type": "websocket", "query_string": f"ticket={ticket}".encode()})
        self.assertFalse(scope["user"].is_authenticated)
        self.assertIsNone(scope[WS_CREDENTIAL_SCOPE_KEY])

    def test_caller_supplied_credential_is_overwritten(self):
        forged = {"kind": CREDENTIAL_PAT, "ref": 1, "auth_hash": "x"}
        scope = _run({"type": "websocket", "query_string": b"", WS_CREDENTIAL_SCOPE_KEY: forged})
        self.assertIsNone(scope[WS_CREDENTIAL_SCOPE_KEY])

    def test_anonymous_cookie_handshake_records_nothing(self):
        from django.contrib.auth.models import AnonymousUser

        scope = _run({"type": "websocket", "query_string": b"", "user": AnonymousUser(), "session": _Session("k")})
        self.assertIsNone(scope[WS_CREDENTIAL_SCOPE_KEY])


class SessionEngineSystemCheckTests(TestCase):
    """accounts.W001: warn when SESSION_ENGINE cannot observe a logout (#1483)."""

    def _check(self):
        from accounts.checks import check_session_engine_supports_ws_revocation

        return check_session_engine_supports_ws_revocation(None)

    @override_settings(SESSION_ENGINE="django.contrib.sessions.backends.signed_cookies")
    def test_signed_cookies_warns(self):
        from django.core import checks

        results = self._check()
        self.assertEqual([r.id for r in results], ["accounts.W001"])
        self.assertIsInstance(results[0], checks.Warning)
        self.assertNotIsInstance(results[0], checks.Error)

    def test_database_engine_is_clean(self):
        for engine in (
            "django.contrib.sessions.backends.db",
            "django.contrib.sessions.backends.cache",
            "django.contrib.sessions.backends.cached_db",
        ):
            with self.subTest(engine=engine), override_settings(SESSION_ENGINE=engine):
                self.assertEqual(self._check(), [])

    def test_registered_under_the_security_tag(self):
        from django.core import checks

        from accounts.checks import check_session_engine_supports_ws_revocation

        self.assertIn(
            check_session_engine_supports_ws_revocation,
            checks.registry.registry.get_checks(include_deployment_checks=False),
        )
        self.assertIn(checks.Tags.security, check_session_engine_supports_ws_revocation.tags)


class WsOriginWildcardHostsCheckTests(TestCase):
    """accounts.W002: wildcard ALLOWED_HOSTS with no public origin listed (#1697)."""

    def _check(self):
        from accounts.checks import check_wildcard_allowed_hosts

        return check_wildcard_allowed_hosts(None)

    @override_settings(
        DEBUG=False,
        ALLOWED_HOSTS=["*"],
        CORS_ALLOWED_ORIGINS=["http://localhost:5173"],
        CSRF_TRUSTED_ORIGINS=["http://localhost:5173"],
    )
    def test_star_without_public_origin_warns(self):
        from django.core import checks

        results = self._check()
        self.assertEqual([r.id for r in results], ["accounts.W002"])
        self.assertIsInstance(results[0], checks.Warning)
        self.assertIn("SILENCED_SYSTEM_CHECKS", results[0].hint)
        self.assertIn("CORS_ALLOWED_ORIGINS", results[0].hint)

    @override_settings(
        DEBUG=False, ALLOWED_HOSTS=[".example.com"], CORS_ALLOWED_ORIGINS=[], CSRF_TRUSTED_ORIGINS=[]
    )
    def test_leading_dot_without_origins_warns(self):
        self.assertEqual([r.id for r in self._check()], ["accounts.W002"])

    @override_settings(
        DEBUG=False,
        ALLOWED_HOSTS=["*"],
        CORS_ALLOWED_ORIGINS=["http://[::1]:5173"],
        CSRF_TRUSTED_ORIGINS=["https://*.example.com"],
    )
    def test_wildcard_origin_and_bracketed_loopback_do_not_clear_it(self):
        self.assertEqual([r.id for r in self._check()], ["accounts.W002"])

    @override_settings(
        DEBUG=False,
        ALLOWED_HOSTS=["*", "[::1]"],
        CORS_ALLOWED_ORIGINS=[],
        CSRF_TRUSTED_ORIGINS=[],
    )
    def test_bracketed_loopback_host_beside_wildcard_still_warns(self):
        self.assertEqual([r.id for r in self._check()], ["accounts.W002"])

    @override_settings(
        DEBUG=False,
        ALLOWED_HOSTS=["[.example.com]", "[*]"],
        CORS_ALLOWED_ORIGINS=[],
        CSRF_TRUSTED_ORIGINS=[],
    )
    def test_bracketed_pattern_entries_are_patterns_not_exact_hosts(self):
        self.assertEqual([r.id for r in self._check()], ["accounts.W002"])

    @override_settings(
        DEBUG=False,
        ALLOWED_HOSTS=["*", ""],
        CORS_ALLOWED_ORIGINS=[],
        CSRF_TRUSTED_ORIGINS=[],
    )
    def test_empty_host_entry_does_not_clear_it(self):
        self.assertEqual([r.id for r in self._check()], ["accounts.W002"])

    @override_settings(
        DEBUG=False,
        ALLOWED_HOSTS=["*", "app.example.com"],
        CORS_ALLOWED_ORIGINS=[],
        CSRF_TRUSTED_ORIGINS=[],
    )
    def test_exact_public_host_beside_wildcard_is_clean(self):
        self.assertEqual(self._check(), [])

    @override_settings(
        DEBUG=False,
        ALLOWED_HOSTS=["*"],
        CORS_ALLOWED_ORIGINS=[],
        CSRF_TRUSTED_ORIGINS=["https://app.example.com"],
    )
    def test_listed_public_origin_clears_it(self):
        self.assertEqual(self._check(), [])

    @override_settings(
        DEBUG=False,
        ALLOWED_HOSTS=["*"],
        CORS_ALLOWED_ORIGINS=["https://app.example.com"],
        CSRF_TRUSTED_ORIGINS=[],
    )
    def test_listed_cors_origin_clears_it(self):
        self.assertEqual(self._check(), [])

    @override_settings(DEBUG=False, ALLOWED_HOSTS=["app.example.com", "localhost", "127.0.0.1"])
    def test_exact_hosts_are_clean(self):
        self.assertEqual(self._check(), [])

    @override_settings(DEBUG=True, ALLOWED_HOSTS=["*", ".example.com"])
    def test_debug_is_quiet(self):
        self.assertEqual(self._check(), [])

    def test_default_settings_values_are_clean(self):
        # Read the shipped default out of settings.py itself (the `default=`
        # of the ALLOWED_HOSTS env.list call) so a change to it is caught.
        import ast
        from pathlib import Path

        import visiban.settings as settings_module

        tree = ast.parse(Path(settings_module.__file__).read_text())
        default = None
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Assign)
                and any(isinstance(t, ast.Name) and t.id == "ALLOWED_HOSTS" for t in node.targets)
                and isinstance(node.value, ast.Call)
            ):
                for kw in node.value.keywords:
                    if kw.arg == "default":
                        default = ast.literal_eval(kw.value)
        self.assertIsNotNone(default)
        with override_settings(DEBUG=False, ALLOWED_HOSTS=default):
            self.assertEqual(self._check(), [])

    def test_registered_under_the_security_tag(self):
        from django.core import checks

        from accounts.checks import check_wildcard_allowed_hosts as fn

        self.assertIn(fn, checks.registry.registry.get_checks(include_deployment_checks=False))
        self.assertIn(checks.Tags.security, fn.tags)
