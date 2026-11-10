"""A group delete announces what its SET_NULL and CASCADE changed (#1742).

``Board.group`` is ``SET_NULL`` and ``Group.parent`` is ``CASCADE``. Deleting a
group must, after commit only:

- send ``group.deleted`` for the group (its channel and its parent's), and for
  every cascaded subgroup on that subgroup's own channel;
- record ``board.updated`` (persisted, actor = the deleter) for every board in
  the subtree, rendered after the clear (``group`` null).
"""
from unittest.mock import patch

from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.broadcast import EVT_BOARD_UPDATED
from boards.models import Board, BoardEvent
from groups.broadcast import EVT_GROUP_DELETED
from groups.models import Group, GroupMembership

PW = "pw123456!x"


class GroupDeleteCascadeBroadcastTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner_1742", password=PW)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

        def group(name, parent=None):
            g = Group.objects.create(name=name, owner=self.owner, parent=parent)
            GroupMembership.objects.create(group=g, user=self.owner, role="admin")
            return g

        self.top = group("Top")
        self.root = group("Root", parent=self.top)
        self.target = group("Target", parent=self.root)
        self.child = group("Child", parent=self.target)
        self.grandchild = group("Grandchild", parent=self.child)
        self.sibling = group("Sibling", parent=self.root)

        self.b_target = Board.objects.create(name="T", owner=self.owner, group=self.target)
        self.b_grandchild = Board.objects.create(name="GC", owner=self.owner, group=self.grandchild)
        self.b_sibling = Board.objects.create(name="S", owner=self.owner, group=self.sibling)

    def _delete(self):
        return self.client.delete(f"/api/v1/groups/{self.target.pk}/")

    def test_delete_announces_subgroups_and_orphaned_boards(self):
        with patch("boards.broadcast.broadcast_board_event") as board_send, \
             patch("groups.broadcast.broadcast_group_event") as group_send, \
             self.captureOnCommitCallbacks(execute=True):
            resp = self._delete()
        self.assertEqual(resp.status_code, 204, resp.content)

        deleted = [(c.args[0], c.args[2]["id"]) for c in group_send.call_args_list
                   if c.args[1] == EVT_GROUP_DELETED]
        self.assertCountEqual(deleted, [
            (self.target.pk, self.target.pk),
            (self.root.pk, self.target.pk),
            (self.top.pk, self.target.pk),
            (self.child.pk, self.child.pk),
            (self.grandchild.pk, self.grandchild.pk),
        ])

        updates = {c.args[0]: c for c in board_send.call_args_list if c.args[1] == EVT_BOARD_UPDATED}
        self.assertEqual(set(updates), {self.b_target.pk, self.b_grandchild.pk})
        for call in updates.values():
            self.assertIsNone(call.args[2]["group"])
            self.assertIsNone(call.args[2]["group_name"])
            self.assertEqual(call.kwargs["actor_id"], self.owner.pk)
            self.assertIsNotNone(call.kwargs["event_id"])

        persisted = BoardEvent.objects.filter(event=EVT_BOARD_UPDATED)
        self.assertCountEqual(
            persisted.values_list("board_id", flat=True), [self.b_target.pk, self.b_grandchild.pk],
        )
        self.assertFalse(Group.objects.filter(pk__in=[self.child.pk, self.grandchild.pk]).exists())

    def test_nothing_sent_before_commit(self):
        with patch("boards.broadcast.broadcast_board_event") as board_send, \
             patch("groups.broadcast.broadcast_group_event") as group_send, \
             self.captureOnCommitCallbacks(execute=False):
            self._delete()
        board_send.assert_not_called()
        group_send.assert_not_called()

    def test_leaf_group_without_boards_sends_only_its_own_delete(self):
        with patch("boards.broadcast.broadcast_board_event") as board_send, \
             patch("groups.broadcast.broadcast_group_event") as group_send, \
             self.captureOnCommitCallbacks(execute=True):
            resp = self.client.delete(f"/api/v1/groups/{self.sibling.pk}/")
        self.assertEqual(resp.status_code, 204)
        self.assertCountEqual(
            [c.args[0] for c in group_send.call_args_list if c.args[1] == EVT_GROUP_DELETED],
            [self.sibling.pk, self.root.pk, self.top.pk],
        )
        # The sibling's one board lost its group.
        self.assertEqual(
            [c.args[0] for c in board_send.call_args_list if c.args[1] == EVT_BOARD_UPDATED],
            [self.b_sibling.pk],
        )

    def test_grandparent_channel_hears_the_delete(self):
        with patch("boards.broadcast.broadcast_board_event"), \
             patch("groups.broadcast.broadcast_group_event") as group_send, \
             self.captureOnCommitCallbacks(execute=True):
            self._delete()
        self.assertIn(
            (self.top.pk, {"id": self.target.pk}),
            [(c.args[0], c.args[2]) for c in group_send.call_args_list if c.args[1] == EVT_GROUP_DELETED],
        )
