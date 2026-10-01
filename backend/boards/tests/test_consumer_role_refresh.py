"""BoardConsumer re-resolves the subscriber's role on a self-subject member frame (#1332).

``BoardConsumer._role`` is resolved once at ``connect()``. Before #1332 nothing
refreshed it, so a board admin demoted to viewer kept receiving the admin-only
``is_moderator`` / ``is_site_admin`` columns on every later ``member.*`` frame
until they reconnected (and a promoted viewer stayed under-exposed — the inverse
of #1191). The consumer now re-resolves from the DB whenever a ``member.added``
/ ``member.updated`` frame is about the connected user.

TransactionTestCase, not TestCase: ``_refresh_role`` reaches the ORM from a
worker thread via ``database_sync_to_async``, which cannot see a TestCase's
uncommitted transaction. ``channels.db`` closes that thread-local connection
itself (``close_old_connections`` in a ``finally``), so no explicit
``connections.close_all()`` is needed — the same reasoning as
``accounts/tests/test_ws_ticket_e2e.py``.
"""
import asyncio
import json
from unittest.mock import AsyncMock

from asgiref.sync import sync_to_async
from channels.testing import WebsocketCommunicator
from django.core.cache import cache
from django.db import connection
from django.test import TestCase, TransactionTestCase
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from accounts.models import User
from accounts.ws_auth import issue_ws_ticket
from boards.consumers import BoardConsumer, _lookup_role
from boards.models import Board, BoardMembership
from groups.models import Group, GroupMembership

ADMIN = BoardMembership.Role.ADMIN
VIEWER = BoardMembership.Role.VIEWER
MEMBER = BoardMembership.Role.MEMBER


def _frame(event, subject_id, role="member"):
    return {
        "event": event,
        "data": {
            "id": 900 + subject_id, "user": {"id": subject_id}, "role": role,
            "is_moderator": True, "is_site_admin": False,
        },
    }


class ConsumerRoleRefreshUnitTests(TransactionTestCase):
    """Drive ``board_event`` directly against real DB rows."""

    def setUp(self):
        self.owner = User.objects.create_user(username="rr_owner", password="pass")
        self.board = Board.objects.create(name="Role refresh", owner=self.owner)
        self.subscriber = User.objects.create_user(username="rr_sub", password="pass")
        self.other = User.objects.create_user(username="rr_other", password="pass")
        BoardMembership.objects.create(board=self.board, user=self.other, role=MEMBER)

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
            # The handshake-time User instance — deliberately the stale one.
            "user": User.objects.get(pk=self.subscriber.pk),
        }
        consumer._role = role
        return consumer

    def _deliver(self, consumer, payload):
        consumer.send.reset_mock()
        asyncio.run(consumer.board_event({"payload": payload}))
        if not consumer.send.called:
            return None
        return json.loads(consumer.send.call_args.kwargs["text_data"])["data"]

    def _set_row(self, role):
        BoardMembership.objects.update_or_create(
            board=self.board, user=self.subscriber, defaults={"role": role}
        )

    def test_demotion_frame_itself_is_filtered_by_the_new_role(self):
        """(b) the self-subject member.updated is stripped per the NEW role."""
        self._set_row(ADMIN)
        consumer = self._consumer("admin")
        self._set_row(VIEWER)  # demoted by another admin; socket still open

        data = self._deliver(consumer, _frame("member.updated", self.subscriber.pk, "viewer"))

        self.assertEqual(consumer._role, "viewer")
        self.assertNotIn("is_site_admin", data)
        # Own row keeps is_moderator — the #1191 self-row exception still holds.
        self.assertIn("is_moderator", data)

    def test_demoted_admin_loses_flags_on_later_frames_about_others(self):
        """(a) the issue's scenario: no more admin-only columns after demotion."""
        self._set_row(ADMIN)
        consumer = self._consumer("admin")
        self.assertIn("is_moderator", self._deliver(consumer, _frame("member.updated", self.other.pk)))

        self._set_row(VIEWER)
        self._deliver(consumer, _frame("member.updated", self.subscriber.pk, "viewer"))
        data = self._deliver(consumer, _frame("member.updated", self.other.pk))

        self.assertNotIn("is_moderator", data)
        self.assertNotIn("is_site_admin", data)

    def test_promotion_gains_flags_on_this_and_later_frames(self):
        """(c) viewer -> admin gains the fields without a reconnect."""
        self._set_row(VIEWER)
        consumer = self._consumer("viewer")
        self.assertNotIn("is_moderator", self._deliver(consumer, _frame("member.added", self.other.pk)))

        self._set_row(ADMIN)
        own = self._deliver(consumer, _frame("member.updated", self.subscriber.pk, "admin"))
        self.assertIn("is_site_admin", own)
        data = self._deliver(consumer, _frame("member.updated", self.other.pk))

        self.assertEqual(consumer._role, "admin")
        self.assertIs(data["is_moderator"], True)
        self.assertIs(data["is_site_admin"], False)

    def test_explicit_row_overrides_group_inherited_admin(self):
        """(d) member.added for self: a group-inherited admin given an explicit
        viewer row drops to viewer (explicit membership outranks groups)."""
        group = Group.objects.create(name="RR group", owner=self.owner)
        GroupMembership.objects.create(group=group, user=self.subscriber, role=GroupMembership.Role.ADMIN)
        self.board.group = group
        self.board.save(update_fields=["group"])
        consumer = self._consumer("admin")

        self._set_row(VIEWER)
        self._deliver(consumer, _frame("member.added", self.subscriber.pk, "viewer"))
        data = self._deliver(consumer, _frame("member.updated", self.other.pk))

        self.assertEqual(consumer._role, "viewer")
        self.assertNotIn("is_moderator", data)

    def test_role_comes_from_the_db_not_the_payload(self):
        """A can_access_all_content user with a viewer row stays site_admin —
        the payload's explicit `role` is not the effective role."""
        User.objects.filter(pk=self.subscriber.pk).update(can_access_all_content=True)
        self._set_row(VIEWER)
        consumer = self._consumer("site_admin")

        self._deliver(consumer, _frame("member.updated", self.subscriber.pk, "viewer"))

        self.assertEqual(consumer._role, "site_admin")

    def test_refresh_rereads_the_user_row(self):
        """Revoking can_access_all_content mid-connection is seen on the next
        self frame — the handshake-time scope user is not trusted."""
        User.objects.filter(pk=self.subscriber.pk).update(can_access_all_content=True)
        self._set_row(VIEWER)
        consumer = self._consumer("site_admin")
        User.objects.filter(pk=self.subscriber.pk).update(can_access_all_content=False)

        self._deliver(consumer, _frame("member.updated", self.subscriber.pk, "viewer"))

        self.assertEqual(consumer._role, "viewer")

    def test_frames_about_others_do_not_re_resolve(self):
        """The refresh is bounded to self-subject frames, never per frame."""
        self._set_row(ADMIN)
        consumer = self._consumer("admin")
        consumer._refresh_role = AsyncMock(return_value="viewer")

        self._deliver(consumer, _frame("member.updated", self.other.pk))
        self._deliver(consumer, _frame("card.updated", self.subscriber.pk))

        consumer._refresh_role.assert_not_called()
        self.assertEqual(consumer._role, "admin")

    def test_no_remaining_access_closes_the_socket(self):
        """Self frame but the role now resolves to None: fail closed."""
        self._set_row(ADMIN)
        consumer = self._consumer("admin")
        BoardMembership.objects.filter(board=self.board, user=self.subscriber).delete()

        data = self._deliver(consumer, _frame("member.updated", self.subscriber.pk, "admin"))

        self.assertIsNone(data)
        consumer.close.assert_called_once()
        self.assertIsNone(consumer._role)

    def test_malformed_subject_does_not_re_resolve(self):
        consumer = self._consumer("viewer")
        consumer._refresh_role = AsyncMock(return_value="admin")
        payload = _frame("member.updated", self.subscriber.pk)
        payload["data"]["user"] = self.subscriber.pk  # not a dict

        data = self._deliver(consumer, payload)

        consumer._refresh_role.assert_not_called()
        self.assertNotIn("is_moderator", data)


class LookupRoleQueryCountTests(TestCase):
    """_lookup_role must not N+1 across the group-ancestor chain (#1332).

    It runs on every self-subject member frame, so a role inherited from a
    deeply nested group must cost the same queries as one from a direct group.
    Called synchronously here (it is the plain-ORM half of _refresh_role), so
    TestCase is fine.
    """

    def _nested_board(self, depth):
        owner = User.objects.create_user(username=f"rr_qc_owner{depth}", password="pass")
        user = User.objects.create_user(username=f"rr_qc_user{depth}", password="pass")
        top = Group.objects.create(name=f"top{depth}", owner=owner)
        GroupMembership.objects.create(group=top, user=user, role=GroupMembership.Role.ADMIN)
        leaf = top
        for i in range(depth - 1):
            leaf = Group.objects.create(name=f"g{depth}-{i}", owner=owner, parent=leaf)
        board = Board.objects.create(name=f"nested{depth}", owner=owner, group=leaf)
        return User.objects.get(pk=user.pk), board.id

    def _count(self, depth):
        user, board_id = self._nested_board(depth)
        with CaptureQueriesContext(connection) as ctx:
            self.assertEqual(_lookup_role(user, board_id), "admin")
        return len(ctx.captured_queries)

    def test_inherited_role_query_count_is_independent_of_depth(self):
        direct = self._count(1)
        deep_user, deep_board = self._nested_board(6)
        with self.assertNumQueries(direct):
            self.assertEqual(_lookup_role(deep_user, deep_board), "admin")


class ConsumerRoleRefreshEndToEndTests(TransactionTestCase):
    """The issue's exact scenario through the real ASGI stack and REST endpoint."""

    def setUp(self):
        cache.clear()
        self.admin_b = User.objects.create_user(username="rr_e2e_b", password="pass")
        self.board = Board.objects.create(name="RR e2e", owner=self.admin_b)
        BoardMembership.objects.create(board=self.board, user=self.admin_b, role=ADMIN)
        self.admin_a = User.objects.create_user(username="rr_e2e_a", password="pass")
        BoardMembership.objects.create(board=self.board, user=self.admin_a, role=ADMIN)
        self.member_c = User.objects.create_user(username="rr_e2e_c", password="pass")
        BoardMembership.objects.create(board=self.board, user=self.member_c, role=MEMBER)
        self.client = APIClient()
        self.client.force_authenticate(self.admin_b)

    def _post_member(self, user, role):
        resp = self.client.post(
            f"/api/v1/boards/{self.board.id}/members/",
            {"user_id": user.pk, "role": role},
            format="json",
        )
        assert resp.status_code in (200, 201), resp.content

    def test_demoted_admin_socket_stops_receiving_admin_only_columns(self):
        from visiban import asgi

        ticket, _ = issue_ws_ticket(self.admin_a)

        async def run():
            comm = WebsocketCommunicator(
                asgi.application, f"/ws/boards/{self.board.id}/?ticket={ticket}"
            )
            connected, _ = await comm.connect()
            assert connected
            try:
                # While admin: frames about C carry both admin-only columns.
                await sync_to_async(self._post_member)(self.member_c, MEMBER)
                before = await comm.receive_json_from(timeout=5)
                # B demotes A to viewer; A never disconnects.
                await sync_to_async(self._post_member)(self.admin_a, VIEWER)
                demotion = await comm.receive_json_from(timeout=5)
                await sync_to_async(self._post_member)(self.member_c, MEMBER)
                after = await comm.receive_json_from(timeout=5)
            finally:
                await comm.disconnect()
            return before, demotion, after

        before, demotion, after = asyncio.run(run())

        self.assertEqual(before["event"], "member.updated")
        self.assertIn("is_moderator", before["data"])
        self.assertIn("is_site_admin", before["data"])
        self.assertEqual(demotion["data"]["user"]["id"], self.admin_a.pk)
        self.assertNotIn("is_site_admin", demotion["data"])
        self.assertEqual(after["data"]["user"]["id"], self.member_c.pk)
        self.assertNotIn("is_moderator", after["data"])
        self.assertNotIn("is_site_admin", after["data"])

