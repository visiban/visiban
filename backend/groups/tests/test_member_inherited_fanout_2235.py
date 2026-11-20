"""Group member add and role change reach the subgroups that inherit the row (#2235).

A subgroup's members panel lists members inherited from its ancestors, so a
membership added or re-roled on a group also changes the row its descendants
list, when that membership is the row's source. Those descendants now get
``member.updated`` carrying the inherited row as the members endpoint lists
it (the #2175 payload: ``id: null``, ``is_inherited``, ``inherited_from``).
Descendants whose listing does not change (a direct row, or a nearer
membership) get nothing. The removal side is ``test_member_removed_subtree_2168``.
"""
import json
from unittest.mock import patch

from django.contrib.admin import site
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from rest_framework import status
from rest_framework.renderers import JSONRenderer
from rest_framework.test import APIClient

from accounts.models import User
from groups.admin import GroupAdmin
from groups.broadcast import broadcast_member_inherited_rows
from groups.invite_registration import _grant_membership
from groups.models import _GROUP_TRAVERSAL_MAX_DEPTH, Group, GroupInviteLink, GroupMembership


class _Tree(TestCase):
    """Root > Child > Grandchild > Great, plus Sibling under Root and an unrelated group."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner_2235", password="pw")
        self.member = User.objects.create_user(username="member_2235", password="pw")
        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        self.root = Group.objects.create(name="Root", owner=self.owner)
        self.child = Group.objects.create(name="Child", owner=self.owner, parent=self.root)
        self.grandchild = Group.objects.create(name="Grandchild", owner=self.owner, parent=self.child)
        self.great = Group.objects.create(name="Great", owner=self.owner, parent=self.grandchild)
        self.sibling = Group.objects.create(name="Sibling", owner=self.owner, parent=self.root)
        self.unrelated = Group.objects.create(name="Unrelated", owner=self.owner)
        for g in (self.root, self.child, self.unrelated):
            GroupMembership.objects.create(group=g, user=self.owner, role="admin")

    def _frames(self, send):
        return [(c.args[0], c.args[1], c.args[2]) for c in send.call_args_list]

    def _updated(self, frames):
        return {gid: p for gid, e, p in frames if e == "member.updated" and p.get("id") is None}

    def _members_row(self, group):
        resp = self.client.get(f"/api/v1/groups/{group.pk}/members/")
        self.assertEqual(resp.status_code, 200)
        return next(r for r in resp.json() if r["user"]["id"] == self.member.pk)


class RoleChangeFanOutTests(_Tree):
    def _patch_role(self, group, role):
        with patch("groups.broadcast.broadcast_group_event") as send:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.patch(
                    f"/api/v1/groups/{group.pk}/members/{self.member.pk}/", {"role": role}, format="json",
                )
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        return self._frames(send)

    def test_role_change_reaches_every_inheriting_descendant(self):
        GroupMembership.objects.create(group=self.root, user=self.member, role="member")
        frames = self._patch_role(self.root, "viewer")
        # The group's own frame is unchanged: the stored row, on its channel.
        own = [p for gid, e, p in frames if gid == self.root.pk]
        self.assertEqual(len(own), 1)
        self.assertEqual(own[0]["role"], "viewer")
        self.assertIsNotNone(own[0]["id"])
        updated = self._updated(frames)
        self.assertEqual(set(updated), {self.child.pk, self.grandchild.pk, self.great.pk, self.sibling.pk})
        for payload in updated.values():
            self.assertEqual(payload["role"], "viewer")
            self.assertTrue(payload["is_inherited"])
            self.assertEqual(payload["inherited_from"], "Root")
            self.assertEqual(payload["user"]["id"], self.member.pk)
            self.assertNotIn("has_all_content_access", payload)
        self.assertNotIn(self.unrelated.pk, {gid for gid, _, _ in frames})

    def test_payload_matches_the_members_endpoint_row(self):
        GroupMembership.objects.create(group=self.root, user=self.member, role="member")
        frames = self._patch_role(self.root, "collaborator")
        payload = self._updated(frames)[self.grandchild.pk]
        row = self._members_row(self.grandchild)
        row.pop("has_all_content_access", None)  # admin-reader only, never on the frame
        self.assertEqual(json.loads(JSONRenderer().render(payload)), row)

    def test_nearer_membership_shields_its_subtree(self):
        GroupMembership.objects.create(group=self.root, user=self.member, role="member")
        GroupMembership.objects.create(group=self.child, user=self.member, role="admin")
        frames = self._patch_role(self.root, "viewer")
        # Child lists the user directly; Grandchild and Great inherit from Child.
        self.assertEqual(set(self._updated(frames)), {self.sibling.pk})

    def test_nearer_row_with_an_unknown_role_does_not_shield(self):
        # An out-of-enum row on Child is listed on Child (direct) but is not an
        # inherited source (#1829), so Grandchild and Great inherit from Root.
        GroupMembership.objects.create(group=self.root, user=self.member, role="member")
        GroupMembership.objects.create(group=self.child, user=self.member, role="bogus")
        frames = self._patch_role(self.root, "viewer")
        self.assertEqual(
            set(self._updated(frames)), {self.grandchild.pk, self.great.pk, self.sibling.pk}
        )

    def test_role_change_on_a_subgroup_does_not_reach_parent_or_siblings(self):
        GroupMembership.objects.create(group=self.child, user=self.member, role="member")
        frames = self._patch_role(self.child, "viewer")
        self.assertEqual(set(self._updated(frames)), {self.grandchild.pk, self.great.pk})
        self.assertEqual({gid for gid, _, _ in frames}, {self.child.pk, self.grandchild.pk, self.great.pk})

    def test_leaf_group_sends_only_its_own_frame(self):
        GroupMembership.objects.create(group=self.great, user=self.member, role="member")
        GroupMembership.objects.create(group=self.great, user=self.owner, role="admin")
        frames = self._patch_role(self.great, "viewer")
        self.assertEqual([(gid, e) for gid, e, _ in frames], [(self.great.pk, "member.updated")])

    def test_fan_out_runs_only_after_commit(self):
        GroupMembership.objects.create(group=self.root, user=self.member, role="member")
        with patch("groups.broadcast.broadcast_group_event") as send:
            with self.captureOnCommitCallbacks(execute=False) as callbacks:
                resp = self.client.patch(
                    f"/api/v1/groups/{self.root.pk}/members/{self.member.pk}/", {"role": "viewer"},
                    format="json",
                )
            self.assertEqual(resp.status_code, 200)
            send.assert_not_called()
            for callback in callbacks:
                callback()
        self.assertIn(self.child.pk, self._updated(self._frames(send)))


class AddFanOutTests(_Tree):
    def test_joining_by_invite_reaches_the_descendants(self):
        link, token = GroupInviteLink.generate(group=self.root, created_by=self.owner, role="member")
        client = APIClient()
        client.force_authenticate(self.member)
        with patch("groups.broadcast.broadcast_group_event") as send:
            with self.captureOnCommitCallbacks(execute=True):
                resp = client.post(f"/api/v1/groups/join/{token}/")
        self.assertIn(resp.status_code, (200, 201), resp.content)
        frames = self._frames(send)
        self.assertEqual([gid for gid, e, _ in frames if e == "member.added"], [self.root.pk])
        updated = self._updated(frames)
        self.assertEqual(set(updated), {self.child.pk, self.grandchild.pk, self.great.pk, self.sibling.pk})
        self.assertEqual(updated[self.child.pk]["role"], "member")
        self.assertEqual(updated[self.child.pk]["inherited_from"], "Root")
        row = self._members_row(self.child)
        row.pop("has_all_content_access", None)
        self.assertEqual(json.loads(JSONRenderer().render(updated[self.child.pk])), row)

    def test_rejoining_sends_nothing(self):
        GroupMembership.objects.create(group=self.root, user=self.member, role="member")
        link, token = GroupInviteLink.generate(group=self.root, created_by=self.owner, role="member")
        client = APIClient()
        client.force_authenticate(self.member)
        with patch("groups.broadcast.broadcast_group_event") as send:
            with self.captureOnCommitCallbacks(execute=True):
                client.post(f"/api/v1/groups/join/{token}/")
        send.assert_not_called()

    def test_registration_grant_reaches_the_descendants(self):
        link, _ = GroupInviteLink.generate(group=self.child, created_by=self.owner, role="viewer")
        with patch("groups.broadcast.broadcast_group_event") as send:
            with self.captureOnCommitCallbacks(execute=True):
                _grant_membership(link, self.member)
        frames = self._frames(send)
        self.assertEqual([gid for gid, e, _ in frames if e == "member.added"], [self.child.pk])
        updated = self._updated(frames)
        self.assertEqual(set(updated), {self.grandchild.pk, self.great.pk})
        self.assertEqual(updated[self.great.pk]["role"], "viewer")
        self.assertEqual(updated[self.great.pk]["inherited_from"], "Child")

    def test_add_below_an_existing_farther_row_replaces_that_source(self):
        # Listed on Grandchild inherited from Root before; Child is now nearer.
        GroupMembership.objects.create(group=self.root, user=self.member, role="viewer")
        link, _ = GroupInviteLink.generate(group=self.child, created_by=self.owner, role="collaborator")
        with patch("groups.broadcast.broadcast_group_event") as send:
            with self.captureOnCommitCallbacks(execute=True):
                _grant_membership(link, self.member)
        updated = self._updated(self._frames(send))
        self.assertEqual(set(updated), {self.grandchild.pk, self.great.pk})
        self.assertEqual({p["inherited_from"] for p in updated.values()}, {"Child"})


class HelperTests(_Tree):
    def _count_queries(self):
        with patch("groups.broadcast.broadcast_group_event") as send:
            with CaptureQueriesContext(connection) as ctx:
                broadcast_member_inherited_rows(self.root.pk, self.member.pk)
        return len(ctx.captured_queries), send.call_count

    def test_cost_is_bounded_by_depth_not_breadth(self):
        GroupMembership.objects.create(group=self.root, user=self.member, role="member")
        for i in range(3):
            Group.objects.create(name=f"Leaf {i}", owner=self.owner, parent=self.great)
        queries, frames = self._count_queries()
        # Four subtree levels plus the empty fifth, the memberships, the name, the user.
        self.assertEqual(queries, 5 + 3)
        self.assertLessEqual(queries, _GROUP_TRAVERSAL_MAX_DEPTH + 4)
        self.assertEqual(frames, 4 + 3)
        for i in range(10):
            Group.objects.create(name=f"Wide {i}", owner=self.owner, parent=self.child)
            Group.objects.create(name=f"Wider {i}", owner=self.owner, parent=self.great)
        more_queries, more_frames = self._count_queries()
        self.assertEqual(more_queries, queries)
        self.assertEqual(more_frames, frames + 20)

    def test_fan_out_is_capped_and_logged(self):
        GroupMembership.objects.create(group=self.root, user=self.member, role="member")
        with patch("groups.broadcast.INHERITED_ROW_FANOUT_MAX", 2), \
             patch("groups.broadcast.broadcast_group_event") as send, \
             self.assertLogs("groups.broadcast", level="WARNING") as logs:
            broadcast_member_inherited_rows(self.root.pk, self.member.pk)
        # The lowest ids first: child, then grandchild (created in that order).
        self.assertEqual([c.args[0] for c in send.call_args_list], [self.child.pk, self.grandchild.pk])
        self.assertIn("capped", "\n".join(logs.output))
        self.assertNotIn(self.member.username, "\n".join(logs.output))

    def test_no_subgroups_costs_one_query(self):
        GroupMembership.objects.create(group=self.unrelated, user=self.member, role="member")
        with patch("groups.broadcast.broadcast_group_event") as send:
            with self.assertNumQueries(1):
                broadcast_member_inherited_rows(self.unrelated.pk, self.member.pk)
        send.assert_not_called()

    def test_fan_out_stops_at_the_inheritance_depth_cap(self):
        # A descendant deeper than the cap cannot inherit from the group
        # (Group.ancestors() stops there), so it is neither read nor told.
        GroupMembership.objects.create(group=self.root, user=self.member, role="member")
        node = self.great  # depth 3 below root
        chain = []
        for i in range(_GROUP_TRAVERSAL_MAX_DEPTH):
            node = Group.objects.create(name=f"Deep {i}", owner=self.owner, parent=node)
            chain.append(node)
        with patch("groups.broadcast.broadcast_group_event") as send:
            broadcast_member_inherited_rows(self.root.pk, self.member.pk)
        told = {c.args[0] for c in send.call_args_list}
        within = [g for i, g in enumerate(chain) if 3 + i + 1 <= _GROUP_TRAVERSAL_MAX_DEPTH]
        beyond = [g for g in chain if g not in within]
        self.assertTrue(within and beyond)
        self.assertTrue({g.pk for g in within} <= told)
        self.assertFalse({g.pk for g in beyond} & told)
        # Each told descendant lists the row on its members endpoint.
        self.assertEqual(self._members_row(within[-1])["inherited_from"], "Root")

    def test_membership_gone_after_commit_sends_nothing(self):
        # Absent input: no row on the group (removed meanwhile) means no source.
        with patch("groups.broadcast.broadcast_group_event") as send:
            broadcast_member_inherited_rows(self.root.pk, self.member.pk)
        send.assert_not_called()

    def test_membership_with_an_unknown_role_sends_nothing(self):
        GroupMembership.objects.create(group=self.root, user=self.member, role="bogus")
        with patch("groups.broadcast.broadcast_group_event") as send:
            broadcast_member_inherited_rows(self.root.pk, self.member.pk)
        send.assert_not_called()

    def test_failed_lookup_is_logged_and_swallowed(self):
        GroupMembership.objects.create(group=self.root, user=self.member, role="member")
        with patch("groups.broadcast.broadcast_group_event") as send, \
             patch("groups.models.GroupMembership.objects.filter", side_effect=RuntimeError("db down")), \
             self.assertLogs("groups.broadcast", level="WARNING") as logs:
            broadcast_member_inherited_rows(self.root.pk, self.member.pk)
        send.assert_not_called()
        self.assertIn("RuntimeError", "\n".join(logs.output))
        self.assertNotIn("db down", "\n".join(logs.output))

    def test_failed_user_lookup_is_logged_and_swallowed(self):
        GroupMembership.objects.create(group=self.root, user=self.member, role="member")
        with patch("groups.broadcast.broadcast_group_event") as send, \
             patch("accounts.models.User.objects.get", side_effect=RuntimeError("db down")), \
             self.assertLogs("groups.broadcast", level="WARNING") as logs:
            broadcast_member_inherited_rows(self.root.pk, self.member.pk)
        send.assert_not_called()
        self.assertIn("RuntimeError", "\n".join(logs.output))


class OwnershipTransferFanOutTests(_Tree):
    """A transfer re-roles the new and previous owner on the group (both admins after it)."""

    def setUp(self):
        super().setUp()
        GroupMembership.objects.create(group=self.root, user=self.member, role="admin")

    def _frames_all(self, send):
        # Several frames can share one channel here (one per user), so keep them all.
        return [(c.args[0], c.args[2]) for c in send.call_args_list if c.args[1] == "member.updated"]

    def test_api_transfer_reaches_the_inheriting_subgroups(self):
        with patch("groups.broadcast.broadcast_group_event") as send:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.post(
                    f"/api/v1/groups/{self.root.pk}/transfer-ownership/",
                    {"new_owner_id": self.member.pk, "confirmation": "Root"}, format="json",
                )
        self.assertEqual(resp.status_code, 200, resp.content)
        by_user = {}
        for gid, payload in self._frames_all(send):
            self.assertIsNone(payload["id"])
            self.assertEqual(payload["role"], "admin")
            by_user.setdefault(payload["user"]["id"], set()).add(gid)
        self.assertEqual(
            by_user[self.member.pk], {self.child.pk, self.grandchild.pk, self.great.pk, self.sibling.pk}
        )
        # The previous owner's direct Child row shields Child's subtree.
        self.assertEqual(by_user[self.owner.pk], {self.sibling.pk})

    def test_django_admin_action_end_to_end_reaches_new_and_previous_owner(self):
        """Posts the real admin action, so a dropped id in `member_ids` fails here."""
        from django.contrib.admin.helpers import ACTION_CHECKBOX_NAME
        from django.test import override_settings
        from django.urls import reverse

        root_user = User.objects.create_user(
            username="su_2235", password="pw", is_staff=True, is_superuser=True
        )
        client = self.client_class()
        client.force_login(root_user)
        plain = override_settings(STORAGES={
            "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
            "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
        })
        with plain, patch("groups.broadcast.broadcast_group_event") as send:
            with self.captureOnCommitCallbacks(execute=True):
                resp = client.post(
                    reverse("admin:groups_group_changelist"),
                    {
                        "action": "transfer_ownership",
                        ACTION_CHECKBOX_NAME: [self.root.pk],
                        "step": "confirm",
                        "expected_owner": self.owner.pk,
                        "new_owner": self.member.pk,
                    },
                    follow=True,
                )
        self.assertEqual(resp.status_code, 200)
        self.root.refresh_from_db()
        self.assertEqual(self.root.owner_id, self.member.pk)
        by_user = {}
        for gid, payload in self._frames_all(send):
            by_user.setdefault(payload["user"]["id"], set()).add(gid)
        self.assertEqual(
            by_user[self.member.pk], {self.child.pk, self.grandchild.pk, self.great.pk, self.sibling.pk}
        )
        # The previous owner's direct Child row shields Child's subtree.
        self.assertEqual(by_user[self.owner.pk], {self.sibling.pk})

    def test_django_admin_transfer_reaches_the_inheriting_subgroups(self):
        with patch("groups.broadcast.broadcast_group_event") as send:
            with self.captureOnCommitCallbacks(execute=True):
                GroupAdmin(Group, site)._broadcast_after_commit(
                    self.root.pk, actor_id=self.owner.pk, member_ids=(self.member.pk,),
                )
        events = [c.args[1] for c in send.call_args_list]
        self.assertEqual(events[0], "group.updated")
        self.assertEqual(
            {gid for gid, _ in self._frames_all(send)},
            {self.child.pk, self.grandchild.pk, self.great.pk, self.sibling.pk},
        )
