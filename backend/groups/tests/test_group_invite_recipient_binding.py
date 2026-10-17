"""Emailed group invites are bound to the invited address (#1678).

Join endpoint, REST and OAuth registration, the send endpoint, and that the
stored hash never reaches an API response. The shared helper and the board
side are covered in ``boards/tests/test_invite_recipient_binding.py``.
"""
import re
import threading
from datetime import timedelta
from unittest import mock

from allauth.account.models import EmailAddress
from allauth.core.exceptions import ImmediateHttpResponse
from django.core import mail
from django.core.cache import cache
from django.db import connection
from django.test import RequestFactory, TestCase, TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from accounts.adapter import PENDING_INVITE_SESSION_KEY, SocialRegistrationAdapter
from accounts.models import SiteSetting, User
from boards.tests.invite_fixtures import generate_invite
from groups.models import Group, GroupInviteLink, GroupMembership
from groups.serializers import GroupInviteLinkSerializer
from visiban.invite_recipient import MISMATCH_CODE, MISMATCH_DETAIL, REGISTRATION_MISMATCH_DETAIL, hash_recipient

PASSWORD = "Sup3rS3cr3t!xyz"
REGISTER_URL = "/api/v1/auth/registration/"
INVITED = "Invitee.Person@Example.org"


def set_mode(mode):
    row = SiteSetting.get()
    row.registration_mode = mode
    row.save()
    cache.clear()


def join_url(raw):
    return f"/api/v1/groups/join/{raw}/"


class _GroupFixture:
    def make_group(self):
        self.admin = User.objects.create_user(
            username="gadmin", password="p", email="gadmin@acme.test", is_site_admin=True,
        )
        self.group = Group.objects.create(name="Platform Team", owner=self.admin)
        GroupMembership.objects.create(group=self.group, user=self.admin, role=GroupMembership.Role.ADMIN)

    def make_link(self, *, recipient=INVITED, delivery=GroupInviteLink.Delivery.EMAIL, single_use=True):
        # recipient=None on an emailed link: a row minted before the column
        # existed (generate() itself refuses it; see boards/tests/invite_fixtures).
        return generate_invite(
            GroupInviteLink,
            group=self.group, created_by=self.admin, role=GroupInviteLink.Role.MEMBER,
            expires_at=timezone.now() + timedelta(days=7), single_use=single_use, delivery=delivery,
            recipient_email=recipient,
        )


class GroupJoinBindingTests(_GroupFixture, TestCase):

    def setUp(self):
        cache.clear()
        self.make_group()
        self.invitee = User.objects.create_user(username="invitee", password="p", email="invitee.person@example.org")
        self.other = User.objects.create_user(username="other", password="p", email="other@example.org")

    def tearDown(self):
        cache.clear()

    def _join(self, raw, user):
        client = APIClient()
        client.force_authenticate(user)
        return client.post(join_url(raw))

    def test_generate_refuses_an_emailed_link_without_an_address(self):
        for recipient in (None, "", "   "):
            with self.subTest(recipient=recipient), self.assertRaises(ValueError):
                GroupInviteLink.generate(
                    group=self.group, created_by=self.admin, single_use=True,
                    delivery=GroupInviteLink.Delivery.EMAIL, recipient_email=recipient,
                )
        self.assertFalse(GroupInviteLink.objects.filter(group=self.group).exists())
        link, _raw = GroupInviteLink.generate(group=self.group, created_by=self.admin)
        self.assertIsNone(link.recipient_hash)

    def test_matching_account_joins_and_consumes(self):
        link, raw = self.make_link()
        self.assertEqual(link.recipient_hash, hash_recipient(INVITED))
        r = self._join(raw, self.invitee)
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.content)
        self.assertTrue(GroupMembership.objects.filter(group=self.group, user=self.invitee).exists())
        link.refresh_from_db()
        self.assertIsNotNone(link.used_at)

    def test_non_matching_account_is_refused_and_not_consumed(self):
        link, raw = self.make_link()
        r = self._join(raw, self.other)
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN, r.content)
        self.assertEqual(r.json(), {"code": MISMATCH_CODE, "detail": MISMATCH_DETAIL})
        self.assertNotIn(INVITED.lower(), r.content.decode().lower())
        self.assertFalse(GroupMembership.objects.filter(group=self.group, user=self.other).exists())
        link.refresh_from_db()
        self.assertIsNone(link.used_at)
        self.assertEqual(self._join(raw, self.invitee).status_code, status.HTTP_201_CREATED)

    def test_existing_member_with_another_address_does_not_consume_it(self):
        GroupMembership.objects.create(group=self.group, user=self.other, role=GroupMembership.Role.VIEWER)
        link, raw = self.make_link()
        self.assertEqual(self._join(raw, self.other).status_code, status.HTTP_403_FORBIDDEN)
        link.refresh_from_db()
        self.assertIsNone(link.used_at)

    @override_settings(ACCOUNT_EMAIL_VERIFICATION="mandatory")
    def test_mandatory_mode_requires_a_verified_address(self):
        _link, raw = self.make_link()
        self.assertEqual(self._join(raw, self.invitee).status_code, status.HTTP_403_FORBIDDEN)
        EmailAddress.objects.create(user=self.invitee, email=self.invitee.email, verified=True, primary=True)
        self.assertEqual(self._join(raw, self.invitee).status_code, status.HTTP_201_CREATED)

    def test_shareable_link_is_unbound(self):
        link, raw = self.make_link(recipient=None, delivery=GroupInviteLink.Delivery.LINK, single_use=False)
        self.assertIsNone(link.recipient_hash)
        self.assertEqual(self._join(raw, self.other).status_code, status.HTTP_201_CREATED)

    def test_legacy_emailed_invite_without_hash_redeems_as_before(self):
        _link, raw = self.make_link(recipient=None)
        self.assertEqual(self._join(raw, self.other).status_code, status.HTTP_201_CREATED)

    def test_consumed_invite_follow_up_by_its_member_is_unchanged(self):
        _link, raw = self.make_link()
        self.assertEqual(self._join(raw, self.invitee).status_code, status.HTTP_201_CREATED)
        self.assertEqual(self._join(raw, self.invitee).status_code, status.HTTP_200_OK)
        self.assertEqual(self._join(raw, self.other).status_code, status.HTTP_410_GONE)

    def test_preview_does_not_disclose_binding(self):
        _link, raw = self.make_link()
        r = APIClient().get(join_url(raw))
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(set(r.json()), {"group_id", "group_name", "role", "can_register"})


@override_settings(
    INVITE_EMAIL_ENABLED=True, DEMO_MODE=False, FRONTEND_URL="https://kanban.acme.test",
)
class GroupSendBindsInviteTests(_GroupFixture, TestCase):

    def setUp(self):
        cache.clear()
        self.make_group()
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def tearDown(self):
        cache.clear()

    def test_send_binds_invite_and_hash_never_leaves_the_server(self):
        r = self.client.post(
            f"/api/v1/groups/{self.group.pk}/invite-links/send/", {"email": INVITED}, format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_202_ACCEPTED, r.content)
        link = GroupInviteLink.objects.get(group=self.group, delivery=GroupInviteLink.Delivery.EMAIL)
        self.assertEqual(link.recipient_hash, hash_recipient(INVITED))
        raw = re.search(r"vbng_[0-9a-f]{40}", mail.outbox[0].body).group(0)

        listing = self.client.get(f"/api/v1/groups/{self.group.pk}/invite-links/")
        self.assertEqual(listing.status_code, status.HTTP_200_OK)
        self.assertNotIn("recipient_hash", listing.content.decode())
        self.assertNotIn(link.recipient_hash, listing.content.decode())

        invitee = User.objects.create_user(username="inv", password="p", email="invitee.person@example.org")
        joiner = APIClient()
        joiner.force_authenticate(invitee)
        with mock.patch("groups.broadcast.broadcast_group_event") as bcast:
            with self.captureOnCommitCallbacks(execute=True):
                joined = joiner.post(join_url(raw))
        self.assertEqual(joined.status_code, status.HTTP_201_CREATED, joined.content)
        self.assertNotIn(link.recipient_hash, joined.content.decode())
        for call in bcast.call_args_list:
            self.assertNotIn(link.recipient_hash, repr(call))

    def test_serializer_does_not_declare_recipient_hash(self):
        self.assertNotIn("recipient_hash", GroupInviteLinkSerializer.Meta.fields)


class GroupRegistrationBindingTests(_GroupFixture, TestCase):

    def setUp(self):
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        self.make_group()

    def tearDown(self):
        set_mode(SiteSetting.RegistrationMode.OPEN)

    def _register(self, email, raw):
        return APIClient().post(REGISTER_URL, {
            "email": email, "password1": PASSWORD, "password2": PASSWORD, "invite_token": raw,
        })

    def test_matching_signup_address_registers_and_joins(self):
        link, raw = self.make_link()
        r = self._register("invitee.PERSON@example.org", raw)
        self.assertIn(r.status_code, (201, 204), r.content)
        user = User.objects.get(email__iexact=INVITED)
        self.assertTrue(GroupMembership.objects.filter(group=self.group, user=user).exists())
        link.refresh_from_db()
        self.assertIsNotNone(link.used_at)

    def test_non_matching_signup_address_is_refused_before_any_account(self):
        link, raw = self.make_link()
        r = self._register("someone.else@example.org", raw)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
        self.assertEqual(r.json(), {"email": [REGISTRATION_MISMATCH_DETAIL], "code": MISMATCH_CODE})
        self.assertFalse(User.objects.filter(email="someone.else@example.org").exists())
        link.refresh_from_db()
        self.assertIsNone(link.used_at)
        self.assertIn(self._register(INVITED, raw).status_code, (201, 204))

    def test_form_errors_read_the_same_for_a_matching_and_a_wrong_address(self):
        link, raw = self.make_link()
        responses = [
            APIClient().post(REGISTER_URL, {
                "email": email, "password1": PASSWORD, "password2": "does-not-match!", "invite_token": raw,
            })
            for email in (INVITED, "someone.else@example.org")
        ]
        self.assertEqual([r.status_code for r in responses], [400, 400])
        self.assertEqual(responses[0].json(), responses[1].json())
        self.assertNotIn("code", responses[0].json())
        self.assertFalse(User.objects.filter(email__iexact=INVITED).exists())
        link.refresh_from_db()
        self.assertIsNone(link.used_at)

    def test_legacy_unbound_invite_registers_any_address(self):
        _link, raw = self.make_link(recipient=None)
        self.assertIn(self._register("anyone@example.org", raw).status_code, (201, 204))


class GroupOAuthBindingTests(_GroupFixture, TestCase):

    def setUp(self):
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        self.make_group()
        self.adapter = SocialRegistrationAdapter()

    def tearDown(self):
        set_mode(SiteSetting.RegistrationMode.OPEN)

    def _save(self, raw, username, email):
        request = RequestFactory().get("/accounts/google/login/callback/")
        request.session = {PENDING_INVITE_SESSION_KEY: raw}

        def create(*args, **kwargs):
            return User.objects.create_user(username=username, password="p", email=email)

        with mock.patch.object(SocialRegistrationAdapter.__bases__[0], "save_user", side_effect=create):
            return self.adapter.save_user(request, mock.MagicMock(), form=None)

    def test_matching_provider_address_joins(self):
        link, raw = self.make_link()
        user = self._save(raw, "oauth_ok", "INVITEE.person@example.org")
        self.assertTrue(GroupMembership.objects.filter(group=self.group, user=user).exists())
        link.refresh_from_db()
        self.assertIsNotNone(link.used_at)

    def test_non_matching_provider_address_is_refused_and_rolled_back(self):
        link, raw = self.make_link()
        with self.assertRaises(ImmediateHttpResponse) as ctx:
            self._save(raw, "oauth_bad", "elsewhere@example.org")
        self.assertIn(f"auth_error={MISMATCH_CODE}", ctx.exception.response.url)
        self.assertFalse(User.objects.filter(username="oauth_bad").exists())
        link.refresh_from_db()
        self.assertIsNone(link.used_at)


class BoundGroupInviteJoinRaceTests(TransactionTestCase):
    """The address check sits inside the locked claim: a race between the
    invited account and another one still yields exactly one redemption."""

    def setUp(self):
        if connection.vendor == "sqlite":
            self.skipTest("SQLite does not support SELECT FOR UPDATE; this test requires PostgreSQL.")
        cache.clear()
        admin = User.objects.create_user(username="race_gadmin", password="p")
        self.group = Group.objects.create(name="Race Group", owner=admin)
        GroupMembership.objects.create(group=self.group, user=admin, role=GroupMembership.Role.ADMIN)
        self.link, self.raw = GroupInviteLink.generate(
            group=self.group, created_by=admin, role=GroupInviteLink.Role.MEMBER, single_use=True,
            delivery=GroupInviteLink.Delivery.EMAIL, expires_at=timezone.now() + timedelta(days=7),
            recipient_email=INVITED,
        )

    def tearDown(self):
        cache.clear()

    def test_invited_account_wins_against_another_account(self):
        invitee = User.objects.create_user(username="race_invitee", password="p", email=INVITED.lower())
        other = User.objects.create_user(username="race_other", password="p", email="other@example.org")
        results = []
        barrier = threading.Barrier(2)

        def run(user):
            from django.db import connections as _conns

            try:
                client = APIClient()
                client.force_authenticate(user)
                barrier.wait()
                results.append((user.username, client.post(join_url(self.raw)).status_code))
            finally:
                _conns.close_all()

        threads = [threading.Thread(target=run, args=(u,)) for u in (invitee, other)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        outcome = dict(results)
        self.assertEqual(outcome["race_invitee"], 201, results)
        # 403 if the other account took the lock first (mismatch, nothing
        # written); 410 if it queued behind the invitee and found it used.
        self.assertIn(outcome["race_other"], (403, 410), results)
        self.assertEqual(
            GroupMembership.objects.filter(group=self.group, user__in=[invitee, other]).count(), 1,
        )
        self.link.refresh_from_db()
        self.assertIsNotNone(self.link.used_at)
