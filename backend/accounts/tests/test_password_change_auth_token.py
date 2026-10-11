"""The DRF auth ``Token`` on the REST self-service password-change routes (#1553, #1562).

Registry Rule 3 (``docs/development/security-invariants.md``, "DRF auth
Token" and "Password change sources" rows): a password change revokes the
``Token`` minted at REST login. A caller that authenticated with that
``Token`` gets a replacement in the response's optional ``key`` field; a
session caller stays signed in through its session and gets no ``key``.

allauth's change and set paths and the Django admin's own-password path are
covered in ``test_forced_change_html_surfaces.py``.
"""

from unittest import mock

from django.core.cache import cache
from rest_framework import status
from rest_framework.authtoken.models import Token
from rest_framework.test import APIClient, APITestCase

from accounts import credentials
from accounts.models import PersonalAccessToken, User

CURRENT = "Current-Passw0rd!"  # gitleaks:allow -- test-only fixture password, not a credential
NEW = "Brand-New-Passw0rd!"  # gitleaks:allow -- test-only fixture password, not a credential

SPA_CHANGE = "/api/v1/auth/change-password/"
DJ_REST_AUTH_CHANGE = "/api/v1/auth/password/change/"


def _token_client(key):
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Token {key}")
    return client


def _authenticates(client):
    return client.get("/api/v1/auth/me/").status_code == status.HTTP_200_OK


class _PasswordChangeTokenCases:
    """Shared cases; subclasses name the route and its request body."""

    url = None

    def body(self):
        raise NotImplementedError

    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(
            username="changer", email="changer@example.com", password=CURRENT
        )
        self.old_key = Token.objects.create(user=self.user).key

    def test_session_caller_stays_signed_in_and_token_is_revoked(self):
        client = APIClient()
        client.force_login(self.user)

        r = client.post(self.url, self.body(), format="json")

        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertNotIn("key", r.data)
        self.assertFalse(Token.objects.filter(user=self.user).exists())
        self.assertFalse(_authenticates(_token_client(self.old_key)))
        self.assertTrue(_authenticates(client))

    def test_token_caller_gets_a_working_replacement(self):
        client = _token_client(self.old_key)

        r = client.post(self.url, self.body(), format="json")

        self.assertEqual(r.status_code, status.HTTP_200_OK)
        new_key = r.data["key"]
        self.assertNotEqual(new_key, self.old_key)
        self.assertEqual(Token.objects.get(user=self.user).key, new_key)
        self.assertFalse(_authenticates(client))
        self.assertFalse(_authenticates(_token_client(self.old_key)))
        self.assertTrue(_authenticates(_token_client(new_key)))
        self.assertIn("no-store", r["Cache-Control"])

    def test_pat_caller_gets_no_token(self):
        _, raw = PersonalAccessToken.generate(self.user, "cli")

        r = _token_client(raw).post(self.url, self.body(), format="json")

        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertNotIn("key", r.data)
        self.assertFalse(Token.objects.filter(user=self.user).exists())
        self.assertFalse(_authenticates(_token_client(raw)))

    def test_other_users_token_is_untouched(self):
        other = User.objects.create_user(username="bystander", password=CURRENT)
        other_key = Token.objects.create(user=other).key
        client = APIClient()
        client.force_login(self.user)

        client.post(self.url, self.body(), format="json")

        self.assertTrue(_authenticates(_token_client(other_key)))

    def test_failed_reissue_rolls_back_the_change(self):
        with mock.patch.object(
            credentials, "reissue_auth_token", side_effect=RuntimeError("boom")
        ):
            with self.assertRaises(RuntimeError):
                _token_client(self.old_key).post(self.url, self.body(), format="json")

        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(CURRENT))
        self.assertEqual(Token.objects.get(user=self.user).key, self.old_key)

    def test_wrong_current_password_keeps_the_token(self):
        client = _token_client(self.old_key)
        body = self.body()
        for field in ("current_password", "old_password"):
            if field in body:
                body[field] = "Wrong-Passw0rd!"  # gitleaks:allow -- test-only fixture password

        r = client.post(self.url, body, format="json")

        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertNotIn("key", r.data)
        self.assertTrue(_authenticates(client))


class ChangePasswordViewTokenTests(_PasswordChangeTokenCases, APITestCase):
    url = SPA_CHANGE

    def body(self):
        return {"current_password": CURRENT, "new_password": NEW}


class TokenRevokingPasswordChangeViewTokenTests(_PasswordChangeTokenCases, APITestCase):
    url = DJ_REST_AUTH_CHANGE

    def body(self):
        return {"old_password": CURRENT, "new_password1": NEW, "new_password2": NEW}


class ReissueAuthTokenTests(APITestCase):
    def test_replaces_an_existing_token(self):
        user = User.objects.create_user(username="direct", password=CURRENT)
        old = Token.objects.create(user=user).key

        new = credentials.reissue_auth_token(user)

        self.assertNotEqual(new, old)
        self.assertEqual(list(Token.objects.filter(user=user).values_list("key", flat=True)), [new])

    def test_creates_one_when_none_exists(self):
        user = User.objects.create_user(username="fresh", password=CURRENT)

        key = credentials.reissue_auth_token(user)

        self.assertEqual(Token.objects.get(user=user).key, key)
