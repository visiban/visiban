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
        ids = [g["id"] for g in r.json()["results"]]
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
        ids = [g["id"] for g in r.json()["results"]]
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

    def test_all_valid_roles_are_accepted(self):
        """Every valid GroupMembership role can be set via PATCH members/<id>/."""
        valid_roles = [r.value for r in GroupMembership.Role]
        for role in valid_roles:
            r = self.client.patch(
                f"/api/groups/{self.group.id}/members/{self.member.id}/",
                {"role": role},
            )
            self.assertEqual(r.status_code, status.HTTP_200_OK, f"role={role!r} was rejected")
            self.assertEqual(r.json()["role"], role)

    def test_site_admin_role_is_not_a_valid_membership_role(self):
        """'site_admin' must never be a valid GroupMembership role."""
        r = self.client.patch(
            f"/api/groups/{self.group.id}/members/{self.member.id}/",
            {"role": "site_admin"},
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)


class GroupRoleCoverageTests(TestCase):
    """Enumerate every valid role for both GroupMembership and GroupInviteLink."""

    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="pass")
        self.group = _make_group(self.admin)
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def test_group_membership_roles_match_expected_set(self):
        expected = {"admin", "member", "collaborator", "viewer"}
        actual = set(GroupMembership.Role.values)
        self.assertEqual(actual, expected, "GroupMembership.Role set changed — update tests and UI dropdowns")

    def test_invite_link_roles_match_expected_set(self):
        expected = {"admin", "member", "collaborator", "viewer"}
        actual = set(GroupInviteLink.Role.values)
        self.assertEqual(actual, expected, "GroupInviteLink.Role set changed — update tests and UI dropdowns")

    def test_all_invite_link_roles_can_be_created(self):
        """Every valid GroupInviteLink role can be used when creating an invite link."""
        for role in GroupInviteLink.Role.values:
            r = self.client.post(
                f"/api/groups/{self.group.id}/invite-links/",
                {"name": f"test-{role}", "role": role},
            )
            self.assertEqual(r.status_code, status.HTTP_201_CREATED, f"role={role!r} was rejected")
            self.assertEqual(r.json()["role"], role)

    def test_invalid_invite_link_role_returns_400(self):
        r = self.client.post(
            f"/api/groups/{self.group.id}/invite-links/",
            {"name": "bad", "role": "site_admin"},
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)


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
        r = self.client.post(f"/api/groups/{self.group.id}/invite-links/")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertIn("token", r.json())

    def test_create_multiple_invite_links(self):
        r1 = self.client.post(f"/api/groups/{self.group.id}/invite-links/")
        r2 = self.client.post(f"/api/groups/{self.group.id}/invite-links/")
        self.assertEqual(r1.status_code, status.HTTP_201_CREATED)
        self.assertEqual(r2.status_code, status.HTTP_201_CREATED)
        self.assertNotEqual(r1.json()["token"], r2.json()["token"])

    def test_revoke_invite_link(self):
        link = self.client.post(f"/api/groups/{self.group.id}/invite-links/").json()
        r = self.client.delete(f"/api/groups/{self.group.id}/invite-links/{link['id']}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(
            GroupInviteLink.objects.filter(pk=link["id"], is_active=True).exists()
        )

    def test_non_admin_cannot_create_link(self):
        outsider = User.objects.create_user(username="out", password="pass")
        self.client.force_authenticate(outsider)
        r = self.client.post(f"/api/groups/{self.group.id}/invite-links/")
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND])


class GroupBoardsTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="pass")
        self.group = _make_group(self.admin)
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def test_list_boards_in_group_empty(self):
        r = self.client.get(f"/api/groups/{self.group.id}/boards/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json(), [])

    def test_create_board_in_group(self):
        r = self.client.post(
            f"/api/groups/{self.group.id}/boards/",
            {"name": "Sprint Board"},
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertEqual(r.json()["name"], "Sprint Board")

    def test_create_board_populates_default_columns(self):
        from boards.models import Column
        r = self.client.post(
            f"/api/groups/{self.group.id}/boards/",
            {"name": "Default Cols"},
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        board_id = r.json()["id"]
        self.assertEqual(Column.objects.filter(board_id=board_id).count(), 4)

    def test_non_admin_cannot_create_board_in_group(self):
        member = User.objects.create_user(username="member", password="pass")
        GroupMembership.objects.create(
            group=self.group, user=member, role=GroupMembership.Role.MEMBER
        )
        self.client.force_authenticate(member)
        r = self.client.post(
            f"/api/groups/{self.group.id}/boards/",
            {"name": "X"},
        )
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_400_BAD_REQUEST])


class GroupMemberSiteAdminTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="pass")
        self.group = _make_group(self.admin)
        self.site_admin = User.objects.create_user(
            username="sa", password="pass", is_site_admin=True
        )
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def test_cannot_modify_site_admin_group_membership(self):
        GroupMembership.objects.create(
            group=self.group, user=self.site_admin, role=GroupMembership.Role.MEMBER
        )
        r = self.client.patch(
            f"/api/groups/{self.group.id}/members/{self.site_admin.id}/",
            {"role": "member"},
        )
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_site_admin_can_pass_require_group_admin(self):
        self.client.force_authenticate(self.site_admin)
        r = self.client.get(f"/api/groups/{self.group.id}/members/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)


class GroupMemberAncestorTests(TestCase):
    """_require_group_member walks the ancestor chain."""
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.parent = _make_group(self.owner, "Parent")
        self.child = Group.objects.create(name="Child", owner=self.owner, parent=self.parent)
        GroupMembership.objects.create(
            group=self.child, user=self.owner, role=GroupMembership.Role.ADMIN
        )
        self.member = User.objects.create_user(username="member", password="pass")
        # member is in parent only
        GroupMembership.objects.create(
            group=self.parent, user=self.member, role=GroupMembership.Role.MEMBER
        )
        self.client = APIClient()
        self.client.force_authenticate(self.member)

    def test_parent_member_can_list_child_subgroups(self):
        r = self.client.get(f"/api/groups/{self.child.id}/subgroups/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)


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


class SubgroupMemberInheritanceTests(TestCase):
    """Members endpoint returns inherited memberships from ancestor groups."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.parent = _make_group(self.owner, "Parent")
        # Child group — owner has admin membership via _make_group
        self.child = _make_group(self.owner, "Child", parent=self.parent)
        # A user who is only a member of the parent
        self.parent_member = User.objects.create_user(username="pmember", password="pass")
        GroupMembership.objects.create(
            group=self.parent, user=self.parent_member, role=GroupMembership.Role.MEMBER
        )
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def test_inherited_member_appears_in_child_members_list(self):
        r = self.client.get(f"/api/groups/{self.child.id}/members/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        data = r.json()
        user_ids = [m["user"]["id"] for m in data]
        self.assertIn(self.parent_member.id, user_ids)

    def test_inherited_member_has_is_inherited_true(self):
        r = self.client.get(f"/api/groups/{self.child.id}/members/")
        entry = next(m for m in r.json() if m["user"]["id"] == self.parent_member.id)
        self.assertTrue(entry["is_inherited"])
        self.assertEqual(entry["inherited_from"], "Parent")

    def test_direct_membership_takes_precedence_over_inherited(self):
        # Give parent_member a direct child membership with a different role
        GroupMembership.objects.create(
            group=self.child, user=self.parent_member, role=GroupMembership.Role.ADMIN
        )
        r = self.client.get(f"/api/groups/{self.child.id}/members/")
        entries = [m for m in r.json() if m["user"]["id"] == self.parent_member.id]
        # Should appear exactly once
        self.assertEqual(len(entries), 1)
        self.assertFalse(entries[0]["is_inherited"])
        self.assertEqual(entries[0]["role"], GroupMembership.Role.ADMIN)

    def test_inherited_admin_can_manage_subgroup(self):
        """A user who is admin in the parent can call admin-only endpoints on the child."""
        parent_admin = User.objects.create_user(username="padmin", password="pass")
        GroupMembership.objects.create(
            group=self.parent, user=parent_admin, role=GroupMembership.Role.ADMIN
        )
        # parent_admin has no direct child membership — inherited admin should suffice
        self.client.force_authenticate(parent_admin)
        # Listing invite links is an admin-only action
        r = self.client.get(f"/api/groups/{self.child.id}/invite-links/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_inherited_member_cannot_perform_admin_actions(self):
        """A user who is only a member (not admin) in an ancestor cannot admin the child."""
        self.client.force_authenticate(self.parent_member)
        r = self.client.get(f"/api/groups/{self.child.id}/invite-links/")
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND])
