from django.contrib import admin
from django.db import transaction

from . import broadcast as _broadcast
from .models import (
    Board, BoardMembership, Column, Swimlane, Label, Card, CardMovement,
    CardComment, CardActivity, CardAttachment, CardChecklist, Notification,
)
from .serializers import ColumnSerializer
from .views._helpers import _refetched_card_data


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
        event = "card.updated" if change else "card.created"
        card_data = _refetched_card_data(obj, request, board)
        board_id = board.id
        transaction.on_commit(
            lambda: _broadcast.broadcast_board_event(board_id, event, card_data)
        )

    def delete_model(self, request, obj):
        board_id = obj.board_id
        card_uid = obj.uid
        super().delete_model(request, obj)
        transaction.on_commit(
            lambda: _broadcast.broadcast_board_event(
                board_id, "card.deleted", {"card_uid": card_uid}
            )
        )

    def delete_queryset(self, request, queryset):
        # Capture board_id + uid before delete — post-delete the instances are gone.
        deleted = [(c.board_id, c.uid) for c in queryset]
        super().delete_queryset(request, queryset)
        for board_id, card_uid in deleted:
            # Bind loop vars into the closure to avoid late-binding all lambdas
            # to the final iteration's values.
            def _emit(bid=board_id, uid=card_uid):
                _broadcast.broadcast_board_event(bid, "card.deleted", {"card_uid": uid})
            transaction.on_commit(_emit)


@admin.register(Column)
class ColumnAdmin(admin.ModelAdmin):
    """Admin for Column that broadcasts mutations (see CardAdmin for rationale)."""

    def save_model(self, request, obj, form, change):
        super().save_model(request, obj, form, change)
        event = "column.updated" if change else "column.created"
        column_data = ColumnSerializer(obj).data
        board_id = obj.board_id
        transaction.on_commit(
            lambda: _broadcast.broadcast_board_event(board_id, event, column_data)
        )

    def delete_model(self, request, obj):
        board_id = obj.board_id
        column_uid = obj.uid
        super().delete_model(request, obj)
        transaction.on_commit(
            lambda: _broadcast.broadcast_board_event(
                board_id, "column.deleted", {"column_uid": column_uid}
            )
        )

    def delete_queryset(self, request, queryset):
        deleted = [(c.board_id, c.uid) for c in queryset]
        super().delete_queryset(request, queryset)
        for board_id, column_uid in deleted:
            def _emit(bid=board_id, uid=column_uid):
                _broadcast.broadcast_board_event(bid, "column.deleted", {"column_uid": uid})
            transaction.on_commit(_emit)


admin.site.register(Board)
admin.site.register(BoardMembership)
admin.site.register(Swimlane)
admin.site.register(Label)
admin.site.register(CardMovement)
admin.site.register(CardComment)
admin.site.register(CardActivity)
admin.site.register(CardAttachment)
admin.site.register(CardChecklist)
admin.site.register(Notification)
