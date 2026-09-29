"""Password-change parity and the uniform 12-character policy (#1257, #1258, #1259).

Two endpoints change a password: Visiban's own POST /api/v1/auth/change-password/
(ChangePasswordView) and dj-rest-auth's POST /api/v1/auth/password/change/
(TokenRevokingPasswordChangeView). The second used to skip the current-password
check (#1257), accept 8-character passwords (#1258), and leave
must_change_password set (#1259). These tests pin both endpoints to the same
rules, and pin the 12-character minimum on every other password-set path that
runs AUTH_PASSWORD_VALIDATORS.
"""

from django.conf import settings
from django.contrib.auth import password_validation
from django.core.exceptions import ValidationError
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient, APITestCase

from accounts.models import InviteLink, PersonalAccessToken, User
from accounts.tests.test_invite_links import make_admin, set_invite_only, set_open

CURRENT = "Current-Passw0rd!"  # gitleaks:allow -- test-only fixture password, not a credential
ELEVEN = "Kx7#mQ2vLp9"  # gitleaks:allow -- test-only fixture password, not a credential
TWELVE = "Kx7#mQ2vLp9w"  # gitleaks:allow -- test-only fixture password, not a credential

DJ_URL = "/api/v1/auth/password/change/"
VB_URL = "/api/v1/auth/change-password/"


def _dj_body(new, old=None):
    body = {"new_password1": new, "new_password2": new}
    if old is not None:
        body["old_password"] = old
    return body


class PolicySourceOfTruthTests(TestCase):
    """PASSWORD_MIN_LENGTH is the one number; the validator chain reads it."""

    def test_min_length_is_twelve(self):
        self.assertEqual(settings.PASSWORD_MIN_LENGTH, 12)

    def test_validator_chain_rejects_eleven_and_accepts_twelve(self):
        # This is what the Django admin set-password form, createsuperuser,
        # allauth's clean_password and SetPasswordForm all call.
        with self.assertRaises(ValidationError):
            password_validation.validate_password(ELEVEN)
        password_validation.validate_password(TWELVE)

    def test_existing_short_password_still_logs_in(self):
        """Validators run only on set — a pre-#1258 8-char account is not locked out."""
        User.objects.create_user(username="legacy", password="Sh0rt!pw")
        r = APIClient().post(
            "/api/v1/auth/login/", {"username": "legacy", "password": "Sh0rt!pw"}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)


class DjRestAuthPasswordChangeOldPasswordTests(APITestCase):
    """#1257: /auth/password/change/ must verify the current password."""

    def setUp(self):
        self.user = User.objects.create_user(username="pwchange", password=CURRENT)
        self.client.force_authenticate(self.user)

    def test_missing_old_password_is_rejected(self):
        r = self.client.post(DJ_URL, _dj_body(TWELVE))
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("old_password", r.json())
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(CURRENT))

    def test_bogus_old_password_is_rejected(self):
        r = self.client.post(DJ_URL, _dj_body(TWELVE, old="not-the-password"))
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("old_password", r.json())
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(CURRENT))

    def test_correct_old_password_succeeds(self):
        r = self.client.post(DJ_URL, _dj_body(TWELVE, old=CURRENT))
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(TWELVE))

    def test_enforced_even_if_the_rest_auth_flag_is_turned_off(self):
        """The serializer forces the check; a REST_AUTH edit cannot reopen #1257."""
        rest_auth = {**settings.REST_AUTH, "OLD_PASSWORD_FIELD_ENABLED": False}
        with self.settings(REST_AUTH=rest_auth):
            r = self.client.post(DJ_URL, _dj_body(TWELVE, old="not-the-password"))
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_social_only_account_may_set_first_password_without_old(self):
        """Matches ChangePasswordView: no usable password means nothing to prove."""
        social = User.objects.create_user(username="socialonly")
        social.set_unusable_password()
        social.save()
        self.client.force_authenticate(social)
        r = self.client.post(DJ_URL, _dj_body(TWELVE))
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        social.refresh_from_db()
        self.assertTrue(social.check_password(TWELVE))


class OldPasswordRequiredForEveryAuthMethodTests(APITestCase):
    """The check must hold for PAT and session callers alike."""

    def setUp(self):
        self.user = User.objects.create_user(username="authmethods", password=CURRENT)

    def _pat_client(self):
        _, raw = PersonalAccessToken.generate(self.user, "cli")
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION=f"Token {raw}")
        return client

    def test_pat_caller_without_old_password_is_rejected(self):
        r = self._pat_client().post(DJ_URL, _dj_body(TWELVE))
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(CURRENT))

    def test_pat_caller_with_wrong_old_password_is_rejected(self):
        r = self._pat_client().post(DJ_URL, _dj_body(TWELVE, old="wrong-password-x"))
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_pat_caller_with_correct_old_password_succeeds(self):
        r = self._pat_client().post(DJ_URL, _dj_body(TWELVE, old=CURRENT))
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_session_caller_without_old_password_is_rejected(self):
        client = APIClient()
        self.assertTrue(client.login(username="authmethods", password=CURRENT))
        r = client.post(DJ_URL, _dj_body(TWELVE))
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_session_caller_with_correct_old_password_succeeds_and_stays_logged_in(self):
        client = APIClient()
        self.assertTrue(client.login(username="authmethods", password=CURRENT))
        r = client.post(DJ_URL, _dj_body(TWELVE, old=CURRENT))
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(client.get("/api/v1/auth/user/").status_code, status.HTTP_200_OK)


class MinimumLengthOnBothChangeEndpointsTests(APITestCase):
    """#1258: 11 characters rejected, 12 accepted, on both change endpoints."""

    def setUp(self):
        self.user = User.objects.create_user(username="lenuser", password=CURRENT)
        self.client.force_authenticate(self.user)

    def test_dj_rest_auth_rejects_eleven(self):
        r = self.client.post(DJ_URL, _dj_body(ELEVEN, old=CURRENT))
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("new_password2", r.json())

    def test_dj_rest_auth_accepts_twelve(self):
        r = self.client.post(DJ_URL, _dj_body(TWELVE, old=CURRENT))
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_change_password_rejects_eleven_with_unchanged_error_shape(self):
        r = self.client.post(VB_URL, {"current_password": CURRENT, "new_password": ELEVEN})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(r.json(), {"detail": "New password must be at least 12 characters."})

    def test_change_password_accepts_twelve(self):
        r = self.client.post(VB_URL, {"current_password": CURRENT, "new_password": TWELVE})
        self.assertEqual(r.status_code, status.HTTP_200_OK)


class MinimumLengthOnOtherSetPathsTests(TestCase):
    """#1258 asked for registration and admin-set paths to be checked too."""

    def setUp(self):
        self.client = APIClient()

    def tearDown(self):
        set_open()

    def _register(self, email, password, **extra):
        return self.client.post("/api/v1/auth/registration/", {
            "email": email, "password1": password, "password2": password, **extra,
        })

    def test_open_registration_rejects_eleven(self):
        set_open()
        r = self._register("short@example.com", ELEVEN)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(User.objects.filter(email="short@example.com").exists())

    def test_open_registration_accepts_twelve(self):
        set_open()
        r = self._register("long@example.com", TWELVE)
        self.assertIn(r.status_code, [status.HTTP_201_CREATED, status.HTTP_204_NO_CONTENT])
        self.assertTrue(User.objects.filter(email="long@example.com").exists())

    def test_invite_accept_rejects_eleven_and_accepts_twelve(self):
        set_invite_only()
        admin = make_admin(username="policy_admin")
        _, raw = InviteLink.generate(created_by=admin, single_use=False)
        r = self._register("inv-short@example.com", ELEVEN, invite_token=raw)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        r = self._register("inv-long@example.com", TWELVE, invite_token=raw)
        self.assertIn(r.status_code, [status.HTTP_201_CREATED, status.HTTP_204_NO_CONTENT])

    def test_admin_create_user_rejects_eleven_and_accepts_twelve(self):
        admin = make_admin(username="policy_admin2")
        self.client.force_authenticate(admin)
        r = self.client.post("/api/v1/admin/users/", {
            "username": "adminmade1", "email": "am1@example.com", "password": ELEVEN,
        })
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        r = self.client.post("/api/v1/admin/users/", {
            "username": "adminmade2", "email": "am2@example.com", "password": TWELVE,
        })
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)


class FinalizePasswordChangeOnBothEndpointsTests(APITestCase):
    """#1259: both endpoints clear must_change_password and revoke PATs."""

    def setUp(self):
        self.user = User.objects.create_user(username="forced", password=CURRENT)
        self.user.must_change_password = True
        self.user.save(update_fields=["must_change_password"])
        PersonalAccessToken.generate(self.user, "a")
        PersonalAccessToken.generate(self.user, "b")
        self.client.force_authenticate(self.user)

    def _assert_finalized(self):
        self.user.refresh_from_db()
        self.assertFalse(self.user.must_change_password)
        self.assertEqual(self.user.personal_access_tokens.count(), 0)

    def test_dj_rest_auth_endpoint_clears_flag_and_revokes_tokens(self):
        r = self.client.post(DJ_URL, _dj_body(TWELVE, old=CURRENT))
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self._assert_finalized()

    def test_change_password_endpoint_clears_flag_and_revokes_tokens(self):
        r = self.client.post(VB_URL, {"current_password": CURRENT, "new_password": TWELVE})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self._assert_finalized()

    def test_forced_user_is_unblocked_after_dj_rest_auth_change(self):
        """The actual #1259 symptom: the user stayed locked out of everything else."""
        self.assertEqual(
            self.client.get("/api/v1/boards/").status_code, status.HTTP_403_FORBIDDEN
        )
        self.client.post(DJ_URL, _dj_body(TWELVE, old=CURRENT))
        self.user.refresh_from_db()
        self.client.force_authenticate(self.user)
        self.assertEqual(self.client.get("/api/v1/boards/").status_code, status.HTTP_200_OK)

    def test_rejected_change_leaves_flag_and_tokens_alone(self):
        r = self.client.post(DJ_URL, _dj_body(TWELVE, old="wrong-password-x"))
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.user.refresh_from_db()
        self.assertTrue(self.user.must_change_password)
        self.assertEqual(self.user.personal_access_tokens.count(), 2)

    def test_both_views_share_one_helper(self):
        """Guard against a third copy of the post-success logic (#1259)."""
        import inspect

        from accounts import views

        for view in (views.ChangePasswordView, views.TokenRevokingPasswordChangeView):
            src = inspect.getsource(view.post)
            self.assertIn("finalize_password_change(", src)
            self.assertNotIn("personal_access_tokens", src)
