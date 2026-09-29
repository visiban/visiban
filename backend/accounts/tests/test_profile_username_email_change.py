"""Profile PATCH enforces the username and email rules (#1273).

``username`` and ``email`` stay writable on PATCH /api/v1/auth/me/ and
dj-rest-auth's /api/v1/auth/user/ (1.0 API contract), but a write through
either must obey the same rules as the dedicated flows:

- username: case-insensitive uniqueness and the choose-username rate limit,
  exactly like POST /auth/choose-username/.
- email: under EMAIL_VERIFICATION=mandatory a changed address only takes
  effect once confirmed from that mailbox.
"""

from unittest.mock import patch

from allauth.account.models import EmailAddress, EmailConfirmationHMAC
from django.core import mail
from django.core.cache import cache
from django.test import TestCase, override_settings
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from accounts.views import ChooseUsernameThrottle, UsernameChangeThrottle

PROFILE_ENDPOINTS = ("/api/v1/auth/me/", "/api/v1/auth/user/")
VERIFY_EMAIL_URL = "/api/v1/auth/registration/verify-email/"


class ProfileUsernameUniquenessTests(TestCase):
    def setUp(self):
        cache.clear()
        User.objects.create_user(username="bob", password="pass12345678")
        self.user = User.objects.create_user(username="alice", password="pass12345678")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_case_variant_of_existing_username_is_rejected(self):
        for url in PROFILE_ENDPOINTS:
            with self.subTest(url=url):
                r = self.client.patch(url, {"username": "Bob"}, format="json")
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertEqual(r.json()["username"], ["That username is already taken."])
                self.user.refresh_from_db()
                self.assertEqual(self.user.username, "alice")

    def test_recasing_own_username_is_allowed(self):
        r = self.client.patch("/api/v1/auth/me/", {"username": "Alice"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.user.refresh_from_db()
        self.assertEqual(self.user.username, "Alice")

    def test_unique_username_is_accepted(self):
        r = self.client.patch("/api/v1/auth/me/", {"username": "carol"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json()["username"], "carol")

    def test_db_constraint_race_is_a_clean_400(self):
        # Simulate a concurrent rename landing between validate_username and
        # the save: the check passes, the unique_username_ci index rejects it.
        with patch("accounts.serializers.is_username_taken", return_value=False):
            r = self.client.patch("/api/v1/auth/me/", {"username": "BOB"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("username", r.json())
        self.user.refresh_from_db()
        self.assertEqual(self.user.username, "alice")

    def test_rename_clears_must_change_username(self):
        self.user.must_change_username = True
        self.user.save(update_fields=["must_change_username"])
        r = self.client.patch("/api/v1/auth/me/", {"username": "alice2"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertFalse(r.json()["must_change_username"])
        self.user.refresh_from_db()
        self.assertFalse(self.user.must_change_username)

    def test_unchanged_username_keeps_must_change_username(self):
        self.user.must_change_username = True
        self.user.save(update_fields=["must_change_username"])
        r = self.client.patch(
            "/api/v1/auth/me/", {"username": "alice", "first_name": "A"}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.user.refresh_from_db()
        self.assertTrue(self.user.must_change_username)


class ProfileUsernameThrottleTests(TestCase):
    """PATCHes that rename share the choose-username bucket; others don't touch it."""

    RATES = {"choose_username": "2/min"}

    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(username="dave", password="pass12345678")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        for cls in (UsernameChangeThrottle, ChooseUsernameThrottle):
            patcher = patch.object(cls, "THROTTLE_RATES", self.RATES)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_rename_patches_are_throttled(self):
        for n, url in enumerate(PROFILE_ENDPOINTS):
            with self.subTest(url=url):
                cache.clear()
                codes = [
                    self.client.patch(url, {"username": f"dave{n}x{i}"}, format="json").status_code
                    for i in range(3)
                ]
                self.assertEqual(codes[:2], [200, 200])
                self.assertEqual(codes[2], status.HTTP_429_TOO_MANY_REQUESTS)

    def test_unchanged_username_is_not_counted(self):
        # The SPA profile form re-sends the current username on every save.
        for _ in range(5):
            r = self.client.patch(
                "/api/v1/auth/me/", {"username": "dave", "first_name": "D"}, format="json"
            )
            self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_bucket_is_shared_with_choose_username(self):
        self.assertEqual(
            self.client.patch("/api/v1/auth/me/", {"username": "d1"}, format="json").status_code, 200
        )
        self.assertEqual(
            self.client.post("/api/v1/auth/choose-username/", {"username": "d2"}, format="json").status_code,
            200,
        )
        r = self.client.patch("/api/v1/auth/user/", {"username": "d3"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_429_TOO_MANY_REQUESTS)


@override_settings(ACCOUNT_EMAIL_VERIFICATION="mandatory")
class MandatoryEmailChangeTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(
            username="erin", email="erin@old.example", password="pass12345678"
        )
        self.old_address = EmailAddress.objects.create(
            user=self.user, email="erin@old.example", verified=True, primary=True
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _confirm(self, address):
        anon = APIClient()
        return anon.post(VERIFY_EMAIL_URL, {"key": EmailConfirmationHMAC(address).key}, format="json")

    def test_changed_email_is_pending_not_applied(self):
        for n, url in enumerate(PROFILE_ENDPOINTS):
            with self.subTest(url=url):
                mail.outbox.clear()
                new = f"erin{n}@new.example"
                r = self.client.patch(url, {"email": new}, format="json")
                self.assertEqual(r.status_code, status.HTTP_200_OK)
                body = r.json()
                self.assertEqual(body["email"], "erin@old.example")
                self.assertEqual(body["pending_email"], new)
                self.user.refresh_from_db()
                self.assertEqual(self.user.email, "erin@old.example")
                pending = EmailAddress.objects.get(user=self.user, email=new)
                self.assertFalse(pending.verified)
                self.assertFalse(pending.primary)
                self.assertEqual(len(mail.outbox), 1)
                self.assertEqual(mail.outbox[0].to, [new])

    def test_get_reports_pending_email(self):
        self.client.patch("/api/v1/auth/me/", {"email": "erin@new.example"}, format="json")
        r = self.client.get("/api/v1/auth/me/")
        self.assertEqual(r.json()["pending_email"], "erin@new.example")
        self.assertEqual(r.json()["email"], "erin@old.example")

    def test_confirmation_switches_email_and_drops_old_address(self):
        self.client.patch("/api/v1/auth/me/", {"email": "erin@new.example"}, format="json")
        pending = EmailAddress.objects.get(user=self.user, email="erin@new.example")
        r = self._confirm(pending)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, "erin@new.example")
        pending.refresh_from_db()
        self.assertTrue(pending.verified)
        self.assertTrue(pending.primary)
        self.assertFalse(EmailAddress.objects.filter(pk=self.old_address.pk).exists())
        self.assertIsNone(self.client.get("/api/v1/auth/me/").json()["pending_email"])

    def test_confirmation_works_for_account_without_address_rows(self):
        # e.g. an admin-created account: User.email set, no EmailAddress rows.
        self.old_address.delete()
        self.client.patch("/api/v1/auth/me/", {"email": "erin@new.example"}, format="json")
        pending = EmailAddress.objects.get(user=self.user, email="erin@new.example")
        self.assertEqual(self._confirm(pending).status_code, status.HTTP_200_OK)
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, "erin@new.example")

    def test_new_request_replaces_earlier_pending_change(self):
        self.client.patch("/api/v1/auth/me/", {"email": "erin@first.example"}, format="json")
        first = EmailAddress.objects.get(user=self.user, email="erin@first.example")
        self.client.patch("/api/v1/auth/me/", {"email": "erin@second.example"}, format="json")
        self.assertFalse(EmailAddress.objects.filter(pk=first.pk).exists())
        # The first link no longer does anything.
        self.assertNotEqual(self._confirm(first).status_code, status.HTTP_200_OK)
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, "erin@old.example")
        self.assertEqual(
            self.client.get("/api/v1/auth/me/").json()["pending_email"], "erin@second.example"
        )

    def test_address_verified_by_another_account_cannot_be_confirmed(self):
        other = User.objects.create_user(username="frank", email="frank@example.com")
        EmailAddress.objects.create(user=other, email="frank@example.com", verified=True, primary=True)
        self.client.patch("/api/v1/auth/me/", {"email": "frank@example.com"}, format="json")
        pending = EmailAddress.objects.get(user=self.user, email="frank@example.com")
        self._confirm(pending)
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, "erin@old.example")

    def test_switch_to_own_verified_address_applies_immediately(self):
        EmailAddress.objects.create(user=self.user, email="erin@alt.example", verified=True, primary=False)
        r = self.client.patch("/api/v1/auth/me/", {"email": "erin@alt.example"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json()["email"], "erin@alt.example")
        self.assertIsNone(r.json()["pending_email"])
        self.assertEqual(len(mail.outbox), 0)

    def test_unchanged_email_does_not_start_a_change(self):
        # The SPA profile form re-sends the current email on every save,
        # sometimes differing only in case.
        r = self.client.patch(
            "/api/v1/auth/me/", {"email": "Erin@Old.example", "first_name": "E"}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIsNone(r.json()["pending_email"])
        self.assertEqual(len(mail.outbox), 0)
        self.assertEqual(EmailAddress.objects.filter(user=self.user).count(), 1)

    def test_other_fields_in_same_patch_still_apply(self):
        r = self.client.patch(
            "/api/v1/auth/me/", {"email": "erin@new.example", "first_name": "Erin"}, format="json"
        )
        self.assertEqual(r.json()["first_name"], "Erin")
        self.assertEqual(r.json()["pending_email"], "erin@new.example")

    def test_signup_confirmation_is_unaffected(self):
        # A primary-but-unverified signup address confirms as before.
        self.old_address.verified = False
        self.old_address.save()
        self.assertEqual(self._confirm(self.old_address).status_code, status.HTTP_200_OK)
        self.old_address.refresh_from_db()
        self.assertTrue(self.old_address.verified)
        self.assertTrue(self.old_address.primary)
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, "erin@old.example")


@override_settings(ACCOUNT_EMAIL_VERIFICATION="optional")
class OptionalEmailChangeTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="gina", email="gina@old.example", password="pass12345678"
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_changed_email_is_written_directly(self):
        r = self.client.patch("/api/v1/auth/me/", {"email": "gina@new.example"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json()["email"], "gina@new.example")
        self.assertIsNone(r.json()["pending_email"])
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, "gina@new.example")
        self.assertEqual(len(mail.outbox), 0)
