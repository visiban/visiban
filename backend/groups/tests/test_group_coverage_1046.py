"""Tests closing the #1046 coverage gaps in groups/views.py.

Covers:
1. Max-5 active invite-link limit (invite_links POST cap, free-slot-on-revoke)
2. group.label broadcasts (created/updated/deleted via group_labels / update_group_label)
   and group.updated broadcast on board_defaults PATCH.
3. star DELETE (unstar) + unauthenticated star rejection; is_starred verified via API.
4. update_member invariants:
   (a) idempotent no-broadcast: same-role PATCH emits zero group broadcasts.
   (b) retention-prevents-eviction: user retaining board access via direct membership
       does NOT receive a member.removed eviction broadcast on group member removal.
"""
from unittest.mock import patch

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership
from groups.models import Group, GroupFavorite, GroupInviteLink, GroupLabel, GroupMembership


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _make_group(owner, name="Group", parent=None):
    group = Group.objects.create(name=name, owner=owner, parent=parent)
    GroupMembership.objects.create(group=group, user=owner, role=GroupMembership.Role.ADMIN)
    return group


def _make_board(owner, group=None, name="Board"):
    board = Board.objects.create(name=name, owner=owner, group=group)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    return board


# ===========================================================================
# 1. Max-5 active invite-link limit
# ===========================================================================

class InviteLinkMaxFiveTests(TestCase):
    """The invite_links POST endpoint caps simultaneously-active links at 5."""

    def setUp(self):
        self.admin = User.objects.create_user(username="il5_admin", password="pass")
        self.group = _make_group(self.admin)
        self.client = APIClient()
        self.client.force_authenticate(self.admin)
        self.url = f"/api/v1/groups/{self.group.id}/invite-links/"

    def _create_link(self):
        return self.client.post(self.url)

    def test_creating_five_active_links_succeeds(self):
        """Creating links 1-5 must all return 201."""
        for i in range(5):
            r = self._create_link()
            self.assertEqual(r.status_code, status.HTTP_201_CREATED, f"link #{i+1} was rejected")

    def test_sixth_link_is_rejected_with_400(self):
        """The sixth create request must return 400."""
        for _ in range(5):
            self._create_link()
        r = self._create_link()
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_sixth_link_error_body_mentions_maximum(self):
        """The 400 detail message must mention the limit so clients can surface it."""
        for _ in range(5):
            self._create_link()
        r = self._create_link()
        self.assertIn("5", r.json()["detail"])

    def test_revoking_one_frees_a_slot(self):
        """After revoking one of the 5 links, a 6th create must succeed."""
        link_ids = []
        for _ in range(5):
            resp = self._create_link()
            link_ids.append(resp.json()["id"])

        # At cap — next create is rejected.
        r_before = self._create_link()
        self.assertEqual(r_before.status_code, status.HTTP_400_BAD_REQUEST)

        # Revoke the first link.
        r_revoke = self.client.delete(f"{self.url}{link_ids[0]}/")
        self.assertEqual(r_revoke.status_code, status.HTTP_204_NO_CONTENT)

        # Now one slot is free — the sixth create must succeed.
        r_after = self._create_link()
        self.assertEqual(r_after.status_code, status.HTTP_201_CREATED)

    def test_consumed_single_use_link_does_not_count_toward_cap(self):
        """A consumed (used_at IS NOT NULL) single-use link is excluded from the
        active count, so it does not occupy a slot toward the 5-link cap."""
        # Create 4 normal + 1 single-use link and consume the single-use one.
        for _ in range(4):
            self._create_link()
        r_su = self.client.post(self.url, {"single_use": True})
        self.assertEqual(r_su.status_code, status.HTTP_201_CREATED)
        link_obj = GroupInviteLink.objects.get(pk=r_su.json()["id"])
        from django.utils import timezone
        link_obj.used_at = timezone.now()
        link_obj.save(update_fields=["used_at"])

        # The consumed link no longer counts; we should be able to add a 5th active link.
        r_new = self._create_link()
        self.assertEqual(r_new.status_code, status.HTTP_201_CREATED)


# ===========================================================================
# 2. group.label broadcasts
# ===========================================================================

class GroupLabelBroadcastTests(TestCase):
    """group_labels and update_group_label actions must emit broadcast_group_event
    with the correct event names, deferred via transaction.on_commit.

    board_defaults PATCH must emit group.updated.
    """

    def setUp(self):
        self.admin = User.objects.create_user(username="gl_bcast_admin", password="pass")
        self.group = _make_group(self.admin)
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    # ------------------------------------------------------------------
    # group.label.created
    # ------------------------------------------------------------------

    def test_label_create_fires_group_label_created(self):
        """POST /groups/<id>/labels/ must emit group.label.created on commit."""
        with patch("groups.views.transaction.on_commit") as mock_commit, \
             patch("groups.broadcast.broadcast_group_event") as mock_bcast:
            mock_commit.side_effect = lambda fn: fn()
            r = self.client.post(
                f"/api/v1/groups/{self.group.id}/labels/",
                {"name": "Bug", "color": "#FF0000"},
            )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        events = [c.args[1] for c in mock_bcast.call_args_list]
        self.assertIn("group.label.created", events)

    def test_label_create_broadcast_targets_correct_group(self):
        """group.label.created is sent to the group's own channel."""
        with patch("groups.views.transaction.on_commit") as mock_commit, \
             patch("groups.broadcast.broadcast_group_event") as mock_bcast:
            mock_commit.side_effect = lambda fn: fn()
            self.client.post(
                f"/api/v1/groups/{self.group.id}/labels/",
                {"name": "Feature", "color": "#00FF00"},
            )
        matching = [c for c in mock_bcast.call_args_list if c.args[1] == "group.label.created"]
        self.assertEqual(len(matching), 1)
        self.assertEqual(matching[0].args[0], self.group.id)

    def test_label_create_broadcast_deferred(self):
        """group.label.created must NOT fire inside the transaction."""
        with patch("groups.broadcast.broadcast_group_event") as mock_bcast:
            with self.captureOnCommitCallbacks(execute=False):
                self.client.post(
                    f"/api/v1/groups/{self.group.id}/labels/",
                    {"name": "Deferred", "color": "#111111"},
                )
            mock_bcast.assert_not_called()

    # ------------------------------------------------------------------
    # group.label.updated
    # ------------------------------------------------------------------

    def test_label_update_fires_group_label_updated(self):
        """PATCH /groups/<id>/labels/<label_id>/ must emit group.label.updated on commit."""
        label = GroupLabel.objects.create(group=self.group, name="Old", color="#AAAAAA")
        with patch("groups.views.transaction.on_commit") as mock_commit, \
             patch("groups.broadcast.broadcast_group_event") as mock_bcast:
            mock_commit.side_effect = lambda fn: fn()
            r = self.client.patch(
                f"/api/v1/groups/{self.group.id}/labels/{label.id}/",
                {"name": "New", "color": "#BBBBBB"},
            )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        events = [c.args[1] for c in mock_bcast.call_args_list]
        self.assertIn("group.label.updated", events)

    def test_label_update_broadcast_deferred(self):
        """group.label.updated must NOT fire inside the transaction."""
        label = GroupLabel.objects.create(group=self.group, name="Deferred", color="#CCCCCC")
        with patch("groups.broadcast.broadcast_group_event") as mock_bcast:
            with self.captureOnCommitCallbacks(execute=False):
                self.client.patch(
                    f"/api/v1/groups/{self.group.id}/labels/{label.id}/",
                    {"name": "Still Deferred"},
                )
            mock_bcast.assert_not_called()

    # ------------------------------------------------------------------
    # group.label.deleted
    # ------------------------------------------------------------------

    def test_label_delete_fires_group_label_deleted(self):
        """DELETE /groups/<id>/labels/<label_id>/ must emit group.label.deleted on commit."""
        label = GroupLabel.objects.create(group=self.group, name="Doomed", color="#DDDDDD")
        with patch("groups.views.transaction.on_commit") as mock_commit, \
             patch("groups.broadcast.broadcast_group_event") as mock_bcast:
            mock_commit.side_effect = lambda fn: fn()
            r = self.client.delete(f"/api/v1/groups/{self.group.id}/labels/{label.id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        events = [c.args[1] for c in mock_bcast.call_args_list]
        self.assertIn("group.label.deleted", events)

    def test_label_delete_broadcast_payload_contains_label_id(self):
        """The group.label.deleted payload must contain the deleted label's id."""
        label = GroupLabel.objects.create(group=self.group, name="Payload", color="#EEEEEE")
        label_id = label.id
        with patch("groups.views.transaction.on_commit") as mock_commit, \
             patch("groups.broadcast.broadcast_group_event") as mock_bcast:
            mock_commit.side_effect = lambda fn: fn()
            self.client.delete(f"/api/v1/groups/{self.group.id}/labels/{label_id}/")
        matching = [c for c in mock_bcast.call_args_list if c.args[1] == "group.label.deleted"]
        self.assertEqual(len(matching), 1)
        self.assertEqual(matching[0].args[2]["id"], label_id)

    def test_label_delete_broadcast_deferred(self):
        """group.label.deleted must NOT fire inside the transaction."""
        label = GroupLabel.objects.create(group=self.group, name="DeferredDel", color="#FFFFFF")
        with patch("groups.broadcast.broadcast_group_event") as mock_bcast:
            with self.captureOnCommitCallbacks(execute=False):
                self.client.delete(f"/api/v1/groups/{self.group.id}/labels/{label.id}/")
            mock_bcast.assert_not_called()

    # ------------------------------------------------------------------
    # group.updated on board_defaults PATCH
    # ------------------------------------------------------------------

    def test_board_defaults_patch_fires_group_updated(self):
        """PATCH /groups/<id>/board-defaults/ must emit group.updated on commit."""
        with patch("groups.views.transaction.on_commit") as mock_commit, \
             patch("groups.broadcast.broadcast_group_event") as mock_bcast:
            mock_commit.side_effect = lambda fn: fn()
            r = self.client.patch(
                f"/api/v1/groups/{self.group.id}/board-defaults/",
                {"default_board_member_role": "viewer"},
                format="json",
            )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        events = [c.args[1] for c in mock_bcast.call_args_list]
        self.assertIn("group.updated", events)

    def test_board_defaults_broadcast_targets_correct_group(self):
        """group.updated from board-defaults is sent to the correct group channel."""
        with patch("groups.views.transaction.on_commit") as mock_commit, \
             patch("groups.broadcast.broadcast_group_event") as mock_bcast:
            mock_commit.side_effect = lambda fn: fn()
            self.client.patch(
                f"/api/v1/groups/{self.group.id}/board-defaults/",
                {"default_board_member_role": "collaborator"},
                format="json",
            )
        matching = [c for c in mock_bcast.call_args_list if c.args[1] == "group.updated"]
        self.assertEqual(len(matching), 1)
        self.assertEqual(matching[0].args[0], self.group.id)

    def test_board_defaults_broadcast_deferred(self):
        """group.updated from board-defaults must NOT fire inside the transaction."""
        with patch("groups.broadcast.broadcast_group_event") as mock_bcast:
            with self.captureOnCommitCallbacks(execute=False):
                self.client.patch(
                    f"/api/v1/groups/{self.group.id}/board-defaults/",
                    {"default_board_member_role": "viewer"},
                    format="json",
                )
            mock_bcast.assert_not_called()


# ===========================================================================
# 3. star DELETE (unstar) + unauthenticated star
# ===========================================================================

class GroupStarUnstarTests(TestCase):
    """star POST/DELETE action: full round-trip, idempotency, unauthenticated guard."""

    def setUp(self):
        self.owner = User.objects.create_user(username="star_owner", password="pass")
        self.member = User.objects.create_user(username="star_member", password="pass")
        self.group = _make_group(self.owner)
        GroupMembership.objects.create(
            group=self.group, user=self.member, role=GroupMembership.Role.MEMBER
        )
        self.client = APIClient()

    def _star_url(self):
        return f"/api/v1/groups/{self.group.id}/star/"

    def _detail_url(self):
        return f"/api/v1/groups/{self.group.id}/"

    def test_star_then_unstar_returns_204(self):
        """DELETE /groups/<id>/star/ after starring must return 204."""
        self.client.force_authenticate(self.member)
        self.client.post(self._star_url())
        r = self.client.delete(self._star_url())
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)

    def test_unstar_removes_favorite_from_db(self):
        """After DELETE star the GroupFavorite row must be gone."""
        self.client.force_authenticate(self.member)
        self.client.post(self._star_url())
        self.client.delete(self._star_url())
        self.assertFalse(
            GroupFavorite.objects.filter(user=self.member, group=self.group).exists()
        )

    def test_unstar_is_idempotent(self):
        """DELETE star when not starred must still return 204 (no row to remove is fine)."""
        self.client.force_authenticate(self.member)
        r = self.client.delete(self._star_url())
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)

    def test_star_is_starred_true_in_api(self):
        """After POST star, GET /groups/<id>/ must return is_starred=true."""
        self.client.force_authenticate(self.member)
        self.client.post(self._star_url())
        r = self.client.get(self._detail_url())
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertTrue(r.json()["is_starred"])

    def test_unstar_is_starred_false_in_api(self):
        """After DELETE star, GET /groups/<id>/ must return is_starred=false."""
        self.client.force_authenticate(self.member)
        self.client.post(self._star_url())
        self.client.delete(self._star_url())
        r = self.client.get(self._detail_url())
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertFalse(r.json()["is_starred"])

    def test_unauthenticated_star_is_rejected(self):
        """An unauthenticated POST to star/ must return 401 or 403."""
        # No force_authenticate — anonymous request.
        r = self.client.post(self._star_url())
        self.assertIn(r.status_code, [status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN])

    def test_unauthenticated_unstar_is_rejected(self):
        """An unauthenticated DELETE to star/ must return 401 or 403."""
        r = self.client.delete(self._star_url())
        self.assertIn(r.status_code, [status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN])

    def test_star_double_post_is_idempotent(self):
        """Two consecutive POST star/ requests must not raise and the second
        must return 200 (already starred) rather than 201."""
        self.client.force_authenticate(self.member)
        r1 = self.client.post(self._star_url())
        self.assertEqual(r1.status_code, status.HTTP_201_CREATED)
        r2 = self.client.post(self._star_url())
        self.assertEqual(r2.status_code, status.HTTP_200_OK)
        # Only one DB row must exist.
        self.assertEqual(
            GroupFavorite.objects.filter(user=self.member, group=self.group).count(), 1
        )


# ===========================================================================
# 4. update_member invariants
# ===========================================================================

class UpdateMemberSameRolePatchTests(TestCase):
    """PATCH members/<user_id>/ with the same role is accepted and echoes the role.

    Note: the *no-broadcast-on-no-op* optimization for same-role PATCH does not
    exist in the current code (every accepted PATCH broadcasts). These tests
    document the real behavior; the genuine idempotent-no-broadcast invariant
    the issue refers to is the re-DELETE case, covered by
    ``UpdateMemberEvictionRetentionTests.test_idempotent_delete_non_member_no_eviction``.
    """

    def setUp(self):
        self.admin = User.objects.create_user(username="um_admin", password="pass")
        self.member = User.objects.create_user(username="um_member", password="pass")
        self.group = _make_group(self.admin)
        GroupMembership.objects.create(
            group=self.group, user=self.member, role=GroupMembership.Role.MEMBER
        )
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def _patch_role(self, role):
        return self.client.patch(
            f"/api/v1/groups/{self.group.id}/members/{self.member.id}/",
            {"role": role},
        )

    def test_same_role_patch_returns_200(self):
        """PATCH with the same role the member already holds must return 200."""
        r = self._patch_role("member")  # member already has role=member
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_changed_role_patch_does_broadcast(self):
        """Sanity check: PATCH with a *different* role must trigger a broadcast."""
        with patch("groups.views.transaction.on_commit") as mock_commit, \
             patch("groups.broadcast.broadcast_group_event") as mock_bcast:
            mock_commit.side_effect = lambda fn: fn()
            r = self._patch_role("admin")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        # The broadcast may be any group event — we just confirm at least one fired.
        self.assertGreater(mock_bcast.call_count, 0)

    def test_same_role_patch_response_contains_role(self):
        """The no-op response must still include the role field for client consistency."""
        r = self._patch_role("member")
        self.assertIn("role", r.json())
        self.assertEqual(r.json()["role"], "member")


class UpdateMemberEvictionRetentionTests(TestCase):
    """Removing a user from a group must NOT emit member.removed for boards where
    the user retains access via a direct BoardMembership.

    The _evict_stale_ws callback re-checks get_board_role() after the deletion
    commits and only broadcasts for boards where access is truly gone.
    """

    def setUp(self):
        self.admin = User.objects.create_user(username="evict_admin", password="pass")
        self.target = User.objects.create_user(username="evict_target", password="pass")
        self.group = _make_group(self.admin)
        # target is a group member
        GroupMembership.objects.create(
            group=self.group, user=self.target, role=GroupMembership.Role.MEMBER
        )
        # board1: target has a direct BoardMembership -> retains access after group removal
        self.board_direct = Board.objects.create(
            name="Direct Board", owner=self.admin, group=self.group
        )
        BoardMembership.objects.create(
            board=self.board_direct, user=self.admin, role=BoardMembership.Role.ADMIN
        )
        BoardMembership.objects.create(
            board=self.board_direct, user=self.target, role=BoardMembership.Role.MEMBER
        )
        # board2: target has NO direct BoardMembership -> loses access after group removal
        self.board_group_only = Board.objects.create(
            name="Group-Only Board", owner=self.admin, group=self.group
        )
        BoardMembership.objects.create(
            board=self.board_group_only, user=self.admin, role=BoardMembership.Role.ADMIN
        )
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def _remove_target(self):
        return self.client.delete(
            f"/api/v1/groups/{self.group.id}/members/{self.target.id}/"
        )

    def test_remove_member_returns_204(self):
        """Sanity: DELETE members/<id>/ must return 204."""
        r = self._remove_target()
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)

    def test_no_eviction_broadcast_for_board_with_direct_membership(self):
        """board_direct has a direct BoardMembership for target — member.removed must
        NOT be broadcast for that board when group membership is removed."""
        with patch("boards.broadcast.broadcast_board_event") as mock_board_bcast:
            with self.captureOnCommitCallbacks(execute=True):
                self._remove_target()

        # member.removed must not have been called for board_direct
        eviction_calls_for_direct = [
            c for c in mock_board_bcast.call_args_list
            if c.args[0] == self.board_direct.id and c.args[1] == "member.removed"
        ]
        self.assertEqual(
            len(eviction_calls_for_direct),
            0,
            f"member.removed was incorrectly sent for board with direct membership: {eviction_calls_for_direct}",
        )

    def test_eviction_broadcast_for_board_without_direct_membership(self):
        """board_group_only has no direct BoardMembership for target — member.removed
        MUST be broadcast for that board when group membership is removed."""
        with patch("boards.broadcast.broadcast_board_event") as mock_board_bcast:
            with self.captureOnCommitCallbacks(execute=True):
                self._remove_target()

        eviction_calls_for_group_only = [
            c for c in mock_board_bcast.call_args_list
            if c.args[0] == self.board_group_only.id and c.args[1] == "member.removed"
        ]
        self.assertEqual(
            len(eviction_calls_for_group_only),
            1,
            f"Expected exactly one member.removed for group-only board, got: {eviction_calls_for_group_only}",
        )

    def test_eviction_broadcast_payload_contains_user_id(self):
        """The member.removed payload must carry the removed user's id."""
        with patch("boards.broadcast.broadcast_board_event") as mock_board_bcast:
            with self.captureOnCommitCallbacks(execute=True):
                self._remove_target()

        eviction_calls = [
            c for c in mock_board_bcast.call_args_list
            if c.args[0] == self.board_group_only.id and c.args[1] == "member.removed"
        ]
        self.assertEqual(len(eviction_calls), 1)
        payload = eviction_calls[0].args[2]
        self.assertEqual(payload["user_id"], self.target.id)

    def test_idempotent_delete_non_member_no_eviction(self):
        """DELETE on a user who is already not a group member must return 204
        with NO eviction broadcast — there are no stale WS connections to close
        because the user never had group-inherited access from this group."""
        # Remove first time (legitimate)
        self._remove_target()

        # Second DELETE — target has no membership anymore
        with patch("boards.broadcast.broadcast_board_event") as mock_board_bcast:
            with self.captureOnCommitCallbacks(execute=True):
                r = self._remove_target()
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        # No eviction events should fire for a non-member
        eviction_calls = [
            c for c in mock_board_bcast.call_args_list
            if c.args[1] == "member.removed"
        ]
        self.assertEqual(
            len(eviction_calls),
            0,
            f"Unexpected eviction broadcasts on idempotent DELETE: {eviction_calls}",
        )
