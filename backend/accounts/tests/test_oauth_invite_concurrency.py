"""Single-use invites admit at most one OAuth account under concurrency (#1489).

``SocialRegistrationAdapter.save_user`` creates the account and redeems the
invite in one transaction, so a signup that loses the race is rolled back
instead of leaving an orphan account on an INVITE_ONLY site.
"""
import threading
from datetime import timedelta
from unittest import mock

from allauth.core.exceptions import ImmediateHttpResponse
from django.db import connection
from django.db import connections as _conns
from django.test import RequestFactory, TestCase, TransactionTestCase, override_settings
from django.utils import timezone

from accounts.adapter import PENDING_INVITE_SESSION_KEY, SocialRegistrationAdapter
from accounts.models import InviteLink, SiteSetting, User
from boards.models import Board, BoardInviteLink, BoardMembership
from groups.models import Group, GroupInviteLink, GroupMembership

KINDS = ("site", "group", "board")
_BASE_SAVE = SocialRegistrationAdapter.__bases__[0]


def set_mode(mode):
    s = SiteSetting.get()
    s.registration_mode = mode
    s.save()


class _Fixture:
    def make_invite(self, kind):
        """Return (raw_token, refresh_used_at) for a fresh single-use invite."""
        admin = User.objects.create_user(username=f"inv_admin_{kind}", password="p", email=f"inv_admin_{kind}@acme.test")
        admin.is_site_admin = True
        admin.save(update_fields=["is_site_admin"])
        expires = timezone.now() + timedelta(days=7)
        if kind == "site":
            link, raw = InviteLink.generate(created_by=admin, single_use=True)
        elif kind == "group":
            group = Group.objects.create(name="G", owner=admin)
            GroupMembership.objects.create(group=group, user=admin, role=GroupMembership.Role.ADMIN)
            link, raw = GroupInviteLink.generate(
                group=group, created_by=admin, role=GroupInviteLink.Role.VIEWER,
                expires_at=expires, single_use=True, delivery=GroupInviteLink.Delivery.EMAIL,
            )
        else:
            board = Board.objects.create(name="B", owner=admin)
            BoardMembership.objects.create(board=board, user=admin, role=BoardMembership.Role.ADMIN)
            link, raw = BoardInviteLink.generate(
                board=board, created_by=admin, role="viewer",
                expires_at=expires, single_use=True, delivery="email",
            )
        self.link = link
        return raw

    def request(self, raw):
        request = RequestFactory().get("/accounts/google/login/callback/")
        request.session = {PENDING_INVITE_SESSION_KEY: raw}
        return request

    def signup(self, raw, username):
        """Drive the adapter's save_user with allauth's user insert stubbed."""
        def create(*args, **kwargs):
            return User.objects.create_user(username=username, password="p", email=f"{username}@x.test")

        with mock.patch.object(_BASE_SAVE, "save_user", side_effect=create):
            return SocialRegistrationAdapter().save_user(self.request(raw), mock.MagicMock(), form=None)


@override_settings(LOGIN_REDIRECT_URL="http://localhost:5173")
class LosingSignupRollsBackTests(_Fixture, TestCase):
    """SQLite-runnable: a token spent before save_user leaves no account."""

    def setUp(self):
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)

    def tearDown(self):
        set_mode(SiteSetting.RegistrationMode.OPEN)

    def test_loser_gets_redirect_and_no_account(self):
        for kind in KINDS:
            with self.subTest(kind=kind):
                raw = self.make_invite(kind)
                self.assertEqual(self.signup(raw, f"winner_{kind}").username, f"winner_{kind}")
                with self.assertRaises(ImmediateHttpResponse) as ctx:
                    self.signup(raw, f"loser_{kind}")
                self.assertIn("auth_error=invite_invalid", ctx.exception.response.url)
                self.assertFalse(User.objects.filter(username=f"loser_{kind}").exists())

    def test_missing_session_token_fails_closed(self):
        with mock.patch.object(_BASE_SAVE, "save_user", side_effect=lambda *a, **k: User.objects.create_user(
            username="notoken", password="p"
        )):
            request = RequestFactory().get("/")
            request.session = {}
            with self.assertRaises(ImmediateHttpResponse):
                SocialRegistrationAdapter().save_user(request, mock.MagicMock(), form=None)
        self.assertFalse(User.objects.filter(username="notoken").exists())


@override_settings(LOGIN_REDIRECT_URL="http://localhost:5173")
class ConcurrentOAuthSignupTests(_Fixture, TransactionTestCase):
    """Two threads race one single-use token: exactly one account is created."""

    def setUp(self):
        if connection.vendor == "sqlite":
            self.skipTest("SQLite does not support SELECT FOR UPDATE; this test requires PostgreSQL.")
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)

    def tearDown(self):
        set_mode(SiteSetting.RegistrationMode.OPEN)

    def _race(self, kind):
        raw = self.make_invite(kind)
        outcomes = []
        barrier = threading.Barrier(2)

        # mock.patch is process-global and not thread-safe: patch once around
        # the whole race and let each thread name its user via its own name.
        def create(*args, **kwargs):
            name = threading.current_thread().name
            return User.objects.create_user(username=name, password="p", email=f"{name}@x.test")

        def attempt():
            try:
                barrier.wait()
                SocialRegistrationAdapter().save_user(self.request(raw), mock.MagicMock(), form=None)
                outcomes.append("ok")
            except ImmediateHttpResponse:
                outcomes.append("refused")
            finally:
                _conns.close_all()

        threads = [threading.Thread(target=attempt, name=f"{kind}_racer{i}") for i in range(2)]
        with mock.patch.object(_BASE_SAVE, "save_user", side_effect=create):
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        return outcomes

    def test_single_use_invite_admits_one_account(self):
        for kind in KINDS:
            with self.subTest(kind=kind):
                outcomes = self._race(kind)
                self.assertEqual(sorted(outcomes), ["ok", "refused"], outcomes)
                self.assertEqual(User.objects.filter(username__startswith=f"{kind}_racer").count(), 1)
                self.link.refresh_from_db()
                self.assertIsNotNone(self.link.used_at)
