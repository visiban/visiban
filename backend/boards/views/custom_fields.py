"""CustomFieldDefinitionViewSet — per-board custom field schema CRUD (#371).

Only the *schema* is managed here. A card's **values** are written through the
card endpoints, so they go through ``boards.services.cards`` and inherit its
invariants (role allow-list, ownership gate, version bump, activity trail,
deferred broadcast) rather than getting a second write path with none of them.

Role boundary, which differs per action and is the whole point of the split:

* read (list / retrieve) — any role with access to the board, viewers
  included. A viewer has to be able to see the schema behind the values they
  can already read, and the definition carries no data a board reader does not
  already have.
* create / update / delete / reorder — board admin, site admin, or owner. The
  schema is board configuration, the same boundary as columns and labels.
"""

from django.db import transaction
from django.db.models import Max
from rest_framework import serializers as drf_serializers, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from drf_spectacular.utils import extend_schema, inline_serializer

from accounts.permissions import TokenHasScope
from visiban.permissions import (
    MustNotHavePendingPasswordChange,
    MustNotHavePendingUsernameChange,
)

from .. import broadcast as _broadcast
from ..models import Board, BoardMembership, CustomFieldDefinition
from ..permissions import SITE_ADMIN
from ..serializers import CustomFieldDefinitionSerializer, assert_definition_caps
from ._helpers import get_board_for_user


class CustomFieldDefinitionViewSet(viewsets.ModelViewSet):
    """CRUD for a board's custom field definitions; writes require admin role."""

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
    serializer_class = CustomFieldDefinitionSerializer

    _cached_board_role = None

    def _board_and_role(self):
        # Cache per-request — DRF builds a fresh viewset instance per request,
        # so this cannot leak across requests. Same pattern as ColumnViewSet.
        if self._cached_board_role is None:
            self._cached_board_role = get_board_for_user(
                self.kwargs["board_pk"], self.request.user
            )
        return self._cached_board_role

    def _board(self):
        return self._board_and_role()[0]

    def _require_admin(self):
        """Gate every write action on board admin.

        Returns the board so callers do not resolve it twice. Raising
        ``PermissionDenied`` here rather than in a permission class keeps the
        rule next to the actions it governs, matching ColumnViewSet and
        LabelViewSet.
        """
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        return board

    def get_queryset(self):
        # Board-scoped, so a definition id from another board is a 404 on this
        # URL rather than a cross-board read or write (IDOR).
        return CustomFieldDefinition.objects.filter(board=self._board())

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        # The cap check in CustomFieldDefinitionSerializer.validate() needs the
        # board; without it the serializer skips the check and the viewset's
        # locked re-check below is the only one that runs.
        ctx["board"] = self._board()
        return ctx

    def perform_create(self, serializer):
        board = self._require_admin()
        with transaction.atomic():
            # Lock the board row before counting. Two concurrent creates would
            # otherwise both read a count of 29 and land a 31st field, and both
            # would read the same Max(position) and collide on
            # unique_together(board, position). Same lock ColumnViewSet takes
            # for the same two reasons.
            Board.objects.select_for_update().get(pk=board.pk)
            assert_definition_caps(
                board,
                show_on_card=serializer.validated_data.get("show_on_card", False),
            )
            _max = board.custom_field_definitions.aggregate(m=Max("position"))["m"]
            next_position = 0 if _max is None else _max + 1
            definition = serializer.save(board=board, position=next_position)
            payload = CustomFieldDefinitionSerializer(definition).data
            board_id = board.id
            # record_board_event, not a bare on_commit broadcast: it persists a
            # BoardEvent row so a client replaying /events/?after= learns about
            # schema changes it missed while disconnected (#1134).
            _broadcast.record_board_event(
                board_id, _broadcast.EVT_CUSTOM_FIELD_CREATED, payload,
                actor_id=self.request.user.id,
            )

    def perform_update(self, serializer):
        board = self._require_admin()
        with transaction.atomic():
            Board.objects.select_for_update().get(pk=board.pk)
            assert_definition_caps(
                board,
                instance=serializer.instance,
                show_on_card=serializer.validated_data.get(
                    "show_on_card", serializer.instance.show_on_card
                ),
            )
            definition = serializer.save()
            payload = CustomFieldDefinitionSerializer(definition).data
            board_id = definition.board_id
            # record_board_event, not a bare on_commit broadcast: it persists a
            # BoardEvent row so a client replaying /events/?after= learns about
            # schema changes it missed while disconnected (#1134).
            _broadcast.record_board_event(
                board_id, _broadcast.EVT_CUSTOM_FIELD_UPDATED, payload,
                actor_id=self.request.user.id,
            )

    def perform_destroy(self, instance):
        self._require_admin()
        board_id = instance.board_id
        field_uid = instance.uid
        with transaction.atomic():
            # CASCADE removes every CustomFieldValue for this definition — the
            # values are meaningless without the schema that types them, and
            # keeping orphans would resurrect them if a field of the same name
            # were recreated.
            instance.delete()
            # record_board_event, not a bare on_commit broadcast: it persists a
            # BoardEvent row so a client replaying /events/?after= learns about
            # schema changes it missed while disconnected (#1134).
            _broadcast.record_board_event(
                board_id, _broadcast.EVT_CUSTOM_FIELD_DELETED,
                {"custom_field_uid": field_uid}, actor_id=self.request.user.id,
            )

    @extend_schema(
        summary="Reorder custom field definitions",
        description=(
            "Admin only. Accepts the full set of custom field IDs for this board "
            "in the desired order and returns the reordered list. Accepts PUT "
            "(as specified for this endpoint) or POST (matching the column and "
            "swimlane reorder actions)."
        ),
        request=inline_serializer(
            name="CustomFieldReorderRequest",
            fields={
                "order": drf_serializers.ListField(
                    child=drf_serializers.IntegerField(),
                    help_text="Custom field IDs for this board, in the desired display order.",
                ),
            },
        ),
        responses=CustomFieldDefinitionSerializer(many=True),
    )
    @action(detail=False, methods=["put", "post"])
    def reorder(self, request, board_pk=None):
        """Reorder custom fields by a list of IDs in the desired order (admin only)."""
        board = self._require_admin()
        order = request.data.get("order", [])
        if not isinstance(order, list):
            raise drf_serializers.ValidationError(
                {"order": "Expected a list of custom field IDs."}
            )
        try:
            order_ints = [int(fid) for fid in order]
        except (TypeError, ValueError):
            raise drf_serializers.ValidationError(
                {"order": "Every entry must be a custom field ID."}
            ) from None

        with transaction.atomic():
            # Two-pass bulk_update to stay inside unique_together(board,
            # position): the first pass parks every row above the current
            # maximum so no two rows share a position mid-update, the second
            # assigns the final values. Two queries regardless of field count.
            # IDs are looked up board-scoped, so an id from another board is
            # silently ignored rather than reordered (IDOR).
            count = board.custom_field_definitions.count()
            rows = list(
                CustomFieldDefinition.objects.filter(
                    board=board, pk__in=order_ints
                ).only("id", "position")
            )
            by_id = {row.pk: row for row in rows}
            ordered = [by_id[fid] for fid in order_ints if fid in by_id]
            for i, row in enumerate(ordered):
                row.position = count + i
            CustomFieldDefinition.objects.bulk_update(ordered, ["position"])
            for i, row in enumerate(ordered):
                row.position = i
            CustomFieldDefinition.objects.bulk_update(ordered, ["position"])

            data = CustomFieldDefinitionSerializer(
                board.custom_field_definitions.order_by("position", "id"), many=True
            ).data
            board_id = board.id

            # record_board_event, not a bare on_commit broadcast: it persists a
            # BoardEvent row so a client replaying /events/?after= learns about
            # schema changes it missed while disconnected (#1134).
            _broadcast.record_board_event(
                board_id, _broadcast.EVT_CUSTOM_FIELD_REORDERED,
                {"custom_fields": list(data)}, actor_id=request.user.id,
            )
        return Response(data)
