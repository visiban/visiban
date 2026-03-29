"""Tests for ChangePasswordView PAT revocation behavior (#406).

Changing a password must revoke all existing Personal Access Tokens so
that a compromised account cannot retain API access after a credential reset.
"""
from rest_framework import status
from rest_framework.test import APIClient, APITestCase

from accounts.models import PersonalAccessToken, User


class ChangePasswordPATRevocationTests(APITestCase):
    """Covers #406: password change revokes all PATs."""

    def setUp(self):
        self.user = User.objects.create_user(username="alice", password="OldPassword123!")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.url = "/api/auth/change-password/"

    def test_password_change_revokes_all_pats(self):
        """All PATs belonging to the user are deleted on password change."""
        PersonalAccessToken.generate(self.user, "ci-1")
        PersonalAccessToken.generate(self.user, "ci-2")
        PersonalAccessToken.generate(self.user, "deploy")
        self.assertEqual(self.user.personal_access_tokens.count(), 3)

        r = self.client.post(self.url, {
            "current_password": "OldPassword123!",
            "new_password": "NewPassword456!",
        })
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(self.user.personal_access_tokens.count(), 0)

    def test_revoked_pat_cannot_authenticate_after_change(self):
        """A PAT that existed before the password change must be rejected."""
        _, raw_token = PersonalAccessToken.generate(self.user, "ci")

        self.client.post(self.url, {
            "current_password": "OldPassword123!",
            "new_password": "NewPassword456!",
        })

        # Try authenticating with the now-revoked token
        anon = APIClient()
        r = anon.get("/api/auth/me/", HTTP_AUTHORIZATION=f"Token {raw_token}")
        self.assertIn(r.status_code, [status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN])

    def test_other_users_pats_not_affected(self):
        """Changing one user's password must not revoke another user's PATs."""
        other = User.objects.create_user(username="bob", password="BobPass1234!")
        PersonalAccessToken.generate(other, "bob-token")
        PersonalAccessToken.generate(self.user, "alice-token")

        self.client.post(self.url, {
            "current_password": "OldPassword123!",
            "new_password": "NewPassword456!",
        })

        # Alice's tokens are gone
        self.assertEqual(self.user.personal_access_tokens.count(), 0)
        # Bob's token is untouched
        self.assertEqual(other.personal_access_tokens.count(), 1)

    def test_password_change_with_no_pats_succeeds(self):
        """Password change succeeds even when the user has no PATs."""
        self.assertEqual(self.user.personal_access_tokens.count(), 0)
        r = self.client.post(self.url, {
            "current_password": "OldPassword123!",
            "new_password": "NewPassword456!",
        })
        self.assertEqual(r.status_code, status.HTTP_200_OK)
