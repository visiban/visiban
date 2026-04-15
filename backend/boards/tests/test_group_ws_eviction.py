"""
Tests for #500: stale WebSocket membership after group-level access revocation.

When a user is removed from a group, any active board WebSocket connections they
hold through *inherited* group access must be closed via a member.removed broadcast.
Connections held through a direct BoardMembership or another remaining group path
must NOT be closed.
"""
from unittest.mock import call, patch

from django.test import TestCase

from accounts.models import User
from boards.models import Board, BoardMembership, Column, Swimlane
from groups.models import Group, GroupMembership
from rest_framework.test import APIClient
from rest_framework import status


def _make_user(username):
    return User.objects.create_user(username=username, password="pass")


def _make_group(owner, name, parent=None):
    g = Group.objects.create(name=name, owner=owner, parent=parent)
    GroupMembership.objects.create(group=g, user=owner, role=GroupMembership.Role.ADMIN)
    return g


def _make_board(owner, group, name="Board"):
    board = Board.objects.create(name=name, owner=owner, group=group)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    return board


class GroupMemberRemovalWsEvictionTests(TestCase):
    """Verify that member.removed is broadcast to affected boards when a group
    membership is deleted and the user has no remaining access path."""

    def setUp(self):
        self.client = APIClient()
        self.admin = _make_user("admin")
        self.member = _make_user("member")
        self.group = _make_group(self.admin, "Engineering")
        self.board = _make_board(self.admin, self.group, "Sprint Board")
        self.client.force_authenticate(self.admin)

    def _remove_url(self):
        return f"/api/v1/groups/{self.group.pk}/members/{self.member.pk}/"

    def test_group_member_removal_broadcasts_member_removed_for_group_only_boards(self):
        """Removing a group-only member broadcasts member.removed for boards they no longer
        have access to, deferred via transaction.on_commit."""
        GroupMembership.objects.create(
            group=self.group, user=self.member, role=GroupMembership.Role.MEMBER
        )
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.delete(self._remove_url())
            self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
            # Exactly one member.removed call for this board
            remove_calls = [
                c for c in mock_broadcast.call_args_list
                if c[0][1] == "member.removed"
            ]
            self.assertEqual(len(remove_calls), 1)
            board_id, event_type, payload = remove_calls[0][0]
            self.assertEqual(board_id, self.board.pk)
            self.assertEqual(payload["user_id"], self.member.pk)

    def test_group_member_removal_no_eviction_when_direct_board_membership_exists(self):
        """If the removed user has a direct BoardMembership, no member.removed is broadcast —
        they retain access and their connection must not be forcibly closed."""
        GroupMembership.objects.create(
            group=self.group, user=self.member, role=GroupMembership.Role.MEMBER
        )
        # Grant a direct board membership so the user keeps access after group removal.
        BoardMembership.objects.create(
            board=self.board, user=self.member, role=BoardMembership.Role.MEMBER
        )
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.delete(self._remove_url())
            self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
            remove_calls = [
                c for c in mock_broadcast.call_args_list
                if c[0][1] == "member.removed"
            ]
            self.assertEqual(
                len(remove_calls), 0,
                "member.removed must not fire when the user retains direct board access",
            )

    def test_group_member_removal_no_eviction_when_user_not_member(self):
        """Removing a user who was never a group member is a no-op — no broadcast fires."""
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                # member has no GroupMembership — deletion is a no-op
                resp = self.client.delete(self._remove_url())
            # The endpoint returns 204 even when no row existed (idempotent delete)
            self.assertIn(resp.status_code, [status.HTTP_204_NO_CONTENT, status.HTTP_404_NOT_FOUND])
            remove_calls = [
                c for c in mock_broadcast.call_args_list
                if c[0][1] == "member.removed"
            ]
            self.assertEqual(len(remove_calls), 0)

    def test_group_member_removal_evicts_across_child_group_boards(self):
        """Boards in child groups of the revoked group also get member.removed
        when the user has no direct board membership in those child boards."""
        child_group = Group.objects.create(
            name="Frontend", owner=self.admin, parent=self.group
        )
        GroupMembership.objects.create(
            group=child_group, user=self.admin, role=GroupMembership.Role.ADMIN
        )
        child_board = _make_board(self.admin, child_group, "Frontend Board")

        # Member gets access to both boards via the parent group membership.
        GroupMembership.objects.create(
            group=self.group, user=self.member, role=GroupMembership.Role.MEMBER
        )
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.delete(self._remove_url())
            self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)

            remove_calls = [
                c for c in mock_broadcast.call_args_list
                if c[0][1] == "member.removed"
            ]
            evicted_board_ids = {c[0][0] for c in remove_calls}
            self.assertIn(self.board.pk, evicted_board_ids)
            self.assertIn(child_board.pk, evicted_board_ids)

    def test_group_member_removal_not_broadcast_before_commit(self):
        """The member.removed broadcast must not fire before the transaction commits."""
        GroupMembership.objects.create(
            group=self.group, user=self.member, role=GroupMembership.Role.MEMBER
        )
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=False):
                self.client.delete(self._remove_url())
                # on_commit has not run yet — no broadcast should have fired
                mock_broadcast.assert_not_called()

    def test_group_member_removal_no_eviction_when_other_group_path_remains(self):
        """If the user belongs to a second group that also covers the same board,
        removing them from the first group must not evict their connection."""
        second_group = Group.objects.create(name="Platform", owner=self.admin)
        GroupMembership.objects.create(
            group=second_group, user=self.admin, role=GroupMembership.Role.ADMIN
        )
        # The board belongs to self.group, not second_group — so membership in
        # second_group does NOT grant access to self.board. This test therefore
        # verifies that the fallback re-check (get_board_role) correctly concludes
        # that the user has no access and the eviction fires — not a false-negative.
        #
        # To test the "retain via other group" path we need a shared board.
        # Move the board to a group that is an ancestor of both paths.
        # Simpler: give the user direct membership in a parent that covers the board.
        parent_of_all = _make_group(self.admin, "Root")
        self.board.group = parent_of_all
        self.board.save(update_fields=["group"])
        Group.objects.filter(pk=self.group.pk).update(parent=parent_of_all)
        GroupMembership.objects.create(
            group=parent_of_all, user=self.member, role=GroupMembership.Role.MEMBER
        )
        GroupMembership.objects.create(
            group=self.group, user=self.member, role=GroupMembership.Role.MEMBER
        )
        # Removing from self.group — user still has parent_of_all membership.
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.delete(self._remove_url())
            self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
            remove_calls = [
                c for c in mock_broadcast.call_args_list
                if c[0][1] == "member.removed"
            ]
            self.assertEqual(
                len(remove_calls), 0,
                "member.removed must not fire when user retains access via a parent group",
            )
