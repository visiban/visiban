"""SwimlaneViewSet — CRUD endpoints for swimlanes on a board."""

from django.db import transaction
from django.db.models import Max
from django.shortcuts import get_object_or_404
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
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

    @action(detail=True, methods=["patch"], url_path="set-collapsed")
    def set_collapsed_kebab(self, request, board_pk=None, pk=None):
        """Canonical kebab-case alias for the swimlane is_collapsed toggle (#816).

        All new callers should use ``PATCH /swimlanes/<pk>/set-collapsed/``.
        The snake_case route ``set_collapsed`` below is kept as a deprecated
        alias and scheduled for removal in 2.0; both routes share the exact
        same implementation.
        """
        return self._set_collapsed_impl(request, pk)

    @action(detail=True, methods=["patch"], url_path="set_collapsed")
    def set_collapsed(self, request, board_pk=None, pk=None):
        """Deprecated snake_case alias for ``set-collapsed`` (#816).

        Retained to preserve the 1.0 URL contract. The canonical kebab-case
        path is ``set-collapsed``; the snake_case form will be removed in 2.0
        after one full minor-release deprecation window.
        """
        return self._set_collapsed_impl(request, pk)

    def _set_collapsed_impl(self, request, pk):
        """Allow non-viewer board members to set the default is_collapsed state on a swimlane.

        This action is intentionally open below the admin gate used by the
        regular update path because ``is_collapsed`` is a low-risk view
        preference that board members can set as the default for all users.
        Viewers are excluded because the value is persisted on the model and
        changes the default view for every member — "manage board structure"
        is an admin/member privilege, not a read-only one.

        Broadcasts a ``swimlane.updated`` event via ``transaction.on_commit``
        so connected clients can reflect the new collapsed state in real time.
        """
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.MEMBER, BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied("Only members and admins can modify swimlane display state.")
        swimlane = get_object_or_404(Swimlane, pk=pk, board=board)
        is_collapsed = request.data.get("is_collapsed")
        if not isinstance(is_collapsed, bool):
            raise ValidationError({"is_collapsed": "This field must be a boolean."})
        swimlane.is_collapsed = is_collapsed
        swimlane.save(update_fields=["is_collapsed"])
        serializer = self.get_serializer(swimlane)
        swimlane_data = SwimlaneSerializer(swimlane).data
        board_id = swimlane.board_id
        transaction.on_commit(lambda: _broadcast.broadcast_board_event(board_id, "swimlane.updated", swimlane_data))
        return Response(serializer.data)

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
            # Emit both plural (legacy 1.0) and singular (canonical from 1.1) event names.
            # The plural form is deprecated and will be removed in 2.0. See issue #807.
            def _broadcast_swimlane_reorder() -> None:
                payload = {"swimlanes": list(lanes_data)}
                _broadcast.broadcast_board_event(board_id, "swimlanes.reordered", payload)
                _broadcast.broadcast_board_event(board_id, "swimlane.reordered", payload)

            transaction.on_commit(_broadcast_swimlane_reorder)
        return Response(lanes_data)
