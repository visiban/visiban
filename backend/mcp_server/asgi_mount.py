"""Mount the MCP server into Visiban's existing ASGI application.

Kept out of ``visiban/asgi.py`` on purpose: that file carries two stable
enterprise extension-point contracts (#1009) and should not absorb MCP SDK
churn. All of the SDK-mounting mechanics live here (#511).
"""
import asyncio
import logging

from django.conf import settings

logger = logging.getLogger(__name__)

# Mount path for the Streamable HTTP transport (MCP spec rev 2025-03-26).
# Both this and the SSE backward-compatibility endpoint live under it.
MCP_BASE_PATH = "/mcp"


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
            self._task = asyncio.ensure_future(_run())
            self._ready = ready
            self._loop = asyncio.get_running_loop()
        await self._ready.wait()

    async def __call__(self, scope, receive, send):
        await self._ensure_started()
        await self._app(scope, receive, send)


def build_mcp_asgi_app():
    """Return the MCP ASGI app wrapped in Bearer authentication.

    The SDK and auth imports are deliberately function-local: an install with
    MCP_SERVER_ENABLED off must not pay the cost of importing the MCP SDK on
    every process start.
    """
    from .auth import BearerAuthMiddleware
    from .server import build_mcp_server

    def _factory():
        mcp = build_mcp_server()
        return mcp.streamable_http_app(), mcp.session_manager

    return BearerAuthMiddleware(_LazySessionManagerApp(_factory))


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
