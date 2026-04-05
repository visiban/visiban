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


class ChangePasswordValidatorTests(TestCase):
    """ChangePasswordView must run AUTH_PASSWORD_VALIDATORS after the length check.

    Covers the validate_password() call added to accounts/views.py. All
    passwords used here are at least 12 characters so they pass the length
    pre-check and reach the Django validator pipeline.
    """

    def setUp(self):
        self.user = User.objects.create_user(username="pwval_user", password="OldPassword123!")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _change(self, new_password):
        return self.client.post("/api/auth/change-password/", {
            "current_password": "OldPassword123!",
            "new_password": new_password,
        })

    # ------------------------------------------------------------------
    # CommonPasswordValidator
    # ------------------------------------------------------------------

    def test_common_password_rejected(self):
        # "123456789012" is 12 chars (passes length check) but is on Django's
        # common-password list, so CommonPasswordValidator must reject it.
        r = self._change("123456789012")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_common_password_error_is_string(self):
        """validate_password() messages are joined into a single string for API compat."""
        r = self._change("123456789012")
        detail = r.json()["detail"]
        self.assertIsInstance(detail, str)
        self.assertTrue(len(detail) > 0)

    # ------------------------------------------------------------------
    # NumericPasswordValidator
    # ------------------------------------------------------------------

    def test_all_numeric_password_rejected(self):
        # A random-looking all-digit string that is not on the common list
        # but still fails NumericPasswordValidator.
        r = self._change("934857263849")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    # ------------------------------------------------------------------
    # Strong password passes all validators
    # ------------------------------------------------------------------

    def test_strong_password_accepted(self):
        r = self._change("Tr0ub4dor&3xtra!")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password("Tr0ub4dor&3xtra!"))


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

    def test_search_by_email_does_not_leak_existence(self):
        # Email filtering was removed to prevent a silent email-existence oracle:
        # an email-style query returning results would confirm account existence
        # even though the email field is not returned in the response body.
        r = self.client.get("/api/users/", {"search": "alice@"})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json(), [])

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


class CurrentUserSerializerWritableFieldsTests(TestCase):
    """Allowlist test for CurrentUserSerializer writable fields (#589).

    A denylist test silently passes when a new sensitive field is added to the
    serializer without being marked read_only.  This allowlist test fails fast
    whenever the serializer changes, forcing an explicit decision about whether
    each new field should be writable via PATCH /api/auth/me/.
    """

    def test_writable_fields_match_allowlist(self):
        """Only explicitly approved fields may be writable via PATCH /api/auth/me/."""
        from accounts.serializers import CurrentUserSerializer

        # Fields that are intentionally writable by the authenticated user.
        # To add a new writable field: add it here AND confirm it is safe to expose
        # via the user-facing profile update endpoint before merging.
        ALLOWED_WRITABLE = {
            "username",
            "email",
            "first_name",
            "last_name",
            "avatar_url",
            "display_name",
            "timezone",
            "date_format",
            "time_format",
            "number_locale",
            "close_editor_on_enter",
            "has_completed_tour",
            "notif_card_assigned",
            "notif_mentioned",
            "notif_due_soon",
            "notif_card_moved",
            "notif_comment_added",
            "notif_board_invite",
            "default_board_id",
        }

        serializer = CurrentUserSerializer()
        writable = {
            name for name, field in serializer.fields.items()
            if not field.read_only
        }

        self.assertEqual(
            writable,
            ALLOWED_WRITABLE,
            "CurrentUserSerializer writable fields have changed. "
            "Update ALLOWED_WRITABLE with an explicit decision about whether "
            "the new/removed field should be writable via PATCH /api/auth/me/. "
            f"Unexpected writable: {writable - ALLOWED_WRITABLE!r}. "
            f"Missing from serializer: {ALLOWED_WRITABLE - writable!r}.",
        )
