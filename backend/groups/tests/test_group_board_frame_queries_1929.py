"""Query cost of the group channel's board-frame gate and access check (#1929).

``GroupConsumer`` forwards ``board.created`` / ``board.updated`` only to a
subscriber with a role on that board (#1829). Each uncached verdict used to
cost about three queries per board per socket, so a burst of board metadata
edits across a group cost sockets x boards x 3. A miss now resolves the
frame's board together with a batch of the group's other boards in one fixed
pass (``get_board_roles``), so the rest of the burst is answered from the
socket's cache. The verdicts and their expiry are unchanged: same ladder,
cleared on the next access re-check.

The access check itself now joins the group's whole capped ancestor chain up
front, so a deep group costs the same two queries as a root one.
"""
import asyncio
import json
from unittest.mock import AsyncMock, patch

from django.db import connection
from django.test import TestCase, TransactionTestCase
from django.test.utils import CaptureQueriesContext

from accounts.models import User
from accounts.tests.ws_helpers import bound_scope
from boards.models import Board, BoardMembership
from groups import consumers as group_consumers
from groups.consumers import ACCESS_RECHECK_SECONDS, GroupConsumer, _user_can_access_group_id
from groups.models import _GROUP_TRAVERSAL_MAX_DEPTH, Group, GroupMembership


class _Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class GroupBoardFrameQueryCountTests(TransactionTestCase):
    """TransactionTestCase: the consumer reaches the ORM from a worker thread."""

    def setUp(self):
        self.owner = User.objects.create_user(username="q1929_owner", password="x")
        self.root = Group.objects.create(name="Q1929 root", owner=self.owner)
        self.group = Group.objects.create(name="Q1929", owner=self.owner, parent=self.root)
        GroupMembership.objects.create(group=self.root, user=self.owner, role=GroupMembership.Role.ADMIN)
        self.user = User.objects.create_user(username="q1929_user", password="x")
        # Inherited from the root, so every verdict walks the group ladder.
        GroupMembership.objects.create(group=self.root, user=self.user, role="member")
        self.boards = [
            Board.objects.create(name=f"B{i}", owner=self.owner, group=self.group) for i in range(8)
        ]
        # One board the user is blocked from by their own stored role (#1829).
        self.blocked = self.boards[0]
        BoardMembership.objects.create(board=self.blocked, user=self.user, role="auditor")
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

    def _deliver(self, consumer, board_id):
        consumer.send.reset_mock()
        asyncio.run(consumer.group_event({"payload": {"event": "board.updated", "data": {"id": board_id}}}))
        if not consumer.send.called:
            return None
        return json.loads(consumer.send.call_args.kwargs["text_data"])

    def _pass_queries(self, consumer, board_id):
        """Run one verdict pass in this thread and return the queries it issued."""
        sync_pass = GroupConsumer.__dict__["_board_verdicts_for"].func
        with CaptureQueriesContext(connection) as ctx:
            verdicts = sync_pass(consumer, board_id)
        return verdicts, ctx.captured_queries

    def test_one_pass_resolves_the_whole_group_in_three_queries(self):
        consumer = self._consumer()
        verdicts, queries = self._pass_queries(consumer, self.boards[3].id)
        # boards with their ancestor chain + board memberships + group memberships.
        self.assertEqual(len(queries), 3, [q["sql"] for q in queries])
        self.assertEqual(set(verdicts), {b.id for b in self.boards})
        self.assertFalse(verdicts[self.blocked.id])
        self.assertTrue(all(verdicts[b.id] for b in self.boards[1:]))

    def test_pass_cost_does_not_grow_with_the_board_count(self):
        consumer = self._consumer()
        _, before = self._pass_queries(consumer, self.boards[1].id)
        for i in range(20):
            Board.objects.create(name=f"Extra {i}", owner=self.owner, group=self.group)
        _, after = self._pass_queries(consumer, self.boards[1].id)
        self.assertEqual(len(before), len(after))

    def test_all_content_user_pass_is_one_query(self):
        User.objects.filter(pk=self.user.pk).update(can_access_all_content=True)
        consumer = self._consumer()
        consumer.scope["user"] = User.objects.get(pk=self.user.pk)
        verdicts, queries = self._pass_queries(consumer, self.blocked.id)
        self.assertEqual(len(queries), 1)
        self.assertTrue(verdicts[self.blocked.id])

    def test_a_burst_across_the_group_costs_one_pass_per_window(self):
        consumer = self._consumer()
        with patch.object(consumer, "_board_verdicts_for", wraps=consumer._board_verdicts_for) as check:
            delivered = [self._deliver(consumer, b.id) for b in self.boards]
            check.assert_called_once()
        self.assertIsNone(delivered[0])  # the blocked board's frame is withheld
        self.assertTrue(all(d is not None for d in delivered[1:]))
        consumer.close.assert_not_called()

    def test_the_cache_still_expires_with_the_access_recheck(self):
        consumer = self._consumer()
        self.assertIsNone(self._deliver(consumer, self.blocked.id))
        BoardMembership.objects.filter(board=self.blocked, user=self.user).update(role="member")
        # Cached: still withheld inside the window.
        self.assertIsNone(self._deliver(consumer, self.blocked.id))
        self.clock.advance(ACCESS_RECHECK_SECONDS + 3)
        self.assertIsNotNone(self._deliver(consumer, self.blocked.id))

    def test_frame_board_outside_the_group_is_still_resolved(self):
        # A board in another group the user can reach: always in the batch.
        elsewhere = Group.objects.create(name="Elsewhere", owner=self.owner, parent=self.root)
        other = Board.objects.create(name="Other", owner=self.owner, group=elsewhere)
        consumer = self._consumer()
        with patch.object(group_consumers, "BOARD_VERDICT_BATCH", 2):
            verdicts, _ = self._pass_queries(consumer, other.id)
        self.assertTrue(verdicts[other.id])
        self.assertEqual(len(verdicts), 2)

    def test_batch_is_capped_and_always_holds_the_frame_board(self):
        consumer = self._consumer()
        last = self.boards[-1]
        with patch.object(group_consumers, "BOARD_VERDICT_BATCH", 3):
            verdicts, _ = self._pass_queries(consumer, last.id)
        self.assertEqual(len(verdicts), 3)
        self.assertIn(last.id, verdicts)

    def test_absent_board_fails_closed_and_is_cached(self):
        consumer = self._consumer()
        missing = max(b.id for b in self.boards) + 1000
        self.assertIsNone(self._deliver(consumer, missing))
        self.assertIs(consumer._board_verdicts[missing], False)
        consumer.close.assert_not_called()

    def test_board_without_a_resolvable_role_is_withheld(self):
        # Absent input: no membership anywhere on the ladder resolves a role.
        GroupMembership.objects.filter(group=self.root, user=self.user).delete()
        GroupMembership.objects.create(group=self.group, user=self.user, role="member")
        BoardMembership.objects.filter(board=self.blocked, user=self.user).delete()
        own = Board.objects.create(name="Personal", owner=self.owner)
        consumer = self._consumer()
        self.assertIsNone(self._deliver(consumer, own.id))
        self.assertIsNotNone(self._deliver(consumer, self.blocked.id))


class GroupAccessCheckQueryCountTests(TestCase):
    """The access predicate's cost no longer grows with the group's depth (#1929)."""

    def setUp(self):
        self.owner = User.objects.create_user(username="a1929_owner", password="x")
        self.user = User.objects.create_user(username="a1929_user", password="x")
        self.chain = []
        parent = None
        for i in range(_GROUP_TRAVERSAL_MAX_DEPTH):
            parent = Group.objects.create(name=f"L{i}", owner=self.owner, parent=parent)
            GroupMembership.objects.create(group=parent, user=self.owner, role=GroupMembership.Role.ADMIN)
            self.chain.append(parent)

    def test_member_check_at_the_depth_cap_is_two_queries(self):
        GroupMembership.objects.create(group=self.chain[0], user=self.user, role="member")
        deepest = self.chain[-1]
        # The group with its whole ancestor chain, then one membership EXISTS.
        with self.assertNumQueries(2):
            self.assertTrue(_user_can_access_group_id(self.user, deepest.pk))

    def test_owner_without_a_membership_row_is_two_queries_and_denied(self):
        # The owner-without-row state (#1829): ownership is not a rung, and
        # the check costs the same as any other at full depth.
        deepest = self.chain[-1]
        GroupMembership.objects.filter(user=self.owner).delete()
        with self.assertNumQueries(2):
            self.assertFalse(_user_can_access_group_id(self.owner, deepest.pk))

    def test_missing_group_is_one_query_and_denied(self):
        with self.assertNumQueries(1):
            self.assertFalse(_user_can_access_group_id(self.user, 2**40))
