from django.contrib import admin
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


@admin.register(Card)
class CardAdmin(admin.ModelAdmin):
    """Admin for Card that broadcasts mutations to connected WebSocket clients.

    Mutations made through the admin site bypass the REST viewset and its
    perform_create/perform_update/perform_destroy hooks. Without this override
    any client viewing the affected board would not see admin edits until a
    full reload. Broadcast is deferred via transaction.on_commit() so clients
    only see events after the DB write is durably committed.
    """

    def save_model(self, request, obj, form, change):
        super().save_model(request, obj, form, change)
        board = obj.board
        event = _broadcast.EVT_CARD_UPDATED if change else _broadcast.EVT_CARD_CREATED
        card_data = _refetched_card_data(obj, request, board)
        board_id = board.id
        _broadcast.record_board_event(board_id, event, card_data, actor_id=request.user.pk)

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

    def save_model(self, request, obj, form, change):
        super().save_model(request, obj, form, change)
        event = self.event_updated if change else self.event_created
        _broadcast.record_board_event(
            self._board_id(obj), event, self._payload(obj, request), actor_id=request.user.pk
        )

    def delete_model(self, request, obj):
        board_id = self._board_id(obj)
        payload = self._delete_payload(obj)
        super().delete_model(request, obj)
        _broadcast.record_board_event(board_id, self.event_deleted, payload, actor_id=request.user.pk)

    def delete_queryset(self, request, queryset):
        # Capture identifiers before delete — post-delete each instance's pk is cleared.
        deleted = [(self._board_id(o), self._delete_payload(o)) for o in queryset]
        super().delete_queryset(request, queryset)
        for board_id, payload in deleted:
            _broadcast.record_board_event(board_id, self.event_deleted, payload, actor_id=request.user.pk)


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
