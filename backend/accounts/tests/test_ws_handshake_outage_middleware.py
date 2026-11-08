"""``HandshakeOutageMiddleware`` contract (#2144).

The real-stack cases (session engines, board and group consumers) live in
``test_ws_handshake_outage.py``. These pin the middleware itself against fake
inner applications, and its coverage of consumers registered through the
enterprise extension point (``enterprise_websocket_urlpatterns``), which
``visiban.asgi`` reads at import time.
"""

import asyncio
import importlib
import sys
import types

from channels.generic.websocket import AsyncWebsocketConsumer
from channels.testing import WebsocketCommunicator
from django.db import IntegrityError, OperationalError
from django.test import SimpleTestCase
from django.urls import re_path

from accounts.ws_auth import CLOSE_AUTH_UNAVAILABLE, HandshakeOutageMiddleware


def _run(app, path="/ws/probe/"):
    """Connect to *app*; return (accepted, close_code)."""

    async def run():
        communicator = WebsocketCommunicator(app, path)
        connected, detail = await communicator.connect(timeout=2)
        if connected:
            await communicator.disconnect()
            return True, None
        return False, detail

    return asyncio.run(run())


class MiddlewareContractTests(SimpleTestCase):
    def test_outage_before_the_connect_message_is_read_closes_1011(self):
        """The session lookup raises before any consumer reads the connect."""

        async def inner(scope, receive, send):
            raise OperationalError("db down at secret-host")

        with self.assertLogs("accounts.ws_auth", level="WARNING") as logs:
            self.assertEqual(
                _run(HandshakeOutageMiddleware(inner)), (False, CLOSE_AUTH_UNAVAILABLE)
            )
        self.assertEqual(
            logs.output,
            ["WARNING:accounts.ws_auth:websocket handshake could not complete: error=OperationalError"],
        )

    def test_outage_after_the_connect_message_is_read_closes_1011(self):
        """A consumer's connect() raises after it has consumed the connect;
        the middleware must not wait for a second message."""

        async def inner(scope, receive, send):
            await receive()
            raise ConnectionError("cache down")

        self.assertEqual(_run(HandshakeOutageMiddleware(inner)), (False, 1011))

    def test_redis_errors_are_outages(self):
        from redis.exceptions import ConnectionError as RedisConnectionError
        from redis.exceptions import ReadOnlyError, ResponseError
        from redis.exceptions import TimeoutError as RedisTimeoutError

        for error in (
            RedisConnectionError("x"),
            RedisTimeoutError("x"),
            ReadOnlyError("x"),
            TimeoutError("x"),
        ):
            with self.subTest(error=repr(error)):

                async def inner(scope, receive, send, error=error):
                    raise error

                self.assertEqual(_run(HandshakeOutageMiddleware(inner)), (False, 1011))

        # Any other Redis server reply is outside the bounded set.
        async def other_reply(scope, receive, send):
            raise ResponseError("OOM command not allowed")

        with self.assertRaises(ResponseError):
            _run(HandshakeOutageMiddleware(other_reply))

    def test_a_failing_close_does_not_chain_the_outage_message(self):
        """If the refusal's own send fails, the outage (whose message can
        carry connection details) must not ride along as __context__."""

        async def inner(scope, receive, send):
            await receive()
            raise OperationalError("db down at secret-host")

        async def receive():
            return {"type": "websocket.connect"}

        async def send(message):
            raise RuntimeError("client gone")

        with self.assertLogs("accounts.ws_auth", level="WARNING"):
            with self.assertRaises(RuntimeError) as caught:
                asyncio.run(
                    HandshakeOutageMiddleware(inner)(
                        {"type": "websocket", "path": "/ws/probe/"}, receive, send
                    )
                )
        self.assertIsNone(caught.exception.__context__)
        self.assertIsNone(caught.exception.__cause__)

    def test_never_admits_after_an_outage(self):
        """Fail closed: a caught outage ends in a close; nothing below is
        called again and no accept is sent."""
        calls = []

        async def inner(scope, receive, send):
            calls.append(scope["type"])
            raise OperationalError("db down")

        async def run():
            communicator = WebsocketCommunicator(HandshakeOutageMiddleware(inner), "/ws/probe/")
            await communicator.send_input({"type": "websocket.connect"})
            first = await communicator.receive_output(timeout=2)
            self.assertTrue(await communicator.receive_nothing())
            return first

        self.assertEqual(asyncio.run(run()), {"type": "websocket.close", "code": 1011})
        self.assertEqual(calls, ["websocket"])

    def test_an_error_outside_the_outage_set_still_raises(self):
        """A bug is not disguised as an outage (it keeps its traceback)."""
        for error in (ValueError("bug"), IntegrityError("bug")):
            with self.subTest(error=type(error).__name__):

                async def inner(scope, receive, send, error=error):
                    raise error

                with self.assertRaises(type(error)):
                    _run(HandshakeOutageMiddleware(inner))

    def test_an_outage_after_accept_is_re_raised(self):
        """Once the handshake is answered it is no longer this middleware's to
        refuse; the consumers' own post-accept 1011 path applies (#2003)."""

        async def inner(scope, receive, send):
            await receive()
            await send({"type": "websocket.accept"})
            raise OperationalError("db down")

        async def run():
            communicator = WebsocketCommunicator(HandshakeOutageMiddleware(inner), "/ws/probe/")
            connected, _ = await communicator.connect(timeout=2)
            self.assertTrue(connected)
            with self.assertRaises(OperationalError):
                await communicator.receive_output(timeout=2)

        asyncio.run(run())

    def test_an_outage_after_a_close_is_re_raised(self):
        async def inner(scope, receive, send):
            await receive()
            await send({"type": "websocket.close", "code": 4003})
            raise OperationalError("db down")

        with self.assertRaises(OperationalError):
            asyncio.run(self._collect(HandshakeOutageMiddleware(inner)))

    async def _collect(self, app):
        communicator = WebsocketCommunicator(app, "/ws/probe/")
        await communicator.send_input({"type": "websocket.connect"})
        await communicator.receive_output(timeout=2)
        await communicator.receive_output(timeout=2)

    def test_a_healthy_handshake_passes_through(self):
        async def inner(scope, receive, send):
            await receive()
            await send({"type": "websocket.accept"})
            await receive()

        self.assertEqual(_run(HandshakeOutageMiddleware(inner)), (True, None))

    def test_non_websocket_scopes_are_untouched(self):
        seen = []

        async def inner(scope, receive, send):
            seen.append((scope["type"], receive, send))

        async def receive():
            return {}

        async def send(message):
            pass

        asyncio.run(HandshakeOutageMiddleware(inner)({"type": "lifespan"}, receive, send))
        self.assertEqual(seen, [("lifespan", receive, send)])


class _EnterpriseOutageConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        raise OperationalError("enterprise lookup failed at secret-host")


class EnterpriseConsumerCoverageTests(SimpleTestCase):
    """A consumer registered through ``enterprise_websocket_urlpatterns`` is
    covered with no enterprise change: the middleware sits outside routing.

    ``visiban.asgi`` reads the extension point at import time, so a stand-in
    ``enterprise.routing`` is installed and the module reloaded, then
    restored for every other test (as ``test_ws_auth_middleware`` does for the
    MCP mount)."""

    def test_enterprise_consumer_connect_outage_closes_1011(self):
        from visiban import asgi

        package = types.ModuleType("enterprise")
        routing = types.ModuleType("enterprise.routing")
        routing.enterprise_websocket_urlpatterns = [
            re_path(r"ws/enterprise-probe/$", _EnterpriseOutageConsumer.as_asgi()),
        ]
        package.routing = routing
        saved = {name: sys.modules.get(name) for name in ("enterprise", "enterprise.routing")}
        sys.modules["enterprise"] = package
        sys.modules["enterprise.routing"] = routing
        try:
            importlib.reload(asgi)
            with self.assertLogs("accounts.ws_auth", level="WARNING") as logs:
                result = _run(asgi.application, "/ws/enterprise-probe/")
        finally:
            for name, module in saved.items():
                if module is None:
                    sys.modules.pop(name, None)
                else:  # pragma: no cover — only when the enterprise package is installed
                    sys.modules[name] = module
            importlib.reload(asgi)
        self.assertEqual(result, (False, CLOSE_AUTH_UNAVAILABLE))
        self.assertNotIn("secret-host", "\n".join(logs.output))
