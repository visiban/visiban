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
from boards.models import Board, BoardMembership, Column, Swimlane
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
            r"analytics\.replay user_id=7 board_id=3 endpoint=metrics_overview movements=0 duration_ms=\d+ outcome=ok",
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

    def test_settled_pass_counts_against_the_same_budget(self):
        # Archived long before the range: only the cumulative-flow settled pass reads it.
        self.path(self.backlog, 400, self.doing, 390, self.done, 380, archived=370)
        self.path(self.backlog, 400, self.doing, 390, self.done, 380, archived=370)
        with mock.patch("django.utils.timezone.now", return_value=self.now):
            with override_settings(ANALYTICS_MAX_MOVEMENTS=5):
                self.assertEqual(self.client.get(self.url("metrics/cycle-time/?days=30")).status_code, 200)
                response = self.client.get(self.url("metrics/cumulative-flow/?days=30"))
            self.assertEqual(response.status_code, 422)
            with override_settings(ANALYTICS_MAX_MOVEMENTS=50):
                self.assertEqual(self.client.get(self.url("metrics/cumulative-flow/?days=30")).status_code, 200)

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
