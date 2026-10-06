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
from django.db import OperationalError
from django.test import TransactionTestCase
from rest_framework.test import APIClient

from accounts.models import User
from accounts.ws_auth import issue_ws_ticket
from boards.broadcast import broadcast_board_event
from boards import consumers as consumers_module
from boards.consumers import ACCESS_RECHECK_JITTER_SECONDS, ACCESS_RECHECK_SECONDS, BoardConsumer
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

    def test_window_honors_the_jitter_bound(self):
        """Each successful check draws a window of base + jitter, jitter in [0, max]."""
        consumer = self._consumer()
        self.clock.advance(ACCESS_RECHECK_SECONDS)
        with patch.object(consumers_module, "_jitter", return_value=1.5):
            self.assertIsNotNone(self._deliver(consumer, _card_frame()))
        self.assertEqual(consumer._access_window, ACCESS_RECHECK_SECONDS + 1.5)

        consumer._refresh_role = AsyncMock(return_value="member")
        self.clock.advance(ACCESS_RECHECK_SECONDS + 1.49)
        self._deliver(consumer, _card_frame())
        consumer._refresh_role.assert_not_called()  # still inside the jittered window
        self.clock.advance(0.01)
        self._deliver(consumer, _card_frame())
        consumer._refresh_role.assert_called_once()  # window lapsed: re-checked

        for _ in range(200):
            self.assertTrue(0 <= consumers_module._jitter() <= ACCESS_RECHECK_JITTER_SECONDS)

    def test_recheck_exception_fails_closed_and_logs(self):
        """A DB outage during the re-check drops the frame and closes with 4003."""
        consumer = self._consumer()
        verified_at = consumer._access_verified_at
        consumer._refresh_role = AsyncMock(side_effect=OperationalError("db host secret-detail"))
        self.clock.advance(ACCESS_RECHECK_SECONDS)

        with self.assertLogs("boards.consumers", level="WARNING") as logs:
            self.assertIsNone(self._deliver(consumer, _card_frame()))
        consumer.close.assert_called_once_with(code=4003)
        output = "\n".join(logs.output)
        self.assertIn("board access re-check failed", output)
        self.assertIn("OperationalError", output)
        self.assertNotIn("secret-detail", output)  # class name only, never the message
        self.assertEqual(consumer._access_verified_at, verified_at)  # not cached

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

            # connect() drew a real jitter; step past the longest window.
            clock.advance(ACCESS_RECHECK_SECONDS + ACCESS_RECHECK_JITTER_SECONDS)
            await sync_to_async(broadcast_board_event)(self.board.id, "card.updated", _card_frame()["data"])

            out = await comm.receive_output(timeout=2)
            self.assertEqual(out, {"type": "websocket.close", "code": 4003})
            # The data frame that triggered the re-check was never forwarded.
            self.assertTrue(await comm.receive_nothing(timeout=0.2))

        with patch("boards.consumers._now", clock):
            asyncio.run(run())


def _other_member_frame(user_id):
    """A member.updated frame about someone else, carrying both admin-only fields."""
    return {
        "event": "member.updated",
        "data": {"id": 900 + user_id, "user": {"id": user_id}, "role": "member",
                 "is_moderator": True, "is_site_admin": False},
    }


class NoFrameAccessChangeTests(TransactionTestCase):
    """#1340 / #1339: access changes that publish no board-channel member.* frame.

    Each path below changes the subscriber's effective board role (or removes
    it) without any frame naming them, so neither the member.removed fast path
    nor #1332's self-subject refresh can fire. The periodic re-check (#1477)
    must pick each one up on the first frame past the socket's window. Path
    numbers follow #1340's issue body. #1339 (deactivation) is covered here
    and by ``test_deactivated_user_is_evicted`` in the unit tests above and in
    groups/tests/test_group_consumer_access_recheck.py.
    """

    def setUp(self):
        self.owner = User.objects.create_user(username="nf_owner", password="pass")
        self.other = User.objects.create_user(username="nf_other", password="pass")
        self.subscriber = User.objects.create_user(username="nf_sub", password="pass")
        self.group = Group.objects.create(name="NF group", owner=self.owner)
        self.board = Board.objects.create(name="NF board", owner=self.owner, group=self.group)
        BoardMembership.objects.create(board=self.board, user=self.other, role=BoardMembership.Role.MEMBER)
        self.clock = _Clock()
        p = patch("boards.consumers._now", self.clock)
        p.start()
        self.addCleanup(p.stop)

    def _consumer(self, role):
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
        consumer._role = role
        consumer._access_verified_at = self.clock()
        return consumer

    def _deliver(self, consumer, payload):
        consumer.send.reset_mock()
        asyncio.run(consumer.board_event({"payload": payload}))
        if not consumer.send.called:
            return None
        return json.loads(consumer.send.call_args.kwargs["text_data"])["data"]

    def _assert_admin_fields_stripped_after_window(self, consumer, expected_role):
        # Inside the window the cached admin role still applies (the accepted,
        # bounded exposure); past it the re-check demotes and strips.
        self.clock.advance(ACCESS_RECHECK_SECONDS)
        data = self._deliver(consumer, _other_member_frame(self.other.pk))
        consumer.close.assert_not_called()
        self.assertEqual(consumer._role, expected_role)
        self.assertNotIn("is_moderator", data)
        self.assertNotIn("is_site_admin", data)

    def test_1340_path1_group_role_lowered(self):
        gm = GroupMembership.objects.create(group=self.group, user=self.subscriber, role=GroupMembership.Role.ADMIN)
        consumer = self._consumer("admin")
        self.assertIn("is_moderator", self._deliver(consumer, _other_member_frame(self.other.pk)))

        gm.role = GroupMembership.Role.VIEWER
        gm.save(update_fields=["role"])
        self._assert_admin_fields_stripped_after_window(consumer, "viewer")

    def test_1340_path2_group_membership_removed_lower_ancestor_role_remains(self):
        parent = Group.objects.create(name="NF parent", owner=self.owner)
        self.group.parent = parent
        self.group.save(update_fields=["parent"])
        GroupMembership.objects.create(group=parent, user=self.subscriber, role=GroupMembership.Role.MEMBER)
        GroupMembership.objects.create(group=self.group, user=self.subscriber, role=GroupMembership.Role.ADMIN)
        consumer = self._consumer("admin")

        GroupMembership.objects.filter(group=self.group, user=self.subscriber).delete()
        self._assert_admin_fields_stripped_after_window(consumer, "member")

    def test_1340_path3_can_access_all_content_revoked(self):
        GroupMembership.objects.create(group=self.group, user=self.subscriber, role=GroupMembership.Role.VIEWER)
        User.objects.filter(pk=self.subscriber.pk).update(can_access_all_content=True)
        consumer = self._consumer("site_admin")

        User.objects.filter(pk=self.subscriber.pk).update(can_access_all_content=False)
        self._assert_admin_fields_stripped_after_window(consumer, "viewer")

    def test_1340_path4_board_moved_to_a_group_the_user_is_not_in(self):
        GroupMembership.objects.create(group=self.group, user=self.subscriber, role=GroupMembership.Role.MEMBER)
        consumer = self._consumer("member")
        elsewhere = Group.objects.create(name="NF elsewhere", owner=self.owner)

        self.board.group = elsewhere
        self.board.save(update_fields=["group"])
        self.clock.advance(ACCESS_RECHECK_SECONDS)

        self.assertIsNone(self._deliver(consumer, _card_frame()))
        consumer.close.assert_called_once_with(code=4003)

    def test_1340_path5_owner_changed_directly_in_the_db(self):
        """Simulates a Django-admin BoardAdmin edit: a queryset update, no signal, no frame."""
        Board.objects.filter(pk=self.board.pk).update(owner=self.subscriber, group=None)
        consumer = self._consumer("admin")

        Board.objects.filter(pk=self.board.pk).update(owner=self.owner)
        self.clock.advance(ACCESS_RECHECK_SECONDS)

        self.assertIsNone(self._deliver(consumer, _card_frame()))
        consumer.close.assert_called_once_with(code=4003)

    def test_1340_path5_group_changed_directly_in_the_db(self):
        GroupMembership.objects.create(group=self.group, user=self.subscriber, role=GroupMembership.Role.MEMBER)
        consumer = self._consumer("member")

        Board.objects.filter(pk=self.board.pk).update(group=None)
        self.clock.advance(ACCESS_RECHECK_SECONDS)

        self.assertIsNone(self._deliver(consumer, _card_frame()))
        consumer.close.assert_called_once_with(code=4003)
