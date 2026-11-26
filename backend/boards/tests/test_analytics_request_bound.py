"""Analytics requests have a wall-clock bound, and a request that ends early frees its slot.

``analytics_slot`` gives each admitted request a deadline
(``ANALYTICS_MAX_SECONDS``): the queries it starts check it first and, on
PostgreSQL, run under a ``statement_timeout`` of the time left; the row
loops check it every ``DEADLINE_CHECK_ROWS`` rows. Past it the request is
refused with a 503 ``analytics_timeout`` and the slot is given back. A
long-window ``/analytics/`` request whose in-range movements alone exceed
the size limit is refused ``analytics_too_large`` before its load.

Most tests put the deadline at admission (``time_budget`` patched to 0), so
they need no real clock and run on SQLite; the ``statement_timeout`` tests
need PostgreSQL and skip elsewhere.
"""

import logging
import threading
import time
from types import SimpleNamespace
from unittest import mock, skipUnless

from django.db import connection, transaction
from django.db import connections as _conns
from django.test import SimpleTestCase, TransactionTestCase, override_settings
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, CardMovement, Column, Swimlane
from boards.services import analytics_admission as admission
from boards.services import flow_metrics
from boards.services.analytics_admission import AnalyticsTimedOut, AnalyticsTooLarge, Ticket, analytics_slot
from boards.tests.test_flow_metrics import FlowFixture
from visiban.analytics_limits import DEFAULT_ANALYTICS_MAX_SECONDS


# Every analytics action that replays history, by a URL that reaches it (the
# admission tests pin that this set matches BoardAnalyticsMixin).
COVERED = {
    "summary": "summary/",
    "analytics": "analytics/",
    "metrics_cycle_time": "metrics/cycle-time/",
    "metrics_swimlanes": "metrics/swimlanes/",
    "metrics_throughput": "metrics/throughput/",
    "metrics_cumulative_flow": "metrics/cumulative-flow/",
    "metrics_wip_age": "metrics/wip-age/",
    "metrics_dwell": "metrics/dwell/",
    "metrics_blocked": "metrics/blocked/",
    "metrics_attention": "metrics/attention/",
    "metrics_overview": "metrics/overview/",
}


def _user(pk):
    return SimpleNamespace(pk=pk, is_authenticated=True)


def _idle(test):
    test.assertEqual(admission.occupancy(), (0, 0, {}))


def _no_time_left():
    return mock.patch.object(admission, "time_budget", return_value=0)


@override_settings(ANALYTICS_MAX_CONCURRENT=1)
class DeadlineTests(SimpleTestCase):
    """The deadline itself, no database."""

    def tearDown(self):
        _idle(self)

    def test_default_and_setting(self):
        self.assertEqual(DEFAULT_ANALYTICS_MAX_SECONDS, 60)
        with override_settings(ANALYTICS_MAX_SECONDS=7):
            self.assertEqual(admission.time_budget(), 7)

    def test_row_loop_stops_at_the_deadline_and_frees_the_slot(self):
        with _no_time_left(), self.assertLogs("boards.services.analytics_admission", logging.INFO) as logs:
            with self.assertRaises(AnalyticsTimedOut):
                with analytics_slot(_user(1), board_id=1, endpoint="test") as ticket:
                    # The clock is read once per DEADLINE_CHECK_ROWS rows, not per row.
                    ticket.count_rows(admission.DEADLINE_CHECK_ROWS - 1, held=True)
                    ticket.count_rows(1, held=False)
                    self.fail("rows read past the deadline")
        self.assertIn("outcome=timeout", logs.output[-1])
        _idle(self)
        # The freed slot admits the next request at ANALYTICS_MAX_CONCURRENT=1.
        with analytics_slot(_user(2), board_id=1, endpoint="test", wait=False):
            self.assertEqual(admission.occupancy()[0], 1)

    def test_rows_before_the_deadline_pass(self):
        with analytics_slot(_user(1), board_id=1, endpoint="test") as ticket:
            ticket.count_rows(admission.DEADLINE_CHECK_ROWS * 3, held=False)
            self.assertGreater(ticket.remaining(), 0)

    def test_refusal_is_constant_and_has_no_retry_after(self):
        body = AnalyticsTimedOut().body()
        self.assertEqual(body["code"], "analytics_timeout")
        self.assertEqual(AnalyticsTimedOut.status_code, 503)
        self.assertFalse(hasattr(AnalyticsTimedOut, "wait") and AnalyticsTimedOut.wait)
        self.assertEqual(AnalyticsTimedOut().body(), body)

    def test_absent_ticket_still_gets_a_deadline(self):
        # Absent input never means unbounded (#1075): a load outside any slot
        # counts on a fresh ticket that has the settings deadline.
        self.assertIsNone(admission.active_ticket())
        with override_settings(ANALYTICS_MAX_SECONDS=30):
            counter = admission.row_counter()
        self.assertAlmostEqual(counter.remaining(), 30, delta=5)
        with _no_time_left():
            counter = admission.row_counter()
        with self.assertRaises(AnalyticsTimedOut):
            counter.count_rows(admission.DEADLINE_CHECK_ROWS, held=True)

    def test_a_ticket_cannot_be_built_without_a_deadline(self):
        with self.assertRaises(TypeError):
            Ticket(10)


@override_settings(ANALYTICS_MAX_CONCURRENT=1)
class BoundViewTests(FlowFixture):
    def setUp(self):
        super().setUp()
        self.path(self.backlog, 20, self.doing, 10, self.done, 5)
        self.path(self.backlog, 15, self.doing, 3)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def tearDown(self):
        _idle(self)

    def url(self, suffix):
        return f"/api/v1/boards/{self.board.pk}/{suffix}"

    def test_a_query_started_past_the_deadline_is_refused_and_frees_the_slot(self):
        with _no_time_left(), self.assertRaises(AnalyticsTimedOut):
            with analytics_slot(self.user, board_id=self.board.pk, endpoint="test"):
                Board.objects.count()
        _idle(self)
        # The wrapper is gone with the slot: queries outside it are untouched.
        with _no_time_left():
            self.assertGreaterEqual(Board.objects.count(), 1)

    def test_every_covered_endpoint_refuses_past_the_bound_then_answers(self):
        with _no_time_left():
            for name, suffix in COVERED.items():
                with self.subTest(action=name):
                    response = self.client.get(self.url(suffix))
                    self.assertEqual(response.status_code, 503)
                    self.assertEqual(response.json(), AnalyticsTimedOut().body())
                    self.assertNotIn("Retry-After", response)
                    _idle(self)
        # Each refusal gave its slot back: the next request is admitted.
        self.assertEqual(self.client.get(self.url("analytics/")).status_code, 200)

    def test_an_abandoned_row_stream_frees_its_slot(self):
        # A consumer that stops reading a streamed load part-way (the generator
        # is closed, or dropped when the request fails) still ends the slot.
        selected = Card.objects.filter(board=self.board)
        with analytics_slot(self.user, board_id=self.board.pk, endpoint="test") as ticket:
            rows = flow_metrics._movement_rows(selected, held=False)
            next(rows)
            rows.close()
            self.assertEqual(ticket.streamed, 1)
        _idle(self)
        with self.assertRaises(RuntimeError):
            with analytics_slot(self.user, board_id=self.board.pk, endpoint="test"):
                rows = flow_metrics._movement_rows(selected, held=True)
                next(rows)
                raise RuntimeError("consumer gave up")
        _idle(self)
        self.assertEqual(self.client.get(self.url("analytics/?days=30")).status_code, 200)


@override_settings(ANALYTICS_MAX_CONCURRENT=1)
class LongWindowSizeTests(FlowFixture):
    """``/analytics/?days=365`` over the movement limit is refused before its load."""

    def setUp(self):
        super().setUp()
        for _ in range(3):
            self.path(self.backlog, 200, self.doing, 150, self.done, 100)
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.in_range = CardMovement.objects.filter(board=self.board, card__isnull=False).count()

    def tearDown(self):
        _idle(self)

    def url(self, query):
        return f"/api/v1/boards/{self.board.pk}/analytics/?{query}"

    def _held(self, query):
        with self.assertLogs("boards.services.analytics_admission", logging.INFO) as logs:
            with mock.patch("django.utils.timezone.now", return_value=self.now):
                response = self.client.get(self.url(query))
        self.assertEqual(response.status_code, 200)
        return int(logs.output[-1].split("movements=")[1].split()[0])

    def test_over_the_limit_is_refused_before_the_load(self):
        with override_settings(ANALYTICS_MAX_MOVEMENTS=self.in_range - 1), \
                mock.patch("django.utils.timezone.now", return_value=self.now), \
                mock.patch.object(flow_metrics, "load_recent_dwell") as load:
            response = self.client.get(self.url("days=365"))
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json(), AnalyticsTooLarge().body())
        load.assert_not_called()

    def test_the_precheck_never_refuses_what_the_load_accepts(self):
        # The count is a lower bound: at a budget of exactly the rows the load
        # holds, the request is still answered.
        held = self._held("days=365")
        self.assertGreaterEqual(held, self.in_range)
        with override_settings(ANALYTICS_MAX_MOVEMENTS=held):
            self._held("days=365")

    def test_a_filtered_request_skips_the_precheck_and_keeps_the_streamed_limit(self):
        # An empty swimlane: the unfiltered in-range count is over the budget,
        # but it is no lower bound for the filtered load, which is answered.
        with override_settings(ANALYTICS_MAX_MOVEMENTS=1), \
                mock.patch("django.utils.timezone.now", return_value=self.now), \
                mock.patch.object(flow_metrics, "load_recent_dwell", wraps=flow_metrics.load_recent_dwell) as load:
            response = self.client.get(self.url(f"days=365&swimlane_id={self.other_lane.pk}"))
        self.assertEqual(response.status_code, 200)
        load.assert_called_once()
        # The lane with the history is still refused, by the streamed count.
        with override_settings(ANALYTICS_MAX_MOVEMENTS=1), \
                mock.patch("django.utils.timezone.now", return_value=self.now):
            response = self.client.get(self.url(f"days=365&swimlane_id={self.lane.pk}"))
        self.assertEqual(response.status_code, 422)

    def test_an_exhausted_ticket_is_refused_without_a_negative_slice(self):
        flow_range = flow_metrics.rolling_range(365, now=self.now, zone=flow_metrics.zone_of(self.board))
        with override_settings(ANALYTICS_MAX_MOVEMENTS=1):
            with analytics_slot(self.user, board_id=self.board.pk, endpoint="test") as ticket:
                ticket.movements = 5
                with self.assertRaises(AnalyticsTooLarge):
                    flow_metrics.refuse_if_range_exceeds_budget(self.board, flow_range)

    def test_the_default_window_runs_no_precheck(self):
        with mock.patch.object(flow_metrics, "refuse_if_range_exceeds_budget") as precheck:
            self.assertEqual(self.client.get(self.url("days=90")).status_code, 200)
            precheck.assert_not_called()
            self.assertEqual(self.client.get(self.url("days=91")).status_code, 200)
            precheck.assert_called_once()


_PG = skipUnless(connection.vendor == "postgresql", "statement_timeout is PostgreSQL only")


def _statement_timeout():
    with connection.cursor() as cursor:
        cursor.execute("SHOW statement_timeout")
        return cursor.fetchone()[0]


def _sleep(seconds):
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_sleep(%s)", [seconds])


@_PG
@override_settings(ANALYTICS_MAX_CONCURRENT=1, ANALYTICS_MAX_SECONDS=1)
class StatementTimeoutTests(TransactionTestCase):
    """The database stops a statement that would outlast the request."""

    def tearDown(self):
        _idle(self)

    def test_a_long_statement_is_cancelled_at_the_bound_and_the_setting_reset(self):
        before = _statement_timeout()
        started = time.monotonic()
        with self.assertRaises(AnalyticsTimedOut):
            with analytics_slot(_user(1), board_id=1, endpoint="test"):
                _sleep(10)
        self.assertLess(time.monotonic() - started, 5)
        _idle(self)
        self.assertEqual(_statement_timeout(), before)

    def test_inside_a_transaction_the_rollback_restores_the_setting(self):
        before = _statement_timeout()
        with self.assertRaises(AnalyticsTimedOut):
            with transaction.atomic():
                with analytics_slot(_user(1), board_id=1, endpoint="test"):
                    _sleep(10)
        _idle(self)
        self.assertEqual(_statement_timeout(), before)

    @override_settings(ANALYTICS_MAX_SECONDS=60)
    def test_a_tighter_operator_timeout_is_never_loosened(self):
        with connection.cursor() as cursor:
            cursor.execute("SET statement_timeout = '300ms'")
        try:
            started = time.monotonic()
            with self.assertRaises(AnalyticsTimedOut):
                with analytics_slot(_user(1), board_id=1, endpoint="test"):
                    _sleep(5)
            self.assertLess(time.monotonic() - started, 3)
            self.assertEqual(_statement_timeout(), "300ms")
        finally:
            with connection.cursor() as cursor:
                cursor.execute("RESET statement_timeout")

    @override_settings(ANALYTICS_MAX_SECONDS=60)
    def test_quick_queries_share_one_setting_and_the_restore_still_runs(self):
        before = _statement_timeout()
        with mock.patch.object(
            admission._DeadlineWrapper, "_set", side_effect=admission._DeadlineWrapper._set,
        ) as setter:
            with analytics_slot(_user(1), board_id=1, endpoint="test"):
                for _ in range(5):
                    Board.objects.count()
        # One setting for the five queries, one restore at the end.
        self.assertEqual(setter.call_count, 2)
        self.assertEqual(_statement_timeout(), before)

    @override_settings(ANALYTICS_MAX_SECONDS=60)
    def test_a_reconnect_inside_the_slot_restores_both_connections(self):
        before = _statement_timeout()
        with analytics_slot(_user(1), board_id=1, endpoint="test"):
            Board.objects.count()
            self.assertNotEqual(_statement_timeout(), before)
            connection.close()
            Board.objects.count()
            self.assertNotEqual(_statement_timeout(), before)
        self.assertEqual(_statement_timeout(), before)

    @override_settings(ANALYTICS_MAX_SECONDS=60)
    def test_a_failed_restore_closes_the_connection(self):
        import psycopg

        before = _statement_timeout()
        real = admission._DeadlineWrapper._set
        calls = []

        def flaky(raw, ms):
            calls.append(ms)
            if len(calls) > 1:
                raise psycopg.OperationalError("restore failed")
            real(raw, ms)

        with mock.patch.object(admission._DeadlineWrapper, "_set", side_effect=flaky), \
                self.assertLogs("boards.services.analytics_admission", logging.WARNING):
            with analytics_slot(_user(1), board_id=1, endpoint="test"):
                Board.objects.count()
        self.assertIsNone(connection.connection)
        # The next query opens a fresh connection with the session default.
        self.assertEqual(_statement_timeout(), before)

    def test_a_request_held_by_a_long_statement_frees_its_slot_for_a_waiter(self):
        # The first request's query would run 10 s; the bound cancels it at
        # 1 s, its slot is given back, and a request waiting for the one slot
        # (ANALYTICS_MAX_CONCURRENT=1) is admitted well inside its 8 s wait.
        entered = threading.Event()
        outcome = {}

        def first():
            try:
                with analytics_slot(_user(1), board_id=1, endpoint="test"):
                    entered.set()
                    _sleep(10)
            except Exception as exc:  # noqa: BLE001 - asserted below
                outcome["error"] = exc
            finally:
                entered.set()
                _conns.close_all()

        thread = threading.Thread(target=first)
        thread.start()
        entered.wait()
        try:
            started = time.monotonic()
            with analytics_slot(_user(2), board_id=1, endpoint="test", wait=True):
                waited = time.monotonic() - started
        finally:
            thread.join()
        self.assertIsInstance(outcome.get("error"), AnalyticsTimedOut)
        self.assertLess(waited, admission.REST_WAIT_SECONDS)


@_PG
@override_settings(ANALYTICS_MAX_CONCURRENT=1, ANALYTICS_MAX_SECONDS=1)
class StatementTimeoutViewTests(TransactionTestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="bound_view", password="pw")
        self.board = Board.objects.create(name="Bound", owner=self.user)
        BoardMembership.objects.create(board=self.board, user=self.user, role="admin")
        Column.objects.create(board=self.board, name="Todo", position=0)
        Swimlane.objects.create(board=self.board, name="Lane", position=0)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def tearDown(self):
        _idle(self)

    def test_a_slow_request_is_refused_and_the_next_one_answered(self):
        real = flow_metrics.load_range_flow

        def slow(*args, **kwargs):
            _sleep(10)
            return real(*args, **kwargs)

        url = f"/api/v1/boards/{self.board.pk}/metrics/cycle-time/"
        with mock.patch.object(flow_metrics, "load_range_flow", side_effect=slow):
            response = self.client.get(url)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), AnalyticsTimedOut().body())
        _idle(self)
        self.assertEqual(self.client.get(url).status_code, 200)
