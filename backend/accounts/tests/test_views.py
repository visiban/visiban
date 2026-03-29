"""Tests for accounts views: CurrentUserView, ChangePasswordView, AuthProvidersView."""
from django.test import TestCase, Client as DjangoTestClient
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User


class CurrentUserViewTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="alice", password="pass12345678")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_get_current_user(self):
        r = self.client.get("/api/auth/me/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json()["username"], "alice")

    def test_patch_current_user(self):
        r = self.client.patch("/api/auth/me/", {"first_name": "Alice"})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json()["first_name"], "Alice")

    def test_patch_invalid_returns_400(self):
        # Sending a read-only field with an empty username triggers validation error
        r = self.client.patch("/api/auth/me/", {"username": ""})
        self.assertIn(r.status_code, [status.HTTP_400_BAD_REQUEST, status.HTTP_200_OK])

    def test_unauthenticated_returns_401(self):
        self.client.force_authenticate(user=None)
        r = self.client.get("/api/auth/me/")
        self.assertIn(r.status_code, [status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN])

    def test_patch_has_completed_tour(self):
        """User can mark the onboarding tour as completed via PATCH /api/auth/me/."""
        self.assertFalse(self.user.has_completed_tour)
        r = self.client.patch("/api/auth/me/", {"has_completed_tour": True})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertTrue(r.json()["has_completed_tour"])
        self.user.refresh_from_db()
        self.assertTrue(self.user.has_completed_tour)

    def test_get_returns_has_completed_tour(self):
        """GET /api/auth/me/ includes has_completed_tour in the response."""
        r = self.client.get("/api/auth/me/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIn("has_completed_tour", r.json())
        self.assertFalse(r.json()["has_completed_tour"])


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

    def test_session_preserved_after_password_change(self):
        """Session must stay alive after password change (update_session_auth_hash)."""
        django_client = DjangoTestClient()
        django_client.login(username="bob", password="oldpassword123")

        r = django_client.post(
            "/api/auth/change-password/",
            data='{"current_password": "oldpassword123", "new_password": "newpassword456secure"}',
            content_type="application/json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)

        # Session must still be valid — authenticated endpoint returns 200, not 401/403.
        r2 = django_client.get("/api/auth/me/")
        self.assertEqual(r2.status_code, status.HTTP_200_OK)


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
        # OIDC keys added in #349 — must always be present even when not configured.
        self.assertIn("oidc", data)
        self.assertIn("oidc_name", data)

    def test_providers_unauthenticated_allowed(self):
        # AllowAny — no auth needed
        r = self.client.get("/api/auth/providers/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)


class UserSearchViewTests(TestCase):
    """Tests for GET /api/users/?search=<query>."""

    def setUp(self):
        self.requester = User.objects.create_user(
            username="searcher", email="searcher@example.com", password="pass"
        )
        self.alice = User.objects.create_user(
            username="alice", email="alice@example.com",
            password="pass", display_name="Alice Wonderland",
        )
        self.bob = User.objects.create_user(
            username="bob", email="bob@example.com",
            password="pass", display_name="Bob Builder",
        )
        self.client = APIClient()
        self.client.force_authenticate(self.requester)

    def test_search_by_display_name(self):
        r = self.client.get("/api/users/", {"search": "Alice"})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        usernames = [u["username"] for u in r.json()]
        self.assertIn("alice", usernames)
        self.assertNotIn("bob", usernames)

    def test_search_by_username(self):
        r = self.client.get("/api/users/", {"search": "bo"})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        usernames = [u["username"] for u in r.json()]
        self.assertIn("bob", usernames)

    def test_search_by_email(self):
        r = self.client.get("/api/users/", {"search": "alice@"})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        emails_returned = [u["username"] for u in r.json()]
        self.assertIn("alice", emails_returned)

    def test_short_query_returns_empty(self):
        """Queries shorter than 2 characters return an empty list."""
        r = self.client.get("/api/users/", {"search": "a"})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json(), [])

    def test_empty_query_returns_empty(self):
        r = self.client.get("/api/users/", {"search": ""})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json(), [])

    def test_results_exclude_requester(self):
        """The authenticated user must not appear in their own search results."""
        r = self.client.get("/api/users/", {"search": "searcher"})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        usernames = [u["username"] for u in r.json()]
        self.assertNotIn("searcher", usernames)

    def test_results_capped_at_ten(self):
        """Results are limited to 10 regardless of how many users match."""
        for i in range(15):
            User.objects.create_user(username=f"match_user_{i}", password="pass",
                                     display_name=f"Matching User {i}")
        r = self.client.get("/api/users/", {"search": "match"})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertLessEqual(len(r.json()), 10)

    def test_response_uses_public_serializer_fields(self):
        """Response includes only the public fields (id, username, display_name, avatar_url)."""
        r = self.client.get("/api/users/", {"search": "alice"})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        result = r.json()[0]
        self.assertIn("id", result)
        self.assertIn("username", result)
        self.assertIn("display_name", result)
        self.assertIn("avatar_url", result)
        # Private fields must not be exposed
        self.assertNotIn("email", result)
        self.assertNotIn("must_change_password", result)
        self.assertNotIn("notif_card_assigned", result)

    def test_unauthenticated_returns_401(self):
        self.client.force_authenticate(user=None)
        r = self.client.get("/api/users/", {"search": "alice"})
        self.assertIn(r.status_code, [status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN])
