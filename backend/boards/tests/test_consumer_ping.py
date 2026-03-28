"""
Tests for WebSocket keepalive ping (#425).

Verifies that BoardConsumer sends periodic {"event": "ping"} messages and
cleans up the ping task on disconnect.
"""
import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

from django.test import TestCase

from boards.consumers import BoardConsumer, PING_INTERVAL


class BoardConsumerPingTests(TestCase):
    """Unit-level tests for the ping loop — no channel layer needed."""

    def _make_consumer(self):
        """Create a BoardConsumer with enough scaffolding for unit tests."""
        consumer = BoardConsumer()
        consumer.board_id = 1
        consumer.room = "board_1"
        consumer.channel_name = "test-channel"
        consumer.channel_layer = AsyncMock()
        consumer.send = AsyncMock()
        consumer.close = AsyncMock()
        consumer.accept = AsyncMock()
        consumer.scope = {
            "url_route": {"kwargs": {"board_id": 1}},
            "user": MagicMock(is_authenticated=True),
        }
        return consumer

    def test_ping_message_sent_after_interval(self):
        """The ping loop should send {"event": "ping"} after PING_INTERVAL."""
        consumer = self._make_consumer()

        async def run():
            # Patch _has_access to return True so connect() succeeds.
            with patch.object(consumer, "_has_access", return_value=True):
                await consumer.connect()

            # The ping task is now running. Advance the event loop past one
            # sleep cycle by replacing asyncio.sleep with a single-shot stub.
            assert consumer._ping_task is not None

            # Let the event loop run the ping task for one iteration.
            # We use a short real sleep to let the task's first asyncio.sleep
            # yield, then cancel it.
            call_count = 0

            async def fake_sleep(seconds):
                nonlocal call_count
                call_count += 1
                if call_count > 1:
                    # Cancel after first ping so the loop exits cleanly.
                    raise asyncio.CancelledError()
                # Verify the sleep interval is correct.
                assert seconds == PING_INTERVAL
                # Return immediately instead of actually sleeping.
                return

            # Cancel the real ping task and start a new one with the patched sleep.
            consumer._ping_task.cancel()
            try:
                await consumer._ping_task
            except asyncio.CancelledError:
                pass

            with patch("boards.consumers.asyncio.sleep", side_effect=fake_sleep):
                consumer._ping_task = asyncio.ensure_future(consumer._ping_loop())
                try:
                    await consumer._ping_task
                except asyncio.CancelledError:
                    pass

            # Verify at least one ping was sent.
            consumer.send.assert_called_with(
                text_data=json.dumps({"event": "ping"})
            )

        asyncio.get_event_loop().run_until_complete(run())

    def test_ping_task_canceled_on_disconnect(self):
        """disconnect() should cancel the ping task."""
        consumer = self._make_consumer()

        async def run():
            with patch.object(consumer, "_has_access", return_value=True):
                await consumer.connect()

            assert consumer._ping_task is not None
            assert not consumer._ping_task.cancelled()

            await consumer.disconnect(1000)

            # Task should be canceled after disconnect.
            assert consumer._ping_task is None

        asyncio.get_event_loop().run_until_complete(run())

    def test_ping_task_not_started_on_auth_failure(self):
        """If connect() rejects auth, no ping task should be started."""
        consumer = self._make_consumer()
        consumer.scope["user"].is_authenticated = False
        consumer._ping_task = None

        async def run():
            await consumer.connect()
            assert consumer._ping_task is None

        asyncio.get_event_loop().run_until_complete(run())
