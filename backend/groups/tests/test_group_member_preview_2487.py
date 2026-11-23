"""``GroupSerializer.member_preview``: the home page's group avatar stack (#2487).

Additive, read-only, bounded to ``MEMBER_PREVIEW_LIMIT`` members per group, one
prefetch query for a whole list (no N+1), withheld on a navigation-only group,
and only the public user shape (no email).
"""
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from accounts.models import User
from groups.counts import MEMBER_PREVIEW_LIMIT
from groups.models import Group, GroupMembership
from groups.serializers import GroupSerializer

PUBLIC_USER_KEYS = {"id", "username", "display_name", "avatar_url"}


def _rows(response):
    data = response.data["results"] if "results" in response.data else response.data
    return {g["name"]: g for g in data}


class GroupMemberPreviewTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="x", email="owner@example.com")
        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        self.big = Group.objects.create(name="big", owner=self.owner)
        GroupMembership.objects.create(group=self.big, user=self.owner, role="admin")
        for i in range(MEMBER_PREVIEW_LIMIT + 3):
            u = User.objects.create_user(username=f"m{i}", password="x", email=f"m{i}@example.com")
            GroupMembership.objects.create(group=self.big, user=u, role="member")
        self.small = Group.objects.create(name="small", owner=self.owner)
        GroupMembership.objects.create(group=self.small, user=self.owner, role="admin")

    def test_list_preview_is_bounded_ordered_and_public_only(self):
        r = self.client.get("/api/v1/groups/")
        self.assertEqual(r.status_code, 200)
        rows = _rows(r)
        big = rows["big"]
        self.assertEqual(big["member_count"], MEMBER_PREVIEW_LIMIT + 4)
        self.assertEqual(len(big["member_preview"]), MEMBER_PREVIEW_LIMIT)
        # Join order: the owner joined first, so leads the stack.
        self.assertEqual(
            [u["username"] for u in big["member_preview"]],
            ["owner"] + [f"m{i}" for i in range(MEMBER_PREVIEW_LIMIT - 1)],
        )
        for u in big["member_preview"]:
            self.assertEqual(set(u), PUBLIC_USER_KEYS)
        self.assertEqual([u["username"] for u in rows["small"]["member_preview"]], ["owner"])

    def test_list_query_count_does_not_grow_with_groups(self):
        def count():
            with CaptureQueriesContext(connection) as ctx:
                self.assertEqual(self.client.get("/api/v1/groups/").status_code, 200)
            return len(ctx.captured_queries)

        before = count()
        for i in range(4):
            g = Group.objects.create(name=f"extra{i}", owner=self.owner)
            GroupMembership.objects.create(group=g, user=self.owner, role="admin")
            for j in range(3):
                u = User.objects.create_user(username=f"x{i}_{j}", password="x")
                GroupMembership.objects.create(group=g, user=u, role="member")
        self.assertEqual(count(), before)

    def test_subgroups_list_carries_preview_without_fallback(self):
        sub = Group.objects.create(name="sub", owner=self.owner, parent=self.big)
        GroupMembership.objects.create(group=sub, user=self.owner, role="admin")
        # The suite runs SERIALIZER_FALLBACK_GUARD="raise": a missing prefetch is a 500 here.
        for path in (f"/api/v1/groups/{self.big.pk}/subgroups/", f"/api/v1/groups/{self.big.pk}/subgroups/paged/"):
            r = self.client.get(path)
            self.assertEqual(r.status_code, 200, path)
            self.assertEqual([u["username"] for u in _rows(r)["sub"]["member_preview"]], ["owner"])

    def test_retrieve_carries_preview(self):
        r = self.client.get(f"/api/v1/groups/{self.big.pk}/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.data["member_preview"]), MEMBER_PREVIEW_LIMIT)

    def test_navigation_only_ancestor_withholds_preview(self):
        # A subgroup-only member sees the parent navigation-only: no members leak.
        outsider = User.objects.create_user(username="outsider", password="x")
        sub = Group.objects.create(name="sub", owner=self.owner, parent=self.big)
        GroupMembership.objects.create(group=sub, user=outsider, role="member")
        client = APIClient()
        client.force_authenticate(outsider)
        rows = _rows(client.get("/api/v1/groups/"))
        self.assertTrue(rows["big"]["navigation_only"])
        self.assertEqual(rows["big"]["member_preview"], [])
        self.assertEqual([u["username"] for u in rows["sub"]["member_preview"]], ["outsider"])

    def test_unrelated_group_not_listed(self):
        stranger = User.objects.create_user(username="stranger", password="x")
        hidden = Group.objects.create(name="hidden", owner=stranger)
        GroupMembership.objects.create(group=hidden, user=stranger, role="admin")
        names = set(_rows(self.client.get("/api/v1/groups/")))
        self.assertNotIn("hidden", names)
        for row in _rows(self.client.get("/api/v1/groups/")).values():
            self.assertNotIn("stranger", [u["username"] for u in row["member_preview"]])

    def test_serializer_without_context_withholds_preview(self):
        # Absent-input guard (#1075): no viewer to judge means navigation-only, so [].
        data = GroupSerializer(self.big).data
        self.assertEqual(data["member_preview"], [])

    def test_unprefetched_single_object_falls_back_bounded(self):
        from groups.serializers import full_group_access

        data = GroupSerializer(self.big, context={"group_access": full_group_access}).data
        self.assertEqual(len(data["member_preview"]), MEMBER_PREVIEW_LIMIT)
        self.assertEqual(data["member_preview"][0]["username"], "owner")
