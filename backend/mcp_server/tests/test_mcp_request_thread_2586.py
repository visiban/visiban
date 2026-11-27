"""MCP requests run their sync work on an executor of their own (#2586).

See ``mcp_server.asgi_mount.MCPRequestThreadMiddleware``. These need
MCP_SERVER_ENABLED, like the rest of the MCP suite.
"""
import pytest
from django.conf import settings

if not settings.MCP_SERVER_ENABLED:  # pragma: no cover - exercised only in the flagged CI job
    pytest.skip(
        "MCP server disabled; set MCP_SERVER_ENABLED=true to run these.",
        allow_module_level=True,
    )

import asyncio
import contextlib
import threading
import time
import types
from unittest import mock

from asgiref.sync import SyncToAsync, async_to_sync, sync_to_async
from channels.db import database_sync_to_async
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import connections
from django.test import SimpleTestCase, TransactionTestCase, override_settings

from accounts.models import SCOPE_MCP_READ, PersonalAccessToken
from boards.tests.conftest import _make_user
from mcp_server import asgi_mount, auth, throttling, tools
from mcp_server.asgi_mount import (
    McpPathRouter, MCPRequestThreadMiddleware, _LazySessionManagerApp,
    build_mcp_asgi_app,
)
from mcp_server.context import set_current_token_id
from mcp_server.tests.test_mcp import McpRequest, _parse_sse, _unreachable_django

# Seconds. A passing run never waits on these; they only stop a failing run
# from hanging the suite.
_WAIT = 10

_LIST_BOARDS_CALL = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {"name": "list_boards", "arguments": {}},
}


def _run_on_server_style_loop(coro_fn):
    """Run ``coro_fn()`` on a fresh event loop in its own thread.

    No ``async_to_sync`` caller sits above it, so thread-sensitive work is
    routed the way it is under Daphne rather than onto the test's thread.
    """
    outcome = {}

    def worker():
        try:
            outcome["value"] = asyncio.run(coro_fn())
        except BaseException as exc:  # re-raised on the test thread below
            outcome["error"] = exc
        finally:
            connections.close_all()

    thread = threading.Thread(target=worker)
    thread.start()
    thread.join(_WAIT * 4)
    assert not thread.is_alive(), "event loop thread did not finish"
    if "error" in outcome:
        raise outcome["error"]
    return outcome["value"]


class McpRequestThreadTests(TransactionTestCase):
    """End to end through the mounted app, on committed data.

    TransactionTestCase because the request's own thread opens its own
    connection, which cannot see a TestCase's uncommitted rows.
    """

    def setUp(self):
        super().setUp()
        cache.clear()
        self.user = _make_user("mcp-request-thread")
        self.pat, self.raw_token = PersonalAccessToken.generate(
            self.user, "mcp", scopes=[SCOPE_MCP_READ]
        )

    def test_tool_call_runs_on_its_own_request_thread(self):
        tool_started = threading.Event()
        release_tool = threading.Event()
        seen = {}
        real_authenticate = auth._authenticate_and_authorize
        real_close = asgi_mount._close_request_connections
        user_model = get_user_model()

        def recording_authenticate(raw_token):
            seen["auth_thread"] = threading.current_thread()
            return real_authenticate(raw_token)

        def blocking_list_boards():
            seen["tool_thread"] = threading.current_thread()
            user_model.objects.count()  # opens this thread's connection
            seen["tool_connection"] = connections["default"]
            tool_started.set()
            release_tool.wait(_WAIT)
            return []

        def recording_close():
            seen["close_thread"] = threading.current_thread()
            real_close()

        def other_db_call():
            seen["other_thread"] = threading.current_thread()
            return user_model.objects.filter(pk=self.user.pk).count()

        async def scenario():
            client = McpRequest(McpPathRouter(_unreachable_django, build_mcp_asgi_app()))
            call = asyncio.ensure_future(client._call(_LIST_BOARDS_CALL, token=self.raw_token))
            try:
                started = await asyncio.get_running_loop().run_in_executor(
                    None, tool_started.wait, _WAIT
                )
                assert started, "tool call never started"
                # Another thread-sensitive call outside the request
                # completes while this one is in progress.
                other_count = await asyncio.wait_for(
                    database_sync_to_async(other_db_call)(), _WAIT
                )
                seen["other_call_done_first"] = not release_tool.is_set()
            finally:
                release_tool.set()
            status, body = await asyncio.wait_for(call, _WAIT)
            await database_sync_to_async(connections.close_all)()
            return status, body, other_count

        # Patched here on the test thread, never inside a worker thread.
        with mock.patch.object(auth, "_authenticate_and_authorize", recording_authenticate), \
                mock.patch.object(tools, "list_boards", blocking_list_boards), \
                mock.patch.object(asgi_mount, "_close_request_connections", recording_close):
            status, body, other_count = _run_on_server_style_loop(scenario)

        self.assertEqual(status, 200, body)
        result = _parse_sse(body)["result"]
        self.assertFalse(result["isError"], result)
        self.assertEqual(other_count, 1)
        self.assertTrue(seen["other_call_done_first"])
        # Thread objects, not get_ident(): an ident can be reused once a
        # thread exits, which would make an identity check pass by accident.
        # One thread for the whole request: auth and the tool share it, so a
        # transaction and its connection stay on one thread...
        self.assertIs(seen["auth_thread"], seen["tool_thread"])
        # ...and it is not the other call's thread.
        self.assertIsNot(seen["tool_thread"], seen["other_thread"])
        # The request's connections were closed on that thread before it went,
        # and the thread itself was shut down with the request.
        self.assertIs(seen["close_thread"], seen["tool_thread"])
        self.assertFalse(seen["tool_thread"].is_alive())
        tool_connection = seen["tool_connection"]
        if not (tool_connection.vendor == "sqlite" and tool_connection.is_in_memory_db()):
            # Django ignores close() on an in-memory SQLite database (closing
            # would destroy it), so the handle is only checkable elsewhere,
            # e.g. PostgreSQL in CI.
            self.assertIsNone(tool_connection.connection)

    def test_each_request_gets_a_new_thread(self):
        threads = []
        real_list_boards = tools.list_boards

        def recording_list_boards():
            threads.append(threading.current_thread())
            return real_list_boards()

        async def scenario():
            client = McpRequest(McpPathRouter(_unreachable_django, build_mcp_asgi_app()))
            statuses = []
            for _ in range(2):
                status, _body = await client._call(_LIST_BOARDS_CALL, token=self.raw_token)
                statuses.append(status)
            return statuses

        with mock.patch.object(tools, "list_boards", recording_list_boards):
            statuses = _run_on_server_style_loop(scenario)

        self.assertEqual(statuses, [200, 200])
        self.assertEqual(len(threads), 2)
        # The first request's executor was shut down, not reused.
        self.assertIsNot(threads[0], threads[1])
        self.assertFalse(threads[0].is_alive())


class McpWorkAfterRequestTests(TransactionTestCase):
    """MCP work that runs after its request has ended closes its connections."""

    def test_call_after_the_request_ends_closes_its_connection(self):
        user_model = get_user_model()
        seen = {}

        def first_call():
            seen["request_thread"] = threading.current_thread()
            user_model.objects.count()

        def late_call():
            seen["late_thread"] = threading.current_thread()
            user_model.objects.count()  # opens this thread's connection
            seen["late_connection"] = connections["default"]
            return "done"

        async def scenario():
            resume = asyncio.Event()
            work = {}

            async def dispatched_work():
                # Like the MCP SDK: a task that copied the request's context
                # and makes its next call after the request has ended.
                await asgi_mount.request_sync_to_async(first_call)()
                await resume.wait()
                work["context"] = SyncToAsync.thread_sensitive_context.get()
                return await asgi_mount.request_sync_to_async(late_call)()

            async def app(scope, receive, send):
                work["task"] = asyncio.ensure_future(dispatched_work())
                while "request_thread" not in seen:
                    await asyncio.sleep(0)

            await MCPRequestThreadMiddleware(app)({"type": "http"}, None, None)
            resume.set()
            result = await asyncio.wait_for(work["task"], _WAIT)
            return result, work["context"]

        result, request_context = _run_on_server_style_loop(scenario)

        self.assertEqual(result, "done")
        # No executor was left behind for the finished request.
        self.assertNotIn(request_context, SyncToAsync.context_to_thread_executor)
        self.assertIsNot(seen["late_thread"], seen["request_thread"])
        late_connection = seen["late_connection"]
        if not (late_connection.vendor == "sqlite" and late_connection.is_in_memory_db()):
            # See test_tool_call_runs_on_its_own_request_thread for why this
            # is checked only off in-memory SQLite.
            self.assertIsNone(late_connection.connection)

    def test_calls_during_the_request_share_its_thread(self):
        threads = []

        async def app(scope, receive, send):
            for _ in range(2):
                threads.append(
                    await asgi_mount.request_sync_to_async(threading.current_thread)()
                )

        _run_on_server_style_loop(
            lambda: MCPRequestThreadMiddleware(app)({"type": "http"}, None, None)
        )

        self.assertEqual(len(threads), 2)
        self.assertIs(threads[0], threads[1])
        self.assertFalse(threads[0].is_alive())


class McpRequestThreadMiddlewareTests(SimpleTestCase):
    """The middleware leaves a caller-owned thread's connections alone."""

    def test_no_cleanup_when_sync_work_ran_on_the_callers_thread(self):
        observed = []

        async def inner(scope, receive, send):
            observed.append(await sync_to_async(threading.current_thread, thread_sensitive=True)())

        with mock.patch.object(asgi_mount, "_close_request_connections") as close:
            async_to_sync(MCPRequestThreadMiddleware(inner))({"type": "http"}, None, None)

        # Under async_to_sync, thread-sensitive work goes to the calling
        # thread, whose connection the caller owns (a TestCase transaction
        # here), so the middleware must not close it.
        self.assertEqual(observed, [threading.current_thread()])
        close.assert_not_called()

    def test_no_cleanup_when_no_sync_work_ran(self):
        async def inner(scope, receive, send):
            return None

        def run():
            asyncio.run(MCPRequestThreadMiddleware(inner)({"type": "http"}, None, None))

        with mock.patch.object(asgi_mount, "_close_request_connections") as close:
            run()
        close.assert_not_called()


class McpRequestCleanupTests(SimpleTestCase):
    """The request's connection cleanup runs however the request ends."""

    def test_cleanup_runs_on_the_request_thread_when_the_request_is_cancelled(self):
        call_running = threading.Event()
        release_call = threading.Event()
        seen = {}

        def in_flight_call():
            seen["request_thread"] = threading.current_thread()
            call_running.set()
            release_call.wait(_WAIT)

        def recording_close():
            seen["close_thread"] = threading.current_thread()

        async def scenario():
            async def app(scope, receive, send):
                seen["context"] = SyncToAsync.thread_sensitive_context.get()
                await asgi_mount.request_sync_to_async(in_flight_call)()

            request = asyncio.ensure_future(
                MCPRequestThreadMiddleware(app)({"type": "http"}, None, None)
            )
            started = await asyncio.get_running_loop().run_in_executor(
                None, call_running.wait, _WAIT
            )
            assert started, "sync call never started"
            executor = SyncToAsync.context_to_thread_executor[seen["context"]]
            # The call is released only once the request reaches its context
            # exit, so the cleanup is still queued behind it when the second
            # cancellation below arrives.
            real_shutdown = executor.shutdown

            def shutdown_after_release(*args, **kwargs):
                release_call.set()
                return real_shutdown(*args, **kwargs)

            executor.shutdown = shutdown_after_release

            request.cancel()
            deadline = time.monotonic() + _WAIT
            # _work_queue is the executor's pending-work queue: one item means
            # the cleanup has been queued behind the running call.
            while executor._work_queue.qsize() == 0:
                assert time.monotonic() < deadline, "cleanup was never queued"
                await asyncio.sleep(0)
            request.cancel()
            try:
                await request
            except asyncio.CancelledError:
                pass
            return request.cancelled()

        # Patched here on the test thread, never inside a worker thread.
        with mock.patch.object(asgi_mount, "_close_request_connections", recording_close):
            cancelled = _run_on_server_style_loop(scenario)

        self.assertTrue(cancelled)
        self.assertIn("close_thread", seen, "cleanup did not run")
        self.assertIs(seen["close_thread"], seen["request_thread"])
        self.assertFalse(seen["request_thread"].is_alive())
        self.assertNotIn(seen["context"], SyncToAsync.context_to_thread_executor)

    def test_cleanup_failure_is_logged_and_the_request_error_kept(self):
        class RequestFailure(Exception):
            pass

        def failing_close():
            raise RuntimeError("cleanup failed")

        async def app(scope, receive, send):
            await asgi_mount.request_sync_to_async(threading.current_thread)()
            raise RequestFailure("request failed")

        with mock.patch.object(asgi_mount, "_close_request_connections", failing_close), \
                self.assertLogs("mcp_server.asgi_mount", level="ERROR") as logs, \
                self.assertRaises(RequestFailure):
            _run_on_server_style_loop(
                lambda: MCPRequestThreadMiddleware(app)({"type": "http"}, None, None)
            )

        self.assertEqual(len(logs.records), 1)
        self.assertIn("Closing MCP request database connections failed", logs.output[0])
        self.assertIs(logs.records[0].exc_info[0], RuntimeError)


class McpSessionSupervisorContextTests(SimpleTestCase):
    """The session manager's supervisor task starts from an empty context."""

    def test_supervisor_does_not_carry_the_first_requests_context(self):
        seen = {}

        @contextlib.asynccontextmanager
        async def run():
            seen["supervisor_context"] = SyncToAsync.thread_sensitive_context.get(None)
            seen["supervisor_state"] = asgi_mount._request_state.get()
            yield

        async def app(scope, receive, send):
            seen["request_context"] = SyncToAsync.thread_sensitive_context.get(None)
            seen["request_state"] = asgi_mount._request_state.get()

        def factory():
            return app, types.SimpleNamespace(run=run)

        _run_on_server_style_loop(
            lambda: MCPRequestThreadMiddleware(_LazySessionManagerApp(factory))(
                {"type": "http"}, None, None
            )
        )

        # The request itself ran inside its own context...
        self.assertIsNotNone(seen["request_context"])
        self.assertIsNotNone(seen["request_state"])
        # ...and the supervisor, which outlives it, did not inherit it.
        self.assertIsNone(seen["supervisor_context"])
        self.assertIsNone(seen["supervisor_state"])


class _SlowReadCache:
    """The real cache, with a pause after every read.

    The pause widens the gap between a limiter's read and its write, so
    calls that are not kept whole would overlap there and lose updates.
    """

    def __init__(self, real):
        self._real = real

    def get(self, *args, **kwargs):
        value = self._real.get(*args, **kwargs)
        time.sleep(0.05)
        return value

    def set(self, *args, **kwargs):
        return self._real.set(*args, **kwargs)


def _run_in_parallel(count, fn):
    """Call ``fn()`` from ``count`` threads released together; return results."""
    barrier = threading.Barrier(count)
    results = []
    results_lock = threading.Lock()

    def worker():
        try:
            barrier.wait(_WAIT)
            value = fn()
            with results_lock:
                results.append(value)
        finally:
            connections.close_all()

    threads = [threading.Thread(target=worker) for _ in range(count)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(_WAIT)
    assert not any(t.is_alive() for t in threads), "a limiter call did not finish"
    return results


class McpLimiterParallelCallTests(SimpleTestCase):
    """The MCP rate limiters stay atomic within a process.

    Each MCP request runs its sync work on a thread of its own, so limiter
    calls can run in parallel; every call's read and write must stay whole.
    """

    def setUp(self):
        super().setUp()
        cache.clear()
        # Patched here on the test thread, never inside a worker thread.
        patcher = mock.patch.object(throttling, "cache", _SlowReadCache(cache))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(cache.clear)

    def test_parallel_failures_are_all_recorded(self):
        calls = 6
        ip = "203.0.113.7"

        _run_in_parallel(calls, lambda: throttling.preauth_limiter.record_failure(ip))

        recorded = cache.get(throttling.PreAuthFailureLimiter._key(ip), [])
        self.assertEqual(len(recorded), calls)

    @override_settings(MCP_THROTTLE_READ_RATE="3/min")
    def test_parallel_checks_allow_exactly_the_limit(self):
        limit, calls = 3, 6

        def check_as_token():
            set_current_token_id(4242)
            return throttling.read_bucket.check()

        results = _run_in_parallel(calls, check_as_token)

        allowed = [r for r in results if r is None]
        self.assertEqual(len(results), calls)
        self.assertEqual(len(allowed), limit)
