import asyncio
import json
import logging
import secrets
import time
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from accounts.models import User

from .broadcast import EVT_MEMBER_REMOVED, EVT_PING
from .models import Board
from .permissions import (
    GROUP_ANCESTOR_SELECT_RELATED,
    MODERATOR_BEARING_EVENTS,
    get_board_role,
    moderator_field_visible,
    site_admin_field_visible,
)

# How often (in seconds) the server sends a keepalive ping to each client.
# NATs and reverse proxies commonly drop idle WebSocket connections after
# 60–120 s of silence; 30 s keeps connections alive through most of them.
PING_INTERVAL = 30

# Base length, in seconds, of the window in which a socket can keep receiving
# board frames after its user loses access to the board, when the member.removed
# frame that would normally evict it at once is lost (#1477). Each socket adds
# its own jitter (ACCESS_RECHECK_JITTER_SECONDS below), so the bound is about 7 s.
#
# Why a re-check at all: eviction used to rest on one fire-and-forget frame.
# The publish is best-effort since #1462 (a channel-layer error is logged and
# swallowed), so a dropped member.removed left the socket open, streaming card
# titles and descriptions to a user who no longer has access. Access is now
# re-verified from the database before a frame is forwarded, which makes the
# member.removed frame a fast path rather than the only path.
#
# Why cached rather than per frame: a busy board fans every write out to every
# subscriber, so one access query per forwarded frame would multiply DB load by
# the subscriber count. With the cache each socket pays at most one re-check
# per window, and only while frames are flowing (an idle socket costs nothing,
# and also receives nothing to leak). 5 s (plus up to 2 s of jitter, below) is
# short next to the time it takes a human to act on a removal and well under
# PING_INTERVAL, while still collapsing a burst of frames (a bulk move, an
# import) into one query.
ACCESS_RECHECK_SECONDS = 5

# Random extra seconds, uniform in [0, ACCESS_RECHECK_JITTER_SECONDS], added to
# each socket's window and redrawn on every successful check. Why: every socket
# on a board connects at about the same time (a page load, a reconnect after a
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

# `is_moderator` visibility on member.* broadcast payloads is decided per
# subscriber by moderator_field_visible() (boards.permissions): admin/site_admin
# subscribers see it on every row; everyone else sees it only on the row that
# is their OWN membership, and it is stripped on every other row (#920/#1173/
# #1191). Broadcasts are fan-out without per-subscriber filtering, so this
# consumer applies the gate itself rather than relying on the REST-response
# stripping in BoardMembershipSerializer.to_representation, which cannot know
# the recipient's role at send time.
#
# The subscriber's role (`self._role`) is resolved at connect() and refreshed
# from the DB on any member.added/member.updated frame whose subject is the
# subscriber (#1332), so a demotion or promotion applies from that frame on.
# Role changes that emit no board-channel member.* frame (group-membership role
# changes, board move-group, can_access_all_content toggles) apply at the next
# access re-check — on the first frame after the socket's re-check window
# (ACCESS_RECHECK_SECONDS plus jitter, at most about 7 s) has lapsed (#1477) —
# rather than only on reconnect.
#
# moderator_field_visible() is defined in boards.permissions since #1114 so
# this consumer, the change-feed reader (BoardEventSerializer), and the two
# REST serializers (BoardFullSerializer.get_members, BoardMembershipSerializer)
# all call the same function rather than each restating the rule.


class BoardConsumer(AsyncWebsocketConsumer):
    # Monotonic time of the last successful access check. None means "never
    # verified" and forces a re-check on the next frame: fail closed rather
    # than trust a consumer that somehow skipped connect()'s check.
    _access_verified_at = None
    # This socket's current window: ACCESS_RECHECK_SECONDS plus its own jitter,
    # redrawn on each successful check.
    _access_window = ACCESS_RECHECK_SECONDS

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
        # This is the fast path only: if the frame is lost, the access re-check
        # below evicts the socket on a later frame instead (#1477).
        if (
            payload.get("event") == EVT_MEMBER_REMOVED
            and payload.get("data", {}).get("user_id") == self.scope["user"].id
        ):
            await self.close()
            return
        data = payload.get("data") or {}
        moderator_bearing = payload.get("event") in MODERATOR_BEARING_EVENTS
        subject_user_id = None
        if moderator_bearing:
            # `user` shape is whatever the writer stored — never assume a dict
            # (a malformed payload must fail closed, not raise).
            subject = data.get("user")
            subject_user_id = subject.get("id") if isinstance(subject, dict) else None
        # Re-verify access before forwarding anything (#1477). The
        # member.removed self-close above is only the fast path: that frame is
        # published best-effort and can be lost (#1462), and a socket must not
        # go on forwarding board data to a user who has lost access. The check
        # is served from a short cache (see ACCESS_RECHECK_SECONDS and
        # ACCESS_RECHECK_JITTER_SECONDS).
        #
        # A member.added/member.updated frame about THIS subscriber forces the
        # check past the cache: their own board role may just have changed
        # (#1332), and without a refresh a board admin demoted to viewer keeps
        # the admin-only `is_moderator` / `is_site_admin` columns (and a
        # promoted viewer stays under-exposed — the inverse of #1191). Forcing
        # it means this very frame is filtered by the new role.
        #
        # Why re-resolve from the DB rather than trust `data["role"]`: the
        # payload carries only the *explicit* membership role, while the
        # effective role also depends on ownership, group inheritance and
        # can_access_all_content (get_board_role's ladder). Trusting the
        # payload would e.g. demote a site_admin who also happens to hold a
        # viewer row. The lookup's query count is small but not fixed: it
        # depends on which rung of the ladder decides (all-content and
        # ownership need no membership query; a group-inherited role also reads
        # the user's group memberships), with the group-ancestor chain
        # pre-joined in _lookup_role so the count does not grow with nesting
        # depth.
        is_self_subject = subject_user_id is not None and subject_user_id == self.scope["user"].id
        if not await self._verify_access(force=is_self_subject):
            # No effective access any more: a removal whose member.removed
            # frame was lost, or one that committed after this frame was
            # queued — or the check itself failed (see _verify_access). Close
            # with 4003, the code connect() uses for the same
            # condition, so the client stops rather than reconnecting into a
            # 4003 anyway.
            self._role = None
            await self.close(code=4003)
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
        if moderator_bearing:
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

    async def _verify_access(self, *, force=False):
        """True if the subscriber may still receive this board's frames (#1477).

        Answered from the cache while the last successful check is younger
        than this socket's window (ACCESS_RECHECK_SECONDS plus jitter);
        otherwise, or when *force*, re-resolved through _refresh_role, which
        runs the same get_board_role ladder that connect() used, so the
        handshake and the re-check cannot disagree about who has access. A
        successful check also refreshes ``self._role`` and draws a new
        window. A failed one is never cached: the caller closes the socket.

        A check that raises (a DB outage, say) counts as failed. Why fail
        closed: forwarding would send board data on an unverified grant, and
        letting the exception escape tears the consumer down with an abnormal
        close that the client answers with a reconnect loop against the same
        outage. Returning False makes the caller close with 4003, so the
        client stops; a reload reconnects once the DB is back. 1011 would let
        the client retry by itself, but it would retry every 3 s for as long
        as the outage lasts, and the handshake would fail the same way.
        """
        verified_at = self._access_verified_at
        if not force and verified_at is not None and _now() - verified_at < self._access_window:
            return True
        try:
            role = await self._refresh_role()
        except Exception as exc:  # noqa: BLE001 — fail closed on any check failure, see docstring
            # Class name only: the message can carry DB connection details.
            logger.warning(
                "board access re-check failed: board_id=%s error=%s",
                self.board_id,
                type(exc).__name__,
            )
            return False
        if role is None:
            return False
        self._role = role
        self._access_verified_at = _now()
        self._access_window = ACCESS_RECHECK_SECONDS + _jitter()
        return True

    @database_sync_to_async
    def _resolve_role(self, user, board_id):
        return _lookup_role(user, board_id)

    @database_sync_to_async
    def _refresh_role(self):
        """Re-resolve the subscriber's effective role mid-connection (#1332, #1477).

        Re-reads the User row as well as the board: ``scope["user"]`` is the
        instance loaded at handshake time, so its ``can_access_all_content``
        (the top rung of get_board_role's ladder) would be just as stale as
        the cached role this method exists to replace. A deactivated account
        resolves to no access, matching the auth middleware, which refuses an
        inactive user at the handshake.
        """
        user = User.objects.filter(pk=self.scope["user"].id, is_active=True).first()
        if user is None:
            return None
        return _lookup_role(user, self.board_id)


def _lookup_role(user, board_id):
    """Effective role of *user* on board *board_id*, or None (sync; ORM).

    The group-ancestor chain is joined up front because get_board_role walks
    it in Python: without the select_related, a role inherited from a nested
    group costs one lazy ``.parent`` fetch per level, and this now runs on
    every self-subject member frame, not only at connect() (#1332).
    """
    try:
        board = Board.objects.select_related(GROUP_ANCESTOR_SELECT_RELATED).get(pk=board_id)
    except Board.DoesNotExist:
        return None
    return get_board_role(user, board)
