"""Tests for PATAuthentication security fix: inactive users are rejected.

Covers the guard added to accounts/authentication.py:
    if not pat.user.is_active:
        raise AuthenticationFailed("User account is disabled.")
"""
from datetime import timedelta

from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient, APITestCase

from accounts.models import PersonalAccessToken, User


def make_user(username="patuser", password="SecurePass123!", **kwargs):
    return User.objects.create_user(username=username, password=password, **kwargs)


class PATAuthenticationInactiveUserTests(APITestCase):
    """PATAuthentication must reject tokens belonging to inactive accounts."""

    def setUp(self):
        self.client = APIClient()

    def _auth_header(self, raw_token):
        return {"HTTP_AUTHORIZATION": f"Token {raw_token}"}

    # ------------------------------------------------------------------
    # Happy path: active user with a valid PAT
    # ------------------------------------------------------------------

    def test_active_user_with_valid_pat_returns_200(self):
        user = make_user("activeuser")
        _, raw = PersonalAccessToken.generate(user, "ci")
        r = self.client.get("/api/v1/auth/me/", **self._auth_header(raw))
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json()["id"], user.id)

    # ------------------------------------------------------------------
    # Deactivated user: PAT must be rejected even if the token is valid
    # ------------------------------------------------------------------

    def test_deactivated_user_pat_returns_401(self):
        user = make_user("inactiveuser")
        _, raw = PersonalAccessToken.generate(user, "ci")
        # Deactivate the user after issuing the token
        user.is_active = False
        user.save(update_fields=["is_active"])
        r = self.client.get("/api/v1/auth/me/", **self._auth_header(raw))
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_deactivated_user_pat_error_message(self):
        """The 401 response body must contain the expected message for inactive accounts."""
        user = make_user("inactiveuser2")
        _, raw = PersonalAccessToken.generate(user, "ci")
        user.is_active = False
        user.save(update_fields=["is_active"])
        r = self.client.get("/api/v1/auth/me/", **self._auth_header(raw))
        self.assertIn("disabled", r.json()["detail"].lower())

    # ------------------------------------------------------------------
    # Expired PAT: must return 401 with expiry message
    # ------------------------------------------------------------------

    def test_expired_pat_returns_401(self):
        user = make_user("expiredtokenuser")
        _, raw = PersonalAccessToken.generate(
            user, "ci", expires_at=timezone.now() - timedelta(seconds=1)
        )
        r = self.client.get("/api/v1/auth/me/", **self._auth_header(raw))
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_expired_pat_error_message(self):
        """Expired PATs must report the expiry reason, not the inactive-user message."""
        user = make_user("expiredtokenuser2")
        _, raw = PersonalAccessToken.generate(
            user, "ci", expires_at=timezone.now() - timedelta(seconds=1)
        )
        r = self.client.get("/api/v1/auth/me/", **self._auth_header(raw))
        self.assertIn("expired", r.json()["detail"].lower())

    # ------------------------------------------------------------------
    # Expiry check precedes is_active check (ordering: expired token on
    # a deactivated user should still say "expired", not "disabled")
    # ------------------------------------------------------------------

    def test_expired_pat_on_inactive_user_reports_expired(self):
        """The expiry guard runs before the is_active guard — expired wins."""
        user = make_user("expiredinactive")
        _, raw = PersonalAccessToken.generate(
            user, "ci", expires_at=timezone.now() - timedelta(seconds=1)
        )
        user.is_active = False
        user.save(update_fields=["is_active"])
        r = self.client.get("/api/v1/auth/me/", **self._auth_header(raw))
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertIn("expired", r.json()["detail"].lower())
