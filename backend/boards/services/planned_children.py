"""Planned children (#2371, epic #2206): child work known for a later parent stage.

A child whose ``CardParentLink.needed_at_column`` is set is *planned* until
the parent reaches (or skips past) that column on its own board, or someone
pulls the child out of To do. While planned, the child's due date is stored
but inactive: it is left out of Overdue, Due soon and Stale on every surface
(REST, export, MCP, notifications) through the one predicate :data:`PLANNED_Q`.

**Release is a system write caused by the link, not by a role on the child
board** (threat model addendum, ``docs/development/security-invariants.md``):
whoever moves the parent may hold no role on the child board, and the move
still releases the child. The write is narrow on purpose: it sets one
timestamp on the link row and writes one history row that names no parent,
board, column or person (the reader may be unable to open the parent's
board), so the move grants the mover no read or write on the child board.

Kept in its own module so the link service (``card_links``) gains no new
branch on every link read.
"""

from django.db import transaction
from django.db.models import Case, DateTimeField, F, IntegerField, OuterRef, Q, Subquery, When
from django.utils import timezone
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError

from .. import broadcast as _broadcast
from ..models import Card, CardActivity, CardMovement, CardParentLink, Column
from ..permissions import get_board_roles

#: A planned link row: Needed set to a later column and not yet released.
LINK_PLANNED_Q = Q(needed_at_column__isnull=False, planned_released_at__isnull=True)

#: The same predicate from a ``Card`` queryset. Every Overdue, Due soon and
#: Stale reader excludes it (Rule 10 parity: REST, export, MCP, notifications).
PLANNED_Q = Q(parent_link__needed_at_column__isnull=False, parent_link__planned_released_at__isnull=True)

#: Serializer-context key holding :func:`planned_fields_for_viewer`'s result.
#: Set ONLY by the reads that name a viewer, like ``CARD_PARENTS_CONTEXT_KEY``.
CARD_PLANNED_CONTEXT_KEY = "card_planned"

#: The fields a card with no planned link carries.
NOT_PLANNED = {
    "planned": False,
    "needed_now": False,
    "needed_at_column": None,
    "needed_at_column_name": None,
    "planned_released_at": None,
}


def _record(card_id, event_type, actor, cause, to_value):
    CardActivity.objects.create(
        card_id=card_id, event_type=event_type, actor=actor,
        from_value=cause, to_value=to_value,
    )


def _due_iso(due_date):
    return due_date.isoformat() if due_date else ""


def resolve_needed_column(parent, value):
    """The ``Column`` a new or edited child is needed at, or ``None`` for "Now".

    Only a column on the PARENT's board that comes after the parent's current
    column qualifies: a column the parent already reached would release the
    child at once, and a column on any other board would never be reached.
    A strict int-or-null (a bool is not an id). Absent (``None``) means Now.
    """
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValidationError({"needed_at_column": ["Must be an integer or null."]})
    column = Column.objects.filter(pk=value, board_id=parent.board_id).first()
    # Re-read, not ``parent.column``: the callers hold the parent's row lock,
    # and the object they were handed may predate a move that committed first.
    current = (
        Card.objects.filter(pk=parent.pk).values_list("column__position", flat=True).first()
    )
    if column is None or current is None or column.position <= current:
        raise ValidationError({"needed_at_column": ["Choose a later column on the parent's board."]})
    return column


def record_created_planned(card, actor):
    """History for a child created planned: "Created in To do · planned for a later stage"."""
    _record(card.pk, CardActivity.EventType.NEEDED_CHANGED, actor, "created", "planned")


def release_on_move(card, *, board, to_column, actor):
    """Release planned links touched by ``card`` changing column. Inside the move's transaction.

    Two cases, both conditional UPDATEs on the link row (claimed once, so a
    pull racing a parent move writes one history row, not two):

    * ``card`` is a planned child: any column change pulls it out of To do.
    * ``card`` is a parent: each planned child whose ``needed_at_column`` sits
      at or before ``to_column`` is released ("reaches or skips past"). A
      parent moving back releases nothing and re-plans nothing.

    Clients refresh the children through the ``card.parent_changed`` frame the
    parent move already sends (``announce_parent_changed``); the pulled child's
    own ``card.moved`` frame carries its new column.
    """
    now = timezone.now()
    # Two tiers (#2208): a card on a parent-tier board is never a child, and
    # a card elsewhere is never a parent. So exactly one query per move.
    if not board.cards_can_have_children:
        pulled = (
            CardParentLink.objects.filter(child_id=card.pk).filter(LINK_PLANNED_Q)
            .update(planned_released_at=now)
        )
        if pulled:
            _record(card.pk, CardActivity.EventType.PLANNED_RELEASED, actor, "pulled", _due_iso(card.due_date))
        return
    rows = list(
        CardParentLink.objects.filter(parent_id=card.pk).filter(LINK_PLANNED_Q)
        .filter(needed_at_column__board_id=to_column.board_id, needed_at_column__position__lte=to_column.position)
        .values_list("pk", "child_id", "child__due_date")
        .order_by("pk")
    )
    for link_pk, child_id, due_date in rows:
        if CardParentLink.objects.filter(pk=link_pk).filter(LINK_PLANNED_Q).update(planned_released_at=now):
            # No actor: the person who moved the parent may hold no role on
            # the child board, and naming them would disclose the move to a
            # reader who cannot open the parent (#2371 hidden-parent history).
            _record(child_id, CardActivity.EventType.PLANNED_RELEASED, None, "parent_reached", _due_iso(due_date))


def clear_for_deleted_column(column, *, actor):
    """Record "Needed: Now" on each planned child whose column is being deleted.

    Called by the column delete under its cascade locks, before the delete;
    the FK's ``SET_NULL`` then clears the field. A released child is already
    an ordinary card and gets no row. Pings each child board so open clients
    re-read the children (ids only).
    """
    rows = list(
        CardParentLink.objects.filter(needed_at_column=column, planned_released_at__isnull=True)
        .values_list("child_id", "child__board_id")
    )
    by_board = {}
    for child_id, child_board_id in rows:
        # No actor (Rule 19): the column's deleter is a PARENT-board admin who
        # may hold no role on the child board, and the child's history is read
        # by the child board's members. Naming them would disclose who changed
        # a board the reader may be unable to open.
        _record(child_id, CardActivity.EventType.NEEDED_CHANGED, None, "column_deleted", "now")
        by_board.setdefault(child_board_id, []).append(child_id)
    for child_board_id in sorted(by_board):
        _broadcast.record_board_event(
            child_board_id, _broadcast.EVT_CARD_PARENT_CHANGED,
            {"card_ids": sorted(by_board[child_board_id])}, actor_id=getattr(actor, "id", None),
        )


#: Roles that may change a child's Needed (the link write roles, #1104).
def _write_roles():
    from .card_links import LINK_WRITE_ROLES
    return LINK_WRITE_ROLES


def set_needed(card, *, user, child_role, value):
    """Change a child's Needed by hand (#2371). Returns the updated link.

    Authorization: MEMBER or higher on the child's board. Setting a column
    also needs a WRITE role (MEMBER or higher, ``LINK_WRITE_ROLES``) on the
    parent's board, the same predicate ``create_child`` applies to a column
    chosen at creation, so the two paths agree; anyone else (a parent-board
    viewer, or a reader who cannot open the parent) may only set "Now"
    (``None``). Setting a column re-plans the child, so it is only
    allowed while the child is in its board's first column (planned work
    waits in To do). The stored due date is kept either way, now inactive or
    live. Every change writes a ``needed_changed`` row; a no-op writes none.
    """
    if child_role not in _write_roles():
        raise PermissionDenied()
    from .cards import lock_card_row

    from .card_links import lock_card_and_link_peers

    with transaction.atomic():
        # Lock order: the child AND its parent card, pk-ordered, in one
        # statement, before the link row is read. That is the order every link
        # write takes (``card_links._lock_endpoints``: both cards, pk order)
        # and it never holds a card a move waits on while waiting on a link:
        # a move (``services.cards._move_card_attempt``) locks its own card's
        # cell and columns, then UPDATEs the link rows in ``release_on_move``,
        # and this holds no link row until both cards are granted. Holding the
        # parent is what makes the column check below current: without it a
        # parent moving past the chosen column could commit its release query
        # between this read of its position and this commit, leaving the child
        # planned for a column the parent already passed, never released, its
        # due date silently inactive (#2371 security review).
        lock_card_and_link_peers(card.pk)
        locked = lock_card_row(card.pk)  # already held; reads the column under it
        if locked is None:
            raise NotFound()
        link = (
            CardParentLink.objects.select_for_update(of=("self",))
            .select_related("parent").filter(child_id=card.pk).first()
        )
        if link is None:
            raise ValidationError({"needed_at_column": ["This card has no parent."]})
        if value is None:
            column = None
        else:
            # ``.get``, not ``[...]``: a board missing from the result denies
            # (#1075), it does not 500.
            if get_board_roles(user, [link.parent.board]).get(link.parent.board_id) not in _write_roles():
                # Same answer as a column that does not qualify: the caller
                # learns nothing about the parent board's columns.
                raise ValidationError({"needed_at_column": ["Choose a later column on the parent's board."]})
            column = resolve_needed_column(link.parent, value)
            first = (
                Column.objects.filter(board_id=card.board_id).order_by("position", "pk")
                .values_list("pk", flat=True).first()
            )
            if locked.column_id != first:
                raise ValidationError({"needed_at_column": ["Only a card in the first column can be planned."]})
        was_planned = link.needed_at_column_id is not None and link.planned_released_at is None
        now_planned = column is not None
        if link.needed_at_column_id == (column.pk if column else None) and was_planned == now_planned:
            return link
        link.needed_at_column = column
        link.planned_released_at = None
        link.save(update_fields=["needed_at_column", "planned_released_at"])
        _record(
            card.pk, CardActivity.EventType.NEEDED_CHANGED, user, "manual",
            "planned" if now_planned else "now",
        )
        _broadcast.record_board_event(
            card.board_id, _broadcast.EVT_CARD_PARENT_CHANGED, {"card_ids": [card.pk]}, actor_id=user.id,
        )
    return link


def annotate_links(qs):
    """Add what :func:`planned_entries` reads to a ``CardParentLink`` queryset.

    Joined into ``parents_for_viewer``'s one links query, so the planned
    fields cost no query of their own: the Needed column (a join), the
    child's column, its board's first column and its last move (subqueries).
    """
    last_move = (
        CardMovement.objects.filter(card_id=OuterRef("child_id"))
        .order_by("-moved_at").values("moved_at")[:1]
    )
    first_column = (
        Column.objects.filter(board_id=OuterRef("child__board_id"))
        .order_by("position", "pk").values("pk")[:1]
    )
    # Only a link with Needed set is read by planned_entries, so the two
    # subqueries sit inside a CASE on it: PostgreSQL evaluates a THEN branch
    # only for the rows whose WHEN holds, and an ordinary (Now) link row, the
    # common case, pays for neither (#2371 perf review).
    has_needed = Q(needed_at_column__isnull=False)
    return qs.select_related("needed_at_column").annotate(
        _planned_last_moved=Case(
            When(has_needed, then=Subquery(last_move)), default=None, output_field=DateTimeField(),
        ),
        _planned_first_col=Case(
            When(has_needed, then=Subquery(first_column)), default=None, output_field=IntegerField(),
        ),
        _planned_child_col=F("child__column_id"),
    )


def planned_entries(links, roles):
    """``{child_id: fields}`` for each link with Needed set, for one viewer.

    ``planned`` and ``needed_now`` describe the child itself (its own board's
    state) and go to every reader of the child. ``needed_at_column`` and
    ``needed_at_column_name`` are the PARENT board's column, so they are
    ``None`` unless ``roles`` (``get_board_roles`` for the viewer) holds a
    role on the parent's board; an empty ``roles`` (absent or anonymous
    viewer) hides them, failing closed (#1075).

    ``needed_now``: released, still in the child board's first column, and no
    move since the release. A pull is itself a move out of that column, so a
    pulled child never reads as needed now.
    """
    out = {}
    for link in links:
        if link.needed_at_column_id is None:
            continue
        visible = roles.get(link.parent.board_id) is not None
        released = link.planned_released_at
        moved = link._planned_last_moved
        out[link.child_id] = {
            "planned": released is None,
            "needed_now": (
                released is not None
                and link._planned_child_col == link._planned_first_col
                and (moved is None or moved <= released)
            ),
            "needed_at_column": link.needed_at_column_id if visible else None,
            "needed_at_column_name": link.needed_at_column.name if visible else None,
            "planned_released_at": released.isoformat() if released else None,
        }
    return out


def planned_stale_exempt(entry, threshold_days):
    """True when a planned map entry exempts its card from Stale (#2371).

    Planned: always. Released: until ``threshold_days`` after the release (the
    stale clock restarts at the release, not at the last move).
    """
    if not entry:
        return False
    if entry["planned"]:
        return True
    released = entry["planned_released_at"]
    if released is None:
        return False
    from datetime import datetime, timedelta

    return datetime.fromisoformat(released) >= timezone.now() - timedelta(days=threshold_days)
