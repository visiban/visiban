"""Unit tests for GroupConsumer (#753).

Covers auth gating (unauthenticated → 4001, non-member → 4003, member → accept)
and event forwarding. Patterned after ``boards/tests/test_consumer_ping.py``.
"""
import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

from django.test import TestCase

from accounts.ws_auth import WS_CREDENTIAL_SCOPE_KEY

from groups.consumers import GroupConsumer, _now


_CREDENTIAL = {"kind": "session", "ref": "unit-test-session", "auth_hash": "unit-test-hash"}

class GroupConsumerAuthTests(TestCase):
    def _make_consumer(self, *, authenticated=True):
        consumer = GroupConsumer()
        consumer.channel_name = "test-channel"
        consumer.channel_layer = AsyncMock()
        consumer.send = AsyncMock()
        consumer.close = AsyncMock()
        consumer.accept = AsyncMock()
        consumer.scope = {
            "url_route": {"kwargs": {"group_id": 1}},
            "user": MagicMock(is_authenticated=authenticated, id=42, must_change_password=False, must_change_username=False),
            # What the auth middleware records on an authenticated handshake
            # (#1483); connect() refuses a scope without it.
            WS_CREDENTIAL_SCOPE_KEY: _CREDENTIAL,
        }
        # A just-connected socket: connect() stamps this after its access
        # check, so the #1477 per-frame re-check is served from the cache.
        consumer._access_verified_at = _now()
        return consumer

    def test_unauthenticated_closed_with_4001(self):
        consumer = self._make_consumer(authenticated=False)
        asyncio.run(consumer.connect())
        consumer.close.assert_called_once_with(code=4001)
        consumer.accept.assert_not_called()

    def test_connect_without_a_recorded_credential_closes_with_4001(self):
        """An authenticated scope with no recorded credential is never admitted (#1483)."""
        consumer = self._make_consumer()
        del consumer.scope[WS_CREDENTIAL_SCOPE_KEY]

        async def run():
            with patch.object(consumer, "_has_access", return_value=True) as has_access:
                await consumer.connect()
            consumer.close.assert_called_once_with(code=4001)
            consumer.accept.assert_not_called()
            has_access.assert_not_called()

        asyncio.run(run())

    def _run_one_ping(self, consumer):
        """Run the ping loop for exactly one iteration (the second sleep cancels it)."""
        sleeps = 0

        async def fake_sleep(seconds):
            nonlocal sleeps
            sleeps += 1
            if sleeps > 1:
                raise asyncio.CancelledError()

        async def run():
            with patch("groups.consumers.asyncio.sleep", side_effect=fake_sleep):
                try:
                    await consumer._ping_loop()
                except asyncio.CancelledError:
                    pass

        asyncio.run(run())

    def test_ping_closes_with_4003_on_a_definitive_denial(self):
        """A quiet socket is still re-checked: a ping whose check denies closes it (#1483)."""
        consumer = self._make_consumer()
        consumer._access_verified_at = None  # window lapsed: the ping re-checks
        consumer._refresh_access = AsyncMock(return_value=False)

        self._run_one_ping(consumer)
        consumer._refresh_access.assert_awaited_once()
        consumer.close.assert_called_once_with(code=4003)
        consumer.send.assert_not_called()

    def test_ping_survives_a_failing_check_and_retries_next_ping(self):
        """An error during the keepalive check (e.g. a DB blip) does not close the
        socket: it is logged by class name, the ping is sent, the window is not
        stamped, so the next ping re-checks (#1483)."""
        from django.db import OperationalError

        consumer = self._make_consumer()
        consumer.group_id = 1  # normally set by connect(); the log line names it
        consumer._access_verified_at = None
        consumer._refresh_access = AsyncMock(side_effect=OperationalError("db host secret-detail"))

        with self.assertLogs("groups.consumers", level="WARNING") as logs:
            self._run_one_ping(consumer)
        consumer.close.assert_not_called()
        consumer.send.assert_called_once_with(text_data=json.dumps({"event": "ping", "data": {}}))
        output = "\n".join(logs.output)
        self.assertIn("re-check failed during keepalive", output)
        self.assertIn("OperationalError", output)
        self.assertNotIn("secret-detail", output)
        self.assertIsNone(consumer._access_verified_at)

        # Next ping: the DB is back, access is confirmed, the window is stamped.
        consumer._refresh_access = AsyncMock(return_value=True)
        consumer.send.reset_mock()
        self._run_one_ping(consumer)
        consumer._refresh_access.assert_awaited_once()
        consumer.close.assert_not_called()
        consumer.send.assert_called_once()
        self.assertIsNotNone(consumer._access_verified_at)

    def test_non_member_closed_with_4003(self):
        consumer = self._make_consumer()

        async def run():
            with patch.object(consumer, "_has_access", return_value=False):
                await consumer.connect()
            consumer.close.assert_called_once_with(code=4003)
            consumer.accept.assert_not_called()

        asyncio.run(run())

    def test_member_accepted_and_joins_room(self):
        consumer = self._make_consumer()

        async def run():
            with patch.object(consumer, "_has_access", return_value=True):
                await consumer.connect()
            consumer.accept.assert_called_once()
            consumer.channel_layer.group_add.assert_awaited_once_with(
                "group_1", "test-channel"
            )
            # Stop the ping task so the event loop exits cleanly.
            if consumer._ping_task is not None:
                consumer._ping_task.cancel()
                try:
                    await consumer._ping_task
                except asyncio.CancelledError:
                    pass

        asyncio.run(run())

    def test_group_event_forwards_payload(self):
        consumer = self._make_consumer()
        payload = {"event": "board.created", "data": {"id": 7}}

        async def run():
            await consumer.group_event({"payload": payload})
            consumer.send.assert_called_once_with(text_data=json.dumps(payload))

        asyncio.run(run())

    def test_group_event_member_removed_closes_connection(self):
        """group_event() should close the socket when the current user is removed (#1329)."""
        consumer = self._make_consumer()
        consumer.scope["user"].id = 42

        payload = {"event": "member.removed", "data": {"user_id": 42}}

        async def run():
            await consumer.group_event({"payload": payload})
            consumer.close.assert_called_once()
            consumer.send.assert_not_called()

        asyncio.run(run())

    def test_group_event_member_removed_other_user_not_closed(self):
        """group_event() should NOT close when a *different* user is removed (#1329)."""
        consumer = self._make_consumer()
        consumer.scope["user"].id = 42

        payload = {"event": "member.removed", "data": {"user_id": 7}}

        async def run():
            await consumer.group_event({"payload": payload})
            consumer.close.assert_not_called()
            consumer.send.assert_called_once_with(text_data=json.dumps(payload))

        asyncio.run(run())

    def test_disconnect_cancels_ping_task(self):
        consumer = self._make_consumer()

        async def run():
            with patch.object(consumer, "_has_access", return_value=True):
                await consumer.connect()
            assert consumer._ping_task is not None
            await consumer.disconnect(1000)
            assert consumer._ping_task is None

        asyncio.run(run())
