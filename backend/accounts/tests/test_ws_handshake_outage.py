"""A backend outage at the WebSocket handshake is a reconnectable 1011 (#2086).

#2014 made the frame-path re-check report a cache-only session outage as
1011 instead of the final 4003. These cover the handshake itself, through the
real ASGI stack (``visiban.asgi.application``):

- cookie handshake: Channels' ``AuthMiddleware`` reads the session through the
  cache engine's ``load()``, which swallows the outage and yields an anonymous
  user. It must close 1011, not 4001 (the web app signs the user out on 4001).
- ticket handshake: an exception while redeeming used to escape
  ``TicketAuthMiddleware``. It must close 1011, and the ticket stays spent.
- never fail open: an absent or expired session, or a spent ticket, still
  closes 4001 with the cache healthy.

TransactionTestCase: the middleware and the consumer reach the ORM from a
worker thread through ``database_sync_to_async`` (see test_ws_ticket_e2e.py).
"""

import asyncio
from importlib import import_module
from unittest.mock import patch

from channels.testing import WebsocketCommunicator
from django.conf import settings
from django.core.cache import cache
from django.db import OperationalError
from django.test import TransactionTestCase, override_settings

from accounts.models import User
from accounts.tests.ws_cache_engine import OWN_CACHE
from accounts.tests.ws_helpers import login_session, session_ticket
from accounts.ws_auth import CLOSE_AUTH_UNAVAILABLE, _ticket_cache_key
from boards.models import Board, BoardMembership
from groups.models import Group, GroupMembership

CACHE_ENGINE = "django.contrib.sessions.backends.cache"
OWN_CACHE_ENGINE = "accounts.tests.ws_cache_engine"
LOCMEM_GET = "django.core.cache.backends.locmem.LocMemCache.get"


def _connect(path, session_key=None):
    """Open *path* against the real ASGI app; return (accepted, close_code)."""
    from visiban import asgi

    headers = []
    if session_key:
        headers.append(
            (b"cookie", f"{settings.SESSION_COOKIE_NAME}={session_key}".encode())
        )

    async def run():
        communicator = WebsocketCommunicator(asgi.application, path, headers=headers)
        connected, detail = await communicator.connect()
        if connected:
            await communicator.disconnect()
            return True, None
        return False, detail

    return asyncio.run(run())


class _HandshakeOutageBase(TransactionTestCase):
    def setUp(self):
        cache.clear()
        OWN_CACHE.clear()
        self.user = User.objects.create_user(username="outage_member", password="pass")
        self.board = Board.objects.create(name="Outage board", owner=self.user)
        BoardMembership.objects.create(
            board=self.board, user=self.user, role=BoardMembership.Role.ADMIN
        )
        self.path = f"/ws/boards/{self.board.id}/"


@override_settings(SESSION_ENGINE=CACHE_ENGINE)
class CookieHandshakeOutageTests(_HandshakeOutageBase):
    def test_live_cache_session_connects(self):
        accepted, _ = _connect(self.path, login_session(self.user))
        self.assertTrue(accepted)

    def test_cache_outage_closes_1011_not_4001(self):
        key = login_session(self.user)
        with patch(
            LOCMEM_GET, side_effect=ConnectionError("cache down at redis://secret-host")
        ):
            with self.assertLogs("accounts.ws_auth", level="WARNING") as logs:
                accepted, code = _connect(self.path, key)
        self.assertFalse(accepted)
        self.assertEqual(code, CLOSE_AUTH_UNAVAILABLE)
        self.assertEqual(code, 1011)
        # No exception message (connection details) and no session key.
        joined = "\n".join(logs.output)
        self.assertNotIn("secret-host", joined)
        self.assertNotIn(key, joined)

    def test_cache_outage_on_the_group_channel_closes_1011(self):
        """Refused in the auth middleware, before routing: every consumer agrees."""
        group = Group.objects.create(name="Outage group", owner=self.user)
        GroupMembership.objects.create(
            group=group, user=self.user, role=GroupMembership.Role.ADMIN
        )
        key = login_session(self.user)
        with patch(LOCMEM_GET, side_effect=ConnectionError("cache down")):
            accepted, code = _connect(f"/ws/groups/{group.id}/", key)
        self.assertFalse(accepted)
        self.assertEqual(code, 1011)

    def test_absent_session_still_closes_4001(self):
        """Never fail open: a session the healthy cache does not have is a 4001."""
        key = login_session(self.user)
        import_module(CACHE_ENGINE).SessionStore(session_key=key).delete()
        accepted, code = _connect(self.path, key)
        self.assertFalse(accepted)
        self.assertEqual(code, 4001)

    def test_session_rejected_for_a_changed_password_still_closes_4001(self):
        """Present in the cache but no longer valid: the probe reads it and
        reports no outage, so the handshake is the ordinary 4001."""
        key = login_session(self.user)
        self.user.set_password("changed-pass")
        self.user.save(update_fields=["password"])
        accepted, code = _connect(self.path, key)
        self.assertFalse(accepted)
        self.assertEqual(code, 4001)

    def test_no_cookie_closes_4001_without_probing(self):
        with patch("accounts.ws_auth._read_cache_session") as probe:
            accepted, code = _connect(self.path)
        self.assertFalse(accepted)
        self.assertEqual(code, 4001)
        probe.assert_not_called()

    def test_malformed_cookie_closes_4001(self):
        """A key Django refuses as a session key is not looked up at all."""
        accepted, code = _connect(self.path, "short")
        self.assertFalse(accepted)
        self.assertEqual(code, 4001)

    def test_authenticated_handshake_does_not_probe(self):
        with patch("accounts.ws_auth._read_cache_session") as probe:
            accepted, _ = _connect(self.path, login_session(self.user))
        self.assertTrue(accepted)
        probe.assert_not_called()


class CookieHandshakeDatabaseEngineTests(_HandshakeOutageBase):
    """The default ``db`` engine's handshake is unchanged: no extra read."""

    def test_absent_db_session_closes_4001_without_probing(self):
        with patch("accounts.ws_auth._read_cache_session") as probe:
            accepted, code = _connect(self.path, "x" * 32)
        self.assertFalse(accepted)
        self.assertEqual(code, 4001)
        probe.assert_not_called()


@override_settings(SESSION_ENGINE=OWN_CACHE_ENGINE)
class TicketHandshakeOutageTests(_HandshakeOutageBase):
    """Ticket redemption. The session engine keeps its sessions in OWN_CACHE,
    so a session-cache outage can be simulated while the ticket cache (the
    default alias) stays up."""

    def test_session_cache_outage_closes_1011_and_spends_the_ticket(self):
        ticket, _ = session_ticket(self.user)
        with patch.object(
            OWN_CACHE,
            "get",
            side_effect=ConnectionError("cache down at redis://secret-host"),
        ):
            with self.assertLogs("accounts.ws_auth", level="WARNING") as logs:
                accepted, code = _connect(f"{self.path}?ticket={ticket}")
        self.assertFalse(accepted)
        self.assertEqual(code, 1011)
        joined = "\n".join(logs.output)
        self.assertNotIn("secret-host", joined)
        self.assertNotIn(ticket, joined)
        # Single use is decided at the claim, not by whether the later check
        # completed: the ticket is gone, and replaying it after recovery is
        # the ordinary 4001.
        self.assertIsNone(cache.get(_ticket_cache_key(ticket)))
        accepted, code = _connect(f"{self.path}?ticket={ticket}")
        self.assertFalse(accepted)
        self.assertEqual(code, 4001)

    def test_retry_with_a_fresh_ticket_succeeds_after_recovery(self):
        key = login_session(self.user)
        ticket, _ = session_ticket(self.user, key)
        with patch.object(OWN_CACHE, "get", side_effect=ConnectionError("cache down")):
            self.assertEqual(_connect(f"{self.path}?ticket={ticket}"), (False, 1011))
        fresh, _ = session_ticket(self.user, key)
        accepted, _ = _connect(f"{self.path}?ticket={fresh}")
        self.assertTrue(accepted)

    def test_ticket_cache_outage_closes_1011(self):
        ticket, _ = session_ticket(self.user)
        with patch("accounts.ws_auth.cache") as ticket_cache:
            ticket_cache.get.side_effect = ConnectionError("cache down")
            accepted, code = _connect(f"{self.path}?ticket={ticket}")
        self.assertFalse(accepted)
        self.assertEqual(code, 1011)

    def test_database_outage_during_redemption_closes_1011(self):
        ticket, _ = session_ticket(self.user)
        with patch(
            "accounts.ws_auth._credential_ref_is_live",
            side_effect=OperationalError("db down"),
        ):
            accepted, code = _connect(f"{self.path}?ticket={ticket}")
        self.assertFalse(accepted)
        self.assertEqual(code, 1011)

    def test_ticket_whose_session_is_absent_still_closes_4001(self):
        """Never fail open: a logged-out minting session is a denial, not an outage."""
        key = login_session(self.user)
        ticket, _ = session_ticket(self.user, key)
        import_module(OWN_CACHE_ENGINE).SessionStore(session_key=key).delete()
        accepted, code = _connect(f"{self.path}?ticket={ticket}")
        self.assertFalse(accepted)
        self.assertEqual(code, 4001)

    def test_live_ticket_connects(self):
        ticket, _ = session_ticket(self.user)
        accepted, _ = _connect(f"{self.path}?ticket={ticket}")
        self.assertTrue(accepted)
