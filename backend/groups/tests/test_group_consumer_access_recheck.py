"""GroupConsumer re-verifies access instead of trusting one member.removed frame (#1477).

Same gap as the board channel: ``GroupConsumer`` self-evicted only on receiving
``member.removed`` (#1329), and that publish is best-effort since #1462, so a
lost frame left a removed member's group socket open. The consumer now
re-checks access with ``user_has_group_access`` (cached for
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
from django.db import OperationalError
from django.test import TransactionTestCase
from rest_framework.test import APIClient

from accounts.models import User
from accounts.tests.ws_helpers import bound_scope, session_ticket
from groups.broadcast import broadcast_group_event
from groups import consumers as consumers_module
from groups.consumers import ACCESS_RECHECK_JITTER_SECONDS, ACCESS_RECHECK_SECONDS, GroupConsumer
from boards.models import Board
from groups.models import Group, GroupMembership

SECRET = "Confidential-board-name-1477"


class _Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def _board_frame(board_id):
    """A board.updated frame for a real board in the group.

    Real, because board.* state frames are forwarded only to a subscriber with
    a role on the board they describe (#1829).
    """
    return {"event": "board.updated", "data": {"id": board_id, "name": SECRET}}


class GroupConsumerAccessRecheckUnitTests(TransactionTestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="gar_owner", password="pass")
        self.group = Group.objects.create(name="GAR group", owner=self.owner)
        self.board = Board.objects.create(name="Board in group", owner=self.owner, group=self.group)
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
            **bound_scope(self.subscriber),
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

        self.assertIsNone(self._deliver(consumer, _board_frame(self.board.id)))
        consumer.close.assert_called_once_with(code=4003)

    def test_window_bounds_the_recheck_cost(self):
        consumer = self._consumer()
        consumer._refresh_access = AsyncMock(return_value=True)
        self.clock.advance(ACCESS_RECHECK_SECONDS - 0.01)

        for _ in range(5):
            self.assertEqual(self._deliver(consumer, _board_frame(self.board.id))["data"]["name"], SECRET)
        consumer._refresh_access.assert_not_called()

    def test_retained_access_forwards_and_restarts_the_window(self):
        consumer = self._consumer()
        self.clock.advance(ACCESS_RECHECK_SECONDS)

        self.assertIsNotNone(self._deliver(consumer, _board_frame(self.board.id)))
        consumer.close.assert_not_called()
        self.assertEqual(consumer._access_verified_at, self.clock())

    def test_access_through_a_parent_group_survives_the_recheck(self):
        """Same predicate as connect(): a subgroup reached via its parent stays open."""
        child = Group.objects.create(name="GAR child", owner=self.owner, parent=self.group)
        consumer = self._consumer()
        consumer.group_id = child.id
        self.clock.advance(ACCESS_RECHECK_SECONDS)

        self.assertIsNotNone(self._deliver(consumer, _board_frame(self.board.id)))
        consumer.close.assert_not_called()

    def test_membership_only_in_a_subgroup_does_not_admit_the_parent_channel(self):
        """Access inherits downward only, matching the REST group endpoints."""
        child = Group.objects.create(name="GAR child2", owner=self.owner, parent=self.group)
        sub_only = User.objects.create_user(username="gar_subonly", password="pass")
        GroupMembership.objects.create(group=child, user=sub_only, role=GroupMembership.Role.MEMBER)
        consumer = GroupConsumer()
        user = User.objects.get(pk=sub_only.pk)

        self.assertFalse(asyncio.run(consumer._has_access(user, self.group.id)))
        self.assertTrue(asyncio.run(consumer._has_access(user, child.id)))

    def test_recheck_evicts_a_subgroup_only_member_from_the_parent_channel(self):
        child = Group.objects.create(name="GAR child3", owner=self.owner, parent=self.group)
        sub_only = User.objects.create_user(username="gar_subonly2", password="pass")
        GroupMembership.objects.create(group=child, user=sub_only, role=GroupMembership.Role.MEMBER)
        consumer = self._consumer()
        consumer.scope = {
            "url_route": {"kwargs": {"group_id": self.group.id}},
            "user": User.objects.get(pk=sub_only.pk),
            **bound_scope(sub_only),
        }
        self.clock.advance(ACCESS_RECHECK_SECONDS)

        self.assertIsNone(self._deliver(consumer, _board_frame(self.board.id)))
        consumer.close.assert_called_once_with(code=4003)

    def test_owner_without_a_membership_row_is_not_admitted(self):
        """Matches the REST group endpoints, which gate on membership rows."""
        lone_owner = User.objects.create_user(username="gar_lone_owner", password="pass")
        group = Group.objects.create(name="GAR owned", owner=lone_owner)
        GroupMembership.objects.filter(group=group, user=lone_owner).delete()
        consumer = GroupConsumer()
        user = User.objects.get(pk=lone_owner.pk)

        self.assertFalse(asyncio.run(consumer._has_access(user, group.id)))

    def test_parent_member_is_admitted_to_the_parent_channel(self):
        consumer = GroupConsumer()
        user = User.objects.get(pk=self.subscriber.pk)
        self.assertTrue(asyncio.run(consumer._has_access(user, self.group.id)))

    def test_window_honors_the_jitter_bound(self):
        """Each successful check draws a window of base + jitter, jitter in [0, max]."""
        consumer = self._consumer()
        self.clock.advance(ACCESS_RECHECK_SECONDS)
        with patch.object(consumers_module, "_jitter", return_value=1.5):
            self.assertIsNotNone(self._deliver(consumer, _board_frame(self.board.id)))
        self.assertEqual(consumer._access_window, ACCESS_RECHECK_SECONDS + 1.5)

        consumer._refresh_access = AsyncMock(return_value=True)
        self.clock.advance(ACCESS_RECHECK_SECONDS + 1.49)
        self._deliver(consumer, _board_frame(self.board.id))
        consumer._refresh_access.assert_not_called()  # still inside the jittered window
        self.clock.advance(0.01)
        self._deliver(consumer, _board_frame(self.board.id))
        consumer._refresh_access.assert_called_once()  # window lapsed: re-checked

        for _ in range(200):
            self.assertTrue(0 <= consumers_module._jitter() <= ACCESS_RECHECK_JITTER_SECONDS)

    def test_recheck_exception_fails_closed_with_1011_and_logs(self):
        """A DB outage during the re-check drops the frame and closes with the
        reconnectable 1011, not the final 4003 (#2003)."""
        consumer = self._consumer()
        verified_at = consumer._access_verified_at
        consumer._refresh_access = AsyncMock(side_effect=OperationalError("db host secret-detail"))
        self.clock.advance(ACCESS_RECHECK_SECONDS)

        with self.assertLogs("groups.consumers", level="WARNING") as logs:
            self.assertIsNone(self._deliver(consumer, _board_frame(self.board.id)))
        consumer.send.assert_not_called()
        consumer.close.assert_called_once_with(code=1011)
        output = "\n".join(logs.output)
        self.assertIn("group access re-check failed", output)
        self.assertIn("OperationalError", output)
        self.assertNotIn("secret-detail", output)  # class name only, never the message
        self.assertEqual(consumer._access_verified_at, verified_at)  # not cached

    def test_access_lookup_error_closes_with_1011_and_denial_with_4003(self):
        """The split is decided by the access lookup itself (#2003): the same
        frame closes with 1011 when the membership lookup raises, and with 4003
        once the lookup completes and finds no access."""
        consumer = self._consumer()
        self.clock.advance(ACCESS_RECHECK_SECONDS)
        with patch(
            "groups.consumers._user_can_access_group_id",
            side_effect=OperationalError("db host secret-detail"),
        ), self.assertLogs("groups.consumers", level="WARNING"):
            self.assertIsNone(self._deliver(consumer, _board_frame(self.board.id)))
        consumer.close.assert_called_once_with(code=1011)

        consumer = self._consumer()
        self.membership.delete()
        self.clock.advance(ACCESS_RECHECK_SECONDS)
        self.assertIsNone(self._deliver(consumer, _board_frame(self.board.id)))
        consumer.close.assert_called_once_with(code=4003)

    def test_never_verified_consumer_fails_closed(self):
        self.membership.delete()
        consumer = self._consumer(verified=False)

        self.assertIsNone(self._deliver(consumer, _board_frame(self.board.id)))
        consumer.close.assert_called_once_with(code=4003)

    def test_deactivated_user_is_evicted(self):
        consumer = self._consumer()
        User.objects.filter(pk=self.subscriber.pk).update(is_active=False)
        self.clock.advance(ACCESS_RECHECK_SECONDS)

        self.assertIsNone(self._deliver(consumer, _board_frame(self.board.id)))
        consumer.close.assert_called_once_with(code=4003)


class LostGroupMemberRemovedFrameE2ETests(TransactionTestCase):
    """Regression test from #1477's scope note, through the real ASGI stack."""

    def setUp(self):
        cache.clear()
        self.owner = User.objects.create_user(username="gar_e2e_owner", password="pass")
        self.member = User.objects.create_user(username="gar_e2e_member", password="pass")
        self.group = Group.objects.create(name="GAR e2e", owner=self.owner)
        self.board = Board.objects.create(name="Board in group", owner=self.owner, group=self.group)
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
            ticket, _ = await sync_to_async(session_ticket)(self.member)
            comm = WebsocketCommunicator(asgi.application, f"/ws/groups/{self.group.id}/?ticket={ticket}")
            connected, _ = await comm.connect()
            self.assertTrue(connected)

            with patch.object(layer, "group_send", lossy_group_send), \
                    self.assertLogs("groups.broadcast", level="WARNING") as logs:
                resp = await sync_to_async(self._remove_member)()
            self.assertEqual(resp.status_code, 204)
            self.assertIn("member.removed", "\n".join(logs.output))
            self.assertTrue(await comm.receive_nothing(timeout=0.2))

            # connect() drew a real jitter; step past the longest window.
            clock.advance(ACCESS_RECHECK_SECONDS + ACCESS_RECHECK_JITTER_SECONDS)
            await sync_to_async(broadcast_group_event)(self.group.id, "board.updated", _board_frame(self.board.id)["data"])

            out = await comm.receive_output(timeout=2)
            self.assertEqual(out, {"type": "websocket.close", "code": 4003})
            self.assertTrue(await comm.receive_nothing(timeout=0.2))

        with patch("groups.consumers._now", clock):
            asyncio.run(run())


class GroupConsumerAccountStateTests(TransactionTestCase):
    """Pending password/username change is applied at connect and on re-check."""

    FLAGS = ("must_change_password", "must_change_username")

    def setUp(self):
        cache.clear()
        self.owner = User.objects.create_user(username="gas_owner", password="pass")
        self.member = User.objects.create_user(username="gas_member", password="pass")
        self.group = Group.objects.create(name="GAS group", owner=self.owner)
        self.board = Board.objects.create(name="Board in group", owner=self.owner, group=self.group)
        GroupMembership.objects.create(group=self.group, user=self.member, role=GroupMembership.Role.MEMBER)

    def _connect(self, *, flag=None):
        from visiban import asgi

        if flag:
            User.objects.filter(pk=self.member.pk).update(**{flag: True})

        async def run():
            ticket, _ = await sync_to_async(session_ticket)(self.member)
            comm = WebsocketCommunicator(asgi.application, f"/ws/groups/{self.group.id}/?ticket={ticket}")
            connected, code = await comm.connect()
            await comm.disconnect()
            return connected, code

        return asyncio.run(run())

    def test_unflagged_user_connects(self):
        connected, _ = self._connect()
        self.assertTrue(connected)

    def test_flagged_user_is_refused_at_connect(self):
        for flag in self.FLAGS:
            with self.subTest(flag=flag):
                connected, code = self._connect(flag=flag)
                self.assertFalse(connected)
                self.assertEqual(code, 4003)
                User.objects.filter(pk=self.member.pk).update(**{flag: False})

    def test_open_socket_is_closed_on_recheck_after_flag_is_set(self):
        from visiban import asgi

        for flag in self.FLAGS:
            with self.subTest(flag=flag):
                clock = _Clock()

                async def run():
                    ticket, _ = await sync_to_async(session_ticket)(self.member)
                    comm = WebsocketCommunicator(asgi.application, f"/ws/groups/{self.group.id}/?ticket={ticket}")
                    connected, _ = await comm.connect()
                    self.assertTrue(connected)

                    await sync_to_async(User.objects.filter(pk=self.member.pk).update)(**{flag: True})
                    clock.advance(ACCESS_RECHECK_SECONDS + ACCESS_RECHECK_JITTER_SECONDS)
                    await sync_to_async(broadcast_group_event)(
                        self.group.id, "board.updated", _board_frame(self.board.id)["data"]
                    )

                    out = await comm.receive_output(timeout=2)
                    self.assertEqual(out, {"type": "websocket.close", "code": 4003})

                with patch("groups.consumers._now", clock):
                    asyncio.run(run())
                User.objects.filter(pk=self.member.pk).update(**{flag: False})

    def test_flagged_user_is_refused_on_cookie_handshake(self):
        from django.conf import settings

        from accounts.tests.ws_helpers import login_session
        from visiban import asgi

        for flag in self.FLAGS:
            with self.subTest(flag=flag):
                User.objects.filter(pk=self.member.pk).update(**{flag: True})
                key = login_session(User.objects.get(pk=self.member.pk))
                cookie = f"{settings.SESSION_COOKIE_NAME}={key}".encode()

                async def run():
                    comm = WebsocketCommunicator(
                        asgi.application, f"/ws/groups/{self.group.id}/", headers=[(b"cookie", cookie)]
                    )
                    return await comm.connect()

                connected, code = asyncio.run(run())
                self.assertFalse(connected)
                self.assertEqual(code, 4003)
                User.objects.filter(pk=self.member.pk).update(**{flag: False})

    def test_idle_socket_is_closed_by_keepalive_recheck_after_flag_is_set(self):
        from visiban import asgi

        for flag in self.FLAGS:
            with self.subTest(flag=flag):
                clock = _Clock()

                async def run():
                    ticket, _ = await sync_to_async(session_ticket)(self.member)
                    comm = WebsocketCommunicator(asgi.application, f"/ws/groups/{self.group.id}/?ticket={ticket}")
                    connected, _ = await comm.connect()
                    self.assertTrue(connected)

                    await sync_to_async(User.objects.filter(pk=self.member.pk).update)(**{flag: True})
                    clock.advance(ACCESS_RECHECK_SECONDS + ACCESS_RECHECK_JITTER_SECONDS)
                    # No broadcast: only the keepalive ping can run the re-check.
                    for _ in range(50):
                        out = await comm.receive_output(timeout=2)
                        if out.get("type") == "websocket.send" and '"ping"' in out.get("text", ""):
                            continue
                        self.assertEqual(out, {"type": "websocket.close", "code": 4003})
                        return
                    self.fail("socket was never closed")

                with patch("groups.consumers._now", clock), patch("groups.consumers.PING_INTERVAL", 0.05):
                    asyncio.run(run())
                User.objects.filter(pk=self.member.pk).update(**{flag: False})
