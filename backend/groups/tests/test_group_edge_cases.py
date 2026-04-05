"""Tests for group cascade behavior and permission inheritance edge cases."""
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Column, Swimlane
from groups.models import Group, GroupMembership


def _make_group(owner, name="Group", parent=None):
    group = Group.objects.create(name=name, owner=owner, parent=parent)
    GroupMembership.objects.create(group=group, user=owner, role=GroupMembership.Role.ADMIN)
    return group


def _make_board_in_group(owner, group, name="Board"):
    board = Board.objects.create(name=name, owner=owner, group=group)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    Swimlane.objects.create(board=board, name="General", position=0)
    return board


# ---------------------------------------------------------------------------
# 2. Group cascade tests
# ---------------------------------------------------------------------------

class GroupCascadeDeletionTests(TestCase):
    """Verify that deleting a parent group cascades to subgroups and
    that group deletion unlinks (SET_NULL) boards."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.parent = _make_group(self.owner, "Parent")
        self.child = _make_group(self.owner, "Child", parent=self.parent)
        self.grandchild = _make_group(self.owner, "Grandchild", parent=self.child)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def test_delete_parent_cascades_to_subgroups(self):
        """Deleting a parent group should cascade delete all subgroups
        (Django CASCADE on parent FK)."""
        child_id = self.child.id
        grandchild_id = self.grandchild.id
        r = self.client.delete(f"/api/v1/groups/{self.parent.id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(Group.objects.filter(pk=child_id).exists())
        self.assertFalse(Group.objects.filter(pk=grandchild_id).exists())

    def test_delete_group_unlinks_boards(self):
        """Board.group is SET_NULL, so deleting a group should leave the
        board intact but with group=None."""
        board = _make_board_in_group(self.owner, self.child, "Board in Child")
        board_id = board.id
        self.client.delete(f"/api/v1/groups/{self.parent.id}/")
        board.refresh_from_db()
        self.assertIsNone(board.group)
        self.assertTrue(Board.objects.filter(pk=board_id).exists())


class GroupMemberRemovalCascadeTests(TestCase):
    """Removing a user from a parent group should revoke their inherited
    access to child group boards."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.member = User.objects.create_user(username="member", password="pass")
        self.parent = _make_group(self.owner, "Parent")
        self.child = Group.objects.create(name="Child", owner=self.owner, parent=self.parent)
        GroupMembership.objects.create(group=self.child, user=self.owner, role=GroupMembership.Role.ADMIN)
        # member is in parent group only
        GroupMembership.objects.create(
            group=self.parent, user=self.member, role=GroupMembership.Role.MEMBER
        )
        self.board = _make_board_in_group(self.owner, self.child, "Child Board")
        self.client = APIClient()

    def test_parent_member_can_access_child_board_before_removal(self):
        """Confirm the member can see the child board via group inheritance."""
        self.client.force_authenticate(self.member)
        r = self.client.get(f"/api/v1/boards/{self.board.id}/full/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_removing_from_parent_revokes_child_board_access(self):
        """After removing member from parent group, they should lose
        access to child group boards (no direct board membership)."""
        # Remove from parent group
        self.client.force_authenticate(self.owner)
        r = self.client.delete(
            f"/api/v1/groups/{self.parent.id}/members/{self.member.id}/"
        )
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)

        # Now member should not be able to access the child board
        self.client.force_authenticate(self.member)
        r = self.client.get(f"/api/v1/boards/{self.board.id}/full/")
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND])


# ---------------------------------------------------------------------------
# 3. Permission inheritance edge cases
# ---------------------------------------------------------------------------

class PermissionInheritanceTests(TestCase):
    """Test that group membership properly propagates board access
    through the parent-child hierarchy."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.member = User.objects.create_user(username="member", password="pass")
        self.parent = _make_group(self.owner, "Parent")
        self.child = Group.objects.create(name="Child", owner=self.owner, parent=self.parent)
        GroupMembership.objects.create(group=self.child, user=self.owner, role=GroupMembership.Role.ADMIN)
        self.board = _make_board_in_group(self.owner, self.child, "Child Board")
        self.client = APIClient()

    def test_parent_member_can_access_child_group_board(self):
        """A user added to the parent group should be able to access
        boards belonging to a child group."""
        GroupMembership.objects.create(
            group=self.parent, user=self.member, role=GroupMembership.Role.MEMBER
        )
        self.client.force_authenticate(self.member)
        r = self.client.get(f"/api/v1/boards/{self.board.id}/full/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_parent_member_removed_loses_child_board_access(self):
        """After removal from parent group, user should lose access
        to child group boards."""
        gm = GroupMembership.objects.create(
            group=self.parent, user=self.member, role=GroupMembership.Role.MEMBER
        )
        # Confirm access exists
        self.client.force_authenticate(self.member)
        r = self.client.get(f"/api/v1/boards/{self.board.id}/full/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)

        # Remove from parent
        gm.delete()

        # Access should be revoked
        r = self.client.get(f"/api/v1/boards/{self.board.id}/full/")
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND])

    def test_direct_board_membership_retained_after_group_removal(self):
        """A user with direct board membership should retain access
        even after being removed from the parent group."""
        # Add member to parent group AND give direct board membership
        gm = GroupMembership.objects.create(
            group=self.parent, user=self.member, role=GroupMembership.Role.MEMBER
        )
        BoardMembership.objects.create(
            board=self.board, user=self.member, role=BoardMembership.Role.MEMBER
        )

        # Remove from parent group
        gm.delete()

        # Should still have access via direct board membership
        self.client.force_authenticate(self.member)
        r = self.client.get(f"/api/v1/boards/{self.board.id}/full/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_non_member_cannot_access_child_board(self):
        """A user with no group membership at all should not be able
        to access a board inside a child group."""
        outsider = User.objects.create_user(username="outsider", password="pass")
        self.client.force_authenticate(outsider)
        r = self.client.get(f"/api/v1/boards/{self.board.id}/full/")
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND])
