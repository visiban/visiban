"""A frame-path re-check failure closes cleanly under Daphne (#2142).

When the access re-check on a forwarded frame raises (a database outage, say),
the board and group consumers close the socket with a reconnectable code
rather than the final 4003 (#2003). That code used to be the standard 1011,
but Daphne passes a server close through autobahn, which accepts only 1000
and 3000-4999 there: ``close(code=1011)`` raised inside the consumer, Daphne's
crash handler sent 1011 itself and logged an ERROR traceback, and
``disconnect()`` never ran, so the channel-layer group kept the dead channel
and the keepalive ping task was never canceled. The consumers now close with
``CLOSE_ACCESS_CHECK_FAILED`` (4503).

``WebsocketCommunicator`` cannot show any of this: it accepts any close code.
These tests serve ``visiban.asgi.application`` from a forked Daphne child (the
harness in ``accounts/tests/test_ws_handshake_refusal.py``, whose docstring
explains the fork) and read the wire with the same minimal client. Patches
started before the fork are inherited by the child:

- the access re-check raises, so the first forwarded frame closes the socket;
- ``connect()`` sends one frame to its own room once admitted, so the test
  needs no REST write to make the re-check run;
- ``disconnect()`` records, in shared memory, that it ran, whether the ping
  task was canceled and whether the room still holds the channel;
- the child counts ERROR log records (Daphne's "Exception inside
  application").

``test_control_1011_crashes`` pins the old code to show the harness sees the
bug: without it, a check that never fires would pass for the wrong reason.

No threads are started in this process (see the harness docstring), so
CLAUDE.md's ``connections.close_all()`` rule does not apply.
"""
import logging
import multiprocessing
from unittest import mock, skipUnless

from django.core.cache import cache
from django.db import OperationalError
from django.test import SimpleTestCase, TransactionTestCase

from accounts.models import User
from accounts.tests.test_ws_handshake_refusal import (
    _FORK_AVAILABLE,
    _TIMEOUT,
    _child_setup,
    _handshake,
    _start_daphne,
)
from accounts.tests.ws_helpers import login_session
from boards import consumers as board_consumers
from boards.consumers import (
    CLOSE_ACCESS_CHECK_FAILED,
    CLOSE_ACCESS_DENIED,
    CLOSE_NO_CREDENTIAL,
    BoardConsumer,
)
from boards.models import Board, BoardMembership
from groups import consumers as group_consumers
from groups.consumers import GroupConsumer
from groups.models import Group, GroupMembership

# Long enough for Daphne's application checker (it runs once a second) to
# notice a crashed consumer and send its own 1011, so the control test sees
# that close rather than timing out first.
_CLOSE_WAIT_SECONDS = 3


def _autobahn_accepts(code):
    """autobahn's rule for a server close code (WebSocketProtocol.sendClose)."""
    return code == 1000 or 3000 <= code <= 4999


class CloseCodeRangeTests(SimpleTestCase):
    def test_every_post_accept_close_code_is_one_daphne_can_send(self):
        """Every code a consumer sends after accept passes autobahn's check.

        Runs where the fork-based Daphne tests below are skipped too."""
        for code in (CLOSE_ACCESS_CHECK_FAILED, CLOSE_ACCESS_DENIED, CLOSE_NO_CREDENTIAL):
            with self.subTest(code=code):
                self.assertTrue(_autobahn_accepts(code))
        self.assertFalse(_autobahn_accepts(1011))  # why 4503, not 1011

    def test_group_consumer_shares_the_board_codes(self):
        self.assertEqual(group_consumers.CLOSE_ACCESS_CHECK_FAILED, CLOSE_ACCESS_CHECK_FAILED)
        self.assertEqual(CLOSE_ACCESS_CHECK_FAILED, 4503)


@skipUnless(_FORK_AVAILABLE, "needs the fork start method to share the test database with Daphne")
class DaphneFramePathCloseTests(TransactionTestCase):
    def setUp(self):
        cache.clear()
        self.member = User.objects.create_user(username="frame_close_member", password="pass")
        self.board = Board.objects.create(name="Frame close board", owner=self.member)
        BoardMembership.objects.create(
            board=self.board, user=self.member, role=BoardMembership.Role.ADMIN
        )
        self.group = Group.objects.create(name="Frame close group", owner=self.member)
        GroupMembership.objects.create(
            group=self.group, user=self.member, role=GroupMembership.Role.ADMIN
        )
        self.key = login_session(self.member)
        fork = multiprocessing.get_context("fork")
        self.errors = fork.Value("i", 0)
        self.ping_canceled = fork.Value("i", 0)
        self.still_joined = fork.Value("i", 1)
        self.disconnected = fork.Event()
        self.daphne = None

    def tearDown(self):
        if self.daphne is None:
            return
        self.daphne.terminate()
        self.daphne.join(_TIMEOUT)
        if self.daphne.is_alive():  # pragma: no cover — only if SIGTERM is ignored
            self.daphne.kill()
            self.daphne.join(_TIMEOUT)

    def _patch(self, *args, **kwargs):
        patcher = mock.patch.object(*args, **kwargs)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _instrument(self, consumer_class, handler_type, event):
        """Make *consumer_class*'s re-check raise and record its disconnect()."""
        self._patch(
            consumer_class,
            "_check_access",
            new=mock.AsyncMock(side_effect=OperationalError("db host secret-detail")),
        )
        connect, disconnect = consumer_class.connect, consumer_class.disconnect
        test = self

        async def connect_then_frame(consumer):
            await connect(consumer)
            if consumer._joined:
                # Delivered after connect() returns: consumers handle one
                # message at a time.
                await consumer.channel_layer.group_send(
                    consumer.room, {"type": handler_type, "payload": {"event": event, "data": {}}}
                )

        async def recording_disconnect(consumer, close_code):
            task = consumer._ping_task
            await disconnect(consumer, close_code)
            test.ping_canceled.value = int(
                task is not None and (task.cancelling() > 0 or task.cancelled())
            )
            groups = getattr(consumer.channel_layer, "groups", {})
            test.still_joined.value = int(consumer.channel_name in groups.get(consumer.room, {}))
            test.disconnected.set()

        self._patch(consumer_class, "connect", new=connect_then_frame)
        self._patch(consumer_class, "disconnect", new=recording_disconnect)

    def _serve(self):
        errors = self.errors

        class CountErrors(logging.Handler):
            def emit(self, record):
                with errors.get_lock():
                    errors.value += 1

        def setup():
            _child_setup()
            logging.getLogger().addHandler(CountErrors(level=logging.ERROR))

        # Rows and patches must exist before the fork: the child sees them as of now.
        self.daphne = _start_daphne(setup=setup)
        return self.daphne.port.value

    def _channels(self):
        return {
            "board": (
                BoardConsumer, "board.event", "card.updated", f"/ws/boards/{self.board.id}/",
            ),
            "group": (
                GroupConsumer, "group.event", "group.updated", f"/ws/groups/{self.group.id}/",
            ),
        }

    def _assert_clean_close(self, channel):
        consumer_class, handler_type, event, path = self._channels()[channel]
        self._instrument(consumer_class, handler_type, event)
        port = self._serve()

        outcome = _handshake(port, path, self.key, quiet=_CLOSE_WAIT_SECONDS)

        # Daphne's crash handler would send 1011; 4503 arriving proves the
        # consumer's own close went through. The frame is not forwarded.
        self.assertEqual(outcome, ("closed", CLOSE_ACCESS_CHECK_FAILED, []))
        self.assertTrue(self.disconnected.wait(_TIMEOUT), "disconnect() never ran")
        self.assertEqual(self.ping_canceled.value, 1, "the ping task was not canceled")
        self.assertEqual(self.still_joined.value, 0, "the room still holds the channel")
        self.assertEqual(self.errors.value, 0, "the server logged an ERROR")

    def test_board_recheck_failure_closes_4503_and_runs_disconnect(self):
        self._assert_clean_close("board")

    def test_group_recheck_failure_closes_4503_and_runs_disconnect(self):
        self._assert_clean_close("group")

    def test_control_1011_crashes(self):
        """The bug this file guards against, reproduced with the old code."""
        self._patch(board_consumers, "CLOSE_ACCESS_CHECK_FAILED", new=1011)
        consumer_class, handler_type, event, path = self._channels()["board"]
        self._instrument(consumer_class, handler_type, event)
        port = self._serve()

        outcome = _handshake(port, path, self.key, quiet=_CLOSE_WAIT_SECONDS)

        self.assertEqual(outcome, ("closed", 1011, []))  # sent by Daphne's crash handler
        self.assertFalse(self.disconnected.wait(1), "disconnect() ran after a crash")
        self.assertGreater(self.errors.value, 0)
