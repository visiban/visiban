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
from django.db.models import F, Sum, prefetch_related_objects
from django.utils import timezone

from .. import broadcast as _broadcast
from .. import hooks
from ..models import (
    BoardMembership, Card, CardActivity, CardMovement, CardRelation, Column,
    Notification, Swimlane,
)
from ..permissions import SITE_ADMIN, can_modify_others_content, get_board_role
from ..utils import notify_new_mentions
from .notifications import create_notifications
from .errors import (
    CardCreationNotAllowed, CardNotFound, ColumnNotFound, ForceNotPermitted,
    InvalidVersion, MoveNotPermitted, NotPermitted, SwimlaneNotFound,
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
        transaction.on_commit(
            lambda: [h(event, card_id, board_id, actor_id) for h in hooks.CARD_MUTATION_HOOKS]
        )


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
# create
# ---------------------------------------------------------------------------

def create_card(*, actor, board, column_id, swimlane_id, save, render, role=None):
    """Create a card at the end of its target cell.

    ``save(position=...)`` performs the validated write and returns the new
    ``Card`` — the HTTP adapter passes a closure over ``serializer.save``.
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
        Column.objects.select_for_update().get(pk=column.pk)
        max_pos = Card.objects.filter(board=board, column=column, swimlane=swimlane).count()
        card = save(position=max_pos)
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
            # Bound to locals so the closure cannot observe a later rebind.
            _card, _actor, _desc = card, actor, card.description
            transaction.on_commit(lambda: notify_new_mentions(_card, _actor, "", _desc))
    return CardMutationResult(card=card, payload=payload)


# ---------------------------------------------------------------------------
# update
# ---------------------------------------------------------------------------

def update_card(*, actor, board, card, submitted, apply, render, role=None):
    """Apply a field update, recording a ``CardActivity`` row per changed field.

    ``submitted`` is the mapping of field names the caller actually supplied. It
    decides three things that a diff of the saved row cannot: which ownership
    denial message applies, whether an omitted ``title``/``description`` should
    produce an activity row, and whether the caller is trying to change
    ``column``/``swimlane`` (which belongs on the move transition — see
    :class:`~boards.services.errors.UseMoveEndpoint`). Pass an empty mapping,
    never ``None``, when the caller has no notion of a partial body.

    ``apply()`` performs the validated write; the HTTP adapter passes a closure
    over ``serializer.save``.

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

    # Reject a change of `column` or `swimlane` — same-board or cross-board
    # (#1106). Either bypasses WIP/weight enforcement and the CardMovement audit
    # trail, which only the move transition evaluates. Echoing back the card's
    # *current* value is still accepted so a client that round-trips the full
    # representation it was given keeps working (required by the 1.0 backward-
    # compatibility contract). The submitted value is compared as a string
    # rather than resolved, so the API never needs to tell the caller whether a
    # foreign id it guessed happens to exist on another board. `None` is left to
    # field validation rather than treated as a no-op here, since column and
    # swimlane are non-nullable FKs and the current id can therefore never
    # legitimately be None.
    for field_name, current_id in (("column", card.column_id), ("swimlane", card.swimlane_id)):
        if field_name in submitted:
            raw_value = submitted.get(field_name)
            if raw_value is not None and str(raw_value) != str(current_id):
                raise UseMoveEndpoint(field_name, board_pk=board.pk, card_pk=card.pk)

    board_id = card.board_id
    with transaction.atomic():
        # Snapshot before the write so the activity diff can name what changed.
        old_title = card.title
        old_priority = card.priority
        old_weight = card.weight
        old_assignee_id = card.assignee_id
        old_assignee_name = card.assignee.username if card.assignee else "Unassigned"
        old_description = card.description
        old_label_ids = {label.id for label in card.labels.all()}
        old_due_date = card.due_date.isoformat() if card.due_date else ""

        apply()
        # OCC: bump version on every mutation so stale clients detect conflicts.
        Card.objects.filter(pk=card.pk).update(version=F("version") + 1)
        # Only reload version — scoping fields= prevents clearing the labels
        # prefetch cache, which would make card.labels.all() below re-query.
        card.refresh_from_db(fields=["version"])
        # Re-prefetch labels since the write may have changed the M2M.
        prefetch_related_objects([card], "labels")

        activities = []
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
            # Notify the new assignee unless they opted out. Routed through
            # create_notifications so email/enterprise delivery fires after the
            # card update commits, not inside this transaction.
            if card.assignee and card.assignee != actor and card.assignee.notif_card_assigned:
                create_notifications([
                    Notification(
                        recipient=card.assignee,
                        actor=actor,
                        action_type=Notification.ActionType.ASSIGNED,
                        verb=f"You were assigned to \"{card.title}\"",
                        card=card,
                        board=card.board,
                    )
                ], context={"previous_assignee_name": old_assignee_name})
        if old_description != card.description and "description" in submitted:
            activities.append(CardActivity(
                card=card, event_type=ET.DESCRIPTION_CHANGE,
                from_value="", to_value="", actor=actor,
            ))
            # Deferred so the updated description is already committed when the
            # mention notifications are created.
            _card, _actor, _old, _new = card, actor, old_description, card.description
            transaction.on_commit(lambda: notify_new_mentions(_card, _actor, _old, _new))
        new_label_ids = {label.id for label in card.labels.all()}
        if old_label_ids != new_label_ids:
            added = new_label_ids - old_label_ids
            removed = old_label_ids - new_label_ids
            parts = []
            # Build the name map from the labels already prefetched above rather
            # than issuing two live queries.
            label_name_by_id = {lbl.id: lbl.name for lbl in card.labels.all()}
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
    return CardMutationResult(card=card, payload=payload)


# ---------------------------------------------------------------------------
# move
# ---------------------------------------------------------------------------

def move_card(
    *, actor, board, card_id, target_column_id, target_swimlane_id, position,
    render, expected_version=None, force=False, role=None,
):
    """Move a card to a column/swimlane/position, writing a ``CardMovement``.

    Takes a ``card_id`` rather than a ``Card`` because the row must be read
    under ``select_for_update()`` *inside* this function's transaction: a card
    the caller fetched beforehand is not locked, and re-locking it would mean a
    second fetch of the same row.

    Lock order, which is the deadlock-avoidance contract and must not change:
    the card row, then the target column row (only when a limit is enforced),
    then the source cell's cards ordered by pk, then the target cell's cards
    ordered by pk. Concurrent moves then queue rather than deadlock.

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

    board_id = board.id
    with transaction.atomic():
        try:
            card = (
                Card.objects.select_for_update()
                .select_related("column", "swimlane")
                .get(pk=card_id, board=board)
            )
        except Card.DoesNotExist:
            raise CardNotFound() from None

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

        target_column = _board_scoped(Column, target_column_id, board, ColumnNotFound)
        target_swimlane = _board_scoped(Swimlane, target_swimlane_id, board, SwimlaneNotFound)

        column_changed = card.column_id != target_column.pk
        swimlane_changed = card.swimlane_id != target_swimlane.pk

        # Lock the target column row once before both limit checks so concurrent
        # moves cannot race past either. One lock covers WIP and weight;
        # acquiring it twice on the same row would be a redundant round-trip.
        wip_enforced = board.enforce_wip_limits or board.enforce_wip_hard
        if column_changed and (
            (wip_enforced and target_column.wip_limit is not None)
            or (board.enforce_weight_limits and target_column.weight_limit is not None)
        ):
            Column.objects.select_for_update().get(pk=target_column.pk)

        # WIP enforcement — only when the card enters a different column (a pure
        # swimlane move within one column counts as entering it too). Pure
        # position reorders within the same cell are exempt.
        #
        # Hard mode is independent of soft mode: it activates even when soft
        # enforcement is off, and accepts no override from any role. It is
        # therefore checked BEFORE `force` is consulted, so the override path is
        # unreachable while hard mode is on.
        if wip_enforced and column_changed and target_column.wip_limit is not None:
            wip_count = (
                Card.objects.filter(board=board, column=target_column, archived_at__isnull=True)
                .exclude(pk=card.pk)
                .count()
            )
            if wip_count >= target_column.wip_limit:
                if board.enforce_wip_hard:
                    raise WipHardBlocked(
                        column_name=target_column.name,
                        current_count=wip_count,
                        wip_limit=target_column.wip_limit,
                    )
                if not force:
                    raise WipLimitExceeded(
                        column_name=target_column.name,
                        current_count=wip_count,
                        wip_limit=target_column.wip_limit,
                    )
                _require_force_role(role, "wip")

        # Weight enforcement — same pattern as WIP, skipped for pure reorders.
        # The target column row is already locked above.
        if board.enforce_weight_limits and column_changed and target_column.weight_limit is not None:
            current_weight = (
                Card.objects.filter(board=board, column=target_column, archived_at__isnull=True)
                .exclude(pk=card.pk)
                .aggregate(total=Sum("weight"))["total"]
            ) or 0
            if current_weight + card.weight > target_column.weight_limit:
                if not force:
                    raise WeightLimitExceeded(
                        column_name=target_column.name,
                        current_weight=current_weight,
                        weight_limit=target_column.weight_limit,
                        card_weight=card.weight,
                    )
                _require_force_role(role, "weight")

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

            # Lock the source cell's cards, then compact the gap the moved card
            # leaves behind. A single bulk UPDATE (decrement every position after
            # the moved card) rather than a per-row save() loop, so a large
            # source cell does not cost O(N) queries. This endpoint keeps
            # positions compact, so -1 is equivalent to a full renumber.
            list(Card.objects.filter(
                board=board, column=card.column, swimlane=card.swimlane
            ).exclude(pk=card.pk).order_by("pk").select_for_update())
            Card.objects.filter(
                board=board, column=card.column, swimlane=card.swimlane,
                archived_at__isnull=True,
            ).exclude(pk=card.pk).filter(position__gt=card.position).update(
                position=F("position") - 1
            )

        # Lock the target cell's cards, then shift to make room.
        list(Card.objects.filter(
            board=board, column=target_column, swimlane=target_swimlane
        ).exclude(pk=card.pk).order_by("pk").select_for_update())
        Card.objects.filter(
            board=board, column=target_column, swimlane=target_swimlane
        ).exclude(pk=card.pk).filter(position__gte=position).update(
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
        from_column_name=card.column.name if card.column else "",
        from_column_uid=card.column.uid if card.column else "",
        to_column=card.column,
        to_column_name=card.column.name if card.column else "",
        to_column_uid=card.column.uid if card.column else "",
        from_swimlane=card.swimlane,
        from_swimlane_name=card.swimlane.name if card.swimlane else "",
        from_swimlane_uid=card.swimlane.uid if card.swimlane else "",
        to_swimlane=card.swimlane,
        to_swimlane_name=card.swimlane.name if card.swimlane else "",
        to_swimlane_uid=card.swimlane.uid if card.swimlane else "",
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


def unarchive_card(*, actor, board, card_id, render, role=None, render_many=None):
    """Restore a card by clearing ``archived_at``.

    The card re-enters its original column/swimlane position. Restoring a card
    that is not archived is a no-op that still returns it, and broadcasts
    nothing.

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
        card.archived_at = None
        card.save(update_fields=["archived_at"])
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

    Takes the ``Card`` rather than an id because no row lock is needed and the
    REST adapter already holds the instance.

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
    # Read before the delete: the relation rows CASCADE away with the card, so
    # after it there is nothing left to tell us whose blocker_count moved (#449).
    peer_ids = _blocked_peer_ids(card)
    with transaction.atomic():
        card.delete()
        _broadcast_after_commit(board_id, _broadcast.EVT_CARD_DELETED, {"card_uid": card_uid}, actor.id)
        _broadcast_blocked_peers(board_id, peer_ids, actor, render, render_many)
        # The id is still passed even though the row is gone, so a handler can
        # tell "deleted" apart from "never existed".
        _fire_hooks("card.deleted", card_id, board_id, actor.id)
    return CardMutationResult(card=card)
