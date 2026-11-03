"""A public share link lasts while the admin who enabled it keeps admin standing (#1865).

``Board.share_enabled_by`` records the enabler. The link is cleared, and
``board.updated`` recorded, when that account is deactivated, deleted, or loses
the role that let it enable sharing on that board (board admin, owner, group
admin, or all-content access), on every route that removes it. Standing is
re-derived from current state, so an account that is still an admin another
way keeps the link. The public view re-checks standing on every read. A link
with no recorded enabler has no standing: the public view refuses and clears
it, and the access-change sweeps leave it to the view (#1939).
"""

from datetime import timedelta
from unittest.mock import patch

from django.core.management import call_command
from django.test import Client, TestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.admin import BoardAdminForm
from boards.models import Board, BoardEvent, BoardMembership
from boards.services.share_links import revoke_lapsed_share_links, share_enabler_has_standing
from groups.models import Group, GroupMembership

PW = "pw123456!x"

_PLAIN_STATIC = override_settings(
    STORAGES={
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
        "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
    }
)


def _client(user):
    c = APIClient()
    c.force_authenticate(user)
    return c


class _ShareFixtures(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner1865", password=PW)
        self.enabler = User.objects.create_user(username="enabler1865", password=PW)
        self.site_admin = User.objects.create_user(username="siteadm1865", password=PW)
        User.objects.filter(pk=self.site_admin.pk).update(is_site_admin=True)
        self.site_admin.refresh_from_db()
        self.board = Board.objects.create(name="B1865", owner=self.owner)
        BoardMembership.objects.create(board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN)
        self.membership = BoardMembership.objects.create(
            board=self.board, user=self.enabler, role=BoardMembership.Role.ADMIN,
        )
        self.anon = APIClient()

    def enable(self, user=None, board=None, body=None):
        board = board or self.board
        r = _client(user or self.enabler).post(
            f"/api/v1/boards/{board.pk}/share/", body or {}, format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        board.refresh_from_db()
        return str(board.share_token)

    def public(self, token):
        return self.anon.get(f"/api/share/{token}/")

    def assert_cleared(self, board=None):
        board = board or self.board
        board.refresh_from_db()
        self.assertIsNone(board.share_token)
        # The hash the link resolves by is cleared with it on every route (#1880).
        self.assertIsNone(board.share_token_hash)
        self.assertIsNone(board.share_token_expires_at)
        self.assertIsNone(board.share_enabled_by_id)

    def assert_kept(self, token, board=None):
        board = board or self.board
        board.refresh_from_db()
        self.assertEqual(str(board.share_token), token)
        self.assertEqual(self.public(token).status_code, status.HTTP_200_OK)

    def updated_events(self, board=None):
        return BoardEvent.objects.filter(
            board_id=(board or self.board).pk, event="board.updated",
        ).count()


class EnablerRecordedTests(_ShareFixtures):
    def test_post_records_the_enabler(self):
        self.enable()
        self.assertEqual(self.board.share_enabled_by_id, self.enabler.pk)

    def test_regenerating_records_the_new_enabler(self):
        self.enable()
        self.enable(user=self.owner)
        self.assertEqual(self.board.share_enabled_by_id, self.owner.pk)

    def test_delete_clears_the_enabler(self):
        self.enable()
        r = _client(self.enabler).delete(f"/api/v1/boards/{self.board.pk}/share/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assert_cleared()

    def test_post_rechecks_standing_under_the_board_lock(self):
        """A demotion that held the board lock first is seen by the share POST."""
        from boards.views import boards as board_views

        real_lock = board_views.lock_board_row_or_404

        def demote_then_lock(board, **kwargs):
            BoardMembership.objects.filter(pk=self.membership.pk).update(
                role=BoardMembership.Role.MEMBER,
            )
            return real_lock(board, **kwargs)

        with patch.object(board_views, "lock_board_row_or_404", side_effect=demote_then_lock):
            r = _client(self.enabler).post(f"/api/v1/boards/{self.board.pk}/share/", {}, format="json")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.board.refresh_from_db()
        self.assertIsNone(self.board.share_token)
        self.assertIsNone(self.board.share_enabled_by_id)


    def test_post_rereads_the_account_under_the_board_lock(self):
        """A deactivation committed while the POST waited is seen, not the sign-in copy."""
        from boards.views import boards as board_views

        real_lock = board_views.lock_board_row_or_404

        def deactivate_then_lock(board, **kwargs):
            User.objects.filter(pk=self.enabler.pk).update(is_active=False)
            return real_lock(board, **kwargs)

        with patch.object(board_views, "lock_board_row_or_404", side_effect=deactivate_then_lock):
            r = _client(self.enabler).post(f"/api/v1/boards/{self.board.pk}/share/", {}, format="json")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.board.refresh_from_db()
        self.assertIsNone(self.board.share_token)


class EnablerAbsentFromPayloadsTests(_ShareFixtures):
    def test_not_in_public_payload(self):
        token = self.enable()
        r = self.public(token)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertNotIn("share_enabled_by", r.json())
        self.assertNotIn(self.enabler.username, r.content.decode())

    def test_not_in_admin_or_member_board_payloads(self):
        self.enable()
        member = User.objects.create_user(username="member1865", password=PW)
        BoardMembership.objects.create(board=self.board, user=member, role=BoardMembership.Role.MEMBER)
        for user in (self.enabler, member):
            for path in ("", "full/"):
                r = _client(user).get(f"/api/v1/boards/{self.board.pk}/{path}")
                self.assertEqual(r.status_code, status.HTTP_200_OK)
                self.assertNotIn("share_enabled_by", r.json())

    def test_not_in_the_recorded_event_payload(self):
        self.enable()
        event = BoardEvent.objects.filter(board_id=self.board.pk, event="board.updated").latest("id")
        self.assertNotIn("share_enabled_by", event.data)


@patch("boards.broadcast.broadcast_board_event")
class DeactivationTests(_ShareFixtures):
    def test_deactivate_endpoint_clears_and_broadcasts_on_commit(self, bc):
        token = self.enable()
        bc.reset_mock()
        before = self.updated_events()
        with self.captureOnCommitCallbacks(execute=True) as callbacks:
            r = _client(self.site_admin).post(
                f"/api/v1/admin/users/{self.enabler.pk}/deactivate/", {}, format="json",
            )
            self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
            bc.assert_not_called()
        self.assertTrue(callbacks)
        self.assert_cleared()
        self.assertEqual(self.updated_events(), before + 1)
        self.assertIn(
            (self.board.pk, "board.updated"),
            [(c.args[0], c.args[1]) for c in bc.call_args_list],
        )
        self.assertEqual(self.public(token).status_code, status.HTTP_404_NOT_FOUND)

    def test_patch_is_active_false_clears(self, bc):
        self.enable()
        r = _client(self.site_admin).patch(
            f"/api/v1/admin/users/{self.enabler.pk}/", {"is_active": False}, format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assert_cleared()

    def test_owner_deactivated_with_transfer_clears(self, bc):
        """An owner (admin by ownership alone) who hands the board over and is deactivated."""
        heir = User.objects.create_user(username="heir1865", password=PW)
        BoardMembership.objects.filter(board=self.board, user=self.owner).delete()
        BoardMembership.objects.create(board=self.board, user=heir, role=BoardMembership.Role.MEMBER)
        self.enable(user=self.owner)
        r = _client(self.site_admin).post(
            f"/api/v1/admin/users/{self.owner.pk}/deactivate/",
            {"transfers": [{"board_id": self.board.pk, "transfer_to": heir.pk}]},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assert_cleared()

    def test_unrecorded_link_and_other_enablers_are_untouched_by_the_sweep(self, bc):
        other_admin = User.objects.create_user(username="other1865", password=PW)
        other = Board.objects.create(name="Other1865", owner=self.owner)
        BoardMembership.objects.create(board=other, user=other_admin, role=BoardMembership.Role.ADMIN)
        BoardMembership.objects.create(board=other, user=self.enabler, role=BoardMembership.Role.ADMIN)
        other_token = self.enable(user=other_admin, board=other)
        legacy = Board.objects.create(name="Legacy1865", owner=self.owner)
        BoardMembership.objects.create(board=legacy, user=self.enabler, role=BoardMembership.Role.ADMIN)
        legacy_token = self.enable(board=legacy)
        Board.objects.filter(pk=legacy.pk).update(share_enabled_by=None)
        self.enable()

        r = _client(self.site_admin).post(
            f"/api/v1/admin/users/{self.enabler.pk}/deactivate/", {}, format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assert_cleared()
        self.assert_kept(other_token, board=other)
        # The sweep is scoped to this enabler, so it does not touch a link with
        # no recorded enabler; the public view refuses that one on its own
        # (#1939, PublicViewStandingTests).
        legacy.refresh_from_db()
        self.assertEqual(str(legacy.share_token), legacy_token)
        self.assertIsNone(legacy.share_enabled_by_id)


@patch("boards.broadcast.broadcast_board_event")
class SiteAccessLossTests(_ShareFixtures):
    def setUp(self):
        super().setUp()
        self.all_content = User.objects.create_user(username="allc1865", password=PW)
        User.objects.filter(pk=self.all_content.pk).update(is_site_admin=True, can_access_all_content=True)
        self.all_content.refresh_from_db()

    def test_patch_clearing_all_content_access_clears(self, bc):
        token = self.enable(user=self.all_content)
        r = _client(self.site_admin).patch(
            f"/api/v1/admin/users/{self.all_content.pk}/",
            {"can_access_all_content": False}, format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assert_cleared()
        self.assertEqual(self.public(token).status_code, status.HTTP_404_NOT_FOUND)

    def test_set_site_admin_revoke_clears(self, bc):
        self.enable(user=self.all_content)
        call_command("set_site_admin", self.all_content.username, "--revoke", stdout=open("/dev/null", "w"))
        self.assert_cleared()

    def test_superuser_status_removed_clears(self, bc):
        root = User.objects.create_superuser(username="root1865", email="root1865@example.com", password=PW)
        self.enable(user=root)
        root.is_superuser = False
        root.save()
        self.assert_cleared()

    def test_kept_when_still_board_admin_by_membership(self, bc):
        BoardMembership.objects.create(board=self.board, user=self.all_content, role=BoardMembership.Role.ADMIN)
        token = self.enable(user=self.all_content)
        r = _client(self.site_admin).patch(
            f"/api/v1/admin/users/{self.all_content.pk}/",
            {"can_access_all_content": False, "is_site_admin": False}, format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assert_kept(token)


@patch("boards.broadcast.broadcast_board_event")
class BoardRoleChangeTests(_ShareFixtures):
    def test_demotion_clears(self, bc):
        token = self.enable()
        before = self.updated_events()
        r = _client(self.owner).post(
            f"/api/v1/boards/{self.board.pk}/members/",
            {"user_id": self.enabler.pk, "role": "member"}, format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assert_cleared()
        self.assertEqual(self.updated_events(), before + 1)
        self.assertEqual(self.public(token).status_code, status.HTTP_404_NOT_FOUND)

    def test_removal_clears(self, bc):
        self.enable()
        r = _client(self.owner).delete(f"/api/v1/boards/{self.board.pk}/members/{self.enabler.pk}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT, r.content)
        self.assert_cleared()

    def test_owner_demoted_by_membership_keeps_link(self, bc):
        """The owner is an admin by ownership whatever the membership row says."""
        token = self.enable(user=self.owner)
        r = _client(self.enabler).post(
            f"/api/v1/boards/{self.board.pk}/members/",
            {"user_id": self.owner.pk, "role": "member"}, format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assert_kept(token)

    def test_demoting_another_admin_keeps_the_enablers_link(self, bc):
        token = self.enable()
        third = User.objects.create_user(username="third1865", password=PW)
        BoardMembership.objects.create(board=self.board, user=third, role=BoardMembership.Role.ADMIN)
        r = _client(self.owner).post(
            f"/api/v1/boards/{self.board.pk}/members/",
            {"user_id": third.pk, "role": "viewer"}, format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assert_kept(token)


@patch("boards.broadcast.broadcast_board_event")
class GroupRoleChangeTests(_ShareFixtures):
    def setUp(self):
        super().setUp()
        self.group = Group.objects.create(name="G1865", owner=self.owner)
        GroupMembership.objects.get_or_create(
            group=self.group, user=self.owner, defaults={"role": GroupMembership.Role.ADMIN},
        )
        self.group_admin = User.objects.create_user(username="gadmin1865", password=PW)
        GroupMembership.objects.create(group=self.group, user=self.group_admin, role=GroupMembership.Role.ADMIN)
        Board.objects.filter(pk=self.board.pk).update(group=self.group)
        self.url = f"/api/v1/groups/{self.group.pk}/members/{self.group_admin.pk}/"

    def test_group_demotion_clears(self, bc):
        self.enable(user=self.group_admin)
        r = _client(self.owner).patch(self.url, {"role": "member"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assert_cleared()

    def test_group_removal_clears(self, bc):
        self.enable(user=self.group_admin)
        r = _client(self.owner).delete(self.url)
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT, r.content)
        self.assert_cleared()

    def test_group_demotion_kept_when_board_admin_directly(self, bc):
        BoardMembership.objects.create(board=self.board, user=self.group_admin, role=BoardMembership.Role.ADMIN)
        token = self.enable(user=self.group_admin)
        r = _client(self.owner).patch(self.url, {"role": "member"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assert_kept(token)

    def _child_group_board(self):
        """Board in a child of self.group; the group admin's role comes from the parent."""
        child = Group.objects.create(name="C1865", owner=self.owner, parent=self.group)
        GroupMembership.objects.get_or_create(
            group=child, user=self.owner, defaults={"role": GroupMembership.Role.ADMIN},
        )
        Board.objects.filter(pk=self.board.pk).update(group=child)
        return child

    def test_reparenting_the_boards_group_clears(self, bc):
        child = self._child_group_board()
        other = Group.objects.create(name="H1865", owner=self.owner)
        GroupMembership.objects.get_or_create(
            group=other, user=self.owner, defaults={"role": GroupMembership.Role.ADMIN},
        )
        self.enable(user=self.group_admin)
        r = _client(self.owner).patch(f"/api/v1/groups/{child.pk}/", {"parent": other.pk}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assert_cleared()

    def test_deleting_the_group_clears(self, bc):
        child = self._child_group_board()
        self.enable(user=self.group_admin)
        r = _client(self.owner).delete(f"/api/v1/groups/{child.pk}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT, r.content)
        self.assert_cleared()

    def test_deleting_a_group_keeps_a_link_whose_enabler_is_still_admin(self, bc):
        child = self._child_group_board()
        token = self.enable(user=self.owner)
        r = _client(self.owner).delete(f"/api/v1/groups/{child.pk}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT, r.content)
        self.assert_kept(token)

    def test_patch_group_to_none_clears(self, bc):
        self.enable(user=self.group_admin)
        r = _client(self.owner).patch(f"/api/v1/boards/{self.board.pk}/", {"group": None}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assert_cleared()

    def test_put_into_another_group_clears(self, bc):
        other = Group.objects.create(name="P1865", owner=self.owner)
        GroupMembership.objects.get_or_create(
            group=other, user=self.owner, defaults={"role": GroupMembership.Role.ADMIN},
        )
        self.enable(user=self.group_admin)
        r = _client(self.owner).put(
            f"/api/v1/boards/{self.board.pk}/", {"name": "B1865", "group": other.pk}, format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assert_cleared()

    def test_patch_without_a_group_change_keeps_link(self, bc):
        token = self.enable(user=self.group_admin)
        r = _client(self.owner).patch(f"/api/v1/boards/{self.board.pk}/", {"name": "Renamed"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assert_kept(token)

    def test_adding_a_group_admin_as_a_direct_member_clears(self, bc):
        """A direct membership outranks the group role, so this lowers the role."""
        self.enable(user=self.group_admin)
        r = _client(self.owner).post(
            f"/api/v1/boards/{self.board.pk}/members/",
            {"user_id": self.group_admin.pk, "role": "member"}, format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.content)
        self.assert_cleared()

    def test_adding_a_group_admin_as_a_direct_admin_keeps_link(self, bc):
        token = self.enable(user=self.group_admin)
        r = _client(self.owner).post(
            f"/api/v1/boards/{self.board.pk}/members/",
            {"user_id": self.group_admin.pk, "role": "admin"}, format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.content)
        self.assert_kept(token)

    def _join_child_group_as_member(self):
        from groups.models import GroupInviteLink

        child = self._child_group_board()
        _, raw = GroupInviteLink.generate(child, self.owner, role=GroupMembership.Role.MEMBER)
        return _client(self.group_admin).post(f"/api/v1/groups/join/{raw}/")

    def test_joining_a_nearer_group_with_a_lower_role_clears(self, bc):
        """The nearest group role wins, so joining the board's own group lowers it."""
        self.enable(user=self.group_admin)
        r = self._join_child_group_as_member()
        self.assertIn(r.status_code, (status.HTTP_200_OK, status.HTTP_201_CREATED), r.content)
        self.assert_cleared()

    def test_invite_grant_at_registration_rechecks_links(self, bc):
        """The registration and confirmation grant shares the same sweep."""
        from groups.invite_registration import _grant_membership
        from groups.models import GroupInviteLink

        child = self._child_group_board()
        self.enable(user=self.group_admin)
        link, _ = GroupInviteLink.generate(child, self.owner, role=GroupMembership.Role.VIEWER)
        _grant_membership(link, self.group_admin)
        self.assert_cleared()

    def test_move_out_of_the_group_clears(self, bc):
        self.enable(user=self.group_admin)
        r = _client(self.owner).post(
            f"/api/v1/boards/{self.board.pk}/move-group/", {"group_id": None}, format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assert_cleared()


@patch("boards.broadcast.broadcast_board_event")
class PublicViewStandingTests(_ShareFixtures):
    def test_lapsed_enabler_answers_404_and_clears_the_board(self, bc):
        token = self.enable()
        # A change that no write path cleared (e.g. a group re-parent).
        BoardMembership.objects.filter(pk=self.membership.pk).update(role=BoardMembership.Role.MEMBER)
        before = self.updated_events()
        with self.captureOnCommitCallbacks(execute=True):
            r = self.public(token)
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)
        self.assert_cleared()
        self.assertEqual(self.updated_events(), before + 1)
        # Regaining admin does not bring the link back.
        BoardMembership.objects.filter(pk=self.membership.pk).update(role=BoardMembership.Role.ADMIN)
        self.assertEqual(self.public(token).status_code, status.HTTP_404_NOT_FOUND)

    def test_lapsed_check_precedes_expiry(self, bc):
        token = self.enable(body={"expires_in_days": 7})
        Board.objects.filter(pk=self.board.pk).update(share_token_expires_at=timezone.now() - timedelta(days=1))
        User.objects.filter(pk=self.enabler.pk).update(is_active=False)
        self.assertEqual(self.public(token).status_code, status.HTTP_404_NOT_FOUND)

    def test_expired_link_with_standing_still_answers_410(self, bc):
        token = self.enable(body={"expires_in_days": 7})
        Board.objects.filter(pk=self.board.pk).update(share_token_expires_at=timezone.now() - timedelta(days=1))
        self.assertEqual(self.public(token).status_code, status.HTTP_410_GONE)

    def _unrecorded_link(self, **extra):
        """A link as an earlier release left it: token and hash, no enabler (#1939)."""
        token = self.enable()
        Board.objects.filter(pk=self.board.pk).update(share_enabled_by=None, **extra)
        return token

    def test_link_without_recorded_enabler_answers_404_and_clears_the_board(self, bc):
        """Every board admin still has standing; the link still does not resolve."""
        token = self._unrecorded_link()
        before = self.updated_events()
        with self.captureOnCommitCallbacks(execute=True):
            r = self.public(token)
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)
        self.assert_cleared()
        self.assertEqual(self.updated_events(), before + 1)
        event = BoardEvent.objects.filter(board_id=self.board.pk, event="board.updated").latest("pk")
        for field in ("share_token", "share_token_expires_at", "share_token_hash", "share_enabled_by"):
            self.assertNotIn(field, event.data)
        self.assertEqual(self.public(token).status_code, status.HTTP_404_NOT_FOUND)

    def test_link_without_recorded_enabler_answers_like_a_lapsed_one(self, bc):
        """Same status and body as a link whose enabler lost standing."""
        token = self._unrecorded_link()
        unrecorded = self.public(token)
        lapsed_token = self.enable()
        User.objects.filter(pk=self.enabler.pk).update(is_active=False)
        lapsed = self.public(lapsed_token)
        self.assertEqual(unrecorded.status_code, lapsed.status_code)
        self.assertEqual(unrecorded.content, lapsed.content)

    def test_link_without_recorded_enabler_precedes_expiry(self, bc):
        token = self._unrecorded_link(share_token_expires_at=timezone.now() - timedelta(days=1))
        self.assertEqual(self.public(token).status_code, status.HTTP_404_NOT_FOUND)
        self.assert_cleared()

    def test_reenabling_records_the_enabler_and_the_new_link_resolves(self, bc):
        old = self._unrecorded_link()
        self.assertEqual(self.public(old).status_code, status.HTTP_404_NOT_FOUND)
        new = self.enable(user=self.owner)
        self.assertNotEqual(new, old)
        self.assertEqual(self.board.share_enabled_by_id, self.owner.pk)
        self.assertEqual(self.public(new).status_code, status.HTTP_200_OK)
        self.assertEqual(self.public(old).status_code, status.HTTP_404_NOT_FOUND)

    def test_reenabling_over_an_uncleared_link_records_the_enabler(self, bc):
        """POST on a board whose unrecorded link was never read replaces it (no off/on needed)."""
        old = self._unrecorded_link()
        new = self.enable()
        self.assertNotEqual(new, old)
        self.assertEqual(self.board.share_enabled_by_id, self.enabler.pk)
        self.assertEqual(self.public(new).status_code, status.HTTP_200_OK)
        self.assertEqual(self.public(old).status_code, status.HTTP_404_NOT_FOUND)

    def test_recorded_enabler_with_standing_is_served(self, bc):
        token = self.enable()
        self.assertEqual(self.public(token).status_code, status.HTTP_200_OK)
        self.assert_kept(token)


@patch("boards.broadcast.broadcast_board_event")
class UserDeleteTests(_ShareFixtures):
    def test_deleting_the_enabler_clears_instead_of_leaving_a_legacy_link(self, bc):
        token = self.enable()
        self.enabler.delete()
        self.assert_cleared()
        self.assertEqual(self.public(token).status_code, status.HTTP_404_NOT_FOUND)

    def test_deleting_an_owner_enabler_deletes_their_board_cleanly(self, bc):
        self.enable(user=self.owner)
        board_pk = self.board.pk
        BoardMembership.objects.filter(board=self.board).exclude(user=self.owner).delete()
        self.owner.delete()
        self.assertFalse(Board.objects.filter(pk=board_pk).exists())


class HelperTests(_ShareFixtures):
    def test_requires_a_scope(self):
        with self.assertRaises(ValueError):
            revoke_lapsed_share_links()

    def test_empty_board_ids_is_a_no_op(self):
        self.enable()
        self.assertEqual(revoke_lapsed_share_links(board_ids=[None]), [])

    def test_returns_only_lapsed_boards(self):
        self.enable()
        self.assertEqual(revoke_lapsed_share_links(enabler=self.enabler), [])
        User.objects.filter(pk=self.enabler.pk).update(is_active=False)
        self.assertEqual(revoke_lapsed_share_links(enabler=self.enabler.pk), [self.board.pk])

    def _judged_then_changed(self, **change):
        """A board judged lapsed, then changed before the clear runs."""
        from boards.services.share_links import _clear_lapsed

        self.enable()
        User.objects.filter(pk=self.enabler.pk).update(is_active=False)
        judged = Board.objects.get(pk=self.board.pk)
        Board.objects.filter(pk=self.board.pk).update(**change)
        return _clear_lapsed([judged])

    def test_clear_skips_a_link_now_held_by_another_enabler(self):
        """Same token, different enabler: the enabler match keeps the link."""
        revoked = self._judged_then_changed(share_enabled_by=self.owner)
        self.assertEqual(revoked, [])
        self.board.refresh_from_db()
        self.assertIsNotNone(self.board.share_token)
        self.assertEqual(self.board.share_enabled_by_id, self.owner.pk)

    def test_clear_skips_a_link_with_a_new_token(self):
        """Same enabler, new token: the token match keeps the link."""
        import uuid

        new_token = uuid.uuid4()
        revoked = self._judged_then_changed(share_token=new_token)
        self.assertEqual(revoked, [])
        self.board.refresh_from_db()
        self.assertEqual(self.board.share_token, new_token)

    def test_reenabled_link_survives_a_sweep(self):
        self.enable()
        User.objects.filter(pk=self.enabler.pk).update(is_active=False)
        new_token = self.enable(user=self.owner)
        self.assertEqual(revoke_lapsed_share_links(board_ids=[self.board.pk]), [])
        self.assert_kept(new_token)

    def test_standing_none_user(self):
        self.assertFalse(share_enabler_has_standing(None, self.board))

    def test_unrecorded_links_are_cleared_only_when_included(self):
        """``include_unrecorded`` opts a board-scoped sweep into clearing them (#1939)."""
        self.enable()
        Board.objects.filter(pk=self.board.pk).update(share_enabled_by=None)
        self.assertEqual(revoke_lapsed_share_links(board_ids=[self.board.pk]), [])
        self.assertEqual(revoke_lapsed_share_links(enabler=self.enabler, include_unrecorded=True), [])
        self.board.refresh_from_db()
        self.assertIsNotNone(self.board.share_token)
        self.assertEqual(
            revoke_lapsed_share_links(board_ids=[self.board.pk], include_unrecorded=True),
            [self.board.pk],
        )
        self.assert_cleared()

    def test_clear_skips_an_unrecorded_link_that_gained_an_enabler(self):
        """Judged with no enabler, then re-enabled on the same row: the IS NULL match keeps it."""
        from boards.services.share_links import _clear_lapsed

        self.enable()
        Board.objects.filter(pk=self.board.pk).update(share_enabled_by=None)
        judged = Board.objects.get(pk=self.board.pk)
        Board.objects.filter(pk=self.board.pk).update(share_enabled_by=self.owner)
        self.assertEqual(_clear_lapsed([judged]), [])
        self.board.refresh_from_db()
        self.assertEqual(self.board.share_enabled_by_id, self.owner.pk)
        self.assertIsNotNone(self.board.share_token)


@_PLAIN_STATIC
@patch("boards.broadcast.broadcast_board_event")
class DjangoAdminTests(_ShareFixtures):
    def setUp(self):
        super().setUp()
        self.root = User.objects.create_superuser(username="root_adm1865", email="ra1865@example.com", password=PW)
        self.web = Client()
        self.web.force_login(self.root)
        Board.objects.filter(pk=self.board.pk).update(allowed_priorities=["low"])

    def _form_data(self, url, **overrides):
        from boards.tests.test_admin_board_concurrent_edits import page_data

        response = self.web.get(url)
        self.assertEqual(response.status_code, 200)
        return page_data(response, **overrides)

    def test_membership_demotion_in_admin_clears(self, bc):
        self.enable()
        url = reverse("admin:boards_boardmembership_change", args=[self.membership.pk])
        r = self.web.post(url, self._form_data(url, role="member"))
        self.assertEqual(r.status_code, 302)
        self.assert_cleared()

    def test_membership_delete_in_admin_clears(self, bc):
        self.enable()
        url = reverse("admin:boards_boardmembership_delete", args=[self.membership.pk])
        r = self.web.post(url, {"post": "yes"})
        self.assertEqual(r.status_code, 302)
        self.assert_cleared()

    def test_membership_bulk_delete_in_admin_clears(self, bc):
        self.enable()
        url = reverse("admin:boards_boardmembership_changelist")
        r = self.web.post(url, {
            "action": "delete_selected", "_selected_action": [self.membership.pk], "post": "yes",
        })
        self.assertEqual(r.status_code, 302)
        self.assert_cleared()

    def test_membership_add_in_admin_clears(self, bc):
        """Adding a direct lower membership for a group admin lowers their role."""
        group = Group.objects.create(name="GA1865", owner=self.owner)
        group_admin = User.objects.create_user(username="ga_adm1865", password=PW)
        GroupMembership.objects.create(group=group, user=group_admin, role=GroupMembership.Role.ADMIN)
        Board.objects.filter(pk=self.board.pk).update(group=group)
        self.enable(user=group_admin)
        url = reverse("admin:boards_boardmembership_add")
        r = self.web.post(url, self._form_data(
            url, board=str(self.board.pk), user=str(group_admin.pk), role="member",
        ))
        self.assertEqual(r.status_code, 302, getattr(r, "context", None) and r.context["adminform"].form.errors)
        self.assertTrue(BoardMembership.objects.filter(board=self.board, user=group_admin).exists())
        self.assert_cleared()

    def test_board_owner_change_in_admin_clears(self, bc):
        heir = User.objects.create_user(username="heir_adm1865", password=PW)
        BoardMembership.objects.filter(board=self.board, user=self.owner).delete()
        self.enable(user=self.owner)
        url = reverse("admin:boards_board_change", args=[self.board.pk])
        r = self.web.post(url, self._form_data(url, owner=str(heir.pk)))
        self.assertEqual(r.status_code, 302)
        self.assert_cleared()

    def test_board_admin_save_does_not_restore_a_cleared_link(self, bc):
        """A link cleared after the admin loaded the board stays cleared."""
        from boards.tests.test_admin_board_concurrent_edits import patched_clean

        self.enable()
        url = reverse("admin:boards_board_change", args=[self.board.pk])
        data = self._form_data(url, row_version=False, name="Renamed1865")

        def clear():
            User.objects.filter(pk=self.enabler.pk).update(is_active=False)
            revoke_lapsed_share_links(enabler=self.enabler)

        with patched_clean(BoardAdminForm, clear):
            r = self.web.post(url, data)
        self.assertEqual(r.status_code, 302)
        self.board.refresh_from_db()
        self.assertEqual(self.board.name, "Renamed1865")
        self.assert_cleared()
