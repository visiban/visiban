"""#1780 / #1784 / #1885: paged siblings of a group's members, subgroups and boards.

The bare routes keep their 1.0 bare-array contract (the web app reads them);
each ``/paged/`` sibling must page through exactly the bare route's set and
row shape, carry the same access gate, and issue a query count that does not
grow with the page size.
"""
from django.db import connection
from django.test import SimpleTestCase, TestCase
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board
from groups.models import Group, GroupMembership

ROLE = GroupMembership.Role


def _user(name, **kw):
    return User.objects.create_user(username=name, password="pass", **kw)


class _Tree(TestCase):
    """root > mid > leaf, with members at each level and some overlap."""

    def setUp(self):
        self.owner = _user("owner")
        self.root = Group.objects.create(name="Root", owner=self.owner)
        self.mid = Group.objects.create(name="Mid", owner=self.owner, parent=self.root)
        self.leaf = Group.objects.create(name="Leaf", owner=self.owner, parent=self.mid)
        GroupMembership.objects.create(group=self.root, user=self.owner, role=ROLE.ADMIN)
        self.root_only = [_user(f"r{i}") for i in range(6)]
        for u in self.root_only:
            GroupMembership.objects.create(group=self.root, user=u, role=ROLE.VIEWER)
        # In root and mid: mid (nearer) must win.
        self.both = _user("both")
        GroupMembership.objects.create(group=self.root, user=self.both, role=ROLE.VIEWER)
        GroupMembership.objects.create(group=self.mid, user=self.both, role=ROLE.MEMBER)
        # Direct in leaf and inherited from root: direct must win.
        self.direct = _user("direct")
        GroupMembership.objects.create(group=self.leaf, user=self.direct, role=ROLE.MEMBER)
        GroupMembership.objects.create(group=self.root, user=self.direct, role=ROLE.ADMIN)
        # An ancestor row with an invalid stored role grants nothing (#1829):
        # not listed from mid, and it must not hide the valid root row.
        self.bad = _user("bad")
        GroupMembership.objects.filter(pk=GroupMembership.objects.create(
            group=self.mid, user=self.bad, role=ROLE.MEMBER).pk).update(role="bogus")
        GroupMembership.objects.create(group=self.root, user=self.bad, role=ROLE.VIEWER)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def _walk(self, url, page_size):
        rows, offset = [], 0
        while True:
            r = self.client.get(url, {"page_size": page_size, "offset": offset})
            self.assertEqual(r.status_code, 200, r.content)
            body = r.json()
            self.assertEqual(set(body), {"count", "offset", "page_size", "results"})
            rows += body["results"]
            offset += page_size
            if offset >= body["count"]:
                return rows, body["count"]


def _key(row):
    return (row["user"]["id"], row["id"], row["role"], row["is_inherited"], row["inherited_from"])


class MembersPagedTests(_Tree):
    url = "/api/v1/groups/{}/members/"

    def test_same_set_and_rows_as_bare_list(self):
        bare = self.client.get(self.url.format(self.leaf.pk)).json()
        paged, count = self._walk(self.url.format(self.leaf.pk) + "paged/", 3)
        self.assertEqual(count, len(bare))
        self.assertEqual(sorted(map(_key, paged)), sorted(map(_key, bare)))
        # Same row shape, admin-only fields included (owner is a root admin).
        self.assertEqual(sorted(paged[0]), sorted(next(r for r in bare if r["id"] == paged[0]["id"])))
        self.assertEqual(len({r["user"]["id"] for r in paged}), len(paged))

    def test_precedence_direct_then_nearest_ancestor(self):
        paged, _ = self._walk(self.url.format(self.leaf.pk) + "paged/", 50)
        by_user = {r["user"]["id"]: r for r in paged}
        self.assertEqual(by_user[self.direct.pk]["is_inherited"], False)
        self.assertEqual(by_user[self.direct.pk]["role"], ROLE.MEMBER)
        self.assertEqual(by_user[self.both.pk]["inherited_from"], "Mid")
        self.assertEqual(by_user[self.bad.pk]["inherited_from"], "Root")
        # Direct first, then by ancestor distance.
        ranks = [0 if not r["is_inherited"] else {"Mid": 1, "Root": 2}[r["inherited_from"]] for r in paged]
        self.assertEqual(ranks, sorted(ranks))

    def test_direct_row_with_invalid_role_is_listed_as_stored(self):
        GroupMembership.objects.filter(group=self.leaf, user=self.direct).update(role="bogus")
        paged, _ = self._walk(self.url.format(self.leaf.pk) + "paged/", 50)
        row = next(r for r in paged if r["user"]["id"] == self.direct.pk)
        self.assertEqual((row["role"], row["is_inherited"]), ("bogus", False))

    def test_non_admin_member_does_not_see_admin_only_fields(self):
        viewer = self.root_only[0]
        self.client.force_authenticate(viewer)
        rows = self.client.get(self.url.format(self.leaf.pk) + "paged/").json()["results"]
        self.assertTrue(rows)
        self.assertNotIn("has_all_content_access", rows[0])
        self.assertNotIn("is_site_admin", rows[0])

    def test_query_count_constant_in_page_size(self):
        for i in range(30):
            GroupMembership.objects.create(group=self.root, user=_user(f"x{i}"), role=ROLE.VIEWER)
        url = self.url.format(self.leaf.pk) + "paged/"
        self.client.get(url)  # warm first-request caches
        counts = {}
        for size in (5, 30):
            with CaptureQueriesContext(connection) as ctx:
                self.assertEqual(len(self.client.get(url, {"page_size": size}).json()["results"]), size)
            counts[size] = len(ctx.captured_queries)
        self.assertEqual(counts[5], counts[30], counts)


class SubgroupsAndBoardsPagedTests(_Tree):
    def setUp(self):
        super().setUp()
        for i in range(5):
            Group.objects.create(name=f"Sub {i}", owner=self.owner, parent=self.root)
            Board.objects.create(name=f"Board {i}", owner=self.owner, group=self.root)

    def test_subgroups_paged_matches_bare(self):
        url = f"/api/v1/groups/{self.root.pk}/subgroups/"
        bare = self.client.get(url).json()
        paged, count = self._walk(url + "paged/", 2)
        self.assertEqual(count, len(bare))
        self.assertEqual([g["id"] for g in paged], sorted(g["id"] for g in bare))
        self.assertEqual(sorted(paged[0]), sorted(bare[0]))

    def test_boards_paged_matches_bare_and_honors_expand(self):
        url = f"/api/v1/groups/{self.root.pk}/boards/"
        bare = self.client.get(url).json()
        paged, count = self._walk(url + "paged/", 2)
        self.assertEqual(count, len(bare))
        self.assertEqual([b["id"] for b in paged], sorted(b["id"] for b in bare))
        self.assertEqual(sorted(paged[0]), sorted(bare[0]))
        expanded = self.client.get(url + "paged/", {"expand": "group"}).json()["results"][0]
        self.assertIsInstance(expanded["group_detail"], dict)

    def test_query_counts_constant_in_page_size(self):
        for i in range(25):
            Group.objects.create(name=f"More {i}", owner=self.owner, parent=self.root)
            Board.objects.create(name=f"More {i}", owner=self.owner, group=self.root)
        for name in ("subgroups", "boards"):
            with self.subTest(name):
                url = f"/api/v1/groups/{self.root.pk}/{name}/paged/"
                self.client.get(url)
                counts = {}
                for size in (5, 25):
                    with CaptureQueriesContext(connection) as ctx:
                        r = self.client.get(url, {"page_size": size})
                    self.assertEqual(len(r.json()["results"]), size)
                    counts[size] = len(ctx.captured_queries)
                self.assertEqual(counts[5], counts[25], counts)
                with CaptureQueriesContext(connection) as ctx:
                    self.client.get(f"/api/v1/groups/{self.root.pk}/{name}/")
                self.assertLessEqual(counts[25], len(ctx.captured_queries) + 1)


class PagedAccessGateTests(_Tree):
    def test_outsider_gets_same_status_as_bare_route(self):
        outsider = APIClient()
        outsider.force_authenticate(_user("outsider"))
        for name in ("members", "subgroups", "boards"):
            with self.subTest(name):
                bare = outsider.get(f"/api/v1/groups/{self.leaf.pk}/{name}/")
                paged = outsider.get(f"/api/v1/groups/{self.leaf.pk}/{name}/paged/")
                self.assertIn(paged.status_code, (403, 404))
                self.assertEqual(paged.status_code, bare.status_code)

    def test_anonymous_is_rejected(self):
        for name in ("members", "subgroups", "boards"):
            with self.subTest(name):
                r = APIClient().get(f"/api/v1/groups/{self.leaf.pk}/{name}/paged/")
                self.assertIn(r.status_code, (401, 403))

    def test_paged_routes_are_get_only(self):
        for name in ("members", "subgroups", "boards"):
            with self.subTest(name):
                r = self.client.post(f"/api/v1/groups/{self.leaf.pk}/{name}/paged/", {})
                self.assertEqual(r.status_code, 405)


class PagedSchemaTests(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from drf_spectacular.generators import SchemaGenerator

        cls.schema = SchemaGenerator().get_schema(request=None, public=True)

    def test_bare_routes_stay_arrays_and_paged_use_envelope(self):
        for name, item in (("members", "GroupMembership"), ("subgroups", "Group"), ("boards", "Board")):
            with self.subTest(name):
                bare = self.schema["paths"][f"/api/v1/groups/{{id}}/{name}/"]["get"]
                schema = bare["responses"]["200"]["content"]["application/json"]["schema"]
                self.assertEqual(schema.get("type"), "array")
                self.assertNotIn("page_size", {p["name"] for p in bare.get("parameters", [])})
                paged = self.schema["paths"][f"/api/v1/groups/{{id}}/{name}/paged/"]["get"]
                ref = paged["responses"]["200"]["content"]["application/json"]["schema"]["$ref"]
                self.assertEqual(ref, f"#/components/schemas/Paginated{item}List")
                self.assertTrue({"offset", "page_size"} <= {p["name"] for p in paged["parameters"]})
