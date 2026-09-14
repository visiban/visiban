"""Request-scoped carrier for the MCP caller's authenticated user.

MCP tools are plain functions with no request argument, so the authenticated
user has to reach them out of band. A :class:`contextvars.ContextVar` is the
correct carrier under an async server: it is task-scoped, so concurrent
requests on the same event loop never observe each other's value, and
``asgiref.sync.sync_to_async`` propagates the active context into the worker
thread, so ORM code called from a tool still sees it.

The var is set by :mod:`mcp_server.auth` before the MCP app is invoked and
cleared in a ``finally`` on the way out, so a value can never leak from one
request into the next on a reused task.
"""
from contextvars import ContextVar

# No default: reading before the auth middleware has run must raise LookupError
# rather than silently yielding None and letting a tool run unauthenticated.
_current_user: ContextVar = ContextVar("mcp_current_user")


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
