"""Deactivating a user with an owner transfer announces the new owner (#1741).

The transfer rewrites ``Board.owner`` with a queryset UPDATE, and ``owner`` is a
``BoardSerializer`` field. Each transferred board must get ``board.updated`` on
its board channel (persisted to the change feed) and, when it is in a group, on
that group's channel, rendered with the new owner, after commit only.
"""
from unittest.mock import patch

from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.broadcast import EVT_BOARD_UPDATED
from boards.models import Board, BoardEvent, BoardMembership
from groups.models import Group, GroupMembership

PW = "pw123456!x"


class DeactivateOwnerTransferBroadcastTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(
            username="admin_1741", password=PW, is_staff=True, is_superuser=True,
        )
        self.client = APIClient()
        self.client.force_authenticate(self.admin)
        self.owner = User.objects.create_user(username="owner_1741", password=PW)
        self.heir = User.objects.create_user(username="heir_1741", password=PW)

        self.personal = Board.objects.create(name="Personal", owner=self.owner)
        BoardMembership.objects.create(board=self.personal, user=self.heir, role="member")

        self.group = Group.objects.create(name="Team", owner=self.heir)
        GroupMembership.objects.create(group=self.group, user=self.heir, role="admin")
        self.grouped = Board.objects.create(name="Grouped", owner=self.owner, group=self.group)

        # Not the deactivated user's: must not be announced.
        self.other = Board.objects.create(name="Other", owner=self.heir)

    def _deactivate(self, transfers):
        return self.client.post(
            f"/api/v1/admin/users/{self.owner.pk}/deactivate/", {"transfers": transfers}, format="json",
        )

    def _transfers(self):
        return [
            {"board_id": self.personal.pk, "transfer_to": self.heir.pk},
            {"board_id": self.grouped.pk, "transfer_to": self.heir.pk},
        ]

    def test_transfer_broadcasts_board_updated_with_new_owner(self):
        with patch("boards.broadcast.broadcast_board_event") as board_send, \
             patch("groups.broadcast.broadcast_group_event") as group_send, \
             self.captureOnCommitCallbacks(execute=True):
            resp = self._deactivate(self._transfers())
        self.assertEqual(resp.status_code, 200, resp.content)

        updates = [c for c in board_send.call_args_list if c.args[1] == EVT_BOARD_UPDATED]
        by_board = {c.args[0]: c for c in updates}
        self.assertEqual(set(by_board), {self.personal.pk, self.grouped.pk})
        for call in updates:
            self.assertEqual(call.args[2]["owner"]["id"], self.heir.pk)
            self.assertEqual(call.kwargs["actor_id"], self.admin.pk)
            self.assertIsNotNone(call.kwargs["event_id"])

        group_updates = [c for c in group_send.call_args_list if c.args[1] == EVT_BOARD_UPDATED]
        self.assertEqual([c.args[0] for c in group_updates], [self.group.pk])
        self.assertEqual(group_updates[0].args[2]["id"], self.grouped.pk)
        self.assertEqual(group_updates[0].args[2]["owner"]["id"], self.heir.pk)

        # Persisted to the change feed, so a reconnecting client catches up.
        persisted = BoardEvent.objects.filter(event=EVT_BOARD_UPDATED)
        self.assertEqual(
            sorted(persisted.values_list("board_id", flat=True)), sorted([self.personal.pk, self.grouped.pk]),
        )
        self.assertFalse(persisted.filter(board_id=self.other.pk).exists())

    def test_nothing_sent_before_commit(self):
        with patch("boards.broadcast.broadcast_board_event") as board_send, \
             patch("groups.broadcast.broadcast_group_event") as group_send, \
             self.captureOnCommitCallbacks(execute=False):
            self._deactivate(self._transfers())
        board_send.assert_not_called()
        group_send.assert_not_called()

    def test_refused_deactivation_announces_nothing(self):
        outsider = User.objects.create_user(username="outsider_1741", password=PW)
        with patch("boards.broadcast.broadcast_board_event") as board_send, \
             patch("groups.broadcast.broadcast_group_event") as group_send, \
             self.captureOnCommitCallbacks(execute=True):
            resp = self._deactivate([
                {"board_id": self.personal.pk, "transfer_to": self.heir.pk},
                {"board_id": self.grouped.pk, "transfer_to": outsider.pk},
            ])
        self.assertEqual(resp.status_code, 400)
        board_send.assert_not_called()
        group_send.assert_not_called()
        self.assertFalse(BoardEvent.objects.filter(event=EVT_BOARD_UPDATED).exists())
