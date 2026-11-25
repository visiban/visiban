"""Group member removal evicts board sockets from a fresh, batched, chunked read (#2624).

Three properties of ``groups.views._evict_lost_board_access``:

1. A board placed under the group's subtree between the pre-transaction read
   and the commit is still evicted. The interleaving is simulated
   deterministically: the placement runs inside the patched membership-lock
   helper, which the view calls after its read and before it deletes the row.
2. The post-commit role resolution is batched (``get_board_roles``), so the
   callback's query count does not grow with the number of boards.
3. The fan-out is capped at ``BOARD_EVICTION_FANOUT_MAX`` boards (the rest
   are logged and left to the consumer's periodic access re-check) and, within
   the cap, chunked: at most ``_EVICTION_CHUNK_SIZE`` boards per transaction.
4. The group-channel ``member.removed`` also reaches a subgroup created
   between the pre-transaction read and the commit.
5. Both post-commit callbacks are robust: an eviction failure still answers
   204 and still sends the group-channel frame.
"""
from unittest.mock import patch

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership
from groups import services as group_services
from groups import views as group_views
from groups.models import Group, GroupMembership


class _Base(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(username="admin_2624", password="pw")
        self.target = User.objects.create_user(username="target_2624", password="pw")
        self.group = Group.objects.create(name="G2624", owner=self.admin)
        GroupMembership.objects.create(group=self.group, user=self.admin, role="admin")
        GroupMembership.objects.create(group=self.group, user=self.target, role="member")
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def _board(self, group, name="B"):
        board = Board.objects.create(name=name, owner=self.admin, group=group)
        BoardMembership.objects.create(board=board, user=self.admin, role="admin")
        return board

    def _remove(self):
        with patch("groups.broadcast.broadcast_group_event") as group_send:
            evicted = self._remove_board_frames()
        self.group_frames = [
            c.args[0] for c in group_send.call_args_list
            if c.args[1] == "member.removed" and c.args[2] == {"user_id": self.target.pk}
        ]
        return evicted

    def _remove_board_frames(self):
        with patch("boards.broadcast.broadcast_board_event") as send:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.delete(
                    f"/api/v1/groups/{self.group.pk}/members/{self.target.pk}/"
                )
        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        return [
            c.args[0] for c in send.call_args_list
            if c.args[1] == "member.removed" and c.args[2] == {"user_id": self.target.pk}
        ]


class ConcurrentPlacementIsEvictedTests(_Base):
    def _remove_with_placement(self, place):
        real_lock = group_services.lock_membership_for_removal_or_demotion
        placed = {}

        def lock_then_place(*args, **kwargs):
            # The view's pre-transaction read has already run; the placement
            # lands before the membership row is deleted and committed.
            placed["board"] = place()
            return real_lock(*args, **kwargs)

        with patch.object(
            group_services, "lock_membership_for_removal_or_demotion", side_effect=lock_then_place
        ):
            evicted = self._remove()
        return placed["board"], evicted

    def test_board_placed_in_group_after_read_is_evicted(self):
        existing = self._board(self.group, "existing")
        late, evicted = self._remove_with_placement(lambda: self._board(self.group, "late"))
        self.assertIn(late.pk, evicted)
        self.assertIn(existing.pk, evicted)

    def test_board_under_subgroup_created_after_read_is_evicted(self):
        def place():
            child = Group.objects.create(name="late child", owner=self.admin, parent=self.group)
            return self._board(child, "late in child")

        late, evicted = self._remove_with_placement(place)
        self.assertEqual(evicted, [late.pk])

    def test_subgroup_created_after_read_gets_group_channel_frame(self):
        """The group channel's fan-out unions the pre-read subtree with a fresh
        read after commit, so a subgroup created in the window is told too."""
        created = {}

        def place():
            created["child"] = Group.objects.create(
                name="late child", owner=self.admin, parent=self.group
            )
            return self._board(created["child"], "late in child")

        self._remove_with_placement(place)
        self.assertCountEqual(self.group_frames, [self.group.pk, created["child"].pk])

    def test_board_moved_in_with_direct_membership_is_not_evicted(self):
        def place():
            board = self._board(self.group, "late direct")
            BoardMembership.objects.create(board=board, user=self.target, role="member")
            return board

        late, evicted = self._remove_with_placement(place)
        self.assertNotIn(late.pk, evicted)

    def test_pre_read_board_moved_out_is_still_rechecked(self):
        """The pre-read stays in the union: a board moved out of the subtree in
        the window, to a group the user is not in, is still evicted."""
        moved = self._board(self.group, "moved out")
        elsewhere = Group.objects.create(name="elsewhere", owner=self.admin)

        def place():
            Board.objects.filter(pk=moved.pk).update(group=elsewhere)
            return moved

        _, evicted = self._remove_with_placement(place)
        self.assertEqual(evicted, [moved.pk])


class EvictionRoleLookupIsBatchedTests(_Base):
    """The callback's query count is independent of the number of boards."""

    def _callback_queries(self, n_boards):
        # The target keeps access through a parent group, so no board is
        # evicted and only the read + role-resolution queries are counted.
        parent = Group.objects.create(name=f"parent {n_boards}", owner=self.admin)
        GroupMembership.objects.create(group=parent, user=self.target, role="member")
        group = Group.objects.create(name=f"child {n_boards}", owner=self.admin, parent=parent)
        GroupMembership.objects.create(group=group, user=self.target, role="member")
        ids = [self._board(group, f"b{i}").pk for i in range(n_boards)]
        GroupMembership.objects.filter(group=group, user=self.target).delete()
        with patch.object(group_views, "_record_eviction_chunk") as chunk:
            with CaptureQueriesContext(connection) as ctx:
                group_views._evict_lost_board_access(self.target.pk, group.pk, frozenset(ids))
        chunk.assert_not_called()
        return len(ctx.captured_queries)

    def test_query_count_does_not_grow_with_board_count(self):
        self.assertEqual(self._callback_queries(2), self._callback_queries(9))

    def test_query_count_is_pinned(self):
        # user + subtree walk (one level, then an empty frontier is not
        # queried) + subtree boards + candidate boards with ancestors +
        # get_board_roles' two batched lookups.
        self.assertEqual(self._callback_queries(4), 6)

    def test_get_board_role_is_not_called_per_board(self):
        for i in range(3):
            self._board(self.group, f"b{i}")
        with patch("boards.permissions.get_board_role") as single:
            evicted = self._remove()
        single.assert_not_called()
        self.assertEqual(len(evicted), 3)


class EvictionFanOutIsChunkedTests(_Base):
    def test_fan_out_is_chunked_and_complete(self):
        boards = [self._board(self.group, f"b{i}").pk for i in range(5)]
        real_chunk = group_views._record_eviction_chunk
        with patch.object(group_views, "_EVICTION_CHUNK_SIZE", 2), patch.object(
            group_views, "_record_eviction_chunk", side_effect=real_chunk
        ) as chunk:
            evicted = self._remove()
        sizes = [len(c.args[0]) for c in chunk.call_args_list]
        self.assertEqual(sizes, [2, 2, 1])
        # Under the cap, every board that lost access is evicted once.
        self.assertEqual(sorted(evicted), sorted(boards))

    def test_default_chunk_size(self):
        self.assertEqual(group_views._EVICTION_CHUNK_SIZE, 50)

    def test_default_fan_out_cap_matches_subgroup_cap(self):
        from groups.broadcast import INHERITED_ROW_FANOUT_MAX

        self.assertEqual(group_views.BOARD_EVICTION_FANOUT_MAX, 500)
        self.assertEqual(group_views.BOARD_EVICTION_FANOUT_MAX, INHERITED_ROW_FANOUT_MAX)

    def test_fan_out_past_cap_is_truncated_chunked_and_logged(self):
        boards = sorted(self._board(self.group, f"b{i}").pk for i in range(5))
        real_chunk = group_views._record_eviction_chunk
        with patch.object(group_views, "BOARD_EVICTION_FANOUT_MAX", 3), patch.object(
            group_views, "_EVICTION_CHUNK_SIZE", 2
        ), patch.object(
            group_views, "_record_eviction_chunk", side_effect=real_chunk
        ) as chunk, self.assertLogs("groups.views", level="WARNING") as logs:
            evicted = self._remove()
        # The lowest ids first, chunked within the cap; the rest are skipped.
        self.assertEqual([len(c.args[0]) for c in chunk.call_args_list], [2, 1])
        self.assertEqual(sorted(evicted), boards[:3])
        self.assertEqual(len(logs.records), 1)
        message = logs.records[0].getMessage()
        self.assertEqual(
            message,
            f"group member board eviction fan-out capped: group_id={self.group.pk} boards=5 sent=3",
        )
        # No PII: neither the removed user's id nor their username is logged.
        self.assertNotIn(self.target.username, message)
        self.assertNotIn(f"user_id={self.target.pk}", message)

    def test_fan_out_at_cap_is_not_truncated_or_logged(self):
        boards = [self._board(self.group, f"b{i}").pk for i in range(3)]
        with patch.object(group_views, "BOARD_EVICTION_FANOUT_MAX", 3), self.assertNoLogs(
            "groups.views", level="WARNING"
        ):
            evicted = self._remove()
        self.assertEqual(sorted(evicted), sorted(boards))

    def test_no_eviction_when_user_is_gone(self):
        board = self._board(self.group)
        with patch.object(group_views, "_record_eviction_chunk") as chunk:
            group_views._evict_lost_board_access(2**62, self.group.pk, frozenset([board.pk]))
        chunk.assert_not_called()

    def test_no_eviction_when_no_candidate_boards(self):
        with patch.object(group_views, "_record_eviction_chunk") as chunk:
            group_views._evict_lost_board_access(self.target.pk, self.group.pk, frozenset())
        chunk.assert_not_called()


class EvictionFailureIsContainedTests(_Base):
    """The eviction runs after the removal committed: a failure there must not
    answer 500, nor stop the group-channel callback registered after it."""

    def test_eviction_failure_still_answers_204_and_sends_group_frame(self):
        self._board(self.group)
        with patch.object(
            group_views, "_record_eviction_chunk", side_effect=RuntimeError("boom")
        ) as chunk, self.assertLogs("django", level="ERROR") as logs:
            # Django logs a robust callback's exception: from "django.test"
            # under captureOnCommitCallbacks, "django.db.backends.base" in
            # production.
            evicted = self._remove()  # asserts 204
        chunk.assert_called_once()
        self.assertIn("_evict_stale_ws", logs.output[0])
        self.assertEqual(evicted, [])
        self.assertEqual(self.group_frames, [self.group.pk])
        self.assertFalse(
            GroupMembership.objects.filter(group=self.group, user=self.target).exists()
        )
