"""Handshake refusals reach a real client with their code (#2145).

Daphne answers a close sent before accept with HTTP 403, whatever the code
(``daphne.ws_protocol.WebSocketProtocol.serverReject``), so while the board
and group consumers refused before accept, no browser ever saw 4001 or 4003:
it saw a failed upgrade (1006) and the web app reconnected every 3 s. The
ASGI ``WebsocketCommunicator`` cannot show this, it reports the application's
close message whatever the server would do with it. These tests therefore run
``visiban.asgi.application`` under Daphne itself and read the wire with a
minimal WebSocket client (``DaphneHandshakeRefusalTests``). The communicator
tests below them pin what the fix must not give up, through the same real
ASGI stack: a refused socket joins no channel-layer group and carries no frame
between the accept and the close, and its disconnect() is clean.

Why fork: the Daphne process must see this test's rows. With a forked child
it inherits the test database (the in-memory SQLite one locally, through its
shared cache; the committed rows of a ``TransactionTestCase`` on PostgreSQL)
and the in-process cache and channel layer the test settings select. A
spawned child would re-read settings without pytest loaded and point at
Redis. Daphne's own test helper (``daphne.testing.DaphneProcess``) is built
for a forked child, including the reactor reinstall macOS needs.

The Daphne tests start no threads in this process, so CLAUDE.md's
``connections.close_all()`` rule does not apply; the child's connections die
with it (``terminate``), and the child never closes the connections it
inherited, which are the parent's.
"""

import asyncio
import base64
import multiprocessing
import secrets
import socket
import struct
import warnings
from unittest import skipUnless

from channels.layers import get_channel_layer
from channels.testing import WebsocketCommunicator
from django.conf import settings
from django.core.cache import cache
from django.test import SimpleTestCase, TransactionTestCase

from accounts.models import User
from accounts.tests.ws_helpers import login_session, session_ticket
from accounts.ws_auth import refuse_handshake
from boards.models import Board, BoardMembership
from groups.models import Group, GroupMembership

_FORK_AVAILABLE = "fork" in multiprocessing.get_all_start_methods()

# How long to wait for Daphne, and for a frame, before failing the test.
_TIMEOUT = 10
# How long an admitted socket must stay open, unclosed, to count as admitted.
_ADMITTED_QUIET_SECONDS = 0.5


def _child_setup():
    """Run in the forked Daphne child before it serves (see module docstring).

    The child inherits this process's objects but not its threads. Two of
    them would otherwise wedge or corrupt it:

    - asgiref's single thread-sensitive executor thinks it still has an idle
      worker (the parent's thread, which does not exist here), so every
      ``database_sync_to_async`` call would queue forever. Give it a new one.
    - Django's per-thread connections for this thread are the parent's open
      sockets (PostgreSQL). The child must never use or close them, so the
      handler gets a fresh store; the old objects stay referenced so nothing
      finalizes them, which also keeps SQLite's shared in-memory database
      alive in the child.
    """
    from concurrent.futures import ThreadPoolExecutor

    from asgiref.local import Local
    from asgiref.sync import SyncToAsync
    from django.db import connections

    SyncToAsync.single_thread_executor = ThreadPoolExecutor(max_workers=1)
    _child_setup.inherited = [connections[alias] for alias in connections]
    connections._connections = Local(connections.thread_critical)


def _start_daphne():
    from daphne.testing import DaphneProcess

    from visiban import asgi

    fork = multiprocessing.get_context("fork")

    class ForkedDaphneProcess(DaphneProcess):
        @staticmethod
        def _Popen(process_obj):
            return fork.Process._Popen(process_obj)

    process = ForkedDaphneProcess("127.0.0.1", lambda: asgi.application, setup=_child_setup)
    with warnings.catch_warnings():
        # Python warns that forking a multi-threaded process can deadlock the
        # child. The parent's threads here are idle executor workers, which
        # hold no lock while they wait, and _child_setup replaces the one
        # executor the child would use; a wedged child would fail the
        # startup wait or the socket timeout below, not hang the run.
        warnings.filterwarnings("ignore", "This process .* is multi-threaded", DeprecationWarning)
        process.start()
    if not process.ready.wait(_TIMEOUT):
        process.terminate()
        process.join()
        raise RuntimeError("Daphne did not start")
    return process


def _recv_exact(sock, size):
    data = b""
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk:
            raise ConnectionError("connection closed mid-frame")
        data += chunk
    return data


def _read_frame(sock):
    """One server frame as (opcode, payload). Server frames are never masked."""
    first, second = _recv_exact(sock, 2)
    opcode = first & 0x0F
    length = second & 0x7F
    if length == 126:
        (length,) = struct.unpack("!H", _recv_exact(sock, 2))
    elif length == 127:
        (length,) = struct.unpack("!Q", _recv_exact(sock, 8))
    return opcode, _recv_exact(sock, length)


def _handshake(port, path, session_key=None):
    """Open *path* like a browser would; return what the client observed.

    ``("http", status)`` when the upgrade was refused, ``("closed", code,
    frames)`` when the socket opened and the server then closed it, with every
    data frame received before the close, and ``("open", None, frames)`` when
    it opened and stayed open.
    """
    sock = socket.create_connection(("127.0.0.1", port), timeout=_TIMEOUT)
    try:
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        lines = [
            f"GET {path} HTTP/1.1",
            f"Host: 127.0.0.1:{port}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Key: {key}",
            "Sec-WebSocket-Version: 13",
        ]
        if session_key:
            lines.append(f"Cookie: {settings.SESSION_COOKIE_NAME}={session_key}")
        sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())

        head = b""
        while b"\r\n\r\n" not in head:
            chunk = sock.recv(1)
            if not chunk:
                raise ConnectionError(f"connection closed during the handshake: {head!r}")
            head += chunk
        status = int(head.split(b" ", 2)[1])
        if status != 101:
            return ("http", status)

        frames = []
        sock.settimeout(_ADMITTED_QUIET_SECONDS)
        while True:
            try:
                opcode, payload = _read_frame(sock)
            except socket.timeout:
                return ("open", None, frames)
            if opcode == 0x8:
                code = struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else None
                return ("closed", code, frames)
            frames.append((opcode, payload))
    finally:
        sock.close()


@skipUnless(_FORK_AVAILABLE, "needs the fork start method to share the test database with Daphne")
class DaphneHandshakeRefusalTests(TransactionTestCase):
    """Every consumer refusal reaches the client as a close frame with its code."""

    def setUp(self):
        cache.clear()
        self.member = User.objects.create_user(username="daphne_member", password="pass")
        self.outsider = User.objects.create_user(username="daphne_outsider", password="pass")
        self.pending = User.objects.create_user(username="daphne_pending", password="pass")
        self.board = Board.objects.create(name="Daphne board", owner=self.member)
        BoardMembership.objects.create(
            board=self.board, user=self.member, role=BoardMembership.Role.ADMIN
        )
        BoardMembership.objects.create(
            board=self.board, user=self.pending, role=BoardMembership.Role.ADMIN
        )
        self.group = Group.objects.create(name="Daphne group", owner=self.member)
        for user in (self.member, self.pending):
            GroupMembership.objects.create(
                group=self.group, user=user, role=GroupMembership.Role.ADMIN
            )
        self.keys = {
            "member": login_session(self.member),
            "outsider": login_session(self.outsider),
            "pending": login_session(self.pending),
        }
        # A forced password change set after login: the session stays valid,
        # so this is the account-state gate (4003), not a dead credential.
        self.pending.must_change_password = True
        self.pending.save(update_fields=["must_change_password"])
        self.ticket_board_outsider, _ = session_ticket(self.outsider, self.keys["outsider"])
        # Rows must exist before the fork: the child sees the database as of now.
        self.daphne = _start_daphne()
        self.port = self.daphne.port.value

    def tearDown(self):
        self.daphne.terminate()
        self.daphne.join(_TIMEOUT)
        if self.daphne.is_alive():  # pragma: no cover — only if SIGTERM is ignored
            self.daphne.kill()
            self.daphne.join(_TIMEOUT)

    def _paths(self):
        return {
            "board": f"/ws/boards/{self.board.id}/",
            "group": f"/ws/groups/{self.group.id}/",
        }

    def assert_refused_with(self, outcome, code):
        """Opened, then closed with *code*, with no frame before the close."""
        self.assertEqual(outcome[0], "closed", f"expected a close frame, got {outcome!r}")
        self.assertEqual(outcome[1], code)
        self.assertEqual(outcome[2], [], "a refused socket must carry no frame")

    def test_no_credential_closes_4001(self):
        for name, path in self._paths().items():
            with self.subTest(channel=name):
                self.assert_refused_with(_handshake(self.port, path), 4001)

    def test_dead_session_cookie_closes_4001(self):
        for name, path in self._paths().items():
            with self.subTest(channel=name):
                self.assert_refused_with(_handshake(self.port, path, "not-a-session"), 4001)

    def test_non_member_closes_4003(self):
        for name, path in self._paths().items():
            with self.subTest(channel=name):
                self.assert_refused_with(
                    _handshake(self.port, path, self.keys["outsider"]), 4003
                )

    def test_non_member_on_a_ticket_handshake_closes_4003(self):
        path = f"{self._paths()['board']}?ticket={self.ticket_board_outsider}"
        self.assert_refused_with(_handshake(self.port, path), 4003)

    def test_pending_account_change_closes_4003(self):
        for name, path in self._paths().items():
            with self.subTest(channel=name):
                self.assert_refused_with(
                    _handshake(self.port, path, self.keys["pending"]), 4003
                )

    def test_member_is_admitted_and_stays_open(self):
        """Positive control: the harness can tell an admitted socket apart."""
        for name, path in self._paths().items():
            with self.subTest(channel=name):
                outcome = _handshake(self.port, path, self.keys["member"])
                self.assertEqual(outcome, ("open", None, []))


class RefusedSocketCarriesNothingTests(TransactionTestCase):
    """Never fail open (#2145): a refusal is the accept and the close, nothing
    else, through ``visiban.asgi.application`` (TransactionTestCase: the
    consumers reach the ORM from a worker thread, see test_ws_ticket_e2e.py)."""

    def setUp(self):
        cache.clear()
        self.member = User.objects.create_user(username="refusal_member", password="pass")
        self.outsider = User.objects.create_user(username="refusal_outsider", password="pass")
        self.board = Board.objects.create(name="Refusal board", owner=self.member)
        BoardMembership.objects.create(
            board=self.board, user=self.member, role=BoardMembership.Role.ADMIN
        )
        self.group = Group.objects.create(name="Refusal group", owner=self.member)
        GroupMembership.objects.create(
            group=self.group, user=self.member, role=GroupMembership.Role.ADMIN
        )
        self.channels = {
            "board": (f"/ws/boards/{self.board.id}/", f"board_{self.board.id}"),
            "group": (f"/ws/groups/{self.group.id}/", f"group_{self.group.id}"),
        }

    def _messages(self, path, session_key=None):
        """Every message the application sends for one handshake, then whether
        the room held a channel once it had answered and after disconnect."""
        from visiban import asgi

        headers = []
        if session_key:
            headers.append((b"cookie", f"{settings.SESSION_COOKIE_NAME}={session_key}".encode()))
        room = next(room for p, room in self.channels.values() if p == path)

        async def run():
            layer = get_channel_layer()
            communicator = WebsocketCommunicator(asgi.application, path, headers=headers)
            await communicator.send_input({"type": "websocket.connect"})
            messages = [await communicator.receive_output(timeout=2)]
            while not await communicator.receive_nothing(timeout=0.2):
                messages.append(await communicator.receive_output(timeout=2))
            joined = bool(layer.groups.get(room))
            # Daphne sends this after the close handshake; disconnect() must
            # then run cleanly (a raise would surface from wait()).
            await communicator.disconnect()
            return messages, joined, bool(layer.groups.get(room))

        return asyncio.run(run())

    def test_refusals_send_only_accept_and_close_and_join_nothing(self):
        cases = {
            "no credential": (None, 4001),
            "non-member": (login_session(self.outsider), 4003),
        }
        for channel, (path, _) in self.channels.items():
            for label, (key, code) in cases.items():
                with self.subTest(channel=channel, case=label):
                    messages, joined, still_joined = self._messages(path, key)
                    self.assertEqual(
                        messages,
                        [
                            {"type": "websocket.accept", "subprotocol": None},
                            {"type": "websocket.close", "code": code},
                        ],
                    )
                    self.assertFalse(joined)
                    self.assertFalse(still_joined)

    def test_admitted_socket_joins_its_room_and_leaves_on_disconnect(self):
        """Positive control for the checks above."""
        key = login_session(self.member)
        for channel, (path, _) in self.channels.items():
            with self.subTest(channel=channel):
                messages, joined, still_joined = self._messages(path, key)
                self.assertEqual([m["type"] for m in messages], ["websocket.accept"])
                self.assertTrue(joined)
                self.assertFalse(still_joined)


class RefuseHandshakeCodeTests(SimpleTestCase):
    def test_only_application_codes_are_sent_after_accept(self):
        """1000-3999 never: autobahn refuses 1011 in a server close (#2142),
        and an outage refusal belongs before accept anyway."""

        class Consumer:
            accepted = False

            async def accept(self):
                self.accepted = True

            async def close(self, code=None):  # pragma: no cover — must not be reached
                raise AssertionError("closed")

        for code in (1000, 1011, 3999, 5000):
            with self.subTest(code=code):
                consumer = Consumer()
                with self.assertRaises(ValueError):
                    asyncio.run(refuse_handshake(consumer, code))
                self.assertFalse(consumer.accepted)
