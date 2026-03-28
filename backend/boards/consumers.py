import asyncio
import json
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from .models import Board
from .permissions import get_board_role

# How often (in seconds) the server sends a keepalive ping to each client.
# NATs and reverse proxies commonly drop idle WebSocket connections after
# 60–120 s of silence; 30 s keeps connections alive through most of them.
PING_INTERVAL = 30


class BoardConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.board_id = self.scope["url_route"]["kwargs"]["board_id"]
        self.room = f"board_{self.board_id}"
        self._ping_task = None
        user = self.scope["user"]

        if not user.is_authenticated:
            await self.close(code=4001)
            return

        if not await self._has_access(user, self.board_id):
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
        """Send a keepalive ping every PING_INTERVAL seconds.

        The message is a regular JSON text frame so the frontend can use it
        to reset its own inactivity timer without special protocol-level
        handling.  If the connection drops mid-send, the resulting exception
        is swallowed — disconnect() will clean up the task.
        """
        try:
            while True:
                await asyncio.sleep(PING_INTERVAL)
                await self.send(text_data=json.dumps({"event": "ping"}))
        except asyncio.CancelledError:
            pass

    async def receive(self, text_data):
        pass  # server-push only

    async def board_event(self, event):
        payload = event["payload"]
        # If this user was just removed from the board, close their WebSocket
        # connection immediately so they stop receiving board events.  The
        # membership deletion has already committed by the time this handler
        # runs (broadcast_board_event is always called via transaction.on_commit).
        if (
            payload.get("event") == "member.removed"
            and payload.get("data", {}).get("user_id") == self.scope["user"].id
        ):
            await self.close()
            return
        await self.send(text_data=json.dumps(payload))

    @database_sync_to_async
    def _has_access(self, user, board_id):
        try:
            board = Board.objects.get(pk=board_id)
        except Board.DoesNotExist:
            return False
        return get_board_role(user, board) is not None
