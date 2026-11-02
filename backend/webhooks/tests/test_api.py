"""``/api/v1/boards/{id}/webhooks/`` access, validation and lifecycle (#863)."""

from unittest.mock import patch

from django.core.cache import cache
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from accounts.models import PersonalAccessToken
from boards.models import BoardEvent
from groups.models import Group, GroupMembership
from visiban import crypto
from webhooks import dispatch
from webhooks.models import SUBSCRIBABLE_EVENT_TYPES, WebhookDispatcherState, WebhookSubscription
from webhooks.views import WebhookConfigThrottle, WebhookTestThrottle

from .base import (
    ENABLED,
    HOOK_URL,
    _make_board,
    _make_membership,
    _make_user,
    admin_and_board,
    make_subscription,
    resolving,
)


def _url(board_id, suffix=""):
    return f"/api/v1/boards/{board_id}/webhooks/{suffix}"


class WebhookApiBase(TestCase):
    def setUp(self):
        cache.clear()
        self.admin, self.board = admin_and_board()
        self.client = APIClient()
        self.client.force_login(self.admin)

    def create(self, client=None, **body):
        body.setdefault("url", HOOK_URL)
        with resolving():
            return (client or self.client).post(_url(self.board.pk), body, format="json")


@ENABLED
class AccessTests(WebhookApiBase):
    def test_admin_crud_round_trip(self):
        r = self.create(name="Deploys", event_types=["card.moved"])
        self.assertEqual(r.status_code, 201, r.content)
        sid = r.data["id"]
        self.assertEqual(r.data["event_types"], ["card.moved"])
        self.assertEqual(self.client.get(_url(self.board.pk)).data[0]["id"], sid)
        self.assertEqual(self.client.get(_url(self.board.pk, f"{sid}/")).data["name"], "Deploys")
        r = self.client.patch(_url(self.board.pk, f"{sid}/"), {"name": "Renamed"}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.data["name"], "Renamed")
        r = self.client.post(_url(self.board.pk, f"{sid}/disable/"))
        self.assertEqual((r.status_code, r.data["enabled"], r.data["disabled_reason"]), (200, False, "manual"))
        self.assertEqual(self.client.delete(_url(self.board.pk, f"{sid}/")).status_code, 204)
        self.assertFalse(WebhookSubscription.objects.exists())

    def test_put_is_not_routed(self):
        sub = make_subscription(self.board, self.admin)
        self.assertEqual(self.client.put(_url(self.board.pk, f"{sub.pk}/"), {}, format="json").status_code, 405)

    def test_roles_below_admin_get_403(self):
        sub = make_subscription(self.board, self.admin)
        for role in ("member", "collaborator", "viewer"):
            user = _make_user()
            _make_membership(self.board, user, role)
            c = APIClient()
            c.force_login(user)
            with self.subTest(role=role):
                self.assertEqual(c.get(_url(self.board.pk)).status_code, 403)
                self.assertEqual(c.get(_url(self.board.pk, "status/")).status_code, 403)
                self.assertEqual(c.post(_url(self.board.pk), {"url": HOOK_URL}, format="json").status_code, 403)
                self.assertEqual(c.delete(_url(self.board.pk, f"{sub.pk}/")).status_code, 403)
                self.assertEqual(c.post(_url(self.board.pk, f"{sub.pk}/test/")).status_code, 403)

    def test_non_member_gets_404(self):
        c = APIClient()
        c.force_login(_make_user())
        self.assertEqual(c.get(_url(self.board.pk)).status_code, 404)
        self.assertEqual(c.get(_url(self.board.pk, "status/")).status_code, 404)
        self.assertEqual(c.post(_url(self.board.pk), {"url": HOOK_URL}, format="json").status_code, 404)

    def test_anonymous_is_refused(self):
        self.assertIn(APIClient().get(_url(self.board.pk)).status_code, (401, 403))

    def test_subscription_from_another_board_is_404(self):
        other_admin, other_board = admin_and_board("Other board")
        foreign = make_subscription(other_board, other_admin)
        for method, suffix in [
            ("get", f"{foreign.pk}/"),
            ("patch", f"{foreign.pk}/"),
            ("delete", f"{foreign.pk}/"),
            ("post", f"{foreign.pk}/disable/"),
            ("post", f"{foreign.pk}/rotate/"),
            ("post", f"{foreign.pk}/test/"),
            ("post", f"{foreign.pk}/reenable/"),
        ]:
            with self.subTest(method=method, suffix=suffix):
                r = getattr(self.client, method)(_url(self.board.pk, suffix), {}, format="json")
                self.assertEqual(r.status_code, 404)
        foreign.refresh_from_db()
        self.assertTrue(foreign.enabled)

    def test_site_admin_with_all_content_access_may_manage(self):
        site = _make_user(can_access_all_content=True)
        c = APIClient()
        c.force_login(site)
        self.assertEqual(c.get(_url(self.board.pk)).status_code, 200)

    def test_group_inherited_admin_may_manage(self):
        group = Group.objects.create(name="G", owner=self.admin)
        self.board.group = group
        self.board.save(update_fields=["group"])
        gadmin = _make_user()
        GroupMembership.objects.create(group=group, user=gadmin, role="admin")
        c = APIClient()
        c.force_login(gadmin)
        self.assertEqual(c.get(_url(self.board.pk)).status_code, 200)


class FeatureGateTests(WebhookApiBase):
    @override_settings(WEBHOOKS_ENABLED=False)
    def test_feature_off_refuses_everything_but_status(self):
        sub = make_subscription(self.board, self.admin)
        r = self.client.get(_url(self.board.pk, "status/"))
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.data["enabled"])
        for method, suffix in [("get", ""), ("post", ""), ("get", f"{sub.pk}/"), ("delete", f"{sub.pk}/"), ("post", f"{sub.pk}/test/")]:
            with self.subTest(method=method, suffix=suffix):
                r = getattr(self.client, method)(_url(self.board.pk, suffix), {"url": HOOK_URL}, format="json")
                self.assertEqual(r.status_code, 403)
                self.assertEqual(r.data["code"], "webhooks_disabled")

    @override_settings(WEBHOOKS_ENABLED=True, DEMO_MODE=True)
    def test_demo_mode_counts_as_off(self):
        self.assertFalse(self.client.get(_url(self.board.pk, "status/")).data["enabled"])
        self.assertFalse(dispatch.webhooks_enabled())

    @ENABLED
    def test_status_reports_dispatcher_heartbeat_and_event_types(self):
        r = self.client.get(_url(self.board.pk, "status/"))
        self.assertEqual(r.data["enabled"], True)
        self.assertIsNone(r.data["dispatcher_last_run_at"])
        self.assertTrue(r.data["dispatcher_stale"])
        self.assertEqual(r.data["subscribable_event_types"], list(SUBSCRIBABLE_EVENT_TYPES))
        self.assertEqual((r.data["disable_after_failures"], r.data["test_timeout_seconds"]), (20, 10.0))
        for excluded in ("board.star_changed", "saved_filter.created", "share_link.updated", "ping", "board.deleted"):
            self.assertNotIn(excluded, r.data["subscribable_event_types"])
        self.assertIn("card.moved", r.data["subscribable_event_types"])
        dispatch.run_once()
        r = self.client.get(_url(self.board.pk, "status/"))
        self.assertIsNotNone(r.data["dispatcher_last_run_at"])
        self.assertFalse(r.data["dispatcher_stale"])
        self.assertEqual(WebhookDispatcherState.objects.count(), 1)


@ENABLED
class SessionRequiredTests(WebhookApiBase):
    def setUp(self):
        super().setUp()
        self.sub = make_subscription(self.board, self.admin)
        _, raw = PersonalAccessToken.generate(self.admin, "t-863")
        self.pat = APIClient()
        self.pat.credentials(HTTP_AUTHORIZATION=f"Token {raw}")

    def test_pat_refused_on_session_only_actions(self):
        cases = [
            ("post", "", {"url": HOOK_URL}),
            ("patch", f"{self.sub.pk}/", {"url": HOOK_URL}),
            ("post", f"{self.sub.pk}/reenable/", {}),
            ("post", f"{self.sub.pk}/rotate/", {}),
            ("post", f"{self.sub.pk}/test/", {}),
        ]
        before = WebhookSubscription.objects.get(pk=self.sub.pk)
        for method, suffix, body in cases:
            with self.subTest(method=method, suffix=suffix), resolving():
                r = getattr(self.pat, method)(_url(self.board.pk, suffix), body, format="json")
                self.assertEqual(r.status_code, 403, r.content)
                self.assertEqual(r.data["code"], "session_required")
        after = WebhookSubscription.objects.get(pk=self.sub.pk)
        self.assertEqual(before.secret_encrypted, after.secret_encrypted)
        self.assertEqual(before.url_encrypted, after.url_encrypted)

    def test_pat_allowed_on_read_and_narrowing_actions(self):
        self.assertEqual(self.pat.get(_url(self.board.pk)).status_code, 200)
        self.assertEqual(self.pat.get(_url(self.board.pk, f"{self.sub.pk}/")).status_code, 200)
        r = self.pat.patch(_url(self.board.pk, f"{self.sub.pk}/"), {"name": "x", "event_types": ["card.created"]}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.pat.post(_url(self.board.pk, f"{self.sub.pk}/disable/")).status_code, 200)
        self.assertEqual(self.pat.delete(_url(self.board.pk, f"{self.sub.pk}/")).status_code, 204)

    def test_force_authenticate_is_not_a_session(self):
        c = APIClient()
        c.force_authenticate(self.admin)
        r = c.post(_url(self.board.pk, f"{self.sub.pk}/rotate/"))
        self.assertEqual(r.data["code"], "session_required")


@ENABLED
class CreateTests(WebhookApiBase):
    def test_create_returns_url_and_secret_once_with_no_store(self):
        BoardEvent.objects.create(board_id=self.board.pk, event="card.created", data={})
        latest = BoardEvent.objects.create(board_id=self.board.pk, event="card.created", data={})
        r = self.create(name="n")
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r["Cache-Control"], "no-store")
        self.assertEqual(r.data["url"], HOOK_URL)
        self.assertTrue(r.data["secret"].startswith("whsec_"))
        self.assertGreaterEqual(len(r.data["secret"]), 40)
        self.assertEqual(r.data["url_display"], "hooks.example.com/…/=abc")
        self.assertEqual(r.data["url_host"], "hooks.example.com")
        self.assertEqual(r.data["configured_by"]["id"], self.admin.pk)
        self.assertEqual(r.data["created_by"]["id"], self.admin.pk)
        self.assertEqual(set(r.data["configured_by"]), {"id", "username", "display_name", "avatar_url"})
        # D5: starts at the board's newest event.
        self.assertEqual(r.data["last_delivered_event_id"], latest.pk)
        sub = WebhookSubscription.objects.get()
        self.assertNotIn("s3cr3tpath", sub.url_encrypted)
        self.assertNotIn(r.data["secret"], sub.secret_encrypted)
        self.assertEqual(sub.get_url(), HOOK_URL)
        self.assertEqual(sub.get_secret(), r.data["secret"])

    def test_create_on_empty_board_is_not_expired_by_its_first_event(self):
        # Cursor 0 with no scan is judged from creation; still "never scanned",
        # so it keeps its place at the front of the dispatch order.
        self.create(name="n")
        sub = WebhookSubscription.objects.get()
        self.assertEqual(sub.cursor, 0)
        self.assertIsNone(sub.last_scanned_at)
        BoardEvent.objects.create(board_id=self.board.pk, event="card.created", data={})
        self.assertFalse(dispatch.cursor_expired(sub))

    def test_url_and_secret_never_returned_after_create(self):
        sid = self.create().data["id"]
        for r in (
            self.client.get(_url(self.board.pk)),
            self.client.get(_url(self.board.pk, f"{sid}/")),
            self.client.patch(_url(self.board.pk, f"{sid}/"), {"name": "z"}, format="json"),
            self.client.post(_url(self.board.pk, f"{sid}/disable/")),
        ):
            body = r.content.decode()
            self.assertNotIn("s3cr3tpath", body)
            self.assertNotIn("whsec_", body)
            self.assertNotIn('"secret"', body)

    def test_empty_board_cursor_is_zero(self):
        self.assertEqual(self.create().data["last_delivered_event_id"], 0)

    def test_invalid_url_codes(self):
        for url, reason in [
            ("ftp://x.example/", "format"),
            ("https://user:pw@hooks.example.com/", "creds"),
            ("not a url", "format"),
            ("https://hooks.example.com:0/", "format"),
            ("http://hooks.example.com/", "http"),
        ]:
            with self.subTest(url=url):
                r = self.create(url=url)
                self.assertEqual(r.status_code, 400)
                self.assertEqual(r.data, {"code": "invalid_url", "reason": reason, "detail": r.data["detail"]})
                self.assertIsInstance(r.data["code"], str)
        r = self.client.post(_url(self.board.pk), {"name": "no url"}, format="json")
        self.assertEqual(r.data["code"], "invalid_url")
        r = self.client.post(_url(self.board.pk), {"url": 5}, format="json")
        self.assertEqual(r.data["code"], "invalid_url")

    def test_url_not_allowed_is_one_neutral_code(self):
        details = set()
        for addrs in (("10.0.0.1",), ("127.0.0.1",), ("169.254.169.254",), ("93.184.216.34", "192.168.0.1"), ()):
            with self.subTest(addrs=addrs), patch("visiban.egress._resolve", return_value=[__import__("ipaddress").ip_address(a) for a in addrs]):
                r = self.client.post(_url(self.board.pk), {"url": "https://internal.example.com/"}, format="json")
                self.assertEqual(r.status_code, 400)
                self.assertEqual(r.data["code"], "url_not_allowed")
                details.add(r.data["detail"])
        with patch("visiban.egress._resolve", side_effect=OSError("nxdomain internal.example.com")):
            r = self.client.post(_url(self.board.pk), {"url": "https://internal.example.com/"}, format="json")
            self.assertEqual(r.data["code"], "url_not_allowed")
            details.add(r.data["detail"])
        self.assertEqual(len(details), 1)
        detail = details.pop()
        self.assertEqual(detail, "Visiban can't send to this address. If it should be allowed, ask your Visiban operator.")
        for addr in ("10.0.0.1", "127.0.0.1", "169.254", "192.168"):
            self.assertNotIn(addr, detail)
        self.assertFalse(WebhookSubscription.objects.exists())

    def test_http_needs_allowlist(self):
        r = self.create(url="http://hooks.example.com/x")
        self.assertEqual((r.data["code"], r.data["reason"]), ("invalid_url", "http"))
        with override_settings(WEBHOOK_ALLOWED_PRIVATE_TARGETS="n8n.lan"):
            r = self.create(url="http://hooks.example.com/x")
            self.assertEqual(r.data["code"], "url_not_allowed")
            with resolving("192.168.1.5"):
                r = self.client.post(_url(self.board.pk), {"url": "http://n8n.lan:5678/hook"}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.data["url_display"], "n8n.lan/…/hook")

    def test_invalid_event_types(self):
        for value in [["board.star_changed"], ["saved_filter.created"], ["share_link.updated"], ["ping"], ["board.deleted"], ["nope"], "card.moved", [1], ["card.moved", "card.moved"], None]:
            with self.subTest(value=value):
                r = self.create(event_types=value)
                self.assertEqual(r.status_code, 400, r.content)
                self.assertEqual(r.data["code"], "invalid_event_types")

    def test_non_object_body(self):
        r = self.client.post(_url(self.board.pk), [1, 2], format="json")
        self.assertEqual(r.status_code, 400)

    @override_settings(WEBHOOK_MAX_PER_BOARD=2)
    def test_limit_per_board(self):
        self.assertEqual(self.create().status_code, 201)
        self.assertEqual(self.create().status_code, 201)
        r = self.create()
        self.assertEqual((r.status_code, r.data["code"]), (400, "limit_reached"))

    @override_settings(WEBHOOK_MAX_PER_USER=1)
    def test_limit_per_user(self):
        self.assertEqual(self.create().status_code, 201)
        _, board2 = admin_and_board("Second")
        _make_membership(board2, self.admin, "admin")
        with resolving():
            r = self.client.post(_url(board2.pk), {"url": HOOK_URL}, format="json")
        self.assertEqual(r.data["code"], "limit_reached")

    @override_settings(WEBHOOK_MAX_TOTAL=1)
    def test_limit_total(self):
        other_admin, other = admin_and_board("Elsewhere")
        make_subscription(other, other_admin)
        self.assertEqual(self.create().data["code"], "limit_reached")

    def test_create_is_throttled(self):
        with patch.dict(WebhookConfigThrottle.THROTTLE_RATES, {"webhook_config": "1/hour"}):
            self.assertEqual(self.create().status_code, 201)
            self.assertEqual(self.create().status_code, 429)


@ENABLED
class UpdateTests(WebhookApiBase):
    def test_url_change_revalidates_and_restamps_owner(self):
        sub = make_subscription(self.board, self.admin)
        other = _make_user()
        _make_membership(self.board, other, "admin")
        c = APIClient()
        c.force_login(other)
        with resolving("10.0.0.9"):
            r = c.patch(_url(self.board.pk, f"{sub.pk}/"), {"url": "https://new.example.com/h"}, format="json")
        self.assertEqual(r.data["code"], "url_not_allowed")
        with resolving():
            r = c.patch(_url(self.board.pk, f"{sub.pk}/"), {"url": "https://new.example.com/h"}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.data["configured_by"]["id"], other.pk)
        self.assertEqual(r.data["created_by"]["id"], self.admin.pk)
        self.assertEqual(r.data["url_host"], "new.example.com")
        self.assertNotIn("url", r.data)

    def test_rename_does_not_restamp_owner(self):
        sub = make_subscription(self.board, self.admin)
        other = _make_user()
        _make_membership(self.board, other, "admin")
        c = APIClient()
        c.force_login(other)
        r = c.patch(_url(self.board.pk, f"{sub.pk}/"), {"name": "x", "event_types": []}, format="json")
        self.assertEqual(r.data["configured_by"]["id"], self.admin.pk)


@ENABLED
class RotateReenableTestActionTests(WebhookApiBase):
    def test_rotate_returns_new_secret_once_and_invalidates_old(self):
        sub = make_subscription(self.board, self.admin, secret="whsec_old")
        r = self.client.post(_url(self.board.pk, f"{sub.pk}/rotate/"))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r["Cache-Control"], "no-store")
        self.assertTrue(r.data["secret"].startswith("whsec_"))
        sub.refresh_from_db()
        self.assertEqual(sub.get_secret(), r.data["secret"])
        self.assertNotEqual(sub.get_secret(), "whsec_old")
        self.assertIsNotNone(sub.secret_rotated_at)
        self.assertNotIn("secret", self.client.get(_url(self.board.pk, f"{sub.pk}/")).data)

    def test_reenable_from_cursor_and_latest(self):
        e1 = BoardEvent.objects.create(board_id=self.board.pk, event="card.created", data={})
        sub = make_subscription(self.board, self.admin, cursor=e1.pk)
        dispatch.disable(sub.pk, "failures", notify=False)
        e2 = BoardEvent.objects.create(board_id=self.board.pk, event="card.created", data={})
        r = self.client.post(_url(self.board.pk, f"{sub.pk}/reenable/"), {}, format="json")
        self.assertEqual((r.status_code, r.data["enabled"], r.data["disabled_reason"]), (200, True, None))
        self.assertEqual(r.data["last_delivered_event_id"], e1.pk)
        dispatch.disable(sub.pk, "manual", notify=False)
        r = self.client.post(_url(self.board.pk, f"{sub.pk}/reenable/"), {"resume_from": "latest"}, format="json")
        self.assertEqual(r.data["last_delivered_event_id"], e2.pk)
        r = self.client.post(_url(self.board.pk, f"{sub.pk}/reenable/"), {"resume_from": "bogus"}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_reenable_cursor_expired_is_409_and_latest_works(self):
        e1 = BoardEvent.objects.create(board_id=self.board.pk, event="card.created", data={})
        sub = make_subscription(self.board, self.admin, cursor=e1.pk)
        dispatch.disable(sub.pk, "manual", notify=False)
        BoardEvent.objects.create(board_id=self.board.pk, event="card.created", data={})
        e1.delete()  # pruned
        r = self.client.post(_url(self.board.pk, f"{sub.pk}/reenable/"), {"resume_from": "cursor"}, format="json")
        self.assertEqual((r.status_code, r.data["code"]), (409, "cursor_expired"))
        r = self.client.post(_url(self.board.pk, f"{sub.pk}/reenable/"), {"resume_from": "latest"}, format="json")
        self.assertEqual(r.status_code, 200)

    def test_reenable_restamps_owner(self):
        sub = make_subscription(self.board, self.admin)
        dispatch.disable(sub.pk, "creator_lost_access", notify=False)
        other = _make_user()
        _make_membership(self.board, other, "admin")
        c = APIClient()
        c.force_login(other)
        r = c.post(_url(self.board.pk, f"{sub.pk}/reenable/"), {"current_password": "pass"}, format="json")
        self.assertEqual(r.data["configured_by"]["id"], other.pk)

    def test_reenable_refused_when_secret_unreadable(self):
        sub = make_subscription(self.board, self.admin)
        dispatch.disable(sub.pk, "secret_unavailable", notify=False)
        # Written under another key (fingerprint mismatch), as after a key rotation.
        WebhookSubscription.objects.filter(pk=sub.pk).update(url_encrypted="v1:00000000:token")
        r = self.client.post(_url(self.board.pk, f"{sub.pk}/reenable/"), {}, format="json")
        self.assertEqual((r.status_code, r.data["code"]), (409, "secret_unavailable"))

    def test_send_test_reports_outcome_without_touching_state(self):
        sub = make_subscription(self.board, self.admin)
        with patch("visiban.egress.guarded_post", return_value=204) as post:
            r = self.client.post(_url(self.board.pk, f"{sub.pk}/test/"))
        self.assertEqual(set(r.data), {"ok", "code", "status_code", "latency_ms"})
        self.assertEqual((r.data["ok"], r.data["code"], r.data["status_code"]), (True, None, 204))
        self.assertIsInstance(r.data["latency_ms"], int)
        body = post.call_args.args[1]
        headers = post.call_args.args[2]
        self.assertIn(b'"event":"webhook.test"', body)
        self.assertIn(b'"id":0', body)
        self.assertEqual(headers["X-Visiban-Event-Id"], "0")
        with patch("visiban.egress.guarded_post", return_value=500):
            r = self.client.post(_url(self.board.pk, f"{sub.pk}/test/"))
        self.assertEqual((r.data["ok"], r.data["code"], r.data["status_code"]), (False, "http_error", 500))
        self.assertIsInstance(r.data["latency_ms"], int)
        from visiban.egress import EgressError

        with patch("visiban.egress.guarded_post", side_effect=EgressError("timeout")):
            r = self.client.post(_url(self.board.pk, f"{sub.pk}/test/"))
        self.assertEqual(r.data, {"ok": False, "code": "timeout", "status_code": None, "latency_ms": None})
        sub.refresh_from_db()
        self.assertEqual((sub.consecutive_failures, sub.last_error_code, sub.cursor), (0, "", 0))

    def test_send_test_rejects_private_target_at_send_time(self):
        sub = make_subscription(self.board, self.admin)
        with resolving("127.0.0.1"):
            r = self.client.post(_url(self.board.pk, f"{sub.pk}/test/"))
        self.assertEqual(r.data, {"ok": False, "code": "connection_failed", "status_code": None, "latency_ms": None})

    def test_send_test_is_throttled(self):
        sub = make_subscription(self.board, self.admin)
        with patch.dict(WebhookTestThrottle.THROTTLE_RATES, {"webhook_test": "1/hour"}), patch(
            "visiban.egress.guarded_post", return_value=200
        ):
            self.assertEqual(self.client.post(_url(self.board.pk, f"{sub.pk}/test/")).status_code, 200)
            self.assertEqual(self.client.post(_url(self.board.pk, f"{sub.pk}/test/")).status_code, 429)

    def test_secret_unreadable_test_reports_code(self):
        sub = make_subscription(self.board, self.admin)
        WebhookSubscription.objects.filter(pk=sub.pk).update(secret_encrypted="v1:00000000:garbage")
        r = self.client.post(_url(self.board.pk, f"{sub.pk}/test/"))
        self.assertEqual(r.data["code"], "secret_unavailable")
        self.assertFalse(crypto.secret_is_decryptable("v1:00000000:garbage", info=crypto.WEBHOOK_SECRET_INFO))


@ENABLED
class BoardDeletionTests(WebhookApiBase):
    def test_board_delete_cascades(self):
        make_subscription(self.board, self.admin)
        self.board.delete()
        self.assertFalse(WebhookSubscription.objects.exists())


class SeparateBoardFixtureTests(TestCase):
    def test_make_board_helper_is_admin(self):
        u = _make_user()
        b = _make_board(u)
        self.assertEqual(b.memberships.get(user=u).role, "admin")


@ENABLED
class NeutralRefusalTests(WebhookApiBase):
    """Every address refusal: same status, same body, same timing (#863 follow-up spec)."""

    def _refuse(self, url, addrs=None, side_effect=None):
        import ipaddress as _ip

        kwargs = {"side_effect": side_effect} if side_effect else {"return_value": [_ip.ip_address(a) for a in addrs or ()]}
        with patch("visiban.egress._resolve", **kwargs), patch("webhooks.serializers._sleep") as sleep, patch(
            "webhooks.serializers.time.monotonic", side_effect=[100.0, 100.05]
        ):
            r = self.client.post(_url(self.board.pk), {"url": url}, format="json")
        return r, sleep

    @override_settings(WEBHOOK_REFUSAL_FLOOR_SECONDS=None, WEBHOOK_CONNECT_TIMEOUT_SECONDS=3)
    def test_every_rule_answers_identically_and_waits_for_the_same_floor(self):
        cases = [
            ("https://10.0.0.1/hook", None, None),  # private literal, no DNS
            ("https://169.254.169.254/latest", None, None),  # metadata literal
            ("https://[::1]/x", None, None),  # loopback literal
            ("https://internal.example.com/", ["192.168.0.9"], None),  # resolves to private
            ("https://meta.example.com/", ["169.254.169.254"], None),  # resolves to metadata
            ("https://nx.example.com/", None, OSError("nxdomain")),  # does not resolve
        ]
        bodies = set()
        for url, addrs, err in cases:
            with self.subTest(url=url):
                r, sleep = self._refuse(url, addrs, err)
                self.assertEqual(r.status_code, 400)
                bodies.add(r.content)
                # The refusal is held until the same floor (the DNS deadline).
                sleep.assert_called_once()
                self.assertAlmostEqual(sleep.call_args.args[0], 3 - 0.05, places=3)
        self.assertEqual(len(bodies), 1)
        self.assertNotIn(b"10.0.0.1", bodies.pop())

    def test_input_shape_errors_answer_at_once(self):
        with patch("webhooks.serializers._sleep") as sleep:
            r = self.client.post(_url(self.board.pk), {"url": "https://u:p@hooks.example.com/"}, format="json")
        self.assertEqual(r.data["reason"], "creds")
        sleep.assert_not_called()
