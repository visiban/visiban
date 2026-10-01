import asyncio
import json

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer

from .broadcast import EVT_MEMBER_REMOVED, EVT_PING
from .models import get_accessible_group_ids

# Mirror BoardConsumer.PING_INTERVAL; NATs and reverse proxies commonly drop idle
# WebSocket connections after 60–120s of silence, so 30s keeps them warm.
PING_INTERVAL = 30


class GroupConsumer(AsyncWebsocketConsumer):
    """Per-group WebSocket channel used by the boards-list view on GroupDetail.

    Auth uses ``get_accessible_group_ids`` so the WS visibility rule stays in lock-step
    with the REST ``/api/v1/groups/<id>/boards/`` view — tightening that rule later
    automatically tightens this consumer too.
    """

    async def connect(self):
        self.group_id = int(self.scope["url_route"]["kwargs"]["group_id"])
        self.room = f"group_{self.group_id}"
        self._ping_task = None
        user = self.scope["user"]

        if not user.is_authenticated:
            await self.close(code=4001)
            return

        if not await self._has_access(user, self.group_id):
            await self.close(code=4003)
            return

        await self.channel_layer.group_add(self.room, self.channel_name)
        await self.accept()
        self._ping_task = asyncio.ensure_future(self._ping_loop())

    async def disconnect(self, close_code):
        if self._ping_task is not None:
            self._ping_task.cancel()
            self._ping_task = None
        await self.channel_layer.group_discard(self.room, self.channel_name)

    async def _ping_loop(self):
        try:
            while True:
                await asyncio.sleep(PING_INTERVAL)
                await self.send(text_data=json.dumps({"event": EVT_PING, "data": {}}))
        except asyncio.CancelledError:
            raise

    async def receive(self, text_data):
        pass  # server-push only

    async def group_event(self, event):
        payload = event["payload"]
        # If this user was just removed from the group, close their WebSocket
        # connection immediately so they stop receiving group events (#1329).
        # Mirrors BoardConsumer.board_event()'s self-eviction check — without
        # it, a removed member keeps a live socket to group_{id} and goes on
        # receiving group.updated, board.*, group.label.*, and member.* events
        # for a group they no longer belong to. The membership deletion has
        # already committed by the time this handler runs (broadcast_group_event
        # is always called via transaction.on_commit).
        if (
            payload.get("event") == EVT_MEMBER_REMOVED
            and payload.get("data", {}).get("user_id") == self.scope["user"].id
        ):
            await self.close()
            return
        await self.send(text_data=json.dumps(payload))

    @database_sync_to_async
    def _has_access(self, user, group_id):
        return group_id in get_accessible_group_ids(user)
