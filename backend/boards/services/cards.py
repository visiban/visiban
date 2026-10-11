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
   coerces it, because *when* the "version must be an integer" 400 is raised is
   part of the frozen contract — it must come after the role allow-list, the
   card lookup and the assignment gate, so a caller who fails one of those sees
   that answer instead.

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
   stays serializer-agnostic; the adapter decides what a payload looks like.

Errors are the typed classes in :mod:`boards.services.errors`, each carrying the
exact HTTP status and body the endpoint returned before the extraction.
"""

import logging
from dataclasses import dataclass

from django.db import transaction
from django.db.models import F, Max, Q, Sum, prefetch_related_objects
from django.utils import timezone

from .. import broadcast as _broadcast
from .. import hooks
from ..models import (
    BoardMembership, Card, CardActivity, CardMovement, CardRelation, Column,
    Notification, Swimlane,
)
from ..permissions import SITE_ADMIN, can_modify_others_content, get_board_role
from ..serializers import _card_labels
from ..utils import notify_new_mentions
from .notifications import create_notifications
from .errors import (
    CardCreationNotAllowed, CardNotFound, ColumnNotFound, ForceNotPermitted,
    InvalidPosition, InvalidVersion, MoveNotPermitted, NotPermitted, SwimlaneNotFound,
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


def _board_scoped(model, pk, board, error):
    """Fetch a row by pk, requiring it to belong to *board*.

    A row on another board raises the same not-found error as a row that does
    not exist, so the API never confirms that an id the caller guessed exists
    somewhere they cannot see (IDOR).
    """
    try:
        return model.objects.get(pk=pk, board=board)
    except model.DoesNotExist:
        raise error() from None


# ---------------------------------------------------------------------------
# Column limits (WIP + weight)
# ---------------------------------------------------------------------------

def enforce_column_limits(
    *, board, column, card, role, force=False, check_wip=True, check_weight=True,
    lock=True,
):
    """Raise if placing ``card`` in ``column`` breaks its WIP or weight limit.

    The one implementation of WIP, hard-WIP and weight enforcement, shared by
    every API write path that puts a card into a column or grows one inside it:
    move, create, restore from archive, a weight increase via update, and the
    Django admin (#1428). Before #1428 only ``move_card`` ran it, so a member
    could exceed even a hard limit by creating or restoring a card.

    ``card`` is the card being placed. It is excluded from the counts — it is
    either somewhere else (move), not yet active (restore), or already saved by
    the caller inside its own transaction (create, weight change) — and its
    ``weight`` is what is added to the column's total.

    ``check_wip`` / ``check_weight`` exist for the weight-change path, which
    does not change how many cards the column holds and so must not be refused
    for a column that is already over its *WIP* limit.

    Locking: when any enforced limit applies, the column row is locked with
    ``select_for_update(no_key=True)`` before counting, so two concurrent
    writers into the same column queue instead of both observing room for one
    more card. Call this inside the caller's transaction, after any card-row
    lock, to keep the card → column lock order ``move_card`` documents.

    ``FOR NO KEY UPDATE`` rather than ``FOR UPDATE`` (#1522): every insert or
    update of a row with a foreign key to the column — a ``CardMovement`` naming
    it as ``from_column``, a card saved into it — takes ``FOR KEY SHARE`` on the
    column row, which ``FOR UPDATE`` blocks and ``FOR NO KEY UPDATE`` does not.
    With ``FOR UPDATE``, a move A -> B racing a move B -> A in another swimlane
    deadlocks: each holds its target column and its audit row needs the other's.
    Two ``FOR NO KEY UPDATE`` locks still conflict, so limit checks still queue.

    Override rules (identical on every path): hard WIP mode is evaluated before
    ``force`` is consulted, so no role can override it; a soft WIP or weight
    limit can be overridden with ``force=True`` only by a board admin or site
    admin (``ForceNotPermitted`` otherwise). Weight has no hard mode.

    ``lock=False`` is only for a caller that already holds the column row lock
    in the same transaction (``create_card`` takes it for position assignment).
    """
    wip_enforced = check_wip and (board.enforce_wip_limits or board.enforce_wip_hard)
    weight_enforced = check_weight and board.enforce_weight_limits
    wip_applies = wip_enforced and column.wip_limit is not None
    weight_applies = weight_enforced and column.weight_limit is not None
    if not (wip_applies or weight_applies):
        return

    # One lock covers WIP and weight; acquiring it twice on the same row would
    # be a redundant round-trip.
    if lock:
        Column.objects.select_for_update(no_key=True).get(pk=column.pk)

    # Hard mode is independent of soft mode: it activates even when soft
    # enforcement is off, and accepts no override from any role. It is
    # therefore checked BEFORE `force` is consulted, so the override path is
    # unreachable while hard mode is on.
    if wip_applies:
        wip_count = (
            Card.objects.filter(board=board, column=column, archived_at__isnull=True)
            .exclude(pk=card.pk)
            .count()
        )
        if wip_count >= column.wip_limit:
            if board.enforce_wip_hard:
                raise WipHardBlocked(
                    column_name=column.name,
                    current_count=wip_count,
                    wip_limit=column.wip_limit,
                )
            if not force:
                raise WipLimitExceeded(
                    column_name=column.name,
                    current_count=wip_count,
                    wip_limit=column.wip_limit,
                )
            _require_force_role(role, "wip")

    if weight_applies:
        current_weight = (
            Card.objects.filter(board=board, column=column, archived_at__isnull=True)
            .exclude(pk=card.pk)
            .aggregate(total=Sum("weight"))["total"]
        ) or 0
        if current_weight + card.weight > column.weight_limit:
            if not force:
                raise WeightLimitExceeded(
                    column_name=column.name,
                    current_weight=current_weight,
                    weight_limit=column.weight_limit,
                    card_weight=card.weight,
                )
            _require_force_role(role, "weight")


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
        # Lock the target column row before reading the cell's card count so two
        # concurrent creates in the same (column, swimlane) cell cannot both
        # observe the same max position and assign a duplicate. Same column-row
        # lock the move transition takes for its WIP check (#1050).
        Column.objects.select_for_update(no_key=True).get(pk=column.pk)
        max_pos = Card.objects.filter(board=board, column=column, swimlane=swimlane).count()
        card = save(position=max_pos)
        # The column row is already locked above, so the helper does not lock
        # it again. The new card is excluded from the count, as in a move.
        enforce_column_limits(
            board=board, column=column, card=card, role=role, force=force, lock=False,
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


# ---------------------------------------------------------------------------
# update
# ---------------------------------------------------------------------------

def update_card(*, actor, board, card, submitted, apply, render, role=None, force=False):
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

    board_id = card.board_id
    with transaction.atomic():
        # Card row first (#1587): without it a delete committing between the
        # caller's read and apply() makes serializer.save()'s UPDATE match no
        # row, and Django falls back to an INSERT that re-creates the card.
        # Taken before enforce_column_limits below locks the column, keeping
        # the card -> column order move_card uses.
        lock_card_for_write(card.pk)
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
            enforce_column_limits(
                board=board, column=card.column, card=card, role=role, force=force,
                check_wip=False,
            )
        # OCC: bump version on every mutation so stale clients detect conflicts.
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
                        verb=f"You were assigned to \"{card.title}\"",
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
    one cell, whose single column is locked. No card row is locked after a
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
    Returns ``(card, locked_pks)``: the locked moved card, or ``None`` when it
    no longer exists on the board (deleted by a concurrent request: a genuine
    404), and the pks of every row this statement locked, for
    ``_require_cells_locked``.

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
    return card, frozenset(row.pk for row in locked)


def _move_cells_filter(card_id, cells):
    """The moved card plus every card in ``cells``, as one ``Q``."""
    cell_filter = Q(pk=card_id)
    for column_id, swimlane_id in cells:
        cell_filter |= Q(column_id=column_id, swimlane_id=swimlane_id)
    return cell_filter


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
    """
    list(
        Column.objects.filter(pk__in=sorted(column_ids))
        .order_by("pk")
        .select_for_update(no_key=True)
    )


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
    """
    if card_id is not None:
        lock_card_row(card_id)
    _lock_move_columns({pk for pk in column_ids if pk is not None})


def lock_card_row(card_id):
    """Lock one card row ``FOR UPDATE`` and return its placement fields.

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
        .only("pk", "column_id", "swimlane_id", "archived_at", "weight")
        .first()
    )


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

    Lock order: this is the card row, so it must be taken before any column
    row the same transaction locks (card -> column, as ``move_card`` and
    ``lock_card_cell_entry`` do). Must be called inside ``transaction.atomic()``.
    On SQLite the lock clause is a no-op and only the existence check remains.
    """
    found = (
        Card.objects.filter(pk=card_id)
        .select_for_update(no_key=True)
        .values_list("pk", flat=True)
        .first()
    )
    if found is None:
        raise CardNotFound()


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
        locked, locked_pks = _lock_move_cells(board=board, card_id=card.pk, cells=cells)
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
        _lock_move_columns({card.column_id, target_column.pk})
        _require_cells_locked(
            board=board, card_id=card.pk, cells=cells, locked_pks=locked_pks,
            current_version=locked.version,
        )

        # WIP and weight enforcement — only when the card enters a different
        # column. Pure position reorders within the same cell, and swimlane-only
        # moves within one column, are exempt. The target column row is already
        # locked above, so the helper does not lock it again.
        if column_changed:
            enforce_column_limits(
                board=board, column=target_column, card=card, role=role, force=force,
                lock=False,
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
        position = max(0, min(position, -1 if highest is None else highest + 1))

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

        payload = render(card, movement)
        # The WebSocket payload is the same dict as the REST body so a client can
        # update its movement history without re-polling /movements/.
        _broadcast_after_commit(board_id, _broadcast.EVT_CARD_MOVED, dict(payload), actor.id)
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
        peer_ids = _blocked_peer_ids(card)
        with transaction.atomic():
            # Card row first (#1587): a delete committing after
            # _fetch_for_archive would otherwise make the update_fields save
            # below match no row and raise "did not affect any rows" (a 500).
            lock_card_for_write(card.pk)
            card.archived_at = timezone.now()
            card.save(update_fields=["archived_at"])
            _archive_movement(card, actor, CardMovement.MovementType.ARCHIVED)
            _broadcast_after_commit(board_id, _broadcast.EVT_CARD_ARCHIVED, {"card_uid": card_uid}, actor.id)
            # Archiving a blocker drops its targets' blocker_count (#449).
            # Rendered after the save so each peer payload reflects the new
            # state, and inside the transaction so it rolls back with it.
            _broadcast_blocked_peers(board_id, peer_ids, actor, render, render_many)
            _fire_hooks("card.archived", card.id, board_id, actor.id)
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
    peer_ids = _blocked_peer_ids(card)
    with transaction.atomic():
        # Card row first (#1587) — same delete race as archive_card — and
        # before enforce_column_limits locks the column, keeping the
        # card -> column order move_card uses.
        lock_card_for_write(card.pk)
        card.archived_at = None
        card.save(update_fields=["archived_at"])
        # Checked after the write, with the card row already locked above, so
        # the column row comes second (move_card's lock order); a refusal
        # rolls the restore back.
        enforce_column_limits(
            board=board, column=card.column, card=card, role=role, force=force,
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
