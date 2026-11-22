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
are absent from MCP and export, pinned by
``boards/tests/test_card_link_transport_parity.py``; link writes have their
own ``card_link_write`` throttle scope, and the children read has a
query-count case at the cap in ``boards/tests/test_query_counts.py`` (#2383).

**Why every read is per viewer:** a link crosses an authorization boundary.
Whoever can open the parent board is not necessarily able to open the child
board, and the reverse. A child board the viewer has no role on is reported
as a count only (owner sign-off 2026-11-17, decision B), never a title, board,
column or id.
"""

from django.db import connection, transaction
from django.db.models import (
    Case, Count, Exists, F, IntegerField, Min, OuterRef, Prefetch, Q, Subquery, Value, When, Window,
)
from django.db.models.functions import Lower, RowNumber
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError

from visiban.exceptions import CodedValidationError

from .. import broadcast as _broadcast
from ..models import (
    Board, BoardMembership, Card, CardActivity, CardMovement, CardParentLink, CardRelation, Column, Label,
)
from ..permissions import GROUP_ANCESTOR_SELECT_RELATED, SITE_ADMIN, get_board_roles
from .errors import LinksChanged

#: Hard cap on the children of one parent (threat model: write amplification
#: and rollup cost). Enforced under the parent card's row lock.
CHILDREN_PER_PARENT_LIMIT = 100

#: Roles that may create or remove a link on a board. An allow-list, as for
#: ``CardViewSet.relations``: a link changes how another card reads for
#: everyone on its board, so it sits on the card-state side of the
#: collaborator line.
LINK_WRITE_ROLES = (BoardMembership.Role.MEMBER, BoardMembership.Role.ADMIN, SITE_ADMIN)

#: Most boards an options list (the Add child chooser, the Rules page's default
#: child board select) returns; the response carries ``boards_total`` so a
#: client can say "showing 100 of N" (#2449). Same number as the children cap,
#: so for a site admin the list is bounded like every other child read.
CHILD_BOARD_OPTIONS_LIMIT = CHILDREN_PER_PARENT_LIMIT

_PERM_DENIED = "You do not have permission to perform this action."


def link_allowed(parent_board, child_board) -> bool:
    """True when a link from ``parent_board``'s card to ``child_board``'s card is allowed.

    Requires the parent board to be a parent tier and the child board to be a
    child tier. The same board on both sides fails the second condition.
    """
    # The column is a non-nullable BooleanField, so plain truthiness equals the
    # old identity checks; they tripped Sonar S2583 (always-false) without
    # guarding anything.
    return bool(parent_board.cards_can_have_children) and not child_board.cards_can_have_children


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


def boards_defaulting_to(board):
    """The other boards whose ``default_child_board`` is ``board`` (#2208 part 2).

    While any exist, ``board`` must stay a child tier: turning its flag ON
    would leave those boards' Add child pointing at a parent tier. Callers that
    must be exact hold ``board``'s row lock, which the default write also takes
    on its target (``BoardViewSet.perform_update``), so a flip and a default
    write serialize.
    """
    return Board.objects.filter(default_child_board_id=board.pk).exclude(pk=board.pk)


def flag_flip_refusal(board, new_value: bool):
    """The message refusing a flip of ``board``'s flag to ``new_value``, or ``None``.

    One rule for the REST PATCH and the Django admin. A no-op (``None``) when
    the value is unchanged. Turning the flag off on a board whose cards have
    children stays refused (the turn-off confirm is a later step of #2208).
    """
    if new_value == board.cards_can_have_children:
        return None
    blocking = links_blocking_flag_flip(board, new_value)
    if blocking:
        return (
            f"Cannot change this setting while {blocking} card link(s) depend on it. "
            "Remove those links first."
        )
    if new_value and boards_defaulting_to(board).exists():
        return (
            "This board is the default child board of another board. Clear that "
            "default first."
        )
    return None


def check_flag_flip(board, new_value: bool) -> None:
    """Raise a 400 when changing the flag to ``new_value`` would break existing links.

    Also refused (#2208 part 2): turning it ON while this board is another
    board's ``default_child_board``. A no-op when the value is unchanged.
    """
    message = flag_flip_refusal(board, new_value)
    if message:
        raise ValidationError({"cards_can_have_children": [message]})


# ─── Default child board (#2208 part 2) ──────────────────────────────────────


def first_column_and_lane(board):
    """``(column, swimlane)`` where Add child puts a new child on ``board``.

    The first column by position and the first lane by position, as the board
    renders them. Either is ``None`` when the board has none.
    """
    from ..models import Column, Swimlane

    column = Column.objects.filter(board_id=board.pk).order_by("position", "pk").first()
    lane = Swimlane.objects.filter(board_id=board.pk).order_by("position", "pk").first()
    return column, lane


def board_qualifies_as_child(board) -> bool:
    """True when ``board`` can be a default child board / Add child target.

    It must be a child tier (two tiers, never three) and its first column
    must allow card creation, since that is where Add child puts the card. A
    missing board fails closed (#1075). Judged at use, never cached: a later
    column edit makes a stored default stop qualifying without clearing it.
    """
    if board is None or board.cards_can_have_children:
        return False
    column, lane = first_column_and_lane(board)
    return column is not None and lane is not None and column.allow_card_creation


def default_child_blockers_for_viewer(board, user):
    """What stands in the way of turning ``board``'s flag ON, for the Rules page.

    ``{"child_cards": N, "parent_cards": M, "default_of": [...]}``:
    ``child_cards`` are this board's cards that are children of other cards
    (blocks ON), ``parent_cards`` this board's cards that have children (blocks
    OFF, the shipped refusal), and ``default_of`` the boards whose default
    child board this is (blocks ON). Each ``default_of`` entry is
    ``{"id", "name", "can_change"}`` when ``user`` can open that board, else
    ``{"hidden": True}``: no name or id for a board the viewer cannot open
    (Rule 8). The caller has already checked ADMIN on ``board``. No user
    fails closed to every source hidden (#1075).
    """
    child_cards = CardParentLink.objects.filter(child__board_id=board.pk).count()
    parent_cards = (
        CardParentLink.objects.filter(parent__board_id=board.pk)
        .values("parent_id").distinct().count()
    )
    sources = list(
        boards_defaulting_to(board).select_related(GROUP_ANCESTOR_SELECT_RELATED).order_by(Lower("name"), "pk")
    )
    viewer = user is not None and getattr(user, "is_authenticated", False)
    roles = get_board_roles(user, sources) if sources and viewer else {}
    default_of = []
    for b in sources:
        role = roles.get(b.pk)
        if role is None:
            default_of.append({"hidden": True})
        else:
            default_of.append({
                "hidden": False, "id": b.pk, "name": b.name,
                "can_change": role in (BoardMembership.Role.ADMIN, SITE_ADMIN),
            })
    return {"child_cards": child_cards, "parent_cards": parent_cards, "default_of": default_of}


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


def lock_board_rows(board_pks):
    """Lock ``board_pks`` ``FOR NO KEY UPDATE`` in pk order (no-op on SQLite).

    The board half of :func:`_lock_endpoints`, for writes that hold boards but
    no card: the default-child-board PATCH and :func:`create_child`.
    """
    if not connection.features.has_select_for_update:
        return
    list(
        Board.objects.select_for_update(no_key=True)
        .filter(pk__in=sorted(set(board_pks)))
        .order_by("pk")
        .values_list("pk", flat=True)
    )


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


def lock_card_and_link_peers(card_id):
    """Lock ``card_id`` and every card linked to it, ``FOR UPDATE``, in pk order (#2383).

    For a path that is about to lock one card and then touch its link peers:
    the REST card delete (``services.cards.delete_card``, whose
    :func:`announce_card_removal` inserts a history row that takes a key-share
    lock on each surviving peer) and the Django-admin card delete and move
    (``CardAdminForm.clean``, ``CardAdmin._lock_cell_entry`` and
    ``CardAdmin.delete_model``; a move then unlinks through
    :func:`unlink_all`). Without it those paths held their own card first and
    the peer second, while the link writes hold "both cards, in pk order"
    (:func:`_lock_endpoints`): against a link write naming the same pair the
    other way round, PostgreSQL aborted one of the two with a deadlock error.
    Taken here first, the caller's later lock on its own card is one it
    already holds, so it queues behind a link write in the same order.

    Call it before the caller's own card lock, inside its transaction. The
    card itself is always locked, links or not, so no link can be created on
    it before the caller's own lock follows.

    The peer set is read before the lock (a lock statement cannot name rows
    it has not read), so a link committed between that read and the lock
    would leave a peer unlocked (#2409). Once the card is held no new link can
    name it (a link write locks both cards), so the peers are re-read under
    the lock; if one is not among the rows locked, the attempt is rolled back
    to a savepoint, which releases its row locks, and repeated, the shape of
    ``services.cards.lock_cards_for_cascade``. Locking the newcomer in a
    second statement instead would take a lower pk after a higher one. A card
    whose links change on every one of ``_PEER_LOCK_ATTEMPTS`` attempts raises
    ``LinksChanged`` (409) with nothing written. Outside a transaction the
    locks would end with their own statement, so the helper refuses to run
    (``RuntimeError``) rather than silently taking nothing (#1075).
    No-op on SQLite, as in :func:`_lock_endpoints`.
    """
    if not connection.features.has_select_for_update:
        return
    if not transaction.get_connection().in_atomic_block:
        raise RuntimeError("lock_card_and_link_peers must run inside transaction.atomic()")
    for _attempt in range(_PEER_LOCK_ATTEMPTS):
        try:
            with transaction.atomic():
                locked = _lock_cards_in_pk_order({card_id} | link_peer_pks([card_id]))
                if not link_peer_pks([card_id]) <= locked:
                    raise _PeerSetChanged()
            return
        except _PeerSetChanged:
            continue
    raise LinksChanged()


# How many times lock_card_and_link_peers re-takes its locks when a link
# committed between its peer read and its lock (#2409). One retry covers the
# ordinary race; the bound only exists so a card under constant relinking
# ends in a 409, not a loop.
_PEER_LOCK_ATTEMPTS = 3


class _PeerSetChanged(Exception):
    """Internal: a link to the card committed before its lock was granted."""


def link_peer_pks(cards):
    """The pks of both ends of every link that names a card in ``cards``.

    ``cards`` is a ``Card`` queryset or an iterable of pks. Read without a
    lock; the lock takers (:func:`lock_card_and_link_peers` and
    ``services.cards.lock_cards_for_cascade``) call it once to decide what to
    lock and again under the lock to check nothing was missed (#2409). The
    result includes the linked cards of ``cards`` themselves.
    """
    pks = set()
    for parent_id, child_id in CardParentLink.objects.filter(
        Q(parent_id__in=cards) | Q(child_id__in=cards)
    ).values_list("parent_id", "child_id"):
        pks.update((parent_id, child_id))
    return pks


def _lock_cards_in_pk_order(pks):
    """Lock ``pks`` ``FOR UPDATE`` in one pk-ordered statement; return the pks locked."""
    return frozenset(
        Card.objects.select_for_update()
        .filter(pk__in=sorted(pks))
        .order_by("pk")
        .values_list("pk", flat=True)
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
    # The other children's "N of M siblings done" just changed (#2443).
    _announce_siblings(
        CardParentLink.objects.filter(parent_id=parent_id, child__archived_at__isnull=True)
        .values_list("parent_id", "child_id", "child__board_id"),
        actor_id=actor_id, exclude={child_id},
    )


def _announce_siblings(rows, *, actor_id, exclude=(), changed=()):
    """Ping each child board that a parent's sibling counts changed (#2443).

    ``Card.parent.siblings_total`` / ``siblings_done`` are on every child of a
    parent, so a link, unlink, archive, restore, delete, move, block or
    unblock of ONE child makes its siblings' copies stale. Write responses and
    ``card.*`` frames never carry ``parent`` (it is per reader), so the
    siblings are told here: one ``card.parent_changed`` per (parent, child
    board) with ``{"card_ids": [...], "siblings": true}``.

    ``rows`` is ``(parent_id, child_id, child_board_id)`` for LIVE children,
    read after the write. ``exclude`` drops ids that get their own frame (the
    child just linked or unlinked, or a deleted card). ``changed`` names the
    cards the write touched: a pair whose only live child is one of them is
    skipped, since the line is shown for two or more and nothing else reads
    the counts.

    Ids only, all on the board the frame goes to and all children of one
    parent: what a member there already sees on each card's face, never a
    parent id, title or count (Rule 8 and its timing residual). ``siblings``
    tells a client the listed cards share ONE parent, so it may read one of
    them and apply that ``parent`` to all; an older client reads each, or
    re-reads the board above its own cap, which is equally right. At most
    ``CHILDREN_PER_PARENT_LIMIT`` ids per frame (the write-side cap).
    Published on commit by ``record_board_event``.
    """
    exclude = set(exclude)
    changed = set(changed)
    by_pair = {}
    for parent_id, child_id, child_board_id in rows:
        if child_id not in exclude:
            by_pair.setdefault((parent_id, child_board_id), []).append(child_id)
    for parent_id, child_board_id in sorted(by_pair):
        ids = sorted(by_pair[(parent_id, child_board_id)])
        if len(ids) == 1 and ids[0] in changed:
            continue
        _broadcast.record_board_event(
            child_board_id, _broadcast.EVT_CARD_PARENT_CHANGED,
            {"card_ids": ids, "siblings": True}, actor_id=actor_id,
        )


def _check_link_rules_under_lock(parent, child_board, *, child=None):
    """Every link rule that reads other rows, for :func:`create_link` and :func:`create_child`.

    Call with both boards and the parent card locked (``child`` too, when it
    exists). One helper so the two writes refuse with the same codes in the
    same precedence. ``child`` is ``None`` for Add child: a card created in
    this transaction has no links to check.
    """
    flags = dict(
        Board.objects.filter(pk__in=[parent.board_id, child_board.pk])
        .values_list("pk", "cards_can_have_children")
    )
    parent.board.cards_can_have_children = flags[parent.board_id]
    child_board.cards_can_have_children = flags[child_board.pk]
    if not link_allowed(parent.board, child_board):
        raise CodedValidationError(
            "link_not_allowed",
            "A parent must be on a board whose cards can have children, and "
            "the child on a board whose cards cannot.",
        )
    # Defense in depth for "exactly two tiers": the board predicate makes
    # these unreachable while every flag flip goes through check_flag_flip.
    if child is not None and CardParentLink.objects.filter(parent_id=child.pk).exists():
        raise CodedValidationError("child_is_parent", "This card has children, so it cannot have a parent.")
    if CardParentLink.objects.filter(child_id=parent.pk).exists():
        raise CodedValidationError("parent_is_child", "That card has a parent, so it cannot have children.")
    if child is not None:
        existing = CardParentLink.objects.filter(child_id=child.pk).first()
        if existing is not None:
            if existing.parent_id == parent.pk:
                raise CodedValidationError("link_exists", "This card is already linked to that parent.")
            raise CodedValidationError("already_has_parent", "This card already has a parent. Unlink it first.")
    # #2447 (owner decision 2026-11-22): no new child under an ARCHIVED parent,
    # on either write. Checked after ``link_exists`` on purpose: re-saving the
    # link a child already has keeps its old answer, and archiving or
    # restoring a parent never touches the links it already has. Read under
    # the parent card's lock, so an archive that commits first is seen.
    if Card.objects.filter(pk=parent.pk, archived_at__isnull=False).exists():
        raise CodedValidationError(
            "parent_archived", "That card is archived, so it cannot get new children. Restore it first.",
        )
    siblings = CardParentLink.objects.filter(parent_id=parent.pk)
    # One child board per parent (epic #2206 decision A): nothing ever splits
    # a parent's children across boards, not a link and not Add child.
    if siblings.exclude(child__board_id=child_board.pk).exists():
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
        _check_link_rules_under_lock(parent, child.board, child=child)
        link = CardParentLink.objects.create(parent=parent, child=child, created_by=user)
        _record(child.pk, CardActivity.EventType.PARENT_LINKED, user)
        _record(parent.pk, CardActivity.EventType.CHILD_LINKED, user)
        _announce(parent.board_id, parent.pk, child.board_id, child.pk, user.id)
    return link


def _positive_id(value):
    """``value`` as a positive int id, or ``None`` (a bool, float or text is not an id)."""
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        return None
    try:
        pk = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return pk if 0 < pk < 2**63 else None


def resolve_child_board(user, parent_board, board_id):
    """The board Add child may create a child on, with the user's role, or ``NotFound``.

    Looked up only among the boards ``user`` can open. A missing id, a board
    the user cannot open, one where they hold less than MEMBER, one that does
    not qualify (:func:`board_qualifies_as_child`) and the parent's own board
    all raise the SAME ``NotFound`` (Rule 7). No user fails closed (#1075).
    """
    pk = _positive_id(board_id)
    if pk is None or user is None or not getattr(user, "is_authenticated", False):
        raise NotFound()
    board = (
        _accessible_boards(user).select_related(GROUP_ANCESTOR_SELECT_RELATED).filter(pk=pk).first()
    )
    if board is None or board.pk == parent_board.pk:
        raise NotFound()
    role = get_board_roles(user, [board])[board.pk]
    if role not in LINK_WRITE_ROLES or not board_qualifies_as_child(board):
        raise NotFound()
    return board, role


def create_child(*, user, parent, parent_role, board_id, make_card):
    """Add child (#2208): create a card on ``board_id`` and link it under ``parent``, atomically.

    One request, one transaction: a child that cannot be linked is never
    created. Authorization: MEMBER or higher on both boards
    (``LINK_WRITE_ROLES``). The card goes in the target board's first column,
    which must allow card creation, and first lane; that cell's limits apply
    as for any create (``make_card`` is the view's closure over
    ``services.cards.create_card``, which enforces them).

    **Lock order:** both boards ``FOR NO KEY UPDATE`` in pk order, then the
    parent card ``FOR UPDATE``, then (inside ``create_card``) the child board
    ``FOR SHARE`` (already held more strongly, so no wait) and the target
    column. Boards first is the order every container delete
    (``lock_cards_for_cascade``) and :func:`create_link` take, so Add child
    racing a board delete, a flag flip, a default write or a link of the same
    parent queues at the board rows instead of deadlocking. Calling
    ``create_card`` and then :func:`create_link` as two steps would take the
    child board ``FOR SHARE`` and then ask to upgrade it, which deadlocks two
    concurrent Add childs.

    Returns the ``CardMutationResult`` of the create.
    """
    if parent_role not in LINK_WRITE_ROLES:
        raise PermissionDenied(_PERM_DENIED)
    child_board, child_role = resolve_child_board(user, parent.board, board_id)
    with transaction.atomic():
        lock_board_rows([parent.board_id, child_board.pk])
        if connection.features.has_select_for_update:
            locked = (
                Card.objects.select_for_update().filter(pk=parent.pk)
                .values_list("board_id", flat=True).first()
            )
        else:
            locked = Card.objects.filter(pk=parent.pk).values_list("board_id", flat=True).first()
        if locked != parent.board_id:
            raise NotFound()
        # The roles were read before the locks: re-derive them now, so a member
        # removed or demoted in that window cannot still put a card on the board.
        roles = get_board_roles(user, [parent.board, child_board])
        if roles.get(parent.board_id) not in LINK_WRITE_ROLES:
            raise PermissionDenied(_PERM_DENIED)
        if roles.get(child_board.pk) not in LINK_WRITE_ROLES:
            raise NotFound()
        child_role = roles[child_board.pk]
        _check_link_rules_under_lock(parent, child_board)
        column, lane = first_column_and_lane(child_board)
        if column is None or lane is None or not column.allow_card_creation:
            # The target stopped qualifying after the lookup (a column edit).
            raise NotFound()
        result = make_card(board=child_board, role=child_role, column=column, swimlane=lane)
        CardParentLink.objects.create(parent=parent, child=result.card, created_by=user)
        _record(result.card.pk, CardActivity.EventType.PARENT_LINKED, user)
        _record(parent.pk, CardActivity.EventType.CHILD_LINKED, user)
        _announce(parent.board_id, parent.pk, child_board.pk, result.card.pk, user.id)
    return result


def _qualifying(boards_qs):
    """``boards_qs`` narrowed to boards that qualify as child boards, in one query.

    The bulk form of :func:`board_qualifies_as_child`: same rule.
    """
    from django.db.models import Exists

    from ..models import Column, Swimlane

    first_creates = Subquery(
        Column.objects.filter(board_id=OuterRef("pk")).order_by("position", "pk")
        .values("allow_card_creation")[:1]
    )
    return (
        boards_qs.filter(cards_can_have_children=False)
        .annotate(_first_creates=first_creates, _has_lane=Exists(Swimlane.objects.filter(board_id=OuterRef("pk"))))
        .filter(_first_creates=True, _has_lane=True)
    )


def child_board_options_for_viewer(parent, user):
    """What the Add child chooser offers ``user`` for ``parent`` (#2208). Per viewer.

    ``{"fixed_board", "default", "boards", "can_set_default"}``:

    * ``fixed_board``: the board ``parent``'s children are already on (one
      child board per parent: Add child must use it), ``{"id", "name"}`` when
      the viewer can open it, ``{"hidden": True}`` when not (Add child is then
      unavailable to them), ``None`` when the parent has no children yet.
    * ``default``: the parent board's ``default_child_board`` as ``{"id",
      "name"}``, only when the viewer holds MEMBER or higher there and it still
      qualifies; else ``None``, and the chooser asks.
    * ``boards``: every qualifying board where the viewer holds MEMBER or
      higher, by name, each with ``can_set_default`` (ADMIN on both boards).
    * ``can_set_default``: ADMIN on the parent's board.
    * ``boards_total`` (since 1.3, #2449): how many boards qualify; ``boards``
      holds at most :data:`CHILD_BOARD_OPTIONS_LIMIT` of them, by name.
      ``default`` is resolved over every qualifying board and is always in
      ``boards`` (it takes the last slot when it sorts past the cap), so the
      chooser can preselect it.
    * ``disabled_reason`` (#2447): ``"parent_archived"`` when ``parent`` is
      archived (the POST refuses it with that code), else ``None``.

    Empty (no boards, no default) when the parent's board is not a parent
    tier. No user fails closed to the empty answer (#1075).

    Cost is flat in the number of boards (#2449, pinned in
    ``test_query_counts.ChildBoardOptionsReadQueryCountTests``): one candidate
    query, one ``get_board_roles`` batch for all of them.
    """
    out = {
        "fixed_board": None, "default": None, "boards": [], "can_set_default": False,
        "boards_total": 0, "disabled_reason": None,
    }
    if user is None or not getattr(user, "is_authenticated", False):
        return out
    parent_board = parent.board
    if not parent_board.cards_can_have_children:
        return out
    parent_role = get_board_roles(user, [parent_board])[parent_board.pk]
    if parent_role is None:
        return out
    admin_here = parent_role in (BoardMembership.Role.ADMIN, SITE_ADMIN)
    out["can_set_default"] = admin_here
    if parent.archived_at is not None:
        out["disabled_reason"] = "parent_archived"
    fixed_id = (
        CardParentLink.objects.filter(parent_id=parent.pk).order_by("pk")
        .values_list("child__board_id", flat=True).first()
    )
    if fixed_id is not None:
        fixed = Board.objects.select_related(GROUP_ANCESTOR_SELECT_RELATED).filter(pk=fixed_id).first()
        fixed_role = get_board_roles(user, [fixed])[fixed.pk] if fixed is not None else None
        if fixed_role is None:
            out["fixed_board"] = {"hidden": True}
        else:
            # ``can_add`` is the POST's own rule, so the dialog never offers a
            # target the write always refuses (a viewer there, or a first
            # column that stopped allowing card creation).
            out["fixed_board"] = {
                "hidden": False, "id": fixed.pk, "name": fixed.name,
                "can_add": fixed_role in LINK_WRITE_ROLES and board_qualifies_as_child(fixed),
            }
    candidates = list(
        _qualifying(_accessible_boards(user).exclude(pk=parent_board.pk))
        .select_related(GROUP_ANCESTOR_SELECT_RELATED)
        .order_by(Lower("name"), "pk")
    )
    roles = get_board_roles(user, candidates) if candidates else {}
    rows = []
    for b in candidates:
        role = roles.get(b.pk)
        if role not in LINK_WRITE_ROLES:
            continue
        if b.pk == parent_board.default_child_board_id:
            out["default"] = {"id": b.pk, "name": b.name}
        rows.append({
            "id": b.pk, "name": b.name,
            "can_set_default": admin_here and role in (BoardMembership.Role.ADMIN, SITE_ADMIN),
        })
    out["boards_total"] = len(rows)
    out["boards"] = _options_page(rows, out["default"] and out["default"]["id"])
    return out


def _options_page(rows, keep_id):
    """At most :data:`CHILD_BOARD_OPTIONS_LIMIT` of ``rows`` (in name order), always with ``keep_id``'s row (#2449).

    The chooser preselects the default, and the Rules page select shows the
    current default, so that board must be in the page even when it sorts past
    the cap: it takes the last slot. ``keep_id`` of ``None``, or one not in
    ``rows``, is the plain first page.
    """
    page = rows[:CHILD_BOARD_OPTIONS_LIMIT]
    if keep_id is None or any(r["id"] == keep_id for r in page):
        return page
    kept = next((r for r in rows if r["id"] == keep_id), None)
    return page if kept is None else [*rows[:CHILD_BOARD_OPTIONS_LIMIT - 1], kept]


def default_child_board_options_for_admin(board, user):
    """Boards ``user`` may pick as ``board``'s default child board (#2208). Per viewer.

    Qualifying boards (not a parent tier, first column creates cards, has a
    lane) where the viewer is ADMIN: setting a default needs ADMIN on both
    boards. Same rule the write's validator applies, so the select never offers
    a board the PATCH would refuse.

    Returns ``{"boards": [...], "boards_total": N}`` (#2449): at most
    :data:`CHILD_BOARD_OPTIONS_LIMIT` boards by name, and how many qualify in
    all. ``board``'s current default child board, when it qualifies here, is
    always in the page (:func:`_options_page`). Empty when the viewer is not ADMIN on ``board`` or there is no viewer
    (#1075 fail closed). Flat in the number of boards: one candidate query and
    one ``get_board_roles`` batch.
    """
    out = {"boards": [], "boards_total": 0}
    if user is None or not getattr(user, "is_authenticated", False):
        return out
    if get_board_roles(user, [board])[board.pk] not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
        return out
    candidates = list(
        _qualifying(_accessible_boards(user).exclude(pk=board.pk))
        .select_related(GROUP_ANCESTOR_SELECT_RELATED)
        .order_by(Lower("name"), "pk")
    )
    roles = get_board_roles(user, candidates) if candidates else {}
    rows = [
        {"id": b.pk, "name": b.name}
        for b in candidates
        if roles.get(b.pk) in (BoardMembership.Role.ADMIN, SITE_ADMIN)
    ]
    return {"boards": _options_page(rows, board.default_child_board_id), "boards_total": len(rows)}


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

    The caller must already hold ``card`` and its peers, taken in pk order by
    :func:`lock_card_and_link_peers` (#2383; the Django admin does this in
    ``CardAdminForm.clean`` and ``CardAdmin._lock_cell_entry``), so the
    :func:`remove_link` locks below are ones it already holds.
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


#: ``announce_cards_removal(reason=...)`` for a whole-board delete (#2208).
REASON_BOARD_DELETED = "board_deleted"


def _record_count(card_id, event_type, actor, count):
    """Write one history row whose only value is a count (#2208).

    Like :func:`_record`, no reference to the other card or its board: a
    number of children lost is all a parent's reader learns.
    """
    CardActivity.objects.create(card_id=card_id, event_type=event_type, actor=actor, to_value=str(count))


def announce_cards_removal(cards, *, actor=None, reason=None):
    """Record what deleting the ``cards`` queryset does to their links, before the delete.

    The link rows CASCADE away with the cards, so this must run first, inside
    the delete's transaction: every path that deletes cards calls it next to
    ``blocked_peers_of`` (the card delete, the Django-admin card, column,
    swimlane and board deletes, the REST column, swimlane and board
    destroys, and ``delete_boards_locked`` for the seed commands' ``--wipe``).
    The only card deletes that skip it are the ``benchmark`` command's and the
    fuzz hooks' cleanup of their own throwaway cards. The Django-admin user
    delete needs no call: it is refused while the user owns a board, so its
    ``Board.owner`` cascade never reaches a card. Each SURVIVING peer records the unlink in its own history, and
    only the peer's board gets a ping: a deleted child pings its parent's board
    (``card.children_changed``), a deleted parent pings each child's board
    (``card.parent_changed``). This is what gives a deleted child board's
    parents, and a deleted parent board's children, their history entry
    (Lifecycle, #1104). A link whose two ends are both deleted is skipped:
    nothing survives to read it. The deleted cards' own boards already get
    their ``card.deleted`` / container-deleted event. Pings carry ids only and
    are published on commit (``record_board_event``).

    **Lock order (#2383):** the history rows inserted here take a key-share
    lock on each peer card. A single-card delete (``delete_card``, the
    Django-admin ``delete_model``) takes the card and its peers in pk order
    first, with :func:`lock_card_and_link_peers`, so that key-share lock is
    covered by a lock it already holds. A container delete (column, swimlane,
    board, the admin bulk deletes, the seed ``--wipe``) takes its cards and
    their link peers in one pk-ordered statement in
    ``services.cards.lock_cards_for_cascade`` (#2409), so it holds every peer
    too before this runs.

    ``reason=REASON_BOARD_DELETED`` (every whole-board delete, #2208) records
    one ``children_removed_board_deleted`` row per surviving parent carrying
    how many children it lost, and ``parent_removed_board_deleted`` on each
    surviving child, instead of the plain unlink rows: "5 children removed:
    their board was deleted" for every reader, with no board name stored.
    """
    actor_id = getattr(actor, "id", None)
    board_deleted = reason == REASON_BOARD_DELETED
    links = list(
        CardParentLink.objects.filter(Q(child__in=cards) | Q(parent__in=cards))
        .values_list("parent_id", "parent__board_id", "child_id", "child__board_id")
        .order_by("pk")
    )
    if not links:
        return
    deleted = set(cards.values_list("pk", flat=True))
    parents = {}  # parent_id -> its board, for each surviving parent of a deleted child
    lost = {}  # parent_id -> how many of its children are deleted
    children_by_board = {}  # child board -> surviving child ids of a deleted parent
    for parent_id, parent_board_id, child_id, child_board_id in links:
        if child_id in deleted and parent_id not in deleted:
            parents[parent_id] = parent_board_id
            lost[parent_id] = lost.get(parent_id, 0) + 1
        elif parent_id in deleted and child_id not in deleted:
            children_by_board.setdefault(child_board_id, []).append(child_id)
    for parent_id in sorted(parents):
        if board_deleted:
            _record_count(
                parent_id, CardActivity.EventType.CHILDREN_REMOVED_BOARD_DELETED, actor, lost[parent_id],
            )
        else:
            _record(parent_id, CardActivity.EventType.CHILD_UNLINKED, actor)
        _broadcast.record_board_event(
            parents[parent_id], _broadcast.EVT_CARD_CHILDREN_CHANGED,
            {"parent_id": parent_id}, actor_id=actor_id,
        )
    if parents:
        # The surviving siblings' counts drop (#2443): one read of the live
        # children of every surviving parent, then a ping per child board.
        _announce_siblings(
            CardParentLink.objects.filter(parent_id__in=list(parents), child__archived_at__isnull=True)
            .values_list("parent_id", "child_id", "child__board_id"),
            actor_id=actor_id, exclude=deleted,
        )
    for child_board_id in sorted(children_by_board):
        child_ids = sorted(children_by_board[child_board_id])
        for child_id in child_ids:
            _record(child_id, (
                CardActivity.EventType.PARENT_REMOVED_BOARD_DELETED if board_deleted
                else CardActivity.EventType.PARENT_UNLINKED
            ), actor)
        _broadcast.record_board_event(
            child_board_id, _broadcast.EVT_CARD_PARENT_CHANGED,
            {"card_ids": child_ids}, actor_id=actor_id,
        )


def boards_losing_default(board_pks):
    """``[(pk, group_id)]`` of surviving boards whose default child board is in ``board_pks``.

    Read inside a board delete's transaction before the delete; after it the
    ``SET_NULL`` has cleared their default and each gets a ``board.updated``
    (:func:`announce_default_cleared`), so their clients drop it and Add child
    falls back to the chooser.

    The REST delete locks the referencing boards with the deleted one
    (``lock_container_cascade``), so a default PATCH cannot slip in between
    this read and the delete. The Django admin and ``delete_boards_locked``
    lock only the deleted boards: there, a PATCH that commits in that window
    still has its default cleared by ``SET_NULL``, and the only loss is that
    its ``board.updated`` is not announced (a client sees the cleared default
    on its next read).
    """
    return list(
        Board.objects.filter(default_child_board_id__in=board_pks)
        .exclude(pk__in=board_pks).order_by("pk").values_list("pk", "group_id")
    )


def announce_default_cleared(rows):
    """Record a system ``board.updated`` for each ``(pk, group_id)`` in ``rows`` (#2208).

    A loop fan-out, one event per board, published on commit by
    ``record_board_updated``. Call after the delete, inside its transaction.
    """
    from .board_events import record_board_updated, system_board_payload

    for pk, group_id in rows:
        record_board_updated(
            pk, system_board_payload(pk), old_group_id=group_id, new_group_id=group_id, actor_id=None,
        )


def board_delete_impact_for_viewer(board, user):
    """What deleting ``board`` does to card links elsewhere, for its delete confirm (#2208).

    ``{"child_cards", "parent_boards", "hidden_parent_boards", "parent_cards"}``:
    ``child_cards`` is how many of this board's cards are children of cards on
    other boards; ``parent_boards`` the boards those parents are on that
    ``user`` can open (``{"id", "name"}``, by name); ``hidden_parent_boards``
    whether any parent is on a board ``user`` cannot open (named nowhere, and
    no count per board: decision E, warn only, discloses nothing about a
    board the deleter cannot open); ``parent_cards`` how many of this board's
    cards have children elsewhere. The caller holds the delete gate. No user
    fails closed to every parent board hidden (#1075).
    """
    child_cards = CardParentLink.objects.filter(child__board_id=board.pk).exclude(parent__board_id=board.pk)
    parent_board_ids = set(child_cards.values_list("parent__board_id", flat=True))
    parent_cards = (
        CardParentLink.objects.filter(parent__board_id=board.pk).exclude(child__board_id=board.pk)
        .values("parent_id").distinct().count()
    )
    boards = list(
        Board.objects.select_related(GROUP_ANCESTOR_SELECT_RELATED)
        .filter(pk__in=parent_board_ids).order_by(Lower("name"), "pk")
    )
    viewer = user is not None and getattr(user, "is_authenticated", False)
    roles = get_board_roles(user, boards) if boards and viewer else {}
    visible = [{"id": b.pk, "name": b.name} for b in boards if roles.get(b.pk) is not None]
    return {
        "child_cards": child_cards.count(),
        "parent_boards": visible,
        "hidden_parent_boards": len(visible) < len(boards),
        "parent_cards": parent_cards,
    }


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
    # The board authorized below is the only board read from. One child board
    # per parent is a write-side rule with no database constraint, so the
    # count and the rows are both scoped to that board: a child on any other
    # board is never listed or counted under a role check it did not get.
    child_board_id = links.order_by("pk").values_list("child__board_id", flat=True).first()
    if child_board_id is None:
        return {"count": 0, "visible": True, "offset": offset, "limit": limit, "results": []}
    count = links.filter(child__board_id=child_board_id).count()
    out = {"count": count, "visible": False, "offset": offset, "limit": limit, "results": []}
    child_board = (
        Board.objects.select_related(GROUP_ANCESTOR_SELECT_RELATED).filter(pk=child_board_id).first()
    )
    child_role = get_board_roles(user, [child_board])[child_board.pk] if child_board is not None else None
    if child_role is None:
        # The hidden branch has no rows to filter client-side, so the count
        # itself must exclude archived children: they leave the tab and its
        # counts (#2209). The visible branch keeps archived rows (flagged
        # `archived`) because the client drops them and pages by this count.
        out["count"] = links.filter(child__board_id=child_board_id, child__archived_at__isnull=True).count()
        return out
    out["visible"] = True
    from accounts.serializers import BoardUserSerializer

    cards = (
        Card.objects.filter(parent_link__parent_id=parent.pk, board_id=child_board_id)
        .select_related("column", "swimlane", "assignee")
        # The blocked predicate the card face uses (#449, #1149): a manual
        # block or an active same-board blocking relation, in one query.
        .prefetch_related(Prefetch(
            "incoming_relations",
            queryset=CardRelation.objects.filter(
                relation_type=CardRelation.Type.BLOCKS,
                from_card__archived_at__isnull=True,
                from_card__board_id=F("to_card__board_id"),
            ).only("id", "to_card_id"),
            to_attr="active_blockers",
        ))
        # The card face's labels (#2209 full card anatomy): one query for the
        # page, whatever the number of children.
        .prefetch_related(Prefetch("labels", queryset=Label.objects.only("id", "name", "color").order_by("name", "pk")))
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
            # Since 1.3 (#2209): what the Children tab's scoped board draws.
            "position": c.position,
            "assignee": BoardUserSerializer(c.assignee).data if c.assignee_id else None,
            "blocked": c.blocked_at is not None or len(c.active_blockers) > 0,
            "blocked_at": c.blocked_at.isoformat() if c.blocked_at else None,
            # Since 1.3 (#2209 full card anatomy): what the child board's own
            # card face shows next to the title, so the scoped card matches it.
            "priority": c.priority,
            "due_date": c.due_date.isoformat() if c.due_date else None,
            "labels": [{"id": lb.pk, "name": lb.name, "color": lb.color} for lb in c.labels.all()],
        }
        for c in cards
    ]
    # The child board as the lens draws it (#2209): its own columns, colors and
    # limits, each with the count of the WHOLE column ("1 of 9 on Delivery"),
    # and the viewer's role there, which alone decides Move and the link
    # writes. Only on the visible branch: a viewer who cannot open the child
    # board gets the count and nothing else (accepted disclosure, #1104).
    columns = (
        Column.objects.filter(board_id=child_board_id)
        .annotate(card_count=Count("cards", filter=Q(cards__archived_at__isnull=True)))
        .order_by("position", "pk")
    )
    out["board"] = {
        "id": child_board.pk,
        "name": child_board.name,
        "role": child_role,
        # Since 1.3 (#2209): the child board's WIP mode, so the in-sheet Move
        # picker disables exactly what the move endpoint would refuse for this
        # viewer. Advisory limits (both false) never block a move; enforced
        # limits block it except for a board admin, who can override with
        # ?force=true; a hard limit blocks every role.
        "enforce_wip_limits": child_board.enforce_wip_limits,
        "enforce_wip_hard": child_board.enforce_wip_hard,
        "columns": [
            {
                "id": col.pk, "name": col.name, "color": col.color,
                "wip_limit": col.wip_limit, "is_done": col.is_done,
                "card_count": col.card_count,
            }
            for col in columns
        ],
    }
    return out


#: The one shape a parent the viewer cannot open is reported as (P1). Only the
#: discriminator: no title, board, column, lane or id (Rule 8, #1104).
_HIDDEN_PARENT = {"hidden": True}


def parents_for_viewer(child_ids, user):
    """The one parent read for every transport (Rule 10). Computed per viewer.

    Returns ``{child_id: entry}`` for each linked card among ``child_ids``;
    an unlinked id is left out (the serializer reports it as ``null``). The
    entry is ``{"hidden": True}`` when ``user`` holds no role on the parent's
    board, else the visible shape (``hidden`` False plus ten keys; the tenth,
    ``board_parent_name_singular``, is the parent board's raw parent name, #2212).

    **Absent input fails closed** (#1075): with no user, or an anonymous one,
    every linked entry is hidden and no role is resolved. A broadcast frame is
    built with the actor's request, so the serializer never reaches this
    function from a broadcast (it has no ``CARD_PARENTS_CONTEXT_KEY``); this
    guard is for any other caller that cannot name a viewer.

    **Siblings (#2443, since 1.3):** a visible entry also carries
    ``siblings_total`` and ``siblings_done``, "2 of 5 siblings done" in the
    child's Parent block: the parent's live (unarchived) children on THIS
    child's board, the child itself included, and how many of them are in a
    done column. Counted only over the child's own board, and only when the
    viewer holds a role there (resolved in the same role batch); otherwise
    both are ``null``. A hidden parent carries no sibling data at all: which
    cards share a parent the viewer cannot open is that parent's information.
    Both are clamped to ``CHILDREN_PER_PARENT_LIMIT``, the write-side cap.

    The role is resolved on every call, never cached, so a viewer who loses
    the parent board sees ``hidden`` on the next read (Rules 2 and 3). Cost: one
    query for the links plus ``get_board_roles``'s fixed two, however many
    parents or parent boards there are, plus ONE grouped sibling count when
    any entry is visible (flat in the number of parents and children).
    """
    ids = list(child_ids)
    if not ids:
        return {}
    links = list(
        CardParentLink.objects.filter(child_id__in=ids).select_related(
            "parent__column", "parent__swimlane",
            f"parent__board__{GROUP_ANCESTOR_SELECT_RELATED}",
            f"child__board__{GROUP_ANCESTOR_SELECT_RELATED}",
        )
    )
    if not links:
        return {}
    if user is None or not getattr(user, "is_authenticated", False):
        return {link.child_id: dict(_HIDDEN_PARENT) for link in links}
    boards = {link.parent.board_id: link.parent.board for link in links}
    for link in links:
        boards.setdefault(link.child.board_id, link.child.board)
    roles = get_board_roles(user, boards.values())
    siblings = _sibling_counts(
        {
            (link.parent_id, link.child.board_id) for link in links
            if roles.get(link.parent.board_id) is not None and roles.get(link.child.board_id) is not None
        },
    )
    out = {}
    for link in links:
        p = link.parent
        if roles.get(p.board_id) is None:
            out[link.child_id] = dict(_HIDDEN_PARENT)
            continue
        if roles.get(link.child.board_id) is None:
            total = done = None
        else:
            total, done = siblings.get((p.pk, link.child.board_id), (0, 0))
        out[link.child_id] = {
            "hidden": False,
            "id": p.pk,
            "title": p.title,
            "board_id": p.board_id,
            "board_name": p.board.name,
            "column_id": p.column_id,
            "column_name": p.column.name,
            "swimlane_id": p.swimlane_id,
            "swimlane_name": p.swimlane.name,
            "archived": p.archived_at is not None,
            "board_parent_name_singular": p.board.parent_name_singular,
            "siblings_total": total,
            "siblings_done": done,
        }
    return out


def _sibling_counts(pairs):
    """``{(parent_id, child_board_id): (total, done)}`` over live children, in ONE query (#2443).

    ``pairs`` names only boards the caller has already authorized; a child of
    the same parent on any other board is never counted (one child board per
    parent is a write rule with no constraint). Zero queries for no pairs.

    ``done`` uses the parent rollup's own partition (:func:`rollups_for_viewer`):
    a blocked child (manual block, or an open ``blocks`` relation from a live
    same-board card) is blocked even in a done column, so it is not done here
    either. The child's "2 of 5 siblings done" and the parent's rollup
    therefore never disagree about the same children.
    """
    if not pairs:
        return {}
    done = Q(child__column__is_done=True, child__blocked_at__isnull=True) & ~Exists(_open_blocker_of_child())
    rows = (
        CardParentLink.objects.filter(
            parent_id__in={p for p, _ in pairs}, child__board_id__in={b for _, b in pairs},
            child__archived_at__isnull=True,
        )
        .order_by().values("parent_id", "child__board_id")
        .annotate(total=Count("pk"), done=Count("pk", filter=done))
        .values_list("parent_id", "child__board_id", "total", "done")
    )
    cap = CHILDREN_PER_PARENT_LIMIT
    return {
        (parent_id, board_id): (min(total, cap), min(done, total, cap))
        for parent_id, board_id, total, done in rows
        if (parent_id, board_id) in pairs
    }


def _accessible_boards(user):
    # Lazy: the board access rule lives with the view helpers, and importing
    # it at module load would make views -> services -> views circular.
    from ..views._helpers import get_accessible_boards_queryset

    return get_accessible_boards_queryset(user)


def parent_boards_for_viewer(user, board):
    """Boards ``user`` may link ``board``'s cards to as parents (P2).

    The boards the user can open that are a parent tier and on which the user
    holds a link-write role, ordered by name then id. Uncapped on purpose: a
    silent truncation would hide a board with no sign (#1724). Empty when
    ``board`` is itself a parent tier (two tiers, #2208).
    """
    if board.cards_can_have_children:
        return []
    candidates = list(
        _accessible_boards(user)
        .filter(cards_can_have_children=True)
        .select_related(GROUP_ANCESTOR_SELECT_RELATED)
        .order_by(Lower("name"), "pk")
    )
    roles = get_board_roles(user, candidates)
    return [
        {
            "id": b.pk,
            "name": b.name,
            "parent_name_singular": b.parent_name_singular,
            "parent_name_plural": b.parent_name_plural,
        }
        for b in candidates
        if roles.get(b.pk) in LINK_WRITE_ROLES
    ]


#: Longest ``search`` the parent picker accepts, and the most rows it returns.
PARENT_CANDIDATE_SEARCH_MAX = 200
PARENT_CANDIDATE_LIMIT = 20
# 18 digits always fit a 64-bit id; a longer digit string is matched as text
# only, so int() can never overflow the column.
_ID_SEARCH_MAX_DIGITS = 18


def resolve_parent_board(user, child_board, parent_board_id):
    """The parent board for the picker, or ``NotFound`` (P3, step 5).

    The board is looked up in the same accessible-board set as
    :func:`parent_boards_for_viewer` (P2). A board outside that set, one on
    which the user holds only a viewer/collaborator role, a child-tier board
    and ``child_board`` itself all raise the SAME ``NotFound`` (Rule 7).

    Every path runs one lookup and one role batch: when the lookup finds no
    board, the batch runs on ``child_board`` instead, so the refusal is decided
    the same way whatever the reason.
    """
    parent_board = (
        _accessible_boards(user)
        .select_related(GROUP_ANCESTOR_SELECT_RELATED)
        .filter(pk=parent_board_id)
        .first()
    )
    subject = parent_board if parent_board is not None else child_board
    role = get_board_roles(user, [subject])[subject.pk]
    if (
        parent_board is None
        or parent_board.pk == child_board.pk
        or not parent_board.cards_can_have_children
        or role not in LINK_WRITE_ROLES
    ):
        raise NotFound()
    return parent_board


def parent_candidates_for_viewer(user, child, parent_board, search):
    """Up to 20 cards on ``parent_board`` that ``child`` could be linked to (P3).

    ``parent_board`` comes from :func:`resolve_parent_board`; ``search`` is
    already stripped and length-checked by the view. A search shorter than two
    characters that is not all digits returns nothing without a card query. An
    all-digit search also matches the card id exactly, and that card sorts first.

    ``disabled_reason`` uses :func:`create_link`'s precedence and codes, so a
    row the picker offers as enabled is one the link write accepts (barring a
    race the write re-checks under its locks). ``children_board_name`` is set
    only when the viewer can open that other child board.
    """
    if child.board.cards_can_have_children:
        return []
    q = search
    digits = q.isascii() and q.isdigit() and len(q) <= _ID_SEARCH_MAX_DIGITS
    if len(q) < 2 and not digits:
        return []
    if digits:
        match = Q(pk=int(q)) | Q(title__ci_contains=q)
        exact = Case(When(pk=int(q), then=Value(0)), default=Value(1), output_field=IntegerField())
    else:
        match = Q(title__ci_contains=q)
        exact = Value(1, output_field=IntegerField())
    first_child_board = Subquery(
        CardParentLink.objects.filter(parent=OuterRef("pk"))
        .order_by("pk").values("child__board_id")[:1]
    )
    cards = list(
        Card.objects.filter(match, board_id=parent_board.pk, archived_at__isnull=True)
        .select_related("column", "swimlane", "assignee")
        .annotate(
            child_count=Count("child_links", distinct=True),
            child_board_id=first_child_board,
            exact_rank=exact,
        )
        .order_by("exact_rank", Lower("title"), "pk")[:PARENT_CANDIDATE_LIMIT]
    )
    other_board_ids = {
        c.child_board_id for c in cards
        if c.child_board_id is not None and c.child_board_id != child.board_id
    }
    named = {}
    if other_board_ids:
        other_boards = list(
            Board.objects.select_related(GROUP_ANCESTOR_SELECT_RELATED).filter(pk__in=other_board_ids)
        )
        roles = get_board_roles(user, other_boards)
        named = {b.pk: b.name for b in other_boards if roles.get(b.pk) is not None}

    from accounts.serializers import BoardUserSerializer

    rows = []
    for c in cards:
        reason = None
        board_name = None
        if c.child_board_id is not None and c.child_board_id != child.board_id:
            reason = "children_on_other_board"
            board_name = named.get(c.child_board_id)
        elif c.child_count >= CHILDREN_PER_PARENT_LIMIT:
            reason = "children_limit"
        rows.append({
            "id": c.pk,
            "title": c.title,
            "column_id": c.column_id,
            "column_name": c.column.name,
            "swimlane_id": c.swimlane_id,
            "swimlane_name": c.swimlane.name,
            "assignee": BoardUserSerializer(c.assignee).data if c.assignee_id else None,
            "disabled_reason": reason,
            "children_board_name": board_name,
        })
    return rows


CHILD_CANDIDATE_LIMIT = PARENT_CANDIDATE_LIMIT


def resolve_link_child_board(user, parent, child_board_id):
    """The child board Link existing searches, or ``NotFound`` (#2209).

    The parent-side mirror of :func:`resolve_parent_board`. The board must be
    one the user can open with MEMBER or higher, not a parent tier, not the
    parent's own board, and, once the parent has children, the board they are
    on (one child board per parent, #2206 decision A). Every refusal is the
    same ``NotFound`` (Rule 7), decided after one lookup and one role batch.
    """
    child_board = (
        _accessible_boards(user)
        .select_related(GROUP_ANCESTOR_SELECT_RELATED)
        .filter(pk=child_board_id)
        .first()
    )
    # Deliberate (Rule 7): a missing board still runs the role batch, on the
    # parent's board, so every refusal costs the same queries. Do not
    # short-circuit it.
    subject = child_board if child_board is not None else parent.board
    role = get_board_roles(user, [subject])[subject.pk]
    fixed_id = (
        CardParentLink.objects.filter(parent_id=parent.pk).order_by("pk")
        .values_list("child__board_id", flat=True).first()
    )
    if (
        child_board is None
        or child_board.pk == parent.board_id
        or child_board.cards_can_have_children
        or role not in LINK_WRITE_ROLES
        or (fixed_id is not None and fixed_id != child_board.pk)
    ):
        raise NotFound()
    return child_board


def child_candidates_for_viewer(user, parent, child_board, search):
    """Up to 20 cards on ``child_board`` that could be linked under ``parent`` (#2209).

    The parent-side mirror of :func:`parent_candidates_for_viewer`, for Link
    existing. ``child_board`` comes from :func:`resolve_link_child_board`.
    ``disabled_reason`` uses :func:`create_link`'s codes: ``link_exists``
    (already this parent's child), ``already_has_parent`` (another parent's),
    ``parent_archived`` (this parent is archived, #2447), ``children_limit``
    (this parent is full). ``parent_title`` names that other
    parent only when the viewer can open its board; otherwise it is ``null``
    and the picker says "a card you can't open".
    """
    if not parent.board.cards_can_have_children:
        return []
    q = search
    digits = q.isascii() and q.isdigit() and len(q) <= _ID_SEARCH_MAX_DIGITS
    if len(q) < 2 and not digits:
        return []
    if digits:
        match = Q(pk=int(q)) | Q(title__ci_contains=q)
        exact = Case(When(pk=int(q), then=Value(0)), default=Value(1), output_field=IntegerField())
    else:
        match = Q(title__ci_contains=q)
        exact = Value(1, output_field=IntegerField())
    cards = list(
        Card.objects.filter(match, board_id=child_board.pk, archived_at__isnull=True)
        .select_related(
            "column", "swimlane", "assignee",
            f"parent_link__parent__board__{GROUP_ANCESTOR_SELECT_RELATED}",
        )
        .annotate(exact_rank=exact)
        .order_by("exact_rank", Lower("title"), "pk")[:CHILD_CANDIDATE_LIMIT]
    )
    full = CardParentLink.objects.filter(parent_id=parent.pk).count() >= CHILDREN_PER_PARENT_LIMIT
    other_parents = {}
    for c in cards:
        link = getattr(c, "parent_link", None)
        if link is not None and link.parent_id != parent.pk:
            other_parents[link.parent.board_id] = link.parent.board
    roles = get_board_roles(user, other_parents.values()) if other_parents else {}

    from accounts.serializers import BoardUserSerializer

    rows = []
    for c in cards:
        link = getattr(c, "parent_link", None)
        reason = None
        parent_title = None
        if link is not None and link.parent_id == parent.pk:
            reason = "link_exists"
        elif link is not None:
            reason = "already_has_parent"
            if roles.get(link.parent.board_id) is not None:
                parent_title = link.parent.title
        elif parent.archived_at is not None:
            # #2447: the write refuses a new child under an archived parent.
            reason = "parent_archived"
        elif full:
            reason = "children_limit"
        rows.append({
            "id": c.pk,
            "title": c.title,
            "column_id": c.column_id,
            "column_name": c.column.name,
            "swimlane_id": c.swimlane_id,
            "swimlane_name": c.swimlane.name,
            "assignee": BoardUserSerializer(c.assignee).data if c.assignee_id else None,
            "disabled_reason": reason,
            "parent_title": parent_title,
        })
    return rows


def announce_parent_changed(card_id, board, *, actor_id):
    """Ping each child board that a parent card changed in a way its children show (P4).

    Called inside the write's transaction: ``record_board_event`` writes the
    feed row there and publishes on commit, so a rollback sends nothing.
    Ids only, never a title (the accepted timing disclosure, Rule 8 residual).
    Zero queries on a board that cannot have children; else one, and at most
    one event per child board (all of a parent's children share one board, so
    in practice one event of at most ``CHILDREN_PER_PARENT_LIMIT`` ids).
    """
    if not board.cards_can_have_children:
        return
    by_board = {}
    for child_id, child_board_id in CardParentLink.objects.filter(parent_id=card_id).values_list(
        "child_id", "child__board_id",
    ):
        by_board.setdefault(child_board_id, []).append(child_id)
    for child_board_id in sorted(by_board):
        _broadcast.record_board_event(
            child_board_id, _broadcast.EVT_CARD_PARENT_CHANGED,
            {"card_ids": sorted(by_board[child_board_id])}, actor_id=actor_id,
        )


# ─── Parent-side rollup and child-side pings (#2210, #2416) ──────────────────


def _open_blocker_of_child():
    """An open ``blocks`` relation onto a ``CardParentLink`` row's child (the #449 predicate).

    For ``Exists`` over ``CardParentLink``: from a live card on the child's own
    board. Shared by the parent rollup and the child's sibling count (#2443) so
    the two always classify a blocked child the same way.
    """
    return CardRelation.objects.filter(
        to_card_id=OuterRef("child_id"),
        relation_type=CardRelation.Type.BLOCKS,
        from_card__archived_at__isnull=True,
        from_card__board_id=OuterRef("child__board_id"),
    )


def _empty_rollup():
    return {
        "visible": True, "total": 0, "done": 0, "doing": 0, "todo": 0, "blocked": 0,
        "last_moved_at": None,
    }


def rollups_for_viewer(parent_ids, user):
    """The one parent-side child rollup for every transport (Rule 10). Per viewer.

    Returns ``{parent_id: rollup}`` with an entry for EVERY id in
    ``parent_ids`` (a parent with no children gets the zero rollup, which the
    card face shows as "No children"). A rollup is either

    * ``{"visible": True, "total", "done", "doing", "todo", "blocked",
      "last_moved_at"}`` when ``user`` holds a role on the child board, or
    * ``{"visible": False, "total"}`` when it does not: the accepted count-only
      disclosure (owner sign-off 2026-11-17, decision B). No state, timestamp,
      board, column or id of a child the viewer cannot open is returned.

    **Why per viewer and never stored or broadcast** (threat model 2026-11-14,
    risk 1): one shared number would hand every parent-board member, webhook
    and share-link viewer a live signal about a board they may not be able to
    open. So the event is the ids-only ``card.children_changed`` ping and each
    client re-reads this over REST, resolved with ``get_board_roles`` on every
    call (Rules 2 and 3: losing the child board hides the states on the next
    read). Absent viewer fails closed (#1075): no user, or an anonymous one,
    gets every non-empty rollup as hidden.

    The states partition ``total``: blocked (a manual block or an open
    ``blocks`` relation from a live same-board card, the #449 predicate)
    overrides the column; else done (``Column.is_done``); else to do (the
    child board's first column); else doing. Archived children leave the
    rollup (#2209). Like :func:`children_for_viewer`, only the board of a
    parent's first link is read.

    **Cost is fixed, not per card** (perf-check, #2210): one query for every
    live child row of every parent in ``parent_ids`` (the write side caps a
    parent at ``CHILDREN_PER_PARENT_LIMIT`` links under its row lock; the read
    itself has no LIMIT, so rows grow with parents x live children), one for the child boards with
    their first column, plus ``get_board_roles``'s fixed two. Zero queries for
    an empty ``parent_ids``.
    """
    ids = list(parent_ids)
    if not ids:
        return {}
    out = {pid: _empty_rollup() for pid in ids}
    open_blocker = _open_blocker_of_child()
    last_move = (
        CardMovement.objects.filter(card_id=OuterRef("child_id"))
        .order_by("-moved_at").values("moved_at")[:1]
    )
    rows = list(
        # Archived children leave the rollup in SQL, so their correlated
        # subqueries never run and archived history does not grow the read.
        CardParentLink.objects.filter(parent_id__in=ids, child__archived_at__isnull=True)
        .annotate(_has_blocker=Exists(open_blocker), _last_moved=Subquery(last_move))
        .order_by("pk")
        .values_list(
            "parent_id", "child__board_id", "child__blocked_at",
            "_has_blocker", "child__column__is_done", "child__column__position", "_last_moved",
        )
    )
    if not rows:
        return out
    board_of = {}  # parent -> the board of its first link, the only board read
    for parent_id, child_board_id, *_ in rows:
        board_of.setdefault(parent_id, child_board_id)
    boards = list(
        Board.objects.select_related(GROUP_ANCESTOR_SELECT_RELATED)
        .filter(pk__in=set(board_of.values()))
        .annotate(_first_position=Min("columns__position"))
    )
    first_position = {b.pk: b._first_position for b in boards}
    if user is None or not getattr(user, "is_authenticated", False):
        roles = {}
    else:
        roles = get_board_roles(user, boards)
    for parent_id, child_board_id, blocked_at, has_blocker, is_done, position, moved in rows:
        if board_of[parent_id] != child_board_id:
            continue
        r = out[parent_id]
        r["total"] += 1
        if blocked_at is not None or has_blocker:
            r["blocked"] += 1
        elif is_done:
            r["done"] += 1
        elif position == first_position.get(child_board_id):
            r["todo"] += 1
        else:
            r["doing"] += 1
        if moved is not None and (r["last_moved_at"] is None or moved > r["last_moved_at"]):
            r["last_moved_at"] = moved
    for parent_id, child_board_id in board_of.items():
        if roles.get(child_board_id) is None:
            # Count only: every other key would describe a board the viewer
            # cannot open.
            out[parent_id] = {"visible": False, "total": out[parent_id]["total"]}
    return out


def announce_children_changed(card_ids, *, board=None, actor_id):
    """Ping each parent's board that some of its children changed state (#2210).

    For the child-side writes the rollup reads: a move between columns,
    archive and restore, block and unblock, and a ``blocks`` relation gained
    or lost (directly or by its blocker being archived, restored or deleted).
    Create, delete, link and unlink already ping through :func:`_announce` and
    :func:`announce_cards_removal`.

    Ids only, ``{parent_id}``: never a count, title or state, and never the
    child's own card event (threat model 2026-11-16, risk 2; Rule 8 row). Call
    inside the write's transaction: ``record_board_event`` writes the feed row
    there and publishes on commit, so a rollback sends nothing. Zero queries
    when ``board`` is a parent tier (its cards cannot be children); else one,
    and at most one event per parent.

    **Siblings (#2443):** the same writes change the sibling counts every
    other child of those parents shows, so the same read also returns each
    parent's other links, and each child board gets
    :func:`_announce_siblings`'s ``card.parent_changed {card_ids, siblings}``.
    That covers a sibling moving into or out of a done column: ``move_card``
    calls this on every column change. Still one query.
    """
    ids = list(card_ids)
    if not ids or (board is not None and board.cards_can_have_children):
        return
    idset = set(ids)
    rows = list(
        CardParentLink.objects.filter(
            parent_id__in=CardParentLink.objects.filter(child_id__in=ids).values("parent_id"),
        ).values_list("parent__board_id", "parent_id", "child_id", "child__board_id", "child__archived_at")
    )
    pairs = sorted({(pb, p) for pb, p, c, _cb, _a in rows if c in idset})
    for parent_board_id, parent_id in pairs:
        _broadcast.record_board_event(
            parent_board_id, _broadcast.EVT_CARD_CHILDREN_CHANGED,
            {"parent_id": parent_id}, actor_id=actor_id,
        )
    _announce_siblings(
        [(p, c, cb) for _pb, p, c, cb, archived_at in rows if archived_at is None],
        actor_id=actor_id, changed=idset,
    )


#: Above this many linked children on one child board, a parent container
#: rename pings that board with ``{"card_ids": [], "reload": true}`` instead of
#: listing every id (#2416, bounded fan-out). Same as the per-parent cap, so a
#: rename of a single parent's lane always lists its children.
CONTAINER_RENAME_ID_CAP = CHILDREN_PER_PARENT_LIMIT


def announce_parent_container_renamed(board, *, column_id=None, swimlane_id=None, actor_id):
    """Ping each child board once when a parent's board, column or lane is renamed (#2416).

    ``Card.parent`` carries ``board_name``, ``column_name`` and
    ``swimlane_name``, so a rename makes them stale on every child board of
    every parent in the container. One rename can reach many parents, so the
    fan-out is coalesced and bounded: ONE ``card.parent_changed`` per child
    board, carrying the affected child ids up to
    :data:`CONTAINER_RENAME_ID_CAP`, or ``{"card_ids": [], "reload": true}``
    above it (the client re-reads the board). Ids only, the accepted timing
    disclosure (Rule 8 residual). Call inside the write's transaction;
    ``record_board_event`` publishes on commit.

    Cost: zero queries on a board that cannot have children; else at most
    two (a per-child-board count, then the ids of the boards under the cap),
    however many parents the container holds.
    """
    if not board.cards_can_have_children:
        return
    links = CardParentLink.objects.filter(parent__board_id=board.pk)
    if column_id is not None:
        links = links.filter(parent__column_id=column_id)
    if swimlane_id is not None:
        links = links.filter(parent__swimlane_id=swimlane_id)
    counts = dict(
        links.order_by().values("child__board_id").annotate(n=Count("pk"))
        .values_list("child__board_id", "n")
    )
    if not counts:
        return
    listed = sorted(b for b, n in counts.items() if n <= CONTAINER_RENAME_ID_CAP)
    by_board = {b: [] for b in listed}
    if listed:
        for child_id, child_board_id in links.filter(child__board_id__in=listed).values_list(
            "child_id", "child__board_id",
        ):
            by_board[child_board_id].append(child_id)
    for child_board_id in sorted(counts):
        if child_board_id in by_board:
            data = {"card_ids": sorted(by_board[child_board_id])}
        else:
            data = {"card_ids": [], "reload": True}
        _broadcast.record_board_event(
            child_board_id, _broadcast.EVT_CARD_PARENT_CHANGED, data, actor_id=actor_id,
        )


# ─── Column writes that re-bucket many children at once (#2500) ──────────────


def column_rollup_state(board):
    """The two column facts a child's rollup bucket reads, for one board (#2500).

    Returns ``(first_column_id, frozenset(done_column_ids))``, or ``None`` on a
    parent-tier board, whose cards cannot be children (zero queries then; one
    small read of the board's columns otherwise). Take it before a column
    write and hand it to :func:`announce_column_rollup_changed` after, under
    the same board lock, so the diff is the write's own.
    """
    if board.cards_can_have_children:
        return None
    rows = list(Column.objects.filter(board_id=board.pk).values_list("pk", "position", "is_done"))
    first = min(rows, key=lambda r: (r[1], r[0]))[0] if rows else None
    return first, frozenset(pk for pk, _pos, is_done in rows if is_done)


def announce_column_rollup_changed(board, before, *, actor_id):
    """Ping parents whose children a column write re-bucketed (#2500).

    ``before`` is :func:`column_rollup_state` taken before the write. The
    columns whose children changed bucket are those whose ``is_done`` flipped,
    plus the old and the new first column when the first column changed (a
    reorder that keeps the first column, or any other position change, moves
    no child between "to do" and "doing", so it sends nothing). Absent input
    fails safe (#1075): ``before`` of ``None`` (a parent tier, or no snapshot
    taken) sends nothing and reads nothing.
    """
    if before is None:
        return
    after = column_rollup_state(board)
    if after is None:
        return
    changed = set(before[1] ^ after[1])
    if before[0] != after[0]:
        changed |= {before[0], after[0]} - {None}
    announce_columns_children_changed(board, changed, actor_id=actor_id)


def announce_columns_children_changed(board, column_ids, *, actor_id):
    """One ``card.children_bulk_changed`` per parent board for a column-wide change (#2500).

    An ``is_done`` toggle or a first-column change re-buckets every live child
    in the column at once, so a ``card.children_changed`` per parent would be
    an unbounded fan-out. Instead each affected PARENT board gets ONE frame:
    ``{"parent_ids": [...]}`` with up to :data:`CONTAINER_RENAME_ID_CAP` ids,
    or ``{"parent_ids": [], "reload": true}`` above it (the client re-reads the
    board). Ids only, never a count, title or state (Rule 8 and its timing
    residual, like ``card.children_changed``). Call inside the write's
    transaction: ``record_board_event`` writes the feed row there and
    publishes on commit, so a rollback sends nothing.

    Cost: zero queries for no columns or a parent-tier board; else ONE read,
    of the distinct parents of the columns' live children ranked per parent
    board and cut at cap + 1. The rows returned are bounded by the parent
    boards (cap + 1 each); the database still ranks every distinct parent of
    those children before the cut, a one-off sort on an ``is_done`` flip or
    first-column change, never per card.
    """
    ids = sorted({c for c in column_ids if c is not None})
    if not ids or board.cards_can_have_children:
        return
    links = CardParentLink.objects.filter(child__column_id__in=ids, child__archived_at__isnull=True)
    rows = (
        Card.objects.filter(pk__in=links.values("parent_id"))
        .annotate(_rank=Window(RowNumber(), partition_by=[F("board_id")], order_by=F("pk").asc()))
        .filter(_rank__lte=CONTAINER_RENAME_ID_CAP + 1)
        .values_list("board_id", "pk")
    )
    by_board = {}
    for parent_board_id, parent_id in rows:
        by_board.setdefault(parent_board_id, []).append(parent_id)
    for parent_board_id in sorted(by_board):
        parent_ids = sorted(by_board[parent_board_id])
        if len(parent_ids) <= CONTAINER_RENAME_ID_CAP:
            data = {"parent_ids": parent_ids}
        else:
            data = {"parent_ids": [], "reload": True}
        _broadcast.record_board_event(
            parent_board_id, _broadcast.EVT_CARD_CHILDREN_BULK_CHANGED, data, actor_id=actor_id,
        )
