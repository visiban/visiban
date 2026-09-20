import json

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.db import transaction
from rest_framework.renderers import JSONRenderer

# ─── Board-channel event registry (#1078) ────────────────────────────────────
#
# The authoritative list of every event name that may appear in the ``event``
# key of a board-channel frame. Every broadcast call site draws its name from
# one of these constants rather than spelling a literal, so the emitted set is
# a Python object that ``scripts/check-ws-event-reachability.py`` can read —
# not a grep over string literals that silently misses a name assembled at
# runtime.
#
# **These values are the wire format.** ``CLAUDE.md`` declares the
# ``{event, data}`` board_* schema a public 1.0+ contract: a name may be added
# freely, but renaming or removing one is a breaking change requiring a major
# bump. Rename the *constant* as much as you like; never touch the string.
#
# Adding a name here is not enough on its own — the CI gate also requires a row
# in ``docs/api/websockets.md`` and a frontend handler (or an entry in
# ``INTENTIONALLY_UNHANDLED_BOARD_EVENTS`` below giving the reason there is
# none). That three-way match is the whole point: a name that exists in only
# two of the three places is an alert that can never fire.
EVT_BOARD_CREATED = "board.created"
EVT_BOARD_UPDATED = "board.updated"
EVT_BOARD_DELETED = "board.deleted"
EVT_BOARD_STAR_CHANGED = "board.star_changed"

EVT_SAVED_FILTER_CREATED = "saved_filter.created"
EVT_SAVED_FILTER_DELETED = "saved_filter.deleted"

EVT_COLUMN_CREATED = "column.created"
EVT_COLUMN_UPDATED = "column.updated"
EVT_COLUMN_DELETED = "column.deleted"
EVT_COLUMN_REORDERED = "column.reordered"

EVT_SWIMLANE_CREATED = "swimlane.created"
EVT_SWIMLANE_UPDATED = "swimlane.updated"
EVT_SWIMLANE_DELETED = "swimlane.deleted"
EVT_SWIMLANE_REORDERED = "swimlane.reordered"

EVT_LABEL_CREATED = "label.created"
EVT_LABEL_UPDATED = "label.updated"
EVT_LABEL_DELETED = "label.deleted"

EVT_CUSTOM_FIELD_CREATED = "custom_field.created"
EVT_CUSTOM_FIELD_UPDATED = "custom_field.updated"
EVT_CUSTOM_FIELD_DELETED = "custom_field.deleted"
EVT_CUSTOM_FIELD_REORDERED = "custom_field.reordered"

EVT_CARD_CREATED = "card.created"
EVT_CARD_UPDATED = "card.updated"
EVT_CARD_DELETED = "card.deleted"
EVT_CARD_MOVED = "card.moved"
EVT_CARD_ARCHIVED = "card.archived"
# Note the asymmetry: the WebSocket name is ``card.unarchived`` while the
# ``CARD_MUTATION_HOOKS`` lifecycle name for the same operation is
# ``card.restored`` (see boards/hooks.py). Both are independently frozen — the
# WS name by this contract, the hook name by the 1.0+ extension guarantee. They
# are not a typo, and neither may be "corrected" to match the other.
EVT_CARD_UNARCHIVED = "card.unarchived"

EVT_MEMBER_ADDED = "member.added"
EVT_MEMBER_UPDATED = "member.updated"
EVT_MEMBER_REMOVED = "member.removed"

# Emitted from the git_lens app, but onto the *board* channel — so they are
# board-channel contract and belong in this registry rather than a third one.
EVT_LENS_CONNECTION_CONFIGURED = "lens_connection.configured"
EVT_LENS_CONNECTION_REMOVED = "lens_connection.removed"

# Consumer keepalive — sent by BoardConsumer._ping_loop, never through
# broadcast_board_event(), but it is on the wire and clients must ignore it, so
# the contract covers it.
EVT_PING = "ping"

BOARD_CHANNEL_EVENTS: frozenset[str] = frozenset({
    EVT_BOARD_CREATED,
    EVT_BOARD_UPDATED,
    EVT_BOARD_DELETED,
    EVT_BOARD_STAR_CHANGED,
    EVT_SAVED_FILTER_CREATED,
    EVT_SAVED_FILTER_DELETED,
    EVT_COLUMN_CREATED,
    EVT_COLUMN_UPDATED,
    EVT_COLUMN_DELETED,
    EVT_COLUMN_REORDERED,
    EVT_SWIMLANE_CREATED,
    EVT_SWIMLANE_UPDATED,
    EVT_SWIMLANE_DELETED,
    EVT_SWIMLANE_REORDERED,
    EVT_LABEL_CREATED,
    EVT_LABEL_UPDATED,
    EVT_LABEL_DELETED,
    EVT_CUSTOM_FIELD_CREATED,
    EVT_CUSTOM_FIELD_UPDATED,
    EVT_CUSTOM_FIELD_DELETED,
    EVT_CUSTOM_FIELD_REORDERED,
    EVT_CARD_CREATED,
    EVT_CARD_UPDATED,
    EVT_CARD_DELETED,
    EVT_CARD_MOVED,
    EVT_CARD_ARCHIVED,
    EVT_CARD_UNARCHIVED,
    EVT_MEMBER_ADDED,
    EVT_MEMBER_UPDATED,
    EVT_MEMBER_REMOVED,
    EVT_LENS_CONNECTION_CONFIGURED,
    EVT_LENS_CONNECTION_REMOVED,
    EVT_PING,
})

# Names still documented (and still accepted by clients) but no longer emitted.
# Maps the wire name to the release it was deprecated in. Removing an entry
# here without also removing its docs row fails the reachability gate — which is
# the point: the docs row is the deprecation notice the contract requires to
# stand for at least one minor release before the name goes.
DEPRECATED_BOARD_EVENTS: dict[str, str] = {}

# Emitted names with deliberately no frontend handler. The reason string is not
# decoration: without it the gate cannot tell a considered omission from a
# forgotten one, which is the exact failure this whole job exists to catch.
INTENTIONALLY_UNHANDLED_BOARD_EVENTS: dict[str, str] = {
    EVT_BOARD_CREATED: (
        "Board-channel board.created can only reach a client already subscribed "
        "to that board's channel, and no client can be subscribed to a board "
        "that did not exist a moment ago. It is broadcast for symmetry with the "
        "group channel (where it does drive the boards list) and to put the row "
        "in the change feed; BoardView has nothing to do with it."
    ),
}


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
