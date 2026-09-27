"""ColumnViewSet — CRUD endpoints for columns on a board."""

from django.db import IntegrityError, transaction
from django.db.models import Max
from rest_framework import serializers, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from drf_spectacular.utils import extend_schema, inline_serializer

from accounts.permissions import TokenHasScope
from visiban.permissions import (
    MustNotHavePendingPasswordChange,
    MustNotHavePendingUsernameChange,
)

from .. import broadcast as _broadcast
from ..models import Board, BoardMembership, Column
from ..permissions import SITE_ADMIN
from ..serializers import ColumnSerializer
from ._helpers import get_board_for_user


class ColumnViewSet(viewsets.ModelViewSet):
    """CRUD endpoints for columns on a board; write operations require admin role."""

    # See BoardViewSet.lookup_value_regex — same fix, own `pk` segment.
    lookup_value_regex = r"\d+"

    # Explicitly enumerate the global default permission chain (#989/#1050) so an
    # accidental change to DEFAULT_PERMISSION_CLASSES cannot silently drop the auth
    # gate from this viewset without a visible diff here.
    permission_classes = [
        IsAuthenticated,
        MustNotHavePendingPasswordChange,
        MustNotHavePendingUsernameChange,
        TokenHasScope,
    ]
    serializer_class = ColumnSerializer

    _cached_board_role = None

    def _board_and_role(self):
        # Cache per-request to avoid redundant board fetches — DRF creates a
        # fresh viewset instance for each request, so the cache is safe.
        if self._cached_board_role is None:
            self._cached_board_role = get_board_for_user(
                self.kwargs["board_pk"], self.request.user
            )
        return self._cached_board_role

    def _board(self):
        return self._board_and_role()[0]

    def get_queryset(self):
        return Column.objects.filter(board=self._board())

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        # ColumnSerializer.validate() needs the board to check unique_together(board,
        # name)/(board, position) — `board` is not a serializer field, so without this
        # the serializer skips the check and only the IntegrityError catch below fires.
        ctx["board"] = self._board()
        return ctx

    def perform_create(self, serializer):
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        try:
            # Lock the board row before computing the next position to prevent a race
            # condition where two concurrent requests both read the same Max(position) and
            # attempt to insert two columns with the same value, violating unique_together.
            with transaction.atomic():
                Board.objects.select_for_update().get(pk=board.pk)
                _max = board.columns.aggregate(m=Max("position"))["m"]
                max_pos = 0 if _max is None else _max + 1
                column = serializer.save(board=board, position=max_pos)
                column_data = ColumnSerializer(column).data
                board_id = board.id
                _broadcast.record_board_event(board_id, _broadcast.EVT_COLUMN_CREATED, column_data, actor_id=self.request.user.id)
        except IntegrityError:
            # Belt and braces for the race the serializer's validate() cannot fully
            # close (two concurrent creates can both pass validation before either
            # commits): the unique_together(board, name) constraint caught it, so
            # report it the way the serializer would have rather than as a 500.
            raise ValidationError(
                {"name": "A column with this name already exists on this board."}
            ) from None

    def perform_update(self, serializer):
        _, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        try:
            with transaction.atomic():
                column = serializer.save()
                column_data = ColumnSerializer(column).data
                board_id = column.board_id
                _broadcast.record_board_event(board_id, _broadcast.EVT_COLUMN_UPDATED, column_data, actor_id=self.request.user.id)
        except IntegrityError:
            # Same race as perform_create, reachable here via either
            # unique_together(board, name) or (board, position) — the serializer
            # checks both, this is only the fallback for the check-then-write gap.
            raise ValidationError(
                {"name": "A column with this name or position already exists on this board."}
            ) from None

    def perform_destroy(self, instance):
        _, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        board_id = instance.board_id
        column_uid = instance.uid
        with transaction.atomic():
            instance.delete()
            _broadcast.record_board_event(board_id, _broadcast.EVT_COLUMN_DELETED, {"column_uid": column_uid}, actor_id=self.request.user.id)

    @extend_schema(
        summary="Reorder columns",
        description="Admin only. Accepts the full set of column IDs in the desired order and returns the reordered list.",
        request=inline_serializer(
            name="ColumnReorderRequest",
            fields={
                "order": serializers.ListField(
                    child=serializers.IntegerField(),
                    help_text="Column IDs for this board, in the desired display order.",
                ),
            },
        ),
        responses=ColumnSerializer(many=True),
    )
    @action(detail=False, methods=["post"], pagination_class=None)
    def reorder(self, request, board_pk=None):
        """Reorder columns by accepting a list of column IDs in the desired order (admin only)."""
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        order = request.data.get("order", [])  # list of column IDs in new order
        try:
            # Cast IDs to int — request JSON sends strings, DB PKs are ints. Done
            # before opening the transaction: a non-integer entry (or a body where
            # `order` isn't even a list) previously reached int() unguarded and
            # surfaced as a 500 instead of a 400 naming the field.
            order_ints = [int(cid) for cid in order]
        except (TypeError, ValueError):
            raise ValidationError(
                {"order": "order must be a list of integer column IDs."}
            ) from None
        with transaction.atomic():
            # Two-pass bulk_update to avoid unique_together(board, position) violations.
            # First pass: shift all positions to high values so no two columns share a
            # position mid-update.  Second pass: assign final positions.
            # Using bulk_update reduces 2N single-row UPDATEs to 2 queries regardless
            # of column count.
            count = board.columns.count()
            cols = list(Column.objects.filter(board=board, pk__in=order_ints).only("id", "position"))
            id_to_col = {c.pk: c for c in cols}
            for i, col_id in enumerate(order_ints):
                if col_id in id_to_col:
                    id_to_col[col_id].position = count + i
            Column.objects.bulk_update([id_to_col[cid] for cid in order_ints if cid in id_to_col], ["position"])
            for pos, col_id in enumerate(order_ints):
                if col_id in id_to_col:
                    id_to_col[col_id].position = pos
            Column.objects.bulk_update([id_to_col[cid] for cid in order_ints if cid in id_to_col], ["position"])
            cols_data = ColumnSerializer(board.columns.order_by("position"), many=True).data
            board_id = board.id
            _broadcast.record_board_event(
                board_id, _broadcast.EVT_COLUMN_REORDERED, {"columns": list(cols_data)},
                actor_id=request.user.id,
            )
        return Response(cols_data)
