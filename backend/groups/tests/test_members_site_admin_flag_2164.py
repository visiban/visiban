"""The group members list flags site-admin direct rows for group admin readers (#2164).

``update_member`` refuses to change or remove a site admin's membership unless
the caller is a site admin, so the Members panel needs to know which direct
rows those are. The flag goes to the same readers as
``has_all_content_access`` (group admins) and only on direct rows.
"""

from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import User
from groups.models import Group, GroupMembership

ADMIN = GroupMembership.Role.ADMIN
MEMBER = GroupMembership.Role.MEMBER


class MembersSiteAdminFlagTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(username="g2164admin", password="pw")
        self.plain = User.objects.create_user(username="g2164member", password="pw")
        self.sa = User.objects.create_user(username="g2164sa", password="pw", is_site_admin=True)
        self.parent = Group.objects.create(name="Parent", owner=self.admin)
        self.child = Group.objects.create(name="Child", owner=self.admin, parent=self.parent)
        for g in (self.parent, self.child):
            GroupMembership.objects.create(group=g, user=self.admin, role=ADMIN)
        GroupMembership.objects.create(group=self.child, user=self.plain, role=MEMBER)
        GroupMembership.objects.create(group=self.child, user=self.sa, role=MEMBER)
        # A site admin listed only through the parent group, where it is a
        # group admin (is_site_admin alone confers no group-admin rights).
        self.inh_sa = User.objects.create_user(username="g2164inhsa", password="pw", is_site_admin=True)
        GroupMembership.objects.create(group=self.parent, user=self.inh_sa, role=ADMIN)

    def _rows(self, reader):
        c = APIClient()
        c.force_authenticate(reader)
        r = c.get(f"/api/v1/groups/{self.child.pk}/members/")
        self.assertEqual(r.status_code, 200)
        return {row["user"]["username"]: row for row in r.json()}

    def test_group_admin_reader_sees_flag_on_direct_rows(self):
        rows = self._rows(self.admin)
        self.assertIs(rows["g2164sa"]["is_site_admin"], True)
        self.assertIs(rows["g2164member"]["is_site_admin"], False)
        self.assertIs(rows["g2164admin"]["is_site_admin"], False)
        # Inherited rows carry no Remove control, so no flag.
        self.assertTrue(rows["g2164inhsa"]["is_inherited"])
        self.assertNotIn("is_site_admin", rows["g2164inhsa"])

    def test_non_admin_reader_gets_no_flag(self):
        for row in self._rows(self.plain).values():
            self.assertNotIn("is_site_admin", row)

    def test_flagged_row_is_the_one_the_server_refuses_to_remove(self):
        c = APIClient()
        c.force_authenticate(self.admin)
        r = c.delete(f"/api/v1/groups/{self.child.pk}/members/{self.sa.pk}/")
        self.assertEqual(r.status_code, 403)
        # A site admin caller who administers the group may remove it, which
        # is why the panel keeps Remove for that caller.
        c.force_authenticate(self.inh_sa)
        r = c.delete(f"/api/v1/groups/{self.child.pk}/members/{self.sa.pk}/")
        self.assertEqual(r.status_code, 204)
