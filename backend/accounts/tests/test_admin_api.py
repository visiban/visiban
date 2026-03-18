"""Tests for #211/#212: site admin API endpoints."""
from django.test import TestCase
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
        from accounts.adapter import RegistrationAdapter
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
