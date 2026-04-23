import json

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from rest_framework.renderers import JSONRenderer


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
