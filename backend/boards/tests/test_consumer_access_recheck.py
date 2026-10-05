"""BoardConsumer re-verifies access instead of trusting one member.removed frame (#1477).

Before #1477 a removed member's board socket was closed only when that consumer
received the ``member.removed`` frame. The publish is best-effort since #1462 —
a channel-layer error is logged and swallowed — so a lost frame left the socket
open, still streaming card titles and descriptions to a user with no access.
The consumer now re-checks access (cached for ``ACCESS_RECHECK_SECONDS``) before
it forwards any frame, and closes with ``4003`` when the check fails.

The clock is driven through ``boards.consumers._now`` rather than by sleeping or
patching ``time.monotonic`` (which the event loop reads too).

TransactionTestCase, not TestCase: the consumer reaches the ORM from a worker
thread via ``database_sync_to_async``, which cannot see a TestCase's
uncommitted transaction. ``channels.db`` closes that thread-local connection
itself (``close_old_connections`` in a ``finally``), so no explicit
``connections.close_all()`` is needed — the same reasoning as
``accounts/tests/test_ws_ticket_e2e.py``.
"""
import asyncio
import json
from unittest.mock import AsyncMock, patch

from asgiref.sync import sync_to_async
from channels.layers import get_channel_layer
from channels.testing import WebsocketCommunicator
from django.core.cache import cache
from django.test import TransactionTestCase
from rest_framework.test import APIClient

from accounts.models import User
from accounts.ws_auth import issue_ws_ticket
from boards.broadcast import broadcast_board_event
from boards.consumers import ACCESS_RECHECK_SECONDS, BoardConsumer
from boards.models import Board, BoardMembership
from groups.models import Group, GroupMembership

SECRET = "Confidential-card-title-1477"


class _Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def _card_frame():
    return {"event": "card.updated", "data": {"id": 1, "title": SECRET}}


class BoardConsumerAccessRecheckUnitTests(TransactionTestCase):
    """Drive ``board_event`` directly against real DB rows."""

    def setUp(self):
        self.owner = User.objects.create_user(username="ar_owner", password="pass")
        self.board = Board.objects.create(name="Access recheck", owner=self.owner)
        self.subscriber = User.objects.create_user(username="ar_sub", password="pass")
        self.membership = BoardMembership.objects.create(
            board=self.board, user=self.subscriber, role=BoardMembership.Role.MEMBER
        )
        self.clock = _Clock()
        p = patch("boards.consumers._now", self.clock)
        p.start()
        self.addCleanup(p.stop)

    def _consumer(self, *, verified=True):
        consumer = BoardConsumer()
        consumer.board_id = self.board.id
        consumer.room = f"board_{self.board.id}"
        consumer.channel_name = "test-channel"
        consumer.channel_layer = AsyncMock()
        consumer.send = AsyncMock()
        consumer.close = AsyncMock()
        consumer.scope = {
            "url_route": {"kwargs": {"board_id": self.board.id}},
            "user": User.objects.get(pk=self.subscriber.pk),
        }
        consumer._role = "member"
        if verified:
            consumer._access_verified_at = self.clock()
        return consumer

    def _deliver(self, consumer, payload):
        consumer.send.reset_mock()
        asyncio.run(consumer.board_event({"payload": payload}))
        if not consumer.send.called:
            return None
        return json.loads(consumer.send.call_args.kwargs["text_data"])

    def test_removed_member_is_evicted_on_the_next_frame_after_the_window(self):
        """The issue's scenario: membership gone, member.removed never arrived."""
        consumer = self._consumer()
        self.membership.delete()
        self.clock.advance(ACCESS_RECHECK_SECONDS)

        self.assertIsNone(self._deliver(consumer, _card_frame()))
        consumer.close.assert_called_once_with(code=4003)
        self.assertIsNone(consumer._role)

    def test_window_bounds_the_recheck_cost(self):
        """Within the window frames are forwarded with no access query at all."""
        consumer = self._consumer()
        consumer._refresh_role = AsyncMock(return_value="member")
        self.clock.advance(ACCESS_RECHECK_SECONDS - 0.01)

        for _ in range(5):
            self.assertEqual(self._deliver(consumer, _card_frame())["data"]["title"], SECRET)
        consumer._refresh_role.assert_not_called()

    def test_retained_access_forwards_and_restarts_the_window(self):
        consumer = self._consumer()
        self.clock.advance(ACCESS_RECHECK_SECONDS)

        self.assertIsNotNone(self._deliver(consumer, _card_frame()))
        consumer.close.assert_not_called()
        self.assertEqual(consumer._access_verified_at, self.clock())

    def test_recheck_applies_a_role_change_that_sent_no_member_frame(self):
        """A group-inherited role change emits no board-channel member.* frame;
        the periodic re-check now picks it up instead of waiting for reconnect."""
        group = Group.objects.create(name="AR group", owner=self.owner)
        GroupMembership.objects.create(group=group, user=self.subscriber, role=GroupMembership.Role.ADMIN)
        self.board.group = group
        self.board.save(update_fields=["group"])
        self.membership.delete()  # access now comes from the group alone
        consumer = self._consumer()
        self.clock.advance(ACCESS_RECHECK_SECONDS)

        self.assertIsNotNone(self._deliver(consumer, _card_frame()))
        self.assertEqual(consumer._role, "admin")

    def test_never_verified_consumer_fails_closed(self):
        """No connect()-time stamp means the first frame is re-checked, not trusted."""
        self.membership.delete()
        consumer = self._consumer(verified=False)

        self.assertIsNone(self._deliver(consumer, _card_frame()))
        consumer.close.assert_called_once_with(code=4003)

    def test_deactivated_user_is_evicted(self):
        """The handshake refuses an inactive account; the re-check agrees."""
        consumer = self._consumer()
        User.objects.filter(pk=self.subscriber.pk).update(is_active=False)
        self.clock.advance(ACCESS_RECHECK_SECONDS)

        self.assertIsNone(self._deliver(consumer, _card_frame()))
        consumer.close.assert_called_once_with(code=4003)

    def test_self_subject_member_frame_rechecks_inside_the_window(self):
        """#1332's immediate refresh still bypasses the cache."""
        consumer = self._consumer()
        self.membership.delete()

        frame = {"event": "member.updated", "data": {"user": {"id": self.subscriber.pk}, "role": "member"}}
        self.assertIsNone(self._deliver(consumer, frame))
        consumer.close.assert_called_once_with(code=4003)


class _LossyMemberRemovedLayer:
    """Patch the real channel layer so only member.removed publishes fail.

    The failure is raised from ``group_send`` the way an unreachable Valkey
    raises it, so the real best-effort helper (#1462) swallows and logs it —
    the frame is lost, every other frame still flows.
    """

    def __init__(self, layer):
        self.layer = layer
        self.real_group_send = layer.group_send

    async def group_send(self, group, message):
        if message.get("payload", {}).get("event") == "member.removed":
            raise ConnectionError("simulated lost publish")
        return await self.real_group_send(group, message)

    def patch(self):
        return patch.object(self.layer, "group_send", self.group_send)


class LostMemberRemovedFrameE2ETests(TransactionTestCase):
    """Regression test from #1477, through the real ASGI stack and channel layer."""

    def setUp(self):
        cache.clear()
        self.owner = User.objects.create_user(username="ar_e2e_owner", password="pass")
        self.member = User.objects.create_user(username="ar_e2e_member", password="pass")
        self.board = Board.objects.create(name="E2E access recheck", owner=self.owner)
        BoardMembership.objects.create(board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN)
        BoardMembership.objects.create(board=self.board, user=self.member, role=BoardMembership.Role.MEMBER)

    def _remove_member(self):
        client = APIClient()
        client.force_authenticate(self.owner)
        return client.delete(f"/api/v1/boards/{self.board.id}/members/{self.member.id}/")

    def test_removed_member_stops_receiving_board_frames_when_eviction_frame_is_lost(self):
        from visiban import asgi

        clock = _Clock()
        lossy = _LossyMemberRemovedLayer(get_channel_layer())

        async def run():
            ticket, _ = await sync_to_async(issue_ws_ticket)(self.member)
            comm = WebsocketCommunicator(asgi.application, f"/ws/boards/{self.board.id}/?ticket={ticket}")
            connected, _ = await comm.connect()
            self.assertTrue(connected)

            with lossy.patch(), self.assertLogs("boards.broadcast", level="WARNING") as logs:
                resp = await sync_to_async(self._remove_member)()
            self.assertEqual(resp.status_code, 204)
            self.assertIn("member.removed", "\n".join(logs.output))
            # The eviction frame was lost: before #1477 nothing would ever
            # close this socket.
            self.assertTrue(await comm.receive_nothing(timeout=0.2))

            clock.advance(ACCESS_RECHECK_SECONDS)
            await sync_to_async(broadcast_board_event)(self.board.id, "card.updated", _card_frame()["data"])

            out = await comm.receive_output(timeout=2)
            self.assertEqual(out, {"type": "websocket.close", "code": 4003})
            # The data frame that triggered the re-check was never forwarded.
            self.assertTrue(await comm.receive_nothing(timeout=0.2))

        with patch("boards.consumers._now", clock):
            asyncio.run(run())
