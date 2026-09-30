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

    def test_numeric_username_is_counted(self):
        # DRF's CharField accepts a JSON number, so it is a real rename and
        # must consume the bucket like a string would.
        codes = [
            self.client.patch("/api/v1/auth/me/", {"username": 1000 + i}, format="json").status_code
            for i in range(4)
        ]
        self.assertEqual(codes[:2], [200, 200])
        self.assertEqual(codes[2:], [status.HTTP_429_TOO_MANY_REQUESTS] * 2)
        self.user.refresh_from_db()
        self.assertEqual(self.user.username, "1001")

    def test_resending_numeric_current_username_is_not_counted(self):
        self.user.username = "1234"
        self.user.save(update_fields=["username"])
        for _ in range(4):
            r = self.client.patch("/api/v1/auth/me/", {"username": 1234}, format="json")
            self.assertEqual(r.status_code, status.HTTP_200_OK)

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

    def test_blanking_email_is_rejected(self):
        for url in PROFILE_ENDPOINTS:
            with self.subTest(url=url):
                r = self.client.patch(url, {"email": ""}, format="json")
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertEqual(r.json()["email"], ["An email address is required."])
                self.user.refresh_from_db()
                self.assertEqual(self.user.email, "erin@old.example")
                self.assertTrue(EmailAddress.objects.filter(pk=self.old_address.pk).exists())

    def test_blanking_email_does_not_disturb_a_pending_change(self):
        self.client.patch("/api/v1/auth/me/", {"email": "erin@new.example"}, format="json")
        r = self.client.patch("/api/v1/auth/me/", {"email": "", "first_name": "E"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, "erin@old.example")
        self.assertEqual(self.user.first_name, "")

    def test_account_without_email_can_still_save_profile(self):
        # e.g. SSO without an email claim: re-sending the existing blank is not a change.
        self.user.email = ""
        self.user.save(update_fields=["email"])
        self.old_address.delete()
        r = self.client.patch("/api/v1/auth/me/", {"email": "", "first_name": "E"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json()["first_name"], "E")

    def test_change_request_is_tracked_explicitly(self):
        self.client.patch("/api/v1/auth/me/", {"email": "erin@new.example"}, format="json")
        self.user.refresh_from_db()
        pending = EmailAddress.objects.get(user=self.user, email="erin@new.example")
        self.assertEqual(self.user.pending_email_address_id, pending.pk)
        self._confirm(pending)
        self.user.refresh_from_db()
        self.assertIsNone(self.user.pending_email_address_id)

    def test_unrelated_unverified_secondary_is_not_reported_as_pending(self):
        # e.g. imported by a social login, or added on allauth's /accounts/email/.
        EmailAddress.objects.create(
            user=self.user, email="erin@social.example", verified=False, primary=False
        )
        r = self.client.get("/api/v1/auth/me/")
        self.assertIsNone(r.json()["pending_email"])

    def test_unrelated_unverified_secondary_survives_a_change_request(self):
        other = EmailAddress.objects.create(
            user=self.user, email="erin@social.example", verified=False, primary=False
        )
        r = self.client.patch("/api/v1/auth/me/", {"email": "erin@new.example"}, format="json")
        self.assertEqual(r.json()["pending_email"], "erin@new.example")
        self.client.patch("/api/v1/auth/me/", {"email": "erin@newer.example"}, format="json")
        self.assertTrue(EmailAddress.objects.filter(pk=other.pk).exists())
        pending = EmailAddress.objects.get(user=self.user, email="erin@newer.example")
        self._confirm(pending)
        self.assertTrue(EmailAddress.objects.filter(pk=other.pk).exists())
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, "erin@newer.example")

    def test_confirming_an_untracked_secondary_does_not_switch_email(self):
        other = EmailAddress.objects.create(
            user=self.user, email="erin@social.example", verified=False, primary=False
        )
        self.assertEqual(self._confirm(other).status_code, status.HTTP_200_OK)
        other.refresh_from_db()
        self.assertTrue(other.verified)
        self.assertFalse(other.primary)
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, "erin@old.example")
        self.assertTrue(EmailAddress.objects.filter(pk=self.old_address.pk).exists())

    def test_existing_unverified_row_for_the_same_address_is_adopted(self):
        row = EmailAddress.objects.create(
            user=self.user, email="erin@social.example", verified=False, primary=False
        )
        r = self.client.patch("/api/v1/auth/me/", {"email": "erin@social.example"}, format="json")
        self.assertEqual(r.json()["pending_email"], "erin@social.example")
        self.user.refresh_from_db()
        self.assertEqual(self.user.pending_email_address_id, row.pk)

    def test_deleting_the_tracked_row_clears_the_pending_change(self):
        self.client.patch("/api/v1/auth/me/", {"email": "erin@new.example"}, format="json")
        EmailAddress.objects.filter(email="erin@new.example").delete()
        self.user.refresh_from_db()
        self.assertIsNone(self.user.pending_email_address_id)
        self.assertIsNone(self.client.get("/api/v1/auth/me/").json()["pending_email"])

    def test_stale_pointer_to_a_confirmed_row_does_not_delete_it(self):
        # (a) The first link is confirmed, then a second request arrives while
        # the pointer still names that (now verified, primary) row.
        self.client.patch("/api/v1/auth/me/", {"email": "erin@first.example"}, format="json")
        first = EmailAddress.objects.get(user=self.user, email="erin@first.example")
        self._confirm(first)
        User.objects.filter(pk=self.user.pk).update(pending_email_address=first)
        # force_authenticate reuses this object; reload it as a real request would.
        self.user.refresh_from_db()
        r = self.client.patch("/api/v1/auth/me/", {"email": "erin@second.example"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        first.refresh_from_db()
        self.assertTrue(first.verified)
        self.assertTrue(first.primary)
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, "erin@first.example")

    def test_tracked_row_verified_elsewhere_survives_a_new_request(self):
        # (b) e.g. an admin marks the tracked row verified in Django admin.
        self.client.patch("/api/v1/auth/me/", {"email": "erin@first.example"}, format="json")
        first = EmailAddress.objects.get(user=self.user, email="erin@first.example")
        EmailAddress.objects.filter(pk=first.pk).update(verified=True)
        self.client.patch("/api/v1/auth/me/", {"email": "erin@second.example"}, format="json")
        self.assertTrue(EmailAddress.objects.filter(pk=first.pk, verified=True).exists())

    def test_pending_email_is_scoped_to_the_user(self):
        self.client.patch("/api/v1/auth/me/", {"email": "erin@new.example"}, format="json")
        other = User.objects.create_user(username="oscar", email="oscar@example.com")
        # An admin reassigns the tracked row; the stale pointer must not leak it.
        EmailAddress.objects.filter(email="erin@new.example").update(user=other)
        self.assertIsNone(self.client.get("/api/v1/auth/me/").json()["pending_email"])
        # Nor may a later request delete the other user's row through it.
        self.client.patch("/api/v1/auth/me/", {"email": "erin@newer.example"}, format="json")
        self.assertTrue(EmailAddress.objects.filter(user=other, email="erin@new.example").exists())

    def test_setting_email_back_to_current_withdraws_the_pending_change(self):
        for n, url in enumerate(PROFILE_ENDPOINTS):
            with self.subTest(url=url):
                new = f"erin{n}@withdraw.example"
                self.client.patch(url, {"email": new}, format="json")
                row = EmailAddress.objects.get(user=self.user, email=new)
                r = self.client.patch(url, {"email": "ERIN@old.example"}, format="json")
                self.assertEqual(r.status_code, status.HTTP_200_OK)
                self.assertIsNone(r.json()["pending_email"])
                self.assertEqual(r.json()["email"].lower(), "erin@old.example")
                self.assertFalse(EmailAddress.objects.filter(pk=row.pk).exists())
                self.user.refresh_from_db()
                self.assertIsNone(self.user.pending_email_address_id)
                # The withdrawn link no longer does anything.
                self.assertNotEqual(self._confirm(row).status_code, status.HTTP_200_OK)
                self.assertTrue(EmailAddress.objects.filter(pk=self.old_address.pk).exists())

    def test_patch_without_email_keeps_the_pending_change(self):
        self.client.patch("/api/v1/auth/me/", {"email": "erin@new.example"}, format="json")
        r = self.client.patch("/api/v1/auth/me/", {"first_name": "E"}, format="json")
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

    def test_blank_email_is_still_allowed(self):
        for policy in ("optional", "none"):
            with self.subTest(policy=policy), override_settings(ACCOUNT_EMAIL_VERIFICATION=policy):
                self.user.email = "gina@old.example"
                self.user.save(update_fields=["email"])
                r = self.client.patch("/api/v1/auth/me/", {"email": ""}, format="json")
                self.assertEqual(r.status_code, status.HTTP_200_OK)
                self.assertEqual(r.json()["email"], "")
                self.user.refresh_from_db()
                self.assertEqual(self.user.email, "")


class UsernameTakenLookupTests(TestCase):
    """is_username_taken() compares on Lower(username) so it can use unique_username_ci."""

    def test_query_uses_lower_on_both_sides(self):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        from accounts.validators import is_username_taken

        User.objects.create_user(username="Hank")
        with CaptureQueriesContext(connection) as ctx:
            self.assertTrue(is_username_taken("hANK"))
        sql = ctx.captured_queries[-1]["sql"].upper()
        self.assertIn('LOWER("USERS"."USERNAME")', sql)
        self.assertNotIn("UPPER(", sql)
        self.assertNotIn(" LIKE ", sql)

    def test_exclude_pk_and_miss(self):
        from accounts.validators import is_username_taken

        hank = User.objects.create_user(username="Hank")
        self.assertFalse(is_username_taken("hank", exclude_pk=hank.pk))
        self.assertFalse(is_username_taken("ivan"))

    def test_choose_username_still_rejects_case_variant(self):
        User.objects.create_user(username="Hank")
        me = User.objects.create_user(username="jo", password="pass12345678")
        client = APIClient()
        client.force_authenticate(me)
        cache.clear()
        r = client.post("/api/v1/auth/choose-username/", {"username": "hank"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(r.json(), {"detail": "That username is already taken."})
