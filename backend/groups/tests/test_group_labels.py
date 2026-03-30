"""Tests for GroupViewSet group_labels, update_group_label, and board_defaults actions."""
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from groups.models import Group, GroupLabel, GroupMembership


def _make_group(owner, name="Group", parent=None):
    group = Group.objects.create(name=name, owner=owner, parent=parent)
    GroupMembership.objects.create(group=group, user=owner, role=GroupMembership.Role.ADMIN)
    return group


class GroupLabelsTests(TestCase):
    """Tests for GET/POST /api/groups/<id>/labels/ and PATCH/DELETE /api/groups/<id>/labels/<label_id>/."""

    def setUp(self):
        self.admin = User.objects.create_user(username="admin_gl", password="pass")
        self.member = User.objects.create_user(username="member_gl", password="pass")
        self.group = _make_group(self.admin)
        GroupMembership.objects.create(
            group=self.group, user=self.member, role=GroupMembership.Role.MEMBER
        )
        self.client = APIClient()

    # ------------------------------------------------------------------
    # GET /api/groups/<id>/labels/
    # ------------------------------------------------------------------

    def test_list_group_labels(self):
        """Admin can list group labels."""
        GroupLabel.objects.create(group=self.group, name="Bug", color="#FF0000")
        GroupLabel.objects.create(group=self.group, name="Feature", color="#00FF00")
        self.client.force_authenticate(self.admin)
        r = self.client.get(f"/api/groups/{self.group.id}/labels/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        names = {label["name"] for label in r.json()}
        self.assertEqual(names, {"Bug", "Feature"})

    def test_list_group_labels_member_allowed(self):
        """Members (non-admin) can also list group labels — GET is member-level."""
        GroupLabel.objects.create(group=self.group, name="Docs", color="#0000FF")
        self.client.force_authenticate(self.member)
        r = self.client.get(f"/api/groups/{self.group.id}/labels/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(len(r.json()), 1)

    # ------------------------------------------------------------------
    # POST /api/groups/<id>/labels/
    # ------------------------------------------------------------------

    def test_create_group_label(self):
        """Admin can create a group label."""
        self.client.force_authenticate(self.admin)
        r = self.client.post(
            f"/api/groups/{self.group.id}/labels/",
            {"name": "Priority", "color": "#EAB308"},
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertEqual(r.json()["name"], "Priority")
        self.assertEqual(r.json()["color"], "#EAB308")
        self.assertTrue(GroupLabel.objects.filter(group=self.group, name="Priority").exists())

    def test_create_group_label_non_admin_rejected(self):
        """Non-admin members cannot create group labels."""
        self.client.force_authenticate(self.member)
        r = self.client.post(
            f"/api/groups/{self.group.id}/labels/",
            {"name": "Sneaky", "color": "#000000"},
        )
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertFalse(GroupLabel.objects.filter(group=self.group, name="Sneaky").exists())

    # ------------------------------------------------------------------
    # PATCH /api/groups/<id>/labels/<label_id>/
    # ------------------------------------------------------------------

    def test_update_group_label(self):
        """Admin can update a group label's name and color."""
        label = GroupLabel.objects.create(group=self.group, name="Old", color="#111111")
        self.client.force_authenticate(self.admin)
        r = self.client.patch(
            f"/api/groups/{self.group.id}/labels/{label.id}/",
            {"name": "New", "color": "#222222"},
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        label.refresh_from_db()
        self.assertEqual(label.name, "New")
        self.assertEqual(label.color, "#222222")

    def test_update_group_label_non_admin_rejected(self):
        """Non-admin members cannot update group labels."""
        label = GroupLabel.objects.create(group=self.group, name="Stable", color="#333333")
        self.client.force_authenticate(self.member)
        r = self.client.patch(
            f"/api/groups/{self.group.id}/labels/{label.id}/",
            {"name": "Hacked"},
        )
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        label.refresh_from_db()
        self.assertEqual(label.name, "Stable")

    # ------------------------------------------------------------------
    # DELETE /api/groups/<id>/labels/<label_id>/
    # ------------------------------------------------------------------

    def test_delete_group_label(self):
        """Admin can delete a group label."""
        label = GroupLabel.objects.create(group=self.group, name="Doomed", color="#444444")
        self.client.force_authenticate(self.admin)
        r = self.client.delete(f"/api/groups/{self.group.id}/labels/{label.id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(GroupLabel.objects.filter(pk=label.id).exists())

    def test_delete_group_label_non_admin_rejected(self):
        """Non-admin members cannot delete group labels."""
        label = GroupLabel.objects.create(group=self.group, name="Protected", color="#555555")
        self.client.force_authenticate(self.member)
        r = self.client.delete(f"/api/groups/{self.group.id}/labels/{label.id}/")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertTrue(GroupLabel.objects.filter(pk=label.id).exists())

    # ------------------------------------------------------------------
    # Cross-group isolation
    # ------------------------------------------------------------------

    def test_cross_group_label_access_rejected(self):
        """Accessing a label from another group via this group's URL returns 404."""
        other_owner = User.objects.create_user(username="other_owner_gl", password="pass")
        other_group = _make_group(other_owner, "Other Group")
        other_label = GroupLabel.objects.create(group=other_group, name="Foreign", color="#666666")
        self.client.force_authenticate(self.admin)
        # Try to PATCH the foreign label through our group's URL
        r = self.client.patch(
            f"/api/groups/{self.group.id}/labels/{other_label.id}/",
            {"name": "Stolen"},
        )
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)
        other_label.refresh_from_db()
        self.assertEqual(other_label.name, "Foreign")


class BoardDefaultsTests(TestCase):
    """Tests for PATCH /api/groups/<id>/board-defaults/."""

    def setUp(self):
        self.admin = User.objects.create_user(username="admin_bd", password="pass")
        self.member = User.objects.create_user(username="member_bd", password="pass")
        self.group = _make_group(self.admin)
        GroupMembership.objects.create(
            group=self.group, user=self.member, role=GroupMembership.Role.MEMBER
        )
        self.client = APIClient()

    def test_get_board_defaults_via_group_detail(self):
        """Group detail includes default_board_member_role and allowed_priorities."""
        self.client.force_authenticate(self.admin)
        r = self.client.get(f"/api/groups/{self.group.id}/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        data = r.json()
        self.assertIn("default_board_member_role", data)
        self.assertIn("allowed_priorities", data)
        # Default values
        self.assertEqual(data["default_board_member_role"], "member")
        self.assertEqual(data["allowed_priorities"], [])

    def test_patch_board_defaults_role(self):
        """Admin can update default_board_member_role."""
        self.client.force_authenticate(self.admin)
        r = self.client.patch(
            f"/api/groups/{self.group.id}/board-defaults/",
            {"default_board_member_role": "viewer"},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.group.refresh_from_db()
        self.assertEqual(self.group.default_board_member_role, "viewer")

    def test_patch_board_defaults_allowed_priorities(self):
        """Admin can update allowed_priorities."""
        self.client.force_authenticate(self.admin)
        r = self.client.patch(
            f"/api/groups/{self.group.id}/board-defaults/",
            {"allowed_priorities": ["low", "high"]},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.group.refresh_from_db()
        self.assertEqual(self.group.allowed_priorities, ["low", "high"])

    def test_patch_board_defaults_non_admin_rejected(self):
        """Non-admin members cannot update board defaults."""
        self.client.force_authenticate(self.member)
        r = self.client.patch(
            f"/api/groups/{self.group.id}/board-defaults/",
            {"default_board_member_role": "viewer"},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.group.refresh_from_db()
        self.assertEqual(self.group.default_board_member_role, "member")

    def test_patch_board_defaults_invalid_role(self):
        """Invalid role value returns 400."""
        self.client.force_authenticate(self.admin)
        r = self.client.patch(
            f"/api/groups/{self.group.id}/board-defaults/",
            {"default_board_member_role": "superuser"},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_board_created_in_group_inherits_defaults(self):
        """A board created in the group inherits the group's allowed_priorities."""
        self.client.force_authenticate(self.admin)
        # Set custom allowed priorities on the group
        self.group.allowed_priorities = ["low", "medium"]
        self.group.save(update_fields=["allowed_priorities"])

        # Create a board in the group
        r = self.client.post(
            f"/api/groups/{self.group.id}/boards/",
            {"name": "Inherited Board"},
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)

        from boards.models import Board
        board = Board.objects.get(pk=r.json()["id"])
        self.assertEqual(board.allowed_priorities, ["low", "medium"])
