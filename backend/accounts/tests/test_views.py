"""Tests for accounts views: CurrentUserView, ChangePasswordView, AuthProvidersView."""
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User


class CurrentUserViewTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="alice", password="pass12345678")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_get_current_user(self):
        r = self.client.get("/api/auth/user/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json()["username"], "alice")

    def test_patch_current_user(self):
        r = self.client.patch("/api/auth/user/", {"first_name": "Alice"})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json()["first_name"], "Alice")

    def test_unauthenticated_returns_401(self):
        self.client.force_authenticate(user=None)
        r = self.client.get("/api/auth/user/")
        self.assertIn(r.status_code, [status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN])


class ChangePasswordViewTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="bob", password="oldpassword123")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_correct_password_change(self):
        r = self.client.post("/api/auth/change-password/", {
            "current_password": "oldpassword123",
            "new_password": "newpassword456secure",
        })
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password("newpassword456secure"))
        self.assertFalse(self.user.must_change_password)

    def test_wrong_current_password_rejected(self):
        r = self.client.post("/api/auth/change-password/", {
            "current_password": "wrongpassword",
            "new_password": "newpassword456secure",
        })
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("incorrect", r.json()["detail"].lower())

    def test_new_password_too_short(self):
        r = self.client.post("/api/auth/change-password/", {
            "current_password": "oldpassword123",
            "new_password": "short",
        })
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("12", r.json()["detail"])

    def test_empty_new_password_rejected(self):
        r = self.client.post("/api/auth/change-password/", {
            "current_password": "oldpassword123",
            "new_password": "",
        })
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)


class AuthProvidersViewTests(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_providers_returns_expected_keys(self):
        r = self.client.get("/api/auth/providers/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        data = r.json()
        self.assertIn("google", data)
        self.assertIn("github", data)
        self.assertIn("gitlab", data)

    def test_providers_unauthenticated_allowed(self):
        # AllowAny — no auth needed
        r = self.client.get("/api/auth/providers/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
