"""Resend or cancel a pending email change, and a blocked confirmation (#1293).

Under EMAIL_VERIFICATION=mandatory, #1273 holds a changed email as
``pending_email`` until the new address is confirmed. These endpoints let the
user act on that pending change from Settings:

- ``DELETE /api/v1/auth/me/pending-email/`` withdraws it (deletes the tracked
  ``EmailAddress`` row, so the link stops working).
- ``POST /api/v1/auth/me/pending-email/resend/`` mails the link again through
  allauth's own, rate-limited send.

And confirming an address another account has already verified answers 409
instead of a misleading ``200 {"detail": "ok"}``.
"""

from unittest.mock import patch

from allauth.account.models import EmailAddress, EmailConfirmationHMAC
from django.core import mail
from django.core.cache import cache
from django.test import TestCase, override_settings
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User

CANCEL_URL = "/api/v1/auth/me/pending-email/"
RESEND_URL = "/api/v1/auth/me/pending-email/resend/"
VERIFY_EMAIL_URL = "/api/v1/auth/registration/verify-email/"


@override_settings(ACCOUNT_EMAIL_VERIFICATION="mandatory")
class PendingEmailActionTestBase(TestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(
            username="erin", email="erin@old.example", password="pass12345678"
        )
        EmailAddress.objects.create(
            user=self.user, email="erin@old.example", verified=True, primary=True
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _request_change(self, new="erin@new.example"):
        r = self.client.patch("/api/v1/auth/me/", {"email": new}, format="json")
        self.assertEqual(r.json()["pending_email"], new)
        # The change request itself consumed allauth's per-address cooldown;
        # clear it so a test can exercise the resend on its own terms.
        cache.clear()
        mail.outbox.clear()
        return EmailAddress.objects.get(user=self.user, email=new)

    def _confirm(self, address):
        return APIClient().post(
            VERIFY_EMAIL_URL, {"key": EmailConfirmationHMAC(address).key}, format="json"
        )


class CancelPendingEmailTests(PendingEmailActionTestBase):
    def test_cancel_deletes_the_pending_row_and_clears_the_field(self):
        pending = self._request_change()
        r = self.client.delete(CANCEL_URL)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIsNone(r.json()["pending_email"])
        self.assertEqual(r.json()["email"], "erin@old.example")
        self.assertFalse(EmailAddress.objects.filter(pk=pending.pk).exists())
        self.user.refresh_from_db()
        self.assertIsNone(self.user.pending_email_address_id)
        self.assertEqual(self.user.email, "erin@old.example")
        self.assertIsNone(self.client.get("/api/v1/auth/me/").json()["pending_email"])

    def test_link_stops_working_after_cancel(self):
        pending = self._request_change()
        key = EmailConfirmationHMAC(pending).key
        self.client.delete(CANCEL_URL)
        r = APIClient().post(VERIFY_EMAIL_URL, {"key": key}, format="json")
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, "erin@old.example")

    def test_cancel_with_nothing_pending_is_an_idempotent_200(self):
        r = self.client.delete(CANCEL_URL)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIsNone(r.json()["pending_email"])
        # The current, verified address is never touched.
        self.assertEqual(EmailAddress.objects.filter(user=self.user).count(), 1)

    def test_cancel_leaves_unrelated_unverified_addresses_alone(self):
        other = EmailAddress.objects.create(
            user=self.user, email="erin@social.example", verified=False, primary=False
        )
        self._request_change()
        self.client.delete(CANCEL_URL)
        self.assertTrue(EmailAddress.objects.filter(pk=other.pk).exists())

    def test_cancel_only_affects_the_requesting_user(self):
        # IDOR: there is no id in the request; another user's DELETE must not
        # touch this user's pending change.
        pending = self._request_change()
        mallory = User.objects.create_user(username="mallory", password="pass12345678")
        other_client = APIClient()
        other_client.force_authenticate(mallory)
        r = other_client.delete(CANCEL_URL)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertTrue(EmailAddress.objects.filter(pk=pending.pk).exists())
        self.assertEqual(
            self.client.get("/api/v1/auth/me/").json()["pending_email"], "erin@new.example"
        )

    def test_requires_authentication(self):
        self.assertEqual(APIClient().delete(CANCEL_URL).status_code, status.HTTP_401_UNAUTHORIZED)

    def test_blocked_by_pending_forced_password_change(self):
        # Default permission chain: unlike /auth/me/ itself, these actions are
        # not part of the flow that clears a forced change.
        self._request_change()
        self.user.must_change_password = True
        self.user.save(update_fields=["must_change_password"])
        self.assertEqual(self.client.delete(CANCEL_URL).status_code, status.HTTP_403_FORBIDDEN)


class ResendPendingEmailTests(PendingEmailActionTestBase):
    def test_resend_mails_the_pending_address(self):
        pending = self._request_change()
        r = self.client.post(RESEND_URL)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json(), {"detail": "Confirmation email sent."})
        self.assertEqual(len(mail.outbox), 1)
        self.assertEqual(mail.outbox[0].to, ["erin@new.example"])
        # The resent link confirms the change.
        self.assertEqual(self._confirm(pending).status_code, status.HTTP_200_OK)
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, "erin@new.example")

    def test_resend_uses_allauths_verification_send(self):
        self._request_change()
        with patch(
            "allauth.account.internal.flows.email_verification.send_verification_email_to_address",
            return_value=True,
        ) as send:
            self.client.post(RESEND_URL)
        send.assert_called_once()
        self.assertEqual(send.call_args.args[1].email, "erin@new.example")

    def test_resend_inside_the_cooldown_is_a_429_and_sends_nothing(self):
        self._request_change()
        self.assertEqual(self.client.post(RESEND_URL).status_code, status.HTTP_200_OK)
        mail.outbox.clear()
        r = self.client.post(RESEND_URL)
        self.assertEqual(r.status_code, status.HTTP_429_TOO_MANY_REQUESTS)
        self.assertIn("link already sent still works", r.json()["detail"])
        self.assertEqual(len(mail.outbox), 0)

    def test_change_request_and_resend_share_the_cooldown(self):
        # A resend can't mail an address more often than a change request could.
        self.client.patch("/api/v1/auth/me/", {"email": "erin@new.example"}, format="json")
        mail.outbox.clear()
        self.assertEqual(
            self.client.post(RESEND_URL).status_code, status.HTTP_429_TOO_MANY_REQUESTS
        )
        self.assertEqual(len(mail.outbox), 0)

    def test_resend_with_nothing_pending_is_404(self):
        r = self.client.post(RESEND_URL)
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(len(mail.outbox), 0)

    def test_resend_never_mails_an_untracked_unverified_address(self):
        EmailAddress.objects.create(
            user=self.user, email="erin@social.example", verified=False, primary=False
        )
        self.assertEqual(self.client.post(RESEND_URL).status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(len(mail.outbox), 0)

    def test_resend_ignores_a_request_body(self):
        # The address always comes from the user's own pending change, never
        # from the request, so the endpoint cannot be aimed at another inbox.
        self._request_change()
        r = self.client.post(RESEND_URL, {"email": "victim@example.com"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(mail.outbox[0].to, ["erin@new.example"])

    def test_resend_only_acts_for_the_requesting_user(self):
        self._request_change()
        mallory = User.objects.create_user(username="mallory", password="pass12345678")
        other_client = APIClient()
        other_client.force_authenticate(mallory)
        self.assertEqual(other_client.post(RESEND_URL).status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(len(mail.outbox), 0)

    def test_requires_authentication(self):
        self.assertEqual(APIClient().post(RESEND_URL).status_code, status.HTTP_401_UNAUTHORIZED)

    def test_resend_does_not_log_the_address(self):
        self._request_change()
        with self.assertNoLogs("accounts", level="INFO"):
            self.client.post(RESEND_URL)


class BlockedConfirmationTests(PendingEmailActionTestBase):
    def setUp(self):
        super().setUp()
        other = User.objects.create_user(username="frank", email="frank@example.com")
        EmailAddress.objects.create(
            user=other, email="frank@example.com", verified=True, primary=True
        )

    def test_confirming_an_address_verified_elsewhere_is_409(self):
        pending = self._request_change("frank@example.com")
        r = self._confirm(pending)
        self.assertEqual(r.status_code, status.HTTP_409_CONFLICT)
        self.assertEqual(r.json()["code"], "email_in_use")
        pending.refresh_from_db()
        self.assertFalse(pending.verified)
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, "erin@old.example")

    def test_requesting_account_sees_no_difference(self):
        # Enumeration: the account that asked for the change must not be able
        # to tell a blocked address from one simply not confirmed yet.
        self._request_change("frank@example.com")
        before = self.client.get("/api/v1/auth/me/").json()
        self._confirm(EmailAddress.objects.get(user=self.user, email="frank@example.com"))
        after = self.client.get("/api/v1/auth/me/").json()
        self.assertEqual(before["pending_email"], after["pending_email"])
        self.assertEqual(before, after)

    def test_blocked_change_can_be_cancelled(self):
        pending = self._request_change("frank@example.com")
        self._confirm(pending)
        r = self.client.delete(CANCEL_URL)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIsNone(r.json()["pending_email"])
        self.assertFalse(EmailAddress.objects.filter(pk=pending.pk).exists())

    def test_signup_confirmation_for_an_address_verified_elsewhere_is_409(self):
        # Signup path: two accounts hold the same unverified address; once the
        # first confirms it, the second's link can no longer verify it.
        first = User.objects.create_user(username="gina1", email="gina@example.com")
        second = User.objects.create_user(username="gina2", email="gina@example.com")
        first_row = EmailAddress.objects.create(
            user=first, email="gina@example.com", verified=False, primary=True
        )
        second_row = EmailAddress.objects.create(
            user=second, email="gina@example.com", verified=False, primary=True
        )
        self.assertEqual(self._confirm(first_row).status_code, status.HTTP_200_OK)
        r = self._confirm(second_row)
        self.assertEqual(r.status_code, status.HTTP_409_CONFLICT)
        self.assertEqual(r.json()["code"], "email_in_use")
        second_row.refresh_from_db()
        self.assertFalse(second_row.verified)
        first_row.refresh_from_db()
        self.assertTrue(first_row.verified)

    def test_ordinary_confirmation_still_answers_ok(self):
        pending = self._request_change()
        r = self._confirm(pending)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json(), {"detail": "ok"})
