"""Tests for group transfer_ownership endpoint — all paths (#402, #694)."""
from unittest.mock import patch

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from groups.models import Group, GroupMembership


def _make_group(owner, name="Group"):
    group = Group.objects.create(name=name, owner=owner)
    GroupMembership.objects.create(group=group, user=owner, role=GroupMembership.Role.ADMIN)
    return group


class TransferOwnershipTests(TestCase):
    """Covers #402: transfer_ownership endpoint — success, non-member, non-owner, self."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.admin_member = User.objects.create_user(username="admin_member", password="pass")
        self.regular_member = User.objects.create_user(username="regular_member", password="pass")
        self.outsider = User.objects.create_user(username="outsider", password="pass")
        self.group = _make_group(self.owner, "Transfer Group")
        GroupMembership.objects.create(
            group=self.group, user=self.admin_member, role=GroupMembership.Role.ADMIN
        )
        GroupMembership.objects.create(
            group=self.group, user=self.regular_member, role=GroupMembership.Role.MEMBER
        )
        self.client = APIClient()
        self.url = f"/api/v1/groups/{self.group.id}/transfer-ownership/"

    def test_successful_transfer(self):
        """Owner transfers ownership to an admin member with correct confirmation."""
        self.client.force_authenticate(self.owner)
        r = self.client.post(self.url, {
            "new_owner_id": self.admin_member.id,
            "confirmation": self.group.name,
        })
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.group.refresh_from_db()
        self.assertEqual(self.group.owner_id, self.admin_member.id)
        # Previous owner should remain as admin member
        self.assertTrue(
            GroupMembership.objects.filter(
                group=self.group, user=self.owner, role=GroupMembership.Role.ADMIN
            ).exists()
        )

    def test_transfer_to_non_member_fails(self):
        """Transferring to a user who is not a group member must fail."""
        self.client.force_authenticate(self.owner)
        r = self.client.post(self.url, {
            "new_owner_id": self.outsider.id,
            "confirmation": self.group.name,
        })
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.group.refresh_from_db()
        self.assertEqual(self.group.owner_id, self.owner.id)

    def test_transfer_to_non_admin_member_fails(self):
        """Transferring to a member who is not an admin must fail."""
        self.client.force_authenticate(self.owner)
        r = self.client.post(self.url, {
            "new_owner_id": self.regular_member.id,
            "confirmation": self.group.name,
        })
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.group.refresh_from_db()
        self.assertEqual(self.group.owner_id, self.owner.id)

    def test_transfer_by_non_owner_fails(self):
        """A non-owner (even an admin member) cannot transfer ownership."""
        self.client.force_authenticate(self.admin_member)
        r = self.client.post(self.url, {
            "new_owner_id": self.admin_member.id,
            "confirmation": self.group.name,
        })
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.group.refresh_from_db()
        self.assertEqual(self.group.owner_id, self.owner.id)

    def test_transfer_to_self_is_noop_or_error(self):
        """Transferring ownership to yourself should either succeed as a
        no-op (owner unchanged) or return a client error."""
        self.client.force_authenticate(self.owner)
        r = self.client.post(self.url, {
            "new_owner_id": self.owner.id,
            "confirmation": self.group.name,
        })
        # Either 200 (no-op) or 400 (explicit rejection) is acceptable
        self.assertIn(r.status_code, [status.HTTP_200_OK, status.HTTP_400_BAD_REQUEST])
        self.group.refresh_from_db()
        self.assertEqual(self.group.owner_id, self.owner.id)

    def test_wrong_confirmation_fails(self):
        """Incorrect confirmation text must be rejected."""
        self.client.force_authenticate(self.owner)
        r = self.client.post(self.url, {
            "new_owner_id": self.admin_member.id,
            "confirmation": "wrong name",
        })
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.group.refresh_from_db()
        self.assertEqual(self.group.owner_id, self.owner.id)

    def test_unauthenticated_request_rejected(self):
        """Unauthenticated users cannot call transfer-ownership."""
        anon = APIClient()
        r = anon.post(self.url, {
            "new_owner_id": self.admin_member.id,
            "confirmation": self.group.name,
        })
        self.assertIn(r.status_code, [status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN])

    @patch("boards.broadcast.broadcast_board_event")
    @patch("groups.views.transaction.on_commit", side_effect=lambda fn: fn())
    def test_broadcast_fired_after_successful_transfer(self, _mock_on_commit, mock_broadcast):
        """A group.updated broadcast must be emitted to all boards in the group (#694).

        transaction.on_commit() is patched to fire immediately because TestCase wraps
        each test in a savepoint rather than a real transaction, so on_commit callbacks
        would never execute without the patch.
        """
        from boards.models import Board, BoardMembership
        board = Board.objects.create(name="B", owner=self.owner, group=self.group)
        BoardMembership.objects.create(board=board, user=self.owner, role=BoardMembership.Role.ADMIN)

        self.client.force_authenticate(self.owner)
        r = self.client.post(self.url, {
            "new_owner_id": self.admin_member.id,
            "confirmation": self.group.name,
        })
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        mock_broadcast.assert_called_once_with(
            board.id, "group.updated", {"id": self.group.id, "owner_id": self.admin_member.id}
        )

    @patch("boards.broadcast.broadcast_board_event")
    def test_no_broadcast_on_failed_transfer(self, mock_broadcast):
        """No broadcast when the transfer is rejected (wrong confirmation)."""
        self.client.force_authenticate(self.owner)
        self.client.post(self.url, {
            "new_owner_id": self.admin_member.id,
            "confirmation": "wrong",
        })
        mock_broadcast.assert_not_called()
