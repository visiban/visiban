"""Board and group health status (#1133).

A board or group may set ``health_status`` to one of :class:`HealthStatus`;
``None`` means "inherit". The *effective* value is resolved on read by walking
up the group tree: the entity's own value if set, otherwise the nearest
ancestor group that sets one (a board starts at its group, a group at its
parent). The walk covers at most ``_GROUP_TRAVERSAL_MAX_DEPTH`` groups, the
same bound ``get_board_role()`` and ``user_has_group_access()`` use.

Why computed on read and never stored: the cascade is *live*. A group's change
must reach every descendant that has not set its own value, and an override
must stay put when the parent changes later (sticky). Storing the effective
value would mean rewriting the whole subtree on every group write; reading it
costs one ancestor walk, which list endpoints batch into a single query
(:func:`build_health_map`).

There is deliberately no upward rollup ("group = worst of its boards"): that
is an aggregation-shaped feature with its own open-core question (#2049).

This module imports nothing from ``boards``: ``boards`` imports ``groups``,
never the reverse (see the note on ``groups.serializers``).
"""

from __future__ import annotations

from typing import NamedTuple

from .models import Group, HealthStatus, _GROUP_TRAVERSAL_MAX_DEPTH


class HealthNode(NamedTuple):
    """The columns of a group the resolver reads."""

    name: str
    parent_id: int | None
    health_status: str | None
    # When the group's own status was last set (#2242); published on an
    # inherited ``health_status_source`` (no setter or note: those stay on the
    # group itself).
    health_status_changed_at: object = None


def valid_health_status(value):
    """``value`` when it is a known :class:`HealthStatus`, else ``None``.

    ``choices`` is not enforced on save, so a row written by the shell, an
    import or a migration could hold any string. Such a value is treated as
    unset (inherit) rather than published as an effective value outside the
    documented enum.
    """
    return value if value in HealthStatus.values else None


def _node_from_group(group) -> HealthNode:
    return HealthNode(group.name, group.parent_id, group.health_status, group.health_status_changed_at)


def _chain_values(group_ids):
    """``id -> HealthNode`` for ``group_ids`` and up to the cap of their ancestors, in one query.

    One row per start group with ``LEFT JOIN``s up the ``parent`` chain, the
    same shape ``groups.models._ancestor_ids_from`` uses for ids.
    """
    if not group_ids:
        return {}
    prefixes = ["__".join(["parent"] * d) for d in range(_GROUP_TRAVERSAL_MAX_DEPTH)]
    columns = []
    for prefix in prefixes:
        lead = f"{prefix}__" if prefix else ""
        columns += [
            f"{lead}id", f"{lead}name", f"{lead}parent_id", f"{lead}health_status",
            f"{lead}health_status_changed_at",
        ]
    found = {}
    for row in Group.objects.filter(pk__in=group_ids).values_list(*columns):
        for i in range(0, len(row), 5):
            gid, name, parent_id, health, changed_at = row[i:i + 5]
            if gid is None:
                break
            found[gid] = HealthNode(name, parent_id, health, changed_at)
    return found


def build_health_map(starts):
    """Return ``id -> HealthNode`` covering every walk :func:`resolve_health` will take.

    ``starts`` is an iterable of ``(group_or_None, group_id)`` pairs: where each
    walk begins (a board's group, a group's parent) and, when the caller has
    it, the already-loaded ``Group`` instance. Loaded ``parent`` chains
    (``select_related``) are read for free; wherever a walk reaches a group
    that is not loaded, the rest of every such chain is fetched together in
    **one** query. A list endpoint therefore pays at most one query for the
    whole page, whatever its length or depth.
    """
    parent_field = Group._meta.get_field("parent")
    found = {}
    missing = set()
    for node, node_id in starts:
        depth = 0
        while node_id is not None and depth < _GROUP_TRAVERSAL_MAX_DEPTH:
            if node is not None and node.pk == node_id:
                found[node_id] = _node_from_group(node)
            elif node_id not in found:
                missing.add(node_id)
                break
            entry = found[node_id]
            if valid_health_status(entry.health_status):
                break
            parent_id = entry.parent_id
            if node is not None and parent_id is not None and parent_field.is_cached(node):
                node = node.parent
            else:
                node = None
            node_id = parent_id
            depth += 1
    missing -= found.keys()
    if missing:
        found.update(_chain_values(missing))
    return found


def resolve_health(own, start_group_id, health_map):
    """Return ``(effective_health_status, health_status_source)``.

    ``own`` is the entity's stored ``health_status``. When it is set, it is the
    effective value and the source is ``None`` (set here). Otherwise the
    nearest group from ``start_group_id`` upward (at most
    ``_GROUP_TRAVERSAL_MAX_DEPTH`` groups) that sets one supplies it, and the
    source is that group's ``{id, name, changed_at}`` (when that group's
    status was last set, #2242; null if before history existed). With no such
    group, both are ``None``.
    """
    own = valid_health_status(own)
    if own:
        return own, None
    node_id = start_group_id
    depth = 0
    while node_id is not None and depth < _GROUP_TRAVERSAL_MAX_DEPTH:
        entry = health_map.get(node_id)
        if entry is None:
            break
        value = valid_health_status(entry.health_status)
        if value:
            return value, {"id": node_id, "name": entry.name, "changed_at": entry.health_status_changed_at}
        node_id = entry.parent_id
        depth += 1
    return None, None
