"""Group ``member.removed`` reaches the subgroups that listed the member as inherited (#2168).

A subgroup's members panel lists members inherited from its ancestors and
refetches only on its own channel, so removing a user from a group must
announce ``member.removed`` on every descendant channel that no longer lists
the user. Descendants that still list the user get no frame:
``GroupConsumer`` closes the socket of the user a ``member.removed`` names.
"""
import json
from unittest.mock import patch

from django.test import TestCase
from rest_framework import status
from rest_framework.renderers import JSONRenderer
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
        # (#1051), the grandchild keeps listing them through root and gets no
        # member.removed (it would close their socket). Its inherited row's
        # source changed from Child to Root, so it gets member.updated (#2175).
        self.assertEqual(self._removed_channels(frames), {self.child.pk})
        updated = [(gid, p) for gid, e, p in frames if e == "member.updated"]
        self.assertEqual([gid for gid, _ in updated], [self.grandchild.pk])
        self.assertEqual(updated[0][1]["inherited_from"], "Root")

    def test_ancestor_row_with_an_unknown_role_does_not_keep_the_subtree(self):
        # The members panel lists an inherited row only when its role is a
        # known GroupMembership.Role (#1829), so a stale root row must not
        # suppress the grandchild's frame.
        GroupMembership.objects.filter(group=self.root, user=self.member).update(role="bogus")
        GroupMembership.objects.create(group=self.child, user=self.member, role="member")
        frames = self._remove(self.child)
        self.assertEqual(self._removed_channels(frames), {self.child.pk, self.grandchild.pk})

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


class MemberRemovedInheritedRowUpdatedTests(TestCase):
    """A subgroup that keeps the user through a farther ancestor gets member.updated (#2175).

    Root > Child > Grandchild; the user is a member of Root and an admin of
    Child. Removing them from Child leaves Grandchild listing them inherited
    from Root as member, where it listed Child / admin.
    """

    def setUp(self):
        self.owner = User.objects.create_user(username="owner_2175", password="pw")
        self.member = User.objects.create_user(username="member_2175", password="pw")
        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        self.root = Group.objects.create(name="Root", owner=self.owner)
        GroupMembership.objects.create(group=self.root, user=self.owner, role="admin")
        self.child = Group.objects.create(name="Child", owner=self.owner, parent=self.root)
        self.grandchild = Group.objects.create(name="Grandchild", owner=self.owner, parent=self.child)
        self.great = Group.objects.create(name="Great", owner=self.owner, parent=self.grandchild)
        # The owner's own Child row keeps Child from losing its last admin.
        GroupMembership.objects.create(group=self.child, user=self.owner, role="admin")
        self.root_row = GroupMembership.objects.create(group=self.root, user=self.member, role="member")
        GroupMembership.objects.create(group=self.child, user=self.member, role="admin")

    def _remove(self, group):
        with patch("groups.broadcast.broadcast_group_event") as send:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.delete(f"/api/v1/groups/{group.pk}/members/{self.member.pk}/")
        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT, resp.content)
        return [(c.args[0], c.args[1], c.args[2]) for c in send.call_args_list]

    def _members_row(self, group):
        resp = self.client.get(f"/api/v1/groups/{group.pk}/members/")
        self.assertEqual(resp.status_code, 200)
        return next(r for r in resp.json() if r["user"]["id"] == self.member.pk)

    def test_descendants_get_member_updated_with_their_new_inherited_row(self):
        frames = self._remove(self.child)
        updated = {gid: p for gid, e, p in frames if e == "member.updated"}
        self.assertEqual(set(updated), {self.grandchild.pk, self.great.pk})
        removed = {gid for gid, e, _ in frames if e == "member.removed"}
        self.assertEqual(removed, {self.child.pk})
        for gid in (self.grandchild.pk, self.great.pk):
            payload = updated[gid]
            self.assertEqual(payload["id"], None)
            self.assertTrue(payload["is_inherited"])
            self.assertEqual(payload["inherited_from"], "Root")
            self.assertEqual(payload["role"], "member")
            self.assertEqual(payload["user"]["id"], self.member.pk)
            # Goes to every subscriber, so never the admin-only key.
            self.assertNotIn("has_all_content_access", payload)

    def test_payload_matches_the_members_endpoint_row(self):
        frames = self._remove(self.child)
        payload = next(p for gid, e, p in frames if e == "member.updated" and gid == self.grandchild.pk)
        row = self._members_row(self.grandchild)
        row.pop("has_all_content_access", None)  # admin-reader only, never on the frame
        rendered = json.loads(JSONRenderer().render(payload))
        self.assertEqual(rendered, row)

    def test_nearer_source_below_the_removed_group_gets_no_frame(self):
        # A direct row on Grandchild keeps Grandchild listing it directly and
        # Great inheriting from Grandchild, so neither listing changes.
        GroupMembership.objects.create(group=self.grandchild, user=self.member, role="viewer")
        frames = self._remove(self.child)
        self.assertEqual(
            [(gid, e) for gid, e, _ in frames], [(self.child.pk, "member.removed")]
        )

    def test_removing_the_farther_row_leaves_the_nearer_source_alone(self):
        # Removing Root's row: Grandchild still lists the user from Child,
        # which was already its source, so nothing changes below Child.
        frames = self._remove(self.root)
        self.assertEqual(
            [(gid, e) for gid, e, _ in frames], [(self.root.pk, "member.removed")]
        )

    def test_removed_row_with_an_unknown_role_sends_no_update(self):
        # An out-of-enum row listed nothing (#1829), so it was nobody's source.
        self.assertEqual(
            self._updated_targets(removed_role="bogus"), []
        )
        self.assertEqual(
            self._updated_targets(removed_role="admin"), [self.grandchild.pk, self.great.pk]
        )
        self.assertEqual(
            self._updated_targets(removed_role=None), [self.grandchild.pk, self.great.pk]
        )

    def _updated_targets(self, *, removed_role):
        GroupMembership.objects.filter(group=self.child, user=self.member).delete()
        subtree = {self.child.pk, self.grandchild.pk, self.great.pk}
        with patch("groups.broadcast.broadcast_group_event") as send:
            broadcast_member_removed(self.child.pk, self.member.pk, subtree, removed_role=removed_role)
        return [c.args[0] for c in send.call_args_list if c.args[1] == "member.updated"]

    def test_update_costs_one_query_for_the_user(self):
        for i in range(4):
            Group.objects.create(name=f"Leaf {i}", owner=self.owner, parent=self.great)
        GroupMembership.objects.filter(group=self.child, user=self.member).delete()
        subtree = set(
            Group.objects.exclude(pk__in=[self.root.pk]).values_list("pk", flat=True)
        )
        with patch("groups.broadcast.broadcast_group_event") as send:
            # descendant groups + the user's memberships + the user.
            with self.assertNumQueries(3):
                broadcast_member_removed(self.child.pk, self.member.pk, subtree, removed_role="admin")
        updated = [c for c in send.call_args_list if c.args[1] == "member.updated"]
        self.assertEqual(len(updated), 2 + 4)

    def test_failed_user_lookup_is_logged_and_swallowed(self):
        GroupMembership.objects.filter(group=self.child, user=self.member).delete()
        with patch("groups.broadcast.broadcast_group_event") as send, \
             patch("accounts.models.User.objects.get", side_effect=RuntimeError("db down")), \
             self.assertLogs("groups.broadcast", level="WARNING") as logs:
            broadcast_member_removed(self.child.pk, self.member.pk, {self.grandchild.pk})
        self.assertEqual([c.args[1] for c in send.call_args_list], ["member.removed"])
        self.assertIn("RuntimeError", "\n".join(logs.output))
        self.assertNotIn("db down", "\n".join(logs.output))
