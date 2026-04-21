"""ColumnViewSet — CRUD endpoints for columns on a board."""

from django.db import transaction
from django.db.models import Max
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from .. import broadcast as _broadcast
from ..models import Board, BoardMembership, Column
from ..permissions import SITE_ADMIN
from ..serializers import ColumnSerializer
from ._helpers import get_board_for_user


class ColumnViewSet(viewsets.ModelViewSet):
    """CRUD endpoints for columns on a board; write operations require admin role."""

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

    def perform_create(self, serializer):
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
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
            transaction.on_commit(lambda: _broadcast.broadcast_board_event(board_id, "column.created", column_data))

    def perform_update(self, serializer):
        _, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        with transaction.atomic():
            column = serializer.save()
            column_data = ColumnSerializer(column).data
            board_id = column.board_id
            transaction.on_commit(lambda: _broadcast.broadcast_board_event(board_id, "column.updated", column_data))

    def perform_destroy(self, instance):
        _, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        board_id = instance.board_id
        column_uid = instance.uid
        with transaction.atomic():
            instance.delete()
            transaction.on_commit(lambda: _broadcast.broadcast_board_event(board_id, "column.deleted", {"column_uid": column_uid}))

    @action(detail=False, methods=["post"])
    def reorder(self, request, board_pk=None):
        """Reorder columns by accepting a list of column IDs in the desired order (admin only)."""
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        order = request.data.get("order", [])  # list of column IDs in new order
        with transaction.atomic():
            # Two-pass bulk_update to avoid unique_together(board, position) violations.
            # First pass: shift all positions to high values so no two columns share a
            # position mid-update.  Second pass: assign final positions.
            # Using bulk_update reduces 2N single-row UPDATEs to 2 queries regardless
            # of column count.
            count = board.columns.count()
            # Cast IDs to int — request JSON sends strings, DB PKs are ints.
            order_ints = [int(cid) for cid in order]
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
            # Emit both plural (legacy 1.0) and singular (canonical from 1.1) event names.
            # The plural form is deprecated and will be removed in 2.0. See issue #807.
            def _broadcast_column_reorder() -> None:
                payload = {"columns": list(cols_data)}
                _broadcast.broadcast_board_event(board_id, "columns.reordered", payload)
                _broadcast.broadcast_board_event(board_id, "column.reordered", payload)

            transaction.on_commit(_broadcast_column_reorder)
        return Response(cols_data)
