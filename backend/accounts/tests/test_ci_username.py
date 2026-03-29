"""Tests for case-insensitive username uniqueness (#436)."""

from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from accounts.models import User


@override_settings(
    CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}},
)
class ChooseUsernameViewTests(TestCase):
    """Tests for POST /api/auth/choose-username/."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="_rename_99",
            email="loser@example.com",
            password="testpass12345",
            must_change_username=True,
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_choose_valid_username(self):
        resp = self.client.post("/api/auth/choose-username/", {"username": "newname"})
        self.assertEqual(resp.status_code, 200)
        self.user.refresh_from_db()
        self.assertEqual(self.user.username, "newname")
        self.assertFalse(self.user.must_change_username)

    def test_choose_duplicate_case_insensitive(self):
        User.objects.create_user(
            username="Existing",
            email="existing@example.com",
            password="testpass12345",
        )
        resp = self.client.post("/api/auth/choose-username/", {"username": "existing"})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("already taken", resp.data["detail"])

    def test_choose_same_username_case_variant_allowed(self):
        """The user should be able to choose a case variant of their own current name."""
        self.user.username = "myname"
        self.user.save(update_fields=["username"])
        resp = self.client.post("/api/auth/choose-username/", {"username": "MyName"})
        self.assertEqual(resp.status_code, 200)
        self.user.refresh_from_db()
        self.assertEqual(self.user.username, "MyName")

    def test_empty_username_rejected(self):
        resp = self.client.post("/api/auth/choose-username/", {"username": ""})
        self.assertEqual(resp.status_code, 400)

    def test_too_long_username_rejected(self):
        resp = self.client.post("/api/auth/choose-username/", {"username": "a" * 151})
        self.assertEqual(resp.status_code, 400)

    def test_invalid_chars_rejected(self):
        resp = self.client.post("/api/auth/choose-username/", {"username": "bad name!"})
        self.assertEqual(resp.status_code, 400)

    def test_unauthenticated_returns_401(self):
        self.client.force_authenticate(None)
        resp = self.client.post("/api/auth/choose-username/", {"username": "test"})
        self.assertEqual(resp.status_code, 401)


@override_settings(
    CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}},
)
class MustNotHavePendingUsernameChangeTests(TestCase):
    """Tests that the MustNotHavePendingUsernameChange permission blocks API access."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="_rename_1",
            email="blocked@example.com",
            password="testpass12345",
            must_change_username=True,
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_blocked_user_cannot_access_normal_endpoints(self):
        # Use /api/auth/tokens/ which inherits DEFAULT_PERMISSION_CLASSES
        # (CurrentUserView opts out with explicit [IsAuthenticated]).
        resp = self.client.get("/api/auth/tokens/")
        self.assertEqual(resp.status_code, 403)

    def test_blocked_user_can_access_choose_username(self):
        resp = self.client.post("/api/auth/choose-username/", {"username": "newuser"})
        self.assertEqual(resp.status_code, 200)

    def test_blocked_user_can_access_change_password(self):
        """ChangePasswordView opts out of all pending-change gates."""
        resp = self.client.post("/api/auth/change-password/", {
            "current_password": "testpass12345",
            "new_password": "newpass12345!",
        })
        self.assertEqual(resp.status_code, 200)

    def test_unblocked_user_can_access_normal_endpoints(self):
        self.user.must_change_username = False
        self.user.save(update_fields=["must_change_username"])
        resp = self.client.get("/api/auth/tokens/")
        self.assertEqual(resp.status_code, 200)

    def test_error_code_in_response(self):
        """PAT/API clients get a machine-readable code to detect the condition."""
        resp = self.client.get("/api/auth/tokens/")
        self.assertEqual(resp.status_code, 403)
        self.assertIn("must_change_username", str(resp.data))


@override_settings(
    CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}},
)
class AdminCreateUserCIUsernameTests(TestCase):
    """Admin user creation rejects case-insensitive duplicates."""

    def setUp(self):
        self.admin = User.objects.create_user(
            username="admin",
            email="admin@example.com",
            password="testpass12345",
            is_site_admin=True,
        )
        User.objects.create_user(
            username="Existing",
            email="existing@example.com",
            password="testpass12345",
        )
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def test_admin_create_user_rejects_ci_duplicate(self):
        resp = self.client.post("/api/admin/users/", {
            "username": "existing",
            "email": "new@example.com",
            "password": "testpass12345!",
            "force_password_reset": True,
        })
        self.assertEqual(resp.status_code, 400)
        self.assertIn("username", resp.data)


@override_settings(
    CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}},
)
class UserSerializerMustChangeUsernameTests(TestCase):
    """Verify must_change_username appears in serialized output."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="testuser",
            email="test@example.com",
            password="testpass12345",
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_field_present_in_current_user(self):
        resp = self.client.get("/api/auth/me/")
        self.assertIn("must_change_username", resp.data)
        self.assertFalse(resp.data["must_change_username"])

    def test_field_is_read_only(self):
        resp = self.client.patch("/api/auth/me/", {"must_change_username": True})
        self.assertEqual(resp.status_code, 200)
        self.user.refresh_from_db()
        self.assertFalse(self.user.must_change_username)


@override_settings(
    CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}},
)
class SetSiteAdminCILookupTests(TestCase):
    """set_site_admin management command uses case-insensitive lookup."""

    def test_case_insensitive_lookup(self):
        from django.core.management import call_command
        from io import StringIO

        User.objects.create_user(
            username="AdminUser",
            email="adminuser@example.com",
            password="testpass12345",
        )
        out = StringIO()
        call_command("set_site_admin", "adminuser", stdout=out)
        user = User.objects.get(username="AdminUser")
        self.assertTrue(user.is_site_admin)
