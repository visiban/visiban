"""Board invites by email (#1444).

- POST   /api/v1/boards/{id}/invite-links/send/
- GET    /api/v1/boards/{id}/invite-links/
- DELETE /api/v1/boards/{id}/invite-links/{link_id}/
- GET/POST /api/v1/boards/join/<token>/
"""
import smtplib
from datetime import timedelta
from unittest import mock

from django.core import mail
from django.core.cache import cache
from django.db import IntegrityError, transaction
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import SiteSetting, User
from boards import broadcast as board_broadcast
from boards.models import Board, BoardEvent, BoardInviteLink, BoardInviteRedemption, BoardMembership
from boards.views.invites import BOARD_MAX_PENDING_EMAILED_INVITES
from groups.models import Group, GroupMembership
from visiban.invite_email import (
    InviteEmailBoardThrottle,
    InviteEmailGlobalThrottle,
    InviteEmailUserThrottle,
)

RECIPIENT = "Invitee.Person@Example.org"


def send_url(board):
    return f"/api/v1/boards/{board.pk}/invite-links/send/"


def list_url(board):
    return f"/api/v1/boards/{board.pk}/invite-links/"


def revoke_url(board, link):
    return f"/api/v1/boards/{board.pk}/invite-links/{link.pk}/"


def join_url(token):
    return f"/api/v1/boards/join/{token}/"


def set_mode(mode):
    s = SiteSetting.get()
    s.registration_mode = mode
    s.save()


class _BoardFixture:
    def make_board(self):
        self.owner = User.objects.create_user(username="owner", password="pass", email="owner@acme.test")
        self.admin = User.objects.create_user(username="badmin", password="pass", email="badmin@acme.test")
        self.board = Board.objects.create(name="Launch Plan", owner=self.owner)
        BoardMembership.objects.create(board=self.board, user=self.admin, role=BoardMembership.Role.ADMIN)

    def make_invite(self, *, created_by=None, role="member", single_use=True, delivery="email",
                    expires_at="default"):
        if expires_at == "default":
            expires_at = timezone.now() + timedelta(days=7)
        return BoardInviteLink.generate(
            board=self.board, created_by=created_by or self.admin, role=role,
            expires_at=expires_at, single_use=single_use, delivery=delivery,
        )

    def client_for(self, user=None):
        client = APIClient()
        if user is not None:
            client.force_authenticate(user)
        return client


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------

class BoardInviteLinkModelTests(_BoardFixture, TestCase):

    def setUp(self):
        self.make_board()

    def test_generate_hashes_token_and_lookup_finds_it(self):
        link, raw = self.make_invite()
        self.assertTrue(raw.startswith("vbnb_"))
        self.assertEqual(len(raw), 5 + 40)
        self.assertEqual(link.prefix, raw[:8])
        self.assertNotEqual(link.token_hash, raw)
        self.assertEqual(BoardInviteLink.lookup_by_token(raw).pk, link.pk)
        self.assertIsNone(BoardInviteLink.lookup_by_token("vbnb_nope"))

    def test_lookup_returns_revoked_invites_too(self):
        link, raw = self.make_invite()
        BoardInviteLink.objects.filter(pk=link.pk).update(revoked_at=timezone.now())
        self.assertEqual(BoardInviteLink.lookup_by_token(raw).status, "revoked")

    def test_status_precedence(self):
        link, _ = self.make_invite()
        self.assertEqual(link.status, "pending")
        link.expires_at = timezone.now() - timedelta(minutes=1)
        self.assertEqual(link.status, "expired")
        link.used_at = timezone.now()
        self.assertEqual(link.status, "used")
        link.revoked_at = timezone.now()
        self.assertEqual(link.status, "revoked")

    def test_used_at_requires_single_use(self):
        link, _ = self.make_invite(single_use=False)
        with self.assertRaises(IntegrityError), transaction.atomic():
            BoardInviteLink.objects.filter(pk=link.pk).update(used_at=timezone.now())

    def test_redemption_unique_per_user(self):
        link, _ = self.make_invite()
        user = User.objects.create_user(username="u1", password="p")
        BoardInviteRedemption.objects.create(invite=link, user=user, role_granted="member", via="join")
        with self.assertRaises(IntegrityError), transaction.atomic():
            BoardInviteRedemption.objects.create(invite=link, user=user, role_granted="member", via="join")


# ---------------------------------------------------------------------------
# Send
# ---------------------------------------------------------------------------

@override_settings(
    INVITE_EMAIL_ENABLED=True,
    DEMO_MODE=False,
    FRONTEND_URL="https://kanban.acme.test",
    DEFAULT_FROM_EMAIL="invites@acme.test",
)
class BoardInviteSendTests(_BoardFixture, TestCase):

    def setUp(self):
        cache.clear()
        self.make_board()
        self.client = self.client_for(self.admin)

    def tearDown(self):
        cache.clear()

    def _send(self, client=None, **body):
        body.setdefault("email", RECIPIENT)
        return (client or self.client).post(send_url(self.board), body, format="json")

    def test_send_mints_single_use_email_invite_and_mails_join_url(self):
        r = self._send(role="viewer", expiry_days=30)
        self.assertEqual(r.status_code, status.HTTP_202_ACCEPTED, r.content)
        self.assertEqual(r.json(), {"detail": "Invite sent", "sent_to": "Invitee.Person@Example.org"})
        link = BoardInviteLink.objects.get(board=self.board)
        self.assertEqual(link.role, "viewer")
        self.assertTrue(link.single_use)
        self.assertEqual(link.delivery, "email")
        self.assertEqual(link.created_by, self.admin)
        self.assertAlmostEqual(
            (link.expires_at - timezone.now()).total_seconds(), timedelta(days=30).total_seconds(), delta=60,
        )
        self.assertEqual(len(mail.outbox), 1)
        msg = mail.outbox[0]
        self.assertEqual(msg.to, ["Invitee.Person@Example.org"])
        self.assertIn("Launch Plan", msg.subject)
        self.assertIn("https://kanban.acme.test/join/vbnb_", msg.body)
        self.assertIn("badmin", msg.body)
        # The raw token never comes back in the response.
        self.assertNotIn("vbnb_", r.content.decode())

    def test_defaults_member_and_seven_days(self):
        self._send()
        link = BoardInviteLink.objects.get(board=self.board)
        self.assertEqual(link.role, "member")
        self.assertAlmostEqual(
            (link.expires_at - timezone.now()).total_seconds(), timedelta(days=7).total_seconds(), delta=60,
        )

    def test_role_validation_refuses_admin_and_moderator(self):
        for role in ("admin", "moderator", "site_admin", "owner"):
            with self.subTest(role=role):
                r = self._send(role=role)
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn("role", r.json())
        self.assertFalse(BoardInviteLink.objects.exists())
        self.assertEqual(len(mail.outbox), 0)

    def test_expiry_days_must_be_1_7_or_30(self):
        for days in (0, 2, 14, 31, 365, None, "never"):
            with self.subTest(days=days):
                r = self._send(expiry_days=days)
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn("expiry_days", r.json())
        for days in (1, 7, 30):
            with self.subTest(days=days):
                self.assertEqual(self._send(expiry_days=days).status_code, status.HTTP_202_ACCEPTED)

    def test_invalid_email_rejected(self):
        for bad in ("", "not-an-email", "a@b.c, d@e.f", "a@b.c\r\nBcc: x@y.z"):
            with self.subTest(email=bad):
                self.assertEqual(self._send(email=bad).status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(len(mail.outbox), 0)

    def test_identical_response_regardless_of_address(self):
        member = User.objects.create_user(username="m", password="p", email="member@acme.test")
        BoardMembership.objects.create(board=self.board, user=member, role="member")
        User.objects.create_user(username="other", password="p", email="other@acme.test")
        bodies = []
        for addr in ("member@acme.test", "other@acme.test", "nobody@acme.test"):
            r = self._send(email=addr)
            self.assertEqual(r.status_code, status.HTTP_202_ACCEPTED)
            body = r.json()
            body.pop("sent_to")
            bodies.append(body)
        self.assertEqual(bodies[0], bodies[1])
        self.assertEqual(bodies[1], bodies[2])
        self.assertEqual(len(mail.outbox), 3)

    @override_settings(INVITE_EMAIL_ENABLED=False)
    def test_feature_gate_off(self):
        r = self._send()
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(r.json()["code"], "invite_email_disabled")
        self.assertEqual(len(mail.outbox), 0)

    @override_settings(DEMO_MODE=True)
    def test_demo_mode_refuses(self):
        self.assertEqual(self._send().status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(len(mail.outbox), 0)

    # -- cap and throttles ------------------------------------------------

    def test_cap_enforced_and_ignores_dead_invites(self):
        future = timezone.now() + timedelta(days=7)
        links = [
            self.make_invite(expires_at=future)[0]
            for _ in range(BOARD_MAX_PENDING_EMAILED_INVITES)
        ]
        r = self._send()
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(r.json()["code"], "invite_email_cap_reached")
        self.assertEqual(len(mail.outbox), 0)
        BoardInviteLink.objects.filter(pk=links[0].pk).update(revoked_at=timezone.now())
        self.assertEqual(self._send().status_code, status.HTTP_202_ACCEPTED)

    def test_cap_reached_does_not_spend_budget(self):
        future = timezone.now() + timedelta(days=7)
        links = [self.make_invite(expires_at=future)[0] for _ in range(BOARD_MAX_PENDING_EMAILED_INVITES)]
        with mock.patch.object(InviteEmailUserThrottle, "get_rate", return_value="1/hour"):
            for _ in range(3):
                self.assertEqual(self._send().status_code, status.HTTP_400_BAD_REQUEST)
            BoardInviteLink.objects.filter(pk=links[0].pk).update(used_at=timezone.now())
            self.assertEqual(self._send().status_code, status.HTTP_202_ACCEPTED)

    def test_per_board_throttle_shared_by_admins(self):
        other_board = Board.objects.create(name="Other", owner=self.admin)
        with mock.patch.object(InviteEmailBoardThrottle, "get_rate", return_value="2/day"):
            self.assertEqual(self._send().status_code, status.HTTP_202_ACCEPTED)
            self.assertEqual(self._send(client=self.client_for(self.owner)).status_code, status.HTTP_202_ACCEPTED)
            self.assertEqual(self._send().status_code, status.HTTP_429_TOO_MANY_REQUESTS)
            r = self.client.post(send_url(other_board), {"email": RECIPIENT}, format="json")
            self.assertEqual(r.status_code, status.HTTP_202_ACCEPTED)

    def test_board_sends_draw_from_global_non_site_budget(self):
        with mock.patch.object(InviteEmailGlobalThrottle, "get_rate", return_value="1/day"):
            self.assertEqual(self._send().status_code, status.HTTP_202_ACCEPTED)
            self.assertEqual(self._send().status_code, status.HTTP_429_TOO_MANY_REQUESTS)

    def test_non_admin_requests_do_not_spend_board_budget(self):
        member = User.objects.create_user(username="plain", password="p")
        BoardMembership.objects.create(board=self.board, user=member, role="member")
        with mock.patch.object(InviteEmailBoardThrottle, "get_rate", return_value="1/day"):
            for _ in range(3):
                self.assertEqual(self._send(client=self.client_for(member)).status_code, status.HTTP_403_FORBIDDEN)
            self.assertEqual(self._send().status_code, status.HTTP_202_ACCEPTED)

    def test_failed_send_revokes_refunds_and_returns_502(self):
        with mock.patch.object(InviteEmailUserThrottle, "get_rate", return_value="1/hour"), \
                mock.patch.object(InviteEmailBoardThrottle, "get_rate", return_value="1/day"):
            with mock.patch(
                "django.core.mail.backends.locmem.EmailBackend.send_messages",
                side_effect=smtplib.SMTPAuthenticationError(535, b"AUTH PLAIN c2VjcmV0 rejected"),
            ):
                for _ in range(2):
                    r = self._send()
                    self.assertEqual(r.status_code, status.HTTP_502_BAD_GATEWAY)
                    self.assertEqual(r.json()["code"], "auth_failed")
                    self.assertNotIn("c2VjcmV0", r.content.decode())
            self.assertTrue(all(link.status == "revoked" for link in BoardInviteLink.objects.all()))
            self.assertTrue(all(link.revoked_by_id == self.admin.pk for link in BoardInviteLink.objects.all()))
            # The refund leaves the whole budget for a retry once mail works.
            self.assertEqual(self._send().status_code, status.HTTP_202_ACCEPTED)
            self.assertEqual(self._send().status_code, status.HTTP_429_TOO_MANY_REQUESTS)

    def test_created_and_revoked_events_broadcast_on_commit(self):
        with mock.patch("boards.broadcast.broadcast_board_event") as bcast:
            with self.captureOnCommitCallbacks(execute=True):
                self._send()
        link = BoardInviteLink.objects.get(board=self.board)
        bcast.assert_called_once()
        self.assertEqual(bcast.call_args.args[:3], (self.board.pk, board_broadcast.EVT_INVITE_LINK_CREATED, {"id": link.pk}))

        with mock.patch("boards.broadcast.broadcast_board_event") as bcast, \
                mock.patch("django.core.mail.backends.locmem.EmailBackend.send_messages",
                           side_effect=ConnectionRefusedError()):
            with self.captureOnCommitCallbacks(execute=True):
                self._send()
        events = [c.args[1] for c in bcast.call_args_list]
        self.assertEqual(events, [board_broadcast.EVT_INVITE_LINK_CREATED, board_broadcast.EVT_INVITE_LINK_REVOKED])


# ---------------------------------------------------------------------------
# List and revoke
# ---------------------------------------------------------------------------

class BoardInviteListRevokeTests(_BoardFixture, TestCase):

    def setUp(self):
        cache.clear()
        set_mode(SiteSetting.RegistrationMode.OPEN)
        self.make_board()
        self.client = self.client_for(self.admin)

    def tearDown(self):
        set_mode(SiteSetting.RegistrationMode.OPEN)
        cache.clear()

    def test_list_fields_newest_first(self):
        older, _ = self.make_invite(role="viewer")
        BoardInviteLink.objects.filter(pk=older.pk).update(created_at=timezone.now() - timedelta(days=1))
        newer, _ = self.make_invite()
        r = self.client.get(list_url(self.board))
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        rows = r.json()
        self.assertIsInstance(rows, list)
        self.assertEqual([row["id"] for row in rows], [newer.pk, older.pk])
        self.assertEqual(set(rows[0]), {
            "id", "prefix", "name", "role", "delivery", "created_at", "created_by_username",
            "expires_at", "is_expired", "single_use", "used_at", "status", "can_register",
            "use_count",
        })
        self.assertEqual(rows[0]["created_by_username"], "badmin")
        self.assertEqual(rows[0]["status"], "pending")
        self.assertIs(rows[0]["can_register"], True)
        self.assertNotIn("token_hash", rows[0])

    def test_created_by_username_null_when_sender_deleted(self):
        self.make_invite(created_by=self.owner)
        BoardInviteLink.objects.update(created_by=None)
        self.assertIsNone(self.client.get(list_url(self.board)).json()[0]["created_by_username"])

    def test_can_register_reflects_current_mode(self):
        self.make_invite()
        set_mode(SiteSetting.RegistrationMode.CLOSED)
        self.assertIs(self.client.get(list_url(self.board)).json()[0]["can_register"], False)
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        # Sender is a board admin but not a site admin.
        self.assertIs(self.client.get(list_url(self.board)).json()[0]["can_register"], False)
        self.admin.is_site_admin = True
        self.admin.save(update_fields=["is_site_admin"])
        self.assertIs(self.client.get(list_url(self.board)).json()[0]["can_register"], True)

    def test_revoke_sets_revoked_by_and_broadcasts(self):
        link, _ = self.make_invite(created_by=self.owner)
        with mock.patch("boards.broadcast.broadcast_board_event") as bcast:
            with self.captureOnCommitCallbacks(execute=True):
                r = self.client.delete(revoke_url(self.board, link))
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        link.refresh_from_db()
        self.assertEqual(link.status, "revoked")
        self.assertEqual(link.revoked_by, self.admin)
        bcast.assert_called_once()
        self.assertEqual(bcast.call_args.args[:3], (self.board.pk, board_broadcast.EVT_INVITE_LINK_REVOKED, {"id": link.pk}))
        self.assertTrue(BoardEvent.objects.filter(board_id=self.board.pk, event="invite_link.revoked").exists())

    def test_revoke_consumed_invite_is_400(self):
        link, _ = self.make_invite()
        BoardInviteLink.objects.filter(pk=link.pk).update(used_at=timezone.now())
        r = self.client.delete(revoke_url(self.board, link))
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        link.refresh_from_db()
        self.assertEqual(link.status, "used")

    def test_revoke_already_revoked_or_other_board_is_404(self):
        link, _ = self.make_invite()
        BoardInviteLink.objects.filter(pk=link.pk).update(revoked_at=timezone.now())
        self.assertEqual(self.client.delete(revoke_url(self.board, link)).status_code, status.HTTP_404_NOT_FOUND)
        other = Board.objects.create(name="Other", owner=self.admin)
        live, _ = self.make_invite()
        self.assertEqual(
            self.client.delete(f"/api/v1/boards/{other.pk}/invite-links/{live.pk}/").status_code,
            status.HTTP_404_NOT_FOUND,
        )


# ---------------------------------------------------------------------------
# Preview and join
# ---------------------------------------------------------------------------

class BoardJoinTests(_BoardFixture, TestCase):

    def setUp(self):
        cache.clear()
        set_mode(SiteSetting.RegistrationMode.OPEN)
        self.make_board()
        self.newcomer = User.objects.create_user(username="newcomer", password="p")

    def tearDown(self):
        cache.clear()

    # -- preview ----------------------------------------------------------

    def test_preview_is_public(self):
        _link, raw = self.make_invite(role="collaborator")
        r = APIClient().get(join_url(raw))
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json(), {
            "board_id": self.board.pk, "board_name": "Launch Plan", "role": "collaborator", "can_register": True,
        })

    def test_preview_unknown_token_404(self):
        self.assertEqual(APIClient().get(join_url("vbnb_" + "0" * 40)).status_code, status.HTTP_404_NOT_FOUND)

    def test_preview_410_codes(self):
        used, used_raw = self.make_invite()
        BoardInviteLink.objects.filter(pk=used.pk).update(used_at=timezone.now())
        _exp, exp_raw = self.make_invite(expires_at=timezone.now() - timedelta(minutes=1))
        rev, rev_raw = self.make_invite()
        BoardInviteLink.objects.filter(pk=rev.pk).update(revoked_at=timezone.now())
        for raw, code in ((used_raw, "used"), (exp_raw, "expired"), (rev_raw, "revoked")):
            with self.subTest(code=code):
                r = APIClient().get(join_url(raw))
                self.assertEqual(r.status_code, status.HTTP_410_GONE)
                self.assertEqual(r.json()["code"], code)
                self.assertNotIn("can_register", r.json())

    def test_preview_of_invite_whose_sender_lost_admin_is_revoked(self):
        _link, raw = self.make_invite()
        BoardMembership.objects.filter(board=self.board, user=self.admin).update(role="viewer")
        r = APIClient().get(join_url(raw))
        self.assertEqual(r.status_code, status.HTTP_410_GONE)
        self.assertEqual(r.json()["code"], "revoked")

    # -- join: access rule ------------------------------------------------

    def _join(self, raw, user):
        return self.client_for(user).post(join_url(raw))

    def test_join_without_access_creates_membership(self):
        link, raw = self.make_invite(role="collaborator")
        with mock.patch("boards.broadcast.broadcast_board_event") as bcast:
            with self.captureOnCommitCallbacks(execute=True):
                r = self._join(raw, self.newcomer)
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.content)
        self.assertEqual(r.json(), {
            "board_id": self.board.pk, "board_name": "Launch Plan", "role": "collaborator", "created": True,
        })
        self.assertEqual(BoardMembership.objects.get(board=self.board, user=self.newcomer).role, "collaborator")
        link.refresh_from_db()
        self.assertIsNotNone(link.used_at)
        self.assertEqual(link.use_count, 1)
        redemption = BoardInviteRedemption.objects.get(invite=link)
        self.assertEqual(
            (redemption.user, redemption.role_granted, redemption.membership_created, redemption.via),
            (self.newcomer, "collaborator", True, "join"),
        )
        bcast.assert_called_once()
        board_id, event, payload = bcast.call_args.args
        self.assertEqual((board_id, event), (self.board.pk, board_broadcast.EVT_MEMBER_ADDED))
        self.assertEqual(payload["user"]["id"], self.newcomer.pk)
        self.assertEqual(payload["role"], "collaborator")
        self.assertEqual(payload["invite"], {"id": link.pk, "created_by_id": self.admin.pk})
        self.assertEqual(bcast.call_args.kwargs["event_id"], BoardEvent.objects.get(event="member.added").pk)

    def test_join_grants_no_group_membership(self):
        group = Group.objects.create(name="G", owner=self.owner)
        self.board.group = group
        self.board.save(update_fields=["group"])
        _link, raw = self.make_invite()
        self.assertEqual(self._join(raw, self.newcomer).status_code, status.HTTP_201_CREATED)
        self.assertFalse(GroupMembership.objects.filter(user=self.newcomer).exists())

    def _inherit(self, user, group_role):
        group = Group.objects.create(name=f"G-{user.username}", owner=self.owner)
        GroupMembership.objects.create(group=group, user=user, role=group_role)
        self.board.group = group
        self.board.save(update_fields=["group"])

    def test_lower_inherited_role_gets_explicit_membership(self):
        self._inherit(self.newcomer, GroupMembership.Role.VIEWER)
        _link, raw = self.make_invite(role="member")
        r = self._join(raw, self.newcomer)
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertTrue(r.json()["created"])
        self.assertEqual(BoardMembership.objects.get(board=self.board, user=self.newcomer).role, "member")

    def test_group_admin_redeeming_viewer_invite_is_not_downgraded(self):
        self._inherit(self.newcomer, GroupMembership.Role.ADMIN)
        link, raw = self.make_invite(role="viewer")
        with mock.patch("boards.broadcast.broadcast_board_event") as bcast:
            with self.captureOnCommitCallbacks(execute=True):
                r = self._join(raw, self.newcomer)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertFalse(r.json()["created"])
        self.assertFalse(BoardMembership.objects.filter(board=self.board, user=self.newcomer).exists())
        bcast.assert_not_called()
        redemption = BoardInviteRedemption.objects.get(invite=link)
        self.assertFalse(redemption.membership_created)

    def test_equal_inherited_role_is_left_alone(self):
        self._inherit(self.newcomer, GroupMembership.Role.MEMBER)
        _link, raw = self.make_invite(role="member")
        r = self._join(raw, self.newcomer)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertFalse(r.json()["created"])
        self.assertFalse(BoardMembership.objects.filter(board=self.board, user=self.newcomer).exists())

    def test_existing_explicit_membership_is_never_changed(self):
        BoardMembership.objects.create(board=self.board, user=self.newcomer, role="viewer")
        _link, raw = self.make_invite(role="member")
        r = self._join(raw, self.newcomer)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertFalse(r.json()["created"])
        self.assertEqual(BoardMembership.objects.get(board=self.board, user=self.newcomer).role, "viewer")

    def test_owner_and_all_content_admin_get_created_false(self):
        site_admin = User.objects.create_user(username="sa", password="p")
        site_admin.can_access_all_content = True
        site_admin.save(update_fields=["can_access_all_content"])
        for user in (self.owner, site_admin):
            with self.subTest(user=user.username):
                _link, raw = self.make_invite()
                r = self._join(raw, user)
                self.assertEqual(r.status_code, status.HTTP_200_OK)
                self.assertFalse(r.json()["created"])
        self.assertFalse(BoardMembership.objects.filter(user__in=[self.owner, site_admin]).exists())

    # -- join: refusals ---------------------------------------------------

    def test_join_unknown_404_and_anonymous_refused(self):
        self.assertEqual(self._join("vbnb_" + "0" * 40, self.newcomer).status_code, status.HTTP_404_NOT_FOUND)
        _link, raw = self.make_invite()
        self.assertIn(APIClient().post(join_url(raw)).status_code, (401, 403))

    def test_join_410_codes(self):
        used, used_raw = self.make_invite()
        BoardInviteLink.objects.filter(pk=used.pk).update(used_at=timezone.now())
        _exp, exp_raw = self.make_invite(expires_at=timezone.now() - timedelta(minutes=1))
        rev, rev_raw = self.make_invite()
        BoardInviteLink.objects.filter(pk=rev.pk).update(revoked_at=timezone.now())
        for raw, code in ((used_raw, "used"), (exp_raw, "expired"), (rev_raw, "revoked")):
            with self.subTest(code=code):
                r = self._join(raw, self.newcomer)
                self.assertEqual(r.status_code, status.HTTP_410_GONE)
                self.assertEqual(r.json()["code"], code)
        self.assertFalse(BoardMembership.objects.filter(user=self.newcomer).exists())

    def test_creator_demoted_or_deactivated_is_refused(self):
        _link, raw = self.make_invite()
        BoardMembership.objects.filter(board=self.board, user=self.admin).update(role="member")
        r = self._join(raw, self.newcomer)
        self.assertEqual(r.status_code, status.HTTP_410_GONE)
        self.assertEqual(r.json()["code"], "revoked")

        BoardMembership.objects.filter(board=self.board, user=self.admin).update(role="admin")
        self.admin.is_active = False
        self.admin.save(update_fields=["is_active"])
        r = self._join(raw, self.newcomer)
        self.assertEqual(r.status_code, status.HTTP_410_GONE)
        self.assertFalse(BoardMembership.objects.filter(user=self.newcomer).exists())

    def test_used_single_use_invite_answers_its_redeemer(self):
        link, raw = self.make_invite()
        self.assertEqual(self._join(raw, self.newcomer).status_code, status.HTTP_201_CREATED)
        used_at = BoardInviteLink.objects.get(pk=link.pk).used_at
        preview = self.client_for(self.newcomer).get(join_url(raw))
        self.assertEqual(preview.status_code, status.HTTP_200_OK)
        r = self._join(raw, self.newcomer)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertTrue(r.json()["created"])  # this invite did create their membership
        link.refresh_from_db()
        self.assertEqual(link.used_at, used_at)
        self.assertEqual(link.use_count, 1)
        self.assertEqual(BoardInviteRedemption.objects.filter(invite=link).count(), 1)
        # A stranger still gets 410 used.
        stranger = User.objects.create_user(username="stranger", password="p")
        self.assertEqual(self._join(raw, stranger).json()["code"], "used")

    def test_join_throttle_shares_join_group_bucket(self):
        from groups.views import JoinGroupRateThrottle

        _link, raw = self.make_invite()
        with mock.patch.object(JoinGroupRateThrottle, "get_rate", return_value="2/hour"):
            client = APIClient()
            self.assertEqual(client.get("/api/v1/groups/join/vbng_nothing/").status_code, status.HTTP_404_NOT_FOUND)
            self.assertEqual(client.get(join_url(raw)).status_code, status.HTTP_200_OK)
            self.assertEqual(client.get(join_url(raw)).status_code, status.HTTP_429_TOO_MANY_REQUESTS)


# ---------------------------------------------------------------------------
# Deactivation
# ---------------------------------------------------------------------------

class DeactivationRevokesBoardInvitesTests(_BoardFixture, TestCase):

    def setUp(self):
        self.make_board()
        self.site_admin = User.objects.create_user(username="root", password="p")
        self.site_admin.is_site_admin = True
        self.site_admin.save(update_fields=["is_site_admin"])

    def test_deactivating_sender_revokes_pending_invites_only(self):
        pending, _ = self.make_invite()
        used, _ = self.make_invite()
        BoardInviteLink.objects.filter(pk=used.pk).update(used_at=timezone.now())
        others, _ = self.make_invite(created_by=self.owner)
        with mock.patch("boards.broadcast.broadcast_board_event") as bcast:
            with self.captureOnCommitCallbacks(execute=True):
                r = self.client_for(self.site_admin).post(f"/api/v1/admin/users/{self.admin.pk}/deactivate/", {}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        statuses = {link.pk: link.status for link in BoardInviteLink.objects.all()}
        self.assertEqual(statuses, {pending.pk: "revoked", used.pk: "used", others.pk: "pending"})
        self.assertEqual(BoardInviteLink.objects.get(pk=pending.pk).revoked_by, self.site_admin)
        bcast.assert_called_once()
        self.assertEqual(bcast.call_args.args[:3], (self.board.pk, board_broadcast.EVT_INVITE_LINK_REVOKED, {"id": pending.pk}))


# ---------------------------------------------------------------------------
# RBAC matrix across list / send / revoke (pre-MR gate, #1444)
# ---------------------------------------------------------------------------

@override_settings(INVITE_EMAIL_ENABLED=True, DEMO_MODE=False, DEFAULT_FROM_EMAIL="invites@acme.test")
class BoardInviteRbacMatrixTests(_BoardFixture, TestCase):
    """Exact status codes, matching the existing ``/members/`` endpoint: a user
    with no access to the board gets 403 (``get_board_for_user`` resolves the
    board by pk, then refuses a None role), a missing board is 404, and an
    anonymous caller is 401 (token auth's ``WWW-Authenticate`` header)."""

    def setUp(self):
        cache.clear()
        self.make_board()
        group_admin = User.objects.create_user(username="gadmin", password="p")
        group = Group.objects.create(name="G", owner=group_admin)
        GroupMembership.objects.create(group=group, user=group_admin, role=GroupMembership.Role.ADMIN)
        self.board.group = group
        self.board.save(update_fields=["group"])
        site_admin = User.objects.create_user(username="sa", password="p")
        site_admin.can_access_all_content = True
        site_admin.save(update_fields=["can_access_all_content"])
        self.allowed = {
            "owner": self.owner, "explicit_admin": self.admin,
            "group_admin": group_admin, "all_content_site_admin": site_admin,
        }
        self.denied = {}
        for role in ("member", "collaborator", "viewer"):
            user = User.objects.create_user(username=f"r_{role}", password="p")
            BoardMembership.objects.create(board=self.board, user=user, role=role)
            self.denied[role] = user
        moderator = User.objects.create_user(username="mod", password="p")
        BoardMembership.objects.create(board=self.board, user=moderator, role="member", is_moderator=True)
        self.denied["moderator_member"] = moderator
        self.denied["non_member"] = User.objects.create_user(username="outsider", password="p")

    def tearDown(self):
        cache.clear()

    def _call(self, client, endpoint, board_pk=None):
        board_pk = board_pk or self.board.pk
        if endpoint == "list":
            return client.get(f"/api/v1/boards/{board_pk}/invite-links/")
        if endpoint == "send":
            return client.post(f"/api/v1/boards/{board_pk}/invite-links/send/", {"email": RECIPIENT}, format="json")
        if endpoint == "create":
            return client.post(f"/api/v1/boards/{board_pk}/invite-links/", {"expiry_days": 7}, format="json")
        link, _ = self.make_invite()
        return client.delete(f"/api/v1/boards/{board_pk}/invite-links/{link.pk}/")

    def test_members_endpoint_baseline_for_non_member_is_403(self):
        r = self.client_for(self.denied["non_member"]).post(
            f"/api/v1/boards/{self.board.pk}/members/", {"user_id": self.owner.pk}, format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_allowed_set(self):
        expected = {"list": 200, "send": 202, "revoke": 204, "create": 201}
        for endpoint, code in expected.items():
            for label, user in self.allowed.items():
                with self.subTest(endpoint=endpoint, user=label):
                    self.assertEqual(self._call(self.client_for(user), endpoint).status_code, code)

    def test_denied_set(self):
        for endpoint in ("list", "send", "revoke", "create"):
            for label, user in self.denied.items():
                with self.subTest(endpoint=endpoint, user=label):
                    self.assertEqual(
                        self._call(self.client_for(user), endpoint).status_code, status.HTTP_403_FORBIDDEN,
                    )
            with self.subTest(endpoint=endpoint, user="anonymous"):
                self.assertEqual(self._call(APIClient(), endpoint).status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(len(mail.outbox), 0)
        self.assertFalse(BoardInviteLink.objects.filter(revoked_at__isnull=False).exists())
        self.assertFalse(BoardInviteLink.objects.filter(delivery="link").exists())

    def test_nonexistent_board_is_404(self):
        for endpoint in ("list", "send", "revoke", "create"):
            with self.subTest(endpoint=endpoint):
                r = self._call(self.client_for(self.admin), endpoint, board_pk=999999)
                self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)


# ---------------------------------------------------------------------------
# Role enforcement below the serializer
# ---------------------------------------------------------------------------

class BoardInviteRoleEnforcementTests(_BoardFixture, TestCase):

    def setUp(self):
        cache.clear()
        self.make_board()
        self.newcomer = User.objects.create_user(username="newcomer", password="p")

    def test_generate_refuses_non_grantable_roles(self):
        for role in ("admin", "moderator", "site_admin", "owner"):
            with self.subTest(role=role), self.assertRaises(ValueError):
                BoardInviteLink.generate(board=self.board, created_by=self.admin, role=role)
        self.assertFalse(BoardInviteLink.objects.exists())

    def test_admin_role_written_directly_is_never_honored(self):
        from accounts.invite_utils import InviteTokenError
        from boards import invites

        link, raw = self.make_invite()
        BoardInviteLink.objects.filter(pk=link.pk).update(role="admin")
        link.refresh_from_db()
        self.assertEqual(self.client_for(self.newcomer).get(join_url(raw)).json()["code"], "revoked")
        r = self.client_for(self.newcomer).post(join_url(raw))
        self.assertEqual(r.status_code, status.HTTP_410_GONE)
        with self.assertRaises(InviteTokenError):
            invites.redeem(link, self.newcomer, self.board, via="join")
        self.assertEqual(invites.board_link_registration_refusal(link), "invite_invalid")
        self.assertFalse(BoardMembership.objects.filter(user=self.newcomer).exists())
        link.refresh_from_db()
        self.assertIsNone(link.used_at)


# ---------------------------------------------------------------------------
# List: bounded history and constant query count
# ---------------------------------------------------------------------------

class BoardInviteListScalingTests(_BoardFixture, TestCase):

    def setUp(self):
        cache.clear()
        self.make_board()
        self.admin.is_site_admin = True
        self.admin.save(update_fields=["is_site_admin"])
        self.client = self.client_for(self.admin)

    def tearDown(self):
        set_mode(SiteSetting.RegistrationMode.OPEN)
        cache.clear()

    def _count_queries(self):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        cache.clear()
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(list_url(self.board))
        self.assertEqual(r.status_code, 200)
        return len(ctx.captured_queries), r.json()

    def test_query_count_does_not_grow_with_rows(self):
        # INVITE_ONLY + site-admin sender: every row takes the full
        # can_register path (sender role re-check).
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        self.make_invite()
        one, rows = self._count_queries()
        self.assertIs(rows[0]["can_register"], True)
        for _ in range(9):
            self.make_invite()
        ten, rows = self._count_queries()
        self.assertEqual(len(rows), 10)
        self.assertEqual(one, ten)

    def test_all_pending_plus_fifty_most_recent_past(self):
        from boards.views.invites import BOARD_INVITE_LIST_MAX_PAST

        base = timezone.now() - timedelta(days=10)
        past_ids = []
        for i in range(BOARD_INVITE_LIST_MAX_PAST + 5):
            link, _ = self.make_invite()
            BoardInviteLink.objects.filter(pk=link.pk).update(
                revoked_at=timezone.now(), created_at=base + timedelta(minutes=i),
            )
            past_ids.append(link.pk)
        old_pending, _ = self.make_invite()
        BoardInviteLink.objects.filter(pk=old_pending.pk).update(created_at=base - timedelta(days=30))
        new_pending, _ = self.make_invite()
        _n, rows = self._count_queries()
        ids = [row["id"] for row in rows]
        self.assertEqual(len(rows), 2 + BOARD_INVITE_LIST_MAX_PAST)
        self.assertIn(old_pending.pk, ids)  # pending is never cut, however old
        self.assertEqual(ids[0], new_pending.pk)
        self.assertEqual(set(ids) & set(past_ids), set(past_ids[-BOARD_INVITE_LIST_MAX_PAST:]))
        created = [row["created_at"] for row in rows]
        self.assertEqual(created, sorted(created, reverse=True))


# ---------------------------------------------------------------------------
# Change feed visibility of invite events
# ---------------------------------------------------------------------------

@override_settings(INVITE_EMAIL_ENABLED=True, DEMO_MODE=False, DEFAULT_FROM_EMAIL="invites@acme.test")
class BoardInviteFeedVisibilityTests(_BoardFixture, TestCase):

    def test_non_admin_feed_reader_sees_only_the_invite_id(self):
        """invite_link.* rows are refetch signals: a non-admin reader of the
        change feed sees them (feed/socket parity) but only ``{id}``."""
        cache.clear()
        self.make_board()
        viewer = User.objects.create_user(username="v", password="p")
        BoardMembership.objects.create(board=self.board, user=viewer, role="viewer")
        self.client_for(self.admin).post(send_url(self.board), {"email": RECIPIENT}, format="json")
        link = BoardInviteLink.objects.get(board=self.board)
        self.client_for(self.admin).delete(revoke_url(self.board, link))
        r = self.client_for(viewer).get(f"/api/v1/boards/{self.board.pk}/events/")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        rows = body["results"] if isinstance(body, dict) else body
        invite_rows = [row for row in rows if row["event"].startswith("invite_link.")]
        self.assertEqual([row["event"] for row in invite_rows], ["invite_link.created", "invite_link.revoked"])
        for row in invite_rows:
            self.assertEqual(row["data"], {"id": link.pk})
        cache.clear()


# ---------------------------------------------------------------------------
# Invites whose sender can no longer add people (completeness check, #1444)
# ---------------------------------------------------------------------------

@override_settings(INVITE_EMAIL_ENABLED=True, DEMO_MODE=False, DEFAULT_FROM_EMAIL="invites@acme.test")
class DeadSenderInviteTests(_BoardFixture, TestCase):
    """The list and the send cap agree with the join path: an invite whose
    sender was deleted or is no longer a board admin is unusable, lists as
    ``revoked`` with ``can_register`` false, and frees its cap slot. Nothing
    is written to the row."""

    def setUp(self):
        cache.clear()
        self.make_board()
        self.sender = User.objects.create_user(username="sender", password="p")
        BoardMembership.objects.create(board=self.board, user=self.sender, role="admin")
        self.client = self.client_for(self.admin)

    def tearDown(self):
        cache.clear()

    def _row(self, link):
        rows = self.client.get(list_url(self.board)).json()
        return next(row for row in rows if row["id"] == link.pk)

    def _fill_cap_with_sender_invites(self):
        future = timezone.now() + timedelta(days=7)
        for _ in range(BOARD_MAX_PENDING_EMAILED_INVITES):
            self.make_invite(created_by=self.sender, expires_at=future)
        r = self.client.post(send_url(self.board), {"email": RECIPIENT}, format="json")
        self.assertEqual(r.json()["code"], "invite_email_cap_reached")

    def _assert_dead(self, link):
        row = self._row(link)
        self.assertEqual(row["status"], "revoked")
        self.assertIs(row["can_register"], False)
        link.refresh_from_db()
        self.assertIsNone(link.revoked_at)  # read-only: no write path

    def test_live_sender_invite_is_pending(self):
        link, _ = self.make_invite(created_by=self.sender)
        row = self._row(link)
        self.assertEqual(row["status"], "pending")
        self.assertIs(row["can_register"], True)

    def test_demoted_sender(self):
        link, _ = self.make_invite(created_by=self.sender)
        BoardMembership.objects.filter(board=self.board, user=self.sender).update(role="member")
        self._assert_dead(link)

    def test_deleted_sender(self):
        link, _ = self.make_invite(created_by=self.sender)
        self.sender.delete()
        link.refresh_from_db()
        self.assertIsNone(link.created_by_id)
        self._assert_dead(link)

    def test_demoted_sender_frees_cap_slots(self):
        self._fill_cap_with_sender_invites()
        BoardMembership.objects.filter(board=self.board, user=self.sender).update(role="viewer")
        r = self.client.post(send_url(self.board), {"email": RECIPIENT}, format="json")
        self.assertEqual(r.status_code, status.HTTP_202_ACCEPTED, r.content)

    def test_deleted_sender_frees_cap_slots(self):
        self._fill_cap_with_sender_invites()
        self.sender.delete()
        r = self.client.post(send_url(self.board), {"email": RECIPIENT}, format="json")
        self.assertEqual(r.status_code, status.HTTP_202_ACCEPTED, r.content)

    def test_used_and_expired_rows_never_claim_can_register(self):
        used, _ = self.make_invite()
        BoardInviteLink.objects.filter(pk=used.pk).update(used_at=timezone.now())
        self.assertIs(self._row(used)["can_register"], False)


# ---------------------------------------------------------------------------
# Shareable links (#439)
# ---------------------------------------------------------------------------

class BoardShareableLinkCreateTests(_BoardFixture, TestCase):

    def setUp(self):
        cache.clear()
        set_mode(SiteSetting.RegistrationMode.OPEN)
        self.make_board()
        self.client = self.client_for(self.admin)

    def tearDown(self):
        set_mode(SiteSetting.RegistrationMode.OPEN)
        cache.clear()

    def _create(self, client=None, **body):
        body.setdefault("expiry_days", 7)
        return (client or self.client).post(list_url(self.board), body, format="json")

    def test_create_returns_token_once_and_mints_link(self):
        r = self._create(role="viewer", expiry_days=30, name="  Design crew  ", single_use=True)
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.content)
        body = r.json()
        self.assertTrue(body["token"].startswith("vbnb_"))
        self.assertEqual(body["prefix"], body["token"][:8])
        self.assertEqual(
            (body["role"], body["delivery"], body["status"], body["single_use"], body["use_count"], body["name"]),
            ("viewer", "link", "pending", True, 0, "Design crew"),
        )
        self.assertEqual(body["created_by_username"], "badmin")
        self.assertIs(body["can_register"], True)
        link = BoardInviteLink.objects.get(pk=body["id"])
        self.assertEqual(link.delivery, "link")
        self.assertEqual(link.created_by, self.admin)
        self.assertEqual(link.token_hash, BoardInviteLink._hash_token(body["token"]))
        self.assertAlmostEqual(
            (link.expires_at - timezone.now()).total_seconds(), timedelta(days=30).total_seconds(), delta=60,
        )
        # Never again: the list carries no token.
        rows = self.client.get(list_url(self.board)).json()
        self.assertEqual([row["id"] for row in rows], [link.pk])
        self.assertNotIn("token", rows[0])
        self.assertNotIn(body["token"], self.client.get(list_url(self.board)).content.decode())

    def test_defaults_member_multi_use_unnamed(self):
        body = self._create().json()
        self.assertEqual((body["role"], body["single_use"], body["name"]), ("member", False, ""))

    def test_expiry_days_is_required_and_must_be_1_7_or_30(self):
        r = self.client.post(list_url(self.board), {}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("expiry_days", r.json())
        for bad in (None, 0, 2, 31, 365, "never"):
            with self.subTest(expiry_days=bad):
                r = self._create(expiry_days=bad)
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
                self.assertIn("expiry_days", r.json())
        for good in (1, 7, 30):
            with self.subTest(expiry_days=good):
                self.assertEqual(self._create(expiry_days=good).status_code, status.HTTP_201_CREATED)
        self.assertFalse(BoardInviteLink.objects.filter(expires_at__isnull=True).exists())

    def test_admin_and_moderator_roles_refused(self):
        for role in ("admin", "moderator", "owner", "site_admin"):
            with self.subTest(role=role):
                r = self._create(role=role)
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn("role", r.json())
        self.assertFalse(BoardInviteLink.objects.exists())

    def test_name_too_long_refused(self):
        self.assertEqual(self._create(name="x" * 101).status_code, status.HTTP_400_BAD_REQUEST)

    def test_cap_of_five_active_links(self):
        for _ in range(5):
            self.assertEqual(self._create().status_code, status.HTTP_201_CREATED)
        r = self._create()
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(
            r.json(), {"detail": "Maximum of 5 active invite links reached. Revoke a link to create a new one."},
        )
        self.assertEqual(BoardInviteLink.objects.filter(delivery="link").count(), 5)

    def test_cap_ignores_emailed_consumed_revoked_expired_and_dead_sender_links(self):
        for _ in range(3):
            self.make_invite(delivery="email")  # emailed: their own cap
        consumed, _ = self.make_invite(delivery="link", single_use=True)
        BoardInviteLink.objects.filter(pk=consumed.pk).update(used_at=timezone.now())
        revoked, _ = self.make_invite(delivery="link", single_use=False)
        BoardInviteLink.objects.filter(pk=revoked.pk).update(revoked_at=timezone.now())
        self.make_invite(delivery="link", single_use=False, expires_at=timezone.now() - timedelta(minutes=1))
        demoted = User.objects.create_user(username="demoted", password="p")
        BoardMembership.objects.create(board=self.board, user=demoted, role="member")
        self.make_invite(created_by=demoted, delivery="link", single_use=False)
        for _ in range(4):
            self.make_invite(delivery="link", single_use=False)
        self.assertEqual(self._create().status_code, status.HTTP_201_CREATED)
        self.assertEqual(self._create().status_code, status.HTTP_400_BAD_REQUEST)

    def test_other_boards_links_do_not_count(self):
        other = Board.objects.create(name="Other", owner=self.admin)
        for _ in range(5):
            BoardInviteLink.generate(
                board=other, created_by=self.admin, expires_at=timezone.now() + timedelta(days=1),
            )
        self.assertEqual(self._create().status_code, status.HTTP_201_CREATED)

    def test_create_query_count_is_bounded(self):
        """Pins the cost of the cap check (``live_invite_count``): one role
        check per distinct sender, never per row."""
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        for _ in range(4):
            self.make_invite(delivery="link", single_use=False)
        for _ in range(10):
            self.make_invite(delivery="email")
        cache.clear()
        with CaptureQueriesContext(connection) as ctx:
            r = self._create()
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        # 14 today with one sender and 14 live invites on the board.
        self.assertLessEqual(len(ctx.captured_queries), 15, [q["sql"] for q in ctx.captured_queries])

    def test_created_event_broadcast_on_commit(self):
        with mock.patch("boards.broadcast.broadcast_board_event") as bcast:
            with self.captureOnCommitCallbacks(execute=True):
                r = self._create()
        bcast.assert_called_once()
        self.assertEqual(
            bcast.call_args.args[:3], (self.board.pk, board_broadcast.EVT_INVITE_LINK_CREATED, {"id": r.json()["id"]}),
        )

    def test_refused_create_broadcasts_nothing(self):
        with mock.patch("boards.broadcast.broadcast_board_event") as bcast:
            with self.captureOnCommitCallbacks(execute=True):
                self._create(expiry_days=2)
        bcast.assert_not_called()

    def test_can_register_on_link_follows_mode(self):
        link_id = self._create().json()["id"]

        def row():
            return next(r for r in self.client.get(list_url(self.board)).json() if r["id"] == link_id)

        self.assertIs(row()["can_register"], True)
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        # A shareable link never admits a new account on an invite-only site,
        # even from a site admin.
        self.admin.is_site_admin = True
        self.admin.save(update_fields=["is_site_admin"])
        self.assertIs(row()["can_register"], False)
        set_mode(SiteSetting.RegistrationMode.CLOSED)
        self.assertIs(row()["can_register"], False)

    def test_shareable_link_revoke_uses_board_revoke(self):
        link_id = self._create().json()["id"]
        r = self.client.delete(f"/api/v1/boards/{self.board.pk}/invite-links/{link_id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(BoardInviteLink.objects.get(pk=link_id).status, "revoked")
        self.assertEqual(self._create().status_code, status.HTTP_201_CREATED)


class BoardShareableLinkJoinTests(_BoardFixture, TestCase):
    """Redeeming a multi-use ``delivery=link`` invite through the join endpoint."""

    def setUp(self):
        cache.clear()
        set_mode(SiteSetting.RegistrationMode.OPEN)
        self.make_board()

    def tearDown(self):
        set_mode(SiteSetting.RegistrationMode.OPEN)
        cache.clear()

    def test_multi_use_link_admits_many_and_counts_uses(self):
        link, raw = self.make_invite(delivery="link", single_use=False, role="collaborator")
        for name in ("u1", "u2", "u3"):
            user = User.objects.create_user(username=name, password="p")
            r = self.client_for(user).post(join_url(raw))
            self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.content)
            self.assertTrue(r.json()["created"])
            self.assertEqual(BoardMembership.objects.get(board=self.board, user=user).role, "collaborator")
        link.refresh_from_db()
        self.assertEqual(link.use_count, 3)
        self.assertIsNone(link.used_at)  # only single-use links are consumed
        self.assertEqual(link.status, "pending")
        self.assertEqual(BoardInviteRedemption.objects.filter(invite=link).count(), 3)

    def test_single_use_link_is_consumed_by_first_redeemer(self):
        link, raw = self.make_invite(delivery="link", single_use=True)
        first = User.objects.create_user(username="first", password="p")
        second = User.objects.create_user(username="second", password="p")
        self.assertEqual(self.client_for(first).post(join_url(raw)).status_code, status.HTTP_201_CREATED)
        r = self.client_for(second).post(join_url(raw))
        self.assertEqual(r.status_code, status.HTTP_410_GONE)
        self.assertEqual(r.json()["code"], "used")
        link.refresh_from_db()
        self.assertIsNotNone(link.used_at)
        self.assertEqual(link.use_count, 1)

    def test_link_never_changes_explicit_membership_or_grants_group(self):
        group_owner = User.objects.create_user(username="gowner", password="p")
        group = Group.objects.create(name="G", owner=group_owner)
        self.board.group = group
        self.board.save(update_fields=["group"])
        _link, raw = self.make_invite(delivery="link", single_use=False, role="viewer")
        member = User.objects.create_user(username="existing", password="p")
        BoardMembership.objects.create(board=self.board, user=member, role="member")
        r = self.client_for(member).post(join_url(raw))
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertFalse(r.json()["created"])
        self.assertEqual(BoardMembership.objects.get(board=self.board, user=member).role, "member")
        newcomer = User.objects.create_user(username="newcomer", password="p")
        self.client_for(newcomer).post(join_url(raw))
        self.assertFalse(GroupMembership.objects.filter(group=group, user=newcomer).exists())

    def test_expired_and_revoked_links_are_410(self):
        user = User.objects.create_user(username="late", password="p")
        _l, expired_raw = self.make_invite(
            delivery="link", single_use=False, expires_at=timezone.now() - timedelta(minutes=1),
        )
        self.assertEqual(self.client_for(user).post(join_url(expired_raw)).json()["code"], "expired")
        revoked, revoked_raw = self.make_invite(delivery="link", single_use=False)
        BoardInviteLink.objects.filter(pk=revoked.pk).update(revoked_at=timezone.now())
        self.assertEqual(self.client_for(user).post(join_url(revoked_raw)).json()["code"], "revoked")
        self.assertFalse(BoardMembership.objects.filter(user=user).exists())

    def test_preview_can_register_for_link_by_mode(self):
        _l, raw = self.make_invite(delivery="link", single_use=False)
        self.admin.is_site_admin = True
        self.admin.save(update_fields=["is_site_admin"])
        expected = {
            SiteSetting.RegistrationMode.OPEN: True,
            SiteSetting.RegistrationMode.INVITE_ONLY: False,
            SiteSetting.RegistrationMode.CLOSED: False,
        }
        for mode, can in expected.items():
            with self.subTest(mode=mode):
                set_mode(mode)
                r = APIClient().get(join_url(raw))
                self.assertEqual(r.status_code, status.HTTP_200_OK)
                self.assertIs(r.json()["can_register"], can)

