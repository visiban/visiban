"""Tests for emailing a group invite link (#731).

POST /api/v1/groups/{id}/invite-links/send/
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

from accounts.models import User
from groups.models import Group, GroupInviteLink, GroupMembership
from groups.views import GROUP_MAX_PENDING_EMAILED_INVITES
from visiban.invite_email import (
    InviteEmailGlobalThrottle,
    InviteEmailGroupThrottle,
    InviteEmailUserThrottle,
)

RECIPIENT = "Invitee.Person@Example.org"


def _url(group):
    return f"/api/v1/groups/{group.pk}/invite-links/send/"


@override_settings(
    INVITE_EMAIL_ENABLED=True,
    DEMO_MODE=False,
    FRONTEND_URL="https://kanban.acme.test",
    DEFAULT_FROM_EMAIL="invites@acme.test",
)
class GroupInviteEmailTests(TestCase):

    def setUp(self):
        cache.clear()
        self.admin = User.objects.create_user(username="gadmin", password="pass", email="gadmin@acme.test")
        self.group = Group.objects.create(name="Platform Team", owner=self.admin)
        GroupMembership.objects.create(group=self.group, user=self.admin, role=GroupMembership.Role.ADMIN)
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def tearDown(self):
        cache.clear()

    def _send(self, **body):
        body.setdefault("email", RECIPIENT)
        return self.client.post(_url(self.group), body, format="json")

    # -- happy path -------------------------------------------------------

    def test_send_creates_single_use_email_link_and_mails_join_url(self):
        r = self._send(role="viewer", expiry_days=3)
        self.assertEqual(r.status_code, status.HTTP_202_ACCEPTED)
        self.assertEqual(r.json(), {"detail": "Invite sent", "sent_to": RECIPIENT})

        link = GroupInviteLink.objects.get(group=self.group)
        self.assertEqual(link.delivery, "email")
        self.assertTrue(link.single_use)
        self.assertTrue(link.is_active)
        self.assertEqual(link.role, "viewer")
        self.assertAlmostEqual(
            (link.expires_at - timezone.now()).total_seconds(), timedelta(days=3).total_seconds(), delta=60,
        )

        self.assertEqual(len(mail.outbox), 1)
        msg = mail.outbox[0]
        self.assertEqual(msg.to, [RECIPIENT])
        self.assertIn("Platform Team", msg.subject)
        self.assertIn("Platform Team", msg.body)
        self.assertIn("https://kanban.acme.test/join/vbng_", msg.body)
        self.assertIn(link.expires_at.strftime("%B %d, %Y"), msg.body)
        # The token in the mail hashes to the stored link.
        token = msg.body.split("/join/")[1].split()[0]
        self.assertEqual(GroupInviteLink._hash_token(token), link.token_hash)
        # ...and never appears in the API response.
        self.assertNotIn(token, r.content.decode())
        self.assertNotIn("token", r.json())

    def test_defaults_role_member_and_seven_day_expiry(self):
        self._send()
        link = GroupInviteLink.objects.get(group=self.group)
        self.assertEqual(link.role, "member")
        self.assertAlmostEqual(
            (link.expires_at - timezone.now()).total_seconds(), timedelta(days=7).total_seconds(), delta=60,
        )

    def test_list_serializer_exposes_delivery(self):
        GroupInviteLink.generate(group=self.group, created_by=self.admin)
        self._send()
        r = self.client.get(f"/api/v1/groups/{self.group.pk}/invite-links/")
        self.assertEqual(sorted(link["delivery"] for link in r.json()), ["email", "link"])

    def test_group_name_with_newlines_is_flattened(self):
        self.group.name = "Evil\r\nBcc: victim@example.org\nOpen this: https://evil.test"
        self.group.save()
        r = self._send()
        self.assertEqual(r.status_code, status.HTTP_202_ACCEPTED)
        msg = mail.outbox[0]
        self.assertNotIn("\n", msg.subject)
        self.assertIn("Evil Bcc: victim@example.org Open this: https://evil.test", msg.body)

    @override_settings(DEBUG=True, EMAIL_BACKEND="django.core.mail.backends.console.EmailBackend")
    def test_debug_console_backend_reports_console_delivery(self):
        with mock.patch("django.core.mail.backends.console.EmailBackend.send_messages", return_value=1):
            r = self._send()
        self.assertEqual(r.status_code, status.HTTP_202_ACCEPTED)
        self.assertEqual(r.json()["delivery"], "console")

    # -- enumeration --------------------------------------------------------

    def test_existing_member_existing_user_and_stranger_get_identical_responses(self):
        member = User.objects.create_user(username="m", password="p", email="member@acme.test")
        GroupMembership.objects.create(group=self.group, user=member)
        User.objects.create_user(username="o", password="p", email="outsider@acme.test")
        bodies = []
        for address in ("member@acme.test", "outsider@acme.test", "nobody@acme.test"):
            r = self._send(email=address)
            self.assertEqual(r.status_code, status.HTTP_202_ACCEPTED)
            body = r.json()
            self.assertEqual(body.pop("sent_to"), address)
            bodies.append(body)
        self.assertEqual(bodies[0], bodies[1])
        self.assertEqual(bodies[1], bodies[2])
        # Mail is always sent, whoever the address belongs to.
        self.assertEqual(len(mail.outbox), 3)

    # -- permissions ----------------------------------------------------------

    def test_non_admin_member_gets_403_and_nothing_is_sent(self):
        member = User.objects.create_user(username="plain", password="p")
        GroupMembership.objects.create(group=self.group, user=member, role=GroupMembership.Role.MEMBER)
        self.client.force_authenticate(member)
        r = self._send()
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(len(mail.outbox), 0)
        self.assertFalse(GroupInviteLink.objects.exists())

    def test_non_member_cannot_reach_group(self):
        stranger = User.objects.create_user(username="stranger", password="p")
        self.client.force_authenticate(stranger)
        r = self._send()
        self.assertIn(r.status_code, (status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND))
        self.assertEqual(len(mail.outbox), 0)

    def test_unauthenticated_rejected(self):
        self.client.force_authenticate(None)
        r = self._send()
        self.assertIn(r.status_code, (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN))

    @override_settings(INVITE_EMAIL_ENABLED=False)
    def test_feature_disabled_returns_403_with_code(self):
        r = self._send()
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(r.json()["code"], "invite_email_disabled")
        self.assertEqual(len(mail.outbox), 0)

    @override_settings(DEMO_MODE=True)
    def test_demo_mode_returns_403(self):
        r = self._send()
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(len(mail.outbox), 0)
        self.assertFalse(GroupInviteLink.objects.exists())

    # -- validation -----------------------------------------------------------

    def test_crlf_in_address_rejected(self):
        for bad in ("victim@example.org\r\nBcc: x@example.org", "victim@example.org\n"):
            r = self._send(email=bad)
            self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, bad)
        self.assertEqual(len(mail.outbox), 0)

    def test_invalid_and_missing_email_rejected(self):
        self.assertEqual(self._send(email="not-an-email").status_code, status.HTTP_400_BAD_REQUEST)
        r = self.client.post(_url(self.group), {}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_never_expiry_rejected(self):
        for value in (None, "never", 0, 31):
            r = self._send(expiry_days=value)
            self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, value)
        self.assertFalse(GroupInviteLink.objects.exists())

    def test_surrounding_whitespace_stripped(self):
        r = self._send(email="  padded@acme.test  ")
        self.assertEqual(r.status_code, status.HTTP_202_ACCEPTED)
        self.assertEqual(mail.outbox[0].to, ["padded@acme.test"])

    # -- caps -----------------------------------------------------------------

    def test_emailed_links_do_not_consume_shareable_slots(self):
        for _ in range(6):
            self.assertEqual(self._send().status_code, status.HTTP_202_ACCEPTED)
        r = self.client.post(f"/api/v1/groups/{self.group.pk}/invite-links/", {}, format="json")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)

    def test_full_shareable_slots_do_not_block_email(self):
        for _ in range(5):
            GroupInviteLink.generate(group=self.group, created_by=self.admin)
        self.assertEqual(self._send().status_code, status.HTTP_202_ACCEPTED)

    def test_emailed_cap_enforced(self):
        future = timezone.now() + timedelta(days=7)
        for _ in range(GROUP_MAX_PENDING_EMAILED_INVITES):
            GroupInviteLink.generate(
                group=self.group, created_by=self.admin, single_use=True,
                expires_at=future, delivery="email",
            )
        r = self._send()
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(r.json()["code"], "invite_email_cap_reached")
        self.assertEqual(len(mail.outbox), 0)

    def test_emailed_cap_ignores_expired_revoked_and_used(self):
        past = timezone.now() - timedelta(days=1)
        future = timezone.now() + timedelta(days=7)
        for i in range(GROUP_MAX_PENDING_EMAILED_INVITES):
            link, _ = GroupInviteLink.generate(
                group=self.group, created_by=self.admin, single_use=True,
                expires_at=past if i % 3 == 0 else future, delivery="email",
            )
            if i % 3 == 1:
                link.is_active = False
                link.save(update_fields=["is_active"])
            elif i % 3 == 2:
                link.used_at = timezone.now()
                link.save(update_fields=["used_at"])
        self.assertEqual(self._send().status_code, status.HTTP_202_ACCEPTED)

    # -- throttles --------------------------------------------------------------

    def test_per_user_throttle(self):
        with mock.patch.object(InviteEmailUserThrottle, "get_rate", return_value="2/hour"):
            self.assertEqual(self._send().status_code, status.HTTP_202_ACCEPTED)
            self.assertEqual(self._send().status_code, status.HTTP_202_ACCEPTED)
            self.assertEqual(self._send().status_code, status.HTTP_429_TOO_MANY_REQUESTS)
        self.assertEqual(len(mail.outbox), 2)

    def test_per_group_throttle_is_shared_by_all_admins_of_the_group(self):
        other_admin = User.objects.create_user(username="admin2", password="p")
        GroupMembership.objects.create(group=self.group, user=other_admin, role=GroupMembership.Role.ADMIN)
        other_group = Group.objects.create(name="Other", owner=self.admin)
        GroupMembership.objects.create(group=other_group, user=self.admin, role=GroupMembership.Role.ADMIN)
        with mock.patch.object(InviteEmailGroupThrottle, "get_rate", return_value="2/day"):
            self.assertEqual(self._send().status_code, status.HTTP_202_ACCEPTED)
            self.client.force_authenticate(other_admin)
            self.assertEqual(self._send().status_code, status.HTTP_202_ACCEPTED)
            self.assertEqual(self._send().status_code, status.HTTP_429_TOO_MANY_REQUESTS)
            # A different group has its own budget.
            self.client.force_authenticate(self.admin)
            r = self.client.post(_url(other_group), {"email": RECIPIENT}, format="json")
            self.assertEqual(r.status_code, status.HTTP_202_ACCEPTED)

    def test_global_throttle(self):
        with mock.patch.object(InviteEmailGlobalThrottle, "get_rate", return_value="1/day"):
            self.assertEqual(self._send().status_code, status.HTTP_202_ACCEPTED)
            self.assertEqual(self._send().status_code, status.HTTP_429_TOO_MANY_REQUESTS)

    def test_non_admin_requests_do_not_spend_group_budget(self):
        member = User.objects.create_user(username="plain", password="p")
        GroupMembership.objects.create(group=self.group, user=member)
        with mock.patch.object(InviteEmailGroupThrottle, "get_rate", return_value="1/day"):
            self.client.force_authenticate(member)
            for _ in range(3):
                self.assertEqual(self._send().status_code, status.HTTP_403_FORBIDDEN)
            self.client.force_authenticate(self.admin)
            self.assertEqual(self._send().status_code, status.HTTP_202_ACCEPTED)

    # -- delivery failure -----------------------------------------------------

    def test_smtp_failure_revokes_link_and_returns_502_with_code(self):
        with mock.patch(
            "django.core.mail.backends.locmem.EmailBackend.send_messages",
            side_effect=smtplib.SMTPAuthenticationError(535, b"AUTH PLAIN c2VjcmV0 rejected"),
        ):
            r = self._send()
        self.assertEqual(r.status_code, status.HTTP_502_BAD_GATEWAY)
        self.assertEqual(r.json()["code"], "auth_failed")
        self.assertNotIn("c2VjcmV0", r.content.decode())
        link = GroupInviteLink.objects.get(group=self.group)
        self.assertFalse(link.is_active)
        self.assertEqual(link.status, "revoked")

    def test_connection_failure_maps_to_code(self):
        with mock.patch(
            "django.core.mail.backends.locmem.EmailBackend.send_messages",
            side_effect=ConnectionRefusedError(),
        ):
            r = self._send()
        self.assertEqual(r.status_code, status.HTTP_502_BAD_GATEWAY)
        self.assertEqual(r.json()["code"], "connection_refused")

    # -- logging ----------------------------------------------------------------

    def test_address_never_logged_on_success_or_failure(self):
        with self.assertLogs(level="DEBUG") as logs:
            self._send()
        with self.assertLogs(level="DEBUG") as fail_logs:
            with mock.patch(
                "django.core.mail.backends.locmem.EmailBackend.send_messages",
                side_effect=smtplib.SMTPAuthenticationError(535, b"nope"),
            ):
                self._send()
        output = "\n".join(logs.output + fail_logs.output)
        self.assertIn("invite_email.sent", output)
        self.assertIn("invite_email.failed", output)
        self.assertNotIn(RECIPIENT, output)
        self.assertNotIn(RECIPIENT.lower(), output)
        self.assertNotIn("vbng_", output.replace("prefix=vbng_", ""))

    # -- broadcast -------------------------------------------------------------

    def test_created_event_broadcast_on_commit(self):
        with mock.patch("groups.broadcast.broadcast_group_event") as bcast:
            with self.captureOnCommitCallbacks(execute=False) as callbacks:
                self._send()
            bcast.assert_not_called()
            for cb in callbacks:
                cb()
        link = GroupInviteLink.objects.get(group=self.group)
        bcast.assert_called_once_with(
            self.group.pk, "invite_link.created", {"id": link.pk, "delivery": "email"},
        )

    def test_failed_send_broadcasts_revoked(self):
        with mock.patch("groups.broadcast.broadcast_group_event") as bcast:
            with mock.patch(
                "django.core.mail.backends.locmem.EmailBackend.send_messages",
                side_effect=ConnectionRefusedError(),
            ):
                with self.captureOnCommitCallbacks(execute=True):
                    self._send()
        events = [c.args[1] for c in bcast.call_args_list]
        self.assertEqual(events, ["invite_link.created", "invite_link.revoked"])

    # -- existing endpoint unchanged -----------------------------------------

    def test_revoke_route_still_works_and_rejects_non_numeric_id(self):
        link, _ = GroupInviteLink.generate(group=self.group, created_by=self.admin)
        r = self.client.delete(f"/api/v1/groups/{self.group.pk}/invite-links/{link.pk}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        r = self.client.delete(f"/api/v1/groups/{self.group.pk}/invite-links/send/")
        self.assertIn(r.status_code, (status.HTTP_404_NOT_FOUND, status.HTTP_405_METHOD_NOT_ALLOWED))
