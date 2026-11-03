"""Ancestor groups a caller reaches only through a subgroup render navigation-only (#1681).

``GET /api/v1/groups/`` and ``GET /api/v1/groups/{id}/`` include ancestors of
the caller's groups so the sidebar can show the path to a subgroup. Access
inherits downward only (``user_has_group_access``), so such an ancestor carries
navigation fields only; the other keys stay with empty values.
"""
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from accounts.models import User
from groups.models import Group, GroupLabel, GroupMembership
from groups.serializers import GroupSerializer, full_group_access

_WITHHELD = {
    "description": "",
    "member_count": 0,
    "board_count": 0,
    "subgroup_count": 0,
    "allowed_priorities": [],
    "shared_labels": [],
}


def _group(owner, name, parent=None, **kwargs):
    group = Group.objects.create(name=name, owner=owner, parent=parent, **kwargs)
    GroupMembership.objects.create(group=group, user=owner, role=GroupMembership.Role.ADMIN)
    return group


class AncestorGroupFieldsTests(TestCase):
    def setUp(self):
        self.parent_admin = User.objects.create_user(username="parentadmin", password="pass")
        self.sub_member = User.objects.create_user(username="submember", password="pass")
        self.parent = _group(
            self.parent_admin, "Parent", description="Parent notes",
            allowed_priorities=["high"],
        )
        GroupLabel.objects.create(group=self.parent, name="Parent label", color="#112233")
        self.sub = _group(self.parent_admin, "Sub", parent=self.parent, description="Sub notes")
        GroupLabel.objects.create(group=self.sub, name="Sub label", color="#445566")
        GroupMembership.objects.create(
            group=self.sub, user=self.sub_member, role=GroupMembership.Role.MEMBER,
        )
        self.client = APIClient()

    def _get(self, user, path):
        self.client.force_authenticate(user)
        response = self.client.get(path)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def _list(self, user):
        return {g["id"]: g for g in self._get(user, "/api/v1/groups/")["results"]}

    def assertNavigationOnly(self, data):
        self.assertTrue(data["navigation_only"])
        for key, empty in _WITHHELD.items():
            self.assertEqual(data[key], empty, key)
        # Navigation fields stay.
        self.assertEqual(data["id"], self.parent.id)
        self.assertEqual(data["name"], "Parent")
        self.assertIsNone(data["parent"])
        self.assertIn("is_starred", data)

    def assertFull(self, data):
        self.assertFalse(data["navigation_only"])

    # -- retrieve --------------------------------------------------------

    def test_subgroup_only_member_retrieves_parent_navigation_only(self):
        data = self._get(self.sub_member, f"/api/v1/groups/{self.parent.id}/")
        self.assertNavigationOnly(data)
        self.assertEqual(data["ancestors"], [])

    def test_parent_member_retrieves_parent_with_all_fields(self):
        data = self._get(self.parent_admin, f"/api/v1/groups/{self.parent.id}/")
        self.assertFull(data)
        self.assertEqual(data["description"], "Parent notes")
        self.assertEqual([lbl["name"] for lbl in data["shared_labels"]], ["Parent label"])
        self.assertEqual(data["allowed_priorities"], ["high"])
        self.assertEqual(data["member_count"], 1)
        self.assertEqual(data["subgroup_count"], 1)

    def test_subgroup_only_member_retrieves_own_subgroup_with_all_fields(self):
        data = self._get(self.sub_member, f"/api/v1/groups/{self.sub.id}/")
        self.assertFull(data)
        self.assertEqual(data["description"], "Sub notes")
        self.assertEqual([lbl["name"] for lbl in data["shared_labels"]], ["Sub label"])
        self.assertEqual(data["ancestors"], [{"id": self.parent.id, "name": "Parent"}])

    def test_navigation_only_response_keeps_every_key(self):
        restricted = self._get(self.sub_member, f"/api/v1/groups/{self.parent.id}/")
        full = self._get(self.parent_admin, f"/api/v1/groups/{self.parent.id}/")
        self.assertEqual(set(restricted), set(full))

    def test_all_content_user_retrieves_parent_with_all_fields(self):
        self.sub_member.can_access_all_content = True
        self.sub_member.save(update_fields=["can_access_all_content"])
        data = self._get(self.sub_member, f"/api/v1/groups/{self.parent.id}/")
        self.assertFull(data)
        self.assertEqual(data["description"], "Parent notes")

    def test_nested_labels_route_agrees_with_retrieve(self):
        self.client.force_authenticate(self.sub_member)
        self.assertEqual(
            self.client.get(f"/api/v1/groups/{self.parent.id}/labels/").status_code, 403,
        )

    def test_owner_without_membership_of_parent_gets_navigation_only(self):
        # Ownership alone is not membership for the access predicate the
        # nested routes use, so the payload follows the same rule.
        owner = User.objects.create_user(username="ownernomember", password="pass")
        self.parent.owner = owner
        self.parent.save(update_fields=["owner"])
        GroupMembership.objects.create(
            group=self.sub, user=owner, role=GroupMembership.Role.MEMBER,
        )
        data = self._get(owner, f"/api/v1/groups/{self.parent.id}/")
        self.assertNavigationOnly(data)
        self.client.force_authenticate(owner)
        for route in ("labels", "members", "boards"):
            self.assertEqual(
                self.client.get(f"/api/v1/groups/{self.parent.id}/{route}/").status_code,
                403, route,
            )

    # -- serializer without a viewer ------------------------------------

    def test_serializer_without_context_withholds(self):
        data = GroupSerializer(self.parent).data
        self.assertNavigationOnly(data)

    def test_serializer_with_full_group_access_returns_all_fields(self):
        data = GroupSerializer(self.parent, context={"group_access": full_group_access}).data
        self.assertFull(data)
        self.assertEqual(data["description"], "Parent notes")

    # -- list ------------------------------------------------------------

    def test_subgroup_only_member_lists_parent_navigation_only(self):
        rows = self._list(self.sub_member)
        self.assertEqual(set(rows), {self.parent.id, self.sub.id})
        self.assertNavigationOnly(rows[self.parent.id])
        self.assertFull(rows[self.sub.id])
        self.assertEqual(
            [lbl["name"] for lbl in rows[self.sub.id]["shared_labels"]], ["Sub label"],
        )

    def test_parent_member_lists_every_group_with_all_fields(self):
        rows = self._list(self.parent_admin)
        self.assertFull(rows[self.parent.id])
        self.assertFull(rows[self.sub.id])
        self.assertEqual(rows[self.parent.id]["description"], "Parent notes")

    def test_middle_member_sees_grandparent_navigation_only_and_child_full(self):
        child = _group(self.parent_admin, "Child", parent=self.sub)
        rows = self._list(self.sub_member)
        self.assertNavigationOnly(rows[self.parent.id])
        self.assertFull(rows[self.sub.id])
        self.assertFull(rows[child.id])

    def test_list_query_count_does_not_grow_with_rows(self):
        def count():
            self.client.force_authenticate(self.sub_member)
            with CaptureQueriesContext(connection) as ctx:
                response = self.client.get("/api/v1/groups/")
            self.assertEqual(response.status_code, 200)
            return len(ctx.captured_queries)

        baseline = count()
        # Three more trees of the same shape: three more navigation-only rows
        # and three more full rows, at the same depth (the accessible-id walk
        # issues one query per tree level, independent of this change).
        for i in range(3):
            root = _group(self.parent_admin, f"Root {i}")
            GroupLabel.objects.create(group=root, name=f"R{i}", color="#000000")
            sub = _group(self.parent_admin, f"Sub {i}", parent=root)
            GroupMembership.objects.create(
                group=sub, user=self.sub_member, role=GroupMembership.Role.MEMBER,
            )
        rows = self._list(self.sub_member)
        self.assertEqual(len(rows), 8)
        self.assertEqual(sum(r["navigation_only"] for r in rows.values()), 4)
        self.assertEqual(count(), baseline)

    # -- subgroups action ------------------------------------------------

    def test_subgroups_action_renders_full_and_query_count_is_flat(self):
        def fetch():
            self.client.force_authenticate(self.parent_admin)
            with CaptureQueriesContext(connection) as ctx:
                response = self.client.get(f"/api/v1/groups/{self.parent.id}/subgroups/")
            self.assertEqual(response.status_code, 200)
            return response.json(), len(ctx.captured_queries)

        rows, baseline = fetch()
        self.assertTrue(rows and all(not r["navigation_only"] for r in rows))
        for i in range(3):
            _group(self.parent_admin, f"Sibling {i}", parent=self.parent)
        rows, queries = fetch()
        self.assertEqual(len(rows), 4)
        self.assertTrue(all(not r["navigation_only"] for r in rows))
        self.assertEqual(queries, baseline)


class DeepAncestorWalkTests(TestCase):
    """``get_accessible_group_ids`` lists every ancestor, not just the parent (#2080).

    Widening the id set must widen navigation only: a grandparent reached
    through a member's subgroup renders navigation-only and its nested routes
    stay closed, exactly like the immediate parent (#1681).
    """

    def setUp(self):
        self.admin = User.objects.create_user(username="deepadmin", password="pass")
        self.member = User.objects.create_user(username="deepmember", password="pass")
        self.root = _group(self.admin, "Root", description="Root notes")
        self.mid = _group(self.admin, "Mid", parent=self.root)
        self.leaf = _group(self.admin, "Leaf", parent=self.mid)
        GroupMembership.objects.create(
            group=self.leaf, user=self.member, role=GroupMembership.Role.MEMBER,
        )
        self.client = APIClient()
        self.client.force_authenticate(self.member)

    def test_depth_three_member_gets_all_ancestors(self):
        from groups.models import get_accessible_group_ids

        self.assertEqual(
            get_accessible_group_ids(self.member),
            {self.root.id, self.mid.id, self.leaf.id},
        )

    def test_walk_stays_bounded_on_a_cycle(self):
        from groups.models import get_accessible_group_ids

        # Bypass validation to force root -> leaf -> mid -> root.
        Group.objects.filter(pk=self.root.pk).update(parent=self.leaf)
        self.assertEqual(
            get_accessible_group_ids(self.member),
            {self.root.id, self.mid.id, self.leaf.id},
        )

    def test_grandparent_is_navigation_only_in_list_and_retrieve(self):
        response = self.client.get("/api/v1/groups/")
        self.assertEqual(response.status_code, 200)
        rows = {g["id"]: g for g in response.json()["results"]}
        self.assertEqual(set(rows), {self.root.id, self.mid.id, self.leaf.id})
        for group in (self.root, self.mid):
            self.assertTrue(rows[group.id]["navigation_only"])
            for key, empty in _WITHHELD.items():
                self.assertEqual(rows[group.id][key], empty, key)
        self.assertFalse(rows[self.leaf.id]["navigation_only"])
        detail = self.client.get(f"/api/v1/groups/{self.root.id}/")
        self.assertEqual(detail.status_code, 200)
        self.assertTrue(detail.json()["navigation_only"])
        self.assertEqual(detail.json()["description"], "")

    def test_grandparent_nested_routes_stay_closed(self):
        for suffix in ("members", "boards", "labels", "subgroups"):
            response = self.client.get(f"/api/v1/groups/{self.root.id}/{suffix}/")
            self.assertEqual(response.status_code, 403, suffix)

    def test_grandparent_grants_no_role_or_write(self):
        from groups.models import user_has_group_access, user_is_group_admin

        self.assertFalse(user_has_group_access(self.member, self.root))
        self.assertFalse(user_is_group_admin(self.member, self.root))
        patch = self.client.patch(
            f"/api/v1/groups/{self.root.id}/", {"name": "Hijack"}, format="json",
        )
        self.assertEqual(patch.status_code, 403)
        self.root.refresh_from_db()
        self.assertEqual(self.root.name, "Root")

    def test_ancestor_walk_query_count_is_flat_in_depth(self):
        from groups.models import get_accessible_group_ids

        def chain(depth, tag):
            node = None
            for i in range(depth):
                node = _group(self.admin, f"{tag}{i}", parent=node)
            GroupMembership.objects.create(
                group=node, user=self.member, role=GroupMembership.Role.MEMBER,
            )
            return node

        def count():
            with CaptureQueriesContext(connection) as ctx:
                get_accessible_group_ids(self.member)
            return len(ctx.captured_queries)

        baseline = count()
        chain(5, "deep")
        self.assertEqual(count(), baseline)

    def test_grandparent_detail_routes_stay_closed(self):
        base = f"/api/v1/groups/{self.root.id}"
        for suffix in ("descendant-boards", "invite-links", "board-defaults"):
            response = self.client.get(f"{base}/{suffix}/")
            self.assertIn(response.status_code, (403, 404, 405), suffix)
            self.assertNotEqual(response.status_code, 200, suffix)
        self.assertEqual(self.client.delete(f"{base}/").status_code, 403)
        self.assertEqual(
            self.client.post(f"{base}/boards/", {"name": "x"}, format="json").status_code, 403,
        )

    def test_ancestor_and_descendant_membership_keeps_sibling_branch(self):
        from groups.models import get_accessible_group_ids

        # R > M > N > L plus M2 under M; member of R and L. M2 is under R, so
        # the member can open it and the list must include it.
        n = _group(self.admin, "N", parent=self.mid)
        low = _group(self.admin, "Low", parent=n)
        m2 = _group(self.admin, "M2", parent=self.mid)
        GroupMembership.objects.create(group=self.root, user=self.member, role=GroupMembership.Role.MEMBER)
        GroupMembership.objects.create(group=low, user=self.member, role=GroupMembership.Role.MEMBER)
        self.assertIn(m2.id, get_accessible_group_ids(self.member))

    def test_descendant_only_member_does_not_see_uncle_branch(self):
        from groups.models import get_accessible_group_ids

        # R > M > Leaf plus L2 under M; member of Leaf only. L2 is a sibling
        # reached only through an ancestor, so it must stay hidden.
        sibling = _group(self.admin, "Sibling", parent=self.mid)
        uncle = _group(self.admin, "Uncle", parent=self.root)
        ids = get_accessible_group_ids(self.member)
        self.assertNotIn(sibling.id, ids)
        self.assertNotIn(uncle.id, ids)

    def test_ancestor_chain_matches_access_cap(self):
        from groups.models import _GROUP_TRAVERSAL_MAX_DEPTH, get_accessible_group_ids

        node = None
        chain = []
        for i in range(_GROUP_TRAVERSAL_MAX_DEPTH + 2):
            node = _group(self.admin, f"Cap{i}", parent=node)
            chain.append(node)
        user = User.objects.create_user(username="capuser", password="pass")
        GroupMembership.objects.create(group=node, user=user, role=GroupMembership.Role.MEMBER)
        ids = get_accessible_group_ids(user)
        # The member's group plus its ancestors: MAX_DEPTH groups, like
        # user_has_group_access.
        expected = {g.id for g in chain[-_GROUP_TRAVERSAL_MAX_DEPTH:]}
        self.assertEqual(ids, expected)
