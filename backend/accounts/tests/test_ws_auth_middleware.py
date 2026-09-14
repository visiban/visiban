"""Tests for TicketAuthMiddleware and its placement in the ASGI stack (#1109).

The existing consumer tests (boards/tests/test_consumer_ping.py,
groups/tests/test_group_consumer.py) hand-construct ``scope["user"]`` and never
run the middleware, so none of them can catch a middleware-ordering regression.
These tests cover that gap directly.
"""
import asyncio

from channels.auth import AuthMiddleware
from django.contrib.auth.models import AnonymousUser
from django.core.cache import cache
from django.test import TestCase, TransactionTestCase, override_settings

from accounts.models import User
from accounts.ws_auth import TicketAuthMiddleware, issue_ws_ticket


class _CapturingApp:
    """Minimal inner ASGI app that records the scope it was handed."""

    def __init__(self):
        self.scope = None

    async def __call__(self, scope, receive, send):
        self.scope = scope
        return None


def _run_middleware(query_string: bytes, initial_user=None):
    """Drive TicketAuthMiddleware once and return the scope the inner app saw."""
    inner = _CapturingApp()
    middleware = TicketAuthMiddleware(inner)
    scope = {"type": "websocket", "query_string": query_string}
    if initial_user is not None:
        scope["user"] = initial_user
    asyncio.run(middleware(scope, None, None))
    return inner.scope


class TicketAuthMiddlewareTests(TransactionTestCase):
    """Exercise the middleware against a real user row.

    TransactionTestCase, not TestCase: the middleware resolves the user through
    ``database_sync_to_async``, which runs the query on a worker thread. That
    thread cannot see the uncommitted transaction a TestCase holds open, and on
    SQLite it fails outright with "database table is locked". Committed data is
    visible to every thread.

    No explicit ``connections.close_all()`` is needed here (cf. CLAUDE.md
    § Backend test conventions) because ``channels.db.database_sync_to_async``
    already calls ``close_old_connections()`` in a ``finally`` around every call,
    so the worker thread never leaves a connection open.
    """

    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(username="wsuser", password="pass")

    def test_valid_ticket_sets_the_scope_user(self):
        ticket, _ = issue_ws_ticket(self.user)
        scope = _run_middleware(f"ticket={ticket}".encode())
        self.assertEqual(scope["user"].id, self.user.id)
        self.assertTrue(scope["user"].is_authenticated)

    def test_valid_ticket_overrides_an_anonymous_session_user(self):
        """A token client has no session, so the stack hands us AnonymousUser."""
        ticket, _ = issue_ws_ticket(self.user)
        scope = _run_middleware(
            f"ticket={ticket}".encode(), initial_user=AnonymousUser()
        )
        self.assertEqual(scope["user"].id, self.user.id)

    def test_ticket_is_consumed_so_a_replay_is_rejected(self):
        ticket, _ = issue_ws_ticket(self.user)
        first = _run_middleware(f"ticket={ticket}".encode())
        self.assertEqual(first["user"].id, self.user.id)

        replayed = _run_middleware(
            f"ticket={ticket}".encode(), initial_user=AnonymousUser()
        )
        self.assertFalse(replayed["user"].is_authenticated)

    def test_tampered_ticket_yields_anonymous(self):
        ticket, _ = issue_ws_ticket(self.user)
        scope = _run_middleware(f"ticket={ticket}x".encode())
        self.assertFalse(scope["user"].is_authenticated)

    def test_invalid_ticket_does_not_fall_back_to_the_session_user(self):
        """Fail closed: a presented-but-bad credential must not downgrade.

        Otherwise a browser holding a valid session could pass a junk ticket and
        still connect, contradicting "reused/expired/tampered ticket -> 4001".
        """
        scope = _run_middleware(b"ticket=forged", initial_user=self.user)
        self.assertFalse(scope["user"].is_authenticated)

    def test_no_ticket_leaves_the_scope_user_untouched(self):
        """The SPA's cookie handshake must behave exactly as it did before."""
        scope = _run_middleware(b"", initial_user=self.user)
        self.assertIs(scope["user"], self.user)

    def test_unrelated_query_params_are_ignored(self):
        scope = _run_middleware(b"foo=bar&baz=1", initial_user=self.user)
        self.assertIs(scope["user"], self.user)

    def test_empty_ticket_param_is_treated_as_absent(self):
        scope = _run_middleware(b"ticket=", initial_user=self.user)
        self.assertIs(scope["user"], self.user)

    def test_undecodable_query_string_is_ignored(self):
        scope = _run_middleware(b"\xff\xfe", initial_user=self.user)
        self.assertIs(scope["user"], self.user)

    def test_ticket_for_a_deactivated_user_is_rejected(self):
        """A ticket must not outlive the access it stands for."""
        ticket, _ = issue_ws_ticket(self.user)
        self.user.is_active = False
        self.user.save(update_fields=["is_active"])
        scope = _run_middleware(f"ticket={ticket}".encode())
        self.assertFalse(scope["user"].is_authenticated)

    def test_ticket_for_a_deleted_user_is_rejected(self):
        ticket, _ = issue_ws_ticket(self.user)
        self.user.delete()
        scope = _run_middleware(f"ticket={ticket}".encode())
        self.assertFalse(scope["user"].is_authenticated)


class ASGIStackOrderingTests(TestCase):
    """TicketAuthMiddleware must nest INSIDE AuthMiddlewareStack.

    channels.auth.AuthMiddleware.resolve_scope() does an unconditional
    ``scope["user"]._wrapped = await get_user(scope)``. If TicketAuthMiddleware
    wrapped the stack from the outside it would run first and be overwritten by
    the session lookup on every connection — for a token client that means
    AnonymousUser and a 4001, i.e. the exact bug #1109 fixes. Nesting is load
    bearing, not stylistic, so pin it here.
    """

    def _websocket_middleware_chain(self):
        from visiban import asgi

        app = asgi.application.application_mapping["websocket"]
        chain = []
        while hasattr(app, "inner"):
            chain.append(type(app))
            app = app.inner
        chain.append(type(app))
        return chain

    def test_ticket_middleware_is_present_in_the_websocket_stack(self):
        self.assertIn(TicketAuthMiddleware, self._websocket_middleware_chain())

    def test_ticket_middleware_runs_after_django_auth_middleware(self):
        chain = self._websocket_middleware_chain()
        self.assertIn(AuthMiddleware, chain)
        self.assertLess(
            chain.index(AuthMiddleware),
            chain.index(TicketAuthMiddleware),
            "TicketAuthMiddleware must be nested inside AuthMiddlewareStack so "
            "the session lookup cannot overwrite a ticket-resolved user.",
        )

    def test_http_protocol_still_mounts_the_mcp_server(self):
        """#1109 is WebSocket-only — it must not disturb the HTTP branch.

        Asserting merely that an "http" key exists is too weak to be worth
        having: it stays true even if the MCP mount (#511) is dropped. A branch
        cut before #511 merged and rebased carelessly would silently revert that
        feature, and nothing else in the suite pins the wiring — mcp_server's own
        tests build an McpPathRouter directly rather than going through
        visiban.asgi. So reload the module with the flag on and check the real
        composed type.
        """
        import importlib

        from mcp_server.asgi_mount import McpPathRouter
        from visiban import asgi

        with override_settings(MCP_SERVER_ENABLED=True):
            importlib.reload(asgi)
            try:
                http_app = asgi.application.application_mapping["http"]
                self.assertIsInstance(
                    http_app,
                    McpPathRouter,
                    "visiban.asgi must keep wrapping the HTTP app with "
                    "mount_mcp_server() — see #511.",
                )
            finally:
                # Restore the module-level `application` other tests import.
                importlib.reload(asgi)

    def test_websocket_stack_survives_a_reload(self):
        """The ticket wiring must not depend on import order or reload state."""
        self.assertIn(TicketAuthMiddleware, self._websocket_middleware_chain())
