"""The group members list flags all-content members for group admin readers (#2075)."""

from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import User
from groups.models import Group, GroupMembership

ADMIN = GroupMembership.Role.ADMIN
MEMBER = GroupMembership.Role.MEMBER
VIEWER = GroupMembership.Role.VIEWER


class MembersAllContentFlagTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(username="g2075admin", password="pw")
        self.plain = User.objects.create_user(username="g2075member", password="pw")
        self.ac = User.objects.create_user(username="g2075ac", password="pw")
        self.ac.can_access_all_content = True
        self.ac.save(update_fields=["can_access_all_content"])
        self.parent = Group.objects.create(name="Parent", owner=self.admin)
        self.child = Group.objects.create(name="Child", owner=self.admin, parent=self.parent)
        for g in (self.parent, self.child):
            GroupMembership.objects.create(group=g, user=self.admin, role=ADMIN)
        GroupMembership.objects.create(group=self.child, user=self.plain, role=MEMBER)
        GroupMembership.objects.create(group=self.child, user=self.ac, role=VIEWER)
        GroupMembership.objects.create(group=self.parent, user=User.objects.create_user(username="g2075inh", password="pw"), role=VIEWER)
        # An all-content member listed only through the parent group.
        self.inh_ac = User.objects.create_user(username="g2075inhac", password="pw")
        self.inh_ac.can_access_all_content = True
        self.inh_ac.save(update_fields=["can_access_all_content"])
        GroupMembership.objects.create(group=self.parent, user=self.inh_ac, role=VIEWER)

    def _rows(self, reader):
        c = APIClient()
        c.force_authenticate(reader)
        r = c.get(f"/api/v1/groups/{self.child.pk}/members/")
        self.assertEqual(r.status_code, 200)
        return {row["user"]["username"]: row for row in r.json()}

    def test_admin_reader_sees_flag_on_every_row_and_stored_role_kept(self):
        rows = self._rows(self.admin)
        self.assertIs(rows["g2075ac"]["has_all_content_access"], True)
        self.assertEqual(rows["g2075ac"]["role"], "viewer")
        self.assertIs(rows["g2075member"]["has_all_content_access"], False)
        self.assertTrue(rows["g2075inh"]["is_inherited"])
        self.assertIs(rows["g2075inh"]["has_all_content_access"], False)
        self.assertTrue(rows["g2075inhac"]["is_inherited"])
        self.assertIs(rows["g2075inhac"]["has_all_content_access"], True)

    def test_non_admin_reader_gets_no_flag(self):
        for row in self._rows(self.plain).values():
            self.assertNotIn("has_all_content_access", row)

    def test_inherited_only_admin_and_viewer_readers(self):
        # Admin on the parent only (no direct row on the child) sees the flag;
        # a viewer does not.
        inh_admin = User.objects.create_user(username="g2075inhadmin", password="pw")
        GroupMembership.objects.create(group=self.parent, user=inh_admin, role=ADMIN)
        for row in self._rows(inh_admin).values():
            self.assertIn("has_all_content_access", row)
        self.assertIn("has_all_content_access", self._rows(self.ac)["g2075ac"])
        viewer = User.objects.create_user(username="g2075viewer", password="pw")
        GroupMembership.objects.create(group=self.child, user=viewer, role=VIEWER)
        for row in self._rows(viewer).values():
            self.assertNotIn("has_all_content_access", row)
