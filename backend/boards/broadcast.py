import json

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.db import transaction
from rest_framework.renderers import JSONRenderer


def _json_safe(payload: dict) -> dict:
    """Return *payload* with only plain JSON types.

    DRF serializer.data may contain datetime/Decimal objects that msgpack (the
    channel layer codec) and JSONField (the feed column) both refuse. Round-trip
    through JSONRenderer to get plain Python types.
    """
    return json.loads(JSONRenderer().render(payload))


def broadcast_board_event(board_id: int, event_type: str, payload: dict, *, event_id: int | None = None) -> None:
    """Broadcast a board mutation event to all connected WebSocket clients.

    ``event_id`` is the id of the ``BoardEvent`` row this frame publishes (#1114).
    It is **additive**: the frozen ``{event, data}`` envelope is unchanged, and
    the key is omitted entirely — rather than sent as null — when the caller
    broadcast without persisting, so no client has to distinguish "no feed row"
    from "feed row zero". A client that keeps the latest ``event_id`` it saw can
    hand it to ``GET /boards/<id>/events/?after=`` after a reconnect and replay
    exactly what it missed.
    """
    channel_layer = get_channel_layer()
    if channel_layer is None:
        return
    safe_payload = _json_safe(payload)
    # Use "event"/"data" keys to avoid collision with any serializer field
    # named "type". The outer "type" key is the Django Channels routing key
    # and is distinct from the event schema sent to WebSocket clients.
    envelope = {"event": event_type, "data": safe_payload}
    if event_id is not None:
        envelope["event_id"] = event_id
    async_to_sync(channel_layer.group_send)(
        f"board_{board_id}",
        {
            "type": "board_event",
            "payload": envelope,
        },
    )


def persist_board_event(
    board_id: int, event_type: str, payload: dict, *, actor_id: int | None = None
) -> int:
    """Append one row to the board change feed and return its id (#1114).

    Call this **inside** the ``transaction.atomic()`` block that performs the
    mutation, so the feed row and the mutation commit or roll back together. A
    call made outside a transaction is still correct, just not atomic with
    anything.

    Most callers want :func:`record_board_event` instead. This lower-level form
    exists for the handful of sites that fan one mutation out to both the board
    channel and a group channel from a *single* ``on_commit`` callback (#753) —
    they need the id to put in the frame, but must keep registering their own
    callback so both channels still observe the change atomically.

    ``models`` is imported lazily because ``boards.models`` is imported by almost
    everything; a module-level import here would make this module — which
    ``consumers.py`` and the admin both reach for early — drag the model graph in
    with it.
    """
    from .models import BoardEvent

    return BoardEvent.objects.create(
        board_id=board_id,
        event=event_type,
        data=_json_safe(payload),
        actor_id=actor_id,
    ).pk


def record_board_event(
    board_id: int, event_type: str, payload: dict, *, actor_id: int | None = None
) -> int:
    """Persist a board event, then publish it once the transaction commits.

    The single replacement for the
    ``transaction.on_commit(lambda: broadcast_board_event(...))`` idiom. Both
    guarantees the feed needs come from the transaction rather than from extra
    bookkeeping: a rolled-back mutation writes no row *and* never broadcasts,
    because the INSERT rolls back with it and ``on_commit`` does not fire.

    The deferred publish goes through the module-global ``broadcast_board_event``
    name on purpose. The test suite patches
    ``boards.broadcast.broadcast_board_event`` at this module to suppress the
    channel layer, and a global lookup resolves through the module dict at call
    time, so the patch is still honored. Calling a private send helper directly
    would slip past every one of those patches. The cost is that the payload is
    JSON-rendered twice (once for the column, once for the frame); that is small
    beside the INSERT and buys a single publish path.
    """
    event_id = persist_board_event(board_id, event_type, payload, actor_id=actor_id)
    transaction.on_commit(
        lambda: broadcast_board_event(board_id, event_type, payload, event_id=event_id)
    )
    return event_id
