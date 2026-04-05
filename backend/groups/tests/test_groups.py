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
        r = self.client.get("/api/v1/groups/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        ids = [g["id"] for g in r.json()["results"]]
        self.assertIn(self.group.id, ids)

    def test_create_group(self):
        r = self.client.post("/api/v1/groups/", {"name": "New Group"})
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertTrue(Group.objects.filter(name="New Group", owner=self.owner).exists())

    def test_create_group_auto_creates_admin_membership(self):
        r = self.client.post("/api/v1/groups/", {"name": "Auto Admin"})
        group = Group.objects.get(id=r.json()["id"])
        self.assertTrue(
            GroupMembership.objects.filter(group=group, user=self.owner, role=GroupMembership.Role.ADMIN).exists()
        )

    def test_create_subgroup_requires_parent_admin(self):
        self.client.force_authenticate(self.other)
        r = self.client.post("/api/v1/groups/", {"name": "Sub", "parent": self.group.id})
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_400_BAD_REQUEST])

    def test_owner_can_delete_group(self):
        r = self.client.delete(f"/api/v1/groups/{self.group.id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(Group.objects.filter(pk=self.group.id).exists())

    def test_non_owner_cannot_delete_group(self):
        self.client.force_authenticate(self.other)
        r = self.client.delete(f"/api/v1/groups/{self.group.id}/")
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND])

    def test_other_user_cannot_see_group(self):
        self.client.force_authenticate(self.other)
        r = self.client.get("/api/v1/groups/")
        ids = [g["id"] for g in r.json()["results"]]
        self.assertNotIn(self.group.id, ids)

    def test_admin_can_rename_group(self):
        r = self.client.patch(f"/api/v1/groups/{self.group.id}/", {"name": "Renamed"})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.group.refresh_from_db()
        self.assertEqual(self.group.name, "Renamed")

    def test_non_admin_cannot_rename_group(self):
        member = User.objects.create_user(username="member2", password="pass")
        GroupMembership.objects.create(group=self.group, user=member, role=GroupMembership.Role.MEMBER)
        self.client.force_authenticate(member)
        r = self.client.patch(f"/api/v1/groups/{self.group.id}/", {"name": "Hacked"})
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.group.refresh_from_db()
        self.assertEqual(self.group.name, "Group")

    def test_viewer_cannot_rename_group(self):
        viewer = User.objects.create_user(username="viewer2", password="pass")
        GroupMembership.objects.create(group=self.group, user=viewer, role=GroupMembership.Role.VIEWER)
        self.client.force_authenticate(viewer)
        r = self.client.patch(f"/api/v1/groups/{self.group.id}/", {"name": "Hacked"})
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_description_defaults_to_empty_string(self):
        r = self.client.get(f"/api/v1/groups/{self.group.id}/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json()["description"], "")

    def test_admin_can_update_description(self):
        r = self.client.patch(f"/api/v1/groups/{self.group.id}/", {"description": "Our engineering hub"})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.group.refresh_from_db()
        self.assertEqual(self.group.description, "Our engineering hub")

    def test_retrieve_returns_ancestors_field(self):
        """GET /api/groups/<id>/ returns an ancestors array (may be empty for root groups)."""
        r = self.client.get(f"/api/v1/groups/{self.group.id}/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIn("ancestors", r.json())

    def test_root_group_ancestors_is_empty(self):
        r = self.client.get(f"/api/v1/groups/{self.group.id}/")
        self.assertEqual(r.json()["ancestors"], [])

    def test_subgroup_ancestors_returns_root_first_chain(self):
        child = _make_group(self.owner, name="Child", parent=self.group)
        grandchild = _make_group(self.owner, name="Grandchild", parent=child)
        r = self.client.get(f"/api/v1/groups/{grandchild.id}/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        ancestors = r.json()["ancestors"]
        # Root-first order: Group → Child
        self.assertEqual(len(ancestors), 2)
        self.assertEqual(ancestors[0]["name"], "Group")
        self.assertEqual(ancestors[1]["name"], "Child")

    def test_ancestors_absent_from_list_endpoint(self):
        """The list endpoint must not include the ancestors field (N+1 concern)."""
        r = self.client.get("/api/v1/groups/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        for group in r.json()["results"]:
            self.assertNotIn("ancestors", group)


class GroupMembersTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="pass")
        self.member = User.objects.create_user(username="member", password="pass")
        self.group = _make_group(self.admin)
        GroupMembership.objects.create(group=self.group, user=self.member, role=GroupMembership.Role.MEMBER)
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def test_list_members(self):
        r = self.client.get(f"/api/v1/groups/{self.group.id}/members/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        user_ids = [m["user"]["id"] for m in r.json()]
        self.assertIn(self.member.id, user_ids)

    def test_update_member_role(self):
        r = self.client.patch(
            f"/api/v1/groups/{self.group.id}/members/{self.member.id}/",
            {"role": "admin"},
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(
            GroupMembership.objects.get(group=self.group, user=self.member).role,
            GroupMembership.Role.ADMIN,
        )

    def test_remove_member(self):
        r = self.client.delete(f"/api/v1/groups/{self.group.id}/members/{self.member.id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(
            GroupMembership.objects.filter(group=self.group, user=self.member).exists()
        )

    def test_invalid_role_returns_400(self):
        r = self.client.patch(
            f"/api/v1/groups/{self.group.id}/members/{self.member.id}/",
            {"role": "superuser"},
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_non_admin_cannot_list_members(self):
        outsider = User.objects.create_user(username="out", password="pass")
        self.client.force_authenticate(outsider)
        r = self.client.get(f"/api/v1/groups/{self.group.id}/members/")
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND])

    def test_all_valid_roles_are_accepted(self):
        """Every valid GroupMembership role can be set via PATCH members/<id>/."""
        valid_roles = [r.value for r in GroupMembership.Role]
        for role in valid_roles:
            r = self.client.patch(
                f"/api/v1/groups/{self.group.id}/members/{self.member.id}/",
                {"role": role},
            )
            self.assertEqual(r.status_code, status.HTTP_200_OK, f"role={role!r} was rejected")
            self.assertEqual(r.json()["role"], role)

    def test_site_admin_role_is_not_a_valid_membership_role(self):
        """'site_admin' must never be a valid GroupMembership role."""
        r = self.client.patch(
            f"/api/v1/groups/{self.group.id}/members/{self.member.id}/",
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
                f"/api/v1/groups/{self.group.id}/invite-links/",
                {"name": f"test-{role}", "role": role},
            )
            self.assertEqual(r.status_code, status.HTTP_201_CREATED, f"role={role!r} was rejected")
            self.assertEqual(r.json()["role"], role)

    def test_invalid_invite_link_role_returns_400(self):
        r = self.client.post(
            f"/api/v1/groups/{self.group.id}/invite-links/",
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
        r = self.client.get(f"/api/v1/groups/{self.parent.id}/subgroups/")
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
        r = self.client.post(f"/api/v1/groups/{self.group.id}/invite-links/")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertIn("token", r.json())

    def test_create_multiple_invite_links(self):
        r1 = self.client.post(f"/api/v1/groups/{self.group.id}/invite-links/")
        r2 = self.client.post(f"/api/v1/groups/{self.group.id}/invite-links/")
        self.assertEqual(r1.status_code, status.HTTP_201_CREATED)
        self.assertEqual(r2.status_code, status.HTTP_201_CREATED)
        self.assertNotEqual(r1.json()["token"], r2.json()["token"])

    def test_revoke_invite_link(self):
        link = self.client.post(f"/api/v1/groups/{self.group.id}/invite-links/").json()
        r = self.client.delete(f"/api/v1/groups/{self.group.id}/invite-links/{link['id']}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(
            GroupInviteLink.objects.filter(pk=link["id"], is_active=True).exists()
        )

    def test_non_admin_cannot_create_link(self):
        outsider = User.objects.create_user(username="out", password="pass")
        self.client.force_authenticate(outsider)
        r = self.client.post(f"/api/v1/groups/{self.group.id}/invite-links/")
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND])


class GroupBoardsTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="pass")
        self.group = _make_group(self.admin)
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def test_list_boards_in_group_empty(self):
        r = self.client.get(f"/api/v1/groups/{self.group.id}/boards/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json(), [])

    def test_create_board_in_group(self):
        r = self.client.post(
            f"/api/v1/groups/{self.group.id}/boards/",
            {"name": "Sprint Board"},
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertEqual(r.json()["name"], "Sprint Board")

    def test_create_board_populates_default_columns(self):
        # No template supplied → falls back to simple_kanban (5 columns)
        from boards.models import Column
        r = self.client.post(
            f"/api/v1/groups/{self.group.id}/boards/",
            {"name": "Default Cols"},
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        board_id = r.json()["id"]
        cols = list(Column.objects.filter(board_id=board_id).order_by("position").values_list("name", flat=True))
        self.assertEqual(cols, ["Backlog", "To Do", "Doing", "Review", "Done"])

    def test_create_board_respects_template(self):
        # Supplying a template slug must produce that template's columns.
        from boards.models import Column
        r = self.client.post(
            f"/api/v1/groups/{self.group.id}/boards/",
            {"name": "Content Board", "template": "content_production"},
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        board_id = r.json()["id"]
        cols = list(Column.objects.filter(board_id=board_id).order_by("position").values_list("name", flat=True))
        self.assertEqual(cols, ["Idea", "Assigned", "Draft", "Internal Review", "Edits", "Final Approval", "Scheduled", "Published"])

    def test_create_blank_board_has_no_columns(self):
        from boards.models import Column
        r = self.client.post(
            f"/api/v1/groups/{self.group.id}/boards/",
            {"name": "Blank", "template": "blank"},
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        board_id = r.json()["id"]
        self.assertEqual(Column.objects.filter(board_id=board_id).count(), 0)

    def test_create_board_uses_supplied_swimlane_name(self):
        from boards.models import Swimlane
        r = self.client.post(
            f"/api/v1/groups/{self.group.id}/boards/",
            {"name": "Roadmap", "swimlane_name": "Platform"},
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        board_id = r.json()["id"]
        lane = Swimlane.objects.get(board_id=board_id)
        self.assertEqual(lane.name, "Platform")

    def test_create_board_defaults_swimlane_to_general(self):
        from boards.models import Swimlane
        r = self.client.post(
            f"/api/v1/groups/{self.group.id}/boards/",
            {"name": "Sprint"},
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        board_id = r.json()["id"]
        lane = Swimlane.objects.get(board_id=board_id)
        self.assertEqual(lane.name, "General")

    def test_non_admin_cannot_create_board_in_group(self):
        member = User.objects.create_user(username="member", password="pass")
        GroupMembership.objects.create(
            group=self.group, user=member, role=GroupMembership.Role.MEMBER
        )
        self.client.force_authenticate(member)
        r = self.client.post(
            f"/api/v1/groups/{self.group.id}/boards/",
            {"name": "X"},
        )
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_400_BAD_REQUEST])

    def test_list_boards_visible_to_group_members(self):
        """Group membership grants access to all boards in the group — explicit
        BoardMembership is no longer required (#377 superseded by group-board access)."""
        from boards.models import Board, BoardMembership

        member = User.objects.create_user(username="gm", password="pass")
        GroupMembership.objects.create(group=self.group, user=member, role=GroupMembership.Role.MEMBER)

        # Create two boards in the group; member has explicit membership on one only.
        # Both should be visible because group membership implies board access.
        board_explicit = Board.objects.create(name="Explicit", owner=self.admin, group=self.group)
        BoardMembership.objects.create(board=board_explicit, user=self.admin, role=BoardMembership.Role.ADMIN)
        BoardMembership.objects.create(board=board_explicit, user=member, role=BoardMembership.Role.MEMBER)

        board_implicit = Board.objects.create(name="Implicit", owner=self.admin, group=self.group)
        BoardMembership.objects.create(board=board_implicit, user=self.admin, role=BoardMembership.Role.ADMIN)

        self.client.force_authenticate(member)
        r = self.client.get(f"/api/v1/groups/{self.group.id}/boards/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        board_names = [b["name"] for b in r.json()]
        # Both boards are visible — group membership grants access to all group boards
        self.assertIn("Explicit", board_names)
        self.assertIn("Implicit", board_names)


class GroupMemberSiteAdminTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="pass")
        self.group = _make_group(self.admin)
        self.site_admin = User.objects.create_user(
            username="sa", password="pass", is_site_admin=True
        )
        self.site_admin.can_access_all_content = True
        self.site_admin.save()
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def test_cannot_modify_site_admin_group_membership(self):
        GroupMembership.objects.create(
            group=self.group, user=self.site_admin, role=GroupMembership.Role.MEMBER
        )
        r = self.client.patch(
            f"/api/v1/groups/{self.group.id}/members/{self.site_admin.id}/",
            {"role": "member"},
        )
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_site_admin_can_pass_require_group_admin(self):
        self.client.force_authenticate(self.site_admin)
        r = self.client.get(f"/api/v1/groups/{self.group.id}/members/")
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
        r = self.client.get(f"/api/v1/groups/{self.child.id}/subgroups/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)


class JoinGroupViewTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.joiner = User.objects.create_user(username="joiner", password="pass")
        self.group = _make_group(self.owner)
        self.link, self.raw_token = GroupInviteLink.generate(
            group=self.group, created_by=self.owner
        )
        self.client = APIClient()

    def test_get_join_info_unauthenticated(self):
        r = self.client.get(f"/api/v1/groups/join/{self.raw_token}/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json()["group_id"], self.group.id)
        self.assertEqual(r.json()["group_name"], self.group.name)

    def test_post_join_adds_membership(self):
        self.client.force_authenticate(self.joiner)
        r = self.client.post(f"/api/v1/groups/join/{self.raw_token}/")
        self.assertIn(r.status_code, [status.HTTP_200_OK, status.HTTP_201_CREATED])
        self.assertTrue(
            GroupMembership.objects.filter(group=self.group, user=self.joiner).exists()
        )

    def test_post_join_idempotent(self):
        self.client.force_authenticate(self.joiner)
        self.client.post(f"/api/v1/groups/join/{self.raw_token}/")
        r2 = self.client.post(f"/api/v1/groups/join/{self.raw_token}/")
        self.assertEqual(r2.status_code, status.HTTP_200_OK)

    def test_invalid_token_returns_404(self):
        self.client.force_authenticate(self.joiner)
        r = self.client.post("/api/v1/groups/join/invalid-token/")
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)

    def test_inactive_link_returns_404(self):
        self.link.is_active = False
        self.link.save()
        r = self.client.get(f"/api/v1/groups/join/{self.raw_token}/")
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)

    def test_token_is_hashed_in_database(self):
        """The raw token is not stored — only its SHA-256 hash."""
        self.link.refresh_from_db()
        self.assertIsNotNone(self.link.token_hash)
        self.assertEqual(len(self.link.token_hash), 64)
        # The raw token must not appear in the hash field
        self.assertNotEqual(self.link.token_hash, self.raw_token)

    def test_post_join_blocked_by_must_change_username(self):
        """A user with must_change_username=True cannot POST to join endpoint (#519)."""
        self.joiner.must_change_username = True
        self.joiner.save(update_fields=["must_change_username"])
        self.client.force_authenticate(self.joiner)
        r = self.client.post(f"/api/v1/groups/join/{self.raw_token}/")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)


class GetClientIPTests(TestCase):
    """Tests for the shared get_client_ip utility (#532)."""

    def test_returns_rightmost_xff_entry(self):
        """The rightmost XFF entry is the one added by the trusted proxy."""
        from visiban.utils import get_client_ip
        from django.test import RequestFactory
        factory = RequestFactory()
        request = factory.get("/", HTTP_X_FORWARDED_FOR="1.2.3.4, 10.0.0.1, 192.168.1.1")
        self.assertEqual(get_client_ip(request), "192.168.1.1")

    def test_single_xff_entry(self):
        from visiban.utils import get_client_ip
        from django.test import RequestFactory
        factory = RequestFactory()
        request = factory.get("/", HTTP_X_FORWARDED_FOR="203.0.113.50")
        self.assertEqual(get_client_ip(request), "203.0.113.50")

    def test_falls_back_to_remote_addr(self):
        from visiban.utils import get_client_ip
        from django.test import RequestFactory
        factory = RequestFactory()
        request = factory.get("/")
        # RequestFactory sets REMOTE_ADDR to 127.0.0.1 by default
        self.assertEqual(get_client_ip(request), "127.0.0.1")


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
        r = self.client.get(f"/api/v1/groups/{self.child.id}/members/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        data = r.json()
        user_ids = [m["user"]["id"] for m in data]
        self.assertIn(self.parent_member.id, user_ids)

    def test_inherited_member_has_is_inherited_true(self):
        r = self.client.get(f"/api/v1/groups/{self.child.id}/members/")
        entry = next(m for m in r.json() if m["user"]["id"] == self.parent_member.id)
        self.assertTrue(entry["is_inherited"])
        self.assertEqual(entry["inherited_from"], "Parent")

    def test_direct_membership_takes_precedence_over_inherited(self):
        # Give parent_member a direct child membership with a different role
        GroupMembership.objects.create(
            group=self.child, user=self.parent_member, role=GroupMembership.Role.ADMIN
        )
        r = self.client.get(f"/api/v1/groups/{self.child.id}/members/")
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
        r = self.client.get(f"/api/v1/groups/{self.child.id}/invite-links/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_inherited_member_cannot_perform_admin_actions(self):
        """A user who is only a member (not admin) in an ancestor cannot admin the child."""
        self.client.force_authenticate(self.parent_member)
        r = self.client.get(f"/api/v1/groups/{self.child.id}/invite-links/")
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND])


class SubgroupVisibilityTests(TestCase):
    """Finding 4: subgroups action must only return subgroups the requesting user is a member of."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner_sgv", password="pass")
        self.outsider = User.objects.create_user(username="outsider_sgv", password="pass")
        # parent group — owner is admin
        self.parent = _make_group(self.owner, "Parent SGV")
        # subgroup_visible: outsider is a member
        self.subgroup_visible = _make_group(self.owner, "Visible Sub")
        self.subgroup_visible.parent = self.parent
        self.subgroup_visible.save()
        GroupMembership.objects.create(
            group=self.subgroup_visible, user=self.outsider, role=GroupMembership.Role.MEMBER
        )
        # Add outsider to parent so they can call the endpoint
        GroupMembership.objects.create(
            group=self.parent, user=self.outsider, role=GroupMembership.Role.MEMBER
        )
        # subgroup_hidden: outsider is NOT a member
        self.subgroup_hidden = _make_group(self.owner, "Hidden Sub")
        self.subgroup_hidden.parent = self.parent
        self.subgroup_hidden.save()
        self.client = APIClient()
        self.client.force_authenticate(self.outsider)

    def test_subgroups_only_shows_accessible_subgroups(self):
        """Outsider should see subgroup_visible but not subgroup_hidden."""
        r = self.client.get(f"/api/v1/groups/{self.parent.id}/subgroups/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        ids = [g["id"] for g in r.json()]
        self.assertIn(self.subgroup_visible.id, ids)
        self.assertNotIn(self.subgroup_hidden.id, ids)

    def test_owner_sees_all_subgroups(self):
        """Owner is a member of all groups they create, so sees all subgroups."""
        self.client.force_authenticate(self.owner)
        r = self.client.get(f"/api/v1/groups/{self.parent.id}/subgroups/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        ids = [g["id"] for g in r.json()]
        self.assertIn(self.subgroup_visible.id, ids)
        self.assertIn(self.subgroup_hidden.id, ids)


class GroupStarMembershipTests(TestCase):
    """Finding 5: non-members must not be able to star a group."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner_star", password="pass")
        self.non_member = User.objects.create_user(username="nomember_star", password="pass")
        self.group = _make_group(self.owner, "Star Group")
        self.client = APIClient()

    def test_non_member_cannot_star_group(self):
        """A user who is not a member of the group must receive 403 or 404."""
        self.client.force_authenticate(self.non_member)
        r = self.client.post(f"/api/v1/groups/{self.group.id}/star/")
        # 404 is acceptable: the group is not in non-member's accessible set
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND])

    def test_member_can_star_group(self):
        """A member of the group can star it."""
        member = User.objects.create_user(username="member_star", password="pass")
        GroupMembership.objects.create(group=self.group, user=member, role=GroupMembership.Role.MEMBER)
        self.client.force_authenticate(member)
        r = self.client.post(f"/api/v1/groups/{self.group.id}/star/")
        self.assertIn(r.status_code, [status.HTTP_200_OK, status.HTTP_201_CREATED])


class CanAccessAllContentBypassTests(TestCase):
    """Users with can_access_all_content=True bypass group permission helpers."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner_bypass", password="pass")
        self.superuser = User.objects.create_user(
            username="super_bypass", password="pass", can_access_all_content=True
        )
        self.non_member = User.objects.create_user(username="nonmember_bypass", password="pass")
        self.group = _make_group(self.owner, "Bypass Group")

    def test_can_access_all_content_bypasses_admin_check(self):
        """_require_group_admin must not raise for a user with can_access_all_content=True."""
        from groups.views import _require_group_admin
        # Should return without raising, even though superuser has no GroupMembership
        try:
            _require_group_admin(self.superuser, self.group)
        except Exception as exc:
            self.fail(f"_require_group_admin raised unexpectedly: {exc}")

    def test_can_access_all_content_bypasses_member_check(self):
        """_require_group_member must not raise for a user with can_access_all_content=True."""
        from groups.views import _require_group_member
        # Should return without raising, even though superuser has no GroupMembership
        try:
            _require_group_member(self.superuser, self.group)
        except Exception as exc:
            self.fail(f"_require_group_member raised unexpectedly: {exc}")

    def test_get_accessible_group_ids_uses_can_access_all_content_not_is_site_admin(self):
        """A user with is_site_admin=True but can_access_all_content=False must NOT
        see all groups. The documented privilege model reserves is_site_admin for the
        /api/admin/* UI only; can_access_all_content is the flag that grants broad
        content access."""
        from groups.models import get_accessible_group_ids

        # Site admin without can_access_all_content — should only see their own groups.
        site_admin_only = User.objects.create_user(
            username="site_admin_no_content", password="pass",
            is_site_admin=True, can_access_all_content=False,
        )
        # A separate group the site_admin_only user has no membership in.
        other_group = _make_group(self.owner, "Other Group")

        ids = get_accessible_group_ids(site_admin_only)
        self.assertNotIn(
            other_group.id, ids,
            "is_site_admin alone must not grant visibility into unrelated groups",
        )

        # A user with can_access_all_content=True must see all groups.
        ids_super = get_accessible_group_ids(self.superuser)
        self.assertIn(
            other_group.id, ids_super,
            "can_access_all_content must grant visibility into all groups",
        )


class GroupBoardMembershipTests(TestCase):
    """Creating a board inside a group must write a BoardMembership row for the owner."""

    def setUp(self):
        self.owner = User.objects.create_user(username="grp_board_owner", password="pass")
        self.group = _make_group(self.owner, "Membership Group")
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def test_create_board_in_group_creates_admin_membership(self):
        """POST /api/groups/{id}/boards/ must create a BoardMembership(ADMIN) for the
        requesting user so the board's member list is not empty."""
        from boards.models import BoardMembership

        r = self.client.post(
            f"/api/v1/groups/{self.group.id}/boards/",
            {"name": "Membership Board"},
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        board_id = r.json()["id"]
        self.assertTrue(
            BoardMembership.objects.filter(
                board_id=board_id,
                user=self.owner,
                role=BoardMembership.Role.ADMIN,
            ).exists(),
            "Owner should have an explicit ADMIN BoardMembership row after creating a board in a group",
        )
