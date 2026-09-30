"""#1221 — usernames and emails are cross-checked so one account can't switch off
another account's email login.

The login resolver (``accounts.backends.resolve_login_user``, #1206) lets an
exact username win over a case-insensitive email match, and fails closed on an
email shared by several active accounts. So a username equal to someone's
email, or a second active account holding the same email, disables that
person's email login. These tests pin the checks at every self-service and
admin write path, and the backward-compatibility rules around them:

- only a *change* is checked — accounts that already collide from before this
  check existed must keep saving the rest of their profile;
- your own row never counts (username == own email is common);
- only active accounts count on the email side, matching the resolver;
- the rejection says no more than the existing "taken" answers.
"""
from unittest.mock import patch

from allauth.account.models import EmailAddress
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.test import TestCase, override_settings
from rest_framework import status
from rest_framework.test import APIClient

from accounts.adapter import RegistrationAdapter
from accounts.backends import resolve_login_user
from accounts.models import User
from accounts.validators import (
    EMAIL_TAKEN_MESSAGE,
    USERNAME_TAKEN_MESSAGE,
    email_collides_with_identifier,
    username_collides_with_email,
)
from accounts.views import ChooseUsernameThrottle, UsernameChangeThrottle

PASSWORD = "correct-horse-battery-staple-1"  # gitleaks:allow -- test-only fixture password, not a credential
PROFILE_ENDPOINTS = ("/api/v1/auth/me/", "/api/v1/auth/user/")
REGISTER_URL = "/api/v1/auth/registration/"
LOGIN_URL = "/api/v1/auth/login/"
# allauth's own "username_taken" text (AbstractUser's unique-username message):
# the signup squat rejection must be indistinguishable from an ordinary clash.
SIGNUP_USERNAME_TAKEN = "A user with that username already exists."
SIGNUP_EMAIL_TAKEN = "User is already registered with this e-mail address."
# allauth's own "email_taken" text (RegistrationAdapter.clean_email, #1312):
# dj-rest-auth's RegisterSerializer.validate_email calls get_adapter().clean_email()
# BEFORE its own is_verified() duplicate check, so any collision that
# email_collides_with_identifier catches surfaces this message first —
# SIGNUP_EMAIL_TAKEN above is now unreachable for the #1221 collision cases.
ADAPTER_EMAIL_TAKEN = "A user is already registered with this email address."


class CollisionHelperTests(TestCase):
    def setUp(self):
        self.victim = User.objects.create_user(
            username="victim", email="Victim@Example.com", password=PASSWORD
        )
        self.inactive = User.objects.create_user(
            username="gone", email="gone@example.com", password=PASSWORD, is_active=False
        )

    def test_username_matches_active_email_ignoring_case_and_whitespace(self):
        self.assertTrue(username_collides_with_email("victim@example.com"))
        self.assertTrue(username_collides_with_email("  VICTIM@EXAMPLE.COM "))

    def test_username_ignores_inactive_own_and_blank(self):
        self.assertFalse(username_collides_with_email("gone@example.com"))
        self.assertFalse(username_collides_with_email("victim@example.com", exclude_pk=self.victim.pk))
        self.assertFalse(username_collides_with_email(""))
        self.assertFalse(username_collides_with_email("   "))

    def test_blank_emails_never_match(self):
        User.objects.create_user(username="noemail", email="", password=PASSWORD)
        self.assertFalse(username_collides_with_email(""))

    def test_email_matches_active_email_or_any_username(self):
        self.assertTrue(email_collides_with_identifier("victim@EXAMPLE.com"))
        # Usernames count whether or not the account is active: the resolver's
        # username rule doesn't look at is_active.
        self.assertTrue(email_collides_with_identifier("VICTIM"))
        self.assertTrue(email_collides_with_identifier("Gone"))

    def test_email_ignores_inactive_email_and_own_row(self):
        self.assertFalse(email_collides_with_identifier("gone@example.com"))
        self.assertFalse(email_collides_with_identifier("victim@example.com", exclude_pk=self.victim.pk))
        self.assertFalse(email_collides_with_identifier("victim", exclude_pk=self.victim.pk))
        self.assertFalse(email_collides_with_identifier(""))


class SignupCollisionTests(TestCase):
    def setUp(self):
        cache.clear()
        self.client = APIClient()
        self.victim = User.objects.create_user(
            username="victim", email="victim@example.com", password=PASSWORD
        )

    def _register(self, **fields):
        body = {"password1": "Sup3rS3cr3t!xyz", "password2": "Sup3rS3cr3t!xyz", **fields}
        return self.client.post(REGISTER_URL, body, format="json")

    def test_username_equal_to_active_email_is_rejected(self):
        r = self._register(username="  Victim@Example.COM ", email="squatter@example.com")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(r.json()["username"], [SIGNUP_USERNAME_TAKEN])
        self.assertNotIn("victim", r.content.decode().lower())
        self.assertFalse(User.objects.filter(email="squatter@example.com").exists())
        # The victim's email login still resolves to the victim.
        r = self.client.post(LOGIN_URL, {"username": "victim@example.com", "password": PASSWORD}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_username_equal_to_inactive_email_is_allowed(self):
        self.victim.is_active = False
        self.victim.save(update_fields=["is_active"])
        r = self._register(username="victim@example.com", email="new@example.com")
        self.assertIn(r.status_code, (status.HTTP_201_CREATED, status.HTTP_204_NO_CONTENT))

    def test_username_equal_to_own_signup_email_is_allowed(self):
        r = self._register(username="me@example.com", email="me@example.com")
        self.assertIn(r.status_code, (status.HTTP_201_CREATED, status.HTTP_204_NO_CONTENT))

    def test_email_equal_to_another_active_unverified_email_is_rejected(self):
        # dj-rest-auth alone only refuses a *verified* address; the victim's
        # address here has no verified EmailAddress row at all. Caught by
        # RegistrationAdapter.clean_email (#1312) before dj-rest-auth's own
        # is_verified() check ever runs.
        self.assertFalse(EmailAddress.objects.filter(email__iexact="victim@example.com").exists())
        r = self._register(email="VICTIM@example.com")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(r.json()["email"], [ADAPTER_EMAIL_TAKEN])
        self.assertEqual(User.objects.filter(email__iexact="victim@example.com").count(), 1)

    def test_email_equal_to_another_accounts_username_is_rejected(self):
        User.objects.create_user(username="owner@example.com", email="", password=PASSWORD)
        r = self._register(email="owner@example.com")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(r.json()["email"], [ADAPTER_EMAIL_TAKEN])

    def test_email_of_inactive_account_is_allowed(self):
        self.victim.is_active = False
        self.victim.save(update_fields=["is_active"])
        r = self._register(email="victim@example.com")
        self.assertIn(r.status_code, (status.HTTP_201_CREATED, status.HTTP_204_NO_CONTENT))


class AdapterCleanUsernameTests(TestCase):
    """The allauth hook every signup path (REST, allauth form, social) uses."""

    def setUp(self):
        User.objects.create_user(username="victim", email="victim@example.com", password=PASSWORD)
        self.adapter = RegistrationAdapter()

    def test_collision_raises(self):
        with self.assertRaises(ValidationError):
            self.adapter.clean_username("Victim@example.com")

    def test_shallow_skips_database_checks(self):
        # allauth's username generation calls shallow=True per candidate.
        self.assertEqual(self.adapter.clean_username("victim@example.com", shallow=True), "victim@example.com")

    def test_social_auto_signup_adjusts_instead_of_failing(self):
        # allauth's social auto-signup blanks a username clean_username rejects
        # and generates one; generated usernames never contain "@", so an
        # IdP-provisioned user still gets an account.
        from allauth.account.utils import user_username

        user = User(email="idp-user@example.com")
        user_username(user, "")
        self.adapter.populate_username(None, user)
        self.assertNotIn("@", user.username)
        self.assertFalse(username_collides_with_email(user.username))


class AdapterCleanEmailTests(TestCase):
    """The allauth hook the HTML signup form's own uniqueness check runs after (#1312).

    allauth's ``BaseSignupForm.clean_email`` calls ``get_adapter().clean_email()``
    before its own ``validate_unique_email`` — this is the one place every
    allauth-driven signup that collects an email goes through, including
    ``/accounts/signup/`` (allauth's HTML form), which dj-rest-auth's
    ``RegisterSerializer.validate_email`` (covered by ``SignupCollisionTests``
    above) never touches.
    """

    def setUp(self):
        User.objects.create_user(username="victim", email="victim@example.com", password=PASSWORD)
        self.adapter = RegistrationAdapter()

    def test_collision_with_another_accounts_username_raises(self):
        with self.assertRaises(ValidationError):
            self.adapter.clean_email("Victim")

    def test_collision_ignores_case_and_whitespace(self):
        with self.assertRaises(ValidationError):
            self.adapter.clean_email("  VICTIM  ")

    def test_non_colliding_email_passes_through(self):
        self.assertEqual(self.adapter.clean_email("newbie@example.com"), "newbie@example.com")

    def test_collision_with_another_accounts_active_email_also_raises(self):
        # clean_email has no notion of "the account being changed" (signup has
        # no existing account yet) — unlike username_collides_with_email's
        # exclude_pk, every match here is necessarily with someone else's
        # account. email_collides_with_identifier also catches an ordinary
        # duplicate active email, not just a username collision.
        with self.assertRaises(ValidationError):
            self.adapter.clean_email("victim@example.com")


class HtmlSignupEmailCollisionTests(TestCase):
    """`/accounts/signup/` is allauth's HTML form — a live, unauthenticated route
    that bypasses dj-rest-auth's ``RegisterSerializer`` entirely (#1312)."""

    def setUp(self):
        cache.clear()
        self.client = APIClient()
        # A username that is itself email-shaped, so an EmailField-valid
        # submission can equal it (mirrors SignupCollisionTests's REST-path
        # equivalent, test_email_equal_to_another_accounts_username_is_rejected).
        self.owner = User.objects.create_user(
            username="owner@example.com", email="", password=PASSWORD
        )

    def test_email_equal_to_another_accounts_username_is_rejected(self):
        r = self.client.post(
            "/accounts/signup/",
            {"email": "Owner@Example.com", "password1": "Sup3rS3cr3t!xyz", "password2": "Sup3rS3cr3t!xyz"},
        )
        # allauth re-renders the signup form (200) rather than redirecting on
        # a validation failure.
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIn(ADAPTER_EMAIL_TAKEN, r.content.decode())
        self.assertFalse(User.objects.filter(email__iexact="owner@example.com").exists())

    def test_non_colliding_signup_still_succeeds(self):
        r = self.client.post(
            "/accounts/signup/",
            {"email": "newbie@example.com", "password1": "Sup3rS3cr3t!xyz", "password2": "Sup3rS3cr3t!xyz"},
        )
        self.assertEqual(r.status_code, status.HTTP_302_FOUND)
        self.assertTrue(User.objects.filter(email="newbie@example.com").exists())


class ProfileCollisionTests(TestCase):
    def setUp(self):
        cache.clear()
        self.victim = User.objects.create_user(
            username="victim", email="victim@example.com", password=PASSWORD
        )
        self.user = User.objects.create_user(
            username="mallory", email="mallory@example.com", password=PASSWORD
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_username_change_to_active_email_is_rejected(self):
        for url in PROFILE_ENDPOINTS:
            with self.subTest(url=url):
                r = self.client.patch(url, {"username": "VICTIM@example.com"}, format="json")
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertEqual(r.json()["username"], [USERNAME_TAKEN_MESSAGE])
                self.user.refresh_from_db()
                self.assertEqual(self.user.username, "mallory")

    def test_choose_username_rejects_active_email(self):
        r = self.client.post("/api/v1/auth/choose-username/", {"username": "victim@example.com"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(r.json()["detail"], USERNAME_TAKEN_MESSAGE)

    def test_username_change_to_inactive_email_is_allowed(self):
        self.victim.is_active = False
        self.victim.save(update_fields=["is_active"])
        r = self.client.patch("/api/v1/auth/me/", {"username": "victim@example.com"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_username_equal_to_own_email_is_allowed(self):
        r = self.client.patch("/api/v1/auth/me/", {"username": "Mallory@example.com"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        r = self.client.post("/api/v1/auth/choose-username/", {"username": "mallory@example.com"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_email_change_to_another_active_email_is_rejected(self):
        for url in PROFILE_ENDPOINTS:
            with self.subTest(url=url):
                r = self.client.patch(url, {"email": " Victim@Example.com "}, format="json")
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertEqual(r.json()["email"], [EMAIL_TAKEN_MESSAGE])
                self.user.refresh_from_db()
                self.assertEqual(self.user.email, "mallory@example.com")

    def test_email_change_to_another_accounts_username_is_rejected(self):
        User.objects.create_user(username="owner@example.com", email="", password=PASSWORD)
        r = self.client.patch("/api/v1/auth/me/", {"email": "OWNER@example.com"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(r.json()["email"], [EMAIL_TAKEN_MESSAGE])

    def test_email_change_to_inactive_accounts_email_is_allowed(self):
        self.victim.is_active = False
        self.victim.save(update_fields=["is_active"])
        r = self.client.patch("/api/v1/auth/me/", {"email": "victim@example.com"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, "victim@example.com")

    def test_email_equal_to_own_username_is_allowed(self):
        self.user.username = "mallory@example.org"
        self.user.save(update_fields=["username"])
        r = self.client.patch("/api/v1/auth/me/", {"email": "Mallory@example.org"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_rejection_does_not_name_the_other_account(self):
        r = self.client.patch("/api/v1/auth/me/", {"email": "victim@example.com"}, format="json")
        body = r.content.decode().lower()
        self.assertNotIn("victim", body.replace("victim@example.com", ""))
        self.assertNotIn("username", r.json()["email"][0].lower())

    @override_settings(ACCOUNT_EMAIL_VERIFICATION="mandatory")
    def test_mandatory_verification_defers_to_proof_of_ownership(self):
        # Under mandatory the address only reaches User.email once confirmed
        # from its mailbox, so a colliding request can't disable anyone's
        # email login — and #1293 deliberately answers it exactly like any
        # other change request, giving the requester no "taken" signal.
        r = self.client.patch("/api/v1/auth/me/", {"email": "victim@example.com"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json()["email"], "mallory@example.com")
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, "mallory@example.com")
        # The victim's email still resolves to the victim.
        self.assertEqual(resolve_login_user("victim@example.com"), self.victim)


class PreExistingCollisionTests(TestCase):
    """Data that already collides (written before #1221) must not start failing."""

    def setUp(self):
        cache.clear()
        User.objects.create_user(username="victim", email="victim@example.com", password=PASSWORD)
        # Written straight to the DB, bypassing the new checks, as an upgraded
        # install's rows would be: a username equal to another account's email
        # AND an email shared with another active account.
        self.user = User.objects.create_user(
            username="victim@example.com", email="victim@example.com", password=PASSWORD
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_unrelated_field_patch_succeeds(self):
        for url in PROFILE_ENDPOINTS:
            with self.subTest(url=url):
                r = self.client.patch(url, {"display_name": "Still Me"}, format="json")
                self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_round_trip_with_unchanged_values_succeeds(self):
        r = self.client.patch(
            "/api/v1/auth/me/",
            {"username": "victim@example.com", "email": "VICTIM@example.com", "first_name": "V"},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.user.refresh_from_db()
        self.assertEqual(self.user.first_name, "V")

    def test_full_put_round_trip_succeeds(self):
        current = self.client.get("/api/v1/auth/user/").json()
        writable = {k: current[k] for k in ("username", "email", "first_name", "last_name", "display_name")}
        r = self.client.put("/api/v1/auth/user/", writable, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_moving_off_the_collision_is_allowed(self):
        r = self.client.patch(
            "/api/v1/auth/me/", {"username": "fresh-name", "email": "fresh@example.com"}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)


class EmailChangeThrottleTests(TestCase):
    """An email change is a probe of the same kind as a rename, so it shares the budget."""

    RATES = {"choose_username": "2/min"}

    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(username="dave", email="dave@example.com", password=PASSWORD)
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        for cls in (UsernameChangeThrottle, ChooseUsernameThrottle):
            patcher = patch.object(cls, "THROTTLE_RATES", self.RATES)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_email_changes_are_throttled(self):
        codes = [
            self.client.patch("/api/v1/auth/me/", {"email": f"d{i}@example.com"}, format="json").status_code
            for i in range(3)
        ]
        self.assertEqual(codes, [200, 200, status.HTTP_429_TOO_MANY_REQUESTS])

    def test_unchanged_email_is_not_counted(self):
        for _ in range(4):
            r = self.client.patch(
                "/api/v1/auth/me/", {"email": "DAVE@example.com", "first_name": "D"}, format="json"
            )
            self.assertEqual(r.status_code, status.HTTP_200_OK)


class AdminCreateCollisionTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="adminpass123!")
        self.admin.is_site_admin = True
        self.admin.save(update_fields=["is_site_admin"])
        User.objects.create_user(username="victim", email="victim@example.com", password=PASSWORD)
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def _create(self, username, email):
        return self.client.post(
            "/api/v1/admin/users/",
            {"username": username, "email": email, "password": "SecurePass123!x"},
            format="json",
        )

    def test_username_equal_to_active_email_is_rejected(self):
        r = self._create("Victim@example.com", "new@example.com")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("username", r.json())

    def test_email_equal_to_username_or_email_case_insensitively_is_rejected(self):
        r = self._create("newbie", "VICTIM@example.com")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("email", r.json())
        User.objects.create_user(username="owner@example.com", password=PASSWORD)
        r = self._create("newbie", "owner@example.com")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("email", r.json())

    def test_non_colliding_create_still_works(self):
        r = self._create("newbie", "newbie@example.com")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)


@override_settings(ACCOUNT_EMAIL_VERIFICATION="mandatory")
class MandatoryConfirmationCollisionTests(TestCase):
    """The request-time check is skipped under mandatory, so confirmation must run it.

    Proving ownership of the mailbox rules out a takeover, not an active
    duplicate: another account can hold the same address *unverified*, which
    allauth's ``can_set_verified`` doesn't see. Promoting it would leave two
    active accounts sharing the address and switch off email login for both.
    """

    VERIFY_EMAIL_URL = "/api/v1/auth/registration/verify-email/"

    def setUp(self):
        cache.clear()
        # Account A: address on User.email, never verified (admin-created,
        # SSO-provisioned, or signed up under `optional`).
        self.holder = User.objects.create_user(
            username="holder", email="shared@co.example", password=PASSWORD
        )
        self.user = User.objects.create_user(username="erin", email="erin@old.example", password=PASSWORD)
        EmailAddress.objects.create(user=self.user, email="erin@old.example", verified=True, primary=True)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _request_change(self, new):
        r = self.client.patch("/api/v1/auth/me/", {"email": new}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json()["pending_email"], new)
        return EmailAddress.objects.get(user=self.user, email=new)

    def _confirm(self, address):
        from allauth.account.models import EmailConfirmationHMAC

        return APIClient().post(
            self.VERIFY_EMAIL_URL, {"key": EmailConfirmationHMAC(address).key}, format="json"
        )

    def test_unverified_duplicate_on_another_account_blocks_promotion(self):
        pending = self._request_change("shared@co.example")
        r = self._confirm(pending)
        self.assertEqual(r.status_code, status.HTTP_409_CONFLICT)
        self.assertEqual(r.json()["code"], "email_in_use")
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, "erin@old.example")
        pending.refresh_from_db()
        self.assertFalse(pending.verified)
        # Account A's email login still works.
        self.assertEqual(resolve_login_user("shared@co.example"), self.holder)

    def test_another_accounts_username_blocks_promotion(self):
        User.objects.create_user(username="owner@co.example", password=PASSWORD)
        pending = self._request_change("owner@co.example")
        self.assertEqual(self._confirm(pending).status_code, status.HTTP_409_CONFLICT)
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, "erin@old.example")

    def test_inactive_holder_does_not_block(self):
        self.holder.is_active = False
        self.holder.save(update_fields=["is_active"])
        pending = self._request_change("shared@co.example")
        self.assertEqual(self._confirm(pending).status_code, status.HTTP_200_OK)
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, "shared@co.example")

    def test_non_colliding_change_still_confirms(self):
        pending = self._request_change("erin@new.example")
        self.assertEqual(self._confirm(pending).status_code, status.HTTP_200_OK)
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, "erin@new.example")

    def test_receiver_refuses_promotion_even_without_the_view_guard(self):
        # Defense in depth: a confirmation that reaches the email_confirmed
        # receiver by another route must still not write User.email.
        from accounts.email_change import apply_confirmed_email_change

        pending = self._request_change("shared@co.example")
        pending.verified = True
        pending.save(update_fields=["verified"])
        apply_confirmed_email_change(sender=None, request=None, email_address=pending)
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, "erin@old.example")
        self.assertEqual(self.user.pending_email_address_id, pending.pk)
