"""Tests for emailing a site invite link (#731).

POST /api/v1/admin/invite-links/send/
"""
import smtplib
from datetime import timedelta
from unittest import mock

from django.core import mail
from django.core.cache import cache
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import (
    MAX_ACTIVE_INVITE_LINKS,
    MAX_PENDING_EMAILED_INVITE_LINKS,
    InviteLink,
    User,
)
from visiban.invite_email import InviteEmailGlobalThrottle, InviteEmailUserThrottle

URL = "/api/v1/admin/invite-links/send/"
RECIPIENT = "New.Hire@Example.org"


@override_settings(
    INVITE_EMAIL_ENABLED=True,
    DEMO_MODE=False,
    FRONTEND_URL="https://kanban.acme.test",
)
class AdminInviteEmailTests(TestCase):

    def setUp(self):
        cache.clear()
        self.admin = User.objects.create_user(username="siteadmin", password="adminpass123!")
        self.admin.is_site_admin = True
        self.admin.save(update_fields=["is_site_admin"])
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def tearDown(self):
        cache.clear()

    def _send(self, **body):
        body.setdefault("email", RECIPIENT)
        return self.client.post(URL, body, format="json")

    # -- happy path -------------------------------------------------------

    def test_send_creates_single_use_email_link_and_mails_join_url(self):
        r = self._send(expires_in_days=30)
        self.assertEqual(r.status_code, status.HTTP_202_ACCEPTED)
        self.assertEqual(
            r.json(), {"detail": "Invite sent", "sent_to": RECIPIENT, "already_registered": False},
        )
        link = InviteLink.objects.get()
        self.assertEqual(link.delivery, "email")
        self.assertTrue(link.single_use)
        self.assertEqual(link.status, "pending")
        self.assertAlmostEqual(
            (link.expires_at - timezone.now()).total_seconds(), timedelta(days=30).total_seconds(), delta=60,
        )
        msg = mail.outbox[0]
        self.assertEqual(msg.to, [RECIPIENT])
        self.assertIn("https://kanban.acme.test/join/vbnl_", msg.body)
        self.assertIn(link.expires_at.strftime("%B %d, %Y"), msg.body)
        token = msg.body.split("/join/")[1].split()[0]
        import hashlib
        self.assertEqual(hashlib.sha256(token.encode()).hexdigest(), link.token_hash)
        self.assertNotIn(token, r.content.decode())
        self.assertNotIn("raw_token", r.json())

    def test_default_expiry_is_seven_days(self):
        self._send()
        link = InviteLink.objects.get()
        self.assertAlmostEqual(
            (link.expires_at - timezone.now()).total_seconds(), timedelta(days=7).total_seconds(), delta=60,
        )

    def test_already_registered_flag_is_case_insensitive(self):
        User.objects.create_user(username="existing", password="p", email="new.hire@example.org")
        r = self._send()
        self.assertEqual(r.status_code, status.HTTP_202_ACCEPTED)
        self.assertTrue(r.json()["already_registered"])
        # Mail is still sent.
        self.assertEqual(len(mail.outbox), 1)

    def test_list_exposes_delivery(self):
        InviteLink.generate(created_by=self.admin)
        self._send()
        r = self.client.get("/api/v1/admin/invite-links/")
        self.assertEqual(sorted(link["delivery"] for link in r.json()), ["email", "link"])

    # -- permissions ----------------------------------------------------------

    def test_non_admin_gets_403(self):
        user = User.objects.create_user(username="regular", password="p")
        self.client.force_authenticate(user)
        r = self._send()
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(len(mail.outbox), 0)
        self.assertFalse(InviteLink.objects.exists())

    def test_unauthenticated_rejected(self):
        self.client.force_authenticate(None)
        self.assertIn(self._send().status_code, (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN))

    @override_settings(INVITE_EMAIL_ENABLED=False)
    def test_feature_disabled_returns_403_with_code(self):
        r = self._send()
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(r.json()["code"], "invite_email_disabled")

    @override_settings(DEMO_MODE=True)
    def test_demo_mode_returns_403(self):
        r = self._send()
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(len(mail.outbox), 0)

    # -- validation -----------------------------------------------------------

    def test_crlf_rejected(self):
        r = self._send(email="a@example.org\r\nBcc: b@example.org")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(len(mail.outbox), 0)

    def test_never_and_off_menu_expiry_rejected(self):
        for value in (None, "never", 2, 90):
            r = self._send(expires_in_days=value)
            self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, value)
        self.assertFalse(InviteLink.objects.exists())

    # -- caps -----------------------------------------------------------------

    def test_emailed_cap_enforced(self):
        future = timezone.now() + timedelta(days=7)
        InviteLink.objects.bulk_create([
            InviteLink(token_hash=f"h{i}", prefix="vbnl_xxx", created_by=self.admin,
                       expires_at=future, single_use=True, delivery="email")
            for i in range(MAX_PENDING_EMAILED_INVITE_LINKS)
        ])
        r = self._send()
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(r.json()["code"], "invite_email_cap_reached")
        self.assertEqual(len(mail.outbox), 0)

    def test_full_shareable_cap_does_not_block_email(self):
        for _ in range(MAX_ACTIVE_INVITE_LINKS):
            InviteLink.generate(created_by=self.admin)
        self.assertEqual(self._send().status_code, status.HTTP_202_ACCEPTED)

    def test_emailed_links_do_not_count_against_shareable_cap(self):
        for _ in range(MAX_ACTIVE_INVITE_LINKS - 1):
            InviteLink.generate(created_by=self.admin)
        for _ in range(3):
            self.assertEqual(self._send().status_code, status.HTTP_202_ACCEPTED)
        r = self.client.post("/api/v1/admin/invite-links/", {}, format="json")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        r = self.client.post("/api/v1/admin/invite-links/", {}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    # -- throttles ------------------------------------------------------------

    def test_per_user_throttle(self):
        with mock.patch.object(InviteEmailUserThrottle, "get_rate", return_value="1/hour"):
            self.assertEqual(self._send().status_code, status.HTTP_202_ACCEPTED)
            self.assertEqual(self._send().status_code, status.HTTP_429_TOO_MANY_REQUESTS)

    def test_global_throttle_spans_admins(self):
        other = User.objects.create_user(username="admin2", password="p")
        other.is_site_admin = True
        other.save(update_fields=["is_site_admin"])
        with mock.patch.object(InviteEmailGlobalThrottle, "get_rate", return_value="1/day"):
            self.assertEqual(self._send().status_code, status.HTTP_202_ACCEPTED)
            self.client.force_authenticate(other)
            self.assertEqual(self._send().status_code, status.HTTP_429_TOO_MANY_REQUESTS)

    # -- delivery failure -----------------------------------------------------

    def test_smtp_failure_revokes_link_and_returns_502(self):
        with mock.patch(
            "django.core.mail.backends.locmem.EmailBackend.send_messages",
            side_effect=smtplib.SMTPAuthenticationError(535, b"AUTH c2VjcmV0"),
        ):
            r = self._send()
        self.assertEqual(r.status_code, status.HTTP_502_BAD_GATEWAY)
        self.assertEqual(r.json()["code"], "auth_failed")
        self.assertNotIn("c2VjcmV0", r.content.decode())
        self.assertEqual(InviteLink.objects.get().status, "revoked")

    # -- logging ----------------------------------------------------------------

    def test_address_never_logged(self):
        with self.assertLogs(level="DEBUG") as logs:
            self._send()
            with mock.patch(
                "django.core.mail.backends.locmem.EmailBackend.send_messages",
                side_effect=ConnectionRefusedError(),
            ):
                self._send()
        output = "\n".join(logs.output)
        self.assertIn("invite_email.sent", output)
        self.assertIn("invite_email.failed", output)
        self.assertNotIn(RECIPIENT, output)
        self.assertNotIn(RECIPIENT.lower(), output)


class InviteEmailAvailableSiteConfigTests(TestCase):
    """``invite_email_available`` on the public site-config endpoint (#731)."""

    def _available(self):
        return APIClient().get("/api/v1/auth/site-config/").json()["invite_email_available"]

    @override_settings(INVITE_EMAIL_ENABLED=True, DEMO_MODE=False, EMAIL_BACKEND_EXPLICIT=True)
    def test_true_when_backend_pinned(self):
        self.assertIs(self._available(), True)

    @override_settings(INVITE_EMAIL_ENABLED=True, DEMO_MODE=False, EMAIL_BACKEND_EXPLICIT=False,
                       DEBUG=False, DEFAULT_FROM_EMAIL="invites@acme.test")
    def test_true_with_real_sender(self):
        self.assertIs(self._available(), True)

    @override_settings(INVITE_EMAIL_ENABLED=True, DEMO_MODE=False, EMAIL_BACKEND_EXPLICIT=False,
                       DEBUG=False, DEFAULT_FROM_EMAIL="noreply@example.com")
    def test_false_with_placeholder_sender(self):
        self.assertIs(self._available(), False)

    @override_settings(INVITE_EMAIL_ENABLED=False, DEMO_MODE=False, EMAIL_BACKEND_EXPLICIT=True)
    def test_false_when_disabled(self):
        self.assertIs(self._available(), False)

    @override_settings(INVITE_EMAIL_ENABLED=True, DEMO_MODE=True, EMAIL_BACKEND_EXPLICIT=True)
    def test_false_in_demo_mode(self):
        self.assertIs(self._available(), False)
