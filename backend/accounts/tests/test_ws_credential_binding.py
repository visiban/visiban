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
