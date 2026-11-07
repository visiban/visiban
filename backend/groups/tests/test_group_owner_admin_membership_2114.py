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
        self.assertIn(r.status_code, (status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND))
        self.assertTrue(Group.objects.filter(pk=self.parent.id).exists())

    def test_owner_with_only_descendant_membership_cannot_transfer(self):
        self._owner_with_descendant_membership_only()
        GroupMembership.objects.create(group=self.parent, user=self.other_admin, role="admin")
        r = self._transfer(self.parent)
        self.assertIn(r.status_code, (status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND))
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
