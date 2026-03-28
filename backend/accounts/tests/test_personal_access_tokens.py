"""Tests for Personal Access Tokens (PATs) — issue #335."""
from datetime import timedelta

from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient, APITestCase

from accounts.models import PAT_MAX_PER_USER, PersonalAccessToken, User


def make_user(username="alice", password="pass123secure!"):
    return User.objects.create_user(username=username, password=password)


class PATListCreateTests(APITestCase):
    def setUp(self):
        self.user = make_user()
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.url = "/api/auth/tokens/"

    # ── List ──────────────────────────────────────────────────────────────────

    def test_list_empty(self):
        r = self.client.get(self.url)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json(), [])

    def test_list_returns_own_tokens_only(self):
        other = make_user("bob")
        PersonalAccessToken.generate(other, "other-token")
        pat, _ = PersonalAccessToken.generate(self.user, "my-token")
        r = self.client.get(self.url)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        ids = [t["id"] for t in r.json()]
        self.assertIn(pat.id, ids)
        self.assertEqual(len(ids), 1)

    def test_list_never_includes_raw_token(self):
        PersonalAccessToken.generate(self.user, "ci-token")
        r = self.client.get(self.url)
        for token in r.json():
            self.assertNotIn("token", token)

    def test_list_includes_expected_fields(self):
        PersonalAccessToken.generate(self.user, "ci-token")
        r = self.client.get(self.url)
        token = r.json()[0]
        for field in ["id", "name", "prefix", "created_at", "last_used_at", "expires_at"]:
            self.assertIn(field, token)

    # ── Create ────────────────────────────────────────────────────────────────

    def test_create_returns_token_once(self):
        r = self.client.post(self.url, {"name": "ci"})
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        data = r.json()
        self.assertIn("token", data)
        raw = data["token"]
        self.assertTrue(raw.startswith("vbn_"))
        self.assertEqual(len(raw), 44)  # "vbn_" + 40 hex chars

    def test_create_token_not_in_subsequent_list(self):
        r = self.client.post(self.url, {"name": "ci"})
        token_id = r.json()["id"]
        r2 = self.client.get(self.url)
        listed = next(t for t in r2.json() if t["id"] == token_id)
        self.assertNotIn("token", listed)

    def test_create_missing_name_returns_400(self):
        r = self.client.post(self.url, {})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_create_empty_name_returns_400(self):
        r = self.client.post(self.url, {"name": "   "})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_create_name_too_long_returns_400(self):
        r = self.client.post(self.url, {"name": "x" * 65})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_create_with_valid_expiry(self):
        expires = (timezone.now() + timedelta(days=30)).isoformat()
        r = self.client.post(self.url, {"name": "expiring", "expires_at": expires})
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertIsNotNone(r.json()["expires_at"])

    def test_create_expiry_over_one_year_returns_400(self):
        expires = (timezone.now() + timedelta(days=366)).isoformat()
        r = self.client.post(self.url, {"name": "too-long", "expires_at": expires})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_create_expiry_in_past_returns_400(self):
        expires = (timezone.now() - timedelta(days=1)).isoformat()
        r = self.client.post(self.url, {"name": "past", "expires_at": expires})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_create_enforces_max_per_user(self):
        for i in range(PAT_MAX_PER_USER):
            PersonalAccessToken.generate(self.user, f"token-{i}")
        r = self.client.post(self.url, {"name": "one-too-many"})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_create_requires_authentication(self):
        self.client.logout()
        r = self.client.post(self.url, {"name": "ci"})
        # PATAuthentication is first and returns authenticate_header="Token", so
        # DRF correctly emits 401 (not 403) for unauthenticated requests.
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_list_requires_authentication(self):
        """Explicit permission_classes on the view must reject unauthenticated GET (#376)."""
        anon = APIClient()
        r = anon.get(self.url)
        self.assertIn(r.status_code, [status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN])


class PATDeleteTests(APITestCase):
    def setUp(self):
        self.user = make_user()
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_revoke_own_token(self):
        pat, _ = PersonalAccessToken.generate(self.user, "ci")
        r = self.client.delete(f"/api/auth/tokens/{pat.id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(PersonalAccessToken.objects.filter(pk=pat.id).exists())

    def test_revoke_other_users_token_returns_404(self):
        """IDOR check: must return 404, not 403, to avoid confirming existence."""
        other = make_user("bob")
        other_pat, _ = PersonalAccessToken.generate(other, "bob-token")
        r = self.client.delete(f"/api/auth/tokens/{other_pat.id}/")
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)
        self.assertTrue(PersonalAccessToken.objects.filter(pk=other_pat.id).exists())

    def test_revoke_nonexistent_returns_404(self):
        r = self.client.delete("/api/auth/tokens/99999/")
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)

    def test_delete_requires_authentication(self):
        """Explicit permission_classes on the view must reject unauthenticated DELETE (#376)."""
        pat, _ = PersonalAccessToken.generate(self.user, "ci")
        anon = APIClient()
        r = anon.delete(f"/api/auth/tokens/{pat.id}/")
        self.assertIn(r.status_code, [status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN])
        self.assertTrue(PersonalAccessToken.objects.filter(pk=pat.id).exists())


class PATAuthenticationTests(APITestCase):
    def setUp(self):
        self.user = make_user()
        self.client = APIClient()

    def _auth_header(self, raw_token):
        return {"HTTP_AUTHORIZATION": f"Token {raw_token}"}

    def test_valid_pat_authenticates(self):
        _, raw = PersonalAccessToken.generate(self.user, "ci")
        r = self.client.get("/api/auth/me/", **self._auth_header(raw))
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json()["id"], self.user.id)

    def test_revoked_pat_returns_401(self):
        pat, raw = PersonalAccessToken.generate(self.user, "ci")
        pat.delete()
        r = self.client.get("/api/auth/me/", **self._auth_header(raw))
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_expired_pat_returns_401(self):
        pat, raw = PersonalAccessToken.generate(
            self.user, "ci", expires_at=timezone.now() - timedelta(seconds=1)
        )
        r = self.client.get("/api/auth/me/", **self._auth_header(raw))
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_invalid_token_returns_401(self):
        r = self.client.get("/api/auth/me/", **self._auth_header("vbn_notarealtoken"))
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_non_pat_token_falls_through(self):
        """Non-vbn_ tokens must not be rejected by PATAuthentication."""
        r = self.client.get("/api/auth/me/", **self._auth_header("someothertoken123"))
        # Falls through to other authenticators; unauthenticated = 403 (not 401 which
        # would be PATAuthentication raising AuthenticationFailed directly).
        self.assertIn(r.status_code, [status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN])

    def test_successful_auth_updates_last_used_at(self):
        pat, raw = PersonalAccessToken.generate(self.user, "ci")
        self.assertIsNone(pat.last_used_at)
        r = self.client.get("/api/auth/me/", **self._auth_header(raw))
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        pat.refresh_from_db()
        self.assertIsNotNone(pat.last_used_at)


class PATPasswordResetRevocationTests(APITestCase):
    def setUp(self):
        self.user = make_user(password="OldPassword123!")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_password_change_revokes_all_tokens(self):
        PersonalAccessToken.generate(self.user, "ci-1")
        PersonalAccessToken.generate(self.user, "ci-2")
        self.assertEqual(self.user.personal_access_tokens.count(), 2)
        r = self.client.post("/api/auth/change-password/", {
            "current_password": "OldPassword123!",
            "new_password": "NewPassword456!",
        })
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(self.user.personal_access_tokens.count(), 0)

    def test_revoked_token_cannot_authenticate_after_password_change(self):
        _, raw = PersonalAccessToken.generate(self.user, "ci")
        self.client.post("/api/auth/change-password/", {
            "current_password": "OldPassword123!",
            "new_password": "NewPassword456!",
        })
        unauthenticated = APIClient()
        r = unauthenticated.get("/api/auth/me/", HTTP_AUTHORIZATION=f"Token {raw}")
        self.assertIn(r.status_code, [status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN])
