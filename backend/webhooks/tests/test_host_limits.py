"""Per-destination-host rate and concurrency limits in the dispatcher (#2055)."""

import logging
from unittest.mock import patch

from django.core.cache import cache
from django.test import override_settings

from boards.tests.conftest import _make_board
from webhooks import dispatch, host_limits
from webhooks.models import WebhookSubscription

from .base import make_subscription
from .test_dispatch import DispatcherBase, Recorder

OTHER_URL = "https://other.example.net/hook"


class HostLimitBase(DispatcherBase):
    def setUp(self):
        super().setUp()
        cache.clear()
        # A second board's webhook to the same receiver: the fan-out the
        # per-subscription caps do not bound.
        self.board2 = _make_board(self.admin, name="Second board")
        self.sub2 = make_subscription(self.board2, self.admin)

    def event_on(self, board, n=1):
        from boards.models import BoardEvent

        return [BoardEvent.objects.create(board_id=board.pk, event="card.created", data={"id": i}) for i in range(n)]

    def run_all(self, rec=None):
        rec = rec or Recorder()
        with patch("visiban.egress.guarded_post", rec), self.captureOnCommitCallbacks(execute=True):
            result = dispatch.run_once()
        for s in (self.sub, self.sub2):
            s.refresh_from_db()
        return rec, result


@override_settings(WEBHOOK_HOST_MAX_PER_MINUTE=3, WEBHOOK_HOST_MAX_CONCURRENCY=0)
class RateLimitTests(HostLimitBase):
    def test_fan_out_to_one_host_stops_at_the_limit_without_a_failure(self):
        self.event_on(self.board, 2)
        self.event_on(self.board2, 2)
        rec, result = self.run_all()
        self.assertEqual(len(rec.calls), 3)
        self.assertEqual(result.delivered, 3)
        self.assertEqual(result.host_limited, 1)
        self.assertEqual(result.failed, 0)
        for s in (self.sub, self.sub2):
            self.assertEqual(s.consecutive_failures, 0)
            self.assertIsNone(s.next_attempt_at)
            self.assertEqual(s.last_error_code, "")
        # Four rows, three sent: the fourth waits before a cursor.
        self.assertEqual(sorted([self.sub.cursor > 0, self.sub2.cursor > 0]), [True, True])

    def test_same_window_sends_nothing_more_then_the_next_window_resumes_in_order(self):
        self.event_on(self.board, 4)
        with patch("webhooks.host_limits.time.time", return_value=6_000_000.0):
            rec, result = self.run_all()
            self.assertEqual(len(rec.calls), 3)
            rec2, result2 = self.run_all()
            self.assertEqual(rec2.calls, [])
            self.assertEqual(result2.host_limited, 1)
        with patch("webhooks.host_limits.time.time", return_value=6_000_060.0):
            rec3, _ = self.run_all()
        self.assertEqual(len(rec3.calls), 1)
        # Order held: the fourth row went out after the first three.
        self.assertGreater(rec3.calls[0]["row"]["id"], max(c["row"]["id"] for c in rec.calls))

    def test_hosts_are_counted_separately(self):
        WebhookSubscription.objects.filter(pk=self.sub2.pk).delete()
        other = self.sub2 = make_subscription(self.board2, self.admin, url=OTHER_URL)
        self.event_on(self.board, 3)
        self.event_on(self.board2, 3)
        rec, result = self.run_all()
        self.assertEqual(len(rec.calls), 6)
        self.assertEqual(result.host_limited, 0)
        other.refresh_from_db()
        self.assertGreater(other.cursor, 0)

    def test_host_names_compare_case_insensitively(self):
        self.assertEqual(host_limits.host_key("Hooks.Example.com"), host_limits.host_key("hooks.example.com"))
        self.assertNotIn("example", host_limits.host_key("hooks.example.com"))

    def test_the_run_log_counts_and_never_names_the_host(self):
        self.event_on(self.board, 5)
        with self.assertLogs("webhooks", level=logging.INFO) as logs:
            self.run_all()
        line = next(m for m in logs.output if "per-host limits" in m)
        self.assertIn("subscriptions=1 hosts=1", line)
        for m in logs.output:
            self.assertNotIn("hooks.example.com", m)

    def test_a_cache_outage_falls_back_to_a_per_process_counter(self):
        self.event_on(self.board, 5)
        with patch("webhooks.host_limits.cache.incr", side_effect=ConnectionError("down")):
            rec, result = self.run_all()
        self.assertEqual(len(rec.calls), 3)
        self.assertEqual(result.host_limited, 1)

    def test_test_sends_are_not_counted(self):
        for _ in range(4):
            with patch("visiban.egress.guarded_post", Recorder()):
                ok, *_ = dispatch.send_test(self.sub)
            self.assertTrue(ok)
        self.event_on(self.board, 3)
        rec, _ = self.run_all()
        self.assertEqual(len(rec.calls), 3)


@override_settings(WEBHOOK_HOST_MAX_PER_MINUTE=0, WEBHOOK_HOST_MAX_CONCURRENCY=1)
class ConcurrencyLimitTests(HostLimitBase):
    def test_a_host_with_every_slot_taken_waits_without_a_failure(self):
        key = host_limits.host_key("hooks.example.com")
        cache.add(f"webhook:host:slot:{key}:0", "another-dispatcher", timeout=60)
        self.event_on(self.board, 2)
        rec, result = self.run_all()
        self.assertEqual(rec.calls, [])
        self.assertEqual(result.host_limited, 1)
        self.assertEqual((self.sub.consecutive_failures, self.sub.cursor), (0, 0))
        cache.delete(f"webhook:host:slot:{key}:0")
        rec, _ = self.run_all()
        self.assertEqual(len(rec.calls), 2)

    def test_a_slot_is_released_after_each_request_even_a_failed_one(self):
        self.event_on(self.board, 3)
        rec, result = self.run_all(Recorder(200, 200, 500))
        self.assertEqual(len(rec.calls), 3)
        self.assertEqual(result.host_limited, 0)
        key = host_limits.host_key("hooks.example.com")
        self.assertIsNone(cache.get(f"webhook:host:slot:{key}:0"))

    def test_a_slot_expires_after_one_request_lifetime(self):
        self.assertEqual(host_limits._slot_ttl(), int(3.0 + 10.0) + host_limits._SLOT_MARGIN_SECONDS)

    def test_a_refused_slot_spends_none_of_the_minute(self):
        with override_settings(WEBHOOK_HOST_MAX_PER_MINUTE=2):
            limiter = host_limits.HostLimiter(clock=lambda: 120.0)
            held = limiter.acquire("hooks.example.com")
            self.assertIsNotNone(held)
            self.assertIsNone(limiter.acquire("hooks.example.com"))  # no slot, no count
            held.release()
            held.release()  # idempotent
            second = limiter.acquire("hooks.example.com")
            self.assertIsNotNone(second)  # the refused one spent nothing
            second.release()
            self.assertIsNone(limiter.acquire("hooks.example.com"))  # now the minute is spent

    def test_release_never_deletes_another_dispatchers_slot(self):
        limiter = host_limits.HostLimiter()
        slot = limiter.acquire("hooks.example.com")
        key = host_limits.host_key("hooks.example.com")
        cache.set(f"webhook:host:slot:{key}:0", "someone-else", timeout=60)
        slot.release()
        self.assertEqual(cache.get(f"webhook:host:slot:{key}:0"), "someone-else")

    def test_a_cache_outage_lets_the_sequential_dispatcher_through(self):
        self.event_on(self.board, 2)
        with patch("webhooks.host_limits.cache.add", side_effect=ConnectionError("down")):
            rec, _ = self.run_all()
        self.assertEqual(len(rec.calls), 2)
