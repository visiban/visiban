"""Single-use invites admit at most one OAuth account under concurrency (#1489).

``SocialRegistrationAdapter.save_user`` creates the account and redeems the
invite in one transaction, so a signup that loses the race is rolled back
instead of leaving an orphan account on an INVITE_ONLY site.
"""
import threading
from datetime import timedelta
from unittest import mock

from allauth.core.exceptions import ImmediateHttpResponse
from django.core import mail
from django.db import connection
from django.db import connections as _conns
from django.http import HttpResponse
from django.test import Client, RequestFactory, TestCase, TransactionTestCase, override_settings
from django.urls import path
from django.utils import timezone

from allauth.account.models import EmailAddress
from allauth.socialaccount.adapter import get_adapter
from allauth.socialaccount.internal.flows.signup import process_signup
from allauth.socialaccount.models import SocialAccount, SocialLogin

from accounts.adapter import PENDING_INVITE_SESSION_KEY, SocialRegistrationAdapter
from accounts.models import InviteLink, SiteSetting, User
from boards.models import Board, BoardInviteLink, BoardMembership
from groups.models import Group, GroupInviteLink, GroupMembership

def _make_sociallogin(email):
    """An unsaved GitHub SocialLogin as allauth builds it mid-callback."""
    req = RequestFactory().get("/accounts/github/login/callback/")
    provider = get_adapter().get_provider(req, "github")
    account = SocialAccount(provider="github", uid="424242", extra_data={})
    sociallogin = SocialLogin(
        user=User(username="", email=email),
        account=account,
        email_addresses=[EmailAddress(email=email, verified=True, primary=True)],
    )
    sociallogin.provider = provider
    return sociallogin


def _signup_view(request):
    """Stand-in for the provider callback: runs allauth's real process_signup
    (is_open_for_signup -> save_user -> complete_social_signup)."""
    return process_signup(request, _make_sociallogin("flow@x.test")) or HttpResponse("done")


urlpatterns = [path("test-oauth-signup/", _signup_view)]

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

    def test_closed_mode_at_save_user_refuses_with_gate_code(self):
        raw = self.make_invite("site")
        set_mode(SiteSetting.RegistrationMode.CLOSED)
        with self.assertRaises(ImmediateHttpResponse) as ctx:
            self.signup(raw, "closed_late")
        self.assertIn("auth_error=signup_closed", ctx.exception.response.url)
        self.assertFalse(User.objects.filter(username="closed_late").exists())
        self.link.refresh_from_db()
        self.assertIsNone(self.link.used_at)

    def test_loser_signup_has_no_observable_side_effects(self):
        """Inside save_user allauth only writes rows (user, social account,
        EmailAddress); verification mail is sent later by complete_signup, which
        a refused signup never reaches. Run the real allauth save_user."""
        raw = self.make_invite("site")
        InviteLink.objects.filter(pk=self.link.pk).update(used_at=timezone.now())
        mail.outbox.clear()
        users_before = User.objects.count()
        sociallogin = _make_sociallogin("loser@x.test")
        with self.assertRaises(ImmediateHttpResponse):
            SocialRegistrationAdapter().save_user(self.request(raw), sociallogin, form=None)
        self.assertEqual(mail.outbox, [])
        self.assertEqual(User.objects.count(), users_before)
        self.assertFalse(SocialAccount.objects.exists())
        self.assertFalse(EmailAddress.objects.filter(email="loser@x.test").exists())

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


@override_settings(
    LOGIN_REDIRECT_URL="http://localhost:5173",
    ROOT_URLCONF="accounts.tests.test_oauth_invite_concurrency",
)
class RefusedSignupReachesClientTests(_Fixture, TestCase):
    """allauth's real signup flow turns a save_user refusal into a redirect.

    A full provider callback needs HTTP mocks for the token and profile
    endpoints; instead a stub view calls allauth's own ``process_signup`` (the
    code the callback view runs) through the full middleware stack, which is
    where ``ImmediateHttpResponse`` is converted to a response.
    """

    def setUp(self):
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)

    def tearDown(self):
        set_mode(SiteSetting.RegistrationMode.OPEN)

    def _client(self, raw):
        client = Client()
        session = client.session
        session[PENDING_INVITE_SESSION_KEY] = raw
        session.save()
        client.cookies["sessionid"] = session.session_key
        return client

    def test_spent_token_is_a_redirect_not_a_500(self):
        raw = self.make_invite("site")
        # Valid at the gate, spent by the time save_user takes the lock.
        real = SocialRegistrationAdapter.is_open_for_signup

        def gate_then_spend(adapter, request, sociallogin):
            result = real(adapter, request, sociallogin)
            InviteLink.objects.filter(pk=self.link.pk).update(used_at=timezone.now())
            return result

        mail.outbox.clear()
        with mock.patch.object(SocialRegistrationAdapter, "is_open_for_signup", gate_then_spend):
            response = self._client(raw).get("/test-oauth-signup/")
        self.assertEqual(response.status_code, 302)
        self.assertIn("auth_error=invite_invalid", response["Location"])
        self.assertFalse(User.objects.filter(email="flow@x.test").exists())
        self.assertEqual(mail.outbox, [])
