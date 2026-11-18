"""#2253 / #2256: paged siblings of a group's invite links and shared labels.

The bare routes keep their 1.0 bare-array contract; each ``/paged/`` sibling
pages through exactly the bare route's set and row shape with the bare route's
access gate (invite links: group admin; labels: group member).
"""
import datetime

from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User
from groups.models import Group, GroupInviteLink, GroupLabel, GroupMembership

ROLE = GroupMembership.Role


def _user(name):
    return User.objects.create_user(username=name, password="pass")


class _Base(TestCase):
    def setUp(self):
        self.admin = _user("gadmin")
        self.member = _user("gmember")
        self.stranger = _user("gstranger")
        self.group = Group.objects.create(name="G", owner=self.admin)
        GroupMembership.objects.create(group=self.group, user=self.admin, role=ROLE.ADMIN)
        GroupMembership.objects.create(group=self.group, user=self.member, role=ROLE.MEMBER)
        self.base = f"/api/v1/groups/{self.group.pk}"

    def _as(self, user):
        c = APIClient()
        c.force_authenticate(user)
        return c

    def _walk(self, client, url, page_size):
        rows, offset = [], 0
        while True:
            r = client.get(url, {"page_size": page_size, "offset": offset})
            self.assertEqual(r.status_code, 200, r.content)
            body = r.json()
            self.assertEqual(set(body), {"count", "offset", "page_size", "results"})
            rows += body["results"]
            offset += page_size
            if offset >= body["count"]:
                return rows, body["count"]


class InviteLinkPagedTests(_Base):
    def setUp(self):
        super().setUp()
        expires = timezone.now() + datetime.timedelta(days=7)
        for i in range(5):
            GroupInviteLink.generate(
                group=self.group, created_by=self.admin, name=f"l{i}", role=ROLE.MEMBER,
                expires_at=expires, single_use=False,
            )
        # A consumed link stays listed; a revoked one does not.
        consumed = GroupInviteLink.objects.filter(group=self.group).first()
        GroupInviteLink.objects.filter(pk=consumed.pk).update(
            used_at=timezone.now(), is_active=False, single_use=True,
        )
        revoked = GroupInviteLink.objects.filter(group=self.group).last()
        GroupInviteLink.objects.filter(pk=revoked.pk).update(is_active=False)
        self.admin_client = self._as(self.admin)

    def test_bare_route_is_unchanged_bare_array_of_every_listed_link(self):
        r = self.admin_client.get(f"{self.base}/invite-links/")
        self.assertEqual(r.status_code, 200)
        self.assertIsInstance(r.json(), list)
        self.assertEqual(len(r.json()), 4)
        self.assertNotIn("X-Total-Count", r)

    def test_paged_walk_matches_bare_set_and_order(self):
        bare = self.admin_client.get(f"{self.base}/invite-links/").json()
        rows, count = self._walk(self.admin_client, f"{self.base}/invite-links/paged/", 3)
        self.assertEqual(count, len(bare))
        self.assertEqual(rows, bare)

    def test_paged_envelope_and_page_size_cap(self):
        r = self.admin_client.get(f"{self.base}/invite-links/paged/", {"page_size": 2})
        self.assertEqual(r.json()["page_size"], 2)
        self.assertEqual(len(r.json()["results"]), 2)
        r = self.admin_client.get(f"{self.base}/invite-links/paged/", {"page_size": 10**6})
        self.assertEqual(r.json()["page_size"], 200)

    def test_paged_requires_group_admin_like_the_bare_route(self):
        for user in (self.member, self.stranger):
            c = self._as(user)
            bare = c.get(f"{self.base}/invite-links/").status_code
            paged = c.get(f"{self.base}/invite-links/paged/").status_code
            self.assertIn(bare, (403, 404))
            self.assertEqual(paged, bare)
        self.assertEqual(APIClient().get(f"{self.base}/invite-links/paged/").status_code, 401)

    def test_paged_does_not_shadow_link_delete_route(self):
        link = GroupInviteLink.objects.filter(group=self.group, is_active=True).first()
        r = self.admin_client.delete(f"{self.base}/invite-links/{link.pk}/")
        self.assertEqual(r.status_code, 204)


class LabelPagedTests(_Base):
    def setUp(self):
        super().setUp()
        for i in range(5):
            GroupLabel.objects.create(group=self.group, name=f"label{i}")

    def test_bare_route_is_unchanged_bare_array(self):
        r = self._as(self.member).get(f"{self.base}/labels/")
        self.assertEqual(r.status_code, 200)
        self.assertIsInstance(r.json(), list)
        self.assertEqual(len(r.json()), 5)

    def test_paged_walk_covers_the_bare_set_once(self):
        client = self._as(self.member)
        bare = client.get(f"{self.base}/labels/").json()
        rows, count = self._walk(client, f"{self.base}/labels/paged/", 2)
        self.assertEqual(count, 5)
        self.assertEqual([r["id"] for r in rows], sorted(r["id"] for r in bare))
        self.assertEqual({r["id"] for r in rows}, {r["id"] for r in bare})
        self.assertEqual(set(rows[0]), set(bare[0]))

    def test_paged_requires_group_membership_like_the_bare_route(self):
        c = self._as(self.stranger)
        bare = c.get(f"{self.base}/labels/").status_code
        self.assertIn(bare, (403, 404))
        self.assertEqual(c.get(f"{self.base}/labels/paged/").status_code, bare)
        self.assertEqual(APIClient().get(f"{self.base}/labels/paged/").status_code, 401)

    def test_paged_refuses_navigation_only_ancestor_viewer_like_the_bare_route(self):
        # A member of a subgroup sees the parent in get_accessible_group_ids
        # (navigation only), so get_object() succeeds on the parent, but
        # membership inherits downward only: _require_group_member must 403.
        # A stranger 404s earlier and would not exercise that gate.
        child = Group.objects.create(name="child", owner=self.admin, parent=self.group)
        GroupMembership.objects.create(group=child, user=self.stranger, role=ROLE.MEMBER)
        c = self._as(self.stranger)
        self.assertEqual(c.get(f"{self.base}/labels/").status_code, 403)
        self.assertEqual(c.get(f"{self.base}/labels/paged/").status_code, 403)

    def test_paged_does_not_shadow_label_detail_route(self):
        label = GroupLabel.objects.filter(group=self.group).first()
        r = self._as(self.admin).patch(f"{self.base}/labels/{label.pk}/", {"name": "renamed"}, format="json")
        self.assertEqual(r.status_code, 200)
