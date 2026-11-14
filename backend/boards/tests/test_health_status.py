"""Board and group health status (#1133).

Covers the stored value (validation, permissions), the effective value
(downward live cascade, sticky override, depth cap, source ref), the
navigation-only withholding on groups, the ``board.updated`` / ``group.updated``
payloads, and the query-count guard on every list that carries the fields.
"""
from unittest.mock import patch

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership
from groups.health import build_health_map, resolve_health
from groups.models import Group, GroupMembership, HealthStatus, _GROUP_TRAVERSAL_MAX_DEPTH

PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"
HEALTH_KEYS = ("health_status", "effective_health_status", "health_status_source")


def _chain(owner, depth, prefix="G"):
    """A root-first list of ``depth`` nested groups."""
    groups = []
    parent = None
    for level in range(1, depth + 1):
        parent = Group.objects.create(name=f"{prefix}{level}", owner=owner, parent=parent)
        groups.append(parent)
    return groups


def _set(entity, value):
    type(entity).objects.filter(pk=entity.pk).update(health_status=value)


class HealthResolverUnitTests(TestCase):
    """``groups.health`` on its own: resolution rules and the map builder."""

    def setUp(self):
        self.owner = User.objects.create_user(username="hs_unit", password="pass")

    def test_own_value_wins_and_has_no_source(self):
        self.assertEqual(resolve_health("at_risk", None, {}), ("at_risk", None))

    def test_nothing_set_is_null_with_no_source(self):
        groups = _chain(self.owner, 3)
        health_map = build_health_map([(None, groups[-1].pk)])
        self.assertEqual(resolve_health(None, groups[-1].pk, health_map), (None, None))

    def test_stored_value_outside_the_enum_is_treated_as_unset(self):
        # choices are not a DB constraint; a shell-written value must not be
        # published as an effective value outside the documented enum.
        root, child = _chain(self.owner, 2)
        _set(root, "on_track")
        _set(child, "purple")
        health_map = build_health_map([(None, child.pk)])
        self.assertEqual(
            resolve_health("bogus", child.pk, health_map),
            ("on_track", {"id": root.pk, "name": root.name, "changed_at": None}),
        )

    def test_loaded_chain_costs_no_query(self):
        groups = _chain(self.owner, 4)
        _set(groups[0], "off_track")
        leaf = Group.objects.select_related(
            *["__".join(["parent"] * d) for d in range(1, _GROUP_TRAVERSAL_MAX_DEPTH + 1)]
        ).get(pk=groups[-1].pk)
        with self.assertNumQueries(0):
            health_map = build_health_map([(leaf, leaf.pk)])
        self.assertEqual(resolve_health(None, leaf.pk, health_map)[0], "off_track")

    def test_unloaded_chains_cost_one_query_together(self):
        a = _chain(self.owner, 5, prefix="A")
        b = _chain(self.owner, 3, prefix="B")
        _set(a[0], "at_risk")
        _set(b[1], "on_track")
        with self.assertNumQueries(1):
            health_map = build_health_map([(None, a[-1].pk), (None, b[-1].pk)])
        self.assertEqual(resolve_health(None, a[-1].pk, health_map), ("at_risk", {"id": a[0].pk, "name": "A1", "changed_at": None}))
        self.assertEqual(resolve_health(None, b[-1].pk, health_map), ("on_track", {"id": b[1].pk, "name": "B2", "changed_at": None}))


class BoardHealthStatusTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="hs_owner", password="pass")
        self.groups = _chain(self.owner, 6)
        GroupMembership.objects.create(group=self.groups[0], user=self.owner, role=GroupMembership.Role.ADMIN)
        self.board = Board.objects.create(name="Leaf board", owner=self.owner, group=self.groups[-1])
        BoardMembership.objects.create(board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def _patch_board(self, body, client=None):
        with patch(PATCH_BROADCAST):
            return (client or self.client).patch(f"/api/v1/boards/{self.board.pk}/", body, format="json")

    def _detail(self):
        r = self.client.get(f"/api/v1/boards/{self.board.pk}/")
        self.assertEqual(r.status_code, 200)
        return r.json()

    # ── validation ──────────────────────────────────────────────────────────

    def test_defaults_to_null_everywhere(self):
        body = self._detail()
        for key in HEALTH_KEYS:
            self.assertIsNone(body[key], key)

    def test_each_value_round_trips_and_null_clears(self):
        for value in HealthStatus.values:
            with self.subTest(value=value):
                r = self._patch_board({"health_status": value})
                self.assertEqual(r.status_code, 200, r.content)
                self.assertEqual(r.json()["health_status"], value)
                self.assertEqual(r.json()["effective_health_status"], value)
                self.assertIsNone(r.json()["health_status_source"])
        r = self._patch_board({"health_status": None})
        self.assertEqual(r.status_code, 200)
        self.board.refresh_from_db()
        self.assertIsNone(self.board.health_status)

    def test_invalid_values_are_400_and_not_stored(self):
        for bad in ("green", "", "ON_TRACK", 3, ["on_track"], {"v": 1}):
            with self.subTest(bad=bad):
                r = self._patch_board({"health_status": bad})
                self.assertEqual(r.status_code, 400)
                self.assertIn("health_status", r.json())
        self.board.refresh_from_db()
        self.assertIsNone(self.board.health_status)

    def test_create_accepts_health_status(self):
        with patch(PATCH_BROADCAST):
            r = self.client.post("/api/v1/boards/", {"name": "New", "health_status": "at_risk"}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(Board.objects.get(pk=r.json()["id"]).health_status, "at_risk")

    def test_effective_fields_are_read_only(self):
        _set(self.groups[0], "on_track")
        r = self._patch_board({"effective_health_status": "off_track", "health_status_source": {"id": 1, "name": "x"}})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["effective_health_status"], "on_track")
        self.board.refresh_from_db()
        self.assertIsNone(self.board.health_status)

    # ── cascade ─────────────────────────────────────────────────────────────

    def test_inherits_from_each_ancestor_depth_1_to_6(self):
        """The board's group is depth 1; the root of a six-level tree is depth 6."""
        for depth in range(1, 7):
            source = self.groups[-depth]
            Group.objects.update(health_status=None)
            _set(source, "at_risk")
            with self.subTest(depth=depth):
                body = self._detail()
                self.assertIsNone(body["health_status"])
                self.assertEqual(body["effective_health_status"], "at_risk")
                self.assertEqual(body["health_status_source"], {"id": source.pk, "name": source.name, "changed_at": None})

    def test_nearest_ancestor_wins(self):
        _set(self.groups[0], "off_track")
        _set(self.groups[3], "on_track")
        body = self._detail()
        self.assertEqual(body["effective_health_status"], "on_track")
        self.assertEqual(body["health_status_source"]["id"], self.groups[3].pk)

    def test_walk_is_capped_at_six_groups(self):
        """A pre-#1690 tree deeper than the cap: a value seven groups up is not reached."""
        top = Group.objects.create(name="Above cap", owner=self.owner)
        Group.objects.filter(pk=self.groups[0].pk).update(parent=top)
        _set(top, "off_track")
        self.assertIsNone(self._detail()["effective_health_status"])

    def test_live_parent_change_reaches_child_on_next_read(self):
        _set(self.groups[2], "on_track")
        self.assertEqual(self._detail()["effective_health_status"], "on_track")
        _set(self.groups[2], "off_track")
        self.assertEqual(self._detail()["effective_health_status"], "off_track")
        _set(self.groups[2], None)
        body = self._detail()
        self.assertIsNone(body["effective_health_status"])
        self.assertIsNone(body["health_status_source"])

    def test_override_is_sticky_across_parent_changes(self):
        self._patch_board({"health_status": "at_risk"})
        for parent_value in ("on_track", "off_track", None):
            _set(self.groups[-1], parent_value)
            with self.subTest(parent=parent_value):
                body = self._detail()
                self.assertEqual(body["health_status"], "at_risk")
                self.assertEqual(body["effective_health_status"], "at_risk")
                self.assertIsNone(body["health_status_source"])

    def test_explicit_value_equal_to_parent_is_set_here(self):
        _set(self.groups[-1], "on_track")
        body = self._patch_board({"health_status": "on_track"}).json()
        self.assertEqual(body["health_status"], "on_track")
        self.assertIsNone(body["health_status_source"])

    def test_personal_board_has_no_inheritance(self):
        personal = Board.objects.create(name="Mine", owner=self.owner)
        BoardMembership.objects.create(board=personal, user=self.owner, role=BoardMembership.Role.ADMIN)
        body = self.client.get(f"/api/v1/boards/{personal.pk}/").json()
        self.assertEqual([body[k] for k in HEALTH_KEYS], [None, None, None])

    def test_full_endpoint_carries_fields(self):
        _set(self.groups[1], "at_risk")
        body = self.client.get(f"/api/v1/boards/{self.board.pk}/full/").json()
        self.assertIsNone(body["health_status"])
        self.assertEqual(body["effective_health_status"], "at_risk")
        self.assertEqual(body["health_status_source"], {"id": self.groups[1].pk, "name": "G2", "changed_at": None})

    def test_list_endpoints_carry_fields(self):
        _set(self.groups[0], "off_track")
        leaf = self.groups[-1]
        urls = [
            "/api/v1/boards/",
            f"/api/v1/groups/{leaf.pk}/boards/",
            f"/api/v1/groups/{self.groups[0].pk}/descendant-boards/",
            f"/api/v1/groups/{self.groups[0].pk}/descendant-boards/paged/",
        ]
        for url in urls:
            with self.subTest(url=url):
                body = self.client.get(url).json()
                rows = body["results"] if isinstance(body, dict) else body
                row = next(r for r in rows if r["id"] == self.board.pk)
                self.assertEqual(row["effective_health_status"], "off_track")
                self.assertEqual(row["health_status_source"], {"id": self.groups[0].pk, "name": "G1", "changed_at": None})

    # ── permissions ─────────────────────────────────────────────────────────

    def test_only_board_admins_may_write(self):
        for role in (BoardMembership.Role.MEMBER, BoardMembership.Role.COLLABORATOR, BoardMembership.Role.VIEWER):
            user = User.objects.create_user(username=f"hs_{role}", password="pass")
            BoardMembership.objects.create(board=self.board, user=user, role=role)
            client = APIClient()
            client.force_authenticate(user)
            with self.subTest(role=role):
                r = self._patch_board({"health_status": "off_track"}, client=client)
                self.assertEqual(r.status_code, 403)
                self.board.refresh_from_db()
                self.assertIsNone(self.board.health_status)

    def test_group_viewer_gets_403(self):
        viewer = User.objects.create_user(username="hs_group_viewer", password="pass")
        GroupMembership.objects.create(group=self.groups[-1], user=viewer, role=GroupMembership.Role.VIEWER)
        client = APIClient()
        client.force_authenticate(viewer)
        self.assertEqual(self._patch_board({"health_status": "at_risk"}, client=client).status_code, 403)

    def test_group_admin_inherits_board_admin_and_may_write(self):
        admin = User.objects.create_user(username="hs_group_admin", password="pass")
        GroupMembership.objects.create(group=self.groups[2], user=admin, role=GroupMembership.Role.ADMIN)
        client = APIClient()
        client.force_authenticate(admin)
        self.assertEqual(self._patch_board({"health_status": "at_risk"}, client=client).status_code, 200)

    def test_all_content_site_admin_may_write(self):
        site_admin = User.objects.create_user(username="hs_sa", password="pass", can_access_all_content=True)
        client = APIClient()
        client.force_authenticate(site_admin)
        self.assertEqual(self._patch_board({"health_status": "at_risk"}, client=client).status_code, 200)
        self.board.refresh_from_db()
        self.assertEqual(self.board.health_status, "at_risk")

    def test_put_from_a_member_is_403(self):
        member = User.objects.create_user(username="hs_put_member", password="pass")
        BoardMembership.objects.create(board=self.board, user=member, role=BoardMembership.Role.MEMBER)
        client = APIClient()
        client.force_authenticate(member)
        with patch(PATCH_BROADCAST):
            r = client.put(
                f"/api/v1/boards/{self.board.pk}/", {"name": self.board.name, "health_status": "off_track"}, format="json",
            )
        self.assertEqual(r.status_code, 403)
        self.board.refresh_from_db()
        self.assertIsNone(self.board.health_status)

    def test_create_into_a_group_the_caller_does_not_administer_is_refused(self):
        member = User.objects.create_user(username="hs_create_member", password="pass")
        GroupMembership.objects.create(group=self.groups[-1], user=member, role=GroupMembership.Role.MEMBER)
        client = APIClient()
        client.force_authenticate(member)
        before = Board.objects.count()
        with patch(PATCH_BROADCAST):
            nested = client.post(
                f"/api/v1/groups/{self.groups[-1].pk}/boards/", {"name": "X", "health_status": "at_risk"}, format="json",
            )
            placed = client.post(
                "/api/v1/boards/", {"name": "Y", "group": self.groups[-1].pk, "health_status": "at_risk"}, format="json",
            )
        self.assertEqual(nested.status_code, 403)
        self.assertEqual(placed.status_code, 400)
        self.assertIn("group", placed.json())
        self.assertEqual(Board.objects.count(), before)

    def test_outsider_gets_404(self):
        outsider = User.objects.create_user(username="hs_outsider", password="pass")
        client = APIClient()
        client.force_authenticate(outsider)
        self.assertEqual(self._patch_board({"health_status": "at_risk"}, client=client).status_code, 404)

    # ── broadcast ───────────────────────────────────────────────────────────

    def test_board_updated_carries_fields_and_is_deferred_to_commit(self):
        _set(self.groups[0], "on_track")
        with patch(PATCH_BROADCAST) as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=False) as callbacks:
                r = self.client.patch(
                    f"/api/v1/boards/{self.board.pk}/", {"health_status": "off_track"}, format="json",
                )
            self.assertEqual(r.status_code, 200)
            mock_broadcast.assert_not_called()
            for callback in callbacks:
                callback()
        payloads = [c[0][2] for c in mock_broadcast.call_args_list if c[0][1] == "board.updated"]
        self.assertEqual(len(payloads), 1)
        self.assertEqual(payloads[0]["health_status"], "off_track")
        self.assertEqual(payloads[0]["effective_health_status"], "off_track")
        self.assertIsNone(payloads[0]["health_status_source"])

        with patch(PATCH_BROADCAST) as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.client.patch(f"/api/v1/boards/{self.board.pk}/", {"health_status": None}, format="json")
        payload = [c[0][2] for c in mock_broadcast.call_args_list if c[0][1] == "board.updated"][0]
        self.assertIsNone(payload["health_status"])
        self.assertEqual(payload["effective_health_status"], "on_track")
        self.assertEqual(payload["health_status_source"], {"id": self.groups[0].pk, "name": "G1", "changed_at": None})


class GroupHealthStatusTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="ghs_owner", password="pass")
        self.groups = _chain(self.owner, 6)
        GroupMembership.objects.create(group=self.groups[0], user=self.owner, role=GroupMembership.Role.ADMIN)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def _patch(self, group, body, client=None):
        with patch("groups.broadcast.broadcast_group_event"):
            return (client or self.client).patch(f"/api/v1/groups/{group.pk}/", body, format="json")

    def _get(self, group, client=None):
        r = (client or self.client).get(f"/api/v1/groups/{group.pk}/")
        self.assertEqual(r.status_code, 200)
        return r.json()

    def test_each_value_round_trips_and_null_clears(self):
        group = self.groups[2]
        for value in HealthStatus.values:
            with self.subTest(value=value):
                r = self._patch(group, {"health_status": value})
                self.assertEqual(r.status_code, 200, r.content)
                self.assertEqual(r.json()["health_status"], value)
                self.assertEqual(r.json()["effective_health_status"], value)
                self.assertIsNone(r.json()["health_status_source"])
        self.assertEqual(self._patch(group, {"health_status": None}).status_code, 200)
        group.refresh_from_db()
        self.assertIsNone(group.health_status)

    def test_invalid_value_is_400(self):
        r = self._patch(self.groups[0], {"health_status": "amber"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("health_status", r.json())

    def test_create_accepts_health_status(self):
        with patch("groups.broadcast.broadcast_group_event"):
            r = self.client.post("/api/v1/groups/", {"name": "New", "health_status": "on_track"}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["effective_health_status"], "on_track")

    def test_subgroup_inherits_from_each_ancestor(self):
        leaf = self.groups[-1]
        for distance in range(1, 6):
            source = self.groups[-1 - distance]
            Group.objects.update(health_status=None)
            _set(source, "off_track")
            with self.subTest(distance=distance):
                body = self._get(leaf)
                self.assertIsNone(body["health_status"])
                self.assertEqual(body["effective_health_status"], "off_track")
                self.assertEqual(body["health_status_source"], {"id": source.pk, "name": source.name, "changed_at": None})

    def test_root_with_nothing_set_is_null(self):
        body = self._get(self.groups[0])
        self.assertEqual([body[k] for k in HEALTH_KEYS], [None, None, None])

    def test_subgroup_override_is_sticky(self):
        self._patch(self.groups[3], {"health_status": "on_track"})
        self._patch(self.groups[0], {"health_status": "off_track"})
        body = self._get(self.groups[3])
        self.assertEqual(body["effective_health_status"], "on_track")
        self.assertIsNone(body["health_status_source"])
        # A descendant of the override follows the override, not the root.
        body = self._get(self.groups[5])
        self.assertEqual(body["effective_health_status"], "on_track")
        self.assertEqual(body["health_status_source"]["id"], self.groups[3].pk)

    def test_group_write_changes_descendants_live(self):
        board = Board.objects.create(name="B", owner=self.owner, group=self.groups[-1])
        self._patch(self.groups[1], {"health_status": "at_risk"})
        body = self.client.get(f"/api/v1/boards/{board.pk}/").json()
        self.assertEqual(body["effective_health_status"], "at_risk")
        self.assertEqual(body["health_status_source"]["id"], self.groups[1].pk)

    def test_list_and_subgroups_carry_fields(self):
        _set(self.groups[0], "at_risk")
        rows = {g["id"]: g for g in self.client.get("/api/v1/groups/").json()["results"]}
        self.assertEqual(rows[self.groups[0].pk]["health_status"], "at_risk")
        self.assertEqual(rows[self.groups[4].pk]["effective_health_status"], "at_risk")
        self.assertEqual(rows[self.groups[4].pk]["health_status_source"], {"id": self.groups[0].pk, "name": "G1", "changed_at": None})
        sub = self.client.get(f"/api/v1/groups/{self.groups[1].pk}/subgroups/").json()
        self.assertEqual(sub[0]["id"], self.groups[2].pk)
        self.assertEqual(sub[0]["effective_health_status"], "at_risk")

    # ── navigation-only withholding ─────────────────────────────────────────

    def test_navigation_only_ancestor_withholds_health(self):
        sub_member = User.objects.create_user(username="ghs_sub", password="pass")
        GroupMembership.objects.create(group=self.groups[3], user=sub_member, role=GroupMembership.Role.MEMBER)
        _set(self.groups[0], "off_track")
        _set(self.groups[2], "at_risk")
        client = APIClient()
        client.force_authenticate(sub_member)
        rows = {g["id"]: g for g in client.get("/api/v1/groups/").json()["results"]}
        # The parent of the member's group is listed for navigation only.
        ancestor = rows[self.groups[2].pk]
        self.assertTrue(ancestor["navigation_only"])
        self.assertEqual([ancestor[k] for k in HEALTH_KEYS], [None, None, None])
        # The member's own group still shows the value it inherits.
        own = rows[self.groups[3].pk]
        self.assertFalse(own["navigation_only"])
        self.assertEqual(own["effective_health_status"], "at_risk")
        detail = self._get(self.groups[2], client=client)
        self.assertTrue(detail["navigation_only"])
        self.assertEqual([detail[k] for k in HEALTH_KEYS], [None, None, None])

    # ── permissions ─────────────────────────────────────────────────────────

    def test_only_group_admins_may_write(self):
        target = self.groups[2]
        for role in (GroupMembership.Role.MEMBER, GroupMembership.Role.COLLABORATOR, GroupMembership.Role.VIEWER):
            user = User.objects.create_user(username=f"ghs_{role}", password="pass")
            GroupMembership.objects.create(group=target, user=user, role=role)
            client = APIClient()
            client.force_authenticate(user)
            with self.subTest(role=role):
                self.assertEqual(self._patch(target, {"health_status": "on_track"}, client=client).status_code, 403)
        target.refresh_from_db()
        self.assertIsNone(target.health_status)

    def test_ancestor_admin_may_write(self):
        admin = User.objects.create_user(username="ghs_anc_admin", password="pass")
        GroupMembership.objects.create(group=self.groups[1], user=admin, role=GroupMembership.Role.ADMIN)
        client = APIClient()
        client.force_authenticate(admin)
        self.assertEqual(self._patch(self.groups[4], {"health_status": "on_track"}, client=client).status_code, 200)

    def test_all_content_site_admin_may_write(self):
        site_admin = User.objects.create_user(username="ghs_sa", password="pass", can_access_all_content=True)
        client = APIClient()
        client.force_authenticate(site_admin)
        self.assertEqual(self._patch(self.groups[3], {"health_status": "off_track"}, client=client).status_code, 200)
        self.groups[3].refresh_from_db()
        self.assertEqual(self.groups[3].health_status, "off_track")

    def test_put_from_a_member_is_403(self):
        member = User.objects.create_user(username="ghs_put_member", password="pass")
        GroupMembership.objects.create(group=self.groups[2], user=member, role=GroupMembership.Role.MEMBER)
        client = APIClient()
        client.force_authenticate(member)
        with patch("groups.broadcast.broadcast_group_event"):
            r = client.put(
                f"/api/v1/groups/{self.groups[2].pk}/", {"name": "G3", "health_status": "at_risk"}, format="json",
            )
        self.assertEqual(r.status_code, 403)
        self.groups[2].refresh_from_db()
        self.assertIsNone(self.groups[2].health_status)

    def test_board_defaults_ignores_health_status(self):
        """board-defaults keeps only its two keys; health is written through PATCH /groups/{id}/."""
        with patch("groups.broadcast.broadcast_group_event"):
            r = self.client.patch(
                f"/api/v1/groups/{self.groups[0].pk}/board-defaults/",
                {"health_status": "off_track", "default_board_member_role": "member"}, format="json",
            )
        self.assertEqual(r.status_code, 200)
        self.groups[0].refresh_from_db()
        self.assertIsNone(self.groups[0].health_status)

    def test_subgroup_create_under_a_group_the_caller_does_not_administer_is_refused(self):
        member = User.objects.create_user(username="ghs_create_member", password="pass")
        GroupMembership.objects.create(group=self.groups[0], user=member, role=GroupMembership.Role.MEMBER)
        client = APIClient()
        client.force_authenticate(member)
        before = Group.objects.count()
        with patch("groups.broadcast.broadcast_group_event"):
            r = client.post(
                "/api/v1/groups/", {"name": "Sub", "parent": self.groups[0].pk, "health_status": "at_risk"}, format="json",
            )
        self.assertIn(r.status_code, (400, 403))
        self.assertEqual(Group.objects.count(), before)

    def test_outsider_gets_404(self):
        outsider = User.objects.create_user(username="ghs_outsider", password="pass")
        client = APIClient()
        client.force_authenticate(outsider)
        self.assertEqual(self._patch(self.groups[0], {"health_status": "on_track"}, client=client).status_code, 404)

    # ── broadcast ───────────────────────────────────────────────────────────

    def test_group_updated_carries_fields_and_is_deferred(self):
        with patch("groups.broadcast.broadcast_group_event") as mock_group:
            with self.captureOnCommitCallbacks(execute=False) as callbacks:
                r = self.client.patch(f"/api/v1/groups/{self.groups[2].pk}/", {"health_status": "at_risk"}, format="json")
            self.assertEqual(r.status_code, 200)
            mock_group.assert_not_called()
            for callback in callbacks:
                callback()
        updates = [c for c in mock_group.call_args_list if c[0][1] == "group.updated"]
        self.assertEqual(len(updates), 1)
        self.assertEqual(updates[0][0][0], self.groups[2].pk)
        self.assertEqual(updates[0][0][2]["health_status"], "at_risk")
        self.assertEqual(updates[0][0][2]["effective_health_status"], "at_risk")

    def test_group_write_does_not_fan_out_board_updated(self):
        """v1 decision: descendants are not told (they refetch on reload/resync)."""
        Board.objects.create(name="B", owner=self.owner, group=self.groups[-1])
        with patch(PATCH_BROADCAST) as mock_board, patch("groups.broadcast.broadcast_group_event"):
            with self.captureOnCommitCallbacks(execute=True):
                self.client.patch(f"/api/v1/groups/{self.groups[0].pk}/", {"health_status": "off_track"}, format="json")
        mock_board.assert_not_called()


class HealthStatusQueryCountTests(TestCase):
    """Lists resolve every row from one ancestor map, never a walk per row."""

    def setUp(self):
        self.owner = User.objects.create_user(username="qhs_owner", password="pass")
        self.root = Group.objects.create(name="Root", owner=self.owner, health_status="at_risk")
        GroupMembership.objects.create(group=self.root, user=self.owner, role=GroupMembership.Role.ADMIN)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        self._n = 0

    def _branch(self, depth=4, override_at=None):
        """A new subtree of ``depth`` groups under root with one board at its leaf.

        ``override_at`` sets a value on that level of the branch, so walks of
        different lengths share the one map. Every branch has the same depth:
        the group-visibility walks this list builds on cost one query per tree
        level (pre-existing, unrelated to health), so only the row count may
        vary between the two measurements.
        """
        self._n += 1
        parent = self.root
        for level in range(depth):
            parent = Group.objects.create(
                name=f"S{self._n}-{level}", owner=self.owner, parent=parent,
                health_status="on_track" if level == override_at else None,
            )
        board = Board.objects.create(name=f"B{self._n}", owner=self.owner, group=parent)
        BoardMembership.objects.create(board=board, user=self.owner, role=BoardMembership.Role.ADMIN)
        return parent

    def _count(self, url):
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(url)
        self.assertEqual(r.status_code, 200)
        return len(ctx), r.json()

    def _assert_constant(self, url_for):
        self._branch()
        small, _ = self._count(url_for())
        for override_at in (0, 1, 2, 3, None):
            self._branch(override_at=override_at)
        large, body = self._count(url_for())
        self.assertEqual(small, large, f"{url_for()}: {small} queries for 1 branch, {large} for 6")
        rows = body["results"] if isinstance(body, dict) else body
        self.assertGreater(len(rows), 1)
        effective = {row["effective_health_status"] for row in rows}
        self.assertTrue(effective <= {"at_risk", "on_track"}, effective)

    def test_board_list(self):
        self._assert_constant(lambda: "/api/v1/boards/")

    def test_board_list_expanded(self):
        self._assert_constant(lambda: "/api/v1/boards/?expand=group")

    def test_group_list(self):
        self._assert_constant(lambda: "/api/v1/groups/")

    def test_descendant_boards(self):
        self._assert_constant(lambda: f"/api/v1/groups/{self.root.pk}/descendant-boards/")

    def test_descendant_boards_paged(self):
        self._assert_constant(lambda: f"/api/v1/groups/{self.root.pk}/descendant-boards/paged/")

    def test_subgroups(self):
        self._assert_constant(lambda: f"/api/v1/groups/{self.root.pk}/subgroups/")

    def test_group_boards(self):
        leaf = self._branch(4)

        def add_board(i):
            board = Board.objects.create(name=f"GB{i}", owner=self.owner, group=leaf)
            BoardMembership.objects.create(board=board, user=self.owner, role=BoardMembership.Role.ADMIN)

        small, _ = self._count(f"/api/v1/groups/{leaf.pk}/boards/")
        for i in range(6):
            add_board(i)
        large, rows = self._count(f"/api/v1/groups/{leaf.pk}/boards/")
        self.assertEqual(small, large)
        self.assertEqual({r["effective_health_status"] for r in rows}, {"at_risk"})

    def test_list_adds_at_most_one_query_for_health(self):
        """The whole page shares one ancestor query; with nothing to inherit, none."""
        for _ in range(3):
            self._branch()
        with_inheritance, _ = self._count("/api/v1/boards/")
        Board.objects.update(health_status="on_track")
        all_set, _ = self._count("/api/v1/boards/")
        self.assertLessEqual(with_inheritance - all_set, 1)
