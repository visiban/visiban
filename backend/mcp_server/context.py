"""Request-scoped carrier for the MCP caller's authenticated user and scopes.

MCP tools are plain functions with no request argument, so the authenticated
user has to reach them out of band. A :class:`contextvars.ContextVar` is the
correct carrier under an async server: it is task-scoped, so concurrent
requests on the same event loop never observe each other's value, and
``asgiref.sync.sync_to_async`` propagates the active context into the worker
thread, so ORM code called from a tool still sees it.

The vars are set by :mod:`mcp_server.auth` before the MCP app is invoked and
cleared in a ``finally`` on the way out, so a value can never leak from one
request into the next on a reused task.

Isolation between concurrent requests relies on the MCP SDK dispatching a tool
call within the calling task's context rather than re-parenting it into an
unrelated one. That holds for the pinned SDK and anyio versions, but it is
their behavior rather than a documented contract, so a bump of either should
be checked here — ``ConcurrentIdentityTests`` in the test suite drives two
users simultaneously and is what would catch a regression.
"""
from contextvars import ContextVar

# No default: reading before the auth middleware has run must raise LookupError
# rather than silently yielding None and letting a tool run unauthenticated.
_current_user: ContextVar = ContextVar("mcp_current_user")

# The scopes the presented PAT carries (a frozenset of scope strings), e.g.
# frozenset({"mcp:read"}) or frozenset({"mcp:read", "mcp:write"}). The
# transport already enforces mcp:read on every request (#1110); this carrier
# exists so a write tool's registration in server.py can additionally require
# mcp:write WITHOUT re-authenticating or re-querying the PAT (#512) — the
# scopes were already loaded resolving the token, so this is a zero-query
# check. Same no-default-raises-LookupError posture as `_current_user`.
_current_scopes: ContextVar = ContextVar("mcp_current_scopes")


def set_current_user(user):
    """Bind *user* to the current context; returns a token for :func:`reset`."""
    return _current_user.set(user)


def reset_current_user(token):
    """Restore the previous value bound by :func:`set_current_user`."""
    _current_user.reset(token)


def get_current_user():
    """Return the authenticated user for the in-flight MCP request.

    Raises :class:`RuntimeError` if no user is bound. That is a fail-closed
    guard, not a convenience: it means a tool was reached without passing
    through the Bearer auth middleware, and returning ``None`` there would let
    the tool query as "no user" instead of refusing.
    """
    try:
        return _current_user.get()
    except LookupError:
        raise RuntimeError(
            "No authenticated MCP user bound to this context. An MCP tool was "
            "invoked without passing through the Bearer authentication "
            "middleware."
        )


def set_current_scopes(scopes):
    """Bind *scopes* (a frozenset of scope strings) to the current context."""
    return _current_scopes.set(scopes)


def reset_current_scopes(token):
    """Restore the previous value bound by :func:`set_current_scopes`."""
    _current_scopes.reset(token)


def get_current_scopes():
    """Return the presented PAT's scopes for the in-flight MCP request.

    Raises :class:`RuntimeError` if unbound, mirroring :func:`get_current_user`
    — reachable only if a tool runs outside the Bearer auth middleware, which
    must never happen.
    """
    try:
        return _current_scopes.get()
    except LookupError:
        raise RuntimeError(
            "No MCP scope set bound to this context. An MCP tool was invoked "
            "without passing through the Bearer authentication middleware."
        )
