"""Tests for the password-reset flow: URL generation, OAuth-only user handling,
throttled endpoint, and confirm with valid/expired tokens."""
from unittest.mock import MagicMock, patch

from allauth.account.forms import default_token_generator
from allauth.account.utils import user_pk_to_url_str
from django.test import TestCase, override_settings
from rest_framework import status
from rest_framework.test import APIClient

from accounts.forms import VisibanPasswordResetForm, _frontend_url_generator
from accounts.models import User


class FrontendUrlGeneratorTests(TestCase):
    """_frontend_url_generator builds the correct SPA URL."""

    def _make_user(self):
        return User.objects.create_user(username="urltest", email="url@example.com", password="pass1")

    @override_settings(FRONTEND_URL="https://app.example.com")
    def test_url_uses_frontend_url(self):
        user = self._make_user()
        url = _frontend_url_generator(MagicMock(), user, "abc123-def456")
        uid = user_pk_to_url_str(user)
        self.assertEqual(url, f"https://app.example.com/reset-password/{uid}/abc123-def456")

    @override_settings(FRONTEND_URL="https://app.example.com/")
    def test_url_strips_trailing_slash(self):
        user = self._make_user()
        url = _frontend_url_generator(MagicMock(), user, "xyz-token")
        uid = user_pk_to_url_str(user)
        self.assertEqual(url, f"https://app.example.com/reset-password/{uid}/xyz-token")

    @override_settings(FRONTEND_URL="http://localhost:5173")
    def test_url_dev_default(self):
        user = self._make_user()
        url = _frontend_url_generator(MagicMock(), user, "tok-en")
        uid = user_pk_to_url_str(user)
        self.assertEqual(url, f"http://localhost:5173/reset-password/{uid}/tok-en")


class OAuthOnlyPasswordResetTests(TestCase):
    """VisibanPasswordResetForm.save() sends the alternate email for OAuth-only users."""

    def test_oauth_only_user_gets_alternate_email(self):
        from allauth.socialaccount.models import SocialAccount

        user = User.objects.create_user(username="oauthuser", email="oauth@example.com")
        user.set_unusable_password()
        user.save()
        SocialAccount.objects.create(user=user, provider="google", uid="google-123", extra_data={})

        form = VisibanPasswordResetForm.__new__(VisibanPasswordResetForm)
        form.cleaned_data = {"email": "oauth@example.com"}
        form.users = [user]

        mock_adapter = MagicMock()
        request = MagicMock()

        with patch("accounts.forms.get_adapter", return_value=mock_adapter):
            form.save(request)

        # send_mail must be called with the no-password template.
        # All three args are positional: (template_prefix, email, context_dict).
        mock_adapter.send_mail.assert_called_once()
        args, _ = mock_adapter.send_mail.call_args
        self.assertEqual(args[0], "account/email/password_reset_no_password")
        self.assertEqual(args[2]["provider"], "Google")

    def test_regular_user_goes_through_standard_flow(self):
        user = User.objects.create_user(
            username="regular", email="regular@example.com", password="strongpass1"
        )

        form = VisibanPasswordResetForm.__new__(VisibanPasswordResetForm)
        form.cleaned_data = {"email": "regular@example.com"}
        form.users = [user]

        request = MagicMock()
        # super().save() is the actual AllAuthPasswordResetForm.save() — mock it
        with patch.object(
            VisibanPasswordResetForm.__bases__[0], "save", return_value=None
        ) as mock_super_save:
            form.save(request)
            mock_super_save.assert_called_once()


class PasswordResetEndpointTests(TestCase):
    """POST /api/v1/auth/password/reset/ — enumeration safety."""

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(
            username="alice", email="alice@example.com", password="strongpass1"
        )

    def _post_reset(self, email):
        # Patch VisibanPasswordResetForm.save to avoid sending real emails.
        with patch.object(VisibanPasswordResetForm, "save", return_value=None):
            return self.client.post(
                "/api/v1/auth/password/reset/", {"email": email}
            )

    def test_reset_request_returns_200_for_registered_email(self):
        r = self._post_reset("alice@example.com")
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_reset_request_returns_200_for_unknown_email(self):
        """Endpoint must not reveal whether an email is registered."""
        r = self._post_reset("nobody@example.com")
        self.assertEqual(r.status_code, status.HTTP_200_OK)


class PasswordResetConfirmTests(TestCase):
    """POST /api/v1/auth/password/reset/confirm/ — valid token, invalid token."""

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(
            username="bob", email="bob@example.com", password="oldpassword1"
        )

    def _make_confirm_payload(self, user=None):
        u = user or self.user
        # dj-rest-auth uses allauth's url_str_to_user_pk (base36) when allauth
        # is installed — must match or uid decoding returns 400.
        uid = user_pk_to_url_str(u)
        token = default_token_generator.make_token(u)
        return {
            "uid": uid,
            "token": token,
            "new_password1": "NewPass9876",
            "new_password2": "NewPass9876",
        }

    def test_confirm_with_valid_token_resets_password(self):
        payload = self._make_confirm_payload()
        r = self.client.post("/api/v1/auth/password/reset/confirm/", payload)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password("NewPass9876"))

    def test_confirm_with_invalid_token_returns_400(self):
        payload = self._make_confirm_payload()
        payload["token"] = "invalid-token-xyz"
        r = self.client.post("/api/v1/auth/password/reset/confirm/", payload)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_confirm_with_mismatched_passwords_returns_400(self):
        payload = self._make_confirm_payload()
        payload["new_password2"] = "DifferentPass9876"
        r = self.client.post("/api/v1/auth/password/reset/confirm/", payload)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_confirm_token_can_only_be_used_once(self):
        payload = self._make_confirm_payload()
        r1 = self.client.post("/api/v1/auth/password/reset/confirm/", payload)
        self.assertEqual(r1.status_code, status.HTTP_200_OK)
        # Second use of the same token must fail.
        r2 = self.client.post("/api/v1/auth/password/reset/confirm/", payload)
        self.assertEqual(r2.status_code, status.HTTP_400_BAD_REQUEST)
