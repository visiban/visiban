"""SwimlaneViewSet — CRUD endpoints for swimlanes on a board."""

from django.db import transaction
from django.db.models import Max
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from .. import broadcast as _broadcast
from ..models import Board, BoardMembership, Swimlane
from ..permissions import SITE_ADMIN
from ..serializers import SwimlaneSerializer, SwimlaneAdminSerializer
from ._helpers import get_board_for_user


class SwimlaneViewSet(viewsets.ModelViewSet):
    """CRUD endpoints for swimlanes on a board; write operations require admin role."""

    def get_serializer_class(self):
        # Admin and site_admin members see contact_email and notes; all others get the
        # public serializer which omits those fields to prevent viewer-role PII exposure.
        _, role = self._board_and_role()
        if role in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            return SwimlaneAdminSerializer
        return SwimlaneSerializer

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
        return Swimlane.objects.filter(board=self._board())

    def perform_create(self, serializer):
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        # Lock the board row for the same reason as ColumnViewSet.perform_create —
        # concurrent swimlane creation could race on Max(position).
        with transaction.atomic():
            Board.objects.select_for_update().get(pk=board.pk)
            _max = board.swimlanes.aggregate(m=Max("position"))["m"]
            max_pos = 0 if _max is None else _max + 1
            swimlane = serializer.save(board=board, position=max_pos)
            # Broadcast uses the public serializer — contact_email and notes must not be
            # sent to viewer-role members who are connected via WebSocket.
            swimlane_data = SwimlaneSerializer(swimlane).data
            board_id = board.id
            transaction.on_commit(lambda: _broadcast.broadcast_board_event(board_id, "swimlane.created", swimlane_data))

    def perform_update(self, serializer):
        _, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        with transaction.atomic():
            swimlane = serializer.save()
            # Same broadcast-safety constraint as perform_create.
            swimlane_data = SwimlaneSerializer(swimlane).data
            board_id = swimlane.board_id
            transaction.on_commit(lambda: _broadcast.broadcast_board_event(board_id, "swimlane.updated", swimlane_data))

    def perform_destroy(self, instance):
        _, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        board_id = instance.board_id
        swimlane_uid = instance.uid
        with transaction.atomic():
            instance.delete()
            transaction.on_commit(lambda: _broadcast.broadcast_board_event(board_id, "swimlane.deleted", {"swimlane_uid": swimlane_uid}))

    @action(detail=False, methods=["post"])
    def reorder(self, request, board_pk=None):
        """Reorder swimlanes by accepting a list of swimlane IDs in the desired order (admin only)."""
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        order = request.data.get("order", [])
        with transaction.atomic():
            # Lock the board row before updating positions to prevent two
            # concurrent reorder requests from interleaving their UPDATE
            # statements and producing an inconsistent position sequence.
            # Single-pass update is safe here: Swimlane has unique_together on
            # (board, name), NOT (board, position), so mid-update position
            # collisions cannot cause an IntegrityError.  Contrast with
            # ColumnViewSet.reorder which requires a two-pass approach because
            # Column has unique_together = ["board", "position"].
            Board.objects.select_for_update().get(pk=board.pk)
            # bulk_update replaces N single-row UPDATEs with one query regardless of
            # swimlane count.  Swimlane has no unique_together on position so a single
            # pass is safe (contrast with ColumnViewSet.reorder which needs two passes).
            # Cast IDs to int — request JSON sends strings, DB PKs are ints.
            order_ints = [int(sid) for sid in order]
            lanes = list(Swimlane.objects.filter(board=board, pk__in=order_ints).only("id", "position"))
            id_to_lane = {sl.pk: sl for sl in lanes}
            for pos, swimlane_id in enumerate(order_ints):
                if swimlane_id in id_to_lane:
                    id_to_lane[swimlane_id].position = pos
            Swimlane.objects.bulk_update(list(id_to_lane.values()), ["position"])
            lanes_data = SwimlaneSerializer(board.swimlanes.order_by("position"), many=True).data
            board_id = board.id
            transaction.on_commit(lambda: _broadcast.broadcast_board_event(board_id, "swimlanes.reordered", {"swimlanes": list(lanes_data)}))
        return Response(lanes_data)
