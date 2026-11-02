"""Access matrix, take-over re-authentication and write races (#863).

Covers the rbac-check and security-review gaps on the MR: every route for
every role below admin, site admins and group admins on a write, the order of
the 404 / role 403 / feature-off checks, token scope, take-over re-auth after
``creator_lost_access``, the account-state gates on the dispatcher's standing
rule, and concurrent dispatcher writes that a view must not roll back.
"""

from unittest.mock import patch

from django.core.cache import cache
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import SCOPE_READ, PersonalAccessToken
from boards.models import BoardEvent, BoardMembership
from groups.models import Group, GroupMembership
from webhooks import dispatch
from webhooks.models import WebhookSubscription

from .base import ENABLED, HOOK_URL, _make_membership, _make_user, admin_and_board, make_subscription, resolving


def _url(board_id, suffix=""):
    return f"/api/v1/boards/{board_id}/webhooks/{suffix}"


def _routes(sub_id):
    return [
        ("get", "status/", None),
        ("get", "", None),
        ("post", "", {"url": HOOK_URL}),
        ("get", f"{sub_id}/", None),
        ("patch", f"{sub_id}/", {"name": "x"}),
        ("delete", f"{sub_id}/", None),
        ("post", f"{sub_id}/disable/", {}),
        ("post", f"{sub_id}/reenable/", {}),
        ("post", f"{sub_id}/rotate/", {}),
        ("post", f"{sub_id}/test/", {}),
    ]


class MatrixBase(TestCase):
    def setUp(self):
        cache.clear()
        self.admin, self.board = admin_and_board()
        self.sub = make_subscription(self.board, self.admin)

    def call(self, client, method, suffix, body):
        with resolving(), patch("visiban.egress.guarded_post", return_value=200):
            return getattr(client, method)(_url(self.board.pk, suffix), body or {}, format="json")

    def as_user(self, user):
        c = APIClient()
        c.force_login(user)
        return c


@ENABLED
class EveryRouteTests(MatrixBase):
    def test_every_route_is_403_for_every_role_below_admin(self):
        for role in ("member", "collaborator", "viewer"):
            user = _make_user()
            _make_membership(self.board, user, role)
            c = self.as_user(user)
            for method, suffix, body in _routes(self.sub.pk):
                with self.subTest(role=role, method=method, suffix=suffix):
                    self.assertEqual(self.call(c, method, suffix, body).status_code, 403)
        self.sub.refresh_from_db()
        self.assertTrue(self.sub.enabled)

    def test_every_route_is_404_for_a_non_member(self):
        c = self.as_user(_make_user())
        for method, suffix, body in _routes(self.sub.pk):
            with self.subTest(method=method, suffix=suffix):
                self.assertEqual(self.call(c, method, suffix, body).status_code, 404)

    def test_is_site_admin_without_all_content_access_is_404(self):
        c = self.as_user(_make_user(is_site_admin=True))
        self.assertEqual(self.call(c, "get", "", None).status_code, 404)

    def test_site_admin_and_group_admin_can_write(self):
        site = _make_user(can_access_all_content=True)
        r = self.call(self.as_user(site), "post", f"{self.sub.pk}/disable/", {})
        self.assertEqual(r.status_code, 200)
        group = Group.objects.create(name="G", owner=self.admin)
        self.board.group = group
        self.board.save(update_fields=["group"])
        gadmin = _make_user()
        GroupMembership.objects.create(group=group, user=gadmin, role="admin")
        r = self.call(self.as_user(gadmin), "post", "", {"url": HOOK_URL})
        self.assertEqual(r.status_code, 201, r.content)

    def test_member_token_is_403_and_read_scoped_token_cannot_write(self):
        member = _make_user()
        _make_membership(self.board, member, "member")
        _, raw = PersonalAccessToken.generate(member, "t-member")
        c = APIClient()
        c.credentials(HTTP_AUTHORIZATION=f"Token {raw}")
        self.assertEqual(self.call(c, "get", "", None).status_code, 403)

        _, raw = PersonalAccessToken.generate(self.admin, "t-read", scopes=[SCOPE_READ])
        c = APIClient()
        c.credentials(HTTP_AUTHORIZATION=f"Token {raw}")
        self.assertEqual(self.call(c, "get", "", None).status_code, 200)
        self.assertEqual(self.call(c, "post", f"{self.sub.pk}/disable/", {}).status_code, 403)
        self.assertEqual(self.call(c, "delete", f"{self.sub.pk}/", None).status_code, 403)
        self.assertEqual(self.call(c, "patch", f"{self.sub.pk}/", {"event_types": []}).status_code, 403)
        self.assertTrue(WebhookSubscription.objects.filter(pk=self.sub.pk, enabled=True).exists())


@override_settings(WEBHOOKS_ENABLED=False)
class FeatureOffOrderingTests(MatrixBase):
    def test_off_never_tells_a_non_admin_anything_about_the_feature(self):
        outsider = self.as_user(_make_user())
        self.assertEqual(self.call(outsider, "get", "", None).status_code, 404)
        member = _make_user()
        _make_membership(self.board, member, "member")
        r = self.call(self.as_user(member), "get", "", None)
        self.assertEqual(r.status_code, 403)
        self.assertNotEqual(r.data.get("code"), "webhooks_disabled")


@ENABLED
class TakeOverReauthTests(MatrixBase):
    """1.3 UI spec Part 8: turning on after creator_lost_access re-verifies the caller."""

    def setUp(self):
        super().setUp()
        self.taker = _make_user(password="correct-horse")
        _make_membership(self.board, self.taker, "admin")
        dispatch.disable(self.sub.pk, "creator_lost_access", notify=False)
        self.c = self.as_user(self.taker)

    def reenable(self, body):
        return self.c.post(_url(self.board.pk, f"{self.sub.pk}/reenable/"), body, format="json")

    def test_password_required_then_incorrect_then_accepted(self):
        r = self.reenable({})
        self.assertEqual((r.status_code, r.data["code"]), (400, "password_required"))
        r = self.reenable({"current_password": "wrong"})
        self.assertEqual((r.status_code, r.data["code"]), (400, "password_incorrect"))
        self.sub.refresh_from_db()
        self.assertFalse(self.sub.enabled)
        r = self.reenable({"current_password": "correct-horse"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.data["configured_by"]["id"], self.taker.pk)
        self.assertTrue(r.data["enabled"])

    def test_wrong_passwords_draw_on_the_login_lockout(self):
        with patch("webhooks.views.password_attempts.begin_current_password_check") as begin:
            self.reenable({"current_password": "wrong"})
        begin.assert_called_once()

    def test_sso_account_needs_a_recent_provider_sign_in(self):
        self.taker.set_unusable_password()
        self.taker.save(update_fields=["password"])
        self.c.force_login(self.taker)
        r = self.reenable({"current_password": "anything"})
        self.assertEqual((r.status_code, r.data["code"]), (403, "recent_login_required"))
        with patch("webhooks.views.session_recently_signed_in_by_provider", return_value=True):
            r = self.reenable({})
        self.assertEqual(r.status_code, 200, r.content)

    def test_other_reasons_need_no_password(self):
        other = make_subscription(self.board, self.admin)
        dispatch.disable(other.pk, "failures", notify=False)
        r = self.c.post(_url(self.board.pk, f"{other.pk}/reenable/"), {}, format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_password_is_never_echoed(self):
        r = self.reenable({"current_password": "wrong"})
        self.assertNotIn("wrong", r.content.decode())


@ENABLED
class ConcurrentWriteTests(MatrixBase):
    """A view must not roll back what the dispatcher wrote after the view's read."""

    def _stale(self):
        stale = WebhookSubscription.objects.select_related("created_by", "configured_by").get(pk=self.sub.pk)
        WebhookSubscription.objects.filter(pk=self.sub.pk).update(
            enabled=False, disabled_reason="failures", cursor=99, consecutive_failures=20
        )
        return stale

    def test_patch_and_rotate_keep_a_concurrent_disable_and_cursor(self):
        c = self.as_user(self.admin)
        for method, suffix, body in [("patch", f"{self.sub.pk}/", {"name": "renamed"}), ("post", f"{self.sub.pk}/rotate/", {})]:
            with self.subTest(suffix=suffix):
                WebhookSubscription.objects.filter(pk=self.sub.pk).update(enabled=True, disabled_reason="", cursor=0)
                stale = self._stale()
                with patch("webhooks.views.WebhookSubscriptionViewSet._subscription", return_value=stale):
                    r = getattr(c, method)(_url(self.board.pk, suffix), body, format="json")
                self.assertEqual(r.status_code, 200, r.content)
                row = WebhookSubscription.objects.get(pk=self.sub.pk)
                self.assertEqual((row.enabled, row.disabled_reason, row.cursor, row.consecutive_failures), (False, "failures", 99, 20))


@ENABLED
@override_settings(NOTIFICATION_EMAIL_ASYNC=False)
class StandingGateTests(MatrixBase):
    def _run(self):
        BoardEvent.objects.create(board_id=self.board.pk, event="card.created", data={})
        with patch("visiban.egress.guarded_post", return_value=200) as post:
            dispatch.run_once()
        self.sub.refresh_from_db()
        return post

    def test_forced_password_change_stops_delivery(self):
        self.admin.must_change_password = True
        self.admin.save(update_fields=["must_change_password"])
        post = self._run()
        post.assert_not_called()
        self.assertEqual(self.sub.disabled_reason, "creator_lost_access")

    def test_role_outside_the_enum_fails_closed(self):
        other = _make_user()
        BoardMembership.objects.create(board=self.board, user=other, role="admin")
        BoardMembership.objects.filter(board=self.board, user=other).update(role="superuser")
        WebhookSubscription.objects.filter(pk=self.sub.pk).update(configured_by=other)
        self._run()
        self.assertEqual(self.sub.disabled_reason, "creator_lost_access")

    def test_losing_all_content_access_stops_a_site_admin_owner(self):
        site = _make_user(can_access_all_content=True)
        WebhookSubscription.objects.filter(pk=self.sub.pk).update(configured_by=site)
        self._run()
        self.assertTrue(self.sub.enabled)
        site.can_access_all_content = False
        site.save(update_fields=["can_access_all_content"])
        self._run()
        self.assertEqual(self.sub.disabled_reason, "creator_lost_access")

    def test_a_rotation_mid_run_stops_further_deliveries_with_the_old_secret(self):
        for _ in range(3):
            BoardEvent.objects.create(board_id=self.board.pk, event="card.created", data={})
        calls = []

        def post(url, body, headers, **kwargs):
            calls.append(headers["X-Visiban-Event-Id"])
            if len(calls) == 1:
                WebhookSubscription.objects.filter(pk=self.sub.pk).update(
                    secret_rotated_at=timezone.now(), configured_at=timezone.now()
                )
            return 200

        with patch("visiban.egress.guarded_post", post):
            dispatch.run_once()
        self.assertEqual(len(calls), 1)
