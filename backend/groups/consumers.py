import asyncio
import json
import logging
import secrets
import time

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer

from accounts.models import User

from .broadcast import EVT_MEMBER_REMOVED, EVT_PING
from .models import get_accessible_group_ids

# Mirror BoardConsumer.PING_INTERVAL; NATs and reverse proxies commonly drop idle
# WebSocket connections after 60–120s of silence, so 30s keeps them warm.
PING_INTERVAL = 30

# Base length, in seconds, of the window in which a socket can keep receiving
# group frames after its user loses access to the group, when the member.removed
# frame that would normally evict it at once is lost (#1477). Each socket adds
# its own jitter (ACCESS_RECHECK_JITTER_SECONDS below), so the bound is about
# 7 s. Same values and the same reasoning as boards.consumers.ACCESS_RECHECK_SECONDS: the publish is
# best-effort since #1462, so eviction cannot rest on that one frame, and a
# per-frame access query would multiply DB load by the subscriber count.
# get_accessible_group_ids walks the group tree (a few queries), which makes
# caching it matter more here, not less.
ACCESS_RECHECK_SECONDS = 5

# Random extra seconds, uniform in [0, ACCESS_RECHECK_JITTER_SECONDS], added to
# each socket's window and redrawn on every successful check. Why: every socket
# on a group page connects at about the same time (a page load, a reconnect after a
# deploy) and is then re-checked on the same fan-out frames, so with one fixed
# window they would all expire together and send a herd of N access queries
# at once, queued on channels' single thread-sensitive DB executor. Spreading
# the expiries keeps that load flat. The cost is a longer worst case: a socket
# can forward frames for at most ACCESS_RECHECK_SECONDS +
# ACCESS_RECHECK_JITTER_SECONDS (about 7 s) after its last successful check.
ACCESS_RECHECK_JITTER_SECONDS = 2

# SystemRandom (from secrets), not the random module, so bandit has nothing to
# flag. This is load spreading, not a security value.
_rng = secrets.SystemRandom()


def _jitter():
    """Extra seconds for one socket's re-check window. A hook tests can pin."""
    return _rng.uniform(0, ACCESS_RECHECK_JITTER_SECONDS)

# Indirection so tests can drive the re-check clock without patching
# time.monotonic globally (the asyncio event loop reads it too).
_now = time.monotonic

logger = logging.getLogger(__name__)


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
    # This socket's current window: ACCESS_RECHECK_SECONDS plus its own jitter,
    # redrawn on each successful check.
    _access_window = ACCESS_RECHECK_SECONDS

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
        self._access_window = ACCESS_RECHECK_SECONDS + _jitter()

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
            # Lost access with no member.removed frame to say so, or the
            # check itself failed (see _verify_access). 4003, the
            # code connect() uses for the same condition, so the client stops
            # rather than reconnecting into a 4003 anyway.
            await self.close(code=4003)
            return
        await self.send(text_data=json.dumps(payload))

    async def _verify_access(self):
        """True if the subscriber may still receive this group's frames (#1477).

        Answered from the cache while the last successful check is younger
        than this socket's window (ACCESS_RECHECK_SECONDS plus jitter);
        otherwise re-evaluated with the predicate connect() used. A failed
        check is never cached: the caller closes the socket.

        A check that raises (a DB outage, say) counts as failed, closing with
        4003 rather than letting the exception tear the consumer down into a
        client reconnect loop — same reasoning as
        ``BoardConsumer._verify_access``.
        """
        verified_at = self._access_verified_at
        if verified_at is not None and _now() - verified_at < self._access_window:
            return True
        try:
            has_access = await self._refresh_access()
        except Exception as exc:  # noqa: BLE001 — fail closed on any check failure, see docstring
            # Class name only: the message can carry DB connection details.
            logger.warning(
                "group access re-check failed: group_id=%s error=%s",
                self.group_id,
                type(exc).__name__,
            )
            return False
        if not has_access:
            return False
        self._access_verified_at = _now()
        self._access_window = ACCESS_RECHECK_SECONDS + _jitter()
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
