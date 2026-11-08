"""A feed cursor never steps past a lower id that commits late (#2053).

PostgreSQL draws ``board_events.id`` at INSERT, not at COMMIT. Transaction A can
draw a lower id than transaction B and commit after it. A reader that polled in
between saw B without A, moved its cursor to B, and never read A.

The threaded tests reproduce that exact interleaving with real connections:
thread A writes an event and holds its transaction open, the main thread writes
and commits a second event on the same board, a consumer polls, then A commits
and the consumer polls again from its cursor. Every thread calls
``connections.close_all()`` before it exits (backend CLAUDE.md). They are
PostgreSQL only: SQLite holds one database-wide write lock from a transaction's
first write to its commit, so the out-of-order commit cannot happen there.
"""

import threading
from unittest import skipUnless
from unittest.mock import patch

from django.db import connection, connections, transaction
from django.test import TestCase, TransactionTestCase
from rest_framework.test import APIClient

from boards.broadcast import persist_board_event
from boards.models import BoardEvent
from boards.services.feed import (
    FEED_LOCK_NAMESPACE,
    PruneMarks,
    feed_horizon,
    feed_lock_key,
    newest_event_id,
    reader_resume_cursor,
)
from boards.tests.conftest import _make_board, _make_user
from boards.tests.lock_wait import assert_blocked_on_lock

POSTGRES_ONLY = skipUnless(
    connection.vendor == "postgresql",
    "ids are drawn at INSERT and committed out of order only on PostgreSQL",
)

# Bounds every wait, so a regression fails the test instead of hanging it.
WAIT = 10


class _InFlightWriter(threading.Thread):
    """Writes one event on *board_id* and holds its transaction open until released."""

    def __init__(self, board_id, event="card.created"):
        super().__init__(name=f"in-flight-writer-{board_id}")
        self.board_id = board_id
        self.event = event
        self.inserted = threading.Event()
        self.release = threading.Event()
        self.event_id = None
        self.error = None

    def run(self):
        try:
            with transaction.atomic():
                self.event_id = persist_board_event(self.board_id, self.event, {"n": "a"})
                self.inserted.set()
                self.release.wait(WAIT)
        except Exception as exc:  # surfaced by the test
            self.error = exc
        finally:
            self.inserted.set()
            connections.close_all()

    def finish(self, testcase):
        self.release.set()
        self.join(WAIT)
        testcase.assertFalse(self.is_alive(), "the in-flight writer never committed")
        testcase.assertIsNone(self.error)


def _held_feed_locks():
    """Feed advisory locks this session holds, in any mode."""
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND classid = %s"
            " AND pid = pg_backend_pid()",
            [FEED_LOCK_NAMESPACE],
        )
        return cursor.fetchone()[0]


def _set_lock_timeout(testcase, seconds):
    """Make a lock wait in this session fail after *seconds* instead of hanging, for one test."""
    with connection.cursor() as cursor:
        cursor.execute(f"SET lock_timeout = '{int(seconds)}s'")

    def reset():
        with connection.cursor() as cursor:
            cursor.execute("RESET lock_timeout")

    testcase.addCleanup(reset)


@POSTGRES_ONLY
class OutOfOrderCommitTests(TransactionTestCase):
    """The acceptance scenario of #2053, against the REST feed."""

    def setUp(self):
        patcher = patch("boards.broadcast.broadcast_board_event")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.owner = _make_user("horizon_owner")
        self.board = _make_board(self.owner, name="Horizon board")
        self.client = APIClient()
        self.client.force_authenticate(user=self.owner)
        self.url = f"/api/v1/boards/{self.board.id}/events/"

    def _poll(self, after):
        resp = self.client.get(f"{self.url}?after={after}")
        self.assertEqual(resp.status_code, 200, resp.content)
        return resp.json()

    def test_poller_between_out_of_order_commits_does_not_lose_the_lower_id(self):
        writer_a = _InFlightWriter(self.board.id)
        writer_a.start()
        self.addCleanup(writer_a.release.set)
        self.assertTrue(writer_a.inserted.wait(WAIT))
        self.assertIsNone(writer_a.error)

        # B writes and commits on the same board while A is still open. It must
        # not wait for A: writers share the feed lock (a hang here would fail
        # on the lock timeout rather than block the suite).
        _set_lock_timeout(self, 5)
        id_b = persist_board_event(self.board.id, "card.updated", {"n": "b"})
        self.assertLess(writer_a.event_id, id_b, "A drew the lower id, B committed first")

        # A consumer polls in the window (B is visible, A is not yet) and moves
        # its cursor the way every client does: to the last id it was handed.
        cursor = 0
        seen = []
        first = self._poll(cursor)
        seen += [r["id"] for r in first["results"]]
        if first["results"]:
            cursor = first["results"][-1]["id"]

        writer_a.finish(self)

        second = self._poll(cursor)
        seen += [r["id"] for r in second["results"]]
        self.assertEqual(seen, [writer_a.event_id, id_b], "the consumer lost the lower id, or saw one twice")
        # How: the first page stopped below A rather than handing out B, so
        # the cursor never passed A. It looks caught up and the consumer polls again.
        self.assertEqual(first["results"], [])
        self.assertIsNone(first["next_cursor"])

    def test_a_write_on_another_board_does_not_hold_this_feed_back(self):
        other = _make_board(self.owner, name="Other board")
        writer = _InFlightWriter(other.id)
        writer.start()
        self.addCleanup(writer.release.set)
        self.assertTrue(writer.inserted.wait(WAIT))
        try:
            own = persist_board_event(self.board.id, "card.updated", {})
            self.assertEqual([r["id"] for r in self._poll(0)["results"]], [own])
        finally:
            writer.finish(self)

    def test_event_id_is_drawn_after_the_writer_lock(self):
        """The id is drawn after the lock is granted, never before (the order the fix relies on).

        The main thread holds the board's feed lock exclusively, so a writer
        has to wait for it. While that writer waits, another board's event
        draws an id. If the waiting writer had drawn its id before asking for
        the lock, its id would be the lower of the two.
        """
        other = _make_board(self.owner, name="Other board")
        result = {}

        def write():
            try:
                result["id"] = persist_board_event(self.board.id, "card.created", {})
            except Exception as exc:  # surfaced below
                result["error"] = exc
            finally:
                connections.close_all()

        writer = threading.Thread(target=write, name="lock-waiting-writer")
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute("SELECT pg_advisory_xact_lock(%s, %s)", feed_lock_key(self.board.id))
            writer.start()
            assert_blocked_on_lock(self, writer, "the writer did not wait for the feed lock")
            drawn_while_waiting = persist_board_event(other.id, "card.created", {})
        writer.join(WAIT)
        self.assertFalse(writer.is_alive())
        self.assertNotIn("error", result)
        self.assertGreater(result["id"], drawn_while_waiting)

    def test_horizon_is_none_while_a_writer_is_in_flight(self):
        committed = persist_board_event(self.board.id, "card.created", {})
        writer = _InFlightWriter(self.board.id)
        writer.start()
        self.addCleanup(writer.release.set)
        self.assertTrue(writer.inserted.wait(WAIT))
        try:
            self.assertIsNone(feed_horizon(self.board.id))
        finally:
            writer.finish(self)
        self.assertEqual(feed_horizon(self.board.id), writer.event_id)
        self.assertGreater(writer.event_id, committed)

    def test_probe_releases_its_lock_outside_a_transaction(self):
        persist_board_event(self.board.id, "card.created", {})
        self.assertFalse(connection.in_atomic_block)
        feed_horizon(self.board.id)
        self.assertEqual(_held_feed_locks(), 0)

    def test_probe_releases_its_lock_inside_a_transaction(self):
        """Inside a caller's transaction the probe must not hold the lock until that transaction ends.

        If it did, every writer on the board would wait for the caller.
        """
        with transaction.atomic():
            feed_horizon(self.board.id)
            self.assertEqual(_held_feed_locks(), 0)
            # The caller's transaction is still usable after the probe's savepoint.
            self.assertEqual(BoardEvent.objects.filter(board_id=self.board.id).count(), 0)


@POSTGRES_ONLY
class WebhookOutOfOrderCommitTests(TransactionTestCase):
    """The same scenario against the webhook dispatcher, with its settle window at 0."""

    def test_dispatcher_between_out_of_order_commits_does_not_lose_the_lower_id(self):
        from webhooks import dispatch
        from webhooks.models import WebhookSubscription
        from webhooks.tests.base import ENABLED, admin_and_board, make_subscription, resolving

        with ENABLED, resolving(), patch("boards.broadcast.broadcast_board_event"):
            admin, board = admin_and_board("Horizon hooks")
            sub = make_subscription(board, admin)
            delivered = []

            def fake_post(url, body, headers, **kwargs):
                delivered.append(int(headers["X-Visiban-Event-Id"]))
                return 200

            writer_a = _InFlightWriter(board.pk)
            writer_a.start()
            self.addCleanup(writer_a.release.set)
            self.assertTrue(writer_a.inserted.wait(WAIT))
            _set_lock_timeout(self, 5)
            id_b = persist_board_event(board.pk, "card.updated", {"n": "b"})
            self.assertLess(writer_a.event_id, id_b)

            with patch("visiban.egress.guarded_post", fake_post):
                dispatch.run_once()
                self.assertEqual(delivered, [], "delivered an id above a lower uncommitted one")
                sub.refresh_from_db()
                self.assertEqual(sub.cursor, 0)

                writer_a.finish(self)
                WebhookSubscription.objects.filter(pk=sub.pk).update(next_attempt_at=None)
                dispatch.run_once()

            self.assertEqual(delivered, [writer_a.event_id, id_b])
            sub.refresh_from_db()
            self.assertEqual(sub.cursor, id_b)


class HorizonWithoutContentionTests(TestCase):
    """With no write in flight, the horizon is the newest id, on every backend."""

    def setUp(self):
        self.owner = _make_user("horizon_quiet")
        self.board = _make_board(self.owner, name="Quiet board")

    def test_empty_board(self):
        self.assertEqual(feed_horizon(self.board.id), 0)

    def test_newest_id(self):
        persist_board_event(self.board.id, "card.created", {})
        newest = persist_board_event(self.board.id, "card.updated", {})
        self.assertEqual(feed_horizon(self.board.id), newest)
        self.assertEqual(feed_horizon(self.board.id), newest_event_id(self.board.id))

    def test_lock_key_fits_two_int4s(self):
        for board_id in (1, 2**31 - 1, 2**31, 2**32 + 5, 2**63 - 1):
            namespace, objid = feed_lock_key(board_id)
            self.assertEqual(namespace, FEED_LOCK_NAMESPACE)
            self.assertTrue(-(2**31) <= objid < 2**31, board_id)
        self.assertNotEqual(feed_lock_key(1), feed_lock_key(2))

    def test_resume_cursor_is_bounded_by_the_ceiling(self):
        first = persist_board_event(self.board.id, "card.created", {})
        second = persist_board_event(self.board.id, "card.updated", {})
        marks = PruneMarks(None)
        args = (self.board.id, marks)
        kwargs = {"role": "owner", "reader_id": self.owner.id}
        self.assertEqual(reader_resume_cursor(*args, **kwargs), second)
        self.assertEqual(reader_resume_cursor(*args, ceiling=first, **kwargs), first)
        # A visible prune mark above the ceiling still counts: it names no row.
        self.assertEqual(reader_resume_cursor(self.board.id, PruneMarks(second + 5), ceiling=first, **kwargs), second + 5)
