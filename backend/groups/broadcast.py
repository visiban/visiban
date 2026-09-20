import json

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from rest_framework.renderers import JSONRenderer

from boards.broadcast import (
    EVT_BOARD_CREATED,
    EVT_BOARD_DELETED,
    EVT_BOARD_STAR_CHANGED,
    EVT_BOARD_UPDATED,
    EVT_MEMBER_ADDED,
    EVT_MEMBER_REMOVED,
    EVT_MEMBER_UPDATED,
    EVT_PING,
)

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

EVT_INVITE_LINK_REVOKED = "invite_link.revoked"

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
    """
    channel_layer = get_channel_layer()
    if channel_layer is None:
        return
    # DRF serializer.data may contain datetime/Decimal objects that msgpack cannot
    # serialize. Round-trip through JSONRenderer to get plain Python types.
    safe_payload = json.loads(JSONRenderer().render(payload))
    async_to_sync(channel_layer.group_send)(
        f"group_{group_id}",
        {
            "type": "group_event",
            "payload": {"event": event_type, "data": safe_payload},
        },
    )
