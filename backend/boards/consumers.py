import asyncio
import json
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from .broadcast import EVT_MEMBER_REMOVED, EVT_PING
from .models import Board
from .permissions import (
    MODERATOR_BEARING_EVENTS,
    get_board_role,
    moderator_field_visible,
    site_admin_field_visible,
)

# How often (in seconds) the server sends a keepalive ping to each client.
# NATs and reverse proxies commonly drop idle WebSocket connections after
# 60–120 s of silence; 30 s keeps connections alive through most of them.
PING_INTERVAL = 30

# `is_moderator` visibility on member.* broadcast payloads is decided per
# subscriber by moderator_field_visible() (boards.permissions): admin/site_admin
# subscribers see it on every row; everyone else sees it only on the row that
# is their OWN membership, and it is stripped on every other row (#920/#1173/
# #1191). Broadcasts are fan-out without per-subscriber filtering, so this
# consumer applies the gate itself rather than relying on the REST-response
# stripping in BoardMembershipSerializer.to_representation, which cannot know
# the recipient's role at send time.
#
# moderator_field_visible() is defined in boards.permissions since #1114 so
# this consumer, the change-feed reader (BoardEventSerializer), and the two
# REST serializers (BoardFullSerializer.get_members, BoardMembershipSerializer)
# all call the same function rather than each restating the rule.


class BoardConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.board_id = self.scope["url_route"]["kwargs"]["board_id"]
        self.room = f"board_{self.board_id}"
        self._ping_task = None
        self._role = None
        user = self.scope["user"]

        if not user.is_authenticated:
            await self.close(code=4001)
            return

        role = await self._resolve_role(user, self.board_id)
        if role is None:
            await self.close(code=4003)
            return
        self._role = role

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
                await self.send(text_data=json.dumps({"event": EVT_PING, "data": {}}))
        except asyncio.CancelledError:
            raise

    async def receive(self, text_data):
        pass  # server-push only

    async def board_event(self, event):
        payload = event["payload"]
        # If this user was just removed from the board, close their WebSocket
        # connection immediately so they stop receiving board events.  The
        # membership deletion has already committed by the time this handler
        # runs (broadcast_board_event is always called via transaction.on_commit).
        if (
            payload.get("event") == EVT_MEMBER_REMOVED
            and payload.get("data", {}).get("user_id") == self.scope["user"].id
        ):
            await self.close()
            return
        # Strip `is_moderator` from member.added/member.updated payloads when
        # the subscriber is below admin role (#978).  REST responses already
        # strip the field via BoardMembershipSerializer.to_representation
        # (#920); the broadcast surface needs the same gate here because it
        # has no per-subscriber filter at the serializer layer.
        #
        # A non-admin subscriber still sees the flag on the row that is their
        # OWN membership (#1191, mirroring the /full/ self-row exception from
        # #1173) — everyone else's row stays stripped.
        if payload.get("event") in MODERATOR_BEARING_EVENTS:
            data = payload.get("data") or {}
            # `user` shape is whatever the writer stored — never assume a dict
            # (a malformed payload must fail closed, not raise).
            subject = data.get("user")
            subject_user_id = subject.get("id") if isinstance(subject, dict) else None
            hidden = set()
            if "is_moderator" in data and not moderator_field_visible(
                self._role, self.scope["user"].id, subject_user_id
            ):
                hidden.add("is_moderator")
            # `is_site_admin` drives the admin member-controls lock (#1290);
            # only admin/site_admin subscribers get it, with no self-row case.
            if "is_site_admin" in data and not site_admin_field_visible(self._role):
                hidden.add("is_site_admin")
            if hidden:
                payload = {**payload, "data": {k: v for k, v in data.items() if k not in hidden}}
        await self.send(text_data=json.dumps(payload))

    @database_sync_to_async
    def _resolve_role(self, user, board_id):
        try:
            board = Board.objects.get(pk=board_id)
        except Board.DoesNotExist:
            return None
        return get_board_role(user, board)
