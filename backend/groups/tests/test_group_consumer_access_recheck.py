"""GroupConsumer re-verifies access instead of trusting one member.removed frame (#1477).

Same gap as the board channel: ``GroupConsumer`` self-evicted only on receiving
``member.removed`` (#1329), and that publish is best-effort since #1462, so a
lost frame left a removed member's group socket open. The consumer now
re-checks access with ``get_accessible_group_ids`` (cached for
``ACCESS_RECHECK_SECONDS``) before forwarding any frame and closes with
``4003`` when the check fails.

TransactionTestCase, not TestCase: the consumer reaches the ORM from a worker
thread via ``database_sync_to_async``, which cannot see a TestCase's
uncommitted transaction. ``channels.db`` closes that thread-local connection
itself (``close_old_connections`` in a ``finally``), so no explicit
``connections.close_all()`` is needed.
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
from groups.broadcast import broadcast_group_event
from groups.consumers import ACCESS_RECHECK_SECONDS, GroupConsumer
from groups.models import Group, GroupMembership

SECRET = "Confidential-board-name-1477"


class _Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def _board_frame():
    return {"event": "board.updated", "data": {"id": 1, "name": SECRET}}


class GroupConsumerAccessRecheckUnitTests(TransactionTestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="gar_owner", password="pass")
        self.group = Group.objects.create(name="GAR group", owner=self.owner)
        self.subscriber = User.objects.create_user(username="gar_sub", password="pass")
        self.membership = GroupMembership.objects.create(
            group=self.group, user=self.subscriber, role=GroupMembership.Role.MEMBER
        )
        self.clock = _Clock()
        p = patch("groups.consumers._now", self.clock)
        p.start()
        self.addCleanup(p.stop)

    def _consumer(self, *, verified=True):
        consumer = GroupConsumer()
        consumer.group_id = self.group.id
        consumer.room = f"group_{self.group.id}"
        consumer.channel_name = "test-channel"
        consumer.channel_layer = AsyncMock()
        consumer.send = AsyncMock()
        consumer.close = AsyncMock()
        consumer.scope = {
            "url_route": {"kwargs": {"group_id": self.group.id}},
            "user": User.objects.get(pk=self.subscriber.pk),
        }
        if verified:
            consumer._access_verified_at = self.clock()
        return consumer

    def _deliver(self, consumer, payload):
        consumer.send.reset_mock()
        asyncio.run(consumer.group_event({"payload": payload}))
        if not consumer.send.called:
            return None
        return json.loads(consumer.send.call_args.kwargs["text_data"])

    def test_removed_member_is_evicted_on_the_next_frame_after_the_window(self):
        consumer = self._consumer()
        self.membership.delete()
        self.clock.advance(ACCESS_RECHECK_SECONDS)

        self.assertIsNone(self._deliver(consumer, _board_frame()))
        consumer.close.assert_called_once_with(code=4003)

    def test_window_bounds_the_recheck_cost(self):
        consumer = self._consumer()
        consumer._refresh_access = AsyncMock(return_value=True)
        self.clock.advance(ACCESS_RECHECK_SECONDS - 0.01)

        for _ in range(5):
            self.assertEqual(self._deliver(consumer, _board_frame())["data"]["name"], SECRET)
        consumer._refresh_access.assert_not_called()

    def test_retained_access_forwards_and_restarts_the_window(self):
        consumer = self._consumer()
        self.clock.advance(ACCESS_RECHECK_SECONDS)

        self.assertIsNotNone(self._deliver(consumer, _board_frame()))
        consumer.close.assert_not_called()
        self.assertEqual(consumer._access_verified_at, self.clock())

    def test_access_through_a_parent_group_survives_the_recheck(self):
        """Same predicate as connect(): a subgroup reached via its parent stays open."""
        child = Group.objects.create(name="GAR child", owner=self.owner, parent=self.group)
        consumer = self._consumer()
        consumer.group_id = child.id
        self.clock.advance(ACCESS_RECHECK_SECONDS)

        self.assertIsNotNone(self._deliver(consumer, _board_frame()))
        consumer.close.assert_not_called()

    def test_never_verified_consumer_fails_closed(self):
        self.membership.delete()
        consumer = self._consumer(verified=False)

        self.assertIsNone(self._deliver(consumer, _board_frame()))
        consumer.close.assert_called_once_with(code=4003)

    def test_deactivated_user_is_evicted(self):
        consumer = self._consumer()
        User.objects.filter(pk=self.subscriber.pk).update(is_active=False)
        self.clock.advance(ACCESS_RECHECK_SECONDS)

        self.assertIsNone(self._deliver(consumer, _board_frame()))
        consumer.close.assert_called_once_with(code=4003)


class LostGroupMemberRemovedFrameE2ETests(TransactionTestCase):
    """Regression test from #1477's scope note, through the real ASGI stack."""

    def setUp(self):
        cache.clear()
        self.owner = User.objects.create_user(username="gar_e2e_owner", password="pass")
        self.member = User.objects.create_user(username="gar_e2e_member", password="pass")
        self.group = Group.objects.create(name="GAR e2e", owner=self.owner)
        GroupMembership.objects.create(group=self.group, user=self.owner, role=GroupMembership.Role.ADMIN)
        GroupMembership.objects.create(group=self.group, user=self.member, role=GroupMembership.Role.MEMBER)

    def _remove_member(self):
        client = APIClient()
        client.force_authenticate(self.owner)
        return client.delete(f"/api/v1/groups/{self.group.id}/members/{self.member.id}/")

    def test_removed_member_stops_receiving_group_frames_when_eviction_frame_is_lost(self):
        from visiban import asgi

        clock = _Clock()
        layer = get_channel_layer()
        real_group_send = layer.group_send

        async def lossy_group_send(group, message):
            # Lose only the eviction frame, the way an unreachable Valkey
            # would; the best-effort helper (#1462) swallows and logs it.
            if message.get("payload", {}).get("event") == "member.removed":
                raise ConnectionError("simulated lost publish")
            return await real_group_send(group, message)

        async def run():
            ticket, _ = await sync_to_async(issue_ws_ticket)(self.member)
            comm = WebsocketCommunicator(asgi.application, f"/ws/groups/{self.group.id}/?ticket={ticket}")
            connected, _ = await comm.connect()
            self.assertTrue(connected)

            with patch.object(layer, "group_send", lossy_group_send), \
                    self.assertLogs("groups.broadcast", level="WARNING") as logs:
                resp = await sync_to_async(self._remove_member)()
            self.assertEqual(resp.status_code, 204)
            self.assertIn("member.removed", "\n".join(logs.output))
            self.assertTrue(await comm.receive_nothing(timeout=0.2))

            clock.advance(ACCESS_RECHECK_SECONDS)
            await sync_to_async(broadcast_group_event)(self.group.id, "board.updated", _board_frame()["data"])

            out = await comm.receive_output(timeout=2)
            self.assertEqual(out, {"type": "websocket.close", "code": 4003})
            self.assertTrue(await comm.receive_nothing(timeout=0.2))

        with patch("groups.consumers._now", clock):
            asyncio.run(run())
