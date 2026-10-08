"""Registration through an emailed group invite on invite-only sites (#1445).

POST /api/v1/auth/registration/ with ``invite_token=vbng_...``, the OAuth
adapter/middleware equivalent, and the member-aware join follow-up.
"""
import threading
from datetime import timedelta
from unittest import mock

from allauth.core.exceptions import ImmediateHttpResponse
from django.core.cache import cache
from django.db import connection, transaction
from django.test import RequestFactory, TestCase, TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from accounts.adapter import PENDING_INVITE_SESSION_KEY, SocialRegistrationAdapter
from accounts.invite_utils import InviteTokenError
from accounts.middleware import OAuthInviteTokenMiddleware
from accounts.models import InviteLink, SiteSetting, User
from groups.broadcast import EVT_MEMBER_ADDED
from groups.invite_registration import (
    NOT_FOR_REGISTRATION_DETAIL,
    redeem_group_registration_token,
    validate_group_registration_token,
)
from groups.models import Group, GroupInviteLink, GroupMembership

REGISTER_URL = "/api/v1/auth/registration/"
PASSWORD = "Sup3rS3cr3t!xyz"


def set_mode(mode):
    s = SiteSetting.get()
    s.registration_mode = mode
    s.save()


def join_url(token):
    return f"/api/v1/groups/join/{token}/"


class _GroupInviteFixture:
    def make_group(self):
        # The sender is a site admin: only a site admin's emailed invite may
        # admit new accounts. Tests for other senders flip the flag.
        self.admin = User.objects.create_user(username="gadmin", password="pass", email="gadmin@acme.test")
        self.admin.is_site_admin = True
        self.admin.save(update_fields=["is_site_admin"])
        self.group = Group.objects.create(name="Platform Team", owner=self.admin)
        GroupMembership.objects.create(group=self.group, user=self.admin, role=GroupMembership.Role.ADMIN)

    def make_link(self, *, delivery=GroupInviteLink.Delivery.EMAIL, single_use=True,
                  role=GroupInviteLink.Role.VIEWER, expires_at="default"):
        if expires_at == "default":
            expires_at = timezone.now() + timedelta(days=7)
        return GroupInviteLink.generate(
            group=self.group, created_by=self.admin, role=role,
            expires_at=expires_at, single_use=single_use, delivery=delivery,
        )


class GroupInviteRegistrationTests(_GroupInviteFixture, TestCase):

    def setUp(self):
        cache.clear()
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        self.make_group()
        self.client = APIClient()

    def tearDown(self):
        set_mode(SiteSetting.RegistrationMode.OPEN)
        cache.clear()

    def _register(self, email, token, password2=PASSWORD):
        return self.client.post(REGISTER_URL, {
            "email": email, "password1": PASSWORD, "password2": password2, "invite_token": token,
        })

    def _assert_refused(self, r, email, link, code=status.HTTP_400_BAD_REQUEST):
        self.assertEqual(r.status_code, code, r.content)
        self.assertFalse(User.objects.filter(email=email).exists())
        link.refresh_from_db()
        self.assertEqual(self.group.memberships.count(), 1)  # the admin only
        return link

    # -- happy path -------------------------------------------------------

    def test_emailed_invite_registers_and_joins_with_link_role(self):
        link, raw = self.make_link(role=GroupInviteLink.Role.COLLABORATOR)
        with self.captureOnCommitCallbacks(execute=True):
            r = self._register("new@example.com", raw)
        self.assertIn(r.status_code, (status.HTTP_201_CREATED, status.HTTP_204_NO_CONTENT), r.content)
        user = User.objects.get(email="new@example.com")
        membership = GroupMembership.objects.get(group=self.group, user=user)
        self.assertEqual(membership.role, GroupMembership.Role.COLLABORATOR)
        link.refresh_from_db()
        self.assertIsNotNone(link.used_at)

    def test_registration_broadcasts_member_added(self):
        _link, raw = self.make_link()
        with mock.patch("groups.broadcast.broadcast_group_event") as bcast:
            with self.captureOnCommitCallbacks(execute=True):
                self._register("bcast@example.com", raw)
        user = User.objects.get(email="bcast@example.com")
        bcast.assert_called_once()
        gid, event, data = bcast.call_args.args
        self.assertEqual(gid, self.group.pk)
        self.assertEqual(event, EVT_MEMBER_ADDED)
        self.assertEqual(data["user"]["id"], user.pk)
        self.assertEqual(data["role"], GroupMembership.Role.VIEWER)

    # -- refusals ---------------------------------------------------------

    def test_shareable_multi_use_link_is_refused(self):
        link, raw = self.make_link(delivery=GroupInviteLink.Delivery.LINK, single_use=False)
        r = self._register("share@example.com", raw)
        self._assert_refused(r, "share@example.com", link)
        self.assertEqual(r.json(), {"invite_token": [NOT_FOR_REGISTRATION_DETAIL]})

    def test_shareable_single_use_link_is_refused(self):
        link, raw = self.make_link(delivery=GroupInviteLink.Delivery.LINK, single_use=True)
        r = self._register("share1@example.com", raw)
        link = self._assert_refused(r, "share1@example.com", link)
        self.assertIsNone(link.used_at)

    def test_multi_use_emailed_link_is_refused(self):
        # The send endpoint never mints one, but the model allows it.
        link, raw = self.make_link(single_use=False)
        r = self._register("multi@example.com", raw)
        self._assert_refused(r, "multi@example.com", link)

    def test_consumed_invite_is_refused(self):
        link, raw = self.make_link()
        self.assertIn(self._register("first@example.com", raw).status_code, (201, 204))
        r = self._register("second@example.com", raw)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(User.objects.filter(email="second@example.com").exists())
        self.assertEqual(self.group.memberships.count(), 2)

    def test_expired_invite_is_refused(self):
        link, raw = self.make_link(expires_at=timezone.now() - timedelta(seconds=1))
        r = self._register("expired@example.com", raw)
        link = self._assert_refused(r, "expired@example.com", link)
        self.assertEqual(r.json(), {"invite_token": ["This invite link has expired."]})
        self.assertIsNone(link.used_at)

    def test_revoked_invite_is_refused(self):
        link, raw = self.make_link()
        link.is_active = False
        link.save(update_fields=["is_active"])
        r = self._register("revoked@example.com", raw)
        self._assert_refused(r, "revoked@example.com", link)

    def test_unknown_group_token_is_refused(self):
        r = self.client.post(REGISTER_URL, {
            "email": "bogus@example.com", "password1": PASSWORD, "password2": PASSWORD,
            "invite_token": "vbng_" + "0" * 40,
        })
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(User.objects.filter(email="bogus@example.com").exists())

    def test_invite_from_non_site_admin_group_admin_is_refused(self):
        self.admin.is_site_admin = False
        self.admin.save(update_fields=["is_site_admin"])
        link, raw = self.make_link()
        r = self._register("groupadmin@example.com", raw)
        link = self._assert_refused(r, "groupadmin@example.com", link)
        self.assertEqual(r.json(), {"invite_token": [NOT_FOR_REGISTRATION_DETAIL]})
        self.assertIsNone(link.used_at)

    def test_invite_from_sender_demoted_from_site_admin_is_refused(self):
        link, raw = self.make_link()  # sent while a site admin
        self.admin.is_site_admin = False
        self.admin.save(update_fields=["is_site_admin"])
        r = self._register("demotedsa@example.com", raw)
        self._assert_refused(r, "demotedsa@example.com", link)

    @override_settings(INVITE_EMAIL_ENABLED=False)
    def test_invite_refused_once_email_invites_are_disabled(self):
        link, raw = self.make_link()
        r = self._register("disabled@example.com", raw)
        link = self._assert_refused(r, "disabled@example.com", link)
        self.assertEqual(r.json(), {"invite_token": ["Invalid or expired invite link."]})
        self.assertIsNone(link.used_at)

    def test_invite_from_deactivated_sender_is_refused(self):
        link, raw = self.make_link()
        self.admin.is_active = False
        self.admin.save(update_fields=["is_active"])
        r = self._register("deact@example.com", raw)
        link = self._assert_refused(r, "deact@example.com", link)
        self.assertIsNone(link.used_at)

    def test_invite_from_demoted_sender_is_refused(self):
        link, raw = self.make_link()
        GroupMembership.objects.filter(group=self.group, user=self.admin).update(role=GroupMembership.Role.MEMBER)
        r = self._register("demoted@example.com", raw)
        self._assert_refused(r, "demoted@example.com", link)

    def test_invite_from_ancestor_group_admin_is_accepted(self):
        parent = Group.objects.create(name="Org", owner=self.admin)
        self.group.parent = parent
        self.group.save(update_fields=["parent"])
        GroupMembership.objects.filter(group=self.group, user=self.admin).delete()
        GroupMembership.objects.create(group=parent, user=self.admin, role=GroupMembership.Role.ADMIN)
        _link, raw = self.make_link()
        r = self._register("ancestor@example.com", raw)
        self.assertIn(r.status_code, (201, 204), r.content)
        self.assertTrue(GroupMembership.objects.filter(group=self.group, user__email="ancestor@example.com").exists())

    def test_non_string_invite_token_is_refused_as_missing(self):
        r = self.client.post(REGISTER_URL, {
            "email": "num@example.com", "password1": PASSWORD, "password2": PASSWORD, "invite_token": 12345,
        }, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("invite_token", r.json())

    def test_failed_registration_leaves_invite_unconsumed(self):
        link, raw = self.make_link()
        r = self._register("mismatch@example.com", raw, password2="Different!pass123")
        link = self._assert_refused(r, "mismatch@example.com", link)
        self.assertIsNone(link.used_at)

    def test_closed_mode_refuses_emailed_invite(self):
        # CLOSED means no new accounts at all — a group invite does not reopen it.
        set_mode(SiteSetting.RegistrationMode.CLOSED)
        link, raw = self.make_link()
        r = self._register("closed@example.com", raw)
        link = self._assert_refused(r, "closed@example.com", link, code=status.HTTP_403_FORBIDDEN)
        self.assertIsNone(link.used_at)

    def test_open_mode_ignores_group_token(self):
        # Open sites never needed a token; the join still happens via /join/.
        set_mode(SiteSetting.RegistrationMode.OPEN)
        link, raw = self.make_link()
        r = self._register("open@example.com", raw)
        self.assertIn(r.status_code, (201, 204))
        link.refresh_from_db()
        self.assertIsNone(link.used_at)
        self.assertFalse(GroupMembership.objects.filter(user__email="open@example.com").exists())

    def test_site_invite_path_unchanged(self):
        site_link, raw = InviteLink.generate(created_by=self.admin, single_use=True)
        r = self._register("site@example.com", raw)
        self.assertIn(r.status_code, (201, 204))
        site_link.refresh_from_db()
        self.assertIsNotNone(site_link.used_at)
        self.assertFalse(GroupMembership.objects.filter(user__email="site@example.com").exists())

    # -- redeem helper ----------------------------------------------------

    def test_redeem_refuses_an_already_used_invite(self):
        link, _raw = self.make_link()
        user = User.objects.create_user(username="late", password="pass")
        GroupInviteLink.objects.filter(pk=link.pk).update(used_at=timezone.now())
        with self.assertRaises(InviteTokenError):
            redeem_group_registration_token(link, user)
        self.assertFalse(GroupMembership.objects.filter(group=self.group, user=user).exists())


class GroupInviteRegistrationJoinFollowUpTests(_GroupInviteFixture, TestCase):
    """After registering, the SPA follows up with /join/<token>/ (#1445)."""

    def setUp(self):
        cache.clear()
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        self.make_group()
        self.link, self.raw = self.make_link()
        self.client = APIClient()
        r = self.client.post(REGISTER_URL, {
            "email": "joined@example.com", "password1": PASSWORD, "password2": PASSWORD,
            "invite_token": self.raw,
        })
        self.assertIn(r.status_code, (201, 204), r.content)
        self.new_user = User.objects.get(email="joined@example.com")

    def tearDown(self):
        set_mode(SiteSetting.RegistrationMode.OPEN)
        cache.clear()

    def test_new_member_can_preview_and_join_their_used_invite(self):
        client = APIClient()
        client.force_authenticate(self.new_user)
        preview = client.get(join_url(self.raw))
        self.assertEqual(preview.status_code, status.HTTP_200_OK)
        self.assertEqual(preview.json()["group_id"], self.group.pk)
        used_at = GroupInviteLink.objects.get(pk=self.link.pk).used_at
        r = client.post(join_url(self.raw))
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json()["id"], self.group.pk)
        # Re-redemption by the member must not restamp the invite.
        self.assertEqual(GroupInviteLink.objects.get(pk=self.link.pk).used_at, used_at)
        self.assertEqual(GroupMembership.objects.filter(group=self.group, user=self.new_user).count(), 1)

    def test_non_member_still_gets_410_for_used_invite(self):
        outsider = User.objects.create_user(username="outsider", password="pass")
        client = APIClient()
        client.force_authenticate(outsider)
        self.assertEqual(client.get(join_url(self.raw)).status_code, status.HTTP_410_GONE)
        self.assertEqual(client.post(join_url(self.raw)).status_code, status.HTTP_410_GONE)
        self.assertFalse(GroupMembership.objects.filter(group=self.group, user=outsider).exists())

    def test_anonymous_preview_of_used_invite_is_410(self):
        self.assertEqual(APIClient().get(join_url(self.raw)).status_code, status.HTTP_410_GONE)


@override_settings(LOGIN_REDIRECT_URL="http://localhost:5173")
class GroupInviteOAuthSignupTests(_GroupInviteFixture, TestCase):

    def setUp(self):
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        self.make_group()
        self.adapter = SocialRegistrationAdapter()
        self.factory = RequestFactory()

    def tearDown(self):
        set_mode(SiteSetting.RegistrationMode.OPEN)

    def _request(self, token):
        request = self.factory.get("/accounts/google/login/callback/")
        request.session = {PENDING_INVITE_SESSION_KEY: token}
        return request

    def test_middleware_stashes_group_token(self):
        request = self.factory.get("/accounts/google/login/?process=login&invite_token=vbng_abc123")
        request.session = {}
        OAuthInviteTokenMiddleware(mock.MagicMock())(request)
        self.assertEqual(request.session[PENDING_INVITE_SESSION_KEY], "vbng_abc123")

    def test_emailed_invite_opens_signup(self):
        _link, raw = self.make_link()
        self.assertTrue(self.adapter.is_open_for_signup(self._request(raw), mock.MagicMock()))

    def test_shareable_link_redirects_with_specific_error(self):
        _link, raw = self.make_link(delivery=GroupInviteLink.Delivery.LINK, single_use=False)
        request = self._request(raw)
        with self.assertRaises(ImmediateHttpResponse) as ctx:
            self.adapter.is_open_for_signup(request, mock.MagicMock())
        self.assertIn("auth_error=invite_not_for_registration", ctx.exception.response.url)
        self.assertNotIn(PENDING_INVITE_SESSION_KEY, request.session)

    def test_non_site_admin_invite_redirects_with_specific_error(self):
        self.admin.is_site_admin = False
        self.admin.save(update_fields=["is_site_admin"])
        _link, raw = self.make_link()
        with self.assertRaises(ImmediateHttpResponse) as ctx:
            self.adapter.is_open_for_signup(self._request(raw), mock.MagicMock())
        self.assertIn("auth_error=invite_not_for_registration", ctx.exception.response.url)

    @override_settings(INVITE_EMAIL_ENABLED=False)
    def test_invite_redirects_once_email_invites_are_disabled(self):
        _link, raw = self.make_link()
        with self.assertRaises(ImmediateHttpResponse) as ctx:
            self.adapter.is_open_for_signup(self._request(raw), mock.MagicMock())
        self.assertIn("auth_error=invite_invalid", ctx.exception.response.url)

    def test_save_user_with_non_site_admin_invite_creates_no_membership(self):
        link, raw = self.make_link()
        self.admin.is_site_admin = False
        self.admin.save(update_fields=["is_site_admin"])
        self._save_refused(raw, "oauth_groupadmin", "invite_not_for_registration")
        self.assertFalse(GroupMembership.objects.filter(group=self.group, user__username="oauth_groupadmin").exists())
        link.refresh_from_db()
        self.assertIsNone(link.used_at)

    def test_expired_invite_redirects(self):
        _link, raw = self.make_link(expires_at=timezone.now() - timedelta(hours=1))
        with self.assertRaises(ImmediateHttpResponse) as ctx:
            self.adapter.is_open_for_signup(self._request(raw), mock.MagicMock())
        self.assertIn("auth_error=invite_expired", ctx.exception.response.url)

    def _save(self, raw, username):
        request = self._request(raw)
        new_user = User.objects.create_user(username=username, password="pass")
        with mock.patch.object(SocialRegistrationAdapter.__bases__[0], "save_user", return_value=new_user):
            self.adapter.save_user(request, mock.MagicMock(), form=None)
        self.assertNotIn(PENDING_INVITE_SESSION_KEY, request.session)
        return new_user

    def _save_refused(self, raw, username, error_code):
        """save_user must refuse AND roll back the account it just created (#1489)."""
        request = self._request(raw)

        def create(*args, **kwargs):
            return User.objects.create_user(username=username, password="pass")

        with mock.patch.object(SocialRegistrationAdapter.__bases__[0], "save_user", side_effect=create):
            with self.assertRaises(ImmediateHttpResponse) as ctx:
                self.adapter.save_user(request, mock.MagicMock(), form=None)
        self.assertIn(f"auth_error={error_code}", ctx.exception.response.url)
        self.assertFalse(User.objects.filter(username=username).exists())

    def test_save_user_joins_group_and_consumes_invite(self):
        link, raw = self.make_link(role=GroupInviteLink.Role.MEMBER)
        user = self._save(raw, "oauth_new")
        self.assertEqual(GroupMembership.objects.get(group=self.group, user=user).role, "member")
        link.refresh_from_db()
        self.assertIsNotNone(link.used_at)

    def test_save_user_with_consumed_invite_creates_no_membership(self):
        link, raw = self.make_link()
        GroupInviteLink.objects.filter(pk=link.pk).update(used_at=timezone.now())
        self._save_refused(raw, "oauth_late", "invite_invalid")


class GroupInviteRegistrationRaceTests(_GroupInviteFixture, TransactionTestCase):
    """Two registrations racing on one emailed invite: exactly one wins."""

    def setUp(self):
        if connection.vendor == "sqlite":
            self.skipTest("SQLite does not support SELECT FOR UPDATE; this test requires PostgreSQL.")
        cache.clear()
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        self.make_group()

    def tearDown(self):
        set_mode(SiteSetting.RegistrationMode.OPEN)
        cache.clear()

    def test_only_one_concurrent_registration_succeeds(self):
        link, raw = self.make_link()
        results = []
        barrier = threading.Barrier(2)

        def attempt(email):
            from django.db import connections as _conns
            try:
                client = APIClient()
                barrier.wait()
                r = client.post(REGISTER_URL, {
                    "email": email, "password1": PASSWORD, "password2": PASSWORD, "invite_token": raw,
                })
                results.append(r.status_code)
            finally:
                _conns.close_all()

        threads = [threading.Thread(target=attempt, args=(f"race{i}@example.com",)) for i in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(sum(1 for s in results if s in (201, 204)), 1, results)
        self.assertEqual(self.group.memberships.count(), 2)
        link.refresh_from_db()
        self.assertIsNotNone(link.used_at)


class GroupJoinPreviewCanRegisterTests(_GroupInviteFixture, TestCase):
    """``can_register`` on GET /groups/join/<token>/ (#1481).

    A bare advisory boolean: true only when registration would accept the link
    under the current registration mode. Same value for anonymous and signed-in
    callers; never present on 404/410 bodies.
    """

    def setUp(self):
        cache.clear()
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        self.make_group()
        self.member = User.objects.create_user(username="existing", password="pass")

    def tearDown(self):
        set_mode(SiteSetting.RegistrationMode.OPEN)
        cache.clear()

    def _preview(self, raw, user=None):
        client = APIClient()
        if user is not None:
            client.force_authenticate(user)
        return client.get(join_url(raw))

    def _can_register(self, raw):
        """Preview as anonymous and as a signed-in user; both must agree."""
        anon = self._preview(raw)
        authed = self._preview(raw, user=self.member)
        self.assertEqual(anon.status_code, status.HTTP_200_OK, anon.content)
        self.assertEqual(authed.status_code, status.HTTP_200_OK, authed.content)
        self.assertIs(type(anon.json()["can_register"]), bool)
        self.assertEqual(anon.json()["can_register"], authed.json()["can_register"])
        return anon.json()["can_register"]

    def _demote_sender(self):
        self.admin.is_site_admin = False
        self.admin.save(update_fields=["is_site_admin"])

    def _deactivate_sender(self):
        self.admin.is_active = False
        self.admin.save(update_fields=["is_active"])

    # -- matrix -------------------------------------------------------------

    def test_open_mode_is_true_even_for_a_shareable_link(self):
        set_mode(SiteSetting.RegistrationMode.OPEN)
        _link, raw = self.make_link(delivery=GroupInviteLink.Delivery.LINK, single_use=False)
        self.assertTrue(self._can_register(raw))

    def test_invite_only_emailed_site_admin_single_use_is_true(self):
        _link, raw = self.make_link()
        self.assertTrue(self._can_register(raw))

    def test_invite_only_shareable_link_is_false(self):
        _link, raw = self.make_link(delivery=GroupInviteLink.Delivery.LINK, single_use=False)
        self.assertFalse(self._can_register(raw))

    def test_invite_only_non_site_admin_sender_is_false(self):
        _link, raw = self.make_link()
        self._demote_sender()
        self.assertFalse(self._can_register(raw))

    def test_invite_only_deactivated_sender_is_false(self):
        _link, raw = self.make_link()
        self._deactivate_sender()
        # #1490: the preview itself now refuses a link whose creator is
        # inactive (404, like a revoked link) rather than advertising false.
        self.assertEqual(self._preview(raw).status_code, status.HTTP_404_NOT_FOUND)

    def _link_from_deleted_sender(self):
        """A qualifying emailed invite whose sender's account was then deleted.

        ``created_by`` is SET_NULL. The sender is a second site admin who
        admins the group without owning it, since deleting the owner would
        cascade the group (and the link) away.
        """
        sender = User.objects.create_user(username="cosender", password="pass")
        sender.is_site_admin = True
        sender.save(update_fields=["is_site_admin"])
        GroupMembership.objects.create(group=self.group, user=sender, role=GroupMembership.Role.ADMIN)
        link, raw = GroupInviteLink.generate(
            group=self.group, created_by=sender, role=GroupInviteLink.Role.VIEWER,
            expires_at=timezone.now() + timedelta(days=7), single_use=True,
            delivery=GroupInviteLink.Delivery.EMAIL,
        )
        sender.delete()
        link.refresh_from_db()
        self.assertIsNone(link.created_by)
        return link, raw

    def test_invite_only_deleted_sender_is_false(self):
        _link, raw = self._link_from_deleted_sender()
        # #1490: a creator-less link is refused outright at preview.
        self.assertEqual(self._preview(raw).status_code, status.HTTP_404_NOT_FOUND)
        with self.assertRaises(InviteTokenError) as ctx, transaction.atomic():
            validate_group_registration_token(raw)
        self.assertEqual(ctx.exception.code, "invite_invalid")

    @override_settings(INVITE_EMAIL_ENABLED=False)
    def test_invite_only_email_invites_disabled_is_false(self):
        _link, raw = self.make_link()
        self.assertFalse(self._can_register(raw))

    def test_closed_mode_is_false_even_for_a_qualifying_invite(self):
        set_mode(SiteSetting.RegistrationMode.CLOSED)
        _link, raw = self.make_link()
        self.assertFalse(self._can_register(raw))

    def test_preview_discloses_only_the_bare_boolean(self):
        _link, raw = self.make_link()
        self.assertEqual(
            set(self._preview(raw).json()),
            {"group_id", "group_name", "role", "can_register"},
        )

    def test_preview_takes_no_lock_and_consumes_nothing(self):
        link, raw = self.make_link()
        self._preview(raw)
        link.refresh_from_db()
        self.assertIsNone(link.used_at)

    def test_invite_only_preview_query_count(self):
        """Pin the anonymous INVITE_ONLY preview's query count (#1481).

        ``lookup_by_token`` joins the sender and group, so ``can_register``
        adds only the sender's group-admin check, not a lazy sender fetch:
        1 = the link lookup (with sender and group joined), 1 = the group-admin
        ancestor walk, shared between the #1490 creator-still-admin check and
        ``can_register`` (memoized on the link, so it runs once).
        """
        _link, raw = self.make_link()
        self._preview(raw)  # warm the cached registration mode
        with self.assertNumQueries(2):
            r = self._preview(raw)
        self.assertTrue(r.json()["can_register"])

    # -- error bodies ---------------------------------------------------------

    def test_unknown_token_404_has_no_can_register(self):
        r = self._preview("vbng_" + "0" * 40)
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)
        self.assertNotIn("can_register", r.json())

    def test_expired_410_has_no_can_register(self):
        _link, raw = self.make_link(expires_at=timezone.now() - timedelta(minutes=1))
        r = self._preview(raw)
        self.assertEqual(r.status_code, status.HTTP_410_GONE)
        self.assertNotIn("can_register", r.json())

    def test_used_410_has_no_can_register(self):
        link, raw = self.make_link()
        GroupInviteLink.objects.filter(pk=link.pk).update(used_at=timezone.now())
        r = self._preview(raw)
        self.assertEqual(r.status_code, status.HTTP_410_GONE)
        self.assertNotIn("can_register", r.json())

    # -- parity with the registration validator -------------------------------

    def test_preview_matches_registration_validator_for_every_fixture(self):
        """Under INVITE_ONLY the preview says true iff registration would accept."""
        def emailed():
            return self.make_link()

        def shareable_multi():
            return self.make_link(delivery=GroupInviteLink.Delivery.LINK, single_use=False)

        def shareable_single():
            return self.make_link(delivery=GroupInviteLink.Delivery.LINK, single_use=True)

        def emailed_multi():
            return self.make_link(single_use=False)

        def non_site_admin():
            pair = self.make_link()
            self._demote_sender()
            return pair

        def deactivated():
            pair = self.make_link()
            self._deactivate_sender()
            return pair

        def no_longer_group_admin():
            pair = self.make_link()
            GroupMembership.objects.filter(group=self.group, user=self.admin).update(
                role=GroupMembership.Role.VIEWER,
            )
            return pair

        def emailed_disabled():
            return self.make_link()

        def deleted_sender():
            return self._link_from_deleted_sender()

        scenarios = [
            ("emailed", emailed, True),
            ("shareable_multi", shareable_multi, True),
            ("shareable_single", shareable_single, True),
            ("emailed_multi", emailed_multi, True),
            ("non_site_admin", non_site_admin, True),
            ("deactivated", deactivated, True),
            ("no_longer_group_admin", no_longer_group_admin, True),
            ("emailed_disabled", emailed_disabled, False),
            ("deleted_sender", deleted_sender, True),
        ]
        for name, build, email_enabled in scenarios:
            with self.subTest(name), override_settings(INVITE_EMAIL_ENABLED=email_enabled):
                # Fresh sender state per scenario.
                User.objects.filter(pk=self.admin.pk).update(is_active=True, is_site_admin=True)
                GroupMembership.objects.filter(group=self.group, user=self.admin).update(
                    role=GroupMembership.Role.ADMIN,
                )
                self.admin.refresh_from_db()
                _link, raw = build()
                resp = self._preview(raw)
                if resp.status_code == status.HTTP_404_NOT_FOUND:
                    # #1490: a creator who is inactive, gone, or no longer a
                    # group admin gets the revoked-link 404 at preview; the
                    # registration validator must refuse the same link.
                    self.assertIn(name, {"deactivated", "no_longer_group_admin", "deleted_sender"})
                    with self.assertRaises(InviteTokenError), transaction.atomic():
                        validate_group_registration_token(raw)
                    continue
                preview = resp.json()["can_register"]
                try:
                    with transaction.atomic():
                        validate_group_registration_token(raw)
                    accepted = True
                except InviteTokenError:
                    accepted = False
                self.assertEqual(preview, accepted)
