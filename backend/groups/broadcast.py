import json
import logging

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from rest_framework.renderers import JSONRenderer

from boards.broadcast import (
    EVT_BOARD_CREATED,
    EVT_BOARD_DELETED,
    EVT_BOARD_STAR_CHANGED,
    EVT_BOARD_UPDATED,
    EVT_INVITE_LINK_CREATED,
    EVT_INVITE_LINK_REVOKED,
    EVT_MEMBER_ADDED,
    EVT_MEMBER_REMOVED,
    EVT_MEMBER_UPDATED,
    EVT_PING,
    without_admin_only_board_fields,
)

logger = logging.getLogger(__name__)

# ─── Group-channel event registry (#1078) ────────────────────────────────────
#
# Same contract and same rules as ``boards.broadcast``'s board-channel registry
# — see the long comment there. This is a *separate* registry because the two
# channels have different subscribers and different permission scopes, so
# "documented on the group channel" is not "documented" for a board-channel
# name and vice versa. The overlapping names (board.*, member.*, ping) are
# imported from the board registry rather than re-spelled, so the two channels
# can never drift to two different strings for what clients see as one name.
EVT_GROUP_CREATED = "group.created"
EVT_GROUP_UPDATED = "group.updated"
EVT_GROUP_DELETED = "group.deleted"
EVT_GROUP_STAR_CHANGED = "group.star_changed"

EVT_GROUP_LABEL_CREATED = "group.label.created"
EVT_GROUP_LABEL_UPDATED = "group.label.updated"
EVT_GROUP_LABEL_DELETED = "group.label.deleted"

# invite_link.created / invite_link.revoked are imported from the board
# registry above: the board channel carries them too since #1444.

GROUP_CHANNEL_EVENTS: frozenset[str] = frozenset({
    EVT_BOARD_CREATED,
    EVT_BOARD_UPDATED,
    EVT_BOARD_DELETED,
    EVT_BOARD_STAR_CHANGED,
    EVT_GROUP_CREATED,
    EVT_GROUP_UPDATED,
    EVT_GROUP_DELETED,
    EVT_GROUP_STAR_CHANGED,
    EVT_GROUP_LABEL_CREATED,
    EVT_GROUP_LABEL_UPDATED,
    EVT_GROUP_LABEL_DELETED,
    EVT_INVITE_LINK_CREATED,
    EVT_INVITE_LINK_REVOKED,
    EVT_MEMBER_ADDED,
    EVT_MEMBER_UPDATED,
    EVT_MEMBER_REMOVED,
    EVT_PING,
})

DEPRECATED_GROUP_EVENTS: dict[str, str] = {}

INTENTIONALLY_UNHANDLED_GROUP_EVENTS: dict[str, str] = {}


def broadcast_group_event(group_id: int, event_type: str, payload: dict) -> None:
    """Broadcast a group-scoped event (board.created / board.updated / board.deleted) to
    WebSocket clients subscribed to ``group_{group_id}``.

    Mirrors the ``{event, data}`` envelope used by ``broadcast_board_event`` so the
    frontend can reuse the same dispatch shape. Separate helper from the per-board
    broadcaster because the two channels have different subscribers and permission
    scopes: per-board events are scoped to board members; group events are scoped to
    group members and cover the boards-list view.

    Best-effort, like ``broadcast_board_event`` (#1462): it runs post-commit, so
    a channel-layer (Valkey) outage is logged — group id, event type and
    exception class only at WARNING, the traceback at DEBUG (lower the logger's
    level to see it) — and swallowed rather than turning a saved change into a
    500. A dropped *data* frame is recovered when the group page re-fetches
    the group's boards list on reconnect. A lost ``member.removed`` does not
    leave a removed member's socket open either: ``GroupConsumer`` re-checks
    access before it forwards any frame and closes the socket when access is
    gone (#1477), so the frame is a fast path for eviction, not the only path.
    A lost frame delays the close by at most the re-check window
    (``ACCESS_RECHECK_SECONDS`` plus jitter, about 7 s) after the socket's
    last successful check.
    The ``except Exception`` is
    deliberately broad for the same reason as the board helper. It is not a
    "never raises" guarantee: payload serialization runs outside the ``try``, so
    an unserializable payload (a code bug) still raises.
    """
    channel_layer = get_channel_layer()
    if channel_layer is None:
        return
    # DRF serializer.data may contain datetime/Decimal objects that msgpack cannot
    # serialize. Round-trip through JSONRenderer to get plain Python types.
    # Drops admin-only board fields at the top level of the payload only; nested
    # values pass through unchanged (see ADMIN_ONLY_BOARD_FIELDS).
    safe_payload = json.loads(JSONRenderer().render(without_admin_only_board_fields(payload)))
    try:
        async_to_sync(channel_layer.group_send)(
            f"group_{group_id}",
            {
                "type": "group_event",
                "payload": {"event": event_type, "data": safe_payload},
            },
        )
    except Exception as exc:  # noqa: BLE001 — best-effort publish, see docstring
        logger.warning(
            "group broadcast dropped: group_id=%s event=%s error=%s",
            group_id,
            event_type,
            type(exc).__name__,
        )
        logger.debug(
            "group broadcast failure traceback: group_id=%s event=%s",
            group_id,
            event_type,
            exc_info=True,
        )
