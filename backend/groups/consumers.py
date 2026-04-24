import asyncio
import json

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer

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
                await self.send(text_data=json.dumps({"event": "ping", "data": {}}))
        except asyncio.CancelledError:
            raise

    async def receive(self, text_data):
        pass  # server-push only

    async def group_event(self, event):
        await self.send(text_data=json.dumps(event["payload"]))

    @database_sync_to_async
    def _has_access(self, user, group_id):
        return group_id in get_accessible_group_ids(user)
