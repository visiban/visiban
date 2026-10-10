from types import SimpleNamespace

from django import forms
from django.contrib import admin
from django.core.exceptions import ValidationError
from django.db import transaction

from groups.broadcast import broadcast_group_event as _broadcast_group_event

from . import broadcast as _broadcast
from .models import (
    Board, BoardMembership, Column, Swimlane, Label, Card, CardMovement,
    CardComment, CardActivity, CardAttachment, CardChecklist, Notification,
)
from .serializers import (
    BoardMembershipSerializer, BoardSerializer, ColumnSerializer, LabelSerializer,
    SwimlaneSerializer,
)
from .permissions import SITE_ADMIN
from .services.cards import enforce_column_limits, lock_card_cell_entry
from .services.errors import WeightLimitExceeded, WipHardBlocked, WipLimitExceeded
from .views._helpers import _refetched_card_data


def _record_board_and_group_event(board_id, group_id, event_type, payload, *, actor_id):
    """Persist one board event and broadcast it to the board channel and,
    when the board belongs to a group, the group channel too — deferred
    until commit, same as record_board_event().

    Board is the only admin-registered model that needs this: BoardViewSet's
    perform_create/perform_update/destroy (boards/views/boards.py) already
    dual-broadcast board.created/updated/deleted to both channels in one
    on_commit callback, because GroupDetail.tsx's dashboard/boards-list view
    listens for those events exclusively on the group socket, not the board
    socket. This is BoardAdmin's counterpart to that — see BoardAdmin's
    docstring for why it doesn't just use _BoardEventAdminMixin.
    """
    event_id = _broadcast.persist_board_event(board_id, event_type, payload, actor_id=actor_id)

    def _send(bid=board_id, evt=event_type, pl=payload, gid=group_id, eid=event_id):
        _broadcast.broadcast_board_event(bid, evt, pl, event_id=eid)
        if gid is not None:
            _broadcast_group_event(gid, evt, pl)

    transaction.on_commit(_send)


def _limit_error_message(exc):
    """A sentence for the admin form from a card-service limit error."""
    if isinstance(exc, WipHardBlocked):
        return (
            f'Column "{exc.column_name}" is at its WIP limit ({exc.current_count}/'
            f"{exc.wip_limit}) and the board enforces hard WIP limits, so no role "
            "can add a card to it. Move a card out or raise the limit first."
        )
    if isinstance(exc, WipLimitExceeded):
        return (
            f'Column "{exc.column_name}" is at its WIP limit ({exc.current_count}/'
            f"{exc.wip_limit}). Raise the limit, or override it as a board admin "
            "through the API with ?force=true."
        )
    return (
        f'Column "{exc.column_name}" would exceed its weight limit '
        f"({exc.current_weight} + {exc.card_weight} > {exc.weight_limit}). Raise the "
        "limit, or override it as a board admin through the API with ?force=true."
    )


class CardAdminForm(forms.ModelForm):
    """Applies the card service's placement rules to Django admin saves (#1428).

    ``CardAdmin.save_model`` writes the row directly, so without this form a
    staff user could create a card in a column with ``allow_card_creation``
    off, or put a card into (or grow one inside) a column past its WIP or
    weight limit — including under hard WIP mode, which the API documents as
    "blocked for all roles". The rules are the service's own
    (:func:`boards.services.cards.enforce_column_limits`), evaluated in
    ``clean()`` so a refusal is an ordinary form error rather than a 500.

    There is no override here: the admin form has no ``force`` control, so a
    soft limit is refused too. A site admin who needs to exceed a soft limit
    uses the API's ``?force=true`` or raises the column's limit. This is
    stricter than the API for site admins on purpose — the admin is a repair
    tool, not the place to bypass board policy silently.

    ``changeform_view`` runs validation inside ``transaction.atomic()``, so the
    column row lock the helper takes is held until the save commits.

    Cell entry (#1588): any change of column or swimlane — archived cards
    included, and creation — locks the card row and then its source and target
    column rows (``lock_card_cell_entry``) before the limit check, so this edit
    queues behind a concurrent ``move_card`` that holds those columns rather
    than committing into its cell behind its membership re-check.
    ``CardAdmin.save_model`` takes the same locks again in the saving
    transaction, so the guarantee does not depend on how the form is driven.
    """

    class Meta:
        model = Card
        fields = "__all__"

    def clean(self):
        cleaned = super().clean()
        if self.errors:
            return cleaned
        column = cleaned.get("column")
        board = cleaned.get("board")
        if column is None or board is None:
            return cleaned
        # The helper counts cards with board=board, so a column from another
        # board would count zero and silently pass every limit. A card in a
        # column of a different board is never valid anyway.
        if column.board_id != board.pk:
            raise ValidationError({"column": "Column belongs to a different board."})
        # Not yet mutated: ModelForm copies cleaned_data onto the instance only
        # after clean() returns, so self.instance still holds the saved values.
        original = self.instance
        creating = original.pk is None
        if creating and not column.allow_card_creation:
            raise ValidationError({"column": "Card creation is not allowed in this column."})

        swimlane = cleaned.get("swimlane")
        swimlane_id = swimlane.pk if swimlane is not None else original.swimlane_id
        # Why lock here and not only in save_model: the limit check below must
        # count under the column lock, and the lock must come after the card
        # row lock (move_card's card -> column order). This is deliberately
        # evaluated before the archived early return: an archived card is
        # still a member of its cell, so moving one changes a cell's members
        # just like moving an active card does (#1588).
        cell_entry = (
            creating
            or original.column_id != column.pk
            or original.swimlane_id != swimlane_id
        )
        if cell_entry:
            lock_card_cell_entry(
                card_id=original.pk,
                column_ids={original.column_id, column.pk} - {None},
            )

        archived_at = cleaned.get("archived_at", original.archived_at)
        if archived_at is not None:
            # An archived card does not count toward a column's limits.
            return cleaned
        weight = cleaned.get("weight", original.weight)
        entering = (
            creating
            or original.archived_at is not None  # restore
            or original.column_id != column.pk  # move
        )
        weight_up = not entering and weight > original.weight
        if not (entering or weight_up):
            return cleaned
        try:
            enforce_column_limits(
                board=board, column=column,
                card=SimpleNamespace(pk=original.pk, weight=weight),
                role=SITE_ADMIN, force=False,
                # A weight change inside the same column does not change its
                # card count, so it is checked against the weight limit only —
                # same rule as the PATCH path.
                check_wip=entering,
                # Already locked above, after the card row, when the cell
                # changed; a restore or weight change in place locks here.
                lock=not cell_entry,
            )
        except (WipHardBlocked, WipLimitExceeded, WeightLimitExceeded) as exc:
            raise ValidationError(_limit_error_message(exc)) from None
        return cleaned


@admin.register(Card)
class CardAdmin(admin.ModelAdmin):
    """Admin for Card that broadcasts mutations to connected WebSocket clients.

    Mutations made through the admin site bypass the REST viewset and its
    perform_create/perform_update/perform_destroy hooks. Without this override
    any client viewing the affected board would not see admin edits until a
    full reload. Broadcast is deferred via transaction.on_commit() so clients
    only see events after the DB write is durably committed.

    WIP, weight and ``allow_card_creation`` are enforced by ``CardAdminForm``
    (#1428); the version bump, ``CardMovement`` audit row and hooks are still
    skipped (see ``docs/architecture/service-layer.md``).
    """

    form = CardAdminForm

    def save_model(self, request, obj, form, change):
        with transaction.atomic():
            self._lock_cell_entry(obj, change)
            super().save_model(request, obj, form, change)
        board = obj.board
        event = _broadcast.EVT_CARD_UPDATED if change else _broadcast.EVT_CARD_CREATED
        card_data = _refetched_card_data(obj, request, board)
        board_id = board.id
        _broadcast.record_board_event(board_id, event, card_data, actor_id=request.user.pk)

    @staticmethod
    def _lock_cell_entry(obj, change):
        """Hold the card's column lock(s) in the transaction that saves it (#1588).

        ``CardAdminForm.clean`` already takes these locks, and in the admin
        it runs inside the same ``changeform_view`` transaction. Taking them
        again here (a no-op for rows this transaction already holds) makes
        the save itself the guarantee: whatever drove the form, the card
        cannot be committed into a new cell without holding that cell's
        column row until commit, which ``move_card``'s membership re-check
        (#1567) relies on. The stored row is read under the card lock, so
        "did the cell change" is decided on committed state.
        """
        if not change:
            lock_card_cell_entry(card_id=None, column_ids={obj.column_id})
            return
        stored = (
            Card.objects.filter(pk=obj.pk)
            .select_for_update(of=("self",))
            .values_list("column_id", "swimlane_id")
            .first()
        )
        if stored is not None and stored != (obj.column_id, obj.swimlane_id):
            lock_card_cell_entry(card_id=obj.pk, column_ids={stored[0], obj.column_id})

    def delete_model(self, request, obj):
        board_id = obj.board_id
        card_uid = obj.uid
        super().delete_model(request, obj)
        _broadcast.record_board_event(
            board_id, _broadcast.EVT_CARD_DELETED, {"card_uid": card_uid}, actor_id=request.user.pk
        )

    def delete_queryset(self, request, queryset):
        # Capture board_id + uid before delete — post-delete the instances are gone.
        deleted = [(c.board_id, c.uid) for c in queryset]
        super().delete_queryset(request, queryset)
        for board_id, card_uid in deleted:
            _broadcast.record_board_event(
                board_id, _broadcast.EVT_CARD_DELETED, {"card_uid": card_uid}, actor_id=request.user.pk
            )


@admin.register(Column)
class ColumnAdmin(admin.ModelAdmin):
    """Admin for Column that broadcasts mutations (see CardAdmin for rationale)."""

    def save_model(self, request, obj, form, change):
        super().save_model(request, obj, form, change)
        event = _broadcast.EVT_COLUMN_UPDATED if change else _broadcast.EVT_COLUMN_CREATED
        column_data = ColumnSerializer(obj).data
        board_id = obj.board_id
        _broadcast.record_board_event(board_id, event, column_data, actor_id=request.user.pk)

    def delete_model(self, request, obj):
        board_id = obj.board_id
        column_uid = obj.uid
        super().delete_model(request, obj)
        _broadcast.record_board_event(
            board_id, _broadcast.EVT_COLUMN_DELETED, {"column_uid": column_uid}, actor_id=request.user.pk
        )

    def delete_queryset(self, request, queryset):
        deleted = [(c.board_id, c.uid) for c in queryset]
        super().delete_queryset(request, queryset)
        for board_id, column_uid in deleted:
            _broadcast.record_board_event(
                board_id, _broadcast.EVT_COLUMN_DELETED, {"column_uid": column_uid}, actor_id=request.user.pk
            )


class _BoardEventAdminMixin:
    """Shared save/delete broadcast wiring for board-scoped admin models.

    Mutations made through the admin site bypass the REST viewset and its
    perform_create/perform_update/perform_destroy hooks (see CardAdmin above
    for the full rationale). CardAdmin and ColumnAdmin each hand-roll the same
    persist-then-broadcast shape; this mixin factors it out for the other
    board-scoped models the 1.2 pre-release broadcast-check audit flagged as
    silently bypassing it (#1241) — Swimlane, Label, BoardMembership. Each
    concrete admin class below only declares its event names and how to
    build a payload.

    Board is deliberately NOT one of these — its REST viewset dual-broadcasts
    to both the board channel and the board's group channel (a second
    audience the other three models don't have), so BoardAdmin implements its
    own save_model/delete_model/delete_queryset via
    _record_board_and_group_event() above instead of this single-channel
    mixin. Do not fold Board back into this mixin without also adding a
    group-channel branch generically — Swimlane/Label/BoardMembership's own
    REST viewsets never call broadcast_group_event, so a generic group
    broadcast here would be wrong for them.

    Subclasses set ``event_created``/``event_updated``/``event_deleted`` and
    implement ``_board_id``, ``_payload`` (used for both create and update),
    and ``_delete_payload``. ``_delete_payload`` is always called *before* the
    row is actually deleted — ``instance.delete()`` clears the instance's pk,
    the same reason CardAdmin/ColumnAdmin capture their uid up front rather
    than after ``super().delete_model()``.
    """

    event_created = None
    event_updated = None
    event_deleted = None

    def _board_id(self, obj):
        raise NotImplementedError

    def _payload(self, obj, request):
        raise NotImplementedError

    def _delete_payload(self, obj):
        raise NotImplementedError

    def _emit(self, board_id, event, payload, request):
        # `event` arrives as a plain parameter rather than a literal EVT_*
        # expression — the concrete constant lives on the subclass
        # (event_created/event_updated/event_deleted), and the
        # ws-event-reachability gate can only trace a registry constant
        # written directly in the calling function's own body, not through
        # an instance-attribute lookup. This one-line forwarder gets the same
        # pass-through treatment the gate already gives
        # _record_board_and_group_event() above; the events themselves are
        # independently declared/emitted/documented via each model's REST
        # viewset.
        _broadcast.record_board_event(board_id, event, payload, actor_id=request.user.pk)

    def save_model(self, request, obj, form, change):
        super().save_model(request, obj, form, change)
        event = self.event_updated if change else self.event_created
        self._emit(self._board_id(obj), event, self._payload(obj, request), request)

    def delete_model(self, request, obj):
        board_id = self._board_id(obj)
        payload = self._delete_payload(obj)
        super().delete_model(request, obj)
        self._emit(board_id, self.event_deleted, payload, request)

    def delete_queryset(self, request, queryset):
        # Capture identifiers before delete — post-delete each instance's pk is cleared.
        deleted = [(self._board_id(o), self._delete_payload(o)) for o in queryset]
        super().delete_queryset(request, queryset)
        for board_id, payload in deleted:
            self._emit(board_id, self.event_deleted, payload, request)


@admin.register(Swimlane)
class SwimlaneAdmin(_BoardEventAdminMixin, admin.ModelAdmin):
    """Admin for Swimlane that broadcasts mutations (see CardAdmin for rationale)."""

    event_created = _broadcast.EVT_SWIMLANE_CREATED
    event_updated = _broadcast.EVT_SWIMLANE_UPDATED
    event_deleted = _broadcast.EVT_SWIMLANE_DELETED

    def _board_id(self, obj):
        return obj.board_id

    def _payload(self, obj, request):
        # SwimlaneSerializer, never SwimlaneAdminSerializer: every swimlane
        # broadcast must go through the public serializer so contact_email
        # and notes (admin-only PII) never reach viewer-role WebSocket
        # subscribers — the same rule SwimlaneViewSet follows (see
        # SwimlaneSerializer's docstring in serializers.py).
        return SwimlaneSerializer(obj).data

    def _delete_payload(self, obj):
        return {"swimlane_uid": obj.uid}


@admin.register(Label)
class LabelAdmin(_BoardEventAdminMixin, admin.ModelAdmin):
    """Admin for Label that broadcasts mutations (see CardAdmin for rationale)."""

    event_created = _broadcast.EVT_LABEL_CREATED
    event_updated = _broadcast.EVT_LABEL_UPDATED
    event_deleted = _broadcast.EVT_LABEL_DELETED

    def _board_id(self, obj):
        return obj.board_id

    def _payload(self, obj, request):
        return LabelSerializer(obj).data

    def _delete_payload(self, obj):
        return {"label_uid": obj.uid}


@admin.register(Board)
class BoardAdmin(admin.ModelAdmin):
    """Admin for Board that broadcasts mutations to both the board channel and
    the board's group channel.

    Board is the one board-scoped model in this file with a second broadcast
    audience: GroupDetail.tsx's dashboard/boards-list view listens for
    board.created/board.updated/board.deleted exclusively on the group socket
    (useGroupSocket), not the board socket — mirroring
    BoardViewSet.perform_create/perform_update/destroy's dual on_commit
    broadcast in boards/views/boards.py. A board created, renamed, or deleted
    via /admin/ must still reach that view without a manual reload, so this
    class does not use _BoardEventAdminMixin's single-channel pattern —
    Swimlane/Label/BoardMembership have no group-channel counterpart (their
    REST viewsets never call broadcast_group_event either) and stay on that
    mixin below.
    """

    def save_model(self, request, obj, form, change):
        super().save_model(request, obj, form, change)
        event = _broadcast.EVT_BOARD_UPDATED if change else _broadcast.EVT_BOARD_CREATED
        # No request in context: BoardSerializer.get_group_detail() reads
        # request.query_params (a DRF Request attribute) to resolve
        # ?expand=group, which the plain Django admin HttpRequest does not
        # have — passing it through would raise AttributeError. Omitting
        # context falls back to is_starred=False / group_detail=None, both
        # of which are documented fallbacks on a bare instance, not a crash.
        board_data = BoardSerializer(obj).data
        _record_board_and_group_event(
            obj.id, obj.group_id, event, board_data, actor_id=request.user.pk
        )

    def delete_model(self, request, obj):
        board_id = obj.id
        board_uid = obj.uid
        group_id = obj.group_id
        super().delete_model(request, obj)
        _record_board_and_group_event(
            board_id, group_id, _broadcast.EVT_BOARD_DELETED, {"board_uid": board_uid},
            actor_id=request.user.pk,
        )

    def delete_queryset(self, request, queryset):
        # Capture identifiers before delete — post-delete each instance's pk is cleared.
        deleted = [(b.id, b.uid, b.group_id) for b in queryset]
        super().delete_queryset(request, queryset)
        for board_id, board_uid, group_id in deleted:
            _record_board_and_group_event(
                board_id, group_id, _broadcast.EVT_BOARD_DELETED, {"board_uid": board_uid},
                actor_id=request.user.pk,
            )


@admin.register(BoardMembership)
class BoardMembershipAdmin(_BoardEventAdminMixin, admin.ModelAdmin):
    """Admin for BoardMembership that broadcasts mutations (see CardAdmin for rationale)."""

    event_created = _broadcast.EVT_MEMBER_ADDED
    event_updated = _broadcast.EVT_MEMBER_UPDATED
    event_deleted = _broadcast.EVT_MEMBER_REMOVED

    def _board_id(self, obj):
        return obj.board_id

    def _payload(self, obj, request):
        return BoardMembershipSerializer(obj, context={"board": obj.board, "request": request}).data

    def _delete_payload(self, obj):
        return {"user_id": obj.user_id}


class _CardChildBroadcastAdminMixin:
    """Shared broadcast wiring for admin models that hang off a Card.

    CardComment and CardChecklist have no WebSocket event of their own — the
    REST endpoints for comments and checklist items (see
    ``boards/views/cards.py``'s ``comments``/``checklist``/``checklist_item``
    actions) always re-broadcast the *card's* full ``card.updated`` payload
    rather than a comment/checklist-specific event, because the frontend
    renders both inline on the open card panel. This mixin matches that: any
    admin mutation re-broadcasts a freshly refetched ``card.updated`` for the
    parent card (see CardAdmin above for why admin needs this at all).
    """

    def save_model(self, request, obj, form, change):
        super().save_model(request, obj, form, change)
        card = obj.card
        card_data = _refetched_card_data(card, request, card.board)
        _broadcast.record_board_event(
            card.board_id, _broadcast.EVT_CARD_UPDATED, card_data, actor_id=request.user.pk
        )

    def delete_model(self, request, obj):
        # Capture the card before deleting obj — obj.card is a live FK lookup
        # that still resolves pre-delete. The refetch happens after the
        # delete so the broadcast reflects the item's removal, same ordering
        # CardViewSet's comment/checklist endpoints use.
        card = obj.card
        super().delete_model(request, obj)
        card_data = _refetched_card_data(card, request, card.board)
        _broadcast.record_board_event(
            card.board_id, _broadcast.EVT_CARD_UPDATED, card_data, actor_id=request.user.pk
        )

    def delete_queryset(self, request, queryset):
        # Dedupe by card: a bulk delete can select several rows on the same
        # card, and each card only needs one post-delete broadcast reflecting
        # its final state, not one per deleted row.
        cards = {o.card_id: o.card for o in queryset}
        super().delete_queryset(request, queryset)
        for card in cards.values():
            card_data = _refetched_card_data(card, request, card.board)
            _broadcast.record_board_event(
                card.board_id, _broadcast.EVT_CARD_UPDATED, card_data, actor_id=request.user.pk
            )


@admin.register(CardComment)
class CardCommentAdmin(_CardChildBroadcastAdminMixin, admin.ModelAdmin):
    """Admin for CardComment that broadcasts mutations (see CardAdmin for rationale)."""


@admin.register(CardChecklist)
class CardChecklistAdmin(_CardChildBroadcastAdminMixin, admin.ModelAdmin):
    """Admin for CardChecklist that broadcasts mutations (see CardAdmin for rationale)."""


# CardMovement and CardActivity are append-only audit-trail rows (no update
# path, and deletion is not part of any documented workflow) — the #1241
# audit flagged them as the same gap in principle but lower priority than the
# six models above. CardAttachment and Notification were not flagged by the
# audit. All four remain plain registrations; broadcasting admin mutations to
# them can follow the same _BoardEventAdminMixin/_CardChildBroadcastAdminMixin
# pattern if a future audit asks for it.
admin.site.register(CardMovement)
admin.site.register(CardActivity)
admin.site.register(CardAttachment)
admin.site.register(Notification)
