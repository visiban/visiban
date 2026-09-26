"""SwimlaneViewSet — CRUD endpoints for swimlanes on a board."""

from django.db import transaction
from django.db.models import Max
from rest_framework.generics import get_object_or_404
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
from ..models import Board, BoardMembership, Swimlane
from ..permissions import SITE_ADMIN
from ..serializers import (
    SwimlaneSerializer, SwimlaneAdminSerializer, _swimlane_custom_field_prefetch,
)
from ..services.custom_fields import apply_swimlane_custom_field_values
from ._helpers import get_board_for_user


def _refetch_swimlane(swimlane):
    """Re-read one swimlane with its custom field values prefetched (#1140).

    A swimlane that has just been written holds no prefetch cache, and the
    values may have been changed by ``apply_swimlane_custom_field_values`` after
    it was loaded. Serializing it directly would therefore either miss the
    change or lazily re-query per value. One targeted re-read keeps the
    broadcast payload correct and its query count fixed.
    """
    return (
        Swimlane.objects.filter(pk=swimlane.pk)
        .prefetch_related(_swimlane_custom_field_prefetch())
        .first()
        or swimlane
    )


class SwimlaneViewSet(viewsets.ModelViewSet):
    """CRUD endpoints for swimlanes on a board; write operations require admin role."""

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

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        # SwimlaneCustomFieldValuesField resolves submitted definition ids
        # scoped to this board and fails closed without it (#1140).
        ctx["board"] = self._board()
        return ctx

    def get_queryset(self):
        # Prefetch the custom field values and their definitions (#1140).
        # Without this, serializing N swimlanes costs 1 + 2N queries: the
        # serializer reads `is_admin_only` off each value's definition to decide
        # whether a non-admin may see it. Ordering lives in the Prefetch
        # queryset rather than Meta.ordering so only the read path pays the
        # join — same reasoning as _card_queryset().
        return Swimlane.objects.filter(board=self._board()).prefetch_related(
            _swimlane_custom_field_prefetch()
        )

    def perform_create(self, serializer):
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        # Not a model field — pop before save() so ModelSerializer.create() does
        # not try to pass it to Swimlane.objects.create().
        field_pairs = serializer.validated_data.pop("custom_field_values", None)
        # Lock the board row for the same reason as ColumnViewSet.perform_create —
        # concurrent swimlane creation could race on Max(position).
        with transaction.atomic():
            Board.objects.select_for_update().get(pk=board.pk)
            _max = board.swimlanes.aggregate(m=Max("position"))["m"]
            max_pos = 0 if _max is None else _max + 1
            swimlane = serializer.save(board=board, position=max_pos)
            if field_pairs:
                apply_swimlane_custom_field_values(
                    swimlane=swimlane, pairs=field_pairs, actor=self.request.user
                )
            # Broadcast uses the public serializer — contact_email, notes, and
            # is_admin_only custom field values must not be sent to viewer-role
            # members who are connected via WebSocket.
            swimlane_data = SwimlaneSerializer(_refetch_swimlane(swimlane)).data
            board_id = board.id
            _broadcast.record_board_event(board_id, _broadcast.EVT_SWIMLANE_CREATED, swimlane_data, actor_id=self.request.user.id)

    def perform_update(self, serializer):
        _, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        field_pairs = serializer.validated_data.pop("custom_field_values", None)
        with transaction.atomic():
            swimlane = serializer.save()
            if field_pairs:
                apply_swimlane_custom_field_values(
                    swimlane=swimlane, pairs=field_pairs, actor=self.request.user
                )
            # Same broadcast-safety constraint as perform_create.
            swimlane_data = SwimlaneSerializer(_refetch_swimlane(swimlane)).data
            board_id = swimlane.board_id
            _broadcast.record_board_event(board_id, _broadcast.EVT_SWIMLANE_UPDATED, swimlane_data, actor_id=self.request.user.id)

    def perform_destroy(self, instance):
        _, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        board_id = instance.board_id
        swimlane_uid = instance.uid
        with transaction.atomic():
            instance.delete()
            _broadcast.record_board_event(board_id, _broadcast.EVT_SWIMLANE_DELETED, {"swimlane_uid": swimlane_uid}, actor_id=self.request.user.id)

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

        Emits ``Deprecation: true`` plus a ``Link`` header pointing at the
        canonical kebab-case route (RFC 8594 / RFC 8288, #986) so operators
        and proxies can audit deprecated traffic before the 2.0 removal.
        """
        response = self._set_collapsed_impl(request, pk)
        response["Deprecation"] = "true"
        # Replace exactly the route segment so we don't accidentally rewrite
        # any future path component that happens to contain "set_collapsed".
        canonical_path = request.path.replace("/set_collapsed/", "/set-collapsed/", 1)
        response["Link"] = f'<{request.build_absolute_uri(canonical_path)}>; rel="successor-version"'
        return response

    def _set_collapsed_impl(self, request, pk):
        """Set the default is_collapsed state on a swimlane (admin-only).

        ``is_collapsed`` is persisted on the model and changes the default
        board view for every member, so it is classified as board-structure
        management — an admin privilege per the RBAC role matrix.

        Broadcasts a ``swimlane.updated`` event via ``transaction.on_commit``
        so connected clients can reflect the new collapsed state in real time.
        """
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied("Only board admins can modify swimlane display state.")
        swimlane = get_object_or_404(Swimlane, pk=pk, board=board)
        is_collapsed = request.data.get("is_collapsed")
        if not isinstance(is_collapsed, bool):
            raise ValidationError({"is_collapsed": "This field must be a boolean."})
        swimlane.is_collapsed = is_collapsed
        with transaction.atomic():
            swimlane.save(update_fields=["is_collapsed"])
            # Fetched once and reused for both the broadcast payload and the
            # response: get_serializer() picks the admin/public class by role,
            # which needs no second query.
            fresh = _refetch_swimlane(swimlane)
            swimlane_data = SwimlaneSerializer(fresh).data
            board_id = swimlane.board_id
            _broadcast.record_board_event(board_id, _broadcast.EVT_SWIMLANE_UPDATED, swimlane_data, actor_id=self.request.user.id)
        return Response(self.get_serializer(fresh).data)

    @extend_schema(
        summary="Reorder swimlanes",
        description="Admin only. Accepts the full set of swimlane IDs in the desired order and returns the reordered list.",
        request=inline_serializer(
            name="SwimlaneReorderRequest",
            fields={
                "order": serializers.ListField(
                    child=serializers.IntegerField(),
                    help_text="Swimlane IDs for this board, in the desired display order.",
                ),
            },
        ),
        # Always the public serializer regardless of caller role — contact_email/notes
        # (admin-only fields) are never included in the reorder response or broadcast.
        responses=SwimlaneSerializer(many=True),
    )
    @action(detail=False, methods=["post"], pagination_class=None)
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
            lanes_data = SwimlaneSerializer(
                board.swimlanes.order_by("position").prefetch_related(
                    _swimlane_custom_field_prefetch()
                ),
                many=True,
            ).data
            board_id = board.id
            _broadcast.record_board_event(
                board_id, _broadcast.EVT_SWIMLANE_REORDERED, {"swimlanes": list(lanes_data)},
                actor_id=request.user.id,
            )
        return Response(lanes_data)
