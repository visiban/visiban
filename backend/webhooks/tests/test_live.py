"""``webhook.changed``: live updates of webhook settings across admin sessions (#2057)."""

from unittest.mock import patch

from django.db import transaction
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from boards.broadcast import BOARD_CHANNEL_EVENTS, EVT_WEBHOOK_CHANGED
from boards.permissions import ADMIN_ONLY_EVENTS, admin_only_event_visible
from webhooks import live
from webhooks.models import SUBSCRIBABLE_EVENT_TYPES, WebhookSubscription

from .base import ENABLED, HOOK_URL, admin_and_board, make_subscription, resolving
from .test_dispatch import DispatcherBase, Recorder

KEYS = {"id", "status", "reason_code", "consecutive_failures", "changed_by", "at"}
LEAKS = ("hooks.example.com", "s3cr3tpath", "token=abc", "whsec_")


def _url(board_id, suffix=""):
    return f"/api/v1/boards/{board_id}/webhooks/{suffix}"


class Frames:
    """Patches the deferred publish and records each frame."""

    def __init__(self):
        self.frames = []

    def __call__(self, board_id, event_type, payload, **kwargs):
        self.frames.append((board_id, event_type, payload, kwargs))


class RegistryTests(TestCase):
    def test_admin_only_and_never_subscribable(self):
        self.assertIn(EVT_WEBHOOK_CHANGED, BOARD_CHANNEL_EVENTS)
        self.assertIn(EVT_WEBHOOK_CHANGED, ADMIN_ONLY_EVENTS)
        self.assertNotIn(EVT_WEBHOOK_CHANGED, SUBSCRIBABLE_EVENT_TYPES)
        for role in ("viewer", "member", "moderator", None):
            self.assertFalse(admin_only_event_visible(role))
        self.assertTrue(admin_only_event_visible("admin"))


@ENABLED
class ApiPublishesTests(TestCase):
    def setUp(self):
        self.admin, self.board = admin_and_board()
        self.sub = make_subscription(self.board, self.admin)
        self.client = APIClient()
        self.client.force_login(self.admin)
        self.frames = Frames()

    def call(self, method, suffix, body=None):
        with patch("boards.broadcast.broadcast_board_event", self.frames), self.captureOnCommitCallbacks(execute=True):
            with resolving():
                return getattr(self.client, method)(_url(self.board.pk, suffix), body, format="json")

    def assert_one_frame(self, *, status, changed_by=None, sub_id=None, reason=""):
        self.assertEqual(len(self.frames.frames), 1, self.frames.frames)
        board_id, event, payload, kwargs = self.frames.frames[0]
        self.assertEqual((board_id, event), (self.board.pk, EVT_WEBHOOK_CHANGED))
        self.assertEqual(set(payload), KEYS)
        self.assertEqual(payload["id"], sub_id or self.sub.pk)
        self.assertEqual(payload["status"], status)
        self.assertEqual(payload["reason_code"], reason)
        self.assertEqual(payload["changed_by"], changed_by or self.admin.pk)
        # Broadcast only: no feed row id.
        self.assertNotIn("event_id", kwargs)
        flat = repr(payload)
        for leak in LEAKS:
            self.assertNotIn(leak, flat)

    def test_create(self):
        r = self.call("post", "", {"url": HOOK_URL})
        self.assertEqual(r.status_code, 201)
        self.assert_one_frame(status="active", sub_id=r.data["id"])

    def test_rename(self):
        self.assertEqual(self.call("patch", f"{self.sub.pk}/", {"name": "n"}).status_code, 200)
        self.assert_one_frame(status="active")

    def test_disable_then_reenable(self):
        self.assertEqual(self.call("post", f"{self.sub.pk}/disable/").status_code, 200)
        self.assert_one_frame(status="disabled", reason="manual")
        self.frames.frames.clear()
        self.assertEqual(self.call("post", f"{self.sub.pk}/reenable/", {}).status_code, 200)
        self.assert_one_frame(status="active")

    def test_rotate(self):
        self.assertEqual(self.call("post", f"{self.sub.pk}/rotate/", {"overlap_seconds": 60}).status_code, 200)
        self.assert_one_frame(status="active")

    def test_end_overlap_publishes_only_when_it_changed_something(self):
        self.assertEqual(self.call("post", f"{self.sub.pk}/end-overlap/").status_code, 200)
        self.assertEqual(self.frames.frames, [])
        self.call("post", f"{self.sub.pk}/rotate/", {"overlap_seconds": 60})
        self.frames.frames.clear()
        self.assertEqual(self.call("post", f"{self.sub.pk}/end-overlap/").status_code, 200)
        self.assert_one_frame(status="active")

    def test_delete(self):
        sub_id = self.sub.pk
        self.assertEqual(self.call("delete", f"{sub_id}/").status_code, 204)
        self.assert_one_frame(status="deleted", sub_id=sub_id)

    def test_test_send_and_reads_publish_nothing(self):
        with patch("visiban.egress.guarded_post", Recorder()):
            self.call("post", f"{self.sub.pk}/test/")
        self.call("get", "")
        self.call("get", f"{self.sub.pk}/")
        self.assertEqual(self.frames.frames, [])

    def test_a_refused_write_publishes_nothing(self):
        r = self.call("patch", f"{self.sub.pk}/", {"event_types": ["not.a.type"]})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.frames.frames, [])


@ENABLED
class DeferralTests(TestCase):
    def test_rolled_back_write_never_publishes(self):
        admin, board = admin_and_board()
        sub = make_subscription(board, admin)
        frames = Frames()
        with patch("boards.broadcast.broadcast_board_event", frames), self.captureOnCommitCallbacks(execute=True):
            try:
                with transaction.atomic():
                    live.publish_changed(sub.pk, board.pk, changed_by_id=admin.pk)
                    raise RuntimeError("roll back")
            except RuntimeError:
                pass
        self.assertEqual(frames.frames, [])

    def test_a_missing_row_reads_as_deleted(self):
        payload = live.changed_payload(None, 99)
        self.assertEqual(payload["status"], "deleted")


class DispatcherPublishesTests(DispatcherBase):
    def run_frames(self, *outcomes):
        frames = Frames()
        with patch("boards.broadcast.broadcast_board_event", frames):
            self.run_with(*outcomes)
        return [f[2] for f in frames.frames]

    def test_failing_once_then_recovered_once(self):
        self.event()
        self.event()
        self.assertEqual([p["status"] for p in self.run_frames(500)], ["failing"])
        WebhookSubscription.objects.filter(pk=self.sub.pk).update(next_attempt_at=None)
        # A second failure in a row is not announced again.
        self.assertEqual(self.run_frames(500), [])
        WebhookSubscription.objects.filter(pk=self.sub.pk).update(next_attempt_at=None)
        frames = self.run_frames()
        self.assertEqual([(p["status"], p["consecutive_failures"], p["changed_by"]) for p in frames], [("active", 0, None)])
        # Healthy runs stay quiet.
        self.event()
        self.assertEqual(self.run_frames(), [])

    @override_settings(WEBHOOK_DISABLE_AFTER_FAILURES=1)
    def test_automatic_disable_is_announced_with_its_reason(self):
        self.event()
        frames = self.run_frames(500)
        self.assertEqual([(p["status"], p["reason_code"]) for p in frames], [("disabled", "failures")])

    def test_lost_standing_is_announced(self):
        from boards.models import BoardMembership
        from boards.tests.conftest import _make_user

        other = _make_user()
        BoardMembership.objects.create(board=self.board, user=other, role="member")
        WebhookSubscription.objects.filter(pk=self.sub.pk).update(configured_by=other)
        self.event()
        frames = self.run_frames()
        self.assertEqual([(p["status"], p["reason_code"]) for p in frames], [("disabled", "creator_lost_access")])
