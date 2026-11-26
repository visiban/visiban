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
    read before the delete and again after commit, #2624) that no longer lists the user: a
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
    direct_ids, inherited = _listing_rows(rows)

    removed_targets = []
    updated_targets = []
    for g in groups:
        source, passed_removed = _listing_source(g, direct_ids, inherited, group_id)
        if source is None:
            removed_targets.append(g.pk)
        elif source != "direct" and passed_removed:
            updated_targets.append((g.pk, source.pk, source.name))
    for gid in sorted(removed_targets):
        broadcast_group_event(gid, EVT_MEMBER_REMOVED, payload, actor_id=actor_id)
    if not updated_targets or (
        removed_role is not None and removed_role not in GroupMembership.Role.values
    ):
        return
    _send_inherited_rows(group_id, user_id, updated_targets, inherited, actor_id=actor_id)


# Most ``member.updated`` frames one membership add or role change fans out to
# subgroups (#2235). The fan-out runs inside the request's post-commit
# callback, one channel-layer publish per subgroup, so a group with thousands
# of subgroups would hold the request for thousands of publishes. Past the cap
# the remaining subgroups (by id) are not told and converge on their next
# refetch (focus, reconnect, reload), as every subgroup did before #2235; the
# skip is logged so an operator can see it.
INHERITED_ROW_FANOUT_MAX = 500


def broadcast_member_inherited_rows(group_id: int, user_id: int, *, actor_id: int | None = None) -> None:
    """Fan a group membership add or role change out to the subgroups that inherit it (#2235).

    Call post-commit (``transaction.on_commit``), after the group's own
    ``member.added`` / ``member.updated`` / ``group.updated`` frame. A
    subgroup's members panel lists members inherited from its ancestors, so a
    membership created or re-roled on ``group_id`` also changes the row each
    descendant lists for the user when that membership is the row's source.
    Those descendants get ``member.updated`` carrying the row as the members
    endpoint now lists it (``id: null``, ``is_inherited: true``,
    ``inherited_from`` this group's name, its role and ``joined_at``) — the
    payload #2175 defined. On an add the descendant may not have listed the
    user before; the frame is still ``member.updated`` (not ``member.added``,
    which carries a stored row), and the group page refetches its members
    list on either.

    The listing rule is ``broadcast_member_removed``'s: a descendant that
    lists the user directly, or through a valid-role membership on a group
    between it and ``group_id``, does not change and gets no frame. Only the
    path up to ``group_id`` matters: when the walk reaches it, its own row is
    the source. The membership is re-read here, after commit, so a row
    removed or re-roled to an out-of-enum value meanwhile sends nothing (the
    removal sends its own frames).

    Bounded twice. In depth: a descendant more than
    ``_GROUP_TRAVERSAL_MAX_DEPTH`` levels below ``group_id`` cannot inherit
    from it (``Group.ancestors()`` stops at the cap), so the subtree is read
    one level at a time (``parent_id`` index, ids only) for at most that many
    levels. In breadth: at most ``INHERITED_ROW_FANOUT_MAX`` frames. Queries:
    one per subtree level plus one (just one when the group has no
    subgroups), then the user's memberships on the group and its subtree,
    then, only when the group's row is a listed source, the group's name and,
    only when a frame is due, the user. Best-effort like ``broadcast_group_event``: a failed lookup is
    logged and swallowed; the subgroup page converges on its next refetch.
    """
    from .models import _GROUP_TRAVERSAL_MAX_DEPTH, Group, GroupMembership

    try:
        parent_of = {}
        frontier = [group_id]
        for _ in range(_GROUP_TRAVERSAL_MAX_DEPTH):
            level = [
                (gid, pid)
                for gid, pid in Group.objects.filter(parent_id__in=frontier).values_list("id", "parent_id")
                if gid != group_id and gid not in parent_of
            ]
            if not level:
                break
            parent_of.update(level)
            frontier = [gid for gid, _ in level]
        if not parent_of:
            return
        rows = list(
            GroupMembership.objects.filter(user_id=user_id, group_id__in=[group_id, *parent_of])
            .values_list("group_id", "role", "joined_at")
        )
        direct_ids, inherited = _listing_rows(rows)
        if group_id not in inherited:
            # Gone, or a stored role outside the enum: it is nobody's listed source.
            return
        name = Group.objects.filter(pk=group_id).values_list("name", flat=True).first()
    except Exception as exc:  # noqa: BLE001 — best-effort, see docstring
        logger.warning(
            "group member inherited-row fan-out dropped: group_id=%s error=%s",
            group_id,
            type(exc).__name__,
        )
        return
    if name is None:
        return

    def inherits_from_group(gid):
        # Same rule as _listing_source, walking the subtree path up to group_id.
        if gid in direct_ids:
            return False
        node = parent_of[gid]
        while node != group_id:
            if node in inherited:
                return False
            node = parent_of[node]
        return True

    targets = sorted(gid for gid in parent_of if inherits_from_group(gid))
    if len(targets) > INHERITED_ROW_FANOUT_MAX:
        logger.warning(
            "group member inherited-row fan-out capped: group_id=%s subgroups=%s sent=%s",
            group_id,
            len(targets),
            INHERITED_ROW_FANOUT_MAX,
        )
        targets = targets[:INHERITED_ROW_FANOUT_MAX]
    if targets:
        _send_inherited_rows(
            group_id, user_id, [(gid, group_id, name) for gid in targets], inherited, actor_id=actor_id,
        )


def _listing_rows(rows):
    """Split ``(group_id, role, joined_at)`` membership rows by how the members panel lists them.

    Direct rows are listed as stored (so an admin can remove a malformed
    one); inherited ones only with a stored role within
    ``GroupMembership.Role`` (#1829). Returns ``(direct_ids, inherited)``,
    ``inherited`` mapping group id to ``(role, joined_at)``.
    """
    from .models import GroupMembership

    direct_ids = {gid for gid, _, _ in rows}
    inherited = {
        gid: (role, joined_at) for gid, role, joined_at in rows if role in GroupMembership.Role.values
    }
    return direct_ids, inherited


def _listing_source(group, direct_ids, inherited, marker_id):
    """How ``group``'s members panel lists the user now (``GroupViewSet.members``).

    ``"direct"`` for a membership on the group itself, the nearest ancestor
    holding a listed (valid-role) membership for an inherited row, or
    ``None`` when the user is not listed. The second value says whether the
    walk passed ``marker_id`` on the way up without stopping there (the
    removed group, for ``broadcast_member_removed``: an inherited source
    above it replaced the removed row). ``group`` must have its parent chain
    loaded (``select_related``).
    """
    from .models import _GROUP_TRAVERSAL_MAX_DEPTH

    if group.pk in direct_ids:
        return "direct", False
    node = group
    passed_marker = False
    # Same cap as Group.ancestors(), walking only the select_related chain.
    for _ in range(_GROUP_TRAVERSAL_MAX_DEPTH):
        if node.parent_id is None:
            return None, passed_marker
        node = node.parent
        if node.pk in inherited:
            return node, passed_marker
        if node.pk == marker_id:
            passed_marker = True
    return None, passed_marker


def _send_inherited_rows(group_id, user_id, targets, inherited, *, actor_id=None):
    """Send ``member.updated`` with each target's inherited row (#2175, #2235).

    ``targets`` is ``[(descendant_id, source_group_id, source_group_name)]``. The row matches what
    ``GroupViewSet.members`` lists on the descendant, minus the admin-only
    ``has_all_content_access`` key, since the frame goes to every
    subscriber. One query, for the user.
    """
    try:
        from accounts.models import User
        from accounts.serializers import BoardUserSerializer

        user_data = BoardUserSerializer(User.objects.get(pk=user_id)).data
    except Exception as exc:  # noqa: BLE001 — best-effort, see the callers' docstrings
        logger.warning(
            "group member.updated subtree fan-out dropped: group_id=%s error=%s",
            group_id,
            type(exc).__name__,
        )
        return
    for gid, source_id, source_name in sorted(targets, key=lambda t: t[0]):
        role, joined_at = inherited[source_id]
        row = {
            "id": None,
            "user": user_data,
            "role": role,
            "joined_at": joined_at,
            "is_inherited": True,
            "inherited_from": source_name,
        }
        broadcast_group_event(gid, EVT_MEMBER_UPDATED, row, actor_id=actor_id)
