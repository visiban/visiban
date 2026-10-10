"""Data migration 0017 deactivates pre-#1513 links whose creator lost admin (#1565)."""

import importlib

from django.apps import apps
from django.test import TestCase

from accounts.models import User
from groups.models import Group, GroupInviteLink, GroupMembership

migration = importlib.import_module("groups.migrations.0017_deactivate_lapsed_admin_invite_links")


class BackfillLapsedAdminLinksTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pw")
        self.root = Group.objects.create(name="Root", owner=self.owner)
        self.child = Group.objects.create(name="Child", owner=self.owner, parent=self.root)

    def _user(self, name, **kw):
        return User.objects.create_user(username=name, password="pw", **kw)

    def _link(self, group, creator):
        link, _ = GroupInviteLink.generate(group, creator)
        return link

    def _run(self):
        migration.deactivate_lapsed_admin_links(apps, None)

    def _active(self, link):
        link.refresh_from_db()
        return link.is_active

    def test_demoted_creator_link_deactivated(self):
        u = self._user("demoted")
        m = GroupMembership.objects.create(group=self.root, user=u, role="admin")
        link = self._link(self.root, u)
        m.role = "member"
        m.save()
        self._run()
        self.assertFalse(self._active(link))

    def test_removed_creator_link_deactivated(self):
        u = self._user("removed")
        GroupMembership.objects.create(group=self.root, user=u, role="admin")
        link = self._link(self.root, u)
        GroupMembership.objects.filter(user=u).delete()
        self._run()
        self.assertFalse(self._active(link))

    def test_reparent_lost_inherited_admin_deactivated(self):
        u = self._user("inherited")
        GroupMembership.objects.create(group=self.root, user=u, role="admin")
        link = self._link(self.child, u)
        other = Group.objects.create(name="Other", owner=self.owner)
        self.child.parent = other
        self.child.save()
        self._run()
        self.assertFalse(self._active(link))

    def test_creator_still_admin_via_ancestor_kept(self):
        u = self._user("anc")
        GroupMembership.objects.create(group=self.root, user=u, role="admin")
        link = self._link(self.child, u)
        self._run()
        self.assertTrue(self._active(link))

    def test_direct_admin_kept(self):
        u = self._user("direct")
        GroupMembership.objects.create(group=self.child, user=u, role="admin")
        link = self._link(self.child, u)
        self._run()
        self.assertTrue(self._active(link))

    def test_admin_only_on_descendant_does_not_cover_parent_link(self):
        u = self._user("below")
        GroupMembership.objects.create(group=self.child, user=u, role="admin")
        link = self._link(self.root, u)
        self._run()
        self.assertFalse(self._active(link))

    def test_site_wide_access_creator_kept(self):
        u = self._user("allseeing", can_access_all_content=True)
        link = self._link(self.root, u)
        self._run()
        self.assertTrue(self._active(link))

    def test_used_link_keeps_history(self):
        from django.utils import timezone
        u = self._user("used")
        link = self._link(self.root, u)
        GroupInviteLink.objects.filter(pk=link.pk).update(single_use=True, used_at=timezone.now())
        self._run()
        self.assertTrue(self._active(link))

    def test_creatorless_link_deactivated(self):
        u = self._user("gone")
        link = self._link(self.root, u)
        GroupInviteLink.objects.filter(pk=link.pk).update(created_by=None)
        self._run()
        self.assertFalse(self._active(link))

    def test_idempotent_and_cap_slot_freed(self):
        u = self._user("cap")
        link = self._link(self.root, u)
        self._run()
        self._run()
        self.assertFalse(self._active(link))
        self.assertEqual(GroupInviteLink.objects.filter(group=self.root, is_active=True).count(), 0)

    def test_inactive_creator_link_deactivated(self):
        u = self._user("inactive")
        GroupMembership.objects.create(group=self.root, user=u, role="admin")
        link = self._link(self.root, u)
        User.objects.filter(pk=u.pk).update(is_active=False)
        self._run()
        self.assertFalse(self._active(link))

    def test_depth_limit_boundary(self):
        u = self._user("deep")
        chain = [self.root]
        for i in range(6):
            chain.append(Group.objects.create(name=f"L{i}", owner=self.owner, parent=chain[-1]))
        GroupMembership.objects.create(group=chain[0], user=u, role="admin")
        # chain[5] reaches chain[0] in 6 levels (kept); chain[6] needs 7 (lapsed).
        at_limit = self._link(chain[5], u)
        too_deep = self._link(chain[6], u)
        self._run()
        self.assertTrue(self._active(at_limit))
        self.assertFalse(self._active(too_deep))

    def test_backfill_frees_cap_and_hides_stale_links_from_list(self):
        from rest_framework.test import APIClient

        admin = self._user("capadmin")
        GroupMembership.objects.create(group=self.root, user=admin, role="admin")
        stale_creator = self._user("stale")
        m = GroupMembership.objects.create(group=self.root, user=stale_creator, role="admin")
        stale = [self._link(self.root, stale_creator) for _ in range(5)]
        m.role = "member"
        m.save()
        client = APIClient()
        client.force_authenticate(admin)
        url = f"/api/v1/groups/{self.root.pk}/invite-links/"

        self.assertEqual(client.post(url, {}, format="json").status_code, 400)
        self._run()
        self.assertEqual(client.get(url).json(), [])
        r = client.post(url, {}, format="json")
        self.assertEqual(r.status_code, 201)
        listed = {row["id"] for row in client.get(url).json()}
        self.assertEqual(len(listed), 1)
        self.assertTrue(listed.isdisjoint({lk.pk for lk in stale}))
