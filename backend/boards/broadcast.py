import json

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from rest_framework.renderers import JSONRenderer


def broadcast_board_event(board_id: int, event_type: str, payload: dict) -> None:
    """Broadcast a board mutation event to all connected WebSocket clients."""
    channel_layer = get_channel_layer()
    if channel_layer is None:
        return
    # DRF serializer.data may contain datetime/Decimal objects that msgpack
    # cannot serialize. Round-trip through JSONRenderer to get plain Python types.
    safe_payload = json.loads(JSONRenderer().render(payload))
    async_to_sync(channel_layer.group_send)(
        f"board_{board_id}",
        {
            "type": "board_event",
            "payload": {"type": event_type, **safe_payload},
        },
    )
