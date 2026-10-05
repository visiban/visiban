import asyncio
import json
import time

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer

from accounts.models import User

from .broadcast import EVT_MEMBER_REMOVED, EVT_PING
from .models import get_accessible_group_ids

# Mirror BoardConsumer.PING_INTERVAL; NATs and reverse proxies commonly drop idle
# WebSocket connections after 60–120s of silence, so 30s keeps them warm.
PING_INTERVAL = 30

# Upper bound, in seconds, on how long a socket can keep receiving group frames
# after its user loses access to the group, when the member.removed frame that
# would normally evict it at once is lost (#1477). Same value and the same
# reasoning as boards.consumers.ACCESS_RECHECK_SECONDS: the publish is
# best-effort since #1462, so eviction cannot rest on that one frame, and a
# per-frame access query would multiply DB load by the subscriber count.
# get_accessible_group_ids walks the group tree (a few queries), which makes
# caching it matter more here, not less.
ACCESS_RECHECK_SECONDS = 5

# Indirection so tests can drive the re-check clock without patching
# time.monotonic globally (the asyncio event loop reads it too).
_now = time.monotonic


class GroupConsumer(AsyncWebsocketConsumer):
    """Per-group WebSocket channel used by the boards-list view on GroupDetail.

    Auth uses ``get_accessible_group_ids`` so the WS visibility rule stays in lock-step
    with the REST ``/api/v1/groups/<id>/boards/`` view — tightening that rule later
    automatically tightens this consumer too. The mid-connection re-check (#1477)
    uses the same predicate, so the handshake and the re-check cannot disagree.
    """

    # Monotonic time of the last successful access check. None means "never
    # verified" and forces a re-check on the next frame: fail closed rather
    # than trust a consumer that somehow skipped connect()'s check.
    _access_verified_at = None

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
        self._access_verified_at = _now()

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
        #
        # This is the fast path only: that frame is published best-effort and
        # can be lost (#1462), so every frame is also gated on an access
        # re-check below (#1477).
        if (
            payload.get("event") == EVT_MEMBER_REMOVED
            and payload.get("data", {}).get("user_id") == self.scope["user"].id
        ):
            await self.close()
            return
        if not await self._verify_access():
            # Lost access with no member.removed frame to say so. 4003, the
            # code connect() uses for the same condition, so the client stops
            # rather than reconnecting into a 4003 anyway.
            await self.close(code=4003)
            return
        await self.send(text_data=json.dumps(payload))

    async def _verify_access(self):
        """True if the subscriber may still receive this group's frames (#1477).

        Answered from the cache while the last successful check is younger
        than ACCESS_RECHECK_SECONDS; otherwise re-evaluated with the predicate
        connect() used. A failed check is never cached: the caller closes the
        socket.
        """
        verified_at = self._access_verified_at
        if verified_at is not None and _now() - verified_at < ACCESS_RECHECK_SECONDS:
            return True
        if not await self._refresh_access():
            return False
        self._access_verified_at = _now()
        return True

    @database_sync_to_async
    def _has_access(self, user, group_id):
        return group_id in get_accessible_group_ids(user)

    @database_sync_to_async
    def _refresh_access(self):
        """Re-evaluate access mid-connection against a fresh User row (#1477).

        ``scope["user"]`` is the instance loaded at handshake time, so its
        ``can_access_all_content`` (which grants every group) would be as stale
        as the access decision this method exists to replace. A deactivated
        account has no access, matching the auth middleware, which refuses an
        inactive user at the handshake.
        """
        user = User.objects.filter(pk=self.scope["user"].id, is_active=True).first()
        if user is None:
            return False
        return self.group_id in get_accessible_group_ids(user)
