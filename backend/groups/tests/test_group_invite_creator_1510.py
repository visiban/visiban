"""Remaining creator-state gaps on group invite links (#1510).

PATCH deactivation revokes invite links, demoting/removing a group admin
revokes their links, preview answers uniformly regardless of creator state, and
the anonymous preview no longer walks the ancestor chain one query per level.
"""

from datetime import timedelta
from unittest.mock import patch

from django.test import TestCase
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import InviteLink, PersonalAccessToken, User
from boards.models import Board, BoardInviteLink
from groups.models import Group, GroupInviteLink, GroupMembership


def join_url(token):
    return f"/api/v1/groups/join/{token}/"


class PatchDeactivationRevokesLinksTests(TestCase):
    def setUp(self):
        self.site_admin = User.objects.create_user(
            username="siteadmin", password="pw", is_site_admin=True,
        )
        self.creator = User.objects.create_user(username="creator", password="pw")
        self.group = Group.objects.create(name="G", owner=self.creator)
        GroupMembership.objects.create(
            group=self.group, user=self.creator, role=GroupMembership.Role.ADMIN,
        )
        self.group_link, _ = GroupInviteLink.generate(self.group, self.creator)
        self.site_link, _ = InviteLink.generate(self.creator)
        # Board owned by someone else so the PATCH owned-boards guard passes.
        owner = User.objects.create_user(username="boardowner", password="pw")
        self.board = Board.objects.create(name="B", owner=owner)
        self.board_link, _ = BoardInviteLink.generate(
            board=self.board, created_by=self.creator,
            expires_at=timezone.now() + timedelta(days=7),
        )
        self.client = APIClient()
        self.client.force_authenticate(self.site_admin)

    def _patch(self, **body):
        return self.client.patch(
            f"/api/v1/admin/users/{self.creator.pk}/", body, format="json",
        )

    def test_patch_deactivate_revokes_site_board_and_group_links(self):
        self.assertEqual(self._patch(is_active=False).status_code, status.HTTP_200_OK)
        self.group_link.refresh_from_db()
        self.site_link.refresh_from_db()
        self.board_link.refresh_from_db()
        self.assertFalse(self.group_link.is_active)
        self.assertEqual(self.group_link.status, "revoked")
        self.assertIsNotNone(self.site_link.revoked_at)
        self.assertIsNotNone(self.board_link.revoked_at)

    def test_patch_deactivate_broadcasts_group_revoked_after_commit(self):
        with (
            patch("groups.broadcast.broadcast_group_event") as mock_bc,
            self.captureOnCommitCallbacks(execute=True),
        ):
            self._patch(is_active=False)
        mock_bc.assert_called_once_with(
            self.group.pk, "invite_link.revoked", {"id": self.group_link.pk},
        )

    def test_patch_without_deactivation_leaves_links_alone(self):
        self.assertEqual(
            self._patch(has_completed_tour=True).status_code, status.HTTP_200_OK,
        )
        self.group_link.refresh_from_db()
        self.site_link.refresh_from_db()
        self.assertTrue(self.group_link.is_active)
        self.assertIsNone(self.site_link.revoked_at)

    def test_patch_reactivation_does_not_touch_links(self):
        User.objects.filter(pk=self.creator.pk).update(is_active=False)
        self.assertEqual(self._patch(is_active=True).status_code, status.HTTP_200_OK)
        self.group_link.refresh_from_db()
        self.assertTrue(self.group_link.is_active)


class PatchDeactivationTokenTests(TestCase):
    def test_pat_stays_dead_after_patch_deactivate_then_reactivate(self):
        admin = User.objects.create_user(username="sa", password="pw", is_site_admin=True)
        user = User.objects.create_user(username="victim", password="pw")
        _, raw = PersonalAccessToken.generate(user, "ci")
        header = {"HTTP_AUTHORIZATION": f"Token {raw}"}
        self.assertEqual(APIClient().get("/api/v1/auth/me/", **header).status_code, 200)
        c = APIClient()
        c.force_authenticate(admin)
        url = f"/api/v1/admin/users/{user.pk}/"
        self.assertEqual(c.patch(url, {"is_active": False}, format="json").status_code, 200)
        self.assertFalse(user.personal_access_tokens.exists())
        self.assertEqual(c.patch(url, {"is_active": True}, format="json").status_code, 200)
        self.assertEqual(APIClient().get("/api/v1/auth/me/", **header).status_code, 401)


class FlagClearRevokesLinksTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(username="sa", password="pw", is_site_admin=True)
        self.user = User.objects.create_user(
            username="omni", password="pw", can_access_all_content=True,
        )
        owner = User.objects.create_user(username="own", password="pw")
        self.g1 = Group.objects.create(name="G1", owner=owner)
        self.g2 = Group.objects.create(name="G2", owner=owner)
        # Admin by membership in g2 only; g1 link is held via the flag alone.
        GroupMembership.objects.create(
            group=self.g2, user=self.user, role=GroupMembership.Role.ADMIN,
        )
        self.l1, _ = GroupInviteLink.generate(self.g1, self.user)
        self.l2, _ = GroupInviteLink.generate(self.g2, self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def test_clearing_can_access_all_content_revokes_only_lapsed_links(self):
        with (
            patch("groups.broadcast.broadcast_group_event") as mock_bc,
            self.captureOnCommitCallbacks(execute=True),
        ):
            r = self.client.patch(
                f"/api/v1/admin/users/{self.user.pk}/",
                {"can_access_all_content": False}, format="json",
            )
        self.assertEqual(r.status_code, 200)
        self.l1.refresh_from_db()
        self.l2.refresh_from_db()
        self.assertFalse(self.l1.is_active)
        self.assertTrue(self.l2.is_active)
        mock_bc.assert_called_once_with(
            self.g1.pk, "invite_link.revoked", {"id": self.l1.pk},
        )

    def test_granting_flag_or_unrelated_patch_revokes_nothing(self):
        self.client.patch(
            f"/api/v1/admin/users/{self.user.pk}/",
            {"has_completed_tour": True}, format="json",
        )
        self.l1.refresh_from_db()
        self.assertTrue(self.l1.is_active)


class AdminDemotionRevokesLinksTests(TestCase):
    def setUp(self):
        self.boss = User.objects.create_user(username="boss", password="pw")
        self.creator = User.objects.create_user(username="creator", password="pw")
        self.group = Group.objects.create(name="Parent", owner=self.boss)
        self.child = Group.objects.create(name="Child", owner=self.boss, parent=self.group)
        for g in (self.group,):
            GroupMembership.objects.create(
                group=g, user=self.boss, role=GroupMembership.Role.ADMIN,
            )
        self.creator_membership = GroupMembership.objects.create(
            group=self.group, user=self.creator, role=GroupMembership.Role.ADMIN,
        )
        self.link, self.raw = GroupInviteLink.generate(self.group, self.creator)
        self.child_link, _ = GroupInviteLink.generate(self.child, self.creator)
        self.boss_link, _ = GroupInviteLink.generate(self.group, self.boss)
        self.client = APIClient()
        self.client.force_authenticate(self.boss)

    def _member_url(self):
        return f"/api/v1/groups/{self.group.pk}/members/{self.creator.pk}/"

    def test_demotion_revokes_creators_links_in_group_and_subtree(self):
        with (
            patch("groups.broadcast.broadcast_group_event") as mock_bc,
            self.captureOnCommitCallbacks(execute=True),
        ):
            resp = self.client.patch(self._member_url(), {"role": "member"}, format="json")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.link.refresh_from_db()
        self.child_link.refresh_from_db()
        self.boss_link.refresh_from_db()
        self.assertFalse(self.link.is_active)
        self.assertFalse(self.child_link.is_active)
        self.assertTrue(self.boss_link.is_active)
        revoked = [c.args for c in mock_bc.call_args_list if c.args[1] == "invite_link.revoked"]
        self.assertCountEqual(
            revoked,
            [
                (self.group.pk, "invite_link.revoked", {"id": self.link.pk}),
                (self.child.pk, "invite_link.revoked", {"id": self.child_link.pk}),
            ],
        )

    def test_removal_revokes_creators_links(self):
        resp = self.client.delete(self._member_url())
        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        self.link.refresh_from_db()
        self.child_link.refresh_from_db()
        self.assertFalse(self.link.is_active)
        self.assertFalse(self.child_link.is_active)

    def test_role_change_to_admin_keeps_links(self):
        resp = self.client.patch(self._member_url(), {"role": "admin"}, format="json")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.link.refresh_from_db()
        self.assertTrue(self.link.is_active)

    def test_demotion_keeps_link_when_still_admin_via_another_path(self):
        # Direct admin on the child keeps the child link; parent link goes.
        GroupMembership.objects.create(
            group=self.child, user=self.creator, role=GroupMembership.Role.ADMIN,
        )
        self.client.patch(self._member_url(), {"role": "member"}, format="json")
        self.link.refresh_from_db()
        self.child_link.refresh_from_db()
        self.assertFalse(self.link.is_active)
        self.assertTrue(self.child_link.is_active)

    def test_demotion_leaves_consumed_single_use_link_alone(self):
        used, _ = GroupInviteLink.generate(self.group, self.creator, single_use=True)
        GroupInviteLink.objects.filter(pk=used.pk).update(used_at=timezone.now())
        self.client.patch(self._member_url(), {"role": "member"}, format="json")
        used.refresh_from_db()
        self.assertTrue(used.is_active)
        self.assertEqual(used.status, "used")

    def test_demotion_frees_a_slot_under_the_active_link_cap(self):
        before = GroupInviteLink.objects.filter(
            group=self.group, created_by=self.creator, is_active=True,
        ).count()
        self.assertEqual(before, 1)
        self.client.patch(self._member_url(), {"role": "member"}, format="json")
        self.assertEqual(
            GroupInviteLink.objects.filter(
                group=self.group, created_by=self.creator, is_active=True,
            ).count(),
            0,
        )

    def test_no_broadcast_when_demoted_member_has_no_links(self):
        GroupInviteLink.objects.filter(created_by=self.creator).update(is_active=False)
        with (
            patch("groups.broadcast.broadcast_group_event") as mock_bc,
            self.captureOnCommitCallbacks(execute=True),
        ):
            self.client.patch(self._member_url(), {"role": "member"}, format="json")
        self.assertFalse(
            [c for c in mock_bc.call_args_list if c.args[1] == "invite_link.revoked"]
        )


class PreviewUniformityTests(TestCase):
    """Creator-gone answers 404 whatever the link's used/expired state (#1510)."""

    def setUp(self):
        self.creator = User.objects.create_user(username="creator", password="pw")
        self.joiner = User.objects.create_user(username="joiner", password="pw")
        self.group = Group.objects.create(name="G", owner=self.creator)
        GroupMembership.objects.create(
            group=self.group, user=self.creator, role=GroupMembership.Role.ADMIN,
        )
        self.client = APIClient()
        self.client.force_authenticate(self.joiner)

    def _gone_creator(self):
        User.objects.filter(pk=self.creator.pk).update(is_active=False)

    def test_expired_link_with_gone_creator_matches_live_creator_shape_404(self):
        link, raw = GroupInviteLink.generate(
            self.group, self.creator, expires_at=timezone.now() - timedelta(days=1),
        )
        # Live creator: expired is 410.
        self.assertEqual(self.client.get(join_url(raw)).status_code, 410)
        self._gone_creator()
        # Gone creator: 404 — same as a used or fresh link with a gone creator.
        self.assertEqual(self.client.get(join_url(raw)).status_code, 404)
        self.assertEqual(self.client.post(join_url(raw)).status_code, 404)

    def test_used_single_use_link_with_gone_creator_is_404_to_non_member(self):
        link, raw = GroupInviteLink.generate(self.group, self.creator, single_use=True)
        GroupInviteLink.objects.filter(pk=link.pk).update(used_at=timezone.now())
        self.assertEqual(self.client.get(join_url(raw)).status_code, 410)
        self._gone_creator()
        self.assertEqual(self.client.get(join_url(raw)).status_code, 404)
        self.assertEqual(self.client.post(join_url(raw)).status_code, 404)

    def test_used_link_member_still_resolves_after_creator_gone(self):
        link, raw = GroupInviteLink.generate(self.group, self.creator, single_use=True)
        GroupMembership.objects.create(group=self.group, user=self.joiner)
        GroupInviteLink.objects.filter(pk=link.pk).update(used_at=timezone.now())
        self._gone_creator()
        self.assertEqual(self.client.get(join_url(raw)).status_code, 200)

    def test_all_gone_creator_states_share_one_body(self):
        _, fresh = GroupInviteLink.generate(self.group, self.creator)
        _, expired = GroupInviteLink.generate(
            self.group, self.creator, expires_at=timezone.now() - timedelta(days=1),
        )
        self._gone_creator()
        bodies = {str(self.client.get(join_url(t)).json()) for t in (fresh, expired)}
        self.assertEqual(len(bodies), 1)


class RevokeQueryCountTests(TestCase):
    _n = 0

    def _delete_count(self, with_links):
        RevokeQueryCountTests._n += 1
        n = self._n
        boss = User.objects.create_user(username=f"b{n}", password="pw")
        victim = User.objects.create_user(username=f"v{n}", password="pw")
        g = Group.objects.create(name="g", owner=boss)
        GroupMembership.objects.create(group=g, user=boss, role="admin")
        GroupMembership.objects.create(group=g, user=victim, role="member")
        if with_links:
            GroupInviteLink.generate(g, victim)
        c = APIClient()
        c.force_authenticate(boss)
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        with CaptureQueriesContext(connection) as ctx:
            r = c.delete(f"/api/v1/groups/{g.pk}/members/{victim.pk}/")
        self.assertEqual(r.status_code, 204)
        return len(ctx)

    def test_member_delete_without_links_skips_subtree_walk(self):
        self._delete_count(False)  # warm one-time caches
        none = self._delete_count(False)
        # Constant: the no-links path adds one links query and no subtree BFS.
        self.assertEqual(none, self._delete_count(False))
        self.assertLessEqual(none, 16)


class JoinPostQueryCountTests(TestCase):
    _n = 0

    def _nested(self, depth):
        JoinPostQueryCountTests._n += 1
        n = self._n
        creator = User.objects.create_user(username=f"jc{n}", password="pw")
        joiner = User.objects.create_user(username=f"jj{n}", password="pw")
        root = Group.objects.create(name="root", owner=creator)
        GroupMembership.objects.create(group=root, user=creator, role="admin")
        node = root
        for i in range(depth):
            node = Group.objects.create(name=f"n{i}", owner=creator, parent=node)
        _, raw = GroupInviteLink.generate(node, creator)
        return joiner, raw

    def _count(self, depth):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        joiner, raw = self._nested(depth)
        c = APIClient()
        c.force_authenticate(joiner)
        with CaptureQueriesContext(connection) as ctx:
            r = c.post(join_url(raw))
        self.assertEqual(r.status_code, 201)
        return len(ctx)

    def test_join_post_query_count_independent_of_depth(self):
        self._count(1)  # warm one-time caches
        self.assertEqual(self._count(1), self._count(5))


class PreviewQueryCountTests(TestCase):
    _n = 0

    def _nested(self, depth):
        PreviewQueryCountTests._n += 1
        creator = User.objects.create_user(username=f"c{self._n}", password="pw")
        root = Group.objects.create(name="root", owner=creator)
        GroupMembership.objects.create(
            group=root, user=creator, role=GroupMembership.Role.ADMIN,
        )
        node = root
        for i in range(depth):
            node = Group.objects.create(name=f"n{i}", owner=creator, parent=node)
        _, raw = GroupInviteLink.generate(node, creator)
        return raw

    def _count(self, raw):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        with CaptureQueriesContext(connection) as ctx:
            resp = APIClient().get(join_url(raw))
        self.assertEqual(resp.status_code, 200)
        return len(ctx)

    def test_anonymous_preview_query_count_independent_of_depth(self):
        self._count(self._nested(1))  # warm one-time caches (throttle, etc.)
        shallow = self._count(self._nested(1))
        deep = self._count(self._nested(5))
        self.assertEqual(shallow, deep)
        # link+group+ancestors in one JOINed lookup, plus one membership check.
        self.assertLessEqual(deep, 3)
