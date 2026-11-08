"""Group access ignores memberships with an unrecognized role (#1829, #1726).

``choices`` is not enforced on save, so a ``GroupMembership`` row written by
an import, the shell or a migration can carry any string. ``get_board_role``
and ``get_group_ids_for_board_access`` already treat such a row as no role;
the group predicates (``user_has_group_access``, ``group_access_resolver``,
``get_accessible_group_ids``) now do too, so the group REST routes, the group
list and the group WebSocket agree with board access for the same row.

``get_accessible_group_ids`` also no longer admits a group's owner without a
membership row: since #1786 every owner holds a direct admin row, so the rung
only mattered for a group whose owner row is missing or malformed, and it was
the one path that listed and resolved such a group for a user every member
check refuses.

The group channel also withholds ``board.created`` / ``board.updated`` frames
from a subscriber who has no role on that board (an explicit board
membership with an unrecognized role), as the board channel and REST do.

The invalid values are written with ``QuerySet.update()`` or a plain
``create()``, since no API path accepts them. Board-side coverage of the same
class (board list, retrieve and ``/cards/``) is
``boards/tests/test_group_derived_board_access.py`` ``StoredRoleTests``.
"""
import asyncio
import json
from unittest.mock import AsyncMock, patch

from asgiref.sync import sync_to_async
from channels.testing import WebsocketCommunicator
from django.core.cache import cache
from django.test import TestCase, TransactionTestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from accounts.tests.ws_helpers import bound_scope, handshake, session_ticket
from boards.models import Board, BoardMembership
from boards.permissions import get_board_role
from groups.consumers import ACCESS_RECHECK_SECONDS, GroupConsumer, _user_can_access_group_id
from groups.models import (
    Group,
    GroupMembership,
    get_accessible_group_ids,
    get_group_ids_for_board_access,
    group_access_resolver,
    user_has_group_access,
)
from groups.views import _is_member

BAD_ROLE = "auditor"
GROUPS_URL = "/api/v1/groups/"


def _list_ids(client):
    r = client.get(GROUPS_URL)
    assert r.status_code == 200, r.content
    body = r.json()
    rows = body["results"] if isinstance(body, dict) else body
    return {g["id"]: g for g in rows}


class _Fixture(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="fc_owner", password="x")
        self.root = Group.objects.create(name="Root", owner=self.owner)
        GroupMembership.objects.create(group=self.root, user=self.owner, role=GroupMembership.Role.ADMIN)
        self.child = Group.objects.create(name="Child", owner=self.owner, parent=self.root)
        GroupMembership.objects.create(group=self.child, user=self.owner, role=GroupMembership.Role.ADMIN)
        self.user = User.objects.create_user(username="fc_user", password="x")
        self.client = APIClient()
        self.client.force_authenticate(self.user)


class GroupPredicateTests(_Fixture):
    def test_unrecognized_role_grants_no_group_access(self):
        GroupMembership.objects.create(group=self.root, user=self.user, role=BAD_ROLE)

        self.assertFalse(user_has_group_access(self.user, self.root))
        self.assertFalse(user_has_group_access(self.user, self.child))
        has_access = group_access_resolver(self.user)
        self.assertFalse(has_access(self.root))
        self.assertFalse(has_access(self.child))
        self.assertEqual(get_accessible_group_ids(self.user), set())
        # The board-side group set already agreed (#1112); now both are empty.
        self.assertEqual(get_group_ids_for_board_access(self.user), set())
        self.assertFalse(_user_can_access_group_id(self.user, self.root.id))
        self.assertFalse(_is_member(self.user, self.root.id))

    def test_every_valid_role_still_grants_access(self):
        membership = GroupMembership.objects.create(group=self.root, user=self.user, role="viewer")
        for role in GroupMembership.Role.values:
            with self.subTest(role=role):
                GroupMembership.objects.filter(pk=membership.pk).update(role=role)
                self.assertTrue(user_has_group_access(self.user, self.child))
                self.assertTrue(group_access_resolver(self.user)(self.child))
                self.assertEqual(get_accessible_group_ids(self.user), {self.root.id, self.child.id})
                self.assertTrue(_is_member(self.user, self.root.id))

    def test_bad_row_on_an_ancestor_does_not_hide_a_valid_row_farther_up(self):
        grandchild = Group.objects.create(name="Grandchild", owner=self.owner, parent=self.child)
        GroupMembership.objects.create(group=self.root, user=self.user, role="viewer")
        GroupMembership.objects.create(group=self.child, user=self.user, role=BAD_ROLE)

        self.assertTrue(user_has_group_access(self.user, grandchild))
        self.assertTrue(group_access_resolver(self.user)(grandchild))


class GroupRestTests(_Fixture):
    def test_bad_role_only_member_gets_an_empty_list_and_404s(self):
        GroupMembership.objects.create(group=self.root, user=self.user, role=BAD_ROLE)

        self.assertEqual(_list_ids(self.client), {})
        for path in ("", "members/", "labels/", "subgroups/", "boards/"):
            with self.subTest(path=path):
                r = self.client.get(f"{GROUPS_URL}{self.root.id}/{path}")
                self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND, r.content)

    def test_bad_role_on_a_listed_ancestor_gets_403_on_its_nested_routes(self):
        # A valid row on the child lists the root for navigation only; the bad
        # row on the root must not turn that into access.
        GroupMembership.objects.create(group=self.child, user=self.user, role="member")
        GroupMembership.objects.create(group=self.root, user=self.user, role=BAD_ROLE)

        rows = _list_ids(self.client)
        self.assertEqual(set(rows), {self.root.id, self.child.id})
        self.assertTrue(rows[self.root.id]["navigation_only"])
        self.assertFalse(rows[self.child.id]["navigation_only"])
        for path in ("members/", "labels/", "subgroups/", "boards/"):
            with self.subTest(path=path):
                r = self.client.get(f"{GROUPS_URL}{self.root.id}/{path}")
                self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN, r.content)
        self.assertEqual(
            self.client.get(f"{GROUPS_URL}{self.child.id}/members/").status_code, status.HTTP_200_OK,
        )

    def test_owner_without_a_valid_membership_row_is_not_admitted(self):
        """The owner rung is gone: ownership alone lists and resolves nothing (#1829)."""
        lone = User.objects.create_user(username="fc_lone_owner", password="x")
        group = Group.objects.create(name="Lone", owner=lone)
        sub = Group.objects.create(name="Lone sub", owner=lone, parent=group)
        client = APIClient()
        client.force_authenticate(lone)

        for label, setup in (
            ("no row", lambda: None),
            ("unrecognized role", lambda: GroupMembership.objects.create(group=group, user=lone, role=BAD_ROLE)),
        ):
            with self.subTest(case=label):
                setup()
                self.assertEqual(get_accessible_group_ids(lone), set())
                self.assertEqual(_list_ids(client), {})
                self.assertEqual(client.get(f"{GROUPS_URL}{group.id}/").status_code, status.HTTP_404_NOT_FOUND)
                self.assertEqual(client.get(f"{GROUPS_URL}{sub.id}/").status_code, status.HTTP_404_NOT_FOUND)
                self.assertEqual(client.delete(f"{GROUPS_URL}{group.id}/").status_code, status.HTTP_404_NOT_FOUND)
        self.assertTrue(Group.objects.filter(pk=group.pk).exists())

    def test_owner_with_the_admin_row_keeps_full_access(self):
        rows = _list_ids(self._owner_client())
        self.assertEqual(set(rows), {self.root.id, self.child.id})
        self.assertFalse(rows[self.root.id]["navigation_only"])

    def _owner_client(self):
        client = APIClient()
        client.force_authenticate(self.owner)
        return client

    def test_roster_skips_an_inherited_row_with_an_unrecognized_role(self):
        grandchild = Group.objects.create(name="Grandchild", owner=self.owner, parent=self.child)
        GroupMembership.objects.create(group=self.root, user=self.user, role="viewer")
        GroupMembership.objects.create(group=self.child, user=self.user, role=BAD_ROLE)
        lurker = User.objects.create_user(username="fc_lurker", password="x")
        GroupMembership.objects.create(group=self.child, user=lurker, role=BAD_ROLE)

        r = self._owner_client().get(f"{GROUPS_URL}{grandchild.id}/members/")
        self.assertEqual(r.status_code, 200, r.content)
        by_user = {row["user"]["id"]: row for row in r.json()}
        # The nearer bad row neither lists itself nor hides the root's row.
        self.assertEqual(by_user[self.user.id]["role"], "viewer")
        self.assertEqual(by_user[self.user.id]["inherited_from"], self.root.name)
        self.assertNotIn(lurker.id, by_user)

    def test_roster_still_lists_a_direct_row_with_an_unrecognized_role(self):
        """Listed as stored so an admin can see and remove it, as on the board roster."""
        GroupMembership.objects.create(group=self.root, user=self.user, role=BAD_ROLE)
        r = self._owner_client().get(f"{GROUPS_URL}{self.root.id}/members/")
        rows = {row["user"]["id"]: row for row in r.json()}
        self.assertEqual(rows[self.user.id]["role"], BAD_ROLE)
        self.assertFalse(rows[self.user.id]["is_inherited"])
        removed = self._owner_client().delete(f"{GROUPS_URL}{self.root.id}/members/{self.user.id}/")
        self.assertEqual(removed.status_code, status.HTTP_204_NO_CONTENT)


class GroupChannelHandshakeTests(TransactionTestCase):
    """The group WebSocket refuses a member whose only row has an unrecognized role."""

    def setUp(self):
        cache.clear()
        self.owner = User.objects.create_user(username="fcw_owner", password="x")
        self.group = Group.objects.create(name="FCW", owner=self.owner)
        GroupMembership.objects.create(group=self.group, user=self.owner, role=GroupMembership.Role.ADMIN)
        self.user = User.objects.create_user(username="fcw_user", password="x")
        self.membership = GroupMembership.objects.create(group=self.group, user=self.user, role="member")

    def _connect(self):
        from visiban import asgi

        async def run():
            ticket, _ = await sync_to_async(session_ticket)(self.user)
            comm = WebsocketCommunicator(asgi.application, f"/ws/groups/{self.group.id}/?ticket={ticket}")
            connected, code = await handshake(comm)
            if connected:
                await comm.disconnect()
            return connected, code

        return asyncio.run(run())

    def test_valid_role_connects_and_unrecognized_role_is_refused(self):
        connected, _ = self._connect()
        self.assertTrue(connected)

        GroupMembership.objects.filter(pk=self.membership.pk).update(role=BAD_ROLE)
        connected, code = self._connect()
        self.assertFalse(connected)
        self.assertEqual(code, 4003)


class _Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class GroupChannelBoardFrameTests(TransactionTestCase):
    """board.created / board.updated reach only subscribers with a role on that board.

    TransactionTestCase: the consumer reaches the ORM from a worker thread via
    ``database_sync_to_async``, which cannot see a TestCase's transaction.
    """

    def setUp(self):
        self.owner = User.objects.create_user(username="fcb_owner", password="x")
        self.group = Group.objects.create(name="FCB", owner=self.owner)
        GroupMembership.objects.create(group=self.group, user=self.owner, role=GroupMembership.Role.ADMIN)
        self.user = User.objects.create_user(username="fcb_user", password="x")
        GroupMembership.objects.create(group=self.group, user=self.user, role="member")
        self.blocked = Board.objects.create(name="Blocked", owner=self.owner, group=self.group)
        self.open = Board.objects.create(name="Open", owner=self.owner, group=self.group)
        self.blocked_row = BoardMembership.objects.create(board=self.blocked, user=self.user, role=BAD_ROLE)
        self.clock = _Clock()
        p = patch("groups.consumers._now", self.clock)
        p.start()
        self.addCleanup(p.stop)

    def _consumer(self):
        consumer = GroupConsumer()
        consumer.group_id = self.group.id
        consumer.room = f"group_{self.group.id}"
        consumer.channel_name = "test-channel"
        consumer.channel_layer = AsyncMock()
        consumer.send = AsyncMock()
        consumer.close = AsyncMock()
        consumer.scope = {
            "url_route": {"kwargs": {"group_id": self.group.id}},
            "user": User.objects.get(pk=self.user.pk),
            **bound_scope(self.user),
        }
        consumer._access_verified_at = self.clock()
        return consumer

    def _deliver(self, consumer, event, data):
        consumer.send.reset_mock()
        asyncio.run(consumer.group_event({"payload": {"event": event, "data": data}}))
        if not consumer.send.called:
            return None
        return json.loads(consumer.send.call_args.kwargs["text_data"])

    def test_board_state_frames_follow_the_board_role(self):
        self.assertIsNone(get_board_role(self.user, Board.objects.get(pk=self.blocked.pk)))
        consumer = self._consumer()
        for event in ("board.created", "board.updated"):
            with self.subTest(event=event):
                self.assertIsNone(self._deliver(consumer, event, {"id": self.blocked.id, "name": "Blocked"}))
                self.assertIsNotNone(self._deliver(consumer, event, {"id": self.open.id, "name": "Open"}))
        # Withholding one board's frame is not a loss of group access.
        consumer.close.assert_not_called()

    def test_board_deleted_and_group_frames_are_not_gated(self):
        consumer = self._consumer()
        self.assertIsNotNone(self._deliver(consumer, "board.deleted", {"board_uid": str(self.blocked.uid)}))
        self.assertIsNotNone(self._deliver(consumer, "group.updated", {"id": self.group.id}))

    def test_a_valid_explicit_role_of_any_level_receives_frames(self):
        for role in BoardMembership.Role.values:
            with self.subTest(role=role):
                BoardMembership.objects.filter(pk=self.blocked_row.pk).update(role=role)
                consumer = self._consumer()
                self.assertIsNotNone(self._deliver(consumer, "board.updated", {"id": self.blocked.id}))

    def test_frames_without_a_resolvable_board_fail_closed(self):
        consumer = self._consumer()
        for data in ({}, {"id": None}, {"id": str(self.open.id)}, {"id": True}, {"id": 2**40}, None, []):
            with self.subTest(data=data):
                self.assertIsNone(self._deliver(consumer, "board.updated", data))
        consumer.close.assert_not_called()

    def test_verdict_is_cached_until_the_access_recheck(self):
        consumer = self._consumer()
        self.assertIsNone(self._deliver(consumer, "board.updated", {"id": self.blocked.id}))
        BoardMembership.objects.filter(pk=self.blocked_row.pk).update(role="member")

        with patch.object(consumer, "_board_role_resolves", wraps=consumer._board_role_resolves) as check:
            self.assertIsNone(self._deliver(consumer, "board.updated", {"id": self.blocked.id}))
            check.assert_not_called()

            # The access re-check clears the cached verdicts with it.
            self.clock.advance(ACCESS_RECHECK_SECONDS + 3)
            self.assertIsNotNone(self._deliver(consumer, "board.updated", {"id": self.blocked.id}))
            check.assert_called_once()

    def test_a_failing_board_check_withholds_without_closing(self):
        consumer = self._consumer()
        consumer._board_role_resolves = AsyncMock(side_effect=RuntimeError("db down"))
        with self.assertLogs("groups.consumers", level="WARNING") as logs:
            self.assertIsNone(self._deliver(consumer, "board.updated", {"id": self.open.id}))
        self.assertIn("RuntimeError", "\n".join(logs.output))
        consumer.close.assert_not_called()
        # Not cached: the next frame asks again.
        consumer._board_role_resolves = AsyncMock(return_value=True)
        self.assertIsNotNone(self._deliver(consumer, "board.updated", {"id": self.open.id}))

    def test_board_check_uses_the_user_row_from_the_last_recheck(self):
        """A cleared all-content flag is not trusted from the handshake user."""
        User.objects.filter(pk=self.user.pk).update(can_access_all_content=True)
        consumer = self._consumer()
        consumer.scope["user"] = User.objects.get(pk=self.user.pk)
        self.assertIsNotNone(self._deliver(consumer, "board.updated", {"id": self.blocked.id}))

        User.objects.filter(pk=self.user.pk).update(can_access_all_content=False)
        self.clock.advance(ACCESS_RECHECK_SECONDS + 3)
        self.assertIsNone(self._deliver(consumer, "board.updated", {"id": self.blocked.id}))
        consumer.close.assert_not_called()
