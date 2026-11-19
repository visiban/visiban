"""Cross-board parent/child card links (#1104) and their two-tier rules (#2208).

Cards link parent -> child across boards, and the hierarchy is two-tier by
design: a board is either a parent tier (``cards_can_have_children`` is True)
or a child tier (False), never both. Making the tier a property of the board
rather than of each card keeps the rule structural: an admin decides once what
a board is for, and a card can never end up as both a grandparent and a child.
The per-card check in :func:`create_link` is defense in depth on top of this
predicate, not a substitute for it.

This module is the ONE place that writes a link and the ONE place that
computes a parent's children for a viewer (threat model, Rule 10). REST calls
it today; MCP, export and the #2212 extension slot must call
:func:`children_for_viewer` rather than querying ``CardParentLink`` on their
own, so a second transport can never show more than REST does. In v1 links
are absent from MCP and export; the parity test that pins that, a throttle on
link writes and a perf-bench case for the children read are not built yet
(tracked in #2383).

**Why every read is per viewer:** a link crosses an authorization boundary.
Whoever can open the parent board is not necessarily able to open the child
board, and the reverse. A child board the viewer has no role on is reported
as a count only (owner sign-off 2026-11-17, decision B), never a title, board,
column or id.
"""

from django.db import connection, transaction
from django.db.models import Q
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError

from visiban.exceptions import CodedValidationError

from .. import broadcast as _broadcast
from ..models import Board, BoardMembership, Card, CardActivity, CardParentLink
from ..permissions import GROUP_ANCESTOR_SELECT_RELATED, SITE_ADMIN, get_board_roles

#: Hard cap on the children of one parent (threat model: write amplification
#: and rollup cost). Enforced under the parent card's row lock.
CHILDREN_PER_PARENT_LIMIT = 100

#: Roles that may create or remove a link on a board. An allow-list, as for
#: ``CardViewSet.relations``: a link changes how another card reads for
#: everyone on its board, so it sits on the card-state side of the
#: collaborator line.
LINK_WRITE_ROLES = (BoardMembership.Role.MEMBER, BoardMembership.Role.ADMIN, SITE_ADMIN)

_PERM_DENIED = "You do not have permission to perform this action."


def link_allowed(parent_board, child_board) -> bool:
    """True when a link from ``parent_board``'s card to ``child_board``'s card is allowed.

    Requires the parent board to be a parent tier and the child board to be a
    child tier. The same board on both sides fails the second condition.
    """
    return (
        parent_board.cards_can_have_children is True
        and child_board.cards_can_have_children is False
    )


def links_blocking_flag_flip(board, new_value: bool) -> int:
    """Count the existing links that flipping ``board`` to ``new_value`` would invalidate.

    Turning the flag OFF on a parent board would leave its cards' children
    linked to a child-tier parent; turning it ON on a child board would make
    its linked children sit on a parent tier. Either breaks :func:`link_allowed`
    for a link that already exists. Callers hold the board row lock, and
    :func:`create_link` takes the same lock, so a flip and a link serialize.
    """
    if new_value:
        return CardParentLink.objects.filter(child__board_id=board.pk).count()
    return CardParentLink.objects.filter(parent__board_id=board.pk).count()


def check_flag_flip(board, new_value: bool) -> None:
    """Raise a 400 when changing the flag to ``new_value`` would break existing links.

    A no-op when the value is unchanged.
    """
    if new_value == board.cards_can_have_children:
        return
    blocking = links_blocking_flag_flip(board, new_value)
    if blocking:
        raise ValidationError({
            "cards_can_have_children": [
                f"Cannot change this setting while {blocking} card link(s) depend on it. "
                "Remove those links first."
            ]
        })


# ─── Lookup ──────────────────────────────────────────────────────────────────


def resolve_card_for_user(user, card_id):
    """Return ``(card, role)`` for a card id from a request body.

    A missing id, a non-numeric id and an id on a board the user cannot open
    all raise the SAME ``NotFound``: the lookup must not be an oracle for the
    existence of cards on other boards (threat model, risk 1; Rule 7).
    """
    # Only a JSON integer or a numeric string is an id: a float would be
    # truncated to some other card, and a bool is an int subclass.
    if isinstance(card_id, bool) or not isinstance(card_id, (int, str)):
        raise NotFound()
    try:
        pk = int(card_id)
    except (TypeError, ValueError, OverflowError):
        raise NotFound() from None
    if pk <= 0:
        raise NotFound()
    card = (
        Card.objects.select_related(f"board__{GROUP_ANCESTOR_SELECT_RELATED}")
        .filter(pk=pk)
        .first()
    )
    if card is None:
        raise NotFound()
    role = get_board_roles(user, [card.board])[card.board_id]
    if role is None:
        raise NotFound()
    return card, role


# ─── Write path ──────────────────────────────────────────────────────────────


def _lock_endpoints(parent_pk, child_pk, board_pks=()):
    """Lock both boards, then both cards, each in pk order.

    Boards first, ``FOR NO KEY UPDATE`` (the mode the board PATCH and the
    Django-admin board save take), so a concurrent ``cards_can_have_children``
    flip either commits before the link reads the flags or waits for the link
    to commit and then counts it in :func:`links_blocking_flag_flip`. Cards
    second, so two links naming the same parent (the one-child-board and cap
    checks) or the same pair in opposite directions (the two-tier check)
    queue instead of both passing on a stale read. pk order on both, so two
    requests naming the same rows in opposite roles queue, not deadlock.

    Returns ``{card_pk: board_id}`` for the cards still present, read under
    the lock so a card moved to another board meanwhile is judged where it is.
    """
    if not connection.features.has_select_for_update:
        # SQLite (the default test harness) serializes writers database-wide,
        # so the race these locks guard against cannot occur there.
        return dict(
            Card.objects.filter(pk__in=[parent_pk, child_pk]).values_list("pk", "board_id")
        )
    # An unlink passes no boards: removing a link can only lower the count a
    # flag flip reads, so it does not need to hold the flip off.
    list(
        Board.objects.select_for_update(no_key=True)
        .filter(pk__in=sorted(set(board_pks)))
        .order_by("pk")
        .values_list("pk", flat=True)
    )
    return dict(
        Card.objects.select_for_update()
        .filter(pk__in=sorted({parent_pk, child_pk}))
        .order_by("pk")
        .values_list("pk", "board_id")
    )


def _record(card_id, event_type, actor):
    """Write one link history row with NO reference to the other card.

    Not even its id: whoever reads this card's history may be unable to open
    the other card's board, and "never a title, board, column or id" holds for
    history as it does for ``children_for_viewer``. Clients read the current
    link from the parent/children endpoints, which resolve the reader's role.
    The signature takes no value arguments on purpose, so no caller can hand
    it the other card's id to store.
    """
    CardActivity.objects.create(card_id=card_id, event_type=event_type, actor=actor)


def _announce(parent_board_id, parent_id, child_board_id, child_id, actor_id):
    """Record the two ids-only pings, published when the transaction commits.

    ``record_board_event`` defers the publish with ``transaction.on_commit``,
    so a rolled-back link broadcasts nothing. The child's own card events are
    never fanned out to the parent board: the parent board only ever learns
    "this parent's children changed" (Rule 8 row, #1104).
    """
    _broadcast.record_board_event(
        parent_board_id, _broadcast.EVT_CARD_CHILDREN_CHANGED,
        {"parent_id": parent_id}, actor_id=actor_id,
    )
    _broadcast.record_board_event(
        child_board_id, _broadcast.EVT_CARD_PARENT_CHANGED,
        {"card_ids": [child_id]}, actor_id=actor_id,
    )


def create_link(*, user, child, child_role, parent_id):
    """Link ``child`` (already resolved on a board the user can open) to a parent.

    Authorization: MEMBER or higher on BOTH boards. ``child_role`` is the
    caller's role on the child's board; the parent's board role is resolved
    here, and a parent the user cannot open is a 404 identical to a missing
    one. Every rule that depends on other rows is decided under
    :func:`_lock_endpoints`. Returns the new ``CardParentLink``.
    """
    if child_role not in LINK_WRITE_ROLES:
        raise PermissionDenied(_PERM_DENIED)
    parent, parent_role = resolve_card_for_user(user, parent_id)
    if parent.pk == child.pk:
        raise CodedValidationError("self_link", "A card cannot be its own parent.")
    if parent_role not in LINK_WRITE_ROLES:
        raise PermissionDenied(_PERM_DENIED)

    with transaction.atomic():
        boards_now = _lock_endpoints(parent.pk, child.pk, [parent.board_id, child.board_id])
        # Judge the cards where they are under the lock: a card deleted or
        # moved to another board after the lookup is a 404, not a link to a
        # board the role checks above were not made against.
        if boards_now.get(child.pk) != child.board_id or boards_now.get(parent.pk) != parent.board_id:
            raise NotFound()
        flags = dict(
            Board.objects.filter(pk__in=[parent.board_id, child.board_id])
            .values_list("pk", "cards_can_have_children")
        )
        parent.board.cards_can_have_children = flags[parent.board_id]
        child.board.cards_can_have_children = flags[child.board_id]
        if not link_allowed(parent.board, child.board):
            raise CodedValidationError(
                "link_not_allowed",
                "A parent must be on a board whose cards can have children, and "
                "the child on a board whose cards cannot.",
            )
        # Defense in depth for "exactly two tiers": the board predicate makes
        # these unreachable while every flag flip goes through check_flag_flip.
        if CardParentLink.objects.filter(parent_id=child.pk).exists():
            raise CodedValidationError("child_is_parent", "This card has children, so it cannot have a parent.")
        if CardParentLink.objects.filter(child_id=parent.pk).exists():
            raise CodedValidationError("parent_is_child", "That card has a parent, so it cannot have children.")
        existing = CardParentLink.objects.filter(child_id=child.pk).first()
        if existing is not None:
            if existing.parent_id == parent.pk:
                raise CodedValidationError("link_exists", "This card is already linked to that parent.")
            raise CodedValidationError("already_has_parent", "This card already has a parent. Unlink it first.")
        siblings = CardParentLink.objects.filter(parent_id=parent.pk)
        # One child board per parent (epic #2206 decision A, enforced pending
        # the owner's confirmation; relaxing it later is backward compatible).
        if siblings.exclude(child__board_id=child.board_id).exists():
            raise CodedValidationError(
                "children_on_other_board",
                "That parent's children are on another board. All of a parent's "
                "children live on one board.",
            )
        if siblings.count() >= CHILDREN_PER_PARENT_LIMIT:
            raise CodedValidationError(
                "children_limit",
                f"That parent has {CHILDREN_PER_PARENT_LIMIT} children (the limit).",
            )
        link = CardParentLink.objects.create(parent=parent, child=child, created_by=user)
        _record(child.pk, CardActivity.EventType.PARENT_LINKED, user)
        _record(parent.pk, CardActivity.EventType.CHILD_LINKED, user)
        _announce(parent.board_id, parent.pk, child.board_id, child.pk, user.id)
    return link


def remove_link(link, *, actor, moved_from=None):
    """Delete ``link`` and record it on both cards and both boards.

    Authorization is the caller's: either end may unlink, with MEMBER or
    higher on the board of the end it acts from (threat model decision 3).
    Unlinking edits only the caller's own card's link, so a child-board member
    who cannot open the parent may still remove it.
    """
    with transaction.atomic():
        boards_now = _lock_endpoints(link.parent_id, link.child_id)
        deleted, _ = CardParentLink.objects.filter(pk=link.pk).delete()
        if not deleted:
            # A concurrent unlink won; answer as for a link that is gone.
            raise NotFound()
        _record(link.child_id, CardActivity.EventType.PARENT_UNLINKED, actor)
        _record(link.parent_id, CardActivity.EventType.CHILD_UNLINKED, actor)
        # ``moved_from`` names the board a card is LEAVING: an admin move
        # unlinks after the card row already points at its new board, and the
        # board whose clients still show the link is the old one.
        moved_from = moved_from or {}

        def board_of(card_id, fallback):
            return moved_from.get(card_id) or boards_now.get(card_id, fallback)

        _announce(
            board_of(link.parent_id, link.parent.board_id), link.parent_id,
            board_of(link.child_id, link.child.board_id), link.child_id,
            getattr(actor, "id", None),
        )


def unlink_all(card, *, actor=None, old_board_id=None):
    """Remove every link ``card`` takes part in, either end.

    For paths that move a card to another board (the Django admin): a moved
    child would split its parent's one child board, and a moved parent could
    land on a child tier. Called inside the caller's transaction.

    The caller already holds ``card``'s row lock, so :func:`remove_link`
    locks the peer after it: a named lock-order residual (#2383), see
    ``CardAdmin.save_model`` and ``docs/development/security-invariants.md``.
    """
    links = CardParentLink.objects.select_related("parent", "child").filter(
        Q(child_id=card.pk) | Q(parent_id=card.pk)
    ).order_by("pk")
    moved_from = {card.pk: old_board_id} if old_board_id else None
    for link in list(links):
        remove_link(link, actor=actor, moved_from=moved_from)


def announce_card_removal(card, *, actor=None):
    """Record what deleting ``card`` does to its links, before the delete.

    The single-card form of :func:`announce_cards_removal`, for
    ``services.cards.delete_card``.
    """
    announce_cards_removal(Card.objects.filter(pk=card.pk), actor=actor)


def announce_cards_removal(cards, *, actor=None):
    """Record what deleting the ``cards`` queryset does to their links, before the delete.

    The link rows CASCADE away with the cards, so this must run first, inside
    the delete's transaction: every path that deletes cards calls it next to
    ``blocked_peers_of`` (the card delete, the Django-admin card, column,
    swimlane and board deletes, and the REST column, swimlane and board
    destroys). Each SURVIVING peer records the unlink in its own history, and
    only the peer's board gets a ping: a deleted child pings its parent's board
    (``card.children_changed``), a deleted parent pings each child's board
    (``card.parent_changed``). This is what gives a deleted child board's
    parents, and a deleted parent board's children, their history entry
    (Lifecycle, #1104). A link whose two ends are both deleted is skipped:
    nothing survives to read it. The deleted cards' own boards already get
    their ``card.deleted`` / container-deleted event. Pings carry ids only and
    are published on commit (``record_board_event``).

    **Lock order (named residual, #2383):** the caller already holds the
    deleted cards' locks, and the history rows inserted here take a key-share
    lock on each peer card. That is card-then-peer, not the "both boards, then
    both cards, in pk order" of :func:`_lock_endpoints`. Against a concurrent
    link write taking the opposite order, Postgres aborts one of the two
    transactions with a deadlock error; neither commits a partial state. See
    ``docs/development/security-invariants.md``.
    """
    actor_id = getattr(actor, "id", None)
    links = list(
        CardParentLink.objects.filter(Q(child__in=cards) | Q(parent__in=cards))
        .values_list("parent_id", "parent__board_id", "child_id", "child__board_id")
        .order_by("pk")
    )
    if not links:
        return
    deleted = set(cards.values_list("pk", flat=True))
    parents = {}  # parent_id -> its board, for each surviving parent of a deleted child
    children_by_board = {}  # child board -> surviving child ids of a deleted parent
    for parent_id, parent_board_id, child_id, child_board_id in links:
        if child_id in deleted and parent_id not in deleted:
            parents[parent_id] = parent_board_id
        elif parent_id in deleted and child_id not in deleted:
            children_by_board.setdefault(child_board_id, []).append(child_id)
    for parent_id in sorted(parents):
        _record(parent_id, CardActivity.EventType.CHILD_UNLINKED, actor)
        _broadcast.record_board_event(
            parents[parent_id], _broadcast.EVT_CARD_CHILDREN_CHANGED,
            {"parent_id": parent_id}, actor_id=actor_id,
        )
    for child_board_id in sorted(children_by_board):
        child_ids = sorted(children_by_board[child_board_id])
        for child_id in child_ids:
            _record(child_id, CardActivity.EventType.PARENT_UNLINKED, actor)
        _broadcast.record_board_event(
            child_board_id, _broadcast.EVT_CARD_PARENT_CHANGED,
            {"card_ids": child_ids}, actor_id=actor_id,
        )


# ─── Read path ───────────────────────────────────────────────────────────────


def children_for_viewer(parent, user, *, offset=0, limit=50):
    """The one children read for every transport. Computed per viewer.

    Returns ``{"count", "visible", "offset", "limit", "results"}``. All of a
    parent's children are on one board, so the viewer either can open that
    board (``visible`` true, rows with titles) or cannot (``visible`` false,
    ``results`` empty, ``count`` only: the accepted disclosure). No board,
    column or card id is returned for a board the viewer cannot open.

    The role is resolved on every call with ``get_board_roles``, never cached,
    so a viewer who loses the child board stops seeing titles on the next
    request (Rules 2 and 3).
    """
    links = CardParentLink.objects.filter(parent_id=parent.pk)
    count = links.count()
    out = {"count": count, "visible": False, "offset": offset, "limit": limit, "results": []}
    if count == 0:
        out["visible"] = True
        return out
    child_board_id = links.values_list("child__board_id", flat=True).first()
    child_board = (
        Board.objects.select_related(GROUP_ANCESTOR_SELECT_RELATED).filter(pk=child_board_id).first()
    )
    if child_board is None or get_board_roles(user, [child_board])[child_board.pk] is None:
        return out
    out["visible"] = True
    cards = (
        Card.objects.filter(parent_link__parent_id=parent.pk)
        .select_related("column", "swimlane")
        .order_by("pk")[offset:offset + limit]
    )
    out["results"] = [
        {
            "id": c.pk,
            "title": c.title,
            "board_id": c.board_id,
            "column_id": c.column_id,
            "column_name": c.column.name,
            "swimlane_id": c.swimlane_id,
            "swimlane_name": c.swimlane.name,
            "archived": c.archived_at is not None,
        }
        for c in cards
    ]
    return out
