"""Unit tests for GroupConsumer (#753).

Covers auth gating (unauthenticated → 4001, non-member → 4003, member → accept)
and event forwarding. Patterned after ``boards/tests/test_consumer_ping.py``.
"""
import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

from django.test import TestCase

from groups.consumers import GroupConsumer


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
            "user": MagicMock(is_authenticated=authenticated, id=42),
        }
        return consumer

    def test_unauthenticated_closed_with_4001(self):
        consumer = self._make_consumer(authenticated=False)
        asyncio.run(consumer.connect())
        consumer.close.assert_called_once_with(code=4001)
        consumer.accept.assert_not_called()

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

    def test_disconnect_cancels_ping_task(self):
        consumer = self._make_consumer()

        async def run():
            with patch.object(consumer, "_has_access", return_value=True):
                await consumer.connect()
            assert consumer._ping_task is not None
            await consumer.disconnect(1000)
            assert consumer._ping_task is None

        asyncio.run(run())
