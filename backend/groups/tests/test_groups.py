"""Tests for GroupViewSet, GroupMembership management, invite links, and JoinGroupView."""
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from groups.models import Group, GroupMembership, GroupInviteLink


def _make_group(owner, name="Group", parent=None):
    group = Group.objects.create(name=name, owner=owner, parent=parent)
    GroupMembership.objects.create(group=group, user=owner, role=GroupMembership.Role.ADMIN)
    return group


class GroupCRUDTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.other = User.objects.create_user(username="other", password="pass")
        self.group = _make_group(self.owner)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def test_list_groups_returns_owned_group(self):
        r = self.client.get("/api/groups/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        ids = [g["id"] for g in r.json()]
        self.assertIn(self.group.id, ids)

    def test_create_group(self):
        r = self.client.post("/api/groups/", {"name": "New Group"})
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertTrue(Group.objects.filter(name="New Group", owner=self.owner).exists())

    def test_create_group_auto_creates_admin_membership(self):
        r = self.client.post("/api/groups/", {"name": "Auto Admin"})
        group = Group.objects.get(id=r.json()["id"])
        self.assertTrue(
            GroupMembership.objects.filter(group=group, user=self.owner, role=GroupMembership.Role.ADMIN).exists()
        )

    def test_create_subgroup_requires_parent_admin(self):
        self.client.force_authenticate(self.other)
        r = self.client.post("/api/groups/", {"name": "Sub", "parent": self.group.id})
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_400_BAD_REQUEST])

    def test_owner_can_delete_group(self):
        r = self.client.delete(f"/api/groups/{self.group.id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(Group.objects.filter(pk=self.group.id).exists())

    def test_non_owner_cannot_delete_group(self):
        self.client.force_authenticate(self.other)
        r = self.client.delete(f"/api/groups/{self.group.id}/")
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND])

    def test_other_user_cannot_see_group(self):
        self.client.force_authenticate(self.other)
        r = self.client.get("/api/groups/")
        ids = [g["id"] for g in r.json()]
        self.assertNotIn(self.group.id, ids)


class GroupMembersTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="pass")
        self.member = User.objects.create_user(username="member", password="pass")
        self.group = _make_group(self.admin)
        GroupMembership.objects.create(group=self.group, user=self.member, role=GroupMembership.Role.MEMBER)
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def test_list_members(self):
        r = self.client.get(f"/api/groups/{self.group.id}/members/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        user_ids = [m["user"]["id"] for m in r.json()]
        self.assertIn(self.member.id, user_ids)

    def test_update_member_role(self):
        r = self.client.patch(
            f"/api/groups/{self.group.id}/members/{self.member.id}/",
            {"role": "admin"},
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(
            GroupMembership.objects.get(group=self.group, user=self.member).role,
            GroupMembership.Role.ADMIN,
        )

    def test_remove_member(self):
        r = self.client.delete(f"/api/groups/{self.group.id}/members/{self.member.id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(
            GroupMembership.objects.filter(group=self.group, user=self.member).exists()
        )

    def test_invalid_role_returns_400(self):
        r = self.client.patch(
            f"/api/groups/{self.group.id}/members/{self.member.id}/",
            {"role": "superuser"},
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_non_admin_cannot_list_members(self):
        outsider = User.objects.create_user(username="out", password="pass")
        self.client.force_authenticate(outsider)
        r = self.client.get(f"/api/groups/{self.group.id}/members/")
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND])


class GroupSubgroupsTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.parent = _make_group(self.owner, "Parent")
        self.child = _make_group(self.owner, "Child", parent=self.parent)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def test_list_subgroups(self):
        r = self.client.get(f"/api/groups/{self.parent.id}/subgroups/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        ids = [g["id"] for g in r.json()]
        self.assertIn(self.child.id, ids)


class GroupInviteLinkTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="pass")
        self.group = _make_group(self.admin)
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def test_create_invite_link(self):
        r = self.client.post(f"/api/groups/{self.group.id}/invite-link/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIn("token", r.json())

    def test_create_invite_link_idempotent(self):
        r1 = self.client.post(f"/api/groups/{self.group.id}/invite-link/")
        r2 = self.client.post(f"/api/groups/{self.group.id}/invite-link/")
        self.assertEqual(r1.json()["token"], r2.json()["token"])

    def test_revoke_invite_link(self):
        self.client.post(f"/api/groups/{self.group.id}/invite-link/")
        r = self.client.delete(f"/api/groups/{self.group.id}/invite-link/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(
            GroupInviteLink.objects.filter(group=self.group, is_active=True).exists()
        )

    def test_non_admin_cannot_create_link(self):
        outsider = User.objects.create_user(username="out", password="pass")
        self.client.force_authenticate(outsider)
        r = self.client.post(f"/api/groups/{self.group.id}/invite-link/")
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND])


class JoinGroupViewTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.joiner = User.objects.create_user(username="joiner", password="pass")
        self.group = _make_group(self.owner)
        self.link = GroupInviteLink.objects.create(group=self.group, created_by=self.owner)
        self.client = APIClient()

    def test_get_join_info_unauthenticated(self):
        r = self.client.get(f"/api/groups/join/{self.link.token}/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json()["group_id"], self.group.id)
        self.assertEqual(r.json()["group_name"], self.group.name)

    def test_post_join_adds_membership(self):
        self.client.force_authenticate(self.joiner)
        r = self.client.post(f"/api/groups/join/{self.link.token}/")
        self.assertIn(r.status_code, [status.HTTP_200_OK, status.HTTP_201_CREATED])
        self.assertTrue(
            GroupMembership.objects.filter(group=self.group, user=self.joiner).exists()
        )

    def test_post_join_idempotent(self):
        self.client.force_authenticate(self.joiner)
        self.client.post(f"/api/groups/join/{self.link.token}/")
        r2 = self.client.post(f"/api/groups/join/{self.link.token}/")
        self.assertEqual(r2.status_code, status.HTTP_200_OK)

    def test_invalid_token_returns_404(self):
        self.client.force_authenticate(self.joiner)
        r = self.client.post("/api/groups/join/invalid-token/")
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)

    def test_inactive_link_returns_404(self):
        self.link.is_active = False
        self.link.save()
        r = self.client.get(f"/api/groups/join/{self.link.token}/")
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)
