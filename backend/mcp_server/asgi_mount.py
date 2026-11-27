"""Mount the MCP server into Visiban's existing ASGI application.

Kept out of ``visiban/asgi.py`` on purpose: that file carries two stable
enterprise extension-point contracts (#1009) and should not absorb MCP SDK
churn. All of the SDK-mounting mechanics live here (#511).
"""
import asyncio
import contextvars
import functools
import logging

from asgiref.sync import SyncToAsync, ThreadSensitiveContext, sync_to_async
from django.conf import settings
from django.db import connections

logger = logging.getLogger(__name__)

# Mount path for the Streamable HTTP transport (MCP spec rev 2025-03-26).
# Both this and the SSE backward-compatibility endpoint live under it.
MCP_BASE_PATH = "/mcp"

# Request/response headers a Streamable HTTP MCP client needs, beyond the
# CORS-"simple" set, before a browser will let JS read the response or send
# the request at all. `authorization` and a non-simple `content-type` are
# exactly what turn a POST into a preflighted request in the first place, so
# they must also be echoed as *allowed* (not just tolerated) or the browser
# never sends the real request. `mcp-session-id`/`mcp-protocol-version` are
# the SDK's own custom headers (mcp.server.streamable_http.MCP_SESSION_ID_
# HEADER / MCP_PROTOCOL_VERSION_HEADER) — a client sends the latter and reads
# the former back, so both need to be allowed AND exposed.
_CORS_ALLOWED_HEADERS = "authorization, content-type, accept, mcp-session-id, mcp-protocol-version"
_CORS_EXPOSED_HEADERS = "mcp-session-id"
_CORS_ALLOWED_METHODS = "GET, POST, OPTIONS"
# Browsers cache a preflight result for this long, so a change to the origin
# allowlist takes up to this long to reach an already-cached client — kept
# short (ten minutes) rather than corsheaders' default (86400s) since this is
# new surface and worth being able to walk back quickly.
_CORS_MAX_AGE = "600"
# Sent on every /mcp response regardless of allow/deny outcome — see
# MCPCorsMiddleware._send_preflight's docstring comment for why omitting it
# on the disallowed-origin branch is a cache-poisoning risk, not just an
# asymmetry.
_VARY_ORIGIN = (b"vary", b"Origin")


def _get_ascii_header(scope, name):
    """Return one ASGI request header by name (already-lowercased bytes), or None."""
    for key, value in scope.get("headers", []):
        if key == name:
            try:
                return value.decode("latin-1")
            except UnicodeDecodeError:  # pragma: no cover - malformed header
                return None
    return None


def _cors_allowed_origin(origin):
    """Return *origin* if it is a trusted MCP client origin, else None.

    Reuses ``CORS_ALLOWED_ORIGINS`` — the same allowlist already trusted for
    the REST API and the WebSocket handshake — rather than a second list that
    could drift from it. Exact match only, matching this project's existing
    CORS configuration (no ``CORS_ALLOWED_ORIGIN_REGEXES``/wildcard support is
    configured, so none is added here).
    """
    if not origin:
        return None
    allowed = getattr(settings, "CORS_ALLOWED_ORIGINS", []) or []
    return origin if origin in allowed else None


class MCPCorsMiddleware:
    """Add CORS headers to ``/mcp`` so a browser-based MCP client can reach it.

    Necessary because ``/mcp`` is mounted at the ASGI ``ProtocolTypeRouter``
    level (``visiban/asgi.py`` -> ``McpPathRouter``), in front of
    ``get_asgi_application()`` — a request routed here never reaches Django's
    own middleware stack, so ``corsheaders.middleware.CorsMiddleware`` (which
    only runs inside that stack) has zero effect on ``/mcp`` today, unlike
    every REST endpoint.

    Wraps :class:`~mcp_server.auth.BearerAuthMiddleware` from the OUTSIDE,
    not the inside. A CORS preflight (``OPTIONS``) request carries no
    ``Authorization`` header by design — that is what the browser is
    checking permission for before it sends one — so if this ran inside the
    auth layer, the auth layer would 401 every preflight and the browser
    would never send the real, authenticated request. Preflights are
    answered here directly, before authentication ever runs.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        origin = _get_ascii_header(scope, b"origin")
        allowed_origin = _cors_allowed_origin(origin)

        if scope["method"] == "OPTIONS":
            await self._send_preflight(send, allowed_origin)
            return

        async def send_with_cors(message):
            if message["type"] == "http.response.start":
                extra = [_VARY_ORIGIN]
                if allowed_origin:
                    extra.extend(self._response_headers(allowed_origin))
                message = {**message, "headers": [*message["headers"], *extra]}
            await send(message)

        await self.app(scope, receive, send_with_cors)

    @staticmethod
    def _response_headers(allowed_origin):
        """Allow-origin headers only — callers add ``_VARY_ORIGIN`` themselves.

        Split out so both call sites (the real-response path and the
        preflight path) can add ``Vary: Origin`` exactly once, unconditionally
        — see the cache-poisoning note where it's added.
        """
        headers = [
            (b"access-control-allow-origin", allowed_origin.encode("latin-1")),
            (b"access-control-expose-headers", _CORS_EXPOSED_HEADERS.encode("latin-1")),
        ]
        if getattr(settings, "CORS_ALLOW_CREDENTIALS", False):
            headers.append((b"access-control-allow-credentials", b"true"))
        return headers

    async def _send_preflight(self, send, allowed_origin):
        # `Vary: Origin` is sent on EVERY preflight response, allowed or not
        # — omitting it only on the disallowed branch would let a shared
        # cache store this "no CORS headers" response keyed without regard
        # to Origin, then replay it for a later, legitimate allowed origin
        # (which needs the real CORS headers to let its browser read the
        # response at all).
        headers = [(b"content-length", b"0"), _VARY_ORIGIN]
        if allowed_origin:
            headers.extend(self._response_headers(allowed_origin))
            headers.append((b"access-control-allow-methods", _CORS_ALLOWED_METHODS.encode("latin-1")))
            headers.append((b"access-control-allow-headers", _CORS_ALLOWED_HEADERS.encode("latin-1")))
            headers.append((b"access-control-max-age", _CORS_MAX_AGE.encode("latin-1")))
        # A disallowed origin still gets a plain 200 with no CORS *allow*
        # headers — exactly what a same-origin/non-browser OPTIONS request
        # would see — rather than an error that would confirm to a probing
        # browser that /mcp exists and rejected it specifically.
        await send({"type": "http.response.start", "status": 200, "headers": headers})
        await send({"type": "http.response.body", "body": b""})


def _close_request_connections():
    """Close every DB connection the current (per-request) thread opened."""
    connections.close_all()


class _RequestState:
    """Whether the ``/mcp`` request that started this work has ended."""

    __slots__ = ("finished",)

    def __init__(self):
        self.finished = False


# Bound by MCPRequestThreadMiddleware for the life of one request. Work the
# MCP SDK dispatches for that request copies the context, so it sees the
# same object, including after the request has ended.
_request_state: contextvars.ContextVar = contextvars.ContextVar(
    "mcp_request_state", default=None
)


def _run_and_close_connections(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    finally:
        connections.close_all()


def request_sync_to_async(fn):
    """Run sync ``fn`` off the event loop for the in-flight ``/mcp`` request.

    Every MCP sync call (auth, throttle, maintenance check, tool) goes
    through this rather than ``sync_to_async`` directly (#2586). While the
    request is in progress it is exactly
    ``sync_to_async(fn, thread_sensitive=True)``, so the request's calls
    share its own thread and that thread's connection, which
    :class:`MCPRequestThreadMiddleware` closes when the request ends.

    The MCP SDK can still run part of a request's work after the request
    has ended (it finishes dispatched work in its own task group). Such a
    call has no request thread left to use, so it runs on the default
    executor and closes its own connections when it returns, the way
    Channels' ``database_sync_to_async`` does. Routing it to the request's
    context instead would start an executor that nothing shuts down.

    With no request bound (a tool called directly, as in tests) it is plain
    ``sync_to_async(fn, thread_sensitive=True)``.
    """
    @functools.wraps(fn)
    async def call(*args, **kwargs):
        state = _request_state.get()
        if state is None or not state.finished:
            return await sync_to_async(fn, thread_sensitive=True)(*args, **kwargs)
        return await sync_to_async(_run_and_close_connections, thread_sensitive=False)(
            fn, *args, **kwargs
        )
    return call


class MCPRequestThreadMiddleware:
    """Run one ``/mcp`` request's sync work on an executor of its own (#2586).

    Django's ``ASGIHandler`` wraps every HTTP request in
    ``asgiref.sync.ThreadSensitiveContext``, so the request's
    ``sync_to_async(thread_sensitive=True)`` calls share one thread that
    belongs to that request alone. ``/mcp`` is routed in front of that
    handler (see ``McpPathRouter``), so it does the same here, consistent
    with other HTTP requests. The auth, throttle and tool calls of one
    request share one thread, so a transaction and its connection stay
    together.

    Concurrency: the thread is created on the request's first sync call and
    shut down when the request ends, so there is at most one per in-flight
    ``/mcp`` request. That is the model Django applies to every other HTTP
    request: the thread count follows the number of in-flight requests.
    Failed authentication attempts per IP are limited by #1679, authenticated
    request rates by the per-token throttles (#1177) and heavy analytics work
    by the #2428 gate. With ``DATABASE_POOL`` on, database connections are
    capped by the pool's ``max_size`` (#1958); a thread waiting on a full
    pool still holds its thread until the pool's timeout.

    Connection cleanup: Django closes a request's connections from its
    ``request_finished`` signal. The thread here is discarded when the
    request ends, so any connection it opened is closed on that thread
    before it goes, whatever ``CONN_MAX_AGE`` is. When the sync work ran on
    some other thread instead (an outer ``async_to_sync`` caller, as in the
    test suite, or an enclosing context that owns the executor), that
    thread's owner manages its connections and nothing is closed here.

    Work after the request: the request is marked finished before its
    connections are closed, so a call made through
    :func:`request_sync_to_async` either was queued on this thread before
    the close (and the close follows it) or sees the mark and closes its own
    connections on another thread.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        async with ThreadSensitiveContext() as request_context:
            state = _RequestState()
            state_token = _request_state.set(state)
            try:
                await self.app(scope, receive, send)
            finally:
                # Set before the close below is queued; see the class docstring.
                state.finished = True
                try:
                    # Only this context's own executor is cleaned up. The dict
                    # is asgiref's map from a ThreadSensitiveContext to the
                    # executor it created; no entry means no thread of ours
                    # ran sync work.
                    if SyncToAsync.context_to_thread_executor.get(request_context) is not None:
                        await self._close_connections()
                finally:
                    _request_state.reset(state_token)

    @staticmethod
    async def _close_connections():
        # Shielded so a second cancellation cannot drop the close: the call
        # is queued on this context's executor, whose shutdown on context
        # exit waits for it. Plain sync_to_async, not request_sync_to_async:
        # the request is already marked finished, and this close must run on
        # the request's own thread. A failure is logged rather than raised so it
        # never replaces the request's own exception.
        try:
            await asyncio.shield(
                sync_to_async(_close_request_connections, thread_sensitive=True)()
            )
        except Exception:
            logger.exception("Closing MCP request database connections failed")


class _LazySessionManagerApp:
    """Start the MCP session manager on first request, then delegate.

    ``StreamableHTTPSessionManager.run()`` is an async context manager that
    must stay open for the life of the app — ``handle_request`` raises "Task
    group is not initialized" otherwise. The SDK expects it to be driven from a
    Starlette ``lifespan``, but Daphne/Channels deliver no lifespan event to an
    app mounted inside ``ProtocolTypeRouter``, so there is no startup hook to
    hang it on. Starting it lazily on the first ``/mcp`` request is the
    workaround.

    The ``asyncio.Lock`` is required, not defensive: two concurrent first
    requests would otherwise both observe "not started" and both call
    ``run()``, and the SDK raises if ``run()`` is called twice on one instance.

    The manager is rebuilt rather than merely restarted when it is no longer
    usable, because ``run()`` may only be called once per instance. Two things
    make it unusable: the supervising task died (an unexpected failure would
    otherwise wedge every later request on this worker), or the running event
    loop is not the one it was started on — a task is bound to its loop, so a
    manager started on a previous loop cannot serve the current request.
    """

    def __init__(self, app_factory):
        self._app_factory = app_factory
        self._lock = asyncio.Lock()
        self._app = None
        self._task = None
        self._ready = None
        self._loop = None

    def _is_usable(self):
        if self._task is None or self._task.done():
            return False
        return self._loop is asyncio.get_running_loop()

    async def _ensure_started(self):
        if self._is_usable():
            return
        async with self._lock:
            # Re-check inside the lock: another task may have started it while
            # this one waited.
            if self._is_usable():
                return

            if self._task is not None and not self._task.done():
                # Superseded by a new loop — stop the old supervisor so its
                # session manager does not linger.
                self._task.cancel()

            import anyio

            app, session_manager = self._app_factory()
            ready = asyncio.Event()

            async def _run():
                try:
                    async with session_manager.run():
                        ready.set()
                        await anyio.sleep_forever()
                except asyncio.CancelledError:
                    raise
                except Exception:
                    # Unblock any waiter rather than hanging the request
                    # forever; the failure surfaces as a normal 500 below, and
                    # the next request rebuilds via the done-task check above.
                    logger.exception("MCP session manager terminated unexpectedly")
                    ready.set()

            self._app = app
            # An empty context, not a copy of this request's: the supervisor
            # outlives the request, so it must not carry the request's
            # ThreadSensitiveContext (#2586) or its caller identity.
            self._task = asyncio.get_running_loop().create_task(
                _run(), context=contextvars.Context()
            )
            self._ready = ready
            self._loop = asyncio.get_running_loop()
        await self._ready.wait()

    async def __call__(self, scope, receive, send):
        await self._ensure_started()
        await self._app(scope, receive, send)


def build_mcp_asgi_app():
    """Return the MCP ASGI app wrapped in CORS handling and Bearer authentication.

    The SDK and auth imports are deliberately function-local: an install with
    MCP_SERVER_ENABLED off must not pay the cost of importing the MCP SDK on
    every process start.

    ``MCPCorsMiddleware`` wraps ``BearerAuthMiddleware`` from the outside —
    see its own docstring for why the order cannot be reversed (a preflight
    carries no Authorization header, so authentication must not run first).
    ``MCPRequestThreadMiddleware`` is outermost so the auth, throttle and
    tool work of one request all run inside its executor context (#2586).
    """
    from .auth import BearerAuthMiddleware
    from .server import _build_transport_security, build_mcp_server

    def _factory():
        mcp = build_mcp_server()
        # Stateless: every request is self-contained, with no server-side
        # session to pin a client to one process. Visiban ships a Helm chart
        # and runs multiple Daphne workers, so a stateful session created on
        # one pod would 404 on the next request routed elsewhere unless the
        # operator configured sticky sessions. Stateless avoids that entirely.
        # (mcp 2.x moved these from the constructor to streamable_http_app().)
        app = mcp.streamable_http_app(
            stateless_http=True,
            streamable_http_path="/",
            transport_security=_build_transport_security(),
        )
        return app, mcp.session_manager

    return MCPRequestThreadMiddleware(
        MCPCorsMiddleware(BearerAuthMiddleware(_LazySessionManagerApp(_factory)))
    )


class McpPathRouter:
    """Dispatch ``/mcp`` requests to the MCP app, everything else to Django.

    A path-prefix dispatcher rather than a change to ``ProtocolTypeRouter``'s
    shape: the ``"http"`` value is simply wrapped, so the ``"websocket"``
    branch and its enterprise extension point are untouched.
    """

    def __init__(self, django_app, mcp_app, base_path=MCP_BASE_PATH):
        self.django_app = django_app
        self.mcp_app = mcp_app
        self.base_path = base_path

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        if path == self.base_path or path.startswith(self.base_path + "/"):
            # Re-root the path so the mounted MCP app sees "/" as its own base,
            # independent of where it is mounted.
            sub_scope = dict(scope)
            sub_scope["root_path"] = scope.get("root_path", "") + self.base_path
            sub_scope["path"] = path[len(self.base_path):] or "/"
            await self.mcp_app(sub_scope, receive, send)
            return
        await self.django_app(scope, receive, send)


def mount_mcp_server(django_http_app):
    """Wrap *django_http_app* so ``/mcp`` reaches the MCP server.

    Returns the Django app unchanged when ``MCP_SERVER_ENABLED`` is off, so a
    deployment that has not opted in exposes no new transport at all and pays
    no import cost for the SDK.
    """
    if not getattr(settings, "MCP_SERVER_ENABLED", False):
        return django_http_app
    return McpPathRouter(django_http_app, build_mcp_asgi_app())
