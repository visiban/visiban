"""Group delete and ownership transfer need an admin membership on the group itself (#2114)."""
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from groups.models import Group, GroupMembership


class OwnerAdminMembershipTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="own2114", password="pass")
        self.peer = User.objects.create_user(username="peer2114", password="pass")
        self.other_admin = User.objects.create_user(username="oadm2114", password="pass")
        self.parent = Group.objects.create(name="Parent", owner=self.owner)
        self.child = Group.objects.create(name="Child", owner=self.peer, parent=self.parent)
        GroupMembership.objects.create(group=self.child, user=self.peer, role="admin")
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def _owner_with_descendant_membership_only(self):
        GroupMembership.objects.create(group=self.child, user=self.owner, role="member")

    def _transfer(self, group):
        return self.client.post(
            f"/api/v1/groups/{group.id}/transfer-ownership/",
            {"new_owner_id": self.other_admin.id, "confirmation": group.name},
            format="json",
        )

    def test_owner_with_only_descendant_membership_cannot_delete(self):
        self._owner_with_descendant_membership_only()
        r = self.client.delete(f"/api/v1/groups/{self.parent.id}/")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertTrue(Group.objects.filter(pk=self.parent.id).exists())

    def test_owner_with_only_descendant_membership_cannot_transfer(self):
        self._owner_with_descendant_membership_only()
        GroupMembership.objects.create(group=self.parent, user=self.other_admin, role="admin")
        r = self._transfer(self.parent)
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.parent.refresh_from_db()
        self.assertEqual(self.parent.owner_id, self.owner.id)

    def test_owner_with_member_role_on_own_group_is_refused(self):
        GroupMembership.objects.create(group=self.parent, user=self.owner, role="member")
        r = self.client.delete(f"/api/v1/groups/{self.parent.id}/")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(r.json()["detail"], "Only the group owner can delete this group.")
        GroupMembership.objects.create(group=self.parent, user=self.other_admin, role="admin")
        r = self._transfer(self.parent)
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_owner_with_direct_admin_membership_can_transfer(self):
        GroupMembership.objects.create(group=self.parent, user=self.owner, role="admin")
        GroupMembership.objects.create(group=self.parent, user=self.other_admin, role="admin")
        r = self._transfer(self.parent)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.parent.refresh_from_db()
        self.assertEqual(self.parent.owner_id, self.other_admin.id)

    def test_owner_with_direct_admin_membership_can_delete(self):
        GroupMembership.objects.create(group=self.parent, user=self.owner, role="admin")
        r = self.client.delete(f"/api/v1/groups/{self.parent.id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)

    def test_non_owner_admin_still_refused(self):
        GroupMembership.objects.create(group=self.parent, user=self.owner, role="admin")
        GroupMembership.objects.create(group=self.parent, user=self.other_admin, role="admin")
        self.client.force_authenticate(self.other_admin)
        r = self.client.delete(f"/api/v1/groups/{self.parent.id}/")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        r = self._transfer(self.parent)
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_site_admin_can_still_delete(self):
        admin = User.objects.create_user(
            username="sadm2114", password="pass", is_superuser=True, is_staff=True,
        )
        self.client.force_authenticate(admin)
        r = self.client.delete(f"/api/v1/groups/{self.parent.id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)


class AncestorMembershipDoesNotQualifyTests(TestCase):
    """An admin row on the parent is not an admin row on the child itself."""

    def setUp(self):
        self.owner = User.objects.create_user(username="own2114b", password="pass")
        self.heir = User.objects.create_user(username="heir2114b", password="pass")
        self.parent = Group.objects.create(name="Parent B", owner=self.owner)
        self.child = Group.objects.create(name="Child B", owner=self.owner, parent=self.parent)
        GroupMembership.objects.create(group=self.parent, user=self.owner, role="admin")
        GroupMembership.objects.create(group=self.child, user=self.heir, role="admin")
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def test_owner_with_admin_row_only_on_parent_cannot_delete_child(self):
        r = self.client.delete(f"/api/v1/groups/{self.child.id}/")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertTrue(Group.objects.filter(pk=self.child.id).exists())

    def test_owner_with_admin_row_only_on_parent_cannot_transfer_child(self):
        r = self.client.post(
            f"/api/v1/groups/{self.child.id}/transfer-ownership/",
            {"new_owner_id": self.heir.id, "confirmation": self.child.name},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.child.refresh_from_db()
        self.assertEqual(self.child.owner_id, self.owner.id)


class TransferOwnershipRoleBeforeBodyShape2225Tests(TestCase):
    """403/404 precede the 400 for a non-object body (#2225, Rule 18)."""

    def setUp(self):
        self.owner = User.objects.create_user(username="own2225", password="pass")
        self.admin = User.objects.create_user(username="adm2225", password="pass")
        self.stranger = User.objects.create_user(username="str2225", password="pass")
        self.group = Group.objects.create(name="G2225", owner=self.owner)
        GroupMembership.objects.create(group=self.group, user=self.owner, role="admin")
        GroupMembership.objects.create(group=self.group, user=self.admin, role="admin")
        self.url = f"/api/v1/groups/{self.group.id}/transfer-ownership/"

    def _post(self, user, body):
        client = APIClient()
        client.force_authenticate(user)
        return client.post(self.url, body, format="json")

    def test_non_owner_member_with_non_object_body_gets_403(self):
        self.assertEqual(self._post(self.admin, [1, 2]).status_code, status.HTTP_403_FORBIDDEN)

    def test_no_access_caller_with_non_object_body_gets_404(self):
        self.assertEqual(self._post(self.stranger, [1, 2]).status_code, status.HTTP_404_NOT_FOUND)

    def test_owner_with_non_object_body_gets_400(self):
        self.assertEqual(self._post(self.owner, [1, 2]).status_code, status.HTTP_400_BAD_REQUEST)

    def test_owner_valid_transfer_unchanged(self):
        r = self._post(self.owner, {"new_owner_id": self.admin.id, "confirmation": "G2225"})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.group.refresh_from_db()
        self.assertEqual(self.group.owner_id, self.admin.id)
