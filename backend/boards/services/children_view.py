"""Children mode on the Board tab: all work in progress by lane and parent (#2370).

``GET /api/v1/boards/{id}/children-view/`` reads a parent-tier board as one row
per parent, grouped under its lane, with each lane's rollup on top. Everything
is computed per viewer, like the parent card's ``children_rollup`` (#2210),
and from the same rows and the same partition
(:func:`card_links.rollup_link_rows`, :func:`card_links.rollup_state`), so a
lane total is the sum of its rows and a row's rollup equals the card's.

Disclosure (#1104 decision B, owner sign-off 2026-11-17): for a parent whose
child board the viewer cannot open, only the number of live children is
returned. Such a row never carries a state, a time, a board, a column or a
title of a child, and never counts toward a lane's done, doing, blocked or
to-do totals, its ``folded`` count, or the row order's blocked and last-move
keys: two boards that differ only in the state of children the viewer cannot
open read identically. Board archive does not exist (#2206 decision F), so
there is no archived-child-board state.

Planned children (#2371, #2550, #2551): a child is planned when
:func:`card_links.is_planned_state` says so (Needed set, not released, and
neither blocked nor done: blocked and done beat planned, which beats to do,
the card's ``children_rollup`` order). A planned child is its own bucket,
``planned``: it is in ``total`` but never in ``todo``, ``doing``,
``blocked`` or ``in_progress``, and never feeds ``last_moved_at`` (the #2551
owner ruling). ``planned_only`` marks a row with nothing in progress and at
least one planned child; such a row is ``folded`` like an empty one, and a
lane's ``planned_only`` is the subset of its ``folded`` rows that are planned
only. Both are computed for visible rows only and never for a locked row, so
a planned count cannot leak a parent or child the viewer cannot open
(Rule 19). The client never re-derives "planned": it reads these keys and
each child's ``planned`` flag.
"""

import base64
import binascii
import json
from datetime import datetime, timedelta, timezone as dt_timezone

from django.db.models import Count, F, Prefetch
from rest_framework.exceptions import NotFound
from rest_framework.fields import DateTimeField

from visiban.exceptions import INVALID_QUERY_PARAM, CodedValidationError

from ..models import Card, CardParentLink, CardRelation, Column, Swimlane
from ..permissions import get_board_roles
from . import card_links

#: Parent rows per page (#2370 "The view loads 20 rows at a time").
CHILDREN_VIEW_PAGE_SIZE = 20

#: The longest cursor accepted; a real one is under 100 characters.
_CURSOR_MAX_LENGTH = 256
#: A cursor is the last row's sort key: seven integers (see :func:`_sort_key`).
_CURSOR_LENGTH = 7

_EPOCH = datetime(1970, 1, 1, tzinfo=dt_timezone.utc)
_datetime = DateTimeField()

_STATES = ("done", "doing", "todo", "blocked")
#: Card text the rows never send: up to 2,000 children a page, so not loaded.
_UNREAD_CARD_FIELDS = ("description", "mentioned_user_ids")


def _micros(moment):
    # Exact integer microseconds, so the cursor round-trips without float error.
    return (moment - _EPOCH) // timedelta(microseconds=1)


def encode_cursor(key):
    return base64.urlsafe_b64encode(json.dumps(list(key), separators=(",", ":")).encode()).decode().rstrip("=")


def decode_cursor(raw):
    """The sort key a cursor names, or a 400 ``invalid_query_param``.

    The cursor is plain JSON the client echoes back, so it is untrusted input:
    anything but a list of seven plain integers is refused before it is used.
    It only ever positions the caller inside rows already computed for them.
    """
    bad = CodedValidationError(INVALID_QUERY_PARAM, "cursor is not a valid cursor.")
    if not raw or len(raw) > _CURSOR_MAX_LENGTH:
        raise bad
    try:
        value = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
    except (binascii.Error, ValueError, UnicodeDecodeError):
        raise bad from None
    if (
        not isinstance(value, list) or len(value) != _CURSOR_LENGTH
        or any(type(v) is not int for v in value)
    ):
        raise bad
    return tuple(value)


def _sort_key(entry, lane_order):
    """Rows by lane, then unfolded before folded, blocked first, most recent move first.

    A hidden row has no blocked or move key (both read as "none"), so its
    place never encodes the state of children the viewer cannot open.
    """
    moved = entry["last_moved_at"]
    return (
        *lane_order[entry["swimlane_id"]],
        1 if entry["folded"] else 0,
        0 if entry["has_blocked"] else 1,
        0 if moved is not None else 1,
        -_micros(moved) if moved is not None else 0,
        -entry["id"],
    )


def _empty_lane(lane_id, name, position):
    return {
        "id": lane_id, "name": name, "position": position,
        "parents": 0, "child_boards": 0,
        "total": 0, "in_progress": 0, "done": 0, "doing": 0, "todo": 0, "blocked": 0,
        "hidden": 0, "folded": 0, "last_moved_at": None,
        "planned": 0, "planned_only": 0,
    }


def children_view_for_viewer(board, user, *, lane_id=None, cursor=None, include_done=False,
                             page_size=CHILDREN_VIEW_PAGE_SIZE):
    """The Children mode read of ``board`` for ``user`` (#2370). Computed per viewer.

    The caller has authorized ``board`` for ``user`` (any role) and checked
    that its cards can have children. ``lane_id`` (a lane of ``board``, else
    404) limits the rows, never the lane rollups: a collapsed band still shows
    its total. ``cursor`` is a ``next_cursor`` from the previous page.
    ``include_done`` adds done children to ``rows[].children``; the counts
    always include them.

    A parent is a row when it is live and has at least one live child; its
    rollup reads only the board of its first live link (one child board per
    parent, :func:`card_links.first_link_boards`). Archived parents and
    children are not counted.

    **Absent viewer fails closed** (#1075): no user, or an anonymous one, gets
    every row as hidden (count only) and no child board, as
    :func:`card_links.rollups_for_viewer` does.

    **Cost is flat** in lanes, parents and children (pinned by a query-count
    test): one lanes query, ONE per-live-link row query for every parent on
    the board (the only unbounded read: parents x live children, at most 100
    children per parent by the write cap), one child-board query plus
    ``get_board_roles``'s two, then for the page only: one parents query, one
    children query with one blocker prefetch, one live-card count per column
    and one columns query.
    """
    lanes = list(Swimlane.objects.filter(board_id=board.pk).order_by("position", "pk").values_list(
        "pk", "name", "position",
    ))
    lane_order = {pk: (position, pk) for pk, _name, position in lanes}
    if lane_id is not None and lane_id not in lane_order:
        raise NotFound()
    rows = card_links.rollup_link_rows(
        CardParentLink.objects.filter(parent__board_id=board.pk, parent__archived_at__isnull=True),
        "parent__swimlane_id", "needed_at_column_id", "planned_released_at",
    )
    board_of = card_links.first_link_boards(rows)
    child_boards = card_links.rollup_child_boards(set(board_of.values())) if board_of else []
    first_position = {b.pk: b._first_position for b in child_boards}
    absent = user is None or not getattr(user, "is_authenticated", False)
    roles = {} if absent or not child_boards else get_board_roles(user, child_boards)

    entries = {}
    for parent_id, child_board_id, blocked_at, has_blocker, is_done, position, moved, lane, needed_col, released in rows:
        if board_of[parent_id] != child_board_id:
            continue
        e = entries.get(parent_id)
        if e is None:
            e = entries[parent_id] = {
                "id": parent_id, "swimlane_id": lane, "child_board_id": child_board_id,
                "total": 0, "done": 0, "doing": 0, "todo": 0, "blocked": 0, "last_moved_at": None,
                "planned": 0,
            }
        e["total"] += 1
        state = card_links.rollup_state(blocked_at, has_blocker, is_done, position, first_position.get(child_board_id))
        if card_links.is_planned_state(state, needed_col, released):
            # Same rule as the card's children_rollup: a planned child is neither to do nor a recent move.
            e["planned"] += 1
            continue
        e[state] += 1
        if moved is not None and (e["last_moved_at"] is None or moved > e["last_moved_at"]):
            e["last_moved_at"] = moved

    lane_out = {pk: _empty_lane(pk, name, position) for pk, name, position in lanes}
    lane_boards = {pk: set() for pk in lane_out}
    for e in entries.values():
        visible = roles.get(e["child_board_id"]) is not None
        e["visible"] = visible
        lane = lane_out.get(e["swimlane_id"])
        if not visible:
            # Count only (decision B): no state, time or board for this row.
            e.update(child_board_id=None, has_blocked=False, folded=False, last_moved_at=None,
                     planned=None, planned_only=False)
            if lane is not None:
                lane["parents"] += 1
                lane["hidden"] += e["total"]
            continue
        # Planned children were skipped above, so this is total - done - planned (#2551 owner ruling).
        e["in_progress"] = e["todo"] + e["doing"] + e["blocked"]
        e["has_blocked"] = e["blocked"] > 0
        # A row whose open work is all planned has nothing in progress, so it folds (#2370 "Parents whose
        # only children are planned fold there too"); planned_only names that subset for the fold label.
        e["folded"] = e["in_progress"] == 0
        e["planned_only"] = e["in_progress"] == 0 and e["planned"] > 0
        if lane is None:
            continue
        lane["parents"] += 1
        lane_boards[lane["id"]].add(e["child_board_id"])
        for k in ("total", *_STATES):
            lane[k] += e[k]
        lane["in_progress"] += e["in_progress"]
        lane["folded"] += 1 if e["folded"] else 0
        lane["planned"] += e["planned"]
        lane["planned_only"] += 1 if e["planned_only"] else 0
        # Visible rows only: a hidden child's move must never reach the lane
        # (a locked row's last_moved_at was already cleared above).
        moved = e["last_moved_at"]
        if moved is not None and (lane["last_moved_at"] is None or moved > lane["last_moved_at"]):
            lane["last_moved_at"] = moved
    for pk, lane in lane_out.items():
        lane["child_boards"] = len(lane_boards[pk])

    after = decode_cursor(cursor) if cursor is not None else None
    ordered = sorted(
        (
            (_sort_key(e, lane_order), e) for e in entries.values()
            if e["swimlane_id"] in lane_order and (lane_id is None or e["swimlane_id"] == lane_id)
        ),
        key=lambda pair: pair[0],
    )
    if after is not None:
        ordered = [pair for pair in ordered if pair[0] > after]
    page = ordered[:page_size]
    next_cursor = encode_cursor(page[-1][0]) if len(ordered) > page_size else None
    lane_list = list(lane_out.values())
    for lane in lane_list:
        moved = lane["last_moved_at"]
        lane["last_moved_at"] = _datetime.to_representation(moved) if moved else None
    return {
        "board_total": {
            "in_progress": sum(lane["in_progress"] for lane in lane_list),
            "total": sum(lane["total"] for lane in lane_list),
            "blocked": sum(lane["blocked"] for lane in lane_list),
            "hidden": sum(lane["hidden"] for lane in lane_list),
            "planned": sum(lane["planned"] for lane in lane_list),
        },
        "lanes": lane_list,
        **_page_rows([e for _key, e in page], {b.pk: b for b in child_boards}, roles, first_position,
                     include_done=include_done),
        "next_cursor": next_cursor,
    }


def _page_rows(page, boards, roles, first_position, *, include_done):
    """The page's parent rows and the child boards they draw, in at most five queries."""
    if not page:
        return {"rows": [], "child_boards": []}
    from accounts.serializers import BoardUserSerializer

    parents = {
        c.pk: c for c in Card.objects.filter(pk__in=[e["id"] for e in page])
        .select_related("column", "assignee").defer(*_UNREAD_CARD_FIELDS)
    }
    visible = {e["id"]: e["child_board_id"] for e in page if e["visible"]}
    children = {pid: [] for pid in visible}
    if visible:
        cards = (
            Card.objects.filter(
                parent_link__parent_id__in=list(visible), board_id__in=set(visible.values()),
                archived_at__isnull=True,
            )
            .select_related("column", "assignee").defer(*_UNREAD_CARD_FIELDS)
            # The planned predicate's two fields, read off the link row this
            # query already joins, so planned adds no subquery.
            .annotate(
                _parent_id=F("parent_link__parent_id"),
                _needed_at=F("parent_link__needed_at_column_id"),
                _released_at=F("parent_link__planned_released_at"),
            )
            # The #449 predicate, as children_for_viewer reads it: a manual
            # block or an active same-board blocking relation.
            .prefetch_related(Prefetch(
                "incoming_relations",
                queryset=CardRelation.objects.filter(
                    relation_type=CardRelation.Type.BLOCKS,
                    from_card__archived_at__isnull=True,
                    from_card__board_id=F("to_card__board_id"),
                ).only("id", "to_card_id"),
                to_attr="active_blockers",
            ))
            .order_by("column__position", "position", "pk")
        )
        for c in cards:
            if visible.get(c._parent_id) != c.board_id:
                continue  # not on the parent's first-link board: never read
            state = card_links.rollup_state(
                c.blocked_at, len(c.active_blockers) > 0, c.column.is_done, c.column.position,
                first_position.get(c.board_id),
            )
            if state == "done" and not include_done:
                continue
            children[c._parent_id].append({
                "id": c.pk,
                "title": c.title,
                "column_id": c.column_id,
                "swimlane_id": c.swimlane_id,
                "position": c.position,
                "state": state,
                "assignee": BoardUserSerializer(c.assignee).data if c.assignee_id else None,
                "blocked": state == "blocked",
                "blocked_at": _datetime.to_representation(c.blocked_at) if c.blocked_at else None,
                "planned": card_links.is_planned_state(state, c._needed_at, c._released_at),
            })
    board_ids = sorted(set(visible.values()))
    columns = {pk: [] for pk in board_ids}
    if board_ids:
        # Live cards per column, counted from ``cards`` with the board in the
        # filter so the (board, column, archived_at) index serves it; archived
        # history in done columns is never joined.
        live = dict(
            Card.objects.filter(board_id__in=board_ids, archived_at__isnull=True)
            .order_by().values("column_id").annotate(n=Count("pk")).values_list("column_id", "n")
        )
        for col in Column.objects.filter(board_id__in=board_ids).order_by("position", "pk"):
            columns[col.board_id].append({
                "id": col.pk, "name": col.name, "color": col.color,
                "wip_limit": col.wip_limit, "is_done": col.is_done, "card_count": live.get(col.pk, 0),
            })
    out_rows = []
    for e in page:
        p = parents.get(e["id"])
        if p is None:
            continue  # deleted between the two reads
        if e["visible"]:
            rollup = {
                "visible": True, "total": e["total"], "done": e["done"], "doing": e["doing"],
                "todo": e["todo"], "blocked": e["blocked"],
                "last_moved_at": _datetime.to_representation(e["last_moved_at"]) if e["last_moved_at"] else None,
            }
        else:
            rollup = {"visible": False, "total": e["total"]}
        out_rows.append({
            "id": p.pk,
            "title": p.title,
            "swimlane_id": p.swimlane_id,
            "column_id": p.column_id,
            "column_name": p.column.name,
            "assignee": BoardUserSerializer(p.assignee).data if p.assignee_id else None,
            "rollup": rollup,
            "in_progress": e["in_progress"] if e["visible"] else None,
            "folded": e["folded"],
            "planned": e["planned"] if e["visible"] else None,
            "planned_only": e["planned_only"],
            "child_board_id": e["child_board_id"],
            "children": children.get(e["id"], []),
        })
    return {
        "rows": out_rows,
        "child_boards": [
            {
                "id": pk, "name": boards[pk].name, "role": roles[pk],
                "enforce_wip_limits": boards[pk].enforce_wip_limits,
                "enforce_wip_hard": boards[pk].enforce_wip_hard,
                "columns": columns[pk],
            }
            for pk in board_ids
        ],
    }
