"""Tests for OAuth + invite-only registration flow.

Covers: invite_utils (shared validation), SocialRegistrationAdapter,
OAuthInviteTokenMiddleware, and the refactored InviteRegisterView.
"""
import hashlib
from datetime import timedelta
from unittest.mock import MagicMock, patch

from django.test import TestCase, RequestFactory, override_settings
from django.utils import timezone

from accounts.adapter import (
    PENDING_INVITE_SESSION_KEY,
    SocialRegistrationAdapter,
)
from accounts.invite_utils import (
    InviteTokenError,
    consume_invite_token,
    validate_invite_token,
)
from accounts.middleware import OAuthInviteTokenMiddleware
from accounts.models import InviteLink, SiteSetting, User


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def make_user(**kwargs):
    kwargs.setdefault("password", "userpass123!")
    return User.objects.create_user(**kwargs)


def make_admin(**kwargs):
    kwargs.setdefault("username", "admin")
    kwargs.setdefault("password", "adminpass123!")
    u = User.objects.create_user(**kwargs)
    u.is_site_admin = True
    u.save(update_fields=["is_site_admin"])
    return u


def set_mode(mode):
    s = SiteSetting.get()
    s.registration_mode = mode
    s.save()


def create_invite(creator, **kwargs):
    """Create an invite link and return (instance, raw_token)."""
    return InviteLink.generate(created_by=creator, **kwargs)


# ---------------------------------------------------------------------------
# validate_invite_token tests
# ---------------------------------------------------------------------------

class ValidateInviteTokenTests(TestCase):
    def setUp(self):
        self.creator = make_user(username="creator")

    def test_valid_token_returns_link(self):
        link, raw = create_invite(self.creator)
        result = validate_invite_token(raw)
        self.assertEqual(result.pk, link.pk)

    def test_empty_token_raises_missing(self):
        with self.assertRaises(InviteTokenError) as ctx:
            validate_invite_token("")
        self.assertEqual(ctx.exception.code, "invite_missing")

    def test_whitespace_token_raises_missing(self):
        with self.assertRaises(InviteTokenError) as ctx:
            validate_invite_token("   ")
        self.assertEqual(ctx.exception.code, "invite_missing")

    def test_wrong_token_raises_invalid(self):
        create_invite(self.creator)
        with self.assertRaises(InviteTokenError) as ctx:
            validate_invite_token("vbnl_wrong_token_value_here")
        self.assertEqual(ctx.exception.code, "invite_invalid")

    def test_used_token_raises_invalid(self):
        link, raw = create_invite(self.creator, single_use=True)
        link.used_at = timezone.now()
        link.save(update_fields=["used_at"])
        with self.assertRaises(InviteTokenError) as ctx:
            validate_invite_token(raw)
        self.assertEqual(ctx.exception.code, "invite_invalid")

    def test_revoked_token_raises_invalid(self):
        link, raw = create_invite(self.creator)
        link.revoked_at = timezone.now()
        link.save(update_fields=["revoked_at"])
        with self.assertRaises(InviteTokenError) as ctx:
            validate_invite_token(raw)
        self.assertEqual(ctx.exception.code, "invite_invalid")

    def test_expired_token_raises_expired(self):
        link, raw = create_invite(
            self.creator,
            expires_at=timezone.now() - timedelta(hours=1),
        )
        with self.assertRaises(InviteTokenError) as ctx:
            validate_invite_token(raw)
        self.assertEqual(ctx.exception.code, "invite_expired")


class ConsumeInviteTokenTests(TestCase):
    def setUp(self):
        self.creator = make_user(username="creator")

    def test_single_use_sets_used_at(self):
        link, raw = create_invite(self.creator, single_use=True)
        self.assertIsNone(link.used_at)
        consume_invite_token(link)
        link.refresh_from_db()
        self.assertIsNotNone(link.used_at)

    def test_multi_use_is_noop(self):
        link, raw = create_invite(self.creator, single_use=False)
        consume_invite_token(link)
        link.refresh_from_db()
        self.assertIsNone(link.used_at)


# ---------------------------------------------------------------------------
# OAuthInviteTokenMiddleware tests
# ---------------------------------------------------------------------------

class OAuthInviteTokenMiddlewareTests(TestCase):
    def setUp(self):
        self.factory = RequestFactory()
        self.get_response = MagicMock(return_value=MagicMock(status_code=200))
        self.middleware = OAuthInviteTokenMiddleware(self.get_response)

    def _make_request(self, path, query=""):
        request = self.factory.get(path + ("?" + query if query else ""))
        request.session = {}
        return request

    def test_stashes_token_on_oauth_login_path(self):
        request = self._make_request(
            "/accounts/google/login/",
            "process=login&invite_token=vbnl_abc123",
        )
        self.middleware(request)
        self.assertEqual(request.session[PENDING_INVITE_SESSION_KEY], "vbnl_abc123")

    def test_ignores_non_vbnl_tokens(self):
        request = self._make_request(
            "/accounts/google/login/",
            "process=login&invite_token=not_a_valid_prefix",
        )
        self.middleware(request)
        self.assertNotIn(PENDING_INVITE_SESSION_KEY, request.session)

    def test_ignores_non_oauth_paths(self):
        request = self._make_request(
            "/api/v1/auth/login/",
            "invite_token=vbnl_abc123",
        )
        self.middleware(request)
        self.assertNotIn(PENDING_INVITE_SESSION_KEY, request.session)

    def test_ignores_callback_path(self):
        request = self._make_request(
            "/accounts/google/login/callback/",
            "invite_token=vbnl_abc123",
        )
        self.middleware(request)
        self.assertNotIn(PENDING_INVITE_SESSION_KEY, request.session)

    def test_works_for_all_providers(self):
        for provider in ["google", "github", "gitlab", "oidc"]:
            request = self._make_request(
                f"/accounts/{provider}/login/",
                "invite_token=vbnl_test123",
            )
            self.middleware(request)
            self.assertEqual(
                request.session.get(PENDING_INVITE_SESSION_KEY),
                "vbnl_test123",
                f"Failed for provider {provider}",
            )

    def test_no_token_param_is_noop(self):
        request = self._make_request("/accounts/google/login/", "process=login")
        self.middleware(request)
        self.assertNotIn(PENDING_INVITE_SESSION_KEY, request.session)


# ---------------------------------------------------------------------------
# SocialRegistrationAdapter tests
# ---------------------------------------------------------------------------

class SocialRegistrationAdapterIsOpenTests(TestCase):
    """Test is_open_for_signup across registration modes."""

    def setUp(self):
        self.creator = make_user(username="creator")
        self.adapter = SocialRegistrationAdapter()
        self.factory = RequestFactory()

    def _request_with_session(self, token=None):
        request = self.factory.get("/accounts/google/login/callback/")
        request.session = {}
        if token:
            request.session[PENDING_INVITE_SESSION_KEY] = token
        return request

    def test_open_mode_allows_signup(self):
        set_mode(SiteSetting.RegistrationMode.OPEN)
        request = self._request_with_session()
        self.assertTrue(self.adapter.is_open_for_signup(request, MagicMock()))

    def test_closed_mode_blocks_signup(self):
        set_mode(SiteSetting.RegistrationMode.CLOSED)
        request = self._request_with_session()
        self.assertFalse(self.adapter.is_open_for_signup(request, MagicMock()))

    def test_invite_only_with_valid_token_allows_signup(self):
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        _link, raw = create_invite(self.creator)
        request = self._request_with_session(token=raw)
        self.assertTrue(self.adapter.is_open_for_signup(request, MagicMock()))

    def test_invite_only_without_token_redirects(self):
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        request = self._request_with_session()
        from allauth.core.exceptions import ImmediateHttpResponse
        with self.assertRaises(ImmediateHttpResponse) as ctx:
            self.adapter.is_open_for_signup(request, MagicMock())
        self.assertIn("auth_error=invite_required", ctx.exception.response.url)

    def test_invite_only_with_expired_token_redirects(self):
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        _link, raw = create_invite(
            self.creator,
            expires_at=timezone.now() - timedelta(hours=1),
        )
        request = self._request_with_session(token=raw)
        from allauth.core.exceptions import ImmediateHttpResponse
        with self.assertRaises(ImmediateHttpResponse) as ctx:
            self.adapter.is_open_for_signup(request, MagicMock())
        self.assertIn("auth_error=invite_expired", ctx.exception.response.url)
        # Session should be cleaned up.
        self.assertNotIn(PENDING_INVITE_SESSION_KEY, request.session)

    def test_invite_only_with_used_token_redirects(self):
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        link, raw = create_invite(self.creator, single_use=True)
        link.used_at = timezone.now()
        link.save(update_fields=["used_at"])
        request = self._request_with_session(token=raw)
        from allauth.core.exceptions import ImmediateHttpResponse
        with self.assertRaises(ImmediateHttpResponse) as ctx:
            self.adapter.is_open_for_signup(request, MagicMock())
        self.assertIn("auth_error=invite_invalid", ctx.exception.response.url)

    def test_invite_only_with_bogus_token_redirects(self):
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        request = self._request_with_session(token="vbnl_totally_bogus_value")
        from allauth.core.exceptions import ImmediateHttpResponse
        with self.assertRaises(ImmediateHttpResponse):
            self.adapter.is_open_for_signup(request, MagicMock())


@override_settings(LOGIN_REDIRECT_URL="http://localhost:5173")
class SocialRegistrationAdapterSaveUserTests(TestCase):
    """Test that save_user consumes the invite token after user creation."""

    def setUp(self):
        self.creator = make_user(username="creator")
        self.adapter = SocialRegistrationAdapter()
        self.factory = RequestFactory()

    def test_consumes_single_use_token_on_save(self):
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        link, raw = create_invite(self.creator, single_use=True)

        request = self.factory.get("/")
        request.session = {PENDING_INVITE_SESSION_KEY: raw}

        # Mock sociallogin to return a user from super().save_user()
        mock_sociallogin = MagicMock()
        new_user = make_user(username="newuser_oauth")
        mock_sociallogin.user = new_user

        with patch.object(
            SocialRegistrationAdapter.__bases__[0],
            "save_user",
            return_value=new_user,
        ):
            result = self.adapter.save_user(request, mock_sociallogin, form=None)

        self.assertEqual(result, new_user)
        link.refresh_from_db()
        self.assertIsNotNone(link.used_at)
        # Session key should be consumed (popped).
        self.assertNotIn(PENDING_INVITE_SESSION_KEY, request.session)

    def test_does_not_consume_multi_use_token(self):
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        link, raw = create_invite(self.creator, single_use=False)

        request = self.factory.get("/")
        request.session = {PENDING_INVITE_SESSION_KEY: raw}

        mock_sociallogin = MagicMock()
        new_user = make_user(username="newuser_multi")
        mock_sociallogin.user = new_user

        with patch.object(
            SocialRegistrationAdapter.__bases__[0],
            "save_user",
            return_value=new_user,
        ):
            self.adapter.save_user(request, mock_sociallogin, form=None)

        link.refresh_from_db()
        self.assertIsNone(link.used_at)

    def test_open_mode_skips_token_consumption(self):
        set_mode(SiteSetting.RegistrationMode.OPEN)

        request = self.factory.get("/")
        request.session = {}

        mock_sociallogin = MagicMock()
        new_user = make_user(username="newuser_open")
        mock_sociallogin.user = new_user

        with patch.object(
            SocialRegistrationAdapter.__bases__[0],
            "save_user",
            return_value=new_user,
        ):
            result = self.adapter.save_user(request, mock_sociallogin, form=None)

        self.assertEqual(result, new_user)


# ---------------------------------------------------------------------------
# InviteRegisterView refactored to use shared utility
# ---------------------------------------------------------------------------

class InviteRegisterViewRefactorTests(TestCase):
    """Verify InviteRegisterView still works after refactoring to use shared utils."""

    def setUp(self):
        self.creator = make_admin()
        self.client.force_login(self.creator)
        # Create an invite link via admin API.
        resp = self.client.post(
            "/api/v1/admin/invite-links/",
            {"ttl_days": 7, "single_use": True},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 201)
        self.raw_token = resp.json()["raw_token"]
        self.client.logout()

    def test_invite_only_registration_with_valid_token(self):
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        resp = self.client.post(
            "/api/v1/auth/registration/",
            {
                "email": "newuser@example.com",
                "password1": "securepassword123!",
                "password2": "securepassword123!",
                "invite_token": self.raw_token,
            },
            content_type="application/json",
        )
        self.assertIn(resp.status_code, (200, 201, 204))

    def test_invite_only_registration_without_token_fails(self):
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        resp = self.client.post(
            "/api/v1/auth/registration/",
            {
                "email": "newuser2@example.com",
                "password1": "securepassword123!",
                "password2": "securepassword123!",
            },
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 400)
        self.assertIn("invite_token", resp.json())

    def test_invite_only_registration_with_expired_token_fails(self):
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        # Expire the token.
        token_hash = hashlib.sha256(self.raw_token.encode()).hexdigest()
        link = InviteLink.objects.get(token_hash=token_hash)
        link.expires_at = timezone.now() - timedelta(hours=1)
        link.save(update_fields=["expires_at"])
        resp = self.client.post(
            "/api/v1/auth/registration/",
            {
                "email": "newuser3@example.com",
                "password1": "securepassword123!",
                "password2": "securepassword123!",
                "invite_token": self.raw_token,
            },
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 400)
