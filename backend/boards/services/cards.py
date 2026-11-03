"""Card state transitions — the single home for the card mutation invariants.

Before #1107 every card transition was implemented inline in ``CardViewSet``, so
any second code path (the MCP write tools, a second front end, import, a future
webhook) had to either re-implement the invariants or bypass them. The drift was
already visible: ``mcp_server/tools.py`` carried a second copy of the role
precedence ladder, and #1106 was a write path that skipped the move invariants.

Each function here owns, for one transition:

* the role allow-list and the ownership / assignment gate,
* optimistic-concurrency comparison,
* row locks, in a fixed order (see ``move_card``),
* WIP, hard-WIP and weight enforcement including the ``force`` authorization,
* the ``CardMovement`` audit-trail write and the ``version`` bump,
* the transaction, and the ``transaction.on_commit`` broadcast and
  ``CARD_MUTATION_HOOKS`` invocation.

What is deliberately *not* here
-------------------------------
Nothing in this module imports ``rest_framework``, reads a request, or builds a
response. Three consequences worth knowing before you call it:

1. **Parsing is mostly the caller's job.** ``force`` arrives as a ``bool``.
   ``expected_version`` is the exception: it arrives raw and ``move_card``
   (and, since #1974, ``update_card``) coerces it, because *when* the "version
   must be an integer" 400 is raised is part of the frozen contract — it must
   come after the role allow-list, the card lookup and the assignment gate, so
   a caller who fails one of those sees that answer instead.

2. **Field validation is the caller's job, for now.** Per the project rule that
   input is validated at the serializer boundary, ``create_card`` and
   ``update_card`` take a ``save`` / ``apply`` callable that performs the
   already-validated write — for the HTTP adapter that is ``serializer.save()``,
   whose querysets are board-scoped (so a cross-board column or label id is a
   400 before the service is ever reached). A non-HTTP caller must bring its own
   validation or instantiate ``CardSerializer`` with ``board`` in context. That
   is a known gap, recorded as debt in the MR for #1107; the service still
   re-asserts every *cross-object* invariant it can enforce cheaply, so a caller
   that skips validation cannot bypass board scoping, WIP, or the audit trail.

3. **Serialization is injected.** Each function takes a ``render`` callable and
   invokes it *inside* the transaction, because the REST response body and the
   WebSocket payload are deliberately the same dict (#999/#1050): re-serializing
   in the adapter after commit would cost a second multi-query fetch and would
   let a concurrent writer land between the write and the read. The service
   stays serializer-agnostic, but ``render``'s return value *is* the
   ``card.*`` WebSocket frame and change-feed row, whose shape is a public
   contract (a ``CardSerializer`` card; ``{card[, movement]}`` for a move —
   see ``docs/api/websockets.md``). An adapter that needs a different return
   shape must render that contract and keep its own shape on the side, as the
   MCP tools do with ``_BroadcastRender.tool_card`` (#1926).

Errors are the typed classes in :mod:`boards.services.errors`, each carrying the
exact HTTP status and body the endpoint returned before the extraction.
"""

import logging
from dataclasses import dataclass

from django.db import connection, transaction
from django.db.models import F, Max, Q, Sum, prefetch_related_objects
from django.utils import timezone

from .. import broadcast as _broadcast
from .. import hooks
from ..models import (
    BoardMembership, Card, CardActivity, CardBlock, CardMovement, CardRelation, Column,
    Notification, Swimlane,
)
from ..permissions import SITE_ADMIN, can_modify_others_content, get_board_role
from ..serializers import _card_labels
from ..utils import notify_new_mentions
from .notifications import create_notifications, quoted_card_verb
from .errors import (
    CardAlreadyBlocked, CardCreationNotAllowed, CardNotBlocked, CardNotFound, ColumnNotFound, ContainerChanged, ForceNotPermitted,
    InvalidPosition, InvalidVersion, MoveNotPermitted, NotPermitted, SwimlaneNotFound,
    SwimlaneWeightLimitExceeded, SwimlaneWipHardBlocked, SwimlaneWipLimitExceeded,
    UseMoveEndpoint, VersionConflict, WeightLimitExceeded, WipHardBlocked,
    WipLimitExceeded,
)

logger = logging.getLogger(__name__)

# Roles permitted to mutate cards at all. An allow-list, not a block-list: a
# block-list would silently grant access to any role added to the system later.
_MUTATION_ROLES = (
    BoardMembership.Role.MEMBER,
    BoardMembership.Role.ADMIN,
    SITE_ADMIN,
)

# Roles permitted to add and delete card comments and attachments and to work on
# checklist items: the mutation roles plus collaborator, who annotates cards
# without changing them (``BoardMembership`` docstring). An allow-list for the
# same reason as ``_MUTATION_ROLES``: a role added later gets no write access
# until it is listed here (#1829, #875).
ANNOTATION_ROLES = (
    BoardMembership.Role.COLLABORATOR,
    *_MUTATION_ROLES,
)

# Roles permitted to override a soft WIP or weight limit with force=True.
_FORCE_ROLES = (BoardMembership.Role.ADMIN, SITE_ADMIN)


@dataclass
class CardMutationResult:
    """What a transition produced.

    ``payload`` is whatever the caller's ``render`` returned — already built,
    inside the transaction, and identical to what was broadcast where the two
    are the same by design. ``movement`` is set only by transitions that wrote
    a ``CardMovement`` the caller needs back (i.e. ``move_card``).
    """

    card: Card
    payload: dict | None = None
    movement: CardMovement | None = None


# ---------------------------------------------------------------------------
# Shared gates
# ---------------------------------------------------------------------------

def _resolve_role(actor, board, role):
    """Return the actor's effective role on the board.

    ``role`` is an optional pre-resolved value. It exists so an adapter that has
    just resolved the role — ``get_board_for_user`` does, as part of its own
    access check — does not pay for it twice; on a group-inherited board that
    second resolution is a real query.

    It **fails closed**. A supplied role is believed only when it matches the
    memo ``get_board_role`` / ``get_board_roles`` left on this board instance
    for this actor; anything else is discarded and the role is derived from the
    database. So a caller cannot widen its own access by passing ``"admin"``,
    and — the likelier mistake now that ``get_board_roles`` hands out a
    ``{board_id: role}`` dict — cannot escalate by indexing that dict with the
    wrong board id either. Both cases simply cost the query the parameter was
    there to save.

    A caller with no already-resolved role passes ``None``, which is always
    correct and never slower than it has to be.
    """
    if role is not None:
        resolved = getattr(board, "_resolved_role", None)
        if resolved == (actor.id, role):
            return role
        logger.warning(
            "card.service.role_hint_rejected board_id=%s actor_id=%s supplied=%r "
            "resolved=%r — deriving from the database instead",
            board.pk, actor.id, role, resolved,
        )
    return get_board_role(actor, board)


def _require_mutation_role(role):
    if role not in _MUTATION_ROLES:
        raise NotPermitted()


def require_mutation_role(*, actor, board, role=None):
    """Public form of the role allow-list, for callers that must check it early.

    Exists for one reason: the update endpoint evaluates the allow-list *before*
    it looks the card up, so a viewer touching a card that does not exist gets
    403 and not 404. That ordering is observable, so the adapter has to be able
    to run the check before it has a card — while the rule itself stays here
    rather than being copied into the view.

    Returns the resolved role so the caller can pass it straight on.
    """
    role = _resolve_role(actor, board, role)
    _require_mutation_role(role)
    return role


def _require_own_content(board, role, actor, card, *, denial):
    """Ownership gate: members may only touch cards they created.

    Bypassed by admins, site admins, board owners, and members holding the
    moderator entitlement (#362).
    """
    if card.created_by_id == actor.id:
        return
    if not can_modify_others_content(board, role, actor):
        raise NotPermitted(denial)


def _require_force_role(role, limit):
    if role not in _FORCE_ROLES:
        raise ForceNotPermitted(limit)


def _fire_hooks(event, card_id, board_id, actor_id):
    """Register the ``CARD_MUTATION_HOOKS`` fan-out for after the commit.

    ``CARD_MUTATION_HOOKS`` is a stability-guaranteed 1.0+ extension point
    (#820): enterprise code appends to the list in place, so this must read the
    module attribute — never a copy taken at import time, and never a rebind.
    The list is re-read inside the callback so a handler registered between the
    request starting and the transaction committing is still called, matching
    the behavior of the original call sites.

    Arguments reach handlers as plain integers, not ORM instances, so a handler
    can safely issue its own queries after the commit without holding a stale
    Python object.
    """
    if hooks.CARD_MUTATION_HOOKS:
        transaction.on_commit(lambda: _run_hooks(event, card_id, board_id, actor_id))


def _run_hooks(event, card_id, board_id, actor_id):
    """Call every ``CARD_MUTATION_HOOKS`` handler, isolating each from the rest.

    This is the single choke point for the fan-out. By the time it runs the
    write is already committed, so a raising handler (webhook, automation, audit
    sink) must not propagate: it would surface as a 500 for a card that *was*
    saved, and the client's retry would create a duplicate (there are no
    idempotency keys). It also must not abandon the handlers after it or any
    other ``on_commit`` callback. Only the handler name, ids, event type and
    exception class are logged — never the exception message or payload, which
    may carry PII.

    Iterates a snapshot so a handler that registers another handler cannot
    mutate the list mid-loop; the list itself is still re-read per commit.
    """
    for handler in list(hooks.CARD_MUTATION_HOOKS):
        try:
            handler(event, card_id, board_id, actor_id)
        except Exception as exc:  # noqa: BLE001 - extension code is untrusted
            logger.error(
                "CARD_MUTATION_HOOKS handler %s failed for %s (card=%s board=%s): %s",
                getattr(handler, "__qualname__", repr(handler)),
                event, card_id, board_id, type(exc).__name__,
            )


def _notify_mentions_after_commit(card, actor, old_text, new_text):
    """Register ``notify_new_mentions`` for after the commit, failure-isolated.

    Same reasoning as ``_run_hooks``: the card write is committed, so a failure
    creating mention notifications must not turn it into a 500 (and a retry
    duplicate). Logs only the card id and exception class.
    """
    def _run():
        try:
            notify_new_mentions(card, actor, old_text, new_text)
        except Exception as exc:  # noqa: BLE001 - best-effort side effect
            logger.error(
                "notify_new_mentions failed for card=%s: %s", card.pk, type(exc).__name__,
            )

    transaction.on_commit(_run)


def _broadcast_after_commit(board_id, event, payload, actor_id=None):
    """Record the event in the board change feed and publish it after commit.

    ``record_board_event`` writes the ``BoardEvent`` row synchronously — inside
    whichever ``transaction.atomic()`` block the caller is in, which is the point
    (#1114): the feed row and the mutation it describes commit or roll back as
    one, and the deferred broadcast then publishes the committed row carrying its
    id. This is why every call below sits inside the transaction rather than
    after it.

    Reached through the ``broadcast`` *module object* rather than by importing
    the function directly: the test suite patches
    ``boards.broadcast.broadcast_board_event`` at its source module, and a
    direct-name import here would bind a reference the patch cannot reach — so
    tests that patch only to suppress the channel layer would silently start
    broadcasting for real.
    """
    _broadcast.record_board_event(board_id, event, payload, actor_id=actor_id)


def _blocked_peer_ids(card):
    """Ids of the cards ``card`` actively blocks (#449).

    Archiving, restoring or deleting a card silently changes the *other* card's
    ``blocker_count``, because ``_active_blockers_prefetch()`` only counts
    blockers that are still on the board. Those peers need their own
    ``card.updated`` frame or every connected client keeps rendering a blocked
    indicator for a blocker that is gone.

    Call this **before** a hard delete — the relation rows cascade away with
    the card, so afterwards there is nothing left to read.
    """
    return list(
        card.outgoing_relations.filter(
            relation_type=CardRelation.Type.BLOCKS
        ).values_list("to_card_id", flat=True)
    )


def _broadcast_blocked_peers(board_id, peer_ids, actor, render, render_many=None):
    """Publish ``card.updated`` for each card whose blocker_count just moved.

    Reuses ``card.updated`` rather than inventing an event type: the payload is
    a complete card and the board store already replaces a card wholesale by id.

    ``render`` is the caller's card-rendering callback, so this module still
    builds no response and imports no serializer — the same layering rule the
    rest of this file follows. It is optional at the call sites that did not
    previously take one; without it the peer broadcast is skipped rather than
    the mutation failing, since a stale indicator is a lesser fault than a
    500 on delete.

    ``render_many`` is the batched form of the same callback. When the caller
    supplies it, every peer is rendered in one prefetch pass instead of one per
    peer — the difference between a constant cost and ``7 x N`` queries on a
    card that blocks N others, which is unbounded. ``render`` is kept as the
    fallback for a caller that has no batched form.
    """
    if not peer_ids:
        return
    if render_many is not None:
        payloads = render_many(peer_ids)
    elif render is not None:
        payloads = [render(peer) for peer in Card.objects.filter(pk__in=peer_ids)]
    else:
        return
    for payload in payloads:
        _broadcast_after_commit(board_id, _broadcast.EVT_CARD_UPDATED, payload, actor.id)


def blocked_peer_ids_by_board(cards, *, active_blockers_only=True):
    """Cards outside ``cards`` that an active card in ``cards`` blocks, grouped by board (#1634).

    The container-delete counterpart of ``_blocked_peer_ids``: a column,
    swimlane or board delete — and a bulk card delete in the Django admin —
    cascades a whole set of cards, and every card *outside* that set that one
    of them was blocking has its ``blocker_count`` drop. Returns
    ``{board_id: [card_id, ...]}``.

    Three choices, each deliberate:

    * **Peers inside ``cards`` are left out.** On a delete they go with the
      same cascade. This only saves work: the render after the delete reads
      the surviving rows, so a deleted peer would produce no frame anyway.
    * **Archived blockers are skipped.** ``blocker_count`` only counts active
      blockers (``_active_blockers_prefetch``), so deleting an archived one
      moves nothing and is worth no frame. A container cascade includes its
      archived cards; ``delete_card`` never deletes one, which is why
      ``_blocked_peer_ids`` needs no such filter. A caller about to flip a
      card's archived state (the Django admin card form) passes
      ``active_blockers_only=False``: there the card's archived state is what
      changes, so its peers move whichever way it goes.
    * **Grouped by the peer's own board.** The API only creates same-board
      relations, but the Django admin card form can move a card to another
      board, and its relations go with it. A peer on another board must hear
      about it on *its* board's channel, never on the deleted container's —
      that would publish a card to subscribers who may have no access to it.

    One query, whatever the size of ``cards`` (a subquery, not a list of ids).
    Call it after the cascade's card locks and **before** the delete: the
    relation rows cascade away with their cards. Under the locks a relation
    added concurrently has either committed (and counts) or queues behind the
    delete, since adding a relation locks both of its cards ``FOR UPDATE``.
    """
    relations = CardRelation.objects.filter(
        relation_type=CardRelation.Type.BLOCKS, from_card__in=cards,
    )
    if active_blockers_only:
        relations = relations.filter(from_card__archived_at__isnull=True)
    rows = (
        relations
        .exclude(to_card__in=cards)
        .order_by("to_card__board_id", "to_card_id")
        .values_list("to_card__board_id", "to_card_id")
        .distinct()
    )
    by_board = {}
    for board_id, card_id in rows:
        by_board.setdefault(board_id, []).append(card_id)
    return by_board


def broadcast_blocked_peers_by_board(peers_by_board, actor, render_many):
    """Publish ``card.updated`` for every peer in ``peers_by_board`` (#1634).

    ``peers_by_board`` is what ``blocked_peer_ids_by_board`` returned before
    the delete. ``render_many(board_id, card_ids)`` renders one board's peers
    in a single prefetch pass; the caller supplies it so this module still
    imports no serializer. Each board's frames go to that board's channel.

    Call it inside the deleting transaction, **after** the delete: the peers
    are rendered from that transaction's own view, in which the deleted
    blockers are already gone, so the published ``blocker_count`` is the
    post-delete one. ``_broadcast_after_commit`` records each change-feed row
    in the same transaction and defers the publish until commit, exactly as
    ``delete_card`` does for its peers.
    """
    for board_id, peer_ids in peers_by_board.items():
        _broadcast_blocked_peers(
            board_id, peer_ids, actor, None,
            render_many=lambda ids, bid=board_id: render_many(bid, ids),
        )


def _board_scoped(model, pk, board, error):
    """Fetch a row by pk, requiring it to belong to *board*.

    A row on another board raises the same not-found error as a row that does
    not exist, so the API never confirms that an id the caller guessed exists
    somewhere they cannot see (IDOR).

    ``pk`` is often the raw client value (``column_id``/``swimlane_id`` in a
    request body), so it may not be an integer at all. The ORM raises
    ``ValueError``/``TypeError`` on the lookup for such a value; that is a row that
    does not exist, answered 404 like any other miss, not an unhandled 500
    (#1585 — the schema fuzzer sends exactly this to ``move/``).
    """
    try:
        return model.objects.get(pk=pk, board=board)
    except (model.DoesNotExist, ValueError, TypeError):
        raise error() from None


# ---------------------------------------------------------------------------
# Placement limits (WIP + weight, per column and per swimlane)
# ---------------------------------------------------------------------------

# Enforcement modes a placement constraint can carry. HARD admits no override
# for any role; BLOCK can be overridden with ``force`` by a board admin.
_HARD = "hard"
_BLOCK = "block"


@dataclass(frozen=True)
class PlacementConstraint:
    """One limit a placement must respect (#1150).

    ``enforce_column_limits`` builds a list of these for the target cell and
    evaluates them in one pass, so a new kind of limit — a per-class-of-service
    WIP policy (#1103), say — is one more entry in that list rather than a
    third enforcement function. Each entry is self-contained:

    * ``kind`` is ``"wip"`` (count the cards in ``cards``, refuse at
      ``limit``) or ``"weight"`` (sum their weight, refuse when adding the
      placed card's weight would pass ``limit``). It also picks the
      ``ForceNotPermitted`` wording.
    * ``mode`` is ``_HARD`` or ``_BLOCK``.
    * ``cards`` is the queryset of the cards that count against ``limit``,
      the placed card already excluded.
    * ``error`` builds the refusal from the measured total.
    """

    kind: str
    mode: str
    limit: int
    cards: object
    error: object

    def measure(self):
        if self.kind == "wip":
            return self.cards.count()
        return self.cards.aggregate(total=Sum("weight"))["total"] or 0

    def is_exceeded(self, measured, card_weight):
        if self.kind == "wip":
            return measured >= self.limit
        return measured + card_weight > self.limit


def _column_limit_modes(board):
    """``(wip_mode, weight_mode)`` the board flags give its columns; ``None``
    means that limit is not enforced. Hard WIP mode is independent of soft
    mode: it applies even when ``enforce_wip_limits`` is off."""
    wip = _HARD if board.enforce_wip_hard else (_BLOCK if board.enforce_wip_limits else None)
    weight = _BLOCK if board.enforce_weight_limits else None
    return wip, weight


def _swimlane_limit_modes(board, swimlane):
    """``(wip_mode, weight_mode)`` for a swimlane's own limits (#1150).

    A swimlane that chose a mode uses it whatever the board flags say; one
    that did not (``NULL``) inherits the board flags exactly as a column does,
    so a board that never touches the setting behaves as it always has.
    Weight has no hard mode, for rows as for columns: under ``hard`` the row's
    weight limit is still a block an admin can override.
    """
    chosen = swimlane.limit_enforcement
    if chosen is None:
        return _column_limit_modes(board)
    if chosen == Swimlane.LimitEnforcement.BLOCK:
        return _BLOCK, _BLOCK
    # HARD, and fail closed on a value only a raw ORM write could store.
    return _HARD, _BLOCK


def _source_counts_for_swimlane(swimlane, source):
    """Whether the card already counts toward ``swimlane``'s limits where it
    is now. ``source`` is ``(column, swimlane_id)`` with ``column`` a
    ``Column`` or a column id, or ``None`` for a card that counts nowhere yet
    (a create, a restore)."""
    if source is None:
        return False
    source_column, source_swimlane_id = source
    if source_swimlane_id != swimlane.pk:
        return False
    if isinstance(source_column, Column):
        return swimlane.counts_column(source_column)
    if isinstance(swimlane.limit_column_ids, list):
        return source_column in swimlane.limit_column_ids
    if swimlane.limit_column_ids is not None:
        return True  # non-list: every column counts (Swimlane.counts_column)
    # NULL means "every column not marked done"; only the id is known here.
    is_done = Column.objects.filter(pk=source_column).values_list("is_done", flat=True).first()
    return is_done is False


def _column_constraints(board, column, card, *, check_wip, check_weight):
    wip_mode, weight_mode = _column_limit_modes(board)
    counted = Card.objects.filter(board=board, column=column, archived_at__isnull=True).exclude(pk=card.pk)
    constraints = []
    if check_wip and wip_mode and column.wip_limit is not None:
        hard = wip_mode == _HARD
        constraints.append(PlacementConstraint(
            kind="wip", mode=wip_mode, limit=column.wip_limit, cards=counted,
            error=lambda n, hard=hard: (WipHardBlocked if hard else WipLimitExceeded)(
                column_name=column.name, current_count=n, wip_limit=column.wip_limit,
            ),
        ))
    if check_weight and weight_mode and column.weight_limit is not None:
        constraints.append(PlacementConstraint(
            kind="weight", mode=weight_mode, limit=column.weight_limit, cards=counted,
            error=lambda w: WeightLimitExceeded(
                column_name=column.name, current_weight=w,
                weight_limit=column.weight_limit, card_weight=card.weight,
            ),
        ))
    return constraints


def _swimlane_constraints(board, swimlane, column, card, *, check_wip, check_weight):
    wip_mode, weight_mode = _swimlane_limit_modes(board, swimlane)
    want_wip = check_wip and wip_mode is not None and swimlane.wip_limit is not None
    want_weight = check_weight and weight_mode is not None and swimlane.weight_limit is not None
    if not (want_wip or want_weight):
        return []
    counted = Card.objects.filter(board=board, swimlane=swimlane, archived_at__isnull=True).exclude(pk=card.pk)
    if swimlane.limit_column_ids is None:
        counted = counted.filter(column__is_done=False)
    else:
        # A stale id (a column deleted under a concurrent settings save) just
        # matches nothing. A non-list (raw ORM write only) counts every column,
        # as Swimlane.counts_column does.
        if isinstance(swimlane.limit_column_ids, list):
            counted = counted.filter(column_id__in=swimlane.limit_column_ids)
    constraints = []
    if want_wip:
        hard = wip_mode == _HARD
        constraints.append(PlacementConstraint(
            kind="wip", mode=wip_mode, limit=swimlane.wip_limit, cards=counted,
            error=lambda n, hard=hard: (SwimlaneWipHardBlocked if hard else SwimlaneWipLimitExceeded)(
                swimlane_name=swimlane.name, column_name=column.name,
                current_count=n, wip_limit=swimlane.wip_limit,
            ),
        ))
    if want_weight:
        constraints.append(PlacementConstraint(
            kind="weight", mode=weight_mode, limit=swimlane.weight_limit, cards=counted,
            error=lambda w: SwimlaneWeightLimitExceeded(
                swimlane_name=swimlane.name, column_name=column.name, current_weight=w,
                weight_limit=swimlane.weight_limit, card_weight=card.weight,
            ),
        ))
    return constraints


def _swimlane_check_applies(board, swimlane, column, *, check_wip, check_weight, source):
    """Whether this placement must be checked against ``swimlane``'s limits.

    Decided on the caller's read of the swimlane, before any lock, so that a
    board without row limits pays no query. A limit saved concurrently after
    that read is therefore not applied to this one placement (the column
    check has the same staleness); once the row lock is taken, the limits
    enforced are the locked row's.

    The row's limits cover only the cards in its counted columns, so only a
    placement that *adds* to that total is checked: the card enters a counted
    column of the row from outside it (another row, an uncounted column of
    this row, or nowhere: create, restore), or it grows inside one (a weight
    increase, ``check_wip=False``). The exact rule, a public 409 behavior:

    * checked: the target column counts for the row, and the card does not
      already count there: it comes from another row, from a column of this
      row that does not count (Backlog -> Doing with ``limit_column_ids``
      ``[Doing]``, or Done -> Doing under the default), or from nowhere
      (create, restore); and a weight increase of a card in a counted column;
    * never checked: a reorder, a move between two counted columns of the
      row, and a move into a column that does not count.

    This is how the issue's "moves inside a lane never trip the lane limit"
    (#1150) is read once a row has counted columns: a move that leaves the
    count unchanged never trips it, exactly as a swimlane-only move never
    trips a column limit. Exempting every move inside a row would let a card
    enter through an uncounted column and walk past the limit one card at a
    time. Listed as an owner decision on the #1150 MR.
    """
    wip_mode, weight_mode = _swimlane_limit_modes(board, swimlane)
    if not (
        (check_wip and wip_mode and swimlane.wip_limit is not None)
        or (check_weight and weight_mode and swimlane.weight_limit is not None)
    ):
        return False
    if not swimlane.counts_column(column):
        return False
    if not check_wip:
        # Growing in place: the card already counts here.
        return True
    return not _source_counts_for_swimlane(swimlane, source)


def _evaluate_constraints(constraints, *, card, role, force):
    """Raise the strictest refusal among ``constraints``, or return.

    Hard constraints are evaluated first, before ``force`` is consulted, so no
    role can override one (hard > block). The sort is stable, so among equally
    strict constraints the caller's order decides which one is reported:
    column before swimlane, WIP before weight — see
    ``boards.services.errors`` for why one body names one constraint. A
    tripped soft constraint raises unless ``force`` is set, and ``force`` is
    accepted only from a board admin or site admin (``ForceNotPermitted``
    worded for the first tripped kind otherwise).
    """
    for constraint in sorted(constraints, key=lambda c: c.mode != _HARD):
        measured = constraint.measure()
        if not constraint.is_exceeded(measured, card.weight):
            continue
        if constraint.mode == _HARD or not force:
            raise constraint.error(measured)
        _require_force_role(role, constraint.kind)


def enforce_column_limits(
    *, board, column, card, role, force=False, check_wip=True, check_weight=True,
    lock=True, swimlane=None, source=None, check_column=True,
):
    """Raise if placing ``card`` in the cell (``column``, ``swimlane``) breaks
    a placement limit: the column's WIP or weight limit, or, since #1150, the
    swimlane's.

    The one implementation of WIP, hard-WIP and weight enforcement, shared by
    every API write path that puts a card into a cell or grows one inside it:
    move, create, restore from archive, a weight increase via update, and the
    Django admin (#1428). Before #1428 only ``move_card`` ran it, so a member
    could exceed even a hard limit by creating or restoring a card. The name
    predates the row limits; it is kept because the lock-order race tests and
    the admin patch this function by name. It builds one list of
    ``PlacementConstraint`` for the cell and evaluates it in one pass
    (``_evaluate_constraints``); a further kind of limit (#1103) adds entries
    to that list, not a second function.

    ``card`` is the card being placed. It is excluded from the counts — it is
    either somewhere else (move), not yet active (restore), or already saved by
    the caller inside its own transaction (create, weight change) — and its
    ``weight`` is what is added to the totals.

    ``check_wip`` / ``check_weight`` exist for the weight-change path, which
    does not change how many cards the cell holds and so must not be refused
    for a column or row that is already over its *WIP* limit.

    ``swimlane`` (#1150) is the target row; ``None`` checks the column only.
    ``source`` is ``(column, swimlane_id)`` where the card counts now, or
    ``None`` when it counts nowhere (create, restore): it decides whether the
    card enters the row's counted columns (see ``_swimlane_check_applies``).
    ``check_column=False`` is for a move that keeps the card in its column (a
    swimlane-only move), which a column limit never refuses.

    Locking: when any enforced limit applies, the column row and then the
    swimlane row are locked with ``select_for_update(no_key=True)`` before
    counting, so two concurrent writers into the same column — or into the
    same row through different columns — queue instead of both observing room
    for one more card. Call this inside the caller's transaction, after any
    card-row lock, to keep the card -> column -> swimlane lock order
    ``move_card`` documents. The swimlane's limits are re-read from the locked
    row, so a concurrent settings save is either seen or waited for.

    ``FOR NO KEY UPDATE`` rather than ``FOR UPDATE`` (#1522): every insert or
    update of a row with a foreign key to the column — a ``CardMovement`` naming
    it as ``from_column``, a card saved into it — takes ``FOR KEY SHARE`` on the
    column row, which ``FOR UPDATE`` blocks and ``FOR NO KEY UPDATE`` does not.
    With ``FOR UPDATE``, a move A -> B racing a move B -> A in another swimlane
    deadlocks: each holds its target column and its audit row needs the other's.
    Two ``FOR NO KEY UPDATE`` locks still conflict, so limit checks still queue.
    The swimlane row takes the same mode for the same reason: a move out of a
    limited row holds no lock on it, but its audit row takes ``FOR KEY SHARE``.

    Override rules (identical on every path): hard WIP mode is evaluated before
    ``force`` is consulted, so no role can override it; a soft WIP or weight
    limit can be overridden with ``force=True`` only by a board admin or site
    admin (``ForceNotPermitted`` otherwise), and one ``force`` covers every
    soft limit the placement trips. Weight has no hard mode. When several
    limits trip, the strictest is reported (see ``_evaluate_constraints``).

    ``lock=False`` is only for a caller that already holds the column row lock
    in the same transaction (``create_card`` takes it for position assignment).
    It never skips the swimlane lock, which no caller takes beforehand.
    """
    constraints = (
        _column_constraints(board, column, card, check_wip=check_wip, check_weight=check_weight)
        if check_column else []
    )
    lane_applies = swimlane is not None and _swimlane_check_applies(
        board, swimlane, column, check_wip=check_wip, check_weight=check_weight, source=source,
    )
    if not (constraints or lane_applies):
        return

    # One lock per row covers WIP and weight; acquiring it twice on the same
    # row would be a redundant round-trip. Column first, then swimlane.
    if constraints and lock:
        Column.objects.select_for_update(no_key=True).get(pk=column.pk)
    if lane_applies:
        locked_swimlane = Swimlane.objects.select_for_update(no_key=True).filter(pk=swimlane.pk).first()
        if locked_swimlane is None:
            # Deleted while this waited; callers check existence first, so this
            # is only reachable under a concurrent delete.
            raise SwimlaneNotFound()
        constraints += _swimlane_constraints(
            board, locked_swimlane, column, card, check_wip=check_wip, check_weight=check_weight,
        )

    _evaluate_constraints(constraints, card=card, role=role, force=force)


# ---------------------------------------------------------------------------
# create
# ---------------------------------------------------------------------------

def create_card(
    *, actor, board, column_id, swimlane_id, save, render, role=None, force=False,
):
    """Create a card at the end of its target cell.

    ``save(position=...)`` performs the validated write and returns the new
    ``Card`` — the HTTP adapter passes a closure over ``serializer.save``.

    The column's WIP and weight limits are enforced exactly as a move into the
    column enforces them (#1428), including hard mode and the board-admin
    ``force`` override. The check runs *after* ``save`` because only the saved
    card carries its validated ``weight``; a refusal raises inside the
    transaction, so the insert (and everything ``save`` wrote with it) rolls
    back and no broadcast, hook or notification is registered.

    Board import and the seed commands deliberately do not come through here:
    they ``bulk_create`` a board as it was exported or designed, which may
    legitimately be over its limits (see ``docs/architecture/service-layer.md``).
    """
    role = _resolve_role(actor, board, role)
    _require_mutation_role(role)

    column = _board_scoped(Column, column_id, board, ColumnNotFound)
    if not column.allow_card_creation:
        raise CardCreationNotAllowed()
    swimlane = _board_scoped(Swimlane, swimlane_id, board, SwimlaneNotFound)

    board_id = board.id
    with transaction.atomic():
        # Board row FOR SHARE first (#1632): the labels and custom-field
        # definitions save() writes were resolved before this transaction, and
        # the serializer re-reads them under this lock. Before the column row:
        # board -> column, the order every container delete takes. A create
        # queued behind a board delete finds the board, and so its column, gone.
        if not lock_board_for_card_write(board_id):
            raise ColumnNotFound()
        # Lock the target column row before reading the cell's card count so two
        # concurrent creates in the same (column, swimlane) cell cannot both
        # observe the same max position and assign a duplicate. Same column-row
        # lock the move transition takes for its WIP check (#1050).
        #
        # A column, swimlane or board delete holds this column row across its
        # cascade (#1602), so a create that waited on it finds its target gone:
        # answer 404 here rather than 500 on Column.DoesNotExist or on the
        # card's deferred swimlane FK check at COMMIT.
        locked_column = (
            Column.objects.select_for_update(no_key=True)
            .filter(pk=column.pk)
            .values_list(
                "pk",
                # Only `is None` is read below; a 1-tuple is just as non-None.
                flat=True,  # pragma: no mutate -- equivalent: result is tested for None only (#1931)
            )
            .first()
        )
        if locked_column is None:
            raise ColumnNotFound()
        require_swimlane_exists(swimlane.pk)
        max_pos = Card.objects.filter(board=board, column=column, swimlane=swimlane).count()
        card = save(position=max_pos)
        # The column row is already locked above, so the helper does not lock
        # it again (it still locks the swimlane row, after the column, when the
        # row has a limit). The new card is excluded from the count, as in a
        # move.
        enforce_column_limits(
            board=board, column=column, card=card, role=role, force=force, lock=False,
            swimlane=swimlane,
        )
        CardMovement.objects.create(
            card=card,
            from_column=None,
            from_column_name="",
            from_column_uid="",
            from_swimlane=None,
            from_swimlane_name="",
            from_swimlane_uid="",
            to_column=column,
            to_column_name=column.name,
            to_column_uid=column.uid,
            to_swimlane=swimlane,
            to_swimlane_name=swimlane.name,
            to_swimlane_uid=swimlane.uid,
            moved_by=actor,
            notes="Card created",
        )
        payload = render(card)
        _broadcast_after_commit(board_id, _broadcast.EVT_CARD_CREATED, payload, actor.id)
        _fire_hooks("card.created", card.id, board_id, actor.id)
        if card.description:
            # Notify any @mentioned board members in the initial description.
            _notify_mentions_after_commit(card, actor, "", card.description)
    return CardMutationResult(card=card, payload=payload)


def create_card_at_position(
    *, actor, board, column_id, swimlane_id, position, save, render, render_moved,
    role=None,
):
    """Create a card and place it at ``position`` in its cell, in one
    transaction (#1992). Returns ``(created, moved)``; ``moved`` is ``None``
    when the card was appended at ``position`` already.

    Why one transaction: the MCP ``create_card`` tool used to call
    ``create_card`` and then ``move_card`` as two transactions, so a reorder
    that failed (``version_conflict``, ``card_not_found``) left the card
    created behind an error that carried no card id, and the documented "retry"
    made a duplicate. Here a failed reorder rolls the create back with it:
    nothing is written, and no broadcast, hook or mention notification is
    registered (their ``on_commit`` callbacks belong to the outer transaction
    and are discarded with it), so the caller may simply retry.

    Why the cell is locked up front: nesting the two calls in a bare
    ``atomic()`` would break the lock order. ``create_card`` holds the cell's
    column row until commit, and ``move_card`` then locks the cell's card
    rows, which is a card row after a column row. A concurrent move in the
    same cell takes them the other way round (cards, then the column), so the
    two would deadlock. So the cell's cards and its column are taken first, in
    the card-entry order (board ``FOR SHARE`` -> cell cards -> column), with
    the same membership re-check ``move_card`` makes (#1567). After that every
    lock ``create_card`` and ``move_card`` ask for is already held, so neither
    waits on anything and neither can take a lock out of order. ``move_card``'s
    own retry loop still runs in its savepoint, but cannot lose a race: no
    card can enter the cell while its column row is held.

    The success path is unchanged for clients: a ``card.created`` frame (the
    card at the end of its cell) followed by a ``card.moved`` frame (``{card}``,
    a same-cell reorder), now committed together.
    """
    role = _resolve_role(actor, board, role)
    _require_mutation_role(role)
    # The same lookups, in the same order, as create_card, so a caller sees the
    # same error first; they also keep the cell lock below on this board.
    column = _board_scoped(Column, column_id, board, ColumnNotFound)
    if not column.allow_card_creation:
        raise CardCreationNotAllowed()
    swimlane = _board_scoped(Swimlane, swimlane_id, board, SwimlaneNotFound)

    with transaction.atomic():
        if not lock_board_for_card_write(board.id):
            raise ColumnNotFound()
        _lock_cell_for_placement(board=board, column=column, swimlane=swimlane)
        created = create_card(
            actor=actor, board=board, column_id=column.pk, swimlane_id=swimlane.pk,
            save=save, render=render, role=role,
        )
        moved = None
        if position != created.card.position:
            moved = move_card(
                actor=actor, board=board, card_id=created.card.pk,
                target_column_id=column.pk, target_swimlane_id=swimlane.pk,
                position=position, render=render_moved, role=role,
            )
    return created, moved


# The detail of _lock_cell_for_placement's VersionConflict (#1992): no card
# exists yet, so the class default about a modified card would be wrong.
_PLACEMENT_CONFLICT_DETAIL = (
    "Cards kept being added to this column and swimlane while the card was "
    "being placed. Nothing was created. Please try again."
)


def _lock_cell_for_placement(*, board, column, swimlane):
    """Lock a cell's card rows, then its column row, for
    ``create_card_at_position``; retry if a card entered the cell in between.

    The ``_lock_move_cells`` -> ``_lock_move_columns`` ->
    ``_require_cells_locked`` sequence of a move, for a cell that has no moved
    card yet. The card statement locks the rows of its snapshot, taken before
    it waited, so a card committed into the cell during that wait is not
    locked; once the column row is held no further card can enter, so the
    cell is re-read and, if it gained a card, the attempt is rolled back to its
    savepoint (releasing its locks) and repeated. Locking the newcomer in a
    second statement would take a card row after a column row instead.

    A cell that gains a card on every attempt raises ``VersionConflict``, with
    ``current_version`` ``None`` since there is no card yet, a detail that
    says nothing was created, and nothing written: the same code ``move_card``
    gives for the same lost race.
    """
    cell = Card.objects.filter(board=board, column=column, swimlane=swimlane)
    for _attempt in range(_MOVE_LOCK_ATTEMPTS):
        try:
            with transaction.atomic():
                locked_pks = frozenset(
                    cell.order_by("pk").select_for_update(of=("self",))
                    .values_list("pk", flat=True)
                )
                if column.pk not in _lock_move_columns({column.pk}):
                    # Deleted while this waited (#1602), as in create_card.
                    raise ColumnNotFound()
                if not set(cell.values_list("pk", flat=True)) <= locked_pks:
                    raise _CardChangedBeforeLock(None)
            return
        except _CardChangedBeforeLock:
            continue
    raise VersionConflict(None, detail=_PLACEMENT_CONFLICT_DETAIL)


# ---------------------------------------------------------------------------
# update
# ---------------------------------------------------------------------------

def _reject_cell_change(board, card, submitted):
    """Raise ``UseMoveEndpoint`` when ``submitted`` changes the card's cell.

    ``update_card`` calls this twice: once on the caller's snapshot, so the
    common case fails before any lock is taken, and again on the state read
    under the card lock (#1598), so an echo of a value a concurrent move has
    since changed cannot write the old cell back.
    """
    # Reject a change of `column`, `swimlane`, or `position` — same-board or
    # cross-board (#1106, #1275). All three bypass WIP/weight enforcement and
    # the CardMovement audit trail, which only the move transition evaluates.
    # Echoing back the card's *current* value is still accepted so a client
    # that round-trips the full representation it was given keeps working
    # (required by the 1.0 backward-compatibility contract). Both sides are
    # normalized to int before comparing rather than resolved against the DB,
    # so the API never needs to tell the caller whether a foreign id it
    # guessed happens to exist on another board — and so an unchanged value
    # sent in a different JSON representation (`5.0`, `"5"`) is not
    # misreported as a real change (security-review finding on #1275). A
    # value that fails to coerce to int is left to the serializer's own field
    # validation rather than raised here as a move-endpoint bypass. `None` is
    # likewise left to field validation rather than treated as a no-op, since
    # column, swimlane, and position are all non-nullable and the current
    # value can therefore never legitimately be None.
    for field_name, current_value in (
        ("column", card.column_id), ("swimlane", card.swimlane_id), ("position", card.position),
    ):
        if field_name in submitted:
            raw_value = submitted.get(field_name)
            if raw_value is None:
                continue
            try:
                raw_normalized = int(float(raw_value))
            except (TypeError, ValueError):
                continue
            if raw_normalized != int(current_value):
                raise UseMoveEndpoint(field_name, board_pk=board.pk, card_pk=card.pk)


def _adopt_locked_state(card, locked):
    """Copy the row read under the card lock onto the caller's ``card`` (#1598).

    Done in place, without a second query, because ``card`` is also the
    instance the caller's serializer will save. Unlike ``refresh_from_db()``
    this keeps the parked label prefetch and any related-object cache whose
    foreign key did not change, so an unraced PATCH costs no extra queries; a
    cached related object is dropped only when its key moved under us.
    """
    for field in Card._meta.concrete_fields:
        value = getattr(locked, field.attname)
        if getattr(card, field.attname) == value:
            continue
        setattr(card, field.attname, value)
        if field.is_relation and field.is_cached(card):
            field.delete_cached_value(card)


def update_card(
    *, actor, board, card, submitted, apply, render, role=None, force=False,
    expected_version=None,
):
    """Apply a field update, recording a ``CardActivity`` row per changed field.

    ``submitted`` is the mapping of field names the caller actually supplied. It
    decides three things that a diff of the saved row cannot: which ownership
    denial message applies, whether an omitted ``title``/``description`` should
    produce an activity row, and whether the caller is trying to change
    ``column``/``swimlane``/``position`` (which belong on the move transition —
    see :class:`~boards.services.errors.UseMoveEndpoint`). Pass an empty mapping,
    never ``None``, when the caller has no notion of a partial body.

    ``apply()`` performs the validated write; the HTTP adapter passes a closure
    over ``serializer.save``.

    ``force`` is consulted only when the write raises the card's ``weight`` in
    a column with an enforced ``weight_limit`` (#1428); it then follows the
    move path's rule — a board admin may override, nobody else.

    ``expected_version`` is the optimistic-concurrency guard ``move_card``
    already takes, with the same semantics (#1974): ``None`` skips the check
    (the REST PATCH/PUT adapter never passes one, so REST behavior is
    unchanged); a non-integer raises ``InvalidVersion`` after the role, 404
    and ownership gates, as on move; a mismatch raises ``VersionConflict``
    carrying the stored version, and nothing is written or broadcast. The
    comparison is made against the row read under the card lock, not the
    caller's snapshot: comparing earlier would let a write that committed
    between the snapshot and the lock slip past the guard.

    The whole sequence — save, activity rows, notification, deferred broadcast
    registration — is one transaction, so a failure at any step rolls back
    rather than leaving a saved card with no audit trail.
    """
    role = _resolve_role(actor, board, role)
    _require_mutation_role(role)

    # Archived cards are not editable. The REST adapter never reaches this
    # branch because its queryset already excludes them (a 404); the guard is
    # here so a direct caller gets the same answer instead of silently editing
    # an archived card. A deliberate purge/restore path needs its own entry
    # point, not this one.
    if card.archived_at is not None:
        raise CardNotFound()

    _require_own_content(
        board, role, actor, card,
        denial=(
            "Assigning cards requires Moderator or Admin access — ask a board admin."
            if "assignee_id" in submitted
            else "You can only edit cards you created."
        ),
    )

    # Coerced here, after the role, 404 and ownership gates, for the reason
    # move_card coerces its own: a caller who fails one of those must see that
    # answer, not a 400 about a malformed version they also sent.
    if expected_version is not None:
        try:
            expected_version = int(expected_version)
        except (TypeError, ValueError):
            raise InvalidVersion() from None

    _reject_cell_change(board, card, submitted)

    board_id = card.board_id
    with transaction.atomic():
        # Board row FOR SHARE before anything else (#1632; see
        # lock_board_for_card_write): apply() writes labels and custom-field
        # values resolved before this transaction, and the serializer re-reads
        # them under this lock. Board -> card -> column, the container
        # delete's order. A board deleted meanwhile took the card with it.
        if not lock_board_for_card_write(board_id):
            raise CardNotFound()
        # Card row next (#1587): without it a delete committing between the
        # caller's read and apply() makes serializer.save()'s UPDATE match no
        # row, and Django falls back to an INSERT that re-creates the card.
        # Taken before enforce_column_limits below locks the column, keeping
        # the card -> column order move_card uses.
        locked = lock_card_for_write(card.pk)
        # Re-read under the lock (#1598). `card` is the caller's snapshot from
        # before the lock, and apply() -> serializer.save() writes *every*
        # column of it, not just the patched ones. An archive or a move that
        # committed between that read and this lock would otherwise be
        # silently undone: archived_at written back to NULL, the card put back
        # in its old cell, and no CardMovement row for the reversal. Adopting
        # the locked row's values means save() writes current state plus the
        # patch, and the snapshot below, the weight check, the activity diff
        # and the broadcast are all computed from post-lock state. Nothing can
        # change the row again before COMMIT: archive, move and reorder all
        # need a lock that conflicts with this one.
        _adopt_locked_state(card, locked)
        # Same answers a request that read the card after the race would get:
        # an archived card is a 404 (the REST queryset and the guard above),
        # and a column/swimlane/position that no longer matches is a move.
        if card.archived_at is not None:
            raise CardNotFound()
        # OCC (#1974): compared against the locked row, which nothing can
        # change again before COMMIT, so a match here cannot go stale before
        # the write. Raising rolls the transaction back before apply() and
        # before the broadcast is registered.
        if expected_version is not None and card.version != expected_version:
            raise VersionConflict(card.version)
        _reject_cell_change(board, card, submitted)
        # Snapshot before the write so the activity diff can name what changed.
        old_title = card.title
        old_priority = card.priority
        old_weight = card.weight
        old_assignee_id = card.assignee_id
        old_assignee_name = card.assignee.username if card.assignee else "Unassigned"
        old_description = card.description
        # _card_labels(), not card.labels.all() (#1223): `card` came from
        # CardViewSet.get_object(), i.e. _card_queryset(), whose labels
        # prefetch is now parked with to_attr — .all() on the M2M manager
        # would miss that parked list and issue a live query here, on every
        # card update, regardless of whether labels actually changed.
        old_labels = _card_labels(card)
        old_label_ids = {label.id for label in old_labels}
        # Captured before the write: a removed label is gone from the card
        # afterwards, so its name can only be resolved from this pre-write
        # snapshot (#1511). Costs no extra query.
        label_name_by_id = {label.id: label.name for label in old_labels}
        old_due_date = card.due_date.isoformat() if card.due_date else ""

        apply()
        # Weight limit (#1428): only a weight *increase* can push the column
        # over its budget, so only an increase is checked. A decrease, an
        # unchanged weight, or any other field edit is always allowed — even in
        # a column that is already over its WIP or weight limit — because
        # refusing it would trap a card in a state the edit does not worsen.
        # WIP is not checked: the column holds the same number of cards. The
        # card row is already locked at the top of this block, so locking the column
        # row now keeps the card → column order move_card uses. A refusal
        # raises inside this transaction and rolls the write back.
        if card.weight > old_weight:
            # The row's weight limit too (#1150), when the card's column counts
            # toward it: the card grows in place in its swimlane as in its
            # column. Locked column -> swimlane, after the card row.
            enforce_column_limits(
                board=board, column=card.column, card=card, role=role, force=force,
                check_wip=False, swimlane=card.swimlane,
            )
        # OCC: bump version on every field update (as move_card does on a move) so
        # stale clients detect conflicts. Archive/unarchive, comments, attachments,
        # checklists and relations do not bump it (see Card.version).
        Card.objects.filter(pk=card.pk).update(version=F("version") + 1)
        # Only reload version — scoping fields= prevents clearing the labels
        # prefetch cache, which would make card.labels.all() below re-query.
        card.refresh_from_db(fields=["version"])
        # Re-prefetch labels since the write may have changed the M2M.
        prefetch_related_objects([card], "labels")

        activities = []
        assignment_notifications = []
        ET = CardActivity.EventType

        if old_title != card.title and "title" in submitted:
            activities.append(CardActivity(
                card=card, event_type=ET.TITLE_CHANGE,
                from_value=old_title, to_value=card.title, actor=actor,
            ))
        if old_priority != card.priority:
            activities.append(CardActivity(
                card=card, event_type=ET.PRIORITY_CHANGE,
                from_value=old_priority, to_value=card.priority, actor=actor,
            ))
        if old_weight != card.weight:
            activities.append(CardActivity(
                card=card, event_type=ET.WEIGHT_CHANGE,
                from_value=str(old_weight), to_value=str(card.weight), actor=actor,
            ))
        if old_assignee_id != card.assignee_id:
            new_name = card.assignee.username if card.assignee else "Unassigned"
            activities.append(CardActivity(
                card=card, event_type=ET.ASSIGNEE_CHANGE,
                from_value=old_assignee_name, to_value=new_name, actor=actor,
            ))
            # Notify the new assignee unless they opted out. Collected here,
            # where the assignee change is detected, but handed to
            # create_notifications at the end of the block — on_commit callbacks
            # run in registration order, and registering this one first would put
            # notification dispatch ahead of the card.updated broadcast every
            # other client on the board is waiting for.
            if card.assignee and card.assignee != actor and card.assignee.notif_card_assigned:
                assignment_notifications.append(
                    Notification(
                        recipient=card.assignee,
                        actor=actor,
                        action_type=Notification.ActionType.ASSIGNED,
                        verb=quoted_card_verb("You were assigned to", card.title),
                        card=card,
                        board=card.board,
                    )
                )
        if old_description != card.description and "description" in submitted:
            activities.append(CardActivity(
                card=card, event_type=ET.DESCRIPTION_CHANGE,
                from_value="", to_value="", actor=actor,
            ))
            # Deferred so the updated description is already committed when the
            # mention notifications are created.
            _notify_mentions_after_commit(card, actor, old_description, card.description)
        new_label_ids = {label.id for label in card.labels.all()}
        if old_label_ids != new_label_ids:
            added = new_label_ids - old_label_ids
            removed = old_label_ids - new_label_ids
            parts = []
            # Merge in the post-write labels (already prefetched) so added
            # names resolve; removed names come from the pre-write snapshot.
            label_name_by_id.update({lbl.id: lbl.name for lbl in card.labels.all()})
            if added:
                names = [label_name_by_id[lid] for lid in added if lid in label_name_by_id]
                parts.append(f"+{', '.join(names)}")
            if removed:
                names = [label_name_by_id[lid] for lid in removed if lid in label_name_by_id]
                parts.append(f"-{', '.join(names)}")
            activities.append(CardActivity(
                card=card, event_type=ET.LABEL_CHANGE,
                from_value="", to_value=", ".join(parts), actor=actor,
            ))
        new_due_date = card.due_date.isoformat() if card.due_date else ""
        if old_due_date != new_due_date:
            activities.append(CardActivity(
                card=card, event_type=ET.DUE_DATE_CHANGE,
                from_value=old_due_date, to_value=new_due_date, actor=actor,
            ))

        if activities:
            CardActivity.objects.bulk_create(activities)

        payload = render(card)
        _broadcast_after_commit(board_id, _broadcast.EVT_CARD_UPDATED, payload, actor.id)
        _fire_hooks("card.updated", card.id, board_id, actor.id)
        # Registered last on purpose — see the comment at the assignee branch.
        if assignment_notifications:
            create_notifications(
                assignment_notifications,
                context={"previous_assignee_name": old_assignee_name},
            )
    return CardMutationResult(card=card, payload=payload)


# ---------------------------------------------------------------------------
# move
# ---------------------------------------------------------------------------

def move_card(
    *, actor, board, card_id, target_column_id, target_swimlane_id, position,
    render, expected_version=None, force=False, role=None,
):
    """Move a card to a column/swimlane/position, writing a ``CardMovement``.

    Takes a ``card_id`` rather than a ``Card`` because the row must be read and
    locked *inside* this function's transaction: a card the caller fetched
    beforehand is not locked and may already be stale.

    Lock order, which is the deadlock-avoidance contract and must not change:
    first the moved card together with every card in its source and target
    cells, in **one** statement ordered by pk; then, when the card changes
    cell, the source and target column rows, again in one pk-ordered statement
    (``FOR NO KEY UPDATE``) — taken on every move, including a reorder within
    one cell, whose single column is locked; then, only when the target
    swimlane has a limit the move is checked against (#1150), the target
    swimlane row (``FOR NO KEY UPDATE``, in ``enforce_column_limits``). So:
    card -> column -> swimlane. No path takes a card or column row after a
    swimlane row: a swimlane delete locks its cards and columns first
    (``lock_cards_for_cascade``), and a swimlane settings save or reorder
    takes only the board row and swimlane rows. The board row is the one lock
    a move needs after its swimlane row (``FOR KEY SHARE``, for the
    ``CardMovement`` insert), which is why every swimlane writer that holds a
    swimlane row locks the board ``FOR NO KEY UPDATE`` (it does not block
    ``FOR KEY SHARE``) and never ``FOR UPDATE``. No card row is locked after a
    column row, and no card row the compaction or shift UPDATEs write is locked
    outside that single pk-ordered statement, so concurrent moves queue rather
    than deadlock (#1522: locking the card first and its siblings after
    deadlocked two moves out of one cell). The second half of that guarantee
    needs a re-check (#1567): the locking statement's snapshot predates its
    lock wait, so a card a concurrent move commits *into* a locked cell while
    this move waits is not locked by it. Once the column rows are held, no
    service path (``create_card``, ``move_card`` and the tools that call them)
    can put another card into either cell until this move commits, so the
    cells are re-read then and the attempt is retried if any card in them is
    unlocked. Django admin card edits are not yet covered (#1588).

    Because the source cell is only known once the card is read, the card is
    read unlocked, then re-checked under the lock; if it, or the membership of
    its cells, changed in between, the attempt rolls back and is retried, and a
    move that keeps losing that race ends in ``VersionConflict`` (409), never a
    500.

    ``force`` only ever relaxes a *soft* limit, and only for a board admin.
    Hard WIP mode is evaluated before ``force`` is consulted at all, so no role
    can override it.

    ``expected_version`` is taken raw and coerced here, not by the caller — see
    the note in the module docstring about why its 400 cannot move earlier.

    Unlike ``update_card`` and ``delete_card``, this transition **does** accept
    an archived card, and the exemption is deliberate rather than an oversight.
    The move endpoint has always read through the unfiltered manager, so
    archiving a card never froze its position: a restored card returns to
    wherever it was put, and tidying archived history is a legitimate operation.
    A guard here would be a behavior change rather than a tightening —
    ``test_archived_cards_can_still_be_moved`` pins it.
    """
    role = _resolve_role(actor, board, role)
    _require_mutation_role(role)

    # The card's cell is only known after reading the card, and the cell has to
    # be locked *with* the card in one pk-ordered statement (see
    # _lock_move_cells), so the card is read unlocked first and re-validated
    # under the lock. If a concurrent writer changed it in between, the attempt
    # is rolled back — releasing its locks — and repeated against the new state.
    for _attempt in range(_MOVE_LOCK_ATTEMPTS):
        try:
            return _move_card_attempt(
                actor=actor, board=board, card_id=card_id,
                target_column_id=target_column_id, target_swimlane_id=target_swimlane_id,
                position=position, render=render, expected_version=expected_version,
                force=force, role=role,
            )
        except _CardChangedBeforeLock as exc:
            current_version = exc.current_version
    # Only reachable when the card, or its cells' membership, changes between
    # read and lock on every attempt — a clean conflict for the caller to
    # retry, never a deadlock.
    raise VersionConflict(current_version)


# How many times move_card re-reads a card that changed between its unlocked
# read and its row lock (or whose cells gained a card it did not lock). One
# retry covers the ordinary race; the bound only exists so a card under
# constant concurrent writes ends in a 409, not a loop.
_MOVE_LOCK_ATTEMPTS = 3


class _CardChangedBeforeLock(Exception):
    """Internal: the card, or its cells' membership, changed before the lock."""

    def __init__(self, current_version):
        super().__init__(current_version)
        self.current_version = current_version


def _lock_move_cells(*, board, card_id, cells):
    """Lock the moved card and every card in ``cells`` in one pk-ordered SELECT.

    This is the whole card-row half of move_card's lock order (#1522). Each
    move used to lock its own card first and its source/target siblings after,
    so two moves out of one cell each held one card and waited for the other's,
    and a move A -> B racing one B -> A took the two cells in opposite orders.
    Both are deadlocks. One statement ordered by pk acquires every row in the
    same global order no matter which card is moving, so concurrent moves that
    share any row queue instead.

    The statement must not join (no ``select_related``). When it waits on a
    card row that a concurrent move then commits, PostgreSQL re-evaluates the
    WHERE clause against the updated card but joins it to the *pre-commit*
    snapshot of any joined row, so ``card.column_id = column.id`` fails and the
    card silently drops out of the result — the loser of two moves of one card
    answered 404 for a card that existed (#1523). Without a join the moved card
    is always found by its pk, and a changed card goes through the
    ``_CardChangedBeforeLock`` retry instead. ``test_same_card_move_race.py``
    pins both. The caller reads column and swimlane from its unlocked read.

    ``of=("self",)`` keeps the lock on card rows only, so that if a join is
    ever added a column-row lock is not taken as a side effect outside the
    documented order. ``cells`` is a set of ``(column_id, swimlane_id)`` pairs.
    Returns ``(card, locked_pks, positions)``: the locked moved card, or
    ``None`` when it no longer exists on the board (deleted by a concurrent
    request: a genuine 404); the pks of every row this statement locked, for
    ``_require_cells_locked``; and ``{pk: position}`` for those rows as read
    under the lock, which ``_shifted_sibling_positions`` diffs against after
    the move's UPDATEs (#1890). A row's position read here is its latest
    committed one: a row this statement waited on is re-read once the lock is
    granted, which is also why ``card.position`` is taken from the locked row.

    What this statement locks is the set of rows in its *snapshot*, which is
    taken before it waits on any lock. A card a concurrent move commits into
    one of the cells during that wait is not in the result and is not locked
    (#1567). ``_require_cells_locked`` closes that gap.
    """
    locked = list(
        Card.objects.filter(_move_cells_filter(card_id, cells), board=board)
        .order_by("pk")
        .select_for_update(of=("self",))
    )
    card = next((row for row in locked if row.pk == card_id), None)
    return (
        card,
        frozenset(row.pk for row in locked),
        {row.pk: row.position for row in locked},
    )


def _move_cells_filter(card_id, cells):
    """The moved card plus every card in ``cells``, as one ``Q``."""
    cell_filter = Q(pk=card_id)
    for column_id, swimlane_id in cells:
        cell_filter |= Q(column_id=column_id, swimlane_id=swimlane_id)
    return cell_filter


def _shifted_sibling_positions(*, board, card_id, cells, positions_before):
    """The siblings a move renumbered, as ``{id, position, version}`` (#1890).

    Why: the compaction and shift UPDATEs in ``_move_card_attempt`` change the
    ``position`` of other cards in the source and target cells, and before
    #1890 the ``card.moved`` frame carried only the moved card, so every other
    client kept the old sibling positions until it reloaded. Those clients
    cannot renumber the cell themselves: they do not know the server's
    tie-break, and a reorder within one cell shifts the cards after the
    target position without compacting the slot the card left. So the server
    sends the result.

    It is a diff, not a model of the UPDATEs: the cells are read back after
    the UPDATEs, inside the move's transaction, and compared with the
    positions ``_lock_move_cells`` read under the lock. Every row in the cells
    is locked by this move and no card can enter them while it holds their
    column rows (``_require_cells_locked``), so the read sees exactly what
    this transaction will commit. One query; the result is bounded by the two
    cells, and holds only cards whose position changed.

    Archived cards are left out. The target-cell shift moves them too, but no
    client shows an archived card in a cell, and a restored card's frame
    (``card.unarchived``) carries its position anyway. ``version`` is the
    sibling's own, which a position shift does not change: it lets a client
    skip a pair for a card it already holds a newer copy of (the #1969 rule).
    """
    cell_filter = Q()
    for column_id, swimlane_id in cells:
        cell_filter |= Q(column_id=column_id, swimlane_id=swimlane_id)
    rows = (
        Card.objects.filter(cell_filter, board=board, archived_at__isnull=True)
        .exclude(pk=card_id)
        .order_by("pk")
        .values_list("pk", "position", "version")
    )
    return [
        {"id": pk, "position": position, "version": version}
        for pk, position, version in rows
        if positions_before.get(pk) != position
    ]


def _require_cells_locked(*, board, card_id, cells, locked_pks, current_version):
    """Retry the move if its cells now hold a card ``_lock_move_cells`` missed.

    Why this exists (#1567): the pk-ordered lock statement locks the rows in
    the snapshot it took *before* waiting. If a concurrent move commits a card
    into one of the cells during that wait, this move never locked it, and its
    later compaction or shift UPDATE would lock it outside pk order. A third
    move that has meanwhile locked that card and is queued on one this move
    holds then deadlocks with it — a 500 on ``POST /cards/<id>/move/``.

    It runs after ``_lock_move_columns``. Every service path that puts a card
    into a cell (``create_card``, ``move_card`` and the tools that call them)
    holds that cell's column row ``FOR NO KEY UPDATE`` until it commits, so
    once this move holds both columns no further card can enter its cells
    through them, and anything that entered before is committed and visible
    to this fresh read. A newcomer from a service path is therefore either
    seen here or cannot exist. Django admin card edits take the same lock
    through ``lock_card_cell_entry`` (#1588).

    The read is a plain SELECT, not a second ``FOR UPDATE``: locking the
    newcomer here would itself be a lock outside pk order and could wait on
    the very move it would deadlock with. Rolling back instead releases every
    lock this attempt holds, and the retry locks the cells' current members in
    one pk-ordered statement like any other attempt; ``_MOVE_LOCK_ATTEMPTS``
    bounds it, ending in a 409. A card that *left* a cell is harmless (it is
    merely locked for nothing), so only unlocked members are checked.
    """
    current = set(
        Card.objects.filter(_move_cells_filter(card_id, cells), board=board)
        .values_list("pk", flat=True)
    )
    if not current <= locked_pks:
        raise _CardChangedBeforeLock(current_version)


def _move_relevant_state(card):
    """The fields ``move_card``'s gates and cell lock were decided on."""
    return (
        card.version, card.column_id, card.swimlane_id,
        card.assignee_id, card.created_by_id,
    )


def _lock_move_columns(column_ids):
    """Lock the move's source and target column rows, pk-ordered, in one SELECT.

    ``FOR NO KEY UPDATE``: it serializes against limit checks and against a
    column reorder (``FOR UPDATE``) without blocking the ``FOR KEY SHARE``
    locks that FK inserts referencing the column take — see
    ``enforce_column_limits``. ColumnViewSet.reorder locks the board's columns
    in the same pk order.

    Returns the pks of the rows locked, so a caller can tell that a column
    was deleted while it waited (#1602).
    """
    return frozenset(
        column.pk
        for column in Column.objects.filter(pk__in=sorted(column_ids))
        .order_by("pk")
        .select_for_update(no_key=True)
    )


def require_swimlane_exists(swimlane_id):
    """Raise ``SwimlaneNotFound`` when the swimlane was deleted (#1602).

    Called once the caller holds its target column row: a swimlane or board
    delete holds every column of the board until it commits, so by the time
    the column lock is granted such a delete has committed and this plain read
    sees it. Without the check the card's deferred swimlane FK fails at COMMIT
    with a 500.
    """
    if not Swimlane.objects.filter(pk=swimlane_id).exists():
        raise SwimlaneNotFound()


def lock_card_cell_entry(*, card_id, column_ids):
    """Lock a card row, then its source and target column rows, for a write
    that puts the card into a cell outside ``move_card`` (#1588).

    Why: ``move_card``'s membership re-check (``_require_cells_locked``,
    #1567) is conclusive only if every writer that puts a card into a cell
    holds that cell's column row until it commits. The Django admin saves the
    card row directly, and before #1588 it took no column lock for a
    swimlane-only change within one column or for any cell change on an
    archived card (archived cards are still cell members — the lock and
    compaction filters have no ``archived_at`` condition). Such a card could
    commit into a cell after a concurrent move's re-check and then be locked
    by that move's compaction or shift ``UPDATE`` outside pk order.

    Order: the card row first, then the columns in one pk-ordered
    ``FOR NO KEY UPDATE`` statement — the same card -> column order as
    ``move_card`` (and ``_lock_move_columns`` itself), so the admin queues
    behind a move instead of deadlocking with it. Pass ``card_id=None`` when
    there is no card row to lock first: either the card is not yet created,
    or the caller already holds its row because it called ``lock_card_row``
    to decide which columns to lock (every current caller in ``admin.py``
    does one or the other). Must run inside the transaction that saves the
    card: the locks protect nothing once it commits.

    Returns the pks of the column rows locked: a column missing from it was
    deleted while this waited (a container delete holds the column across
    its cascade, #1602), and the caller must refuse the save rather than
    fail the card's deferred foreign-key check at COMMIT.
    """
    if card_id is not None:
        lock_card_row(card_id)
    return _lock_move_columns({pk for pk in column_ids if pk is not None})


def lock_card_row(card_id):
    """Lock one card row ``FOR UPDATE`` and return its placement fields and
    ``version`` (the admin bumps the locked version on save, #1969, #2040).

    The first half of ``lock_card_cell_entry``, exposed on its own for a
    caller that must decide *which* columns to lock from the card's current
    state (#1588): an unlocked read can be stale by the time the lock is
    granted — a concurrent move may have committed in between — so the
    source column is read here, under the lock, and the columns are locked
    after. Returns ``None`` when the card no longer exists.
    """
    return (
        Card.objects.filter(pk=card_id)
        .select_for_update(of=("self",))
        .only("pk", "column_id", "swimlane_id", "archived_at", "weight", "version")
        .first()
    )


def lock_cards_for_cascade(cards, *, entry_columns=None, boards=None):
    """Lock every card in ``cards`` ``FOR UPDATE``, pk-ordered, in one
    statement, before a column, swimlane or board delete cascades to them
    (#1599).

    Why: the container's cascade is ``delete_card``'s cascade times N, and it
    had the same race ``delete_card`` closed in #1587. Django's collector
    reads each card's child rows (comments, checklist items, attachments,
    relations, activity) before it deletes anything; a child write holding
    ``lock_card_for_write`` could insert a row the collector never saw and
    commit before the container's card ``DELETE`` reached that card. The card
    foreign keys are ``DEFERRABLE INITIALLY DEFERRED`` on PostgreSQL, so the
    container delete then failed its own FK check at COMMIT — a 500. Holding
    the card rows first means a write that started earlier commits before the
    collector reads (so its rows are cascaded away), and a write that starts
    later waits, finds the card gone, and answers 404.

    Locking was chosen over catching the commit-time ``IntegrityError`` and
    retrying: the error surfaces at COMMIT, after the view's work and
    broadcasts were queued, and a retry loop would only repeat the race.

    Lock order for a container delete: board rows (``boards``) -> card rows
    -> entry column rows (``entry_columns``); the collector's ``DELETE`` of
    the container comes after. The card rows go in **one** statement ordered
    by pk — the same shape as ``move_card``'s card lock, so the two queue
    rather than deadlock — and before any column row, keeping the card ->
    column order. ``FOR UPDATE`` because the rows are about to be
    deleted, which ``FOR NO KEY UPDATE`` would not cover. One query however
    many cards; only pks are read. Archived cards are included: they cascade
    too, so pass an unfiltered queryset. Must run inside the transaction that
    deletes the container. On SQLite the lock clause is a no-op.

    ``of=("self",)`` keeps the lock on card rows even when ``cards`` joins
    (the user admin filters on ``board__owner``): a board row locked
    ``FOR UPDATE`` here would block the ``FOR KEY SHARE`` a concurrent
    ``create_card`` needs on it at COMMIT while that create holds the column
    row this helper then waits for — a deadlock.

    Cards that *enter* the container (#1602). The statement locks the rows of
    its snapshot, so a card ``create_card`` inserts into the container, or
    ``move_card`` moves into an empty cell of it, could commit after it and
    before the collector's card ``DELETE`` — the same COMMIT-time 500. Pass
    ``entry_columns``, the column rows whose lock every such writer holds
    until it commits (the deleted column; every column of the board for a
    swimlane or board delete). They are locked after the cards, in one
    pk-ordered ``FOR NO KEY UPDATE`` statement, exactly like
    ``_lock_move_columns``, so the card -> column order is kept rather than
    inverted. Once they are held no service path can put another card into
    the container, and any that entered before has committed, so the
    container's cards are re-read: if one is not among the rows locked, the
    attempt is rolled back to a savepoint — which releases its row locks —
    and repeated, the same shape as ``move_card``'s ``_require_cells_locked``
    (#1567). Locking the newcomer in a second statement instead would take a
    card row after a column row, and could deadlock with a move of that card
    that holds it and waits on the column. A container that gains a card on
    every one of ``_CASCADE_LOCK_ATTEMPTS`` attempts raises
    ``ContainerChanged`` (409) with nothing deleted. Django admin card adds
    and edits take the same column lock (``lock_card_cell_entry``, #1588);
    board import and the seed commands create cards only in a board they are
    creating, so nothing can delete it concurrently.

    The board row first (``boards``, #1602). Column create, swimlane create
    and swimlane reorder take the board row ``FOR UPDATE`` and column reorder
    takes it ``FOR NO KEY UPDATE`` (#1566) *before* any column row. Holding
    the entry columns without the board row inverted that: a board delete
    held the columns and then needed the board row for its ``DELETE``, while
    a column reorder held the board row and waited on a column — a deadlock
    (#1604's shape, made reachable earlier by the column lock). So a
    container delete takes its board row(s) first, pk-ordered, ``FOR NO KEY
    UPDATE``: that conflicts with every board-row lock above, so those
    requests queue behind the whole delete (or it behind them) in the same
    board -> column order, and it also stops a column being created in the
    board mid-delete, so the ``entry_columns`` statement sees every column a
    card could enter through. It must not be ``FOR UPDATE``: a
    ``create_card`` holding a column needs ``FOR KEY SHARE`` on the board at
    COMMIT, which ``FOR UPDATE`` would block while this delete waits on that
    column. Taken once, outside the retry savepoint, since nothing it guards
    changes between attempts. No path takes a board-row lock after a card or
    column lock (``docs/architecture/service-layer.md`` lists the order).

    The retry needs a transaction to roll back into, so with
    ``entry_columns`` or ``boards`` the helper refuses to run outside one
    (``RuntimeError``) rather than silently committing its locks away.
    """
    if (entry_columns is not None or boards is not None) and not (
        transaction.get_connection().in_atomic_block
    ):
        raise RuntimeError("lock_cards_for_cascade must run inside transaction.atomic()")
    if boards is not None:
        _lock_cascade_boards(boards)
    if entry_columns is None:
        _lock_cascade_cards(cards)
        return
    for _attempt in range(_CASCADE_LOCK_ATTEMPTS):
        try:
            with transaction.atomic():
                locked = _lock_cascade_cards(cards)
                _lock_entry_columns(entry_columns)
                if not _cascade_card_pks(cards) <= locked:
                    raise _ContainerGainedCard()
            return
        except _ContainerGainedCard:
            continue
    raise ContainerChanged()


def delete_boards_locked(boards):
    """Delete ``boards`` with the container-delete locks, in one transaction.

    For callers outside a view or admin, such as the seed commands' ``--wipe``,
    which the demo cronjob runs against a live instance (#1602). Takes the
    board rows, their cards and their columns exactly as ``BoardViewSet``'s
    destroy does, so a concurrent card create, move or child write queues
    instead of failing the delete at COMMIT. Returns ``QuerySet.delete()``'s
    result. May raise ``ContainerChanged``, with nothing deleted.
    """
    with transaction.atomic():
        # Resolve the set once, inside the transaction, and use these pks for
        # every statement: with a lazy name filter, a board created with the
        # same name between the lock statements and the final DELETE would be
        # deleted without ever being locked.
        board_pks = list(boards.values_list("pk", flat=True))
        locked = boards.model.objects.filter(pk__in=board_pks)
        lock_cards_for_cascade(
            Card.objects.filter(board_id__in=board_pks),
            entry_columns=Column.objects.filter(board_id__in=board_pks),
            boards=locked,
        )
        return locked.delete()


# How many times lock_cards_for_cascade re-takes its locks when a card entered
# the container between its card lock and its column lock. One retry covers
# the ordinary race; the bound only exists so a container under constant
# inserts ends in a 409, not a loop.
_CASCADE_LOCK_ATTEMPTS = 3


class _ContainerGainedCard(Exception):
    """Internal: a card entered the container after the card-row lock."""


def _lock_cascade_boards(boards):
    """Lock ``boards`` pk-ordered, ``FOR NO KEY UPDATE``, in one statement —
    the first lock a container delete takes (see ``lock_cards_for_cascade``)."""
    list(
        boards.order_by("pk")
        .select_for_update(no_key=True, of=("self",))
        .values_list(
            "pk",
            flat=True,  # pragma: no mutate -- equivalent: the list() result is discarded (#1931)
        )
    )


def _lock_cascade_cards(cards):
    """The card-row statement of ``lock_cards_for_cascade``; returns the pks."""
    return frozenset(
        cards.order_by("pk").select_for_update(of=("self",)).values_list("pk", flat=True)
    )


def _lock_entry_columns(columns):
    """Lock ``columns`` pk-ordered, ``FOR NO KEY UPDATE``, in one statement —
    the mode and order of ``_lock_move_columns``, so a container delete queues
    with moves, creates and column reorders instead of deadlocking."""
    list(
        columns.order_by("pk")
        .select_for_update(no_key=True, of=("self",))
        .values_list(
            "pk",
            flat=True,  # pragma: no mutate -- equivalent: the list() result is discarded (#1931)
        )
    )


def _cascade_card_pks(cards):
    """The container's current card pks, read without a lock (#1602)."""
    return set(cards.values_list("pk", flat=True))


# Static literals, not built from Board._meta: the table name is pinned by
# Board.Meta.db_table and the lock-order tests assert this exact statement.
# Django's select_for_update() has no FOR SHARE mode, hence the raw statement;
# the only value is the bound board id.
_BOARD_SHARE_LOCK_SQL = {
    "postgresql": 'SELECT 1 FROM "boards" WHERE "id" = %s FOR SHARE',
    None: 'SELECT 1 FROM "boards" WHERE "id" = %s',
}


def lock_board_for_card_write(board_id):
    """Hold the card's board row ``FOR SHARE`` for the rest of the caller's
    transaction; return ``False`` when the board is already gone (#1632).

    Why: a card create or update resolves the labels (``label_ids``) and
    custom-field definitions (``custom_field_values``) it names at
    validation, before its transaction. A label or definition DELETE that
    committed in between, or that commits before the card write does, left
    the M2M or value row the card write inserts pointing at a missing row:
    a ``500`` from the deferred foreign key at COMMIT. Every deleter of a
    label or definition (the REST ``DELETE``s and admin deletes through
    ``lock_board_and_row_or_404``/``_lock_board_for_admin_save``, the
    container and user deletes through ``lock_cards_for_cascade(boards=...)``)
    takes the board row ``FOR NO KEY UPDATE`` first, which conflicts with
    ``FOR SHARE``. So once this lock is granted no such delete is in flight
    and none can start before this transaction ends, and
    ``CardSerializer._require_live_referents`` re-reads the named rows: one
    that a delete removed answers ``400``, as a request naming an unknown id
    always did.

    Why the board row and this mode: ``FOR SHARE`` does not conflict with
    itself or with ``FOR KEY SHARE``, so card writes on one board do not
    queue behind each other (``FOR NO KEY UPDATE`` would serialize every card
    write on the board) and the ``FOR KEY SHARE`` a card insert takes on the
    board at COMMIT is unaffected. It does conflict with every board-row lock
    a structure writer takes (``FOR NO KEY UPDATE``/``FOR UPDATE``), so those
    and a card write queue whole, in either order. Locking the label and
    definition rows instead (the first attempt at #1632) put them between the
    card row and the column row on update and after the column row on
    create, and a create and a weight-raising update naming the same label
    deadlocked on it.

    Lock order: the board row is the first lock of the card transaction,
    before the card row (``lock_card_for_write``) and any column row, and
    the transaction then holds it while it waits for anything else. No path
    takes a board-row lock after a card or column lock
    (``docs/architecture/service-layer.md``). One more edge exists: at
    COMMIT the card write takes ``FOR KEY SHARE`` on the user rows its
    foreign keys name (activity actor, ``created_by``, ``assignee``). So a
    transaction that holds a user row ``FOR UPDATE`` and then locks or
    UPDATEs a board row would close a cycle. The only such path was the
    user deactivation's board transfer, which now locks the user ``FOR NO
    KEY UPDATE`` (it does not block ``FOR KEY SHARE``), like the user admin
    delete (#1616). No other path takes a board, card or column lock after
    a user-row ``FOR UPDATE``: the credential, login, access-change and
    email-change paths and the user admin save take none at all, and the
    user admin delete locks its targets ``FOR NO KEY UPDATE``, then the
    owned boards and the cards, and only then the targets ``FOR UPDATE``
    (``_lock_cards_then_targets``), so it waits at the board row while
    holding nothing that blocks ``FOR KEY SHARE``. Nothing in a card create or update writes
    the board row, so two writers holding ``FOR SHARE`` never upgrade into
    each other. There is no lock timeout: a card write waits for a
    board-row writer (and the reverse) for as long as that transaction
    runs, which for a large container delete is the whole cascade. On
    SQLite there is no row lock and only the existence check remains. Must
    be called inside ``transaction.atomic()``.
    """
    sql = _BOARD_SHARE_LOCK_SQL.get(connection.vendor, _BOARD_SHARE_LOCK_SQL[None])
    with connection.cursor() as cursor:
        cursor.execute(sql, [board_id])
        return cursor.fetchone() is not None


def lock_card_for_write(card_id):
    """Lock a card row ``FOR NO KEY UPDATE`` for the rest of the caller's
    transaction, raising ``CardNotFound`` when the row is already gone (#1587).

    Why: a write that targets an existing card — a field update, or a child
    row (comment, checklist item, attachment, relation, activity) inserted
    against it — otherwise holds nothing on the card row until commit, so a
    concurrent hard delete can commit in between:

    * a field update's ``save()`` matches zero rows and Django falls back to
      an INSERT, re-creating the deleted card under the same pk (minus its
      children), and clients see ``card.deleted`` then ``card.updated``;
    * a child insert's foreign key is ``DEFERRABLE INITIALLY DEFERRED`` on
      PostgreSQL, so the check runs at COMMIT and fails with an
      ``IntegrityError`` — a 500 after the response had been built.

    Holding the card row closes both: a delete that started first commits
    before this lock is granted, and the empty result answers 404 before
    anything is written or broadcast; a delete that starts after waits for
    this transaction, and its cascade then sees (and removes) the new child
    rows. ``FOR NO KEY UPDATE`` is enough — DELETE needs ``FOR UPDATE``,
    which conflicts with it — and it is the mode a plain UPDATE of the row
    takes anyway.

    Returns the row as read under the lock, which callers that go on to save
    the card must write from instead of an earlier snapshot (#1598).

    Lock order: this is the card row, so it must be taken before any column
    row the same transaction locks (card -> column, as ``move_card`` and
    ``lock_card_cell_entry`` do). Must be called inside ``transaction.atomic()``.
    On SQLite the lock clause is a no-op and only the existence check remains.
    """
    locked = Card.objects.filter(pk=card_id).select_for_update(no_key=True).first()
    if locked is None:
        raise CardNotFound()
    return locked


def _read_card_for_move(card_id, board):
    """The unlocked read that starts each ``move_card`` attempt."""
    try:
        return Card.objects.select_related("column", "swimlane").get(pk=card_id, board=board)
    except Card.DoesNotExist:
        raise CardNotFound() from None


def _move_card_attempt(
    *, actor, board, card_id, target_column_id, target_swimlane_id, position,
    render, expected_version, force, role,
):
    """One locked attempt at ``move_card``; see its docstring for the contract."""
    board_id = board.id
    with transaction.atomic():
        # Unlocked read: the gates below are evaluated on it so their order —
        # 404, assignment, version, then target lookups — is unchanged, and it
        # names the source cell that _lock_move_cells must take.
        card = _read_card_for_move(card_id, board)

        # Ownership/assignment gate: any member may move unassigned cards or
        # cards they created, and the assignee of a card may move it (they own
        # the work). Moving a card assigned to somebody else and not created by
        # the actor requires Moderator or Admin access.
        if (
            card.assignee_id is not None
            and card.created_by_id != actor.id
            and card.assignee_id != actor.id
            and not can_modify_others_content(board, role, actor)
        ):
            raise MoveNotPermitted()

        # Optimistic concurrency control — reject stale writes. Optional for
        # backward compatibility: a caller that supplies no version skips OCC.
        #
        # The int() coercion is here rather than in the adapter because its
        # position in the sequence is observable: a caller who fails the role
        # allow-list, names a card that does not exist, or fails the assignment
        # gate must see that answer, not a 400 about a malformed version they
        # also sent.
        if expected_version is not None:
            try:
                expected_version = int(expected_version)
            except (TypeError, ValueError):
                raise InvalidVersion() from None
            if card.version != expected_version:
                raise VersionConflict(card.version)

        # Same placement rule as the version coercion above. A huge or negative
        # integer reached the INSERT/UPDATE unchecked and Postgres answered
        # "integer out of range" as a 500 (#1570, schema-fuzz); it is clamped
        # below, once the target cell is locked.
        try:
            position = int(position)
        except (TypeError, ValueError, OverflowError):
            raise InvalidPosition() from None

        target_column = _board_scoped(Column, target_column_id, board, ColumnNotFound)
        target_swimlane = _board_scoped(Swimlane, target_swimlane_id, board, SwimlaneNotFound)

        cells = {
            (card.column_id, card.swimlane_id),
            (target_column.pk, target_swimlane.pk),
        }
        locked, locked_pks, positions_before = _lock_move_cells(
            board=board, card_id=card.pk, cells=cells,
        )
        if locked is None:
            # Deleted between the read and the lock.
            raise CardNotFound()
        if _move_relevant_state(locked) != _move_relevant_state(card):
            # The gates above were judged on the unlocked read, and the cells
            # locked are the ones that read named. ``version`` alone cannot
            # vouch for either: not every write bumps it (archive/unarchive and
            # the ``clear_viewer_assignees`` command do not), so every
            # field the gates or the lock depend on is compared. If any moved,
            # start over on the new state.
            raise _CardChangedBeforeLock(locked.version)
        # Sibling compaction does not bump ``version``, so the position read
        # before the lock may be stale; the locked row's is current.
        card.position = locked.position

        column_changed = card.column_id != target_column.pk
        swimlane_changed = card.swimlane_id != target_swimlane.pk

        # Column rows, after the card rows (#1522). The CardMovement insert
        # and the card's column change below take FOR KEY SHARE on the
        # source and target columns, and a column reorder updates
        # ``position`` (a unique key) and so holds FOR UPDATE on every
        # column row. Taking both rows here, in one pk-ordered statement,
        # before any of those FK checks, gives every move and reorder the
        # same column order — so they queue instead of deadlocking.
        #
        # Taken for a reorder within one cell too, although it changes no
        # column (#1567): holding the cell's column is what stops a service
        # path (create_card, move_card) putting another card into the cell
        # before this move commits, which is what makes the membership
        # re-check below conclusive. Django admin card edits take it too, via
        # lock_card_cell_entry (#1588).
        locked_columns = _lock_move_columns({card.column_id, target_column.pk})
        # A column, swimlane or board delete holds these column rows across
        # its cascade (#1602). A move that waited on one finds the target
        # gone once it is granted: answer 404 rather than fail the
        # CardMovement's and card's deferred FK checks at COMMIT with a 500.
        # A container the card is already in cannot vanish here: its delete
        # locks the card first, and the card lock above answers that. So the
        # swimlane is only re-read when the move leaves it, keeping a
        # same-cell reorder within its query budget.
        if target_column.pk not in locked_columns:
            raise ColumnNotFound()
        if swimlane_changed:
            require_swimlane_exists(target_swimlane.pk)
        _require_cells_locked(
            board=board, card_id=card.pk, cells=cells, locked_pks=locked_pks,
            current_version=locked.version,
        )

        # WIP and weight enforcement. A column limit applies only when the card
        # enters a different column, so a swimlane-only move within one column
        # is exempt from it; a swimlane limit (#1150) applies only when the
        # move adds to the target row's counted total (see
        # _swimlane_check_applies), so a reorder, or a move between two
        # counted columns of one row, is exempt from it. A reorder within one
        # cell checks nothing. The target column row is already locked above,
        # so the helper does not lock it again; it locks the target swimlane
        # row itself, after the columns (card -> column -> swimlane).
        if column_changed or swimlane_changed:
            enforce_column_limits(
                board=board, column=target_column, card=card, role=role, force=force,
                lock=False, swimlane=target_swimlane,
                source=(card.column, card.swimlane_id), check_column=column_changed,
            )

        movement = None
        if column_changed or swimlane_changed:
            movement = CardMovement.objects.create(
                card=card,
                from_column=card.column,
                from_column_name=card.column.name,
                from_column_uid=card.column.uid,
                to_column=target_column,
                to_column_name=target_column.name,
                to_column_uid=target_column.uid,
                from_swimlane=card.swimlane,
                from_swimlane_name=card.swimlane.name,
                from_swimlane_uid=card.swimlane.uid,
                to_swimlane=target_swimlane,
                to_swimlane_name=target_swimlane.name,
                to_swimlane_uid=target_swimlane.uid,
                moved_by=actor,
            )

            # Compact the gap the moved card leaves in its (already locked)
            # source cell. A single bulk UPDATE (decrement every position after
            # the moved card) rather than a per-row save() loop, so a large
            # source cell does not cost O(N) queries. This endpoint keeps
            # positions compact, so -1 is equivalent to a full renumber.
            Card.objects.filter(
                board=board, column=card.column, swimlane=card.swimlane,
                archived_at__isnull=True,
            ).exclude(pk=card.pk).filter(position__gt=card.position).update(
                position=F("position") - 1
            )

        # Clamp into [0, highest sibling + 1]. Order-preserving for any input
        # (nothing sorts after "one past the last", and the shift below moves
        # every sibling for any value at or under the lowest), and it bounds
        # stored positions by the cell size. A fixed cap would not: repeated
        # moves to just under it shift the top sibling past int32 (#1570).
        target_cell = Card.objects.filter(
            board=board, column=target_column, swimlane=target_swimlane
        ).exclude(pk=card.pk)
        highest = target_cell.aggregate(m=Max("position"))["m"]
        # An empty cell caps at 0 (the same result as any negative bound under
        # max(0, ...)); a bound of 1 would leave a gap, which a test pins (#1931).
        position = max(0, min(position, 0 if highest is None else highest + 1))

        # Shift the (already locked) target cell to make room.
        target_cell.filter(position__gte=position).update(
            position=F("position") + 1
        )

        card.column = target_column
        card.swimlane = target_swimlane
        card.position = position
        card.version = F("version") + 1
        card.save(update_fields=["column", "swimlane", "position", "version"])
        card.refresh_from_db(fields=["version"])
        sibling_positions = _shifted_sibling_positions(
            board=board, card_id=card.pk, cells=cells, positions_before=positions_before,
        )

        payload = render(card, movement)
        # The WebSocket payload is the REST body, so a client can update its
        # movement history without re-polling /movements/, plus the siblings
        # this move renumbered (#1890; additive, the REST body is unchanged).
        _broadcast_after_commit(
            board_id, _broadcast.EVT_CARD_MOVED,
            {**payload, "sibling_positions": sibling_positions}, actor.id,
        )
        _fire_hooks("card.moved", card.id, board_id, actor.id)
    return CardMutationResult(card=card, payload=payload, movement=movement)


# ---------------------------------------------------------------------------
# archive / unarchive
# ---------------------------------------------------------------------------

def _fetch_for_archive(card_id, board):
    """Fetch a card including archived ones.

    Uses the unfiltered manager so archiving an already-archived card is a no-op
    rather than a 404. ``select_related`` avoids extra queries when the
    ``CardMovement`` row below reads the column and swimlane names.
    """
    try:
        return (
            Card.objects.select_related("column", "swimlane")
            .get(pk=card_id, board=board)
        )
    except Card.DoesNotExist:
        raise CardNotFound() from None


def _archive_movement(card, actor, movement_type):
    """Record an archive/restore event in movement history.

    from/to column and swimlane are both the card's current ones — its position
    has not changed, only its archive state. Keeping these in the audit trail is
    what lets cycle-time calculations use ``archived_at`` as a terminal
    timestamp, and what makes the trail complete across a restore.
    """
    return CardMovement.objects.create(
        card=card,
        from_column=card.column,
        from_column_name=card.column.name,
        from_column_uid=card.column.uid,
        to_column=card.column,
        to_column_name=card.column.name,
        to_column_uid=card.column.uid,
        from_swimlane=card.swimlane,
        from_swimlane_name=card.swimlane.name,
        from_swimlane_uid=card.swimlane.uid,
        to_swimlane=card.swimlane,
        to_swimlane_name=card.swimlane.name,
        to_swimlane_uid=card.swimlane.uid,
        moved_by=actor,
        movement_type=movement_type,
    )


def archive_card(*, actor, board, card_id, render, role=None, render_many=None):
    """Soft-delete a card by stamping ``archived_at``.

    Member+ role required — the same boundary as edit and delete. Archiving an
    already-archived card is a no-op that still returns the card, and
    broadcasts nothing.

    The broadcast payload is only ``{"card_uid": ...}`` while the returned
    payload is the whole card; unlike every other transition here the two are
    deliberately different, because a client only needs to remove the card from
    its board view. Do not "fix" the asymmetry — the event schema is frozen.
    """
    role = _resolve_role(actor, board, role)
    _require_mutation_role(role)
    card = _fetch_for_archive(card_id, board)
    _require_own_content(
        board, role, actor, card, denial="You can only archive cards you created.",
    )

    if card.archived_at is None:
        board_id = card.board_id
        card_uid = card.uid
        with transaction.atomic():
            # Card row first (#1587): a delete committing after
            # _fetch_for_archive would otherwise make the update_fields save
            # below match no row and raise "did not affect any rows" (a 500).
            locked = lock_card_for_write(card.pk)
            # Decide from the row read under the lock, not the pre-lock read
            # (#1605). A move committing in between left `card` naming the
            # old cell, so the ARCHIVED movement row recorded A -> A while
            # the card sat in B — a wrong audit trail for cycle-time reports.
            # An archive committing in between would otherwise be overwritten
            # with a later timestamp and fire a second movement row,
            # broadcast and hook. Nothing can change the row again before
            # COMMIT: move, archive and update all need a conflicting lock.
            _adopt_locked_state(card, locked)
            if card.archived_at is None:
                # Read under the lock, like delete_card, so a BLOCKS relation
                # committed while we waited counts: relation create locks both
                # cards FOR UPDATE, which conflicts with lock_card_for_write.
                # Read before it, the newly blocked peer would never get its
                # card.updated frame and keep a stale blocker_count (#1605).
                peer_ids = _blocked_peer_ids(card)
                card.archived_at = timezone.now()
                card.save(update_fields=["archived_at"])
                _archive_movement(card, actor, CardMovement.MovementType.ARCHIVED)
                _broadcast_after_commit(board_id, _broadcast.EVT_CARD_ARCHIVED, {"card_uid": card_uid}, actor.id)
                # Archiving a blocker drops its targets' blocker_count (#449).
                # Rendered after the save so each peer payload reflects the new
                # state, and inside the transaction so it rolls back with it.
                _broadcast_blocked_peers(board_id, peer_ids, actor, render, render_many)
                _fire_hooks("card.archived", card.id, board_id, actor.id)
            # else: archived concurrently — the same no-op as the pre-lock
            # check above, returning the card and broadcasting nothing.
    return CardMutationResult(card=card, payload=render(card))


def unarchive_card(
    *, actor, board, card_id, render, role=None, render_many=None, force=False,
):
    """Restore a card by clearing ``archived_at``.

    The card re-enters its original column/swimlane position. Restoring a card
    that is not archived is a no-op that still returns it, and broadcasts
    nothing.

    Archived cards do not count toward a column's WIP or weight total, so a
    restore re-adds one: it is checked exactly like a move into the column
    (#1428) — hard mode blocks every role, a soft limit can be overridden with
    ``force`` by a board admin only.

    Note the hook event is ``card.restored`` while the WebSocket event is
    ``card.unarchived``. Both names are independently frozen — the WS name by
    the event-schema compatibility rule, the hook name by ``boards.hooks`` — so
    the asymmetry is contract, not a typo.
    """
    role = _resolve_role(actor, board, role)
    _require_mutation_role(role)
    card = _fetch_for_archive(card_id, board)
    _require_own_content(
        board, role, actor, card, denial="You can only restore cards you created.",
    )

    if card.archived_at is None:
        # No-op path: the card was not archived. One render to return state.
        return CardMutationResult(card=card, payload=render(card))

    board_id = card.board_id
    with transaction.atomic():
        # Card row first (#1587) — same delete race as archive_card — and
        # before enforce_column_limits locks the column, keeping the
        # card -> column order move_card uses.
        locked = lock_card_for_write(card.pk)
        # Decide from the locked row (#1605), as archive_card does: a restore
        # committing in between makes this the documented no-op (no second
        # UNARCHIVED row, broadcast or hook), and the movement row and the
        # column limit check below use the card's cell as it is now.
        _adopt_locked_state(card, locked)
        if card.archived_at is None:
            return CardMutationResult(card=card, payload=render(card))
        # Under the lock, as in archive_card: a relation committed while we
        # waited must count, or its peer misses its card.updated frame.
        peer_ids = _blocked_peer_ids(card)
        card.archived_at = None
        card.save(update_fields=["archived_at"])
        # Checked after the write, with the card row already locked above, so
        # the column row comes second (move_card's lock order); a refusal
        # rolls the restore back.
        enforce_column_limits(
            board=board, column=card.column, card=card, role=role, force=force,
            swimlane=card.swimlane,
        )
        _archive_movement(card, actor, CardMovement.MovementType.UNARCHIVED)
        # Rendered inside the atomic block so the payload is a plain dict
        # captured before the callback is registered (#999), and reused as the
        # response rather than re-fetched (#1050).
        payload = render(card)
        _broadcast_after_commit(board_id, _broadcast.EVT_CARD_UNARCHIVED, payload, actor.id)
        # Restoring a blocker puts its targets back into a blocked state (#449)
        # — the mirror of the archive case above.
        _broadcast_blocked_peers(board_id, peer_ids, actor, render, render_many)
        _fire_hooks("card.restored", card.id, board_id, actor.id)
    return CardMutationResult(card=card, payload=payload)


# ---------------------------------------------------------------------------
# block / unblock (#1149)
# ---------------------------------------------------------------------------

def _fetch_for_block(card_id, board):
    """The unlocked read that starts ``block_card`` / ``unblock_card``.

    ``select_related("column")`` because the block row snapshots the column
    the card sits in. Archived cards answer 404, as on every other edit path:
    the REST queryset excludes them, and blocking a card nobody can see on the
    board would only accrue blocked time no one can act on.
    """
    try:
        card = Card.objects.select_related("column").get(pk=card_id, board=board)
    except Card.DoesNotExist:
        raise CardNotFound() from None
    if card.archived_at is not None:
        raise CardNotFound()
    return card


def _bump_version(card):
    """Bump ``Card.version`` for a block-state change, as ``update_card`` does.

    Blocking changes fields every client renders (the card face, the filter),
    so a client that cached the old copy must see a newer version: the web
    client drops any card copy whose version is lower than the one it holds
    (#1969), and an MCP ``update_card``/``move_card`` sent with the old
    version gets ``version_conflict`` rather than acting on stale state.
    """
    Card.objects.filter(pk=card.pk).update(version=F("version") + 1)
    card.refresh_from_db(fields=["version"])


def block_card(*, actor, board, card_id, reason, render, role=None):
    """Mark a card manually blocked, with a reason (#1149).

    Member+ role and the ownership gate, the same boundary as editing the card
    (``update_card``), because the blocked state is a field of the card. The
    reason must already be validated (non-blank, length-capped) by the caller's
    serializer; it is stored verbatim.

    Writes, in one transaction under the card lock: an open ``CardBlock`` row
    (who, when, why, and the column the card is in), the denormalized
    ``Card.blocked_at`` / ``blocked_reason``, a ``blocked`` ``CardActivity``,
    and the version bump. ``card.updated`` is the WebSocket event: the payload
    is a full card carrying the additive blocked fields, so no new event type
    is needed and clients that do not know the fields ignore them.

    A card that is already blocked raises ``CardAlreadyBlocked`` (409), decided
    from the row read under the lock so two concurrent blocks cannot both win;
    the partial unique constraint on ``CardBlock`` is the backstop.
    """
    role = _resolve_role(actor, board, role)
    _require_mutation_role(role)
    card = _fetch_for_block(card_id, board)
    _require_own_content(
        board, role, actor, card, denial="You can only block cards you created.",
    )

    board_id = card.board_id
    with transaction.atomic():
        # Card row first (#1587): a delete committing after the read above
        # would otherwise leave the CardBlock insert pointing at a missing
        # card (a 500 at COMMIT) and the update_fields save matching no row.
        locked = lock_card_for_write(card.pk)
        # Decide from the locked row (#1605): a block, archive or move that
        # committed in between must be seen, or this would open a second
        # block, block an archived card, or snapshot the wrong column.
        _adopt_locked_state(card, locked)
        if card.archived_at is not None:
            raise CardNotFound()
        if card.blocked_at is not None:
            raise CardAlreadyBlocked()
        column = card.column
        now = timezone.now()
        CardBlock.objects.create(
            card=card,
            board_id=board_id,
            card_uid=card.uid,
            card_title=card.title,
            blocked_at=now,
            blocked_by=actor,
            reason=reason,
            column=column,
            column_name=column.name,
            column_uid=column.uid,
        )
        card.blocked_at = now
        card.blocked_reason = reason
        # updated_at is listed so auto_now stamps it: a block is an edit.
        card.save(update_fields=["blocked_at", "blocked_reason", "updated_at"])
        _bump_version(card)
        CardActivity.objects.create(
            card=card, event_type=CardActivity.EventType.BLOCKED,
            from_value="", to_value=reason, actor=actor,
        )
        payload = render(card)
        _broadcast_after_commit(board_id, _broadcast.EVT_CARD_UPDATED, payload, actor.id)
        _fire_hooks("card.updated", card.id, board_id, actor.id)
    return CardMutationResult(card=card, payload=payload)


def unblock_card(*, actor, board, card_id, render, resolution="", role=None):
    """Clear a card's manual block, with an optional resolution (#1149).

    Same role and ownership gate as ``block_card``. Closes the open
    ``CardBlock`` row (``unblocked_at``/``unblocked_by``/``resolution``),
    clears the denormalized card fields, writes an ``unblocked``
    ``CardActivity`` (from_value: the block's reason, to_value: the
    resolution), bumps the version and broadcasts ``card.updated``.

    A card with no open block raises ``CardNotBlocked`` (409). Relation blocks
    (#449) are not touched: they are a different signal and clear on their own.
    """
    role = _resolve_role(actor, board, role)
    _require_mutation_role(role)
    card = _fetch_for_block(card_id, board)
    _require_own_content(
        board, role, actor, card, denial="You can only unblock cards you created.",
    )

    board_id = card.board_id
    with transaction.atomic():
        locked = lock_card_for_write(card.pk)
        _adopt_locked_state(card, locked)
        if card.archived_at is not None:
            raise CardNotFound()
        if card.blocked_at is None:
            raise CardNotBlocked()
        now = timezone.now()
        reason = card.blocked_reason
        # Closes the open row only; closed blocks are never rewritten. Both
        # writes of a block share one transaction, so the open row exists
        # whenever blocked_at is set, but the card fields are cleared either
        # way so a card can never be left stuck in the blocked state.
        CardBlock.objects.filter(card=card, unblocked_at__isnull=True).update(
            unblocked_at=now, unblocked_by=actor, resolution=resolution,
        )
        card.blocked_at = None
        card.blocked_reason = ""
        card.save(update_fields=["blocked_at", "blocked_reason", "updated_at"])
        _bump_version(card)
        CardActivity.objects.create(
            card=card, event_type=CardActivity.EventType.UNBLOCKED,
            from_value=reason, to_value=resolution, actor=actor,
        )
        payload = render(card)
        _broadcast_after_commit(board_id, _broadcast.EVT_CARD_UPDATED, payload, actor.id)
        _fire_hooks("card.updated", card.id, board_id, actor.id)
    return CardMutationResult(card=card, payload=payload)


# ---------------------------------------------------------------------------
# delete
# ---------------------------------------------------------------------------

def delete_card(*, actor, board, card, role=None, render=None, render_many=None):
    """Hard-delete a card.

    Takes the ``Card`` rather than an id because the REST adapter already holds
    the instance. The row is still locked (``FOR UPDATE``) inside the
    transaction before the cascade is collected — see the comment there and
    ``lock_card_for_write`` (#1587).

    Archived cards are rejected, matching the REST behavior (the endpoint's
    queryset excludes them, so it 404s today). A purge path for archived cards
    would need its own entry point rather than relaxing this.
    """
    role = _resolve_role(actor, board, role)
    _require_mutation_role(role)
    if card.archived_at is not None:
        raise CardNotFound()
    _require_own_content(
        board, role, actor, card, denial="You can only delete cards you created.",
    )

    board_id = card.board_id
    card_uid = card.uid
    card_id = card.pk
    with transaction.atomic():
        # Lock the card row before collecting its cascade (#1587). A child
        # writer holding lock_card_for_write() commits first, so the cascade
        # below sees its new rows and removes them; without the lock the
        # collector could DELETE the children, the child insert commit, and
        # this transaction then fail its own deferred FK check at COMMIT.
        # A card already deleted by a concurrent request answers 404.
        locked = lock_card_row(card_id)
        # Re-checked under the lock: a concurrent archive that committed after
        # the caller's read must still get the "archived cards are rejected"
        # answer above, not a hard delete of the archived card.
        if locked is None or locked.archived_at is not None:
            raise CardNotFound()
        # Read before the delete: the relation rows CASCADE away with the card, so
        # after it there is nothing left to tell us whose blocker_count moved (#449).
        # Read under the lock so a relation committed while we waited counts.
        peer_ids = _blocked_peer_ids(card)
        card.delete()
        _broadcast_after_commit(board_id, _broadcast.EVT_CARD_DELETED, {"card_uid": card_uid}, actor.id)
        _broadcast_blocked_peers(board_id, peer_ids, actor, render, render_many)
        # The id is still passed even though the row is gone, so a handler can
        # tell "deleted" apart from "never existed".
        _fire_hooks("card.deleted", card_id, board_id, actor.id)
    return CardMutationResult(card=card)
