"""Analytics admission: the concurrency limit and the size limit (#2428).

``analytics_slot`` admits every analytics request at the request boundary;
``flow_metrics._movement_rows`` counts the movement rows a request reads
against its ticket. These tests pin both limits, the refusal codes and
bodies, the order (authorize, validate, then admit) and that a slot is
always released.
"""

import inspect
import logging
import re
import threading
from types import SimpleNamespace
from unittest import mock

from django.contrib.auth.models import AnonymousUser
from django.core.exceptions import ImproperlyConfigured
from django.db import connection
from django.db import connections as _conns
from django.test import SimpleTestCase, TransactionTestCase, override_settings
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, CardBlock, CardMovement, Column, Swimlane
from boards.services import analytics_admission as admission
from boards.services import flow_metrics
from boards.services.analytics_admission import AnalyticsBusy, AnalyticsTooLarge, analytics_slot
from boards.tests.test_flow_metrics import FlowFixture
from boards.views.analytics import BoardAnalyticsMixin
from visiban.analytics_limits import parse_positive_int


def _user(pk):
    return SimpleNamespace(pk=pk, is_authenticated=True)


def _assert_idle(test):
    test.assertEqual(admission.occupancy(), (0, 0, {}))


class _Holder:
    """Hold a slot in a background thread until ``release()``."""

    def __init__(self, user, **kwargs):
        self.entered = threading.Event()
        self._release = threading.Event()
        self.error = None
        self._thread = threading.Thread(target=self._run, args=(user,), kwargs=kwargs)

    def _run(self, user, **kwargs):
        try:
            with analytics_slot(user, board_id=1, endpoint="test", **kwargs):
                self.entered.set()
                self._release.wait()
        except Exception as exc:  # noqa: BLE001 - surfaced through .error
            self.error = exc
            self.entered.set()

    def start(self):
        self._thread.start()
        return self

    def release(self):
        self._release.set()
        self._thread.join()


@override_settings(ANALYTICS_MAX_CONCURRENT=1)
class AdmissionTests(SimpleTestCase):
    """The gate itself, no database."""

    def tearDown(self):
        _assert_idle(self)

    def test_full_slot_refuses_a_non_waiting_request(self):
        with analytics_slot(_user(1), board_id=1, endpoint="test"):
            with self.assertRaises(AnalyticsBusy):
                with analytics_slot(_user(2), board_id=1, endpoint="test", wait=False):
                    self.fail("admitted past the limit")

    @override_settings(ANALYTICS_MAX_CONCURRENT=5)
    def test_per_user_cap_counts_running_and_waiting(self):
        with analytics_slot(_user(1), board_id=1, endpoint="test"):
            with analytics_slot(_user(1), board_id=1, endpoint="test"):
                with self.assertRaises(AnalyticsBusy):
                    with analytics_slot(_user(1), board_id=1, endpoint="test", wait=True):
                        self.fail("third request of one user admitted")
                with analytics_slot(_user(2), board_id=1, endpoint="test"):
                    self.assertEqual(admission.occupancy()[0], 3)

    def test_waiter_cap(self):
        waiting = threading.Semaphore(0)
        holder = _Holder(_user(100)).start()
        holder.entered.wait()
        with mock.patch.object(admission, "_on_wait", waiting.release):
            waiters = [_Holder(_user(200 + i), wait=True).start() for i in range(admission.MAX_WAITERS)]
            for _ in waiters:
                waiting.acquire()
            self.assertEqual(admission.occupancy()[1], admission.MAX_WAITERS)
            with self.assertRaises(AnalyticsBusy):
                with analytics_slot(_user(999), board_id=1, endpoint="test", wait=True):
                    self.fail("admitted past the waiter cap")
            holder.release()
            for waiter in waiters:
                waiter.entered.wait()
                waiter.release()
                self.assertIsNone(waiter.error)

    def test_bounded_wait_is_admitted_when_the_slot_frees(self):
        holder = _Holder(_user(1)).start()
        holder.entered.wait()
        waiting = threading.Event()
        with mock.patch.object(admission, "_on_wait", waiting.set):
            waiter = _Holder(_user(2), wait=True).start()
            waiting.wait()
            self.assertFalse(waiter.entered.is_set())
            holder.release()
            waiter.entered.wait()
            waiter.release()
        self.assertIsNone(waiter.error)

    def test_bounded_wait_times_out_busy(self):
        with analytics_slot(_user(1), board_id=1, endpoint="test"):
            with mock.patch.object(admission, "REST_WAIT_SECONDS", 0.01):
                with self.assertRaises(AnalyticsBusy):
                    with analytics_slot(_user(2), board_id=1, endpoint="test", wait=True):
                        self.fail("admitted past the wait")

    def _assert_a_failed_wait_gives_the_slot_back(self, patch):
        holder = _Holder(_user(1)).start()
        holder.entered.wait()
        try:
            with patch, self.assertRaises(RuntimeError):
                with analytics_slot(_user(2), board_id=1, endpoint="test", wait=True):
                    self.fail("admitted past a failed wait")
            self.assertEqual(admission.occupancy(), (1, 0, {1: 1}))
        finally:
            holder.release()
        _assert_idle(self)
        with analytics_slot(_user(2), board_id=1, endpoint="test", wait=True):
            pass

    def test_an_error_from_the_wait_hook_gives_the_slot_back(self):
        self._assert_a_failed_wait_gives_the_slot_back(
            mock.patch.object(admission, "_on_wait", side_effect=RuntimeError("hook")),
        )

    def test_an_error_from_the_wait_itself_gives_the_slot_back(self):
        self._assert_a_failed_wait_gives_the_slot_back(
            mock.patch.object(admission._cond, "wait", side_effect=RuntimeError("wait")),
        )

    def test_absent_user_is_never_admitted(self):
        for user in (None, AnonymousUser(), SimpleNamespace(pk=None, is_authenticated=True)):
            with self.subTest(user=user), self.assertRaises(ValueError):
                with analytics_slot(user, board_id=1, endpoint="test"):
                    self.fail("admitted without a key")

    def test_slot_is_released_when_the_body_raises(self):
        for exc in (RuntimeError("boom"), AnalyticsTooLarge()):
            with self.subTest(exc=type(exc).__name__):
                with self.assertRaises(type(exc)):
                    with analytics_slot(_user(1), board_id=1, endpoint="test"):
                        raise exc
                _assert_idle(self)
                with analytics_slot(_user(1), board_id=1, endpoint="test"):
                    pass

    def test_ticket_is_active_only_inside_the_slot(self):
        self.assertIsNone(admission.active_ticket())
        with analytics_slot(_user(1), board_id=1, endpoint="test") as ticket:
            self.assertIs(admission.active_ticket(), ticket)
        self.assertIsNone(admission.active_ticket())

    def test_refusals_are_constant(self):
        busy, large = AnalyticsBusy(), AnalyticsTooLarge()
        self.assertEqual((busy.status_code, busy.wait), (503, 10))
        self.assertEqual(large.status_code, 422)
        self.assertEqual(busy.body(), {"code": "analytics_busy", "detail": admission.ANALYTICS_BUSY_DETAIL})
        self.assertEqual(large.body(), {"code": "analytics_too_large", "detail": admission.ANALYTICS_TOO_LARGE_DETAIL})
        self.assertNotRegex(admission.ANALYTICS_TOO_LARGE_DETAIL, r"\d")

    def test_exit_log_line_names_the_outcome(self):
        with self.assertLogs("boards.services.analytics_admission", logging.INFO) as logs:
            with analytics_slot(_user(7), board_id=3, endpoint="metrics_overview"):
                pass
            with analytics_slot(_user(7), board_id=3, endpoint="metrics_overview"):
                with self.assertRaises(AnalyticsBusy):
                    with analytics_slot(_user(8), board_id=3, endpoint="metrics_overview"):
                        pass
        self.assertRegex(
            logs.output[0],
            r"analytics\.replay user_id=7 board_id=3 endpoint=metrics_overview movements=0 streamed=0 duration_ms=\d+ outcome=ok",
        )
        self.assertIn("user_id=8 board_id=3 endpoint=metrics_overview movements=0", logs.output[1])
        self.assertIn("outcome=busy", logs.output[1])


class SettingsParsingTests(SimpleTestCase):
    def test_blank_or_unset_is_the_default(self):
        for raw in (None, "", "  "):
            self.assertEqual(parse_positive_int(raw, name="ANALYTICS_MAX_CONCURRENT", default=1), 1)

    def test_positive_integer_is_read(self):
        self.assertEqual(parse_positive_int("3", name="ANALYTICS_MAX_CONCURRENT", default=1), 3)

    def test_zero_negative_and_non_integer_stop_startup(self):
        for name in ("ANALYTICS_MAX_CONCURRENT", "ANALYTICS_MAX_MOVEMENTS"):
            for raw in ("0", "-1", "abc", "1.5"):
                with self.subTest(name=name, raw=raw), self.assertRaisesRegex(ImproperlyConfigured, name):
                    parse_positive_int(raw, name=name, default=1)


# Every BoardAnalyticsMixin action that replays history, with a URL that reaches it.
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
_REPLAY_CALL = re.compile(r"flow_metrics\.load_|_load_flow\(|_load_range_flow\(")


class CoveragePinTests(SimpleTestCase):
    def test_every_replaying_action_is_gated_and_tested(self):
        replaying = {
            name for name, member in vars(BoardAnalyticsMixin).items()
            if callable(member) and _REPLAY_CALL.search(inspect.getsource(member))
        }
        self.assertEqual(replaying, set(COVERED), "a new analytics action must take analytics_slot and join COVERED")
        for name in replaying:
            with self.subTest(action=name):
                self.assertIn(f'_analytics_slot(request, board, "{name}")', inspect.getsource(getattr(BoardAnalyticsMixin, name)))


class BlockRowsCountTests(FlowFixture):
    """Block rows are held until the load ends, so they count against the size limit (#2428)."""

    def _blocks(self):
        card = self.path(self.backlog, 10, self.doing, 8)
        for days in (6, 4, 2):
            CardBlock.objects.create(
                card=card, board=self.board, reason="Vendor",
                blocked_at=self.ago(days), unblocked_at=self.ago(days - 1),
            )
        return card

    def test_block_spans_count_as_held_rows(self):
        self._blocks()
        last = flow_metrics.rolling_range(30, now=self.now)
        flow = flow_metrics.load_board_flow(self.board, now=self.now)
        with override_settings(ANALYTICS_MAX_MOVEMENTS=2), self.assertRaises(AnalyticsTooLarge):
            list(flow_metrics._block_spans(flow, last))
        with override_settings(ANALYTICS_MAX_MOVEMENTS=3):
            self.assertEqual(len(list(flow_metrics._block_spans(flow, last))), 3)
        # Inside one request the rows join the shared ticket.
        with override_settings(ANALYTICS_MAX_MOVEMENTS=100):
            with analytics_slot(self.user, board_id=self.board.pk, endpoint="test") as ticket:
                list(flow_metrics._block_spans(flow, last))
            self.assertEqual(ticket.movements, 3)

    def test_in_progress_blocked_seconds_count_as_held_rows(self):
        card = self._blocks()
        flow = flow_metrics.load_board_flow(self.board, now=self.now)
        in_progress = [c for c in flow.cards if c.uid == card.uid]
        self.assertTrue(in_progress)
        with override_settings(ANALYTICS_MAX_MOVEMENTS=2), self.assertRaises(AnalyticsTooLarge):
            flow_metrics._blocked_seconds_in_progress(flow, in_progress)
        with override_settings(ANALYTICS_MAX_MOVEMENTS=3):
            self.assertIn(card.id, flow_metrics._blocked_seconds_in_progress(flow, in_progress))


@override_settings(ANALYTICS_MAX_CONCURRENT=1)
class AnalyticsGateViewTests(FlowFixture):
    def setUp(self):
        super().setUp()
        self.path(self.backlog, 20, self.doing, 10, self.done, 5)
        self.path(self.backlog, 15, self.doing, 3)
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.outsider = User.objects.create_user(username="outsider_2428", password="pw")

    def tearDown(self):
        _assert_idle(self)

    def url(self, suffix):
        return f"/api/v1/boards/{self.board.pk}/{suffix}"

    def test_every_covered_endpoint_refuses_busy(self):
        other = _user(10_000)
        with mock.patch.object(admission, "REST_WAIT_SECONDS", 0):
            with analytics_slot(other, board_id=1, endpoint="test"):
                bodies = {}
                for name, suffix in COVERED.items():
                    with self.subTest(action=name):
                        response = self.client.get(self.url(suffix))
                        self.assertEqual(response.status_code, 503)
                        self.assertEqual(response.json()["code"], "analytics_busy")
                        self.assertIsInstance(response.json()["code"], str)
                        self.assertEqual(response["Retry-After"], "10")
                        bodies[name] = response.content
                with override_settings(ANALYTICS_MAX_CONCURRENT=2):
                    with analytics_slot(_user(10_001), board_id=1, endpoint="test"):
                        busier = self.client.get(self.url("metrics/overview/"))
        self.assertEqual(busier.status_code, 503)
        self.assertEqual(busier.content, bodies["metrics_overview"])
        self.assertEqual(len(set(bodies.values())), 1)

    def test_over_budget_is_refused_too_large(self):
        yesterday = (self.now.date() - __import__("datetime").timedelta(days=1)).isoformat()
        with override_settings(ANALYTICS_MAX_MOVEMENTS=2), mock.patch("django.utils.timezone.now", return_value=self.now):
            for suffix in ("metrics/overview/", "analytics/", "metrics/cycle-time/", "metrics/cumulative-flow/",
                           f"metrics/cumulative-flow/?date={yesterday}"):
                with self.subTest(suffix=suffix):
                    response = self.client.get(self.url(suffix))
                    self.assertEqual(response.status_code, 422)
                    self.assertEqual(response.json(), AnalyticsTooLarge().body())
        with override_settings(ANALYTICS_MAX_MOVEMENTS=100):
            self.assertEqual(self.client.get(self.url("metrics/overview/")).status_code, 200)

    def _age_the_board(self, generations=2):
        # Archived long before the range: only the cumulative-flow settled pass
        # reads these, card by card, so the board is old but its range is small.
        for g in range(generations):
            start = 400 + 100 * g
            for _ in range(2):
                self.path(self.backlog, start, self.doing, start - 10, self.done, start - 20, archived=start - 30)

    def _replay_counts(self, suffix):
        with self.assertLogs("boards.services.analytics_admission", logging.INFO) as logs:
            response = self.client.get(self.url(suffix))
        held, streamed = re.search(r"movements=(\d+) streamed=(\d+) ", logs.output[-1]).groups()
        return response.status_code, int(held), int(streamed)

    def test_settled_pass_is_streamed_not_held(self):
        self._age_the_board()
        moves = CardMovement.objects.filter(card__board=self.board)
        live = moves.filter(card__archived_at__isnull=True).count()
        settled = moves.filter(card__archived_at__isnull=False).count()
        self.assertGreater(settled, live)
        with mock.patch("django.utils.timezone.now", return_value=self.now):
            self.assertEqual(self._replay_counts("metrics/cumulative-flow/?days=30"), (200, live, settled))
            # The held budget is the live history alone: the old history is
            # well past it and still does not count against it.
            with override_settings(ANALYTICS_MAX_MOVEMENTS=live):
                self.assertEqual(self.client.get(self.url("metrics/cumulative-flow/?days=30")).status_code, 200)

    def test_an_old_board_gets_its_overview_while_a_held_overrun_is_refused(self):
        self._age_the_board()
        total = CardMovement.objects.filter(card__board=self.board).count()
        yesterday = (self.now.date() - __import__("datetime").timedelta(days=1)).isoformat()
        with mock.patch("django.utils.timezone.now", return_value=self.now):
            status_code, held, streamed = self._replay_counts("metrics/overview/?days=30")
            self.assertEqual(status_code, 200)
            self.assertLess(held, total)
            self.assertGreater(streamed, 0)
            with override_settings(ANALYTICS_MAX_MOVEMENTS=held):
                self.assertEqual(self.client.get(self.url("metrics/overview/?days=30")).status_code, 200)
                # The day drill-down holds the whole history: past the budget, refused.
                response = self.client.get(self.url(f"metrics/cumulative-flow/?date={yesterday}"))
                self.assertEqual(response.status_code, 422)
                self.assertEqual(response.json(), AnalyticsTooLarge().body())
            with override_settings(ANALYTICS_MAX_MOVEMENTS=total):
                self.assertEqual(self.client.get(self.url(f"metrics/cumulative-flow/?date={yesterday}")).status_code, 200)

    def test_streamed_rows_still_stop_at_the_fixed_ceiling(self):
        self._age_the_board(generations=4)
        moves = CardMovement.objects.filter(card__board=self.board)
        live = moves.filter(card__archived_at__isnull=True).count()
        settled = moves.filter(card__archived_at__isnull=False).count()
        with mock.patch("django.utils.timezone.now", return_value=self.now):
            with override_settings(ANALYTICS_MAX_MOVEMENTS=live), \
                    mock.patch.object(admission, "STREAMED_ROWS_MULTIPLE", settled // live - 1 or 1):
                self.assertLess(live * admission.STREAMED_ROWS_MULTIPLE, settled)
                response = self.client.get(self.url("metrics/cumulative-flow/?days=30"))
            self.assertEqual(response.status_code, 422)
            self.assertEqual(response.json(), AnalyticsTooLarge().body())
        self.assertGreaterEqual(admission.STREAMED_ROWS_MULTIPLE, 2)

    def test_non_member_gets_404_before_any_refusal(self):
        self.client.force_authenticate(self.outsider)
        with mock.patch.object(admission, "REST_WAIT_SECONDS", 0):
            with analytics_slot(_user(10_000), board_id=1, endpoint="test"):
                self.assertEqual(self.client.get(self.url("metrics/overview/")).status_code, 404)
        with override_settings(ANALYTICS_MAX_MOVEMENTS=1):
            for suffix in COVERED.values():
                with self.subTest(suffix=suffix):
                    self.assertEqual(self.client.get(self.url(suffix)).status_code, 404)

    def test_bad_params_are_400_before_admission(self):
        with mock.patch.object(admission, "REST_WAIT_SECONDS", 0):
            with analytics_slot(_user(10_000), board_id=1, endpoint="test"):
                self.assertEqual(self.client.get(self.url("metrics/overview/?days=0")).status_code, 400)
                self.assertEqual(self.client.get(self.url("analytics/?days=abc")).status_code, 400)

    def test_slot_is_released_when_the_load_raises(self):
        with mock.patch.object(flow_metrics, "load_range_flow", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                self.client.get(self.url("metrics/cycle-time/"))
        _assert_idle(self)
        with override_settings(ANALYTICS_MAX_MOVEMENTS=1):
            self.assertEqual(self.client.get(self.url("metrics/cycle-time/")).status_code, 422)
        _assert_idle(self)
        self.assertEqual(self.client.get(self.url("metrics/cycle-time/")).status_code, 200)

    def test_site_admin_is_not_exempt(self):
        self.user.is_superuser = True
        self.user.is_staff = True
        self.user.save()
        with override_settings(ANALYTICS_MAX_MOVEMENTS=1):
            self.assertEqual(self.client.get(self.url("metrics/overview/")).status_code, 422)

    def test_schema_documents_both_refusals(self):
        from drf_spectacular.generators import SchemaGenerator

        paths = SchemaGenerator().get_schema(request=None, public=True)["paths"]
        for suffix in COVERED.values():
            path = f"/api/v1/boards/{{id}}/{suffix}"
            with self.subTest(path=path):
                responses = paths[path]["get"]["responses"]
                self.assertIn("422", responses)
                self.assertIn("503", responses)


class AbsentTicketTests(FlowFixture):
    """With no active ticket (direct service callers), the settings budget still applies (#1075)."""

    def test_row_counter_without_a_ticket_is_a_fresh_settings_budget(self):
        with override_settings(ANALYTICS_MAX_MOVEMENTS=3):
            first, second = admission.row_counter(), admission.row_counter()
        self.assertIsNot(first, second)
        self.assertEqual((first.budget, first.movements, first.streamed), (3, 0, 0))
        first.count_rows(3, held=True)
        with self.assertRaises(AnalyticsTooLarge):
            first.count_rows(1, held=True)
        second.count_rows(3 * admission.STREAMED_ROWS_MULTIPLE, held=False)
        with self.assertRaises(AnalyticsTooLarge):
            second.count_rows(1, held=False)

    def test_direct_load_enforces_the_settings_budget(self):
        self.path(self.backlog, 20, self.doing, 10, self.done, 5)
        self.assertIsNone(admission.active_ticket())
        with override_settings(ANALYTICS_MAX_MOVEMENTS=2), self.assertRaises(AnalyticsTooLarge):
            flow_metrics.load_board_flow(self.board, now=self.now)
        with override_settings(ANALYTICS_MAX_MOVEMENTS=3):
            flow_metrics.load_board_flow(self.board, now=self.now)


@override_settings(ANALYTICS_MAX_CONCURRENT=1)
class AnalyticsGateConcurrencyTests(TransactionTestCase):
    """Two real requests in two threads at a limit of one (PostgreSQL only)."""

    def setUp(self):
        if connection.vendor != "postgresql":
            self.skipTest("threaded ORM requests need PostgreSQL")
        self.user = User.objects.create_user(username="conc_2428", password="pw")
        self.board = Board.objects.create(name="Conc", owner=self.user)
        BoardMembership.objects.create(board=self.board, user=self.user, role="admin")
        Column.objects.create(board=self.board, name="Doing", position=0)
        Swimlane.objects.create(board=self.board, name="Lane", position=0)
        self.other = User.objects.create_user(username="conc_2428_b", password="pw")
        BoardMembership.objects.create(board=self.board, user=self.other, role="member")

    def _run_pair(self):
        inside, release = threading.Event(), threading.Event()
        real = flow_metrics.load_cumulative_flow

        def slow(*args, **kwargs):
            if not inside.is_set():
                inside.set()
                release.wait()
            return real(*args, **kwargs)

        results = {}

        def get(user):
            client = APIClient()
            client.force_authenticate(user)
            results[user.username] = client.get(f"/api/v1/boards/{self.board.pk}/metrics/overview/").status_code
            _conns.close_all()

        return slow, inside, release, results, get

    def test_waiting_requests_both_succeed_one_after_the_other(self):
        slow, inside, release, results, get = self._run_pair()
        waiting = threading.Event()
        with mock.patch.object(flow_metrics, "load_cumulative_flow", slow), \
                mock.patch.object(admission, "_on_wait", waiting.set):
            first = threading.Thread(target=get, args=(self.user,))
            first.start()
            inside.wait()
            second = threading.Thread(target=get, args=(self.other,))
            second.start()
            waiting.wait()
            release.set()
            first.join()
            second.join()
        self.assertEqual(results, {"conc_2428": 200, "conc_2428_b": 200})
        _assert_idle(self)

    def test_without_wait_exactly_one_is_refused(self):
        slow, inside, release, results, get = self._run_pair()
        with mock.patch.object(flow_metrics, "load_cumulative_flow", slow), \
                mock.patch.object(admission, "REST_WAIT_SECONDS", 0):
            first = threading.Thread(target=get, args=(self.user,))
            first.start()
            inside.wait()
            second = threading.Thread(target=get, args=(self.other,))
            second.start()
            second.join()
            release.set()
            first.join()
        self.assertEqual(sorted(results.values()), [200, 503])
        _assert_idle(self)
