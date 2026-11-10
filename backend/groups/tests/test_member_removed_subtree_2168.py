"""Group ``member.removed`` reaches the subgroups that listed the member as inherited (#2168).

A subgroup's members panel lists members inherited from its ancestors and
refetches only on its own channel, so removing a user from a group must
announce ``member.removed`` on every descendant channel that no longer lists
the user. Descendants that still list the user get no frame:
``GroupConsumer`` closes the socket of the user a ``member.removed`` names.
"""
from unittest.mock import patch

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from groups.broadcast import broadcast_member_removed
from groups.models import Group, GroupMembership


class MemberRemovedSubtreeFanOutTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner_2168", password="pw")
        self.member = User.objects.create_user(username="member_2168", password="pw")
        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        # root > child > grandchild, plus a sibling of root's child.
        self.root = Group.objects.create(name="Root", owner=self.owner)
        GroupMembership.objects.create(group=self.root, user=self.owner, role="admin")
        self.child = Group.objects.create(name="Child", owner=self.owner, parent=self.root)
        self.grandchild = Group.objects.create(name="Grandchild", owner=self.owner, parent=self.child)
        self.sibling = Group.objects.create(name="Sibling", owner=self.owner, parent=self.root)
        self.unrelated = Group.objects.create(name="Unrelated", owner=self.owner)
        GroupMembership.objects.create(group=self.root, user=self.member, role="member")

    def _remove(self, group):
        with patch("groups.broadcast.broadcast_group_event") as send:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.delete(f"/api/v1/groups/{group.pk}/members/{self.member.pk}/")
        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        return [(c.args[0], c.args[1], c.args[2]) for c in send.call_args_list]

    def _removed_channels(self, frames):
        return {
            gid for gid, event, payload in frames
            if event == "member.removed" and payload == {"user_id": self.member.pk}
        }

    def test_removal_reaches_every_descendant_channel(self):
        frames = self._remove(self.root)
        self.assertEqual(
            self._removed_channels(frames),
            {self.root.pk, self.child.pk, self.grandchild.pk, self.sibling.pk},
        )
        # The payload shape is unchanged on every channel (public WS contract).
        for _, event, payload in frames:
            if event == "member.removed":
                self.assertEqual(payload, {"user_id": self.member.pk})

    def test_descendant_where_user_keeps_access_gets_no_frame(self):
        # A direct membership on the child keeps the child and grandchild.
        GroupMembership.objects.create(group=self.child, user=self.member, role="member")
        frames = self._remove(self.root)
        self.assertEqual(self._removed_channels(frames), {self.root.pk, self.sibling.pk})

    def test_removal_from_subgroup_does_not_reach_parent_or_siblings(self):
        GroupMembership.objects.filter(group=self.root, user=self.member).delete()
        GroupMembership.objects.create(group=self.child, user=self.member, role="member")
        frames = self._remove(self.child)
        self.assertEqual(self._removed_channels(frames), {self.child.pk, self.grandchild.pk})

    def test_access_through_an_ancestor_of_the_removed_group_keeps_the_subtree(self):
        GroupMembership.objects.create(group=self.child, user=self.member, role="member")
        frames = self._remove(self.child)
        # Still a root member: the child's own channel gets the frame as before
        # (#1051), the grandchild keeps listing them through root and gets none.
        # Known gap #2175: had the child row carried a different role, the
        # grandchild's inherited row would now show root's, with no frame.
        self.assertEqual(self._removed_channels(frames), {self.child.pk})

    def test_all_content_member_is_announced_on_every_descendant(self):
        # can_access_all_content grants access to every group but is not a row
        # in a members panel: the subgroups listed this user only through root.
        self.member.can_access_all_content = True
        self.member.save(update_fields=["can_access_all_content"])
        frames = self._remove(self.root)
        self.assertEqual(
            self._removed_channels(frames),
            {self.root.pk, self.child.pk, self.grandchild.pk, self.sibling.pk},
        )

    def test_all_content_member_still_listed_through_a_membership_gets_no_frame(self):
        self.member.can_access_all_content = True
        self.member.save(update_fields=["can_access_all_content"])
        GroupMembership.objects.create(group=self.child, user=self.member, role="member")
        frames = self._remove(self.root)
        self.assertEqual(self._removed_channels(frames), {self.root.pk, self.sibling.pk})

    def test_subtree_lookup_is_constant_in_descendant_count(self):
        for i in range(5):
            Group.objects.create(name=f"Leaf {i}", owner=self.owner, parent=self.grandchild)
        GroupMembership.objects.filter(group=self.root, user=self.member).delete()
        subtree = set(Group.objects.exclude(pk=self.unrelated.pk).values_list("pk", flat=True))
        with patch("groups.broadcast.broadcast_group_event") as send:
            # descendant groups (one JOINed query) + the user's memberships.
            with self.assertNumQueries(2):
                broadcast_member_removed(self.root.pk, self.member.pk, subtree)
        # root, then child, grandchild, sibling and the five leaves.
        self.assertEqual(send.call_count, 1 + 3 + 5)

    def test_deleted_user_is_announced_on_every_descendant(self):
        uid = self.member.pk
        self.member.delete()
        with patch("groups.broadcast.broadcast_group_event") as send:
            broadcast_member_removed(self.root.pk, uid, {self.root.pk, self.child.pk})
        self.assertEqual(
            [c.args[0] for c in send.call_args_list], [self.root.pk, self.child.pk]
        )

    def test_failed_lookup_is_logged_and_swallowed(self):
        with patch("groups.broadcast.broadcast_group_event") as send, \
             patch("groups.models.GroupMembership.objects.filter", side_effect=RuntimeError("db down")), \
             self.assertLogs("groups.broadcast", level="WARNING") as logs:
            broadcast_member_removed(self.root.pk, self.member.pk, {self.child.pk})
        # The removed group's own frame was already sent.
        self.assertEqual([c.args[0] for c in send.call_args_list], [self.root.pk])
        self.assertIn("RuntimeError", "\n".join(logs.output))
        self.assertNotIn("db down", "\n".join(logs.output))
