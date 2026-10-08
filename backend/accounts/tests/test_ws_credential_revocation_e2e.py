"""Revoking a socket's credential closes it within the re-check window (#1483).

Through the real ASGI stack (session and auth middleware,
TicketAuthMiddleware, the consumer) and the real REST endpoints: an open board
or group socket closes with 4003 on the first frame past the #1477 re-check
window — or at the next keepalive ping on a quiet channel — after a logout, a
password change, or a revoked session/PAT/token, for both the cookie handshake
and the ws-ticket handshake. It does *not* close when an unrelated session of
the same user logs out.

The re-check clock is driven through ``boards.consumers._now`` and
``groups.consumers._now`` (as in the #1477 tests), stepped past the longest
jittered window before the frame that triggers the re-check.

TransactionTestCase, not TestCase: the consumer and the middleware reach the
ORM from worker threads via ``database_sync_to_async``, which cannot see a
TestCase's uncommitted transaction. ``channels.db`` closes those thread-local
connections itself, so no explicit ``connections.close_all()`` is needed (same
reasoning as ``test_ws_ticket_e2e.py``).
"""
import asyncio
from unittest.mock import patch

from asgiref.sync import sync_to_async
from channels.testing import WebsocketCommunicator
from django.conf import settings
from django.contrib.sessions.models import Session
from django.core.cache import cache
from django.test import TransactionTestCase
from rest_framework.authtoken.models import Token
from rest_framework.test import APIClient

from accounts.models import PersonalAccessToken, User
from boards.broadcast import broadcast_board_event
from boards.consumers import ACCESS_RECHECK_JITTER_SECONDS, ACCESS_RECHECK_SECONDS
from boards.models import Board, BoardMembership
from groups.broadcast import broadcast_group_event
from groups.models import Group, GroupMembership

PASSWORD = "Original-long-passphrase-1483"
NEW_PASSWORD = "Rotated-long-passphrase-1483"
SECRET = "Confidential-title-1483"
WS_TICKET_URL = "/api/v1/auth/ws-ticket/"
LOGOUT_URL = "/api/v1/auth/logout/"
CHANGE_PASSWORD_URL = "/api/v1/auth/change-password/"
DJ_REST_AUTH_PASSWORD_CHANGE_URL = "/api/v1/auth/password/change/"


class _Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class _RevocationScenarios:
    """Scenarios shared by the board and group channels; see subclasses."""

    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(username="rev_user", password=PASSWORD)
        self.clock = _Clock()
        for target in ("boards.consumers._now", "groups.consumers._now"):
            p = patch(target, self.clock)
            p.start()
            self.addCleanup(p.stop)
        self.make_channel()

    # -- credentials ------------------------------------------------------------

    def _session_client(self):
        client = APIClient()
        self.assertTrue(client.login(username="rev_user", password=PASSWORD))
        return client

    @staticmethod
    def _session_key(client):
        return client.cookies[settings.SESSION_COOKIE_NAME].value

    def _ticket(self, client, **headers):
        r = client.post(WS_TICKET_URL, **headers)
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()["ticket"]

    # -- socket helpers -----------------------------------------------------------

    async def _open_with_cookie(self, client):
        cookie = f"{settings.SESSION_COOKIE_NAME}={self._session_key(client)}".encode()
        return await self._open(self.ws_path(), headers=[(b"cookie", cookie)])

    async def _open_with_ticket(self, ticket):
        return await self._open(f"{self.ws_path()}?ticket={ticket}")

    async def _open(self, path, headers=()):
        from visiban import asgi

        comm = WebsocketCommunicator(asgi.application, path, headers=list(headers))
        connected, code = await comm.connect()
        self.assertTrue(connected, f"handshake refused with {code}")
        return comm

    async def _frame_after_window(self):
        self.clock.advance(ACCESS_RECHECK_SECONDS + ACCESS_RECHECK_JITTER_SECONDS)
        await sync_to_async(self.broadcast)()

    async def _assert_evicted(self, comm):
        await self._frame_after_window()
        out = await comm.receive_output(timeout=2)
        self.assertEqual(out, {"type": "websocket.close", "code": 4003})
        # The frame that triggered the re-check was never forwarded.
        self.assertTrue(await comm.receive_nothing(timeout=0.2))

    async def _assert_still_receiving(self, comm):
        await self._frame_after_window()
        msg = await comm.receive_json_from(timeout=2)
        self.assertIn(SECRET, str(msg))
        await comm.disconnect()

    def _run(self, coro_fn):
        asyncio.run(coro_fn())

    async def _next_non_ping(self, comm):
        """Next output that is not a keepalive ping (a frame or a close).

        Bounded: if only pings arrive (the socket was never closed), fail
        rather than drain them forever.
        """
        for _ in range(50):
            out = await comm.receive_output(timeout=2)
            if out.get("type") == "websocket.send" and '"ping"' in out.get("text", ""):
                continue
            return out
        self.fail("only keepalive pings arrived; the socket was never closed")

    # -- quiet channel: the keepalive ping runs the re-check ----------------------

    def test_quiet_socket_closes_after_logout_with_no_events(self):
        client = self._session_client()

        async def run():
            with patch(self.ping_interval_target, 0.05):
                comm = await self._open_with_cookie(client)
                r = await sync_to_async(client.post)(LOGOUT_URL)
                self.assertEqual(r.status_code, 200)
                self.clock.advance(ACCESS_RECHECK_SECONDS + ACCESS_RECHECK_JITTER_SECONDS)
                # No broadcast at all: the next ping's re-check closes it.
                out = await self._next_non_ping(comm)
                self.assertEqual(out, {"type": "websocket.close", "code": 4003})

        self._run(run)

    def test_quiet_socket_with_a_live_credential_keeps_receiving_pings(self):
        client = self._session_client()

        async def run():
            with patch(self.ping_interval_target, 0.05):
                comm = await self._open_with_cookie(client)
                self.clock.advance(ACCESS_RECHECK_SECONDS + ACCESS_RECHECK_JITTER_SECONDS)
                for _ in range(2):  # the first ping past the window re-checks
                    self.assertEqual(await comm.receive_json_from(timeout=2), {"event": "ping", "data": {}})
                await comm.disconnect()

        self._run(run)

    # -- cookie (session) handshake ---------------------------------------------

    def test_cookie_socket_closes_after_logout(self):
        client = self._session_client()

        async def run():
            comm = await self._open_with_cookie(client)
            r = await sync_to_async(client.post)(LOGOUT_URL)
            self.assertEqual(r.status_code, 200)
            await self._assert_evicted(comm)

        self._run(run)

    def test_cookie_socket_closes_after_password_change_in_the_same_session(self):
        client = self._session_client()

        async def run():
            comm = await self._open_with_cookie(client)
            r = await sync_to_async(client.post)(
                CHANGE_PASSWORD_URL, {"current_password": PASSWORD, "new_password": NEW_PASSWORD}
            )
            self.assertEqual(r.status_code, 200, r.content)
            await self._assert_evicted(comm)

        self._run(run)

    def test_cookie_socket_closes_after_password_change_from_another_session(self):
        socket_client = self._session_client()
        other_client = self._session_client()

        async def run():
            comm = await self._open_with_cookie(socket_client)
            r = await sync_to_async(other_client.post)(
                DJ_REST_AUTH_PASSWORD_CHANGE_URL,
                {"old_password": PASSWORD, "new_password1": NEW_PASSWORD, "new_password2": NEW_PASSWORD},
            )
            self.assertEqual(r.status_code, 200, r.content)
            await self._assert_evicted(comm)

        self._run(run)

    def test_cookie_socket_closes_after_its_session_is_revoked(self):
        """No session-revocation endpoint exists; deleting the row is what an
        admin, ``clearsessions`` or a future endpoint would do."""
        client = self._session_client()
        key = self._session_key(client)

        async def run():
            comm = await self._open_with_cookie(client)
            await sync_to_async(Session.objects.filter(session_key=key).delete)()
            await self._assert_evicted(comm)

        self._run(run)

    def test_cookie_socket_survives_logout_of_another_session(self):
        socket_client = self._session_client()
        other_client = self._session_client()
        self.assertNotEqual(self._session_key(socket_client), self._session_key(other_client))

        async def run():
            comm = await self._open_with_cookie(socket_client)
            r = await sync_to_async(other_client.post)(LOGOUT_URL)
            self.assertEqual(r.status_code, 200)
            await self._assert_still_receiving(comm)

        self._run(run)

    # -- ticket handshake ----------------------------------------------------------

    def test_session_ticket_socket_closes_after_that_session_logs_out(self):
        client = self._session_client()
        ticket = self._ticket(client)

        async def run():
            comm = await self._open_with_ticket(ticket)
            r = await sync_to_async(client.post)(LOGOUT_URL)
            self.assertEqual(r.status_code, 200)
            await self._assert_evicted(comm)

        self._run(run)

    def test_pat_ticket_socket_closes_after_the_pat_is_revoked(self):
        pat, raw = PersonalAccessToken.generate(self.user, "cli")
        ticket = self._ticket(APIClient(), HTTP_AUTHORIZATION=f"Token {raw}")
        manager = self._session_client()

        async def run():
            comm = await self._open_with_ticket(ticket)
            r = await sync_to_async(manager.delete)(f"/api/v1/auth/tokens/{pat.pk}/")
            self.assertEqual(r.status_code, 204, r.content)
            await self._assert_evicted(comm)

        self._run(run)

    def test_pat_ticket_socket_closes_after_a_password_change(self):
        _, raw = PersonalAccessToken.generate(self.user, "cli")
        ticket = self._ticket(APIClient(), HTTP_AUTHORIZATION=f"Token {raw}")
        client = self._session_client()

        async def run():
            comm = await self._open_with_ticket(ticket)
            r = await sync_to_async(client.post)(
                CHANGE_PASSWORD_URL, {"current_password": PASSWORD, "new_password": NEW_PASSWORD}
            )
            self.assertEqual(r.status_code, 200, r.content)
            await self._assert_evicted(comm)

        self._run(run)

    def test_pat_ticket_socket_survives_an_unrelated_session_logout(self):
        _, raw = PersonalAccessToken.generate(self.user, "cli")
        ticket = self._ticket(APIClient(), HTTP_AUTHORIZATION=f"Token {raw}")
        client = self._session_client()

        async def run():
            comm = await self._open_with_ticket(ticket)
            r = await sync_to_async(client.post)(LOGOUT_URL)
            self.assertEqual(r.status_code, 200)
            await self._assert_still_receiving(comm)

        self._run(run)

    def test_drf_token_ticket_socket_closes_after_token_logout(self):
        token = Token.objects.create(user=self.user)
        token_client = APIClient()
        token_client.credentials(HTTP_AUTHORIZATION=f"Token {token.key}")
        ticket = self._ticket(token_client)

        async def run():
            comm = await self._open_with_ticket(ticket)
            r = await sync_to_async(token_client.post)(LOGOUT_URL)
            self.assertEqual(r.status_code, 200)
            await self._assert_evicted(comm)

        self._run(run)

    def test_drf_token_ticket_socket_closes_after_a_password_change(self):
        """The DRF token itself survives a password change; the socket does not."""
        token = Token.objects.create(user=self.user)
        token_client = APIClient()
        token_client.credentials(HTTP_AUTHORIZATION=f"Token {token.key}")
        ticket = self._ticket(token_client)
        client = self._session_client()

        async def run():
            comm = await self._open_with_ticket(ticket)
            r = await sync_to_async(client.post)(
                CHANGE_PASSWORD_URL, {"current_password": PASSWORD, "new_password": NEW_PASSWORD}
            )
            self.assertEqual(r.status_code, 200, r.content)
            await self._assert_evicted(comm)

        self._run(run)


class BoardSocketCredentialRevocationTests(_RevocationScenarios, TransactionTestCase):
    ping_interval_target = "boards.consumers.PING_INTERVAL"

    def make_channel(self):
        self.board = Board.objects.create(name="Revocation board", owner=self.user)
        BoardMembership.objects.create(board=self.board, user=self.user, role=BoardMembership.Role.ADMIN)

    def ws_path(self):
        return f"/ws/boards/{self.board.id}/"

    def broadcast(self):
        broadcast_board_event(self.board.id, "card.updated", {"id": 1, "title": SECRET})


class GroupSocketCredentialRevocationTests(_RevocationScenarios, TransactionTestCase):
    ping_interval_target = "groups.consumers.PING_INTERVAL"

    def make_channel(self):
        self.group = Group.objects.create(name="Revocation group", owner=self.user)
        GroupMembership.objects.create(group=self.group, user=self.user, role=GroupMembership.Role.ADMIN)

    def ws_path(self):
        return f"/ws/groups/{self.group.id}/"

    def broadcast(self):
        broadcast_group_event(self.group.id, "board.updated", {"id": 1, "name": SECRET})
