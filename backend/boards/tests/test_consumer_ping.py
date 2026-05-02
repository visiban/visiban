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
            with patch.object(consumer, "_resolve_role", return_value="admin"):
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
                text_data=json.dumps({"event": "ping", "data": {}})
            )

        asyncio.run(run())

    def test_ping_task_canceled_on_disconnect(self):
        """disconnect() should cancel the ping task."""
        consumer = self._make_consumer()

        async def run():
            with patch.object(consumer, "_resolve_role", return_value="admin"):
                await consumer.connect()

            assert consumer._ping_task is not None
            assert not consumer._ping_task.cancelled()

            await consumer.disconnect(1000)

            # Task should be canceled after disconnect.
            assert consumer._ping_task is None

        asyncio.run(run())

    def test_ping_task_not_started_on_auth_failure(self):
        """If connect() rejects auth, no ping task should be started."""
        consumer = self._make_consumer()
        consumer.scope["user"].is_authenticated = False
        consumer._ping_task = None

        async def run():
            await consumer.connect()
            assert consumer._ping_task is None

        asyncio.run(run())

    def test_connect_access_denied_closes_with_4003(self):
        """connect() should close with code 4003 when _resolve_role returns None."""
        consumer = self._make_consumer()

        async def run():
            with patch.object(consumer, "_resolve_role", return_value=None):
                await consumer.connect()
            consumer.close.assert_called_once_with(code=4003)
            assert consumer._ping_task is None

        asyncio.run(run())

    def test_board_event_sends_payload(self):
        """board_event() should forward the payload as JSON text."""
        consumer = self._make_consumer()
        consumer.scope["user"].id = 42
        consumer._role = "admin"

        payload = {"event": "card.moved", "data": {"card_id": 7}}

        async def run():
            await consumer.board_event({"payload": payload})
            consumer.send.assert_called_once_with(
                text_data=json.dumps(payload)
            )

        asyncio.run(run())

    def test_board_event_member_removed_closes_connection(self):
        """board_event() should close the socket when the current user is removed."""
        consumer = self._make_consumer()
        consumer.scope["user"].id = 99
        consumer._role = "viewer"

        payload = {"event": "member.removed", "data": {"user_id": 99}}

        async def run():
            await consumer.board_event({"payload": payload})
            consumer.close.assert_called_once()
            consumer.send.assert_not_called()

        asyncio.run(run())

    def test_board_event_member_removed_other_user_not_closed(self):
        """board_event() should NOT close when a *different* user is removed."""
        consumer = self._make_consumer()
        consumer.scope["user"].id = 1
        consumer._role = "viewer"

        payload = {"event": "member.removed", "data": {"user_id": 2}}

        async def run():
            await consumer.board_event({"payload": payload})
            consumer.close.assert_not_called()
            consumer.send.assert_called_once_with(text_data=json.dumps(payload))

        asyncio.run(run())

    def test_resolve_role_board_not_found_returns_none(self):
        """_resolve_role() should return None when the board does not exist."""
        from unittest.mock import MagicMock
        from boards.consumers import BoardConsumer

        consumer = BoardConsumer()
        user = MagicMock()

        async def run():
            # Use a board_id that cannot exist (negative PK).
            result = await consumer._resolve_role(user, -1)
            assert result is None

        asyncio.run(run())

    def test_board_event_strips_is_moderator_for_viewer(self):
        """is_moderator must be stripped from member.added payloads when subscriber is below admin (#978)."""
        consumer = self._make_consumer()
        consumer.scope["user"].id = 5
        consumer._role = "viewer"

        payload = {
            "event": "member.added",
            "data": {"id": 9, "user": {"id": 7}, "role": "member", "is_moderator": True},
        }

        async def run():
            await consumer.board_event({"payload": payload})
            sent = consumer.send.call_args.kwargs["text_data"]
            decoded = json.loads(sent)
            assert "is_moderator" not in decoded["data"]
            # Other fields preserved unchanged.
            assert decoded["data"]["role"] == "member"
            assert decoded["event"] == "member.added"

        asyncio.run(run())

    def test_board_event_strips_is_moderator_for_member(self):
        """member-role subscribers must not see is_moderator in member.updated either (#978)."""
        consumer = self._make_consumer()
        consumer.scope["user"].id = 5
        consumer._role = "member"

        payload = {
            "event": "member.updated",
            "data": {"id": 9, "user": {"id": 7}, "role": "member", "is_moderator": False},
        }

        async def run():
            await consumer.board_event({"payload": payload})
            decoded = json.loads(consumer.send.call_args.kwargs["text_data"])
            assert "is_moderator" not in decoded["data"]

        asyncio.run(run())

    def test_board_event_keeps_is_moderator_for_admin(self):
        """admin-role subscribers must still receive is_moderator (#978)."""
        consumer = self._make_consumer()
        consumer.scope["user"].id = 5
        consumer._role = "admin"

        payload = {
            "event": "member.added",
            "data": {"id": 9, "user": {"id": 7}, "role": "member", "is_moderator": True},
        }

        async def run():
            await consumer.board_event({"payload": payload})
            decoded = json.loads(consumer.send.call_args.kwargs["text_data"])
            assert decoded["data"]["is_moderator"] is True

        asyncio.run(run())

    def test_board_event_keeps_is_moderator_for_site_admin(self):
        """site_admin subscribers must still receive is_moderator (#978)."""
        consumer = self._make_consumer()
        consumer.scope["user"].id = 5
        consumer._role = "site_admin"

        payload = {
            "event": "member.updated",
            "data": {"id": 9, "user": {"id": 7}, "role": "admin", "is_moderator": True},
        }

        async def run():
            await consumer.board_event({"payload": payload})
            decoded = json.loads(consumer.send.call_args.kwargs["text_data"])
            assert decoded["data"]["is_moderator"] is True

        asyncio.run(run())

    def test_board_event_does_not_filter_non_member_events(self):
        """is_moderator filter must only apply to member.added / member.updated (#978)."""
        consumer = self._make_consumer()
        consumer.scope["user"].id = 5
        consumer._role = "viewer"

        # A card.updated event with an `is_moderator` field somewhere in its
        # data must not be touched — the filter is event-typed.
        payload = {
            "event": "card.updated",
            "data": {"id": 1, "is_moderator": True},  # contrived, but must pass through
        }

        async def run():
            await consumer.board_event({"payload": payload})
            decoded = json.loads(consumer.send.call_args.kwargs["text_data"])
            assert decoded["data"]["is_moderator"] is True

        asyncio.run(run())
