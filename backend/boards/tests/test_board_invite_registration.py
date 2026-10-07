"""Registration through an emailed board invite (#1444).

REST ``POST /api/v1/auth/registration/`` with ``invite_token=vbnb_...``, the
OAuth middleware/adapter equivalent, and the shared prefix table in
``accounts.registration_tokens``.
"""
from datetime import timedelta
from unittest import mock

from allauth.core.exceptions import ImmediateHttpResponse
from django.core.cache import cache
from django.test import RequestFactory, TestCase, override_settings
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from accounts import registration_tokens
from accounts.adapter import PENDING_INVITE_SESSION_KEY, SocialRegistrationAdapter
from accounts.middleware import OAuthInviteTokenMiddleware
from accounts.models import INVITE_LINK_PREFIX, SiteSetting, User
from boards import broadcast as board_broadcast
from boards.invites import NOT_FOR_REGISTRATION_DETAIL
from boards.models import Board, BoardInviteLink, BoardInviteRedemption, BoardMembership
from groups.models import GroupInviteLink

REGISTER_URL = "/api/v1/auth/registration/"
PASSWORD = "Sup3rS3cr3t!xyz"


def set_mode(mode):
    s = SiteSetting.get()
    s.registration_mode = mode
    s.save()


class _Fixture:
    def make_board(self, *, sender_is_site_admin=True):
        self.owner = User.objects.create_user(username="owner", password="p", email="owner@acme.test")
        self.sender = User.objects.create_user(username="sender", password="p", email="sender@acme.test")
        self.sender.is_site_admin = sender_is_site_admin
        self.sender.save(update_fields=["is_site_admin"])
        self.board = Board.objects.create(name="Launch Plan", owner=self.owner)
        BoardMembership.objects.create(board=self.board, user=self.sender, role=BoardMembership.Role.ADMIN)

    def make_invite(self, *, delivery="email", single_use=True, role="collaborator", expires_at="default"):
        if expires_at == "default":
            expires_at = timezone.now() + timedelta(days=7)
        return BoardInviteLink.generate(
            board=self.board, created_by=self.sender, role=role,
            expires_at=expires_at, single_use=single_use, delivery=delivery,
        )


class RegistrationTokenTableTests(TestCase):
    """The prefix literals in the table must match the models' prefixes."""

    def test_prefixes_match_models(self):
        self.assertEqual(registration_tokens.SITE.prefix, INVITE_LINK_PREFIX)
        self.assertEqual(registration_tokens.GROUP.prefix, GroupInviteLink.GROUP_INVITE_PREFIX)
        self.assertEqual(registration_tokens.BOARD.prefix, BoardInviteLink.BOARD_INVITE_PREFIX)

    def test_dispatch_by_prefix_with_site_fallback(self):
        kind = registration_tokens.registration_token_kind
        self.assertIs(kind("vbnb_abc"), registration_tokens.BOARD)
        self.assertIs(kind("  vbng_abc"), registration_tokens.GROUP)
        self.assertIs(kind("vbnl_abc"), registration_tokens.SITE)
        self.assertIs(kind("garbage"), registration_tokens.SITE)
        self.assertIs(kind(""), registration_tokens.SITE)

    def test_stashable_prefixes_cover_every_kind(self):
        self.assertEqual(set(registration_tokens.STASHABLE_PREFIXES), {"vbnl_", "vbng_", "vbnb_"})


class BoardInviteRegistrationTests(_Fixture, TestCase):

    def setUp(self):
        cache.clear()
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        self.make_board()
        self.client = APIClient()

    def tearDown(self):
        set_mode(SiteSetting.RegistrationMode.OPEN)
        cache.clear()

    def _register(self, email, token):
        return self.client.post(REGISTER_URL, {
            "email": email, "password1": PASSWORD, "password2": PASSWORD, "invite_token": token,
        })

    def _assert_refused(self, r, email, link, expected_detail=None):
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
        self.assertFalse(User.objects.filter(email=email).exists())
        link.refresh_from_db()
        self.assertIsNone(link.used_at)
        if expected_detail is not None:
            self.assertEqual(r.json(), {"invite_token": [expected_detail]})

    def test_site_admin_emailed_invite_registers_and_joins_board(self):
        link, raw = self.make_invite(role="collaborator")
        with mock.patch("boards.broadcast.broadcast_board_event") as bcast:
            with self.captureOnCommitCallbacks(execute=True):
                r = self._register("new@example.com", raw)
        self.assertIn(r.status_code, (201, 204), r.content)
        user = User.objects.get(email="new@example.com")
        self.assertEqual(BoardMembership.objects.get(board=self.board, user=user).role, "collaborator")
        link.refresh_from_db()
        self.assertIsNotNone(link.used_at)
        redemption = BoardInviteRedemption.objects.get(invite=link)
        self.assertEqual((redemption.user, redemption.via, redemption.membership_created), (user, "registration", True))
        bcast.assert_called_once()
        self.assertEqual(bcast.call_args.args[1], board_broadcast.EVT_MEMBER_ADDED)
        self.assertEqual(bcast.call_args.args[2]["invite"]["id"], link.pk)

    def test_follow_up_join_after_registration_reports_created(self):
        link, raw = self.make_invite()
        self._register("follow@example.com", raw)
        user = User.objects.get(email="follow@example.com")
        client = APIClient()
        client.force_authenticate(user)
        r = client.post(f"/api/v1/boards/join/{raw}/")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assertTrue(r.json()["created"])
        self.assertEqual(BoardMembership.objects.filter(board=self.board, user=user).count(), 1)

    def test_non_site_admin_sender_is_refused(self):
        self.sender.is_site_admin = False
        self.sender.save(update_fields=["is_site_admin"])
        link, raw = self.make_invite()
        self._assert_refused(self._register("x@example.com", raw), "x@example.com", link, NOT_FOR_REGISTRATION_DETAIL)

    def test_shareable_or_multi_use_invite_is_refused(self):
        for delivery, single_use in (("link", True), ("link", False), ("email", False)):
            with self.subTest(delivery=delivery, single_use=single_use):
                link, raw = self.make_invite(delivery=delivery, single_use=single_use)
                email = f"{delivery}{single_use}@example.com"
                self._assert_refused(self._register(email, raw), email, link, NOT_FOR_REGISTRATION_DETAIL)

    def test_used_expired_revoked_unknown_refused(self):
        used, used_raw = self.make_invite()
        BoardInviteLink.objects.filter(pk=used.pk).update(used_at=timezone.now())
        self.assertEqual(self._register("u@example.com", used_raw).status_code, 400)
        exp, exp_raw = self.make_invite(expires_at=timezone.now() - timedelta(minutes=1))
        self._assert_refused(self._register("e@example.com", exp_raw), "e@example.com", exp, "This invite link has expired.")
        rev, rev_raw = self.make_invite()
        BoardInviteLink.objects.filter(pk=rev.pk).update(revoked_at=timezone.now())
        self.assertEqual(self._register("r@example.com", rev_raw).status_code, 400)
        self.assertEqual(self._register("k@example.com", "vbnb_" + "0" * 40).status_code, 400)
        self.assertFalse(User.objects.filter(email__in=["u@example.com", "r@example.com", "k@example.com"]).exists())

    def test_sender_no_longer_board_admin_or_deactivated_refused(self):
        link, raw = self.make_invite()
        BoardMembership.objects.filter(board=self.board, user=self.sender).update(role="member")
        self._assert_refused(self._register("d@example.com", raw), "d@example.com", link)
        BoardMembership.objects.filter(board=self.board, user=self.sender).update(role="admin")
        self.sender.is_active = False
        self.sender.save(update_fields=["is_active"])
        self._assert_refused(self._register("d2@example.com", raw), "d2@example.com", link)

    @override_settings(INVITE_EMAIL_ENABLED=False)
    def test_refused_once_email_invites_disabled(self):
        link, raw = self.make_invite()
        self._assert_refused(self._register("off@example.com", raw), "off@example.com", link)

    def test_failed_registration_leaves_invite_unconsumed(self):
        link, raw = self.make_invite()
        r = self.client.post(REGISTER_URL, {
            "email": "bad@example.com", "password1": PASSWORD, "password2": "different!", "invite_token": raw,
        })
        self.assertEqual(r.status_code, 400)
        link.refresh_from_db()
        self.assertIsNone(link.used_at)
        self.assertFalse(BoardInviteRedemption.objects.exists())

    def test_closed_mode_refuses_even_a_qualifying_invite(self):
        set_mode(SiteSetting.RegistrationMode.CLOSED)
        link, raw = self.make_invite()
        r = self._register("closed@example.com", raw)
        self.assertNotIn(r.status_code, (201, 204))
        self.assertFalse(User.objects.filter(email="closed@example.com").exists())
        link.refresh_from_db()
        self.assertIsNone(link.used_at)

    def test_open_mode_registers_without_redeeming(self):
        set_mode(SiteSetting.RegistrationMode.OPEN)
        for sender_is_site_admin in (True, False):
            with self.subTest(sender_is_site_admin=sender_is_site_admin):
                self.sender.is_site_admin = sender_is_site_admin
                self.sender.save(update_fields=["is_site_admin"])
                link, raw = self.make_invite()
                email = f"open{sender_is_site_admin}@example.com"
                r = self._register(email, raw)
                self.assertIn(r.status_code, (201, 204), r.content)
                link.refresh_from_db()
                self.assertIsNone(link.used_at)  # the SPA's follow-up join redeems it
                self.assertFalse(BoardMembership.objects.filter(user__email=email).exists())

    def test_site_invite_path_unchanged(self):
        from accounts.models import InviteLink

        site_link, raw = InviteLink.generate(created_by=self.sender, single_use=True)
        r = self._register("site@example.com", raw)
        self.assertIn(r.status_code, (201, 204))
        site_link.refresh_from_db()
        self.assertIsNotNone(site_link.used_at)

    def test_multi_use_site_link_dedup_keys_on_the_saved_account_email(self):
        """#925 dedup is keyed on the email saved on the new account (since
        #1444), normalized, so a case variant of an address that already
        redeemed the link is refused and leaves no account behind."""
        from accounts.invite_utils import _email_hash_for_dedup
        from accounts.models import InviteLink, InviteLinkRedemption

        site_link, raw = InviteLink.generate(created_by=self.sender, single_use=False)
        self.assertIn(self._register("Case.Person@Example.com", raw).status_code, (201, 204))
        saved = User.objects.get(email__iexact="case.person@example.com").email
        self.assertEqual(
            InviteLinkRedemption.objects.get(invite_link=site_link).email_hash,
            _email_hash_for_dedup(saved),
        )
        User.objects.filter(email__iexact="case.person@example.com").update(email="moved@example.com")
        r = self._register("CASE.PERSON@example.COM", raw)
        self.assertEqual(r.status_code, status.HTTP_409_CONFLICT)
        self.assertFalse(User.objects.filter(email__iexact="case.person@example.com").exists())

    def test_multi_use_site_link_repeat_email_is_409_and_rolled_back(self):
        from accounts.models import InviteLink

        site_link, raw = InviteLink.generate(created_by=self.sender, single_use=False)
        self.assertIn(self._register("dup@example.com", raw).status_code, (201, 204))
        User.objects.filter(email="dup@example.com").update(email="renamed@example.com")
        r = self._register("dup@example.com", raw)
        self.assertEqual(r.status_code, status.HTTP_409_CONFLICT)
        self.assertFalse(User.objects.filter(email="dup@example.com").exists())


@override_settings(LOGIN_REDIRECT_URL="http://localhost:5173")
class BoardInviteOAuthTests(_Fixture, TestCase):

    def setUp(self):
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        self.make_board()
        self.adapter = SocialRegistrationAdapter()
        self.factory = RequestFactory()

    def tearDown(self):
        set_mode(SiteSetting.RegistrationMode.OPEN)

    def _request(self, token):
        request = self.factory.get("/accounts/google/login/callback/")
        request.session = {PENDING_INVITE_SESSION_KEY: token}
        return request

    def _save(self, raw, username):
        request = self._request(raw)
        new_user = User.objects.create_user(username=username, password="p")
        with mock.patch.object(SocialRegistrationAdapter.__bases__[0], "save_user", return_value=new_user):
            self.adapter.save_user(request, mock.MagicMock(), form=None)
        self.assertNotIn(PENDING_INVITE_SESSION_KEY, request.session)
        return new_user

    def test_middleware_stashes_board_token(self):
        request = self.factory.get("/accounts/google/login/?process=login&invite_token=vbnb_abc123")
        request.session = {}
        OAuthInviteTokenMiddleware(mock.MagicMock())(request)
        self.assertEqual(request.session[PENDING_INVITE_SESSION_KEY], "vbnb_abc123")

    def test_middleware_ignores_unknown_prefix(self):
        request = self.factory.get("/accounts/google/login/?invite_token=zzzz_abc")
        request.session = {}
        OAuthInviteTokenMiddleware(mock.MagicMock())(request)
        self.assertNotIn(PENDING_INVITE_SESSION_KEY, request.session)

    def test_qualifying_invite_opens_signup(self):
        _link, raw = self.make_invite()
        self.assertTrue(self.adapter.is_open_for_signup(self._request(raw), mock.MagicMock()))

    def test_non_site_admin_invite_redirects_not_for_registration(self):
        self.sender.is_site_admin = False
        self.sender.save(update_fields=["is_site_admin"])
        _link, raw = self.make_invite()
        request = self._request(raw)
        with self.assertRaises(ImmediateHttpResponse) as ctx:
            self.adapter.is_open_for_signup(request, mock.MagicMock())
        self.assertIn("auth_error=invite_not_for_registration", ctx.exception.response.url)
        self.assertNotIn(PENDING_INVITE_SESSION_KEY, request.session)

    def test_expired_invite_redirects_expired(self):
        _link, raw = self.make_invite(expires_at=timezone.now() - timedelta(hours=1))
        with self.assertRaises(ImmediateHttpResponse) as ctx:
            self.adapter.is_open_for_signup(self._request(raw), mock.MagicMock())
        self.assertIn("auth_error=invite_expired", ctx.exception.response.url)

    def test_save_user_joins_board_and_consumes_invite(self):
        link, raw = self.make_invite(role="viewer")
        user = self._save(raw, "oauth_new")
        self.assertEqual(BoardMembership.objects.get(board=self.board, user=user).role, "viewer")
        link.refresh_from_db()
        self.assertIsNotNone(link.used_at)
        self.assertEqual(BoardInviteRedemption.objects.get(invite=link).via, "registration")

    def test_save_user_with_consumed_invite_grants_nothing(self):
        link, raw = self.make_invite()
        BoardInviteLink.objects.filter(pk=link.pk).update(used_at=timezone.now())
        user = self._save(raw, "oauth_late")
        self.assertFalse(BoardMembership.objects.filter(board=self.board, user=user).exists())

    def test_save_user_with_non_site_admin_invite_grants_nothing(self):
        link, raw = self.make_invite()
        self.sender.is_site_admin = False
        self.sender.save(update_fields=["is_site_admin"])
        user = self._save(raw, "oauth_ga")
        self.assertFalse(BoardMembership.objects.filter(board=self.board, user=user).exists())
        link.refresh_from_db()
        self.assertIsNone(link.used_at)


class BoardJoinPreviewCanRegisterTests(_Fixture, TestCase):

    def setUp(self):
        cache.clear()
        self.make_board()

    def tearDown(self):
        set_mode(SiteSetting.RegistrationMode.OPEN)
        cache.clear()

    def _can_register(self, raw):
        r = APIClient().get(f"/api/v1/boards/join/{raw}/")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()["can_register"]

    def test_matrix(self):
        _l, raw = self.make_invite()
        set_mode(SiteSetting.RegistrationMode.OPEN)
        self.assertIs(self._can_register(raw), True)
        set_mode(SiteSetting.RegistrationMode.CLOSED)
        self.assertIs(self._can_register(raw), False)
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        self.assertIs(self._can_register(raw), True)
        self.sender.is_site_admin = False
        self.sender.save(update_fields=["is_site_admin"])
        self.assertIs(self._can_register(raw), False)


class ShareableBoardLinkRegistrationTests(_Fixture, TestCase):
    """Shareable (``delivery=link``) board invites × registration mode (#439).

    OPEN: anyone may register, and the SPA's follow-up join redeems the link.
    INVITE_ONLY: a shareable link never creates an account — even one minted by
    a site admin — but existing accounts join with it. CLOSED: no new accounts.
    """

    def setUp(self):
        cache.clear()
        self.make_board(sender_is_site_admin=True)
        self.client = APIClient()

    def tearDown(self):
        set_mode(SiteSetting.RegistrationMode.OPEN)
        cache.clear()

    def _register(self, email, token):
        return self.client.post(REGISTER_URL, {
            "email": email, "password1": PASSWORD, "password2": PASSWORD, "invite_token": token,
        })

    def _join(self, user, raw):
        client = APIClient()
        client.force_authenticate(user)
        return client.post(f"/api/v1/boards/join/{raw}/")

    def test_open_new_user_registers_then_joins_with_link(self):
        set_mode(SiteSetting.RegistrationMode.OPEN)
        link, raw = self.make_invite(delivery="link", single_use=False, role="member")
        for email in ("first@example.com", "second@example.com"):
            r = self._register(email, raw)
            self.assertIn(r.status_code, (201, 204), r.content)
            user = User.objects.get(email=email)
            joined = self._join(user, raw)
            self.assertEqual(joined.status_code, status.HTTP_201_CREATED, joined.content)
            self.assertTrue(joined.json()["created"])
            self.assertEqual(BoardMembership.objects.get(board=self.board, user=user).role, "member")
        link.refresh_from_db()
        self.assertEqual(link.use_count, 2)
        self.assertIsNone(link.used_at)

    def test_invite_only_link_never_creates_an_account(self):
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        for single_use in (False, True):
            with self.subTest(single_use=single_use):
                link, raw = self.make_invite(delivery="link", single_use=single_use)
                email = f"nope{single_use}@example.com"
                r = self._register(email, raw)
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
                self.assertEqual(r.json(), {"invite_token": [NOT_FOR_REGISTRATION_DETAIL]})
                self.assertFalse(User.objects.filter(email=email).exists())
                link.refresh_from_db()
                self.assertEqual((link.use_count, link.used_at), (0, None))

    def test_invite_only_existing_account_joins_with_link(self):
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        link, raw = self.make_invite(delivery="link", single_use=False, role="viewer")
        existing = User.objects.create_user(username="existing", password="p", email="existing@example.com")
        r = self._join(existing, raw)
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.content)
        self.assertEqual(BoardMembership.objects.get(board=self.board, user=existing).role, "viewer")
        link.refresh_from_db()
        self.assertEqual(link.use_count, 1)

    def test_closed_link_never_creates_an_account_but_existing_users_join(self):
        set_mode(SiteSetting.RegistrationMode.CLOSED)
        link, raw = self.make_invite(delivery="link", single_use=False)
        r = self._register("closed@example.com", raw)
        self.assertNotIn(r.status_code, (201, 204))
        self.assertFalse(User.objects.filter(email="closed@example.com").exists())
        existing = User.objects.create_user(username="existing2", password="p")
        self.assertEqual(self._join(existing, raw).status_code, status.HTTP_201_CREATED)


@override_settings(LOGIN_REDIRECT_URL="http://localhost:5173")
class ShareableBoardLinkOAuthTests(_Fixture, TestCase):
    """The OAuth path refuses shareable links for sign-up exactly as REST does."""

    def setUp(self):
        self.make_board(sender_is_site_admin=True)
        self.adapter = SocialRegistrationAdapter()
        self.factory = RequestFactory()

    def tearDown(self):
        set_mode(SiteSetting.RegistrationMode.OPEN)

    def _request(self, token):
        request = self.factory.get("/accounts/google/login/callback/")
        request.session = {PENDING_INVITE_SESSION_KEY: token}
        return request

    def test_invite_only_link_redirects_not_for_registration(self):
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        link, raw = self.make_invite(delivery="link", single_use=False)
        request = self._request(raw)
        with self.assertRaises(ImmediateHttpResponse) as ctx:
            self.adapter.is_open_for_signup(request, mock.MagicMock())
        self.assertIn("auth_error=invite_not_for_registration", ctx.exception.response.url)
        self.assertNotIn(PENDING_INVITE_SESSION_KEY, request.session)
        link.refresh_from_db()
        self.assertEqual(link.use_count, 0)

    def test_closed_link_redirects_signup_closed(self):
        set_mode(SiteSetting.RegistrationMode.CLOSED)
        _link, raw = self.make_invite(delivery="link", single_use=False)
        with self.assertRaises(ImmediateHttpResponse) as ctx:
            self.adapter.is_open_for_signup(self._request(raw), mock.MagicMock())
        self.assertIn("auth_error=signup_closed", ctx.exception.response.url)

    def test_open_link_allows_signup(self):
        set_mode(SiteSetting.RegistrationMode.OPEN)
        _link, raw = self.make_invite(delivery="link", single_use=False)
        self.assertTrue(self.adapter.is_open_for_signup(self._request(raw), mock.MagicMock()))
