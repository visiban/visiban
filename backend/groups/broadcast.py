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

# Group payload fields whose value depends on who is asking (#1692). A frame
# goes to every subscriber of the group channel, but the payload was built for
# the acting user (or for no viewer at all), so these are dropped from every
# group event rather than sent with someone else's answer. Clients read them
# over REST. Top-level keys only, like ``ADMIN_ONLY_BOARD_FIELDS``.
VIEWER_SPECIFIC_GROUP_FIELDS = frozenset({"can_place_boards"})


def without_viewer_specific_group_fields(payload):
    """Return *payload* without the top-level keys in ``VIEWER_SPECIFIC_GROUP_FIELDS``.

    Applied once, in ``broadcast_group_event``, so every group event (created,
    updated, ownership transfer, board defaults, Django admin transfer) is
    covered without each call site having to remember it. Keys are dropped,
    not nulled, so a client merging the frame keeps the value it read over
    REST. A non-dict payload is returned unchanged.
    """
    if not isinstance(payload, dict) or VIEWER_SPECIFIC_GROUP_FIELDS.isdisjoint(payload):
        return payload
    return {k: v for k, v in payload.items() if k not in VIEWER_SPECIFIC_GROUP_FIELDS}


def broadcast_group_event(
    group_id: int, event_type: str, payload: dict, *, actor_id: int | None = None
) -> None:
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

    ``actor_id`` is the acting user (#1705), carried on the channel-layer
    message beside the envelope, never on the wire. ``GroupConsumer`` sends the
    actor's per-user fields (``boards.permissions.ACTOR_SCOPED_FIELDS``) to the
    actor only; without it they are omitted for every subscriber.
    """
    channel_layer = get_channel_layer()
    if channel_layer is None:
        return
    # DRF serializer.data may contain datetime/Decimal objects that msgpack cannot
    # serialize. Round-trip through JSONRenderer to get plain Python types.
    # Drops admin-only board fields at the top level of the payload only; nested
    # values pass through unchanged (see ADMIN_ONLY_BOARD_FIELDS). Per-viewer
    # group fields are dropped the same way (VIEWER_SPECIFIC_GROUP_FIELDS).
    safe_payload = json.loads(JSONRenderer().render(
        without_viewer_specific_group_fields(without_admin_only_board_fields(payload))
    ))
    message = {"type": "group_event", "payload": {"event": event_type, "data": safe_payload}}
    if actor_id is not None:
        message["actor_id"] = actor_id
    try:
        async_to_sync(channel_layer.group_send)(f"group_{group_id}", message)
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


def broadcast_member_removed(group_id: int, user_id: int, descendant_ids=(), *, actor_id: int | None = None) -> None:
    """Publish ``member.removed`` for a group membership removal (#1051, #2168).

    Call post-commit (``transaction.on_commit``). The frame always goes to
    ``group_{group_id}``, the group the membership was in. It also goes to the
    channel of each group in ``descendant_ids`` (the removed group's subtree,
    snapshotted before the delete) where the user no longer has access: a
    subgroup's members panel lists members inherited from its ancestors, so
    a subgroup page open in another session must refetch too (#2168).

    A descendant where the user keeps access (a direct membership there or on
    the path to it, a membership on an ancestor of the removed group, or a
    site role) gets no frame: the user is still listed there, and
    ``GroupConsumer`` closes the removed user's socket on any ``member.removed``
    that names them, which would evict a user who still belongs. The access
    rule is ``group_access_resolver``, the bulk form of the predicate the REST
    group routes and ``GroupConsumer`` use, so the three cannot disagree.

    Cost is constant in the size of the subtree: one query for the user, one
    for the descendant groups with their ancestor chain, one for the user's
    memberships. Best-effort like ``broadcast_group_event`` (#1462): a failed
    lookup is logged and swallowed, since the transaction has already
    committed; the subgroup page converges on its next refetch.
    """
    payload = {"user_id": user_id}
    broadcast_group_event(group_id, EVT_MEMBER_REMOVED, payload, actor_id=actor_id)
    descendant_ids = set(descendant_ids) - {group_id}
    if not descendant_ids:
        return
    from accounts.models import User

    from .models import _GROUP_TRAVERSAL_MAX_DEPTH, Group, group_access_resolver

    try:
        user = User.objects.filter(pk=user_id).first()
        groups = Group.objects.filter(pk__in=descendant_ids).select_related(
            "__".join(["parent"] * _GROUP_TRAVERSAL_MAX_DEPTH)
        )
        if user is None:
            # Deleted meanwhile: no access anywhere.
            targets = sorted(g.pk for g in groups)
        else:
            has_access = group_access_resolver(user)
            targets = sorted(g.pk for g in groups if not has_access(g))
    except Exception as exc:  # noqa: BLE001 — best-effort, see docstring
        logger.warning(
            "group member.removed subtree fan-out dropped: group_id=%s error=%s",
            group_id,
            type(exc).__name__,
        )
        return
    for gid in targets:
        broadcast_group_event(gid, EVT_MEMBER_REMOVED, payload, actor_id=actor_id)
