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


def broadcast_member_removed(
    group_id: int, user_id: int, descendant_ids=(), *, actor_id: int | None = None,
    removed_role: str | None = None,
) -> None:
    """Publish ``member.removed`` for a group membership removal (#1051, #2168, #2175).

    Call post-commit (``transaction.on_commit``). The frame always goes to
    ``group_{group_id}``, the group the membership was in. It also goes to the
    channel of each group in ``descendant_ids`` (the removed group's subtree,
    snapshotted before the delete) that no longer lists the user: a
    subgroup's members panel lists members inherited from its ancestors, so
    a subgroup page open in another session must refetch too (#2168).

    Which descendants get it follows the members panel's listing rule
    (``GroupViewSet.members``), not the access rule: the user is listed on a
    group through a membership of their own on it, or an inherited one (a
    stored role within ``GroupMembership.Role``) on one of its ancestors,
    capped at ``_GROUP_TRAVERSAL_MAX_DEPTH``. A descendant that still lists
    the user (a membership on it or on the path to it, or on an ancestor of
    the removed group) gets no frame: ``GroupConsumer`` closes the removed
    user's socket on any ``member.removed`` that names them, which would
    evict a user who still belongs. ``can_access_all_content`` is not
    consulted: it grants access but not a row in the panel, so a site-wide
    user's inherited row would otherwise stay on the subgroup page, and the
    removed group's own channel already sends them this frame (#1051).

    A descendant that keeps listing the user only through an inherited row
    from an ancestor *above* the removed group (#2175) gets ``member.updated``
    instead, carrying that row as the members endpoint lists it (``id: null``,
    ``is_inherited: true``, ``inherited_from`` the source group's name, its
    role and ``joined_at``): the removed row was nearer, so it was the row's
    source and role before, and now the farther one is. ``member.updated``
    does not close any socket, and the group page already refetches its
    members list on it. Its payload never carries the admin-only
    ``has_all_content_access`` key, since the frame goes to every subscriber.
    ``removed_role`` is the deleted row's stored role: one outside
    ``GroupMembership.Role`` listed nothing (#1829), so it was nobody's source
    and no ``member.updated`` is sent for it. ``None`` (unknown) sends it.

    Cost is constant in the size of the subtree: one query for the
    descendant groups with their ancestor chain, one for the user's
    memberships, and, only when a ``member.updated`` is due, one for the
    user. Best-effort like ``broadcast_group_event`` (#1462): a failed
    lookup is logged and swallowed, since the transaction has already
    committed; the subgroup page converges on its next refetch.
    """
    payload = {"user_id": user_id}
    broadcast_group_event(group_id, EVT_MEMBER_REMOVED, payload, actor_id=actor_id)
    descendant_ids = set(descendant_ids) - {group_id}
    if not descendant_ids:
        return
    from .models import _GROUP_TRAVERSAL_MAX_DEPTH, Group, GroupMembership

    try:
        groups = list(Group.objects.filter(pk__in=descendant_ids).select_related(
            "__".join(["parent"] * _GROUP_TRAVERSAL_MAX_DEPTH)
        ))
        # A deleted user's memberships are gone with them, so every descendant
        # is announced.
        rows = list(
            GroupMembership.objects.filter(user_id=user_id).values_list("group_id", "role", "joined_at")
        )
    except Exception as exc:  # noqa: BLE001 — best-effort, see docstring
        logger.warning(
            "group member.removed subtree fan-out dropped: group_id=%s error=%s",
            group_id,
            type(exc).__name__,
        )
        return
    # Direct rows are listed as stored; inherited ones only with a valid role.
    direct_ids = {gid for gid, _, _ in rows}
    inherited = {
        gid: (role, joined_at) for gid, role, joined_at in rows if role in GroupMembership.Role.values
    }

    def listing_source(group):
        """How ``group``'s members panel lists the user now.

        ``"direct"`` for a membership on the group itself, the nearest
        ancestor holding a listed (valid-role) membership for an inherited
        row, or ``None`` when the user is not listed. The second value says
        whether the walk passed the removed group on the way up: an inherited
        source above it replaced the removed row.
        """
        if group.pk in direct_ids:
            return "direct", False
        node = group
        passed_removed = False
        # Same cap as Group.ancestors(), walking only the select_related chain.
        for _ in range(_GROUP_TRAVERSAL_MAX_DEPTH):
            if node.parent_id is None:
                return None, passed_removed
            node = node.parent
            if node.pk in inherited:
                return node, passed_removed
            if node.pk == group_id:
                passed_removed = True
        return None, passed_removed

    removed_targets = []
    updated_targets = []
    for g in groups:
        source, passed_removed = listing_source(g)
        if source is None:
            removed_targets.append(g.pk)
        elif source != "direct" and passed_removed:
            updated_targets.append((g.pk, source))
    for gid in sorted(removed_targets):
        broadcast_group_event(gid, EVT_MEMBER_REMOVED, payload, actor_id=actor_id)
    if not updated_targets or (
        removed_role is not None and removed_role not in GroupMembership.Role.values
    ):
        return
    try:
        from accounts.models import User
        from accounts.serializers import BoardUserSerializer

        user_data = BoardUserSerializer(User.objects.get(pk=user_id)).data
    except Exception as exc:  # noqa: BLE001 — best-effort, see docstring
        logger.warning(
            "group member.updated subtree fan-out dropped: group_id=%s error=%s",
            group_id,
            type(exc).__name__,
        )
        return
    for gid, source in sorted(updated_targets, key=lambda t: t[0]):
        role, joined_at = inherited[source.pk]
        row = {
            "id": None,
            "user": user_data,
            "role": role,
            "joined_at": joined_at,
            "is_inherited": True,
            "inherited_from": source.name,
        }
        broadcast_group_event(gid, EVT_MEMBER_UPDATED, row, actor_id=actor_id)
