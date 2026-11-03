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

from django.core.cache import cache
from django.db import connection, connections
from django.test import TransactionTestCase, override_settings
from rest_framework.test import APIClient

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


@ENABLED
class ConcurrentRotationTests(TransactionTestCase):
    """Rotate is read-modify-write: the current secret becomes the previous one (#2054)."""

    @skipUnless(connection.vendor == "postgresql", "select_for_update is a no-op on SQLite")
    @override_settings(NOTIFICATION_EMAIL_ASYNC=False)
    def test_concurrent_rotations_leave_a_consistent_row(self):
        cache.clear()
        admin, board = admin_and_board()
        sub = make_subscription(board, admin, secret="whsec_start")
        start = threading.Barrier(2)
        lock = threading.Lock()
        answers = []
        errors = []

        def worker():
            try:
                client = APIClient()
                client.force_login(admin)
                start.wait(5)
                r = client.post(
                    f"/api/v1/boards/{board.pk}/webhooks/{sub.pk}/rotate/", {"overlap_seconds": 3600}, format="json"
                )
                with lock:
                    answers.append((r.status_code, r.data.get("secret")))
            except Exception as exc:  # surfaced below
                errors.append(exc)
            finally:
                connections.close_all()

        threads = [threading.Thread(target=worker) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(30)

        self.assertEqual(errors, [])
        self.assertEqual([a[0] for a in answers], [200, 200])
        secrets = {a[1] for a in answers}
        self.assertEqual(len(secrets), 2)
        sub.refresh_from_db()
        # Serialized: one rotation ran after the other, so the survivor's previous
        # secret is the other caller's new one, never the secret both started from.
        self.assertEqual({sub.get_secret(), sub.get_previous_secret()}, secrets)
