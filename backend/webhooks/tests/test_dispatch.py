"""The webhook dispatcher (#863): order, signing, redaction parity, retry,
auto-disable, cursor expiry, standing, decrypt failure, leases, no leaks."""

import json
import logging
from datetime import timedelta
from io import StringIO
from unittest.mock import patch

from allauth.account.models import EmailAddress
from django.core import mail
from django.core.management import call_command
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from boards.models import BoardEvent, BoardMembership, Notification, Swimlane, SwimlaneCustomFieldDefinition
from groups.models import Group, GroupMembership
from visiban.egress import EgressError
from webhooks import dispatch, signing
from webhooks.models import WebhookSubscription

from .base import ENABLED, HOOK_URL, _make_membership, _make_user, admin_and_board, make_subscription

GOLDEN_SECRET = "whsec_test"
GOLDEN_BODY = b'{"a":1}'
GOLDEN_SIGNATURE = "v1=38877139021993b830af32feea6e18a8da83eb2f6e49ee50bd9e4cf4ca4d3789"


class SigningTests(TestCase):
    def test_golden_vector(self):
        self.assertEqual(signing.sign(GOLDEN_SECRET, 1700000000, GOLDEN_BODY), GOLDEN_SIGNATURE)
        self.assertTrue(signing.verify(GOLDEN_SECRET, 1700000000, GOLDEN_BODY, GOLDEN_SIGNATURE))
        self.assertFalse(signing.verify(GOLDEN_SECRET, 1700000001, GOLDEN_BODY, GOLDEN_SIGNATURE))
        self.assertFalse(signing.verify("whsec_other", 1700000000, GOLDEN_BODY, GOLDEN_SIGNATURE))
        self.assertFalse(signing.verify(GOLDEN_SECRET, 1700000000, GOLDEN_BODY, ""))


class Recorder:
    """Stands in for visiban.egress.guarded_post and records every call."""

    def __init__(self, *outcomes):
        self.calls = []
        self.outcomes = list(outcomes)

    def __call__(self, url, body, headers, **kwargs):
        self.calls.append({"url": url, "body": body, "headers": headers, "row": json.loads(body)})
        outcome = self.outcomes.pop(0) if self.outcomes else 200
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    @property
    def events(self):
        return [c["row"]["event"] for c in self.calls]


@ENABLED
@override_settings(NOTIFICATION_EMAIL_ASYNC=False)
class DispatcherBase(TestCase):
    def setUp(self):
        self.admin, self.board = admin_and_board()
        self.sub = make_subscription(self.board, self.admin, secret=GOLDEN_SECRET)

    def event(self, name="card.created", data=None, actor_id=None, **kw):
        return BoardEvent.objects.create(board_id=self.board.pk, event=name, data=data or {"id": 1}, actor_id=actor_id, **kw)

    def run_with(self, *outcomes):
        rec = Recorder(*outcomes)
        # execute=True: the disable notice's email is sent from on_commit.
        with patch("visiban.egress.guarded_post", rec), self.captureOnCommitCallbacks(execute=True):
            result = dispatch.run_once()
        self.sub.refresh_from_db()
        return rec, result


class DeliveryTests(DispatcherBase):
    def test_delivers_in_event_id_order_and_advances_cursor(self):
        ids = [self.event(f"card.{n}").pk for n in ("created", "updated", "moved")]
        rec, result = self.run_with()
        self.assertEqual([c["row"]["id"] for c in rec.calls], ids)
        self.assertEqual(self.sub.cursor, ids[-1])
        self.assertEqual(result.delivered, 3)
        self.assertIsNotNone(self.sub.last_success_at)
        # Nothing new: a second run posts nothing.
        rec, _ = self.run_with()
        self.assertEqual(rec.calls, [])

    def test_request_shape_and_signature(self):
        row = self.event("card.moved", data={"id": 7, "column": 2}, actor_id=self.admin.pk)
        rec, _ = self.run_with()
        call = rec.calls[0]
        self.assertEqual(call["url"], HOOK_URL)
        self.assertEqual(set(call["row"]), {"id", "event", "data", "actor_id", "actor", "created_at"})
        self.assertEqual(call["row"]["actor"]["id"], self.admin.pk)
        h = call["headers"]
        self.assertEqual(h["Content-Type"], "application/json")
        self.assertTrue(h["User-Agent"].startswith("Visiban-Webhooks/"))
        self.assertEqual(h["X-Visiban-Event"], "card.moved")
        self.assertEqual(h["X-Visiban-Event-Id"], str(row.pk))
        self.assertEqual(h["X-Visiban-Board-Id"], str(self.board.pk))
        self.assertEqual(h["X-Visiban-Subscription-Id"], str(self.sub.pk))
        ts = int(h["X-Visiban-Timestamp"])
        self.assertLess(abs(ts - timezone.now().timestamp()), 60)
        self.assertTrue(signing.verify(GOLDEN_SECRET, ts, call["body"], h["X-Visiban-Signature"]))

    def test_filtered_types_advance_the_cursor_without_a_post(self):
        WebhookSubscription.objects.filter(pk=self.sub.pk).update(event_types=["card.moved"])
        self.event("card.created")
        moved = self.event("card.moved")
        last = self.event("card.updated")
        rec, _ = self.run_with()
        self.assertEqual(rec.events, ["card.moved"])
        self.assertEqual(rec.calls[0]["row"]["id"], moved.pk)
        self.assertEqual(self.sub.cursor, last.pk)

    def test_per_user_and_admin_only_rows_never_sent_but_cursor_passes_them(self):
        self.event("board.star_changed", data={"user_id": self.admin.pk, "is_starred": True}, actor_id=self.admin.pk)
        tail = self.event("share_link.updated", data={"board_uid": "x", "active": True})
        rec, _ = self.run_with()
        self.assertEqual(rec.calls, [])
        self.assertEqual(self.sub.cursor, tail.pk)

    def test_settle_window_holds_back_fresh_rows_and_everything_after_them(self):
        old = self.event("card.created")
        BoardEvent.objects.filter(pk=old.pk).update(created_at=timezone.now() - timedelta(seconds=30))
        self.event("card.updated")  # fresh
        with override_settings(WEBHOOK_SETTLE_SECONDS=10):
            rec, _ = self.run_with()
        self.assertEqual(rec.events, ["card.created"])
        self.assertEqual(self.sub.cursor, old.pk)

    def test_unsettled_lower_id_blocks_settled_higher_id(self):
        low = self.event("card.created")
        high = self.event("card.updated")
        BoardEvent.objects.filter(pk=high.pk).update(created_at=timezone.now() - timedelta(seconds=60))
        with override_settings(WEBHOOK_SETTLE_SECONDS=10):
            rec, _ = self.run_with()
        self.assertEqual(rec.calls, [])
        self.assertLess(self.sub.cursor, low.pk)

    def test_run_cap_per_subscription(self):
        for _ in range(5):
            self.event()
        with override_settings(WEBHOOK_MAX_EVENTS_PER_RUN=2):
            rec, _ = self.run_with()
        self.assertEqual(len(rec.calls), 2)

    def test_disabled_and_demo_mode_do_nothing(self):
        self.event()
        for overrides in ({"WEBHOOKS_ENABLED": False}, {"DEMO_MODE": True}):
            with self.subTest(**overrides), override_settings(**overrides):
                rec, result = self.run_with()
                self.assertTrue(result.skipped)
                self.assertEqual(rec.calls, [])
        from webhooks.models import WebhookDispatcherState

        self.assertFalse(WebhookDispatcherState.objects.exists())

    def test_leased_subscription_is_skipped(self):
        self.event()
        WebhookSubscription.objects.filter(pk=self.sub.pk).update(lease_until=timezone.now() + timedelta(minutes=5))
        rec, _ = self.run_with()
        self.assertEqual(rec.calls, [])

    def test_lease_is_released_after_the_run(self):
        self.event()
        self.run_with()
        self.assertIsNone(self.sub.lease_until)
        self.assertIsNone(self.sub.lease_token)


class RedactionParityTests(DispatcherBase):
    """The webhook payload never has a key the viewer feed does not."""

    def test_payload_is_no_broader_than_the_viewer_feed(self):
        viewer = _make_user()
        _make_membership(self.board, viewer, "viewer")
        member = _make_user()
        lane = Swimlane.objects.create(board=self.board, name="L", position=0)
        secret_field = SwimlaneCustomFieldDefinition.objects.create(
            board=self.board, name="Budget", field_type="text", is_admin_only=True, position=0
        )
        open_field = SwimlaneCustomFieldDefinition.objects.create(
            board=self.board, name="Owner", field_type="text", position=1, is_admin_only=False
        )
        self.event(
            "member.added",
            data={"user": {"id": member.pk}, "role": "member", "is_moderator": True, "is_site_admin": False, "invite": {"id": 3, "created_by_id": 1}},
        )
        self.event("member.updated", data={"user": {"id": member.pk}, "role": "admin", "is_moderator": False})
        self.event("board.updated", data={"id": self.board.pk, "name": "B", "is_starred": True}, actor_id=self.admin.pk)
        self.event(
            "swimlane.updated",
            data={"id": lane.pk, "name": "L", "custom_field_values": [
                {"field_definition": secret_field.pk, "value": "1M"}, {"field_definition": open_field.pk, "value": "Ann"},
            ]},
        )
        self.event("board.star_changed", data={"user_id": self.admin.pk}, actor_id=self.admin.pk)
        self.event("share_link.updated", data={"board_uid": "u", "active": True})

        rec, _ = self.run_with()
        c = APIClient()
        c.force_login(viewer)
        feed = {row["id"]: row for row in c.get(f"/api/v1/boards/{self.board.pk}/events/").data["results"]}

        self.assertEqual(rec.events, ["member.added", "member.updated", "board.updated", "swimlane.updated"])

        def keys(obj, prefix=""):
            out = set()
            if isinstance(obj, dict):
                for k, v in obj.items():
                    out.add(prefix + k)
                    out |= keys(v, prefix + k + ".")
            elif isinstance(obj, list):
                for item in obj:
                    out |= keys(item, prefix + "[].")
            return out

        for call in rec.calls:
            row = call["row"]
            with self.subTest(event=row["event"]):
                self.assertIn(row["id"], feed)
                extra = keys(row) - keys(feed[row["id"]])
                self.assertEqual(extra, set(), f"webhook payload has keys the viewer feed does not: {extra}")
        sent = json.dumps([c["row"] for c in rec.calls])
        self.assertNotIn("is_moderator", sent)
        self.assertNotIn("is_site_admin", sent)
        self.assertNotIn('"invite"', sent)
        self.assertNotIn("is_starred", sent)
        self.assertNotIn("1M", sent)
        self.assertIn("Ann", sent)


class FailureTests(DispatcherBase):
    def test_first_failure_stops_the_run_and_backs_off(self):
        first = self.event()
        self.event()
        rec, result = self.run_with(503)
        self.assertEqual(len(rec.calls), 1)
        self.assertEqual(self.sub.cursor, 0)
        self.assertEqual((self.sub.consecutive_failures, self.sub.last_error_code, self.sub.last_status_code), (1, "http_error", 503))
        self.assertIsNotNone(self.sub.failing_since)
        delay = (self.sub.next_attempt_at - self.sub.last_attempt_at).total_seconds()
        self.assertTrue(30 <= delay <= 33, delay)
        # Not due yet: nothing is retried.
        rec, _ = self.run_with()
        self.assertEqual(rec.calls, [])
        # Due again: the same row is retried first, then the rest.
        WebhookSubscription.objects.filter(pk=self.sub.pk).update(next_attempt_at=timezone.now())
        rec, _ = self.run_with()
        self.assertEqual(rec.calls[0]["row"]["id"], first.pk)
        self.assertEqual(self.sub.consecutive_failures, 0)
        self.assertIsNone(self.sub.failing_since)
        self.assertEqual(self.sub.last_error_code, "")

    def test_backoff_progression_is_capped(self):
        with patch("webhooks.dispatch.secrets.SystemRandom") as rnd:
            rnd.return_value.uniform.return_value = 0
            self.assertEqual([dispatch.backoff_seconds(n) for n in (1, 2, 3, 4)], [30, 60, 120, 240])
            self.assertEqual(dispatch.backoff_seconds(20), 3600)
        self.assertLess(3600, dispatch.CURSOR_EXPIRY_SCAN_GAP.total_seconds())

    def test_redirect_is_an_http_error(self):
        self.event()
        self.run_with(302)
        self.assertEqual((self.sub.last_error_code, self.sub.last_status_code), ("http_error", 302))

    def test_transport_error_codes(self):
        for code in ("connection_failed", "tls_error", "timeout"):
            with self.subTest(code=code):
                WebhookSubscription.objects.filter(pk=self.sub.pk).update(next_attempt_at=None)
                self.event()
                self.run_with(EgressError(code))
                self.assertEqual(self.sub.last_error_code, code)
                self.assertIsNone(self.sub.last_status_code)

    @override_settings(WEBHOOK_DISABLE_AFTER_FAILURES=3)
    def test_auto_disable_after_n_failures_notifies_admins_in_app_and_email(self):
        EmailAddress.objects.create(user=self.admin, email=self.admin.email, verified=True, primary=True)
        self.assertFalse(getattr(self.admin, "email_notif_card_assigned"))  # every opt-in is off
        member = _make_user(email="m@example.com")
        _make_membership(self.board, member, "member")
        self.event()
        for i in range(3):
            WebhookSubscription.objects.filter(pk=self.sub.pk).update(next_attempt_at=None)
            self.run_with(500)
        self.assertFalse(self.sub.enabled)
        self.assertEqual(self.sub.disabled_reason, "failures")
        self.assertIsNotNone(self.sub.disabled_at)
        notes = Notification.objects.filter(action_type="webhook_disabled")
        self.assertEqual([n.recipient_id for n in notes], [self.admin.pk])
        note = notes.get()
        self.assertEqual(note.board_id, self.board.pk)
        self.assertIn(f"#{self.sub.pk}", note.verb)
        self.assertIn("failures", note.verb)
        self.assertIn(self.board.name, note.verb)
        self.assertEqual(len(mail.outbox), 1)
        msg = mail.outbox[0]
        self.assertEqual(msg.to, [self.admin.email])
        text = msg.subject + msg.body
        self.assertIn(f"/boards/{self.board.pk}?settings=webhooks", msg.body)
        for leak in ("hooks.example.com", "s3cr3tpath", "token=abc", "whsec_", "500"):
            self.assertNotIn(leak, text)
        self.assertIn("whatever your email settings", msg.body)

    @override_settings(WEBHOOK_DISABLE_AFTER_FAILURES=1)
    def test_notice_email_needs_a_verified_address(self):
        self.event()
        self.run_with(500)
        self.assertEqual(Notification.objects.filter(action_type="webhook_disabled").count(), 1)
        self.assertEqual(len(mail.outbox), 0)

    def test_auto_disable_after_hours_of_failure(self):
        self.event()
        WebhookSubscription.objects.filter(pk=self.sub.pk).update(
            consecutive_failures=2, failing_since=timezone.now() - timedelta(hours=25)
        )
        self.run_with(500)
        self.assertEqual((self.sub.enabled, self.sub.disabled_reason), (False, "failures"))

    def test_decrypt_failure_disables_and_never_sends(self):
        self.event()
        WebhookSubscription.objects.filter(pk=self.sub.pk).update(secret_encrypted="v1:00000000:x")
        rec, result = self.run_with()
        self.assertEqual(rec.calls, [])
        self.assertEqual((self.sub.enabled, self.sub.disabled_reason), (False, "secret_unavailable"))
        self.assertEqual(result.disabled, 1)

    def test_logs_and_error_fields_never_carry_url_or_secret(self):
        self.event()
        with self.assertLogs(level=logging.DEBUG) as logs, override_settings(WEBHOOK_DISABLE_AFTER_FAILURES=1):
            logging.getLogger("webhooks.dispatch").info("marker")
            self.run_with(EgressError("connection_failed"))
        text = "\n".join(logs.output)
        for leak in ("hooks.example.com", "s3cr3tpath", "token=abc", GOLDEN_SECRET):
            self.assertNotIn(leak, text)
        self.assertIn(f"subscription_id={self.sub.pk}", text)
        self.assertEqual(self.sub.last_error_code, "connection_failed")


class CursorExpiryTests(DispatcherBase):
    def test_cursor_expired_after_prune_when_last_scan_is_old(self):
        old = self.event()
        WebhookSubscription.objects.filter(pk=self.sub.pk).update(
            cursor=old.pk, last_scanned_at=timezone.now() - timedelta(days=2)
        )
        self.event()
        old.delete()
        rec, _ = self.run_with()
        self.assertEqual(rec.calls, [])
        self.assertEqual((self.sub.enabled, self.sub.disabled_reason), (False, "cursor_expired"))
        self.assertTrue(Notification.objects.filter(action_type="webhook_disabled").exists())

    def test_no_false_expiry_on_a_quiet_board_scanned_recently(self):
        old = self.event()
        WebhookSubscription.objects.filter(pk=self.sub.pk).update(
            cursor=old.pk, last_scanned_at=timezone.now() - timedelta(hours=1)
        )
        old.delete()
        new = self.event()
        rec, _ = self.run_with()
        self.assertTrue(self.sub.enabled)
        self.assertEqual([c["row"]["id"] for c in rec.calls], [new.pk])

    def test_caught_up_cursor_moves_to_newest_row(self):
        tail = self.event("board.star_changed", data={"user_id": self.admin.pk}, actor_id=self.admin.pk)
        self.run_with()
        self.assertEqual(self.sub.cursor, tail.pk)
        self.assertIsNotNone(self.sub.last_scanned_at)


class StandingTests(DispatcherBase):
    """D4: each way the configurer loses board-admin standing disables it."""

    def assertDisabledForStanding(self):
        self.event()
        rec, _ = self.run_with()
        self.assertEqual(rec.calls, [])
        self.assertEqual((self.sub.enabled, self.sub.disabled_reason), (False, "creator_lost_access"))

    def _configure_as(self, user):
        WebhookSubscription.objects.filter(pk=self.sub.pk).update(configured_by=user)

    def test_demotion(self):
        other = _make_user()
        _make_membership(self.board, other, "admin")
        self._configure_as(other)
        BoardMembership.objects.filter(board=self.board, user=other).update(role="member")
        self.assertDisabledForStanding()

    def test_removal(self):
        other = _make_user()
        _make_membership(self.board, other, "admin")
        self._configure_as(other)
        BoardMembership.objects.filter(board=self.board, user=other).delete()
        self.assertDisabledForStanding()

    def test_deactivation(self):
        self.admin.is_active = False
        self.admin.save(update_fields=["is_active"])
        self.assertDisabledForStanding()

    def test_deletion_fails_closed(self):
        other = _make_user()
        _make_membership(self.board, other, "admin")
        self._configure_as(other)
        other.delete()
        self.sub.refresh_from_db()
        self.assertIsNone(self.sub.configured_by_id)
        self.assertDisabledForStanding()
        # The board's remaining admin is told.
        self.assertTrue(Notification.objects.filter(action_type="webhook_disabled", recipient=self.admin).exists())

    def test_loss_of_group_inherited_role(self):
        group = Group.objects.create(name="G", owner=self.admin)
        self.board.group = group
        self.board.save(update_fields=["group"])
        gadmin = _make_user()
        gm = GroupMembership.objects.create(group=group, user=gadmin, role="admin")
        self._configure_as(gadmin)
        self.event()
        rec, _ = self.run_with()
        self.assertTrue(self.sub.enabled)
        gm.role = "member"
        gm.save(update_fields=["role"])
        self.assertDisabledForStanding()

    def test_owner_without_membership_row_keeps_standing(self):
        BoardMembership.objects.filter(board=self.board, user=self.admin).delete()
        self.event()
        rec, _ = self.run_with()
        self.assertTrue(self.sub.enabled)
        self.assertEqual(len(rec.calls), 1)


class CommandTests(DispatcherBase):
    def test_one_shot_command(self):
        self.event()
        out = StringIO()
        with patch("visiban.egress.guarded_post", Recorder()):
            call_command("dispatch_webhooks", stdout=out)
        self.assertIn("1 delivered", out.getvalue())

    @override_settings(WEBHOOKS_ENABLED=False)
    def test_disabled_command_writes_nothing(self):
        out = StringIO()
        call_command("dispatch_webhooks", verbosity=2, stdout=out)
        self.assertIn("disabled", out.getvalue())


class SeedTests(TestCase):
    @override_settings(DEBUG=True)
    def test_seed_demo_data_creates_no_subscriptions(self):
        call_command("seed_demo_data", stdout=StringIO(), stderr=StringIO())
        self.assertFalse(WebhookSubscription.objects.exists())
