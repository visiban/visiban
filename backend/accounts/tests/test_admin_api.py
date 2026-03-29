"""Tests for #211/#212: site admin API endpoints."""
from datetime import timedelta

from django.test import TestCase
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import SiteSetting, User


def make_admin(**kwargs):
    kwargs.setdefault("username", "admin")
    kwargs.setdefault("password", "adminpass123!")
    u = User.objects.create_user(**kwargs)
    u.is_site_admin = True
    u.save(update_fields=["is_site_admin"])
    return u


def make_user(**kwargs):
    kwargs.setdefault("password", "userpass123!")
    return User.objects.create_user(**kwargs)


# ---------------------------------------------------------------------------
# IsSiteAdmin permission
# ---------------------------------------------------------------------------

class IsSiteAdminPermissionTests(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_unauthenticated_rejected(self):
        r = self.client.get("/api/admin/settings/")
        self.assertIn(r.status_code, [status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN])

    def test_regular_user_rejected(self):
        user = make_user(username="reg")
        self.client.force_authenticate(user)
        r = self.client.get("/api/admin/settings/")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_site_admin_allowed(self):
        admin = make_admin()
        self.client.force_authenticate(admin)
        r = self.client.get("/api/admin/settings/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)


# ---------------------------------------------------------------------------
# AdminSettingsView
# ---------------------------------------------------------------------------

class AdminSettingsViewTests(TestCase):
    def setUp(self):
        self.admin = make_admin()
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def test_get_returns_registration_mode(self):
        r = self.client.get("/api/admin/settings/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIn("registration_mode", r.json())
        self.assertEqual(r.json()["registration_mode"], "open")

    def test_patch_registration_mode(self):
        r = self.client.patch("/api/admin/settings/", {"registration_mode": "closed"})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json()["registration_mode"], "closed")
        self.assertEqual(SiteSetting.get().registration_mode, "closed")

    def test_patch_invite_only(self):
        r = self.client.patch("/api/admin/settings/", {"registration_mode": "invite_only"})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json()["registration_mode"], "invite_only")

    def test_patch_invalid_mode_rejected(self):
        r = self.client.patch("/api/admin/settings/", {"registration_mode": "bananas"})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_non_admin_cannot_patch(self):
        reg = make_user(username="reg2")
        self.client.force_authenticate(reg)
        r = self.client.patch("/api/admin/settings/", {"registration_mode": "closed"})
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_get_returns_uploads_enabled(self):
        r = self.client.get("/api/admin/settings/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIn("uploads_enabled", r.json())
        self.assertTrue(r.json()["uploads_enabled"])

    def test_patch_uploads_enabled_false(self):
        r = self.client.patch("/api/admin/settings/", {"uploads_enabled": False})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertFalse(r.json()["uploads_enabled"])
        self.assertFalse(SiteSetting.get().uploads_enabled)

    def test_patch_uploads_enabled_true(self):
        s = SiteSetting.get()
        s.uploads_enabled = False
        s.save(update_fields=["uploads_enabled"])
        r = self.client.patch("/api/admin/settings/", {"uploads_enabled": True})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertTrue(r.json()["uploads_enabled"])
        self.assertTrue(SiteSetting.get().uploads_enabled)


# ---------------------------------------------------------------------------
# AdminUsersView — GET
# ---------------------------------------------------------------------------

class AdminUsersListTests(TestCase):
    def setUp(self):
        self.admin = make_admin()
        self.client = APIClient()
        self.client.force_authenticate(self.admin)
        make_user(username="alice", email="alice@example.com")
        make_user(username="bob", email="bob@example.com")

    def test_lists_all_users(self):
        r = self.client.get("/api/admin/users/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        usernames = [u["username"] for u in r.json()["results"]]
        self.assertIn("alice", usernames)
        self.assertIn("bob", usernames)

    def test_search_by_username(self):
        r = self.client.get("/api/admin/users/?search=alice")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        results = r.json()["results"]
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["username"], "alice")

    def test_search_by_email(self):
        r = self.client.get("/api/admin/users/?search=bob@example")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        results = r.json()["results"]
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["username"], "bob")

    def test_non_admin_rejected(self):
        reg = make_user(username="reg3")
        self.client.force_authenticate(reg)
        r = self.client.get("/api/admin/users/")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)


# ---------------------------------------------------------------------------
# AdminUsersView — POST (create user)
# ---------------------------------------------------------------------------

class AdminCreateUserTests(TestCase):
    def setUp(self):
        self.admin = make_admin()
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def test_create_user_with_force_password_reset(self):
        r = self.client.post("/api/admin/users/", {
            "username": "newuser",
            "email": "new@example.com",
            "password": "SecurePass123!",
            "force_password_reset": True,
        })
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        u = User.objects.get(username="newuser")
        self.assertTrue(u.must_change_password)

    def test_create_user_without_force_reset(self):
        r = self.client.post("/api/admin/users/", {
            "username": "newuser2",
            "email": "new2@example.com",
            "password": "SecurePass123!",
            "force_password_reset": False,
        })
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        u = User.objects.get(username="newuser2")
        self.assertFalse(u.must_change_password)

    def test_create_user_defaults_to_force_reset(self):
        r = self.client.post("/api/admin/users/", {
            "username": "newuser3",
            "email": "new3@example.com",
            "password": "SecurePass123!",
        })
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        u = User.objects.get(username="newuser3")
        self.assertTrue(u.must_change_password)

    def test_duplicate_username_rejected(self):
        make_user(username="existing")
        r = self.client.post("/api/admin/users/", {
            "username": "existing",
            "email": "other@example.com",
            "password": "SecurePass123!",
        })
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_short_password_rejected(self):
        r = self.client.post("/api/admin/users/", {
            "username": "shortpass",
            "email": "short@example.com",
            "password": "abc",
        })
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_non_admin_rejected(self):
        reg = make_user(username="reg4")
        self.client.force_authenticate(reg)
        r = self.client.post("/api/admin/users/", {
            "username": "shouldfail",
            "email": "fail@example.com",
            "password": "SecurePass123!",
        })
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)


# ---------------------------------------------------------------------------
# AdminUserDetailView — PATCH
# ---------------------------------------------------------------------------

class AdminPatchUserTests(TestCase):
    def setUp(self):
        self.admin = make_admin()
        self.target = make_user(username="target")
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def test_deactivate_user(self):
        r = self.client.patch(f"/api/admin/users/{self.target.pk}/", {"is_active": False})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.target.refresh_from_db()
        self.assertFalse(self.target.is_active)

    def test_reactivate_user(self):
        self.target.is_active = False
        self.target.save(update_fields=["is_active"])
        r = self.client.patch(f"/api/admin/users/{self.target.pk}/", {"is_active": True})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.target.refresh_from_db()
        self.assertTrue(self.target.is_active)

    def test_deactivating_self_rejected(self):
        r = self.client.patch(f"/api/admin/users/{self.admin.pk}/", {"is_active": False})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("cannot deactivate", r.json()["detail"].lower())

    def test_promote_to_site_admin(self):
        r = self.client.patch(f"/api/admin/users/{self.target.pk}/", {"is_site_admin": True})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.target.refresh_from_db()
        self.assertTrue(self.target.is_site_admin)

    def test_demote_last_site_admin_rejected(self):
        # Only one admin in the system; trying to demote them is rejected.
        r = self.client.patch(f"/api/admin/users/{self.admin.pk}/", {"is_site_admin": False})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_demote_when_another_admin_exists(self):
        # A second admin exists, so demoting this one is allowed.
        other_admin = make_user(username="otheradmin2")
        other_admin.is_site_admin = True
        other_admin.save(update_fields=["is_site_admin"])
        # Demote the target (not self) — target was promoted in a previous test
        # but this is isolated — target has is_site_admin=False by default.
        # Instead, demote the other_admin.
        r = self.client.patch(f"/api/admin/users/{other_admin.pk}/", {"is_site_admin": False})
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_force_password_reset(self):
        r = self.client.patch(f"/api/admin/users/{self.target.pk}/", {"must_change_password": True})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.target.refresh_from_db()
        self.assertTrue(self.target.must_change_password)

    def test_admin_reset_tour_flag(self):
        """Admin can reset a user's onboarding tour flag."""
        self.target.has_completed_tour = True
        self.target.save(update_fields=["has_completed_tour"])
        r = self.client.patch(f"/api/admin/users/{self.target.pk}/", {"has_completed_tour": False})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.target.refresh_from_db()
        self.assertFalse(self.target.has_completed_tour)

    def test_non_admin_rejected(self):
        reg = make_user(username="reg5")
        self.client.force_authenticate(reg)
        r = self.client.patch(f"/api/admin/users/{self.target.pk}/", {"is_active": False})
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_user_not_found_returns_404(self):
        r = self.client.patch("/api/admin/users/99999/", {"is_active": False})
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)


# ---------------------------------------------------------------------------
# SiteSetting singleton enforcement
# ---------------------------------------------------------------------------

class SiteSettingSingletonTests(TestCase):
    def test_get_creates_singleton(self):
        self.assertEqual(SiteSetting.objects.count(), 0)
        s = SiteSetting.get()
        self.assertEqual(SiteSetting.objects.count(), 1)
        self.assertEqual(s.registration_mode, "open")

    def test_save_enforces_singleton(self):
        SiteSetting.get()
        duplicate = SiteSetting(registration_mode="closed")
        duplicate.save()
        self.assertEqual(SiteSetting.objects.count(), 1)
        self.assertEqual(SiteSetting.objects.get(pk=1).registration_mode, "closed")


# ---------------------------------------------------------------------------
# Adapter: registration_mode enforcement
# ---------------------------------------------------------------------------

class RegistrationAdapterModeTests(TestCase):
    def setUp(self):
        from django.test import RequestFactory
        from accounts.adapter import RegistrationAdapter, invalidate_registration_mode_cache
        # Clear any cache left by a prior test so mode defaults to 'open'.
        invalidate_registration_mode_cache()
        self.adapter = RegistrationAdapter()
        self.request = RequestFactory().get("/")

    def test_open_allows_signup(self):
        self.assertTrue(self.adapter.is_open_for_signup(self.request))

    def test_closed_blocks_signup(self):
        s = SiteSetting.get()
        s.registration_mode = "closed"
        s.save()
        self.assertFalse(self.adapter.is_open_for_signup(self.request))

    def test_invite_only_blocks_oauth_signup(self):
        # invite_only blocks the allauth/OAuth flow; token validation happens
        # at the REST endpoint level (not tested here).
        s = SiteSetting.get()
        s.registration_mode = "invite_only"
        s.save()
        self.assertFalse(self.adapter.is_open_for_signup(self.request))

    def test_reopened_after_closed(self):
        s = SiteSetting.get()
        s.registration_mode = "closed"
        s.save()
        self.assertFalse(self.adapter.is_open_for_signup(self.request))
        s.registration_mode = "open"
        s.save()
        self.assertTrue(self.adapter.is_open_for_signup(self.request))


# ---------------------------------------------------------------------------
# First-user bootstrap: superuser → is_site_admin
# ---------------------------------------------------------------------------

class SuperuserSiteAdminBootstrapTests(TestCase):
    def test_creating_superuser_sets_is_site_admin(self):
        u = User.objects.create_superuser(username="su", password="superpass123!")
        u.refresh_from_db()
        self.assertTrue(u.is_site_admin)

    def test_regular_user_does_not_get_site_admin(self):
        u = User.objects.create_user(username="normal", password="normalpass123!")
        u.refresh_from_db()
        self.assertFalse(u.is_site_admin)


# ---------------------------------------------------------------------------
# AdminUserDeactivateView — POST /api/admin/users/{pk}/deactivate/
# ---------------------------------------------------------------------------

class AdminUserDeactivateViewTests(TestCase):
    def setUp(self):
        from boards.models import Board, BoardMembership
        self.Board = Board
        self.BoardMembership = BoardMembership

        self.admin = make_admin()
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def _make_user(self, username, **kwargs):
        return make_user(username=username, **kwargs)

    def _make_board(self, owner, name="Test Board"):
        return self.Board.objects.create(name=name, owner=owner)

    def _deactivate(self, pk, payload=None):
        return self.client.post(f"/api/admin/users/{pk}/deactivate/", payload or {}, format="json")

    # --- happy path: no boards ---

    def test_deactivate_user_with_no_boards_succeeds(self):
        target = self._make_user("noboards")
        r = self._deactivate(target.pk)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        target.refresh_from_db()
        self.assertFalse(target.is_active)

    def test_response_reflects_is_active_false(self):
        target = self._make_user("noboards2")
        r = self._deactivate(target.pk)
        self.assertFalse(r.json()["is_active"])

    # --- 409 when user owns boards and no transfers provided ---

    def test_deactivate_board_owner_without_transfers_returns_409(self):
        owner = self._make_user("boardowner")
        self._make_board(owner)
        r = self._deactivate(owner.pk)
        self.assertEqual(r.status_code, status.HTTP_409_CONFLICT)
        self.assertEqual(r.json()["code"], "owned_boards")

    def test_409_response_lists_owned_boards(self):
        owner = self._make_user("boardowner2")
        self._make_board(owner, name="Alpha")
        r = self._deactivate(owner.pk)
        board_names = [b["name"] for b in r.json()["owned_boards"]]
        self.assertIn("Alpha", board_names)

    def test_user_not_deactivated_after_409(self):
        owner = self._make_user("boardowner3")
        self._make_board(owner)
        self._deactivate(owner.pk)
        owner.refresh_from_db()
        self.assertTrue(owner.is_active)

    # --- happy path: boards with valid transfers ---

    def test_deactivate_with_valid_transfer_succeeds(self):
        owner = self._make_user("xferowner")
        member = self._make_user("xfermember")
        board = self._make_board(owner)
        self.BoardMembership.objects.create(board=board, user=member, role="member")

        r = self._deactivate(owner.pk, {"transfers": [{"board_id": board.pk, "transfer_to": member.pk}]})
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_board_ownership_transferred_after_deactivation(self):
        owner = self._make_user("xferowner2")
        member = self._make_user("xfermember2")
        board = self._make_board(owner)
        self.BoardMembership.objects.create(board=board, user=member, role="member")

        self._deactivate(owner.pk, {"transfers": [{"board_id": board.pk, "transfer_to": member.pk}]})
        board.refresh_from_db()
        self.assertEqual(board.owner_id, member.pk)

    def test_deactivated_user_marked_inactive_after_transfer(self):
        owner = self._make_user("xferowner3")
        member = self._make_user("xfermember3")
        board = self._make_board(owner)
        self.BoardMembership.objects.create(board=board, user=member, role="member")

        self._deactivate(owner.pk, {"transfers": [{"board_id": board.pk, "transfer_to": member.pk}]})
        owner.refresh_from_db()
        self.assertFalse(owner.is_active)

    # --- transfer target is not a board member ---

    def test_transfer_to_non_member_returns_400(self):
        owner = self._make_user("nonmemberowner")
        outsider = self._make_user("outsider")
        board = self._make_board(owner)
        # outsider has no BoardMembership for this board

        r = self._deactivate(owner.pk, {"transfers": [{"board_id": board.pk, "transfer_to": outsider.pk}]})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_transfer_to_non_member_does_not_deactivate_user(self):
        owner = self._make_user("nonmemberowner2")
        outsider = self._make_user("outsider2")
        board = self._make_board(owner)
        self._deactivate(owner.pk, {"transfers": [{"board_id": board.pk, "transfer_to": outsider.pk}]})
        owner.refresh_from_db()
        self.assertTrue(owner.is_active)

    # --- transfer target is inactive ---

    def test_transfer_to_inactive_user_returns_400(self):
        owner = self._make_user("inactiveowner")
        inactive = self._make_user("inactivetarget")
        inactive.is_active = False
        inactive.save(update_fields=["is_active"])
        board = self._make_board(owner)
        self.BoardMembership.objects.create(board=board, user=inactive, role="member")

        r = self._deactivate(owner.pk, {"transfers": [{"board_id": board.pk, "transfer_to": inactive.pk}]})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    # --- incomplete transfers (not all owned boards covered) ---

    def test_missing_transfer_for_one_board_returns_400(self):
        owner = self._make_user("twoboardowner")
        member = self._make_user("twoboardmember")
        board1 = self._make_board(owner, name="Board One")
        board2 = self._make_board(owner, name="Board Two")
        self.BoardMembership.objects.create(board=board1, user=member, role="member")
        self.BoardMembership.objects.create(board=board2, user=member, role="member")

        # Only provide a transfer for board1, not board2.
        r = self._deactivate(owner.pk, {"transfers": [{"board_id": board1.pk, "transfer_to": member.pk}]})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    # --- invite links revoked on deactivation ---

    def test_pending_invite_links_revoked_on_deactivation(self):
        from accounts.models import InviteLink
        target = self._make_user("inviteuser")
        link, _ = InviteLink.generate(created_by=target)
        self.assertIsNone(link.revoked_at)

        self._deactivate(target.pk)

        link.refresh_from_db()
        self.assertIsNotNone(link.revoked_at)

    def test_already_used_invite_link_not_touched_on_deactivation(self):
        from accounts.models import InviteLink
        target = self._make_user("inviteuser2")
        link, _ = InviteLink.generate(created_by=target)
        link.used_at = timezone.now()
        link.save(update_fields=["used_at"])

        self._deactivate(target.pk)

        # used_at links are not pending — revoked_at should stay null.
        link.refresh_from_db()
        self.assertIsNone(link.revoked_at)

    def test_already_revoked_invite_link_not_re_stamped(self):
        from accounts.models import InviteLink
        target = self._make_user("inviteuser3")
        original_revoked = timezone.now() - timedelta(hours=1)
        link, _ = InviteLink.generate(created_by=target)
        link.revoked_at = original_revoked
        link.save(update_fields=["revoked_at"])

        self._deactivate(target.pk)

        link.refresh_from_db()
        # The timestamp should not be updated — the bulk update only touches
        # links where revoked_at__isnull=True, so this link is not re-stamped.
        self.assertAlmostEqual(
            link.revoked_at.timestamp(),
            original_revoked.timestamp(),
            delta=1,
        )

    # --- self-deactivation guard ---

    def test_cannot_deactivate_self(self):
        r = self._deactivate(self.admin.pk)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("cannot deactivate", r.json()["detail"].lower())

    def test_self_remains_active_after_rejected_attempt(self):
        self._deactivate(self.admin.pk)
        self.admin.refresh_from_db()
        self.assertTrue(self.admin.is_active)

    # --- already-inactive user ---

    def test_cannot_deactivate_already_inactive_user(self):
        target = self._make_user("alreadyinactive")
        target.is_active = False
        target.save(update_fields=["is_active"])
        r = self._deactivate(target.pk)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("already inactive", r.json()["detail"].lower())

    # --- 404 ---

    def test_nonexistent_user_returns_404(self):
        r = self._deactivate(99999)
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)

    # --- permission ---

    def test_non_admin_rejected(self):
        target = self._make_user("noadmindeact")
        regular = self._make_user("regulardeact")
        self.client.force_authenticate(regular)
        r = self._deactivate(target.pk)
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)


# ---------------------------------------------------------------------------
# AdminUserDetailView.patch — 409 guard for board-owning users
# ---------------------------------------------------------------------------

class AdminPatchUserBoardOwner409Tests(TestCase):
    def setUp(self):
        from boards.models import Board
        self.Board = Board

        self.admin = make_admin(username="patch409admin")
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def test_patch_is_active_false_on_board_owner_returns_409(self):
        owner = make_user(username="patchboardowner")
        self.Board.objects.create(name="Owned Board", owner=owner)

        r = self.client.patch(f"/api/admin/users/{owner.pk}/", {"is_active": False})
        self.assertEqual(r.status_code, status.HTTP_409_CONFLICT)

    def test_409_response_contains_code_and_owned_boards(self):
        owner = make_user(username="patchboardowner2")
        self.Board.objects.create(name="My Board", owner=owner)

        r = self.client.patch(f"/api/admin/users/{owner.pk}/", {"is_active": False})
        data = r.json()
        self.assertEqual(data["code"], "owned_boards")
        self.assertTrue(len(data["owned_boards"]) > 0)
        self.assertIn("My Board", [b["name"] for b in data["owned_boards"]])

    def test_409_does_not_deactivate_user(self):
        owner = make_user(username="patchboardowner3")
        self.Board.objects.create(name="Safe Board", owner=owner)

        self.client.patch(f"/api/admin/users/{owner.pk}/", {"is_active": False})
        owner.refresh_from_db()
        self.assertTrue(owner.is_active)

    def test_patch_is_active_false_on_user_without_boards_succeeds(self):
        # Confirm the 409 only triggers when boards are owned.
        target = make_user(username="patchnoboards")
        r = self.client.patch(f"/api/admin/users/{target.pk}/", {"is_active": False})
        self.assertEqual(r.status_code, status.HTTP_200_OK)


# ---------------------------------------------------------------------------
# MustNotHavePendingPasswordChange enforced on all admin endpoints
# ---------------------------------------------------------------------------

class AdminMustChangePwdBlocksTests(TestCase):
    """An admin with must_change_password=True must be blocked from all admin endpoints.

    _ADMIN_PERMISSIONS includes MustNotHavePendingPasswordChange explicitly
    because class-level permission_classes replaces the global DEFAULT list.
    This test verifies that the constant actually enforces the block.
    """

    def setUp(self):
        self.admin = make_admin(username="pwdblock_admin")
        self.admin.must_change_password = True
        self.admin.save(update_fields=["must_change_password"])
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def test_get_settings_blocked(self):
        r = self.client.get("/api/admin/settings/")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_get_users_blocked(self):
        r = self.client.get("/api/admin/users/")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_get_invite_links_blocked(self):
        r = self.client.get("/api/admin/invite-links/")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_post_invite_links_blocked(self):
        r = self.client.post("/api/admin/invite-links/", {})
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_deactivate_user_blocked(self):
        target = make_user(username="pwdblock_target")
        r = self.client.post(f"/api/admin/users/{target.pk}/deactivate/", {})
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
