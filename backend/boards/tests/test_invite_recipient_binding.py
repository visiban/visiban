"""Emailed board invites are bound to the invited address (#1678).

Covers the shared helper (``visiban/invite_recipient.py``), the board join
endpoint, REST and OAuth registration, and that the stored hash never reaches
an API response. The group side lives in
``groups/tests/test_group_invite_recipient_binding.py``.
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
from boards.models import Board, BoardInviteLink, BoardInviteRedemption, BoardMembership
from boards.tests.invite_fixtures import generate_invite
from visiban.invite_recipient import (
    MISMATCH_CODE,
    MISMATCH_DETAIL,
    REGISTRATION_MISMATCH_DETAIL,
    account_addresses,
    address_matches,
    hash_recipient,
)

PASSWORD = "Sup3rS3cr3t!xyz"
REGISTER_URL = "/api/v1/auth/registration/"
INVITED = "Invitee.Person@Example.org"


def set_mode(mode):
    row = SiteSetting.get()
    row.registration_mode = mode
    row.save()
    cache.clear()


def join_url(raw):
    return f"/api/v1/boards/join/{raw}/"


class HashHelperTests(TestCase):

    def test_hash_is_keyed_hex_and_never_the_address(self):
        value = hash_recipient(INVITED)
        self.assertRegex(value, r"^[0-9a-f]{64}$")
        self.assertNotIn("invitee", value.lower())

    def test_normalization_is_case_and_whitespace_insensitive(self):
        self.assertEqual(hash_recipient(INVITED), hash_recipient("  invitee.person@example.ORG "))
        self.assertNotEqual(hash_recipient(INVITED), hash_recipient("invitee.person+x@example.org"))

    def test_blank_address_stores_nothing(self):
        self.assertIsNone(hash_recipient(""))
        self.assertIsNone(hash_recipient(None))
        self.assertIsNone(hash_recipient("   "))

    def test_hash_depends_on_secret_key(self):
        with override_settings(SECRET_KEY="a" * 50):
            first = hash_recipient(INVITED)
        with override_settings(SECRET_KEY="b" * 50):
            self.assertNotEqual(first, hash_recipient(INVITED))

    def test_secret_key_fallbacks_still_match_after_rotation(self):
        with override_settings(SECRET_KEY="old" * 20):
            stored = hash_recipient(INVITED)
        with override_settings(SECRET_KEY="new" * 20, SECRET_KEY_FALLBACKS=["old" * 20]):
            self.assertTrue(address_matches(stored, [INVITED]))
        with override_settings(SECRET_KEY="new" * 20, SECRET_KEY_FALLBACKS=[]):
            self.assertFalse(address_matches(stored, [INVITED]))

    def test_account_addresses_by_verification_mode(self):
        user = User.objects.create_user(username="addr", password="p", email="primary@example.org")
        EmailAddress.objects.create(user=user, email="second@example.org", verified=True, primary=False)
        EmailAddress.objects.create(user=user, email="pending@example.org", verified=False, primary=False)
        with override_settings(ACCOUNT_EMAIL_VERIFICATION="optional"):
            self.assertEqual(account_addresses(user), {"primary@example.org", "second@example.org"})
        with override_settings(ACCOUNT_EMAIL_VERIFICATION="none"):
            self.assertEqual(account_addresses(user), {"primary@example.org", "second@example.org"})
        with override_settings(ACCOUNT_EMAIL_VERIFICATION="mandatory"):
            # User.email has no verified row: under mandatory it does not count,
            # and an unconfirmed pending address never does.
            self.assertEqual(account_addresses(user), {"second@example.org"})
            # At registration the signup address counts in every mode.
            self.assertEqual(
                account_addresses(user, at_registration=True), {"primary@example.org", "second@example.org"},
            )

    def test_mismatch_detail_is_neutral(self):
        self.assertNotIn("@", MISMATCH_DETAIL)


class _BoardFixture:
    def make_board(self, *, sender_is_site_admin=True):
        self.owner = User.objects.create_user(username="owner", password="p", email="owner@acme.test")
        self.sender = User.objects.create_user(
            username="sender", password="p", email="sender@acme.test", is_site_admin=sender_is_site_admin,
        )
        self.board = Board.objects.create(name="Launch Plan", owner=self.owner)
        BoardMembership.objects.create(board=self.board, user=self.sender, role=BoardMembership.Role.ADMIN)

    def make_invite(self, *, recipient=INVITED, delivery="email", single_use=True):
        # recipient=None on an emailed invite: a row minted before the column
        # existed (generate() itself refuses it; see invite_fixtures).
        return generate_invite(
            BoardInviteLink,
            board=self.board, created_by=self.sender, role="member",
            expires_at=timezone.now() + timedelta(days=7), single_use=single_use, delivery=delivery,
            recipient_email=recipient,
        )


class BoardJoinBindingTests(_BoardFixture, TestCase):

    def setUp(self):
        cache.clear()
        self.make_board()
        self.invitee = User.objects.create_user(username="invitee", password="p", email="invitee.person@example.org")
        self.other = User.objects.create_user(username="other", password="p", email="other@example.org")

    def tearDown(self):
        cache.clear()

    def _join(self, raw, user):
        client = APIClient()
        client.force_authenticate(user)
        return client.post(join_url(raw))

    def test_generate_refuses_an_emailed_invite_without_an_address(self):
        for recipient in (None, "", "   "):
            with self.subTest(recipient=recipient), self.assertRaises(ValueError):
                BoardInviteLink.generate(
                    board=self.board, created_by=self.sender, single_use=True,
                    delivery=BoardInviteLink.Delivery.EMAIL, recipient_email=recipient,
                )
        self.assertFalse(BoardInviteLink.objects.filter(board=self.board).exists())
        # A shareable link needs no address.
        link, _raw = BoardInviteLink.generate(board=self.board, created_by=self.sender)
        self.assertIsNone(link.recipient_hash)

    def test_generate_stores_only_the_keyed_hash(self):
        link, _raw = self.make_invite()
        self.assertEqual(link.recipient_hash, hash_recipient(INVITED))
        values = BoardInviteLink.objects.filter(pk=link.pk).values()[0]
        self.assertNotIn(INVITED.lower(), " ".join(str(v).lower() for v in values.values()))

    def test_matching_account_redeems_case_insensitively(self):
        link, raw = self.make_invite()
        r = self._join(raw, self.invitee)
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.content)
        self.assertTrue(BoardMembership.objects.filter(board=self.board, user=self.invitee).exists())
        link.refresh_from_db()
        self.assertIsNotNone(link.used_at)

    def test_non_matching_account_is_refused_and_invite_not_consumed(self):
        link, raw = self.make_invite()
        r = self._join(raw, self.other)
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN, r.content)
        self.assertEqual(r.json(), {"code": MISMATCH_CODE, "detail": MISMATCH_DETAIL})
        self.assertNotIn(INVITED.lower(), r.content.decode().lower())
        self.assertFalse(BoardMembership.objects.filter(board=self.board, user=self.other).exists())
        self.assertFalse(BoardInviteRedemption.objects.filter(invite=link).exists())
        link.refresh_from_db()
        self.assertIsNone(link.used_at)
        self.assertEqual(link.use_count, 0)
        # Still usable by the person it was sent to.
        self.assertEqual(self._join(raw, self.invitee).status_code, status.HTTP_201_CREATED)

    def test_existing_member_with_another_address_does_not_consume_it(self):
        BoardMembership.objects.create(board=self.board, user=self.other, role="viewer")
        link, raw = self.make_invite()
        self.assertEqual(self._join(raw, self.other).status_code, status.HTTP_403_FORBIDDEN)
        link.refresh_from_db()
        self.assertIsNone(link.used_at)

    def test_secondary_verified_address_matches(self):
        EmailAddress.objects.create(user=self.other, email="INVITEE.person@example.org", verified=True)
        _link, raw = self.make_invite()
        self.assertEqual(self._join(raw, self.other).status_code, status.HTTP_201_CREATED)

    @override_settings(ACCOUNT_EMAIL_VERIFICATION="mandatory")
    def test_mandatory_mode_requires_a_verified_address(self):
        _link, raw = self.make_invite()
        # User.email matches but is not verified.
        self.assertEqual(self._join(raw, self.invitee).status_code, status.HTTP_403_FORBIDDEN)
        EmailAddress.objects.create(user=self.invitee, email=self.invitee.email, verified=True, primary=True)
        self.assertEqual(self._join(raw, self.invitee).status_code, status.HTTP_201_CREATED)

    def test_unverified_secondary_address_does_not_match(self):
        EmailAddress.objects.create(user=self.other, email=INVITED, verified=False)
        _link, raw = self.make_invite()
        self.assertEqual(self._join(raw, self.other).status_code, status.HTTP_403_FORBIDDEN)

    def test_shareable_link_is_unbound(self):
        link, raw = self.make_invite(recipient=None, delivery="link", single_use=False)
        self.assertIsNone(link.recipient_hash)
        self.assertEqual(self._join(raw, self.other).status_code, status.HTTP_201_CREATED)

    def test_legacy_emailed_invite_without_hash_redeems_as_before(self):
        link, raw = self.make_invite(recipient=None)
        self.assertIsNone(link.recipient_hash)
        self.assertEqual(self._join(raw, self.other).status_code, status.HTTP_201_CREATED)

    def test_consumed_invite_follow_up_by_its_redeemer_is_unchanged(self):
        _link, raw = self.make_invite()
        self.assertEqual(self._join(raw, self.invitee).status_code, status.HTTP_201_CREATED)
        r = self._join(raw, self.invitee)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertTrue(r.json()["created"])
        # A consumed invite still answers 410 to someone without access.
        self.assertEqual(self._join(raw, self.other).status_code, status.HTTP_410_GONE)

    def test_preview_does_not_disclose_binding(self):
        _link, raw = self.make_invite()
        r = APIClient().get(join_url(raw))
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(set(r.json()), {"board_id", "board_name", "role", "can_register"})


@override_settings(
    INVITE_EMAIL_ENABLED=True, DEMO_MODE=False, FRONTEND_URL="https://kanban.acme.test",
)
class BoardSendBindsInviteTests(_BoardFixture, TestCase):

    def setUp(self):
        cache.clear()
        self.make_board()
        self.client = APIClient()
        self.client.force_authenticate(self.sender)

    def tearDown(self):
        cache.clear()

    def test_send_binds_invite_and_hash_never_leaves_the_server(self):
        r = self.client.post(
            f"/api/v1/boards/{self.board.pk}/invite-links/send/", {"email": INVITED}, format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_202_ACCEPTED, r.content)
        link = BoardInviteLink.objects.get(board=self.board, delivery="email")
        self.assertEqual(link.recipient_hash, hash_recipient(INVITED))
        raw = re.search(r"vbnb_[0-9a-f]{40}", mail.outbox[0].body).group(0)

        listing = self.client.get(f"/api/v1/boards/{self.board.pk}/invite-links/")
        self.assertEqual(listing.status_code, status.HTTP_200_OK)
        self.assertNotIn("recipient_hash", listing.json()[0])
        self.assertNotIn(link.recipient_hash, listing.content.decode())

        site_admin = User.objects.create_user(
            username="siteadm", password="p", is_site_admin=True, can_access_all_content=True,
        )
        admin_client = APIClient()
        admin_client.force_authenticate(site_admin)
        admin_listing = admin_client.get("/api/v1/admin/board-invite-links/")
        self.assertEqual(admin_listing.status_code, status.HTTP_200_OK, admin_listing.content)
        self.assertNotIn(link.recipient_hash, admin_listing.content.decode())
        self.assertNotIn("recipient_hash", admin_listing.content.decode())

        invitee = User.objects.create_user(username="inv", password="p", email="invitee.person@example.org")
        joiner = APIClient()
        joiner.force_authenticate(invitee)
        with mock.patch("boards.broadcast.broadcast_board_event") as bcast:
            with self.captureOnCommitCallbacks(execute=True):
                joined = joiner.post(join_url(raw))
        self.assertEqual(joined.status_code, status.HTTP_201_CREATED, joined.content)
        self.assertNotIn(link.recipient_hash, joined.content.decode())
        for call in bcast.call_args_list:
            self.assertNotIn(link.recipient_hash, repr(call))


class BoardSerializerFieldTests(TestCase):

    def test_invite_serializers_do_not_declare_recipient_hash(self):
        from boards.serializers import (
            AdminBoardInviteLinkSerializer,
            BoardInviteLinkCreateResponseSerializer,
            BoardInviteLinkSerializer,
        )

        for serializer in (
            BoardInviteLinkSerializer, BoardInviteLinkCreateResponseSerializer, AdminBoardInviteLinkSerializer,
        ):
            with self.subTest(serializer=serializer.__name__):
                self.assertNotIn("recipient_hash", serializer.Meta.fields)


class BoardRegistrationBindingTests(_BoardFixture, TestCase):

    def setUp(self):
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        self.make_board()

    def tearDown(self):
        set_mode(SiteSetting.RegistrationMode.OPEN)

    def _register(self, email, raw):
        return APIClient().post(REGISTER_URL, {
            "email": email, "password1": PASSWORD, "password2": PASSWORD, "invite_token": raw,
        })

    def test_matching_signup_address_registers_and_joins(self):
        link, raw = self.make_invite()
        r = self._register("INVITEE.PERSON@example.org", raw)
        self.assertIn(r.status_code, (201, 204), r.content)
        user = User.objects.get(email__iexact=INVITED)
        self.assertTrue(BoardMembership.objects.filter(board=self.board, user=user).exists())
        link.refresh_from_db()
        self.assertIsNotNone(link.used_at)

    def test_non_matching_signup_address_is_refused_and_rolled_back(self):
        link, raw = self.make_invite()
        r = self._register("someone.else@example.org", raw)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
        self.assertEqual(r.json(), {"email": [REGISTRATION_MISMATCH_DETAIL], "code": MISMATCH_CODE})
        self.assertFalse(User.objects.filter(email="someone.else@example.org").exists())
        link.refresh_from_db()
        self.assertIsNone(link.used_at)
        self.assertFalse(BoardInviteRedemption.objects.filter(invite=link).exists())
        # The invited address can still use it.
        self.assertIn(self._register(INVITED, raw).status_code, (201, 204))

    def test_form_errors_read_the_same_for_a_matching_and_a_wrong_address(self):
        link, raw = self.make_invite()
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
        _link, raw = self.make_invite(recipient=None)
        self.assertIn(self._register("anyone@example.org", raw).status_code, (201, 204))


class BoardOAuthBindingTests(_BoardFixture, TestCase):

    def setUp(self):
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        self.make_board()
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
        link, raw = self._invite()
        user = self._save(raw, "oauth_ok", "invitee.person@EXAMPLE.org")
        self.assertTrue(BoardMembership.objects.filter(board=self.board, user=user).exists())
        link.refresh_from_db()
        self.assertIsNotNone(link.used_at)

    def test_non_matching_provider_address_is_refused_and_rolled_back(self):
        link, raw = self._invite()
        with self.assertRaises(ImmediateHttpResponse) as ctx:
            self._save(raw, "oauth_bad", "elsewhere@example.org")
        self.assertIn(f"auth_error={MISMATCH_CODE}", ctx.exception.response.url)
        self.assertFalse(User.objects.filter(username="oauth_bad").exists())
        link.refresh_from_db()
        self.assertIsNone(link.used_at)

    def test_provider_without_an_address_is_refused(self):
        link, raw = self._invite()
        with self.assertRaises(ImmediateHttpResponse):
            self._save(raw, "oauth_noemail", "")
        link.refresh_from_db()
        self.assertIsNone(link.used_at)

    def _invite(self):
        return self.make_invite()


class BoundInviteJoinRaceTests(TransactionTestCase):
    """The address check sits inside the locked claim: a race between the
    invited account and another one still yields exactly one redemption."""

    def setUp(self):
        if connection.vendor == "sqlite":
            self.skipTest("SQLite does not support SELECT FOR UPDATE; this test requires PostgreSQL.")
        cache.clear()
        owner = User.objects.create_user(username="race_owner", password="p")
        sender = User.objects.create_user(username="race_sender", password="p", is_site_admin=True)
        self.board = Board.objects.create(name="Race Board", owner=owner)
        BoardMembership.objects.create(board=self.board, user=sender, role="admin")
        self.link, self.raw = BoardInviteLink.generate(
            board=self.board, created_by=sender, role="member", single_use=True, delivery="email",
            expires_at=timezone.now() + timedelta(days=7), recipient_email=INVITED,
        )

    def tearDown(self):
        cache.clear()

    def _race(self, users):
        results = []
        barrier = threading.Barrier(len(users))

        def run(user):
            from django.db import connections as _conns

            try:
                client = APIClient()
                client.force_authenticate(user)
                barrier.wait()
                results.append((user.username, client.post(join_url(self.raw)).status_code))
            finally:
                _conns.close_all()

        threads = [threading.Thread(target=run, args=(u,)) for u in users]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        return results

    def test_invited_account_wins_against_another_account(self):
        invitee = User.objects.create_user(username="race_invitee", password="p", email=INVITED.lower())
        other = User.objects.create_user(username="race_other", password="p", email="other@example.org")
        results = self._race([invitee, other])
        outcome = dict(results)
        self.assertEqual(outcome["race_invitee"], 201, results)
        # 403 if the other account took the lock first (mismatch, nothing
        # written); 410 if it queued behind the invitee and found it used.
        self.assertIn(outcome["race_other"], (403, 410), results)
        self.assertEqual(BoardInviteRedemption.objects.filter(invite=self.link).count(), 1)
        self.link.refresh_from_db()
        self.assertEqual(self.link.use_count, 1)

    def test_two_concurrent_joins_by_the_invited_account_redeem_once(self):
        invitee = User.objects.create_user(username="race_invitee", password="p", email=INVITED.lower())
        results = self._race([invitee, invitee])
        # One redeems (201); the other waits on the row lock, then finds the
        # invite consumed by this same account and is answered 200.
        self.assertEqual(sorted(code for _name, code in results), [200, 201], results)
        self.assertEqual(BoardInviteRedemption.objects.filter(invite=self.link).count(), 1)
        self.assertEqual(BoardMembership.objects.filter(board=self.board, user=invitee).count(), 1)
        self.link.refresh_from_db()
        self.assertEqual(self.link.use_count, 1)

