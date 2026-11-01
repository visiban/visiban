"""Two dispatchers at once deliver each event exactly once (#863).

The lease is a conditional UPDATE, so of two overlapping runs (a slow loop and
a host cron, two Helm replicas) exactly one holds a given subscription and the
other skips it. Threads are real and each opens its own connection, closed
before it exits (backend CLAUDE.md, threaded tests).
"""

import threading
import time
from unittest import skipUnless
from unittest.mock import patch

from django.db import connection, connections
from django.test import TransactionTestCase

from boards.models import BoardEvent
from webhooks import dispatch
from webhooks.models import WebhookSubscription

from .base import ENABLED, admin_and_board, make_subscription


@ENABLED
class OverlappingDispatchersTests(TransactionTestCase):
    @skipUnless(
        connection.vendor == "postgresql",
        "SQLite's shared-cache test database serializes writers with a table lock, so the runs cannot overlap",
    )
    def test_two_threaded_dispatchers_deliver_each_event_once(self):
        admin, board = admin_and_board()
        subs = [make_subscription(board, admin) for _ in range(3)]
        ids = [BoardEvent.objects.create(board_id=board.pk, event="card.created", data={"n": i}).pk for i in range(4)]

        lock = threading.Lock()
        delivered = []

        def fake_post(url, body, headers, **kwargs):
            # Slow enough that the two runs overlap on every subscription.
            time.sleep(0.02)
            with lock:
                delivered.append((headers["X-Visiban-Subscription-Id"], headers["X-Visiban-Event-Id"]))
            return 200

        start = threading.Barrier(2)
        errors = []

        def worker():
            try:
                start.wait(5)
                dispatch.run_once()
            except Exception as exc:  # surfaced below
                errors.append(exc)
            finally:
                connections.close_all()

        with patch("visiban.egress.guarded_post", fake_post):
            threads = [threading.Thread(target=worker) for _ in range(2)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(30)

        self.assertEqual(errors, [])
        expected = sorted((str(s.pk), str(e)) for s in subs for e in ids)
        self.assertEqual(sorted(delivered), expected, "each (subscription, event) exactly once")
        for sub in WebhookSubscription.objects.all():
            self.assertEqual(sub.cursor, ids[-1])
            self.assertIsNone(sub.lease_token)

    def test_cursor_compare_and_set_refuses_a_stale_lease(self):
        admin, board = admin_and_board()
        sub = make_subscription(board, admin)
        WebhookSubscription.objects.filter(pk=sub.pk).update(lease_token="00000000-0000-0000-0000-000000000001")
        self.assertFalse(dispatch._advance(sub.pk, "00000000-0000-0000-0000-000000000002", 0, 5))
        self.assertTrue(dispatch._advance(sub.pk, "00000000-0000-0000-0000-000000000001", 0, 5))
        self.assertFalse(dispatch._advance(sub.pk, "00000000-0000-0000-0000-000000000001", 0, 6))
