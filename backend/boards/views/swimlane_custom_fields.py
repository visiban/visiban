"""SwimlaneCustomFieldDefinitionViewSet — per-board row field schema CRUD (#1140).

The row-level counterpart to ``views/custom_fields.py``. Only the *schema* is
managed here: a swimlane's **values** are written through the swimlane endpoint,
so they go through ``SwimlaneViewSet.perform_update`` and inherit its admin
gate, its transaction and its event recording rather than getting a second
write path with none of them.

Role boundary, identical to the card-level viewset and for the same reason:

* read (list / retrieve) — any role with access to the board, viewers
  included. A viewer must be able to see the schema behind the values they can
  already read, and a definition carries no data a board reader does not
  already have. Note this is the *schema*, not the values: which of those
  values a given role may read is decided by ``is_admin_only`` on the swimlane
  serializers, not here.
* create / update / delete / reorder — board admin, site admin, or owner. The
  schema is board configuration, the same boundary as columns and labels.

**Broadcast convention:** this module uses ``record_board_event``, matching
``views/swimlanes.py``, *not* the ``transaction.on_commit(broadcast_board_event)``
idiom still used by ``views/custom_fields.py``. ``record_board_event`` is the
documented replacement for that idiom and additionally persists a ``BoardEvent``
row, which is what makes an event resumable through
``GET /boards/<id>/events/?after=``. The card-level module predates the
migration by three minutes (``d4acd5e4`` vs ``7e1a5e07``) and is the stale one;
migrating it is tracked separately rather than smuggled in here, because it
changes card-level WebSocket behavior.
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

from visiban.request_shape import id_in_db_range, require_json_object

from .. import broadcast as _broadcast
from ..models import BoardMembership, SwimlaneCustomFieldDefinition
from ..permissions import SITE_ADMIN
from ..serializers import (
    SwimlaneCustomFieldDefinitionSerializer, assert_definition_caps,
)
from ._helpers import (
    get_board_for_user,
    lock_board_and_row_or_404,
    lock_board_row_or_404,
)


class SwimlaneCustomFieldDefinitionViewSet(viewsets.ModelViewSet):
    """CRUD for a board's swimlane custom field definitions; writes need admin."""

    # See BoardViewSet.lookup_value_regex — same fix, own `pk` segment: without
    # it a non-numeric id is a 500 rather than a 404.
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
    serializer_class = SwimlaneCustomFieldDefinitionSerializer

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
        CustomFieldDefinitionViewSet.
        """
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        return board

    def get_queryset(self):
        # Board-scoped, so a definition id from another board is a 404 on this
        # URL rather than a cross-board read or write (IDOR).
        return SwimlaneCustomFieldDefinition.objects.filter(board=self._board())

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        # The cap and name-clash checks in the serializer's validate() need the
        # board; without it the serializer skips them and the viewset's locked
        # re-check below is the only one that runs.
        ctx["board"] = self._board()
        return ctx

    def create(self, request, *args, **kwargs):
        """POST: the admin check runs before the body is validated (#2009).

        DRF validates the serializer before ``perform_create``, so a caller below
        admin sending an invalid body got a ``400`` instead of the ``403`` a valid
        one gets. The role is cached per request, so ``perform_create``'s own
        check costs nothing; an access-less caller still gets the ``404`` from
        ``_board_and_role``.
        """
        self._require_admin()
        return super().create(request, *args, **kwargs)

    def perform_create(self, serializer):
        board = self._require_admin()
        with transaction.atomic():
            # Lock the board row before counting. Two concurrent creates would
            # otherwise both read a count of MAX_PER_BOARD - 1 and land one
            # field over the cap, and both would read the same Max(position)
            # and collide on unique_together(board, position).
            lock_board_row_or_404(board)
            assert_definition_caps(
                board,
                show_on_card=serializer.validated_data.get("show_on_row", False),
                definition_model=SwimlaneCustomFieldDefinition,
                pin_attr="show_on_row",
                pin_surface="the swimlane row",
                field_noun="swimlane custom fields",
            )
            _max = board.swimlane_custom_field_definitions.aggregate(
                m=Max("position")
            )["m"]
            next_position = 0 if _max is None else _max + 1
            definition = serializer.save(board=board, position=next_position)
            payload = SwimlaneCustomFieldDefinitionSerializer(definition).data
            _broadcast.record_board_event(
                board.id,
                _broadcast.EVT_SWIMLANE_CUSTOM_FIELD_CREATED,
                payload,
                actor_id=self.request.user.id,
            )

    def update(self, request, *args, **kwargs):
        """PUT/PATCH: the admin check runs before the body is validated (#2009).

        DRF validates the serializer before ``perform_update``, so a caller below
        admin sending an invalid body got a ``400`` instead of the ``403`` a valid
        one gets. The role is cached per request, so ``perform_update``'s own
        check costs nothing; an access-less caller still gets the ``404`` from
        ``_board_and_role``.
        """
        self._require_admin()
        return super().update(request, *args, **kwargs)

    def perform_update(self, serializer):
        board = self._require_admin()
        with transaction.atomic():
            # Board row, then the definition row (#1602): a PATCH queued behind
            # a DELETE of the same definition UPDATEd 0 rows and fell back to
            # an INSERT under the same pk, resurrecting it. Now it answers 404.
            lock_board_and_row_or_404(board, SwimlaneCustomFieldDefinition, serializer.instance.pk)
            # Reload under the lock: save() writes every column and the
            # instance predates the lock (a rename queued behind a reorder
            # must keep the new position).
            serializer.instance.refresh_from_db()
            assert_definition_caps(
                board,
                instance=serializer.instance,
                show_on_card=serializer.validated_data.get(
                    "show_on_row", serializer.instance.show_on_row
                ),
                definition_model=SwimlaneCustomFieldDefinition,
                pin_attr="show_on_row",
                pin_surface="the swimlane row",
                field_noun="swimlane custom fields",
            )
            definition = serializer.save()
            payload = SwimlaneCustomFieldDefinitionSerializer(definition).data
            _broadcast.record_board_event(
                definition.board_id,
                _broadcast.EVT_SWIMLANE_CUSTOM_FIELD_UPDATED,
                payload,
                actor_id=self.request.user.id,
            )

    def perform_destroy(self, instance):
        board = self._require_admin()
        board_id = instance.board_id
        field_uid = instance.uid
        with transaction.atomic():
            # Board row, then the definition row, the order update takes, so a
            # delete queued behind an update (or another delete) serializes
            # and answers 404 instead of broadcasting a second deletion.
            lock_board_and_row_or_404(board, SwimlaneCustomFieldDefinition, instance.pk)
            # CASCADE removes every SwimlaneCustomFieldValue for this
            # definition — the values are meaningless without the schema that
            # types them, and keeping orphans would resurrect them if a field
            # of the same name were recreated.
            instance.delete()
            _broadcast.record_board_event(
                board_id,
                _broadcast.EVT_SWIMLANE_CUSTOM_FIELD_DELETED,
                {"swimlane_custom_field_uid": field_uid},
                actor_id=self.request.user.id,
            )

    @extend_schema(
        summary="Reorder swimlane custom field definitions",
        description=(
            "Admin only. Accepts the full set of swimlane custom field IDs for "
            "this board in the desired order and returns the reordered list. "
            "POST only, matching the card-level custom field reorder action."
        ),
        request=inline_serializer(
            name="SwimlaneCustomFieldReorder",
            fields={
                "order": drf_serializers.ListField(
                    child=drf_serializers.IntegerField(),
                    help_text=(
                        "Swimlane custom field IDs for this board, in the "
                        "desired display order."
                    ),
                ),
            },
        ),
        responses=SwimlaneCustomFieldDefinitionSerializer(many=True),
    )
    # pagination_class=None: the response is the plain reordered list. Without it
    # drf-spectacular wraps the many=True response in the global paginator's
    # envelope, so the schema promises {count, results, ...} but the endpoint
    # sends a bare array — a client generated from the schema cannot parse it.
    @action(detail=False, methods=["post"], pagination_class=None)
    def reorder(self, request, board_pk=None):
        """Reorder swimlane custom fields by a list of IDs (admin only)."""
        board = self._require_admin()
        order = require_json_object(request).get("order", [])
        if not isinstance(order, list):
            raise drf_serializers.ValidationError(
                {"order": "Expected a list of swimlane custom field IDs."}
            )
        try:
            order_ints = [int(fid) for fid in order]
        except (TypeError, ValueError):
            raise drf_serializers.ValidationError(
                {"order": "Every entry must be a swimlane custom field ID."}
            ) from None
        if not all(id_in_db_range(i) for i in order_ints):
            raise drf_serializers.ValidationError(
                {"order": "Every entry must be a swimlane custom field ID."}
            )

        with transaction.atomic():
            # Two-pass bulk_update to stay inside unique_together(board,
            # position): the first pass parks every row above the current
            # maximum so no two rows share a position mid-update, the second
            # assigns the final values. Two queries regardless of field count.
            # Note this model needs the two-pass treatment even though
            # SwimlaneViewSet.reorder does not — Swimlane has no unique
            # constraint on position, this model does.
            # IDs are looked up board-scoped, so an id from another board is
            # silently ignored rather than reordered (IDOR).
            # Board row first, then the rows in pk order (#1632). Every
            # other writer of these rows (create, update, delete, and the
            # card or swimlane writes whose value rows take FOR KEY SHARE on
            # them at COMMIT) holds a conflicting lock on the board row
            # first, so they queue whole with this reorder instead of meeting
            # it row by row: bulk_update's UPDATE locks rows in scan order,
            # and a writer holding one definition while waiting on another
            # could otherwise close a cycle with it. FOR UPDATE because
            # position is part of a unique key, the lock the UPDATE takes.
            lock_board_row_or_404(board, no_key=True)
            count = board.swimlane_custom_field_definitions.count()
            rows = list(
                SwimlaneCustomFieldDefinition.objects.select_for_update()
                .filter(board=board, pk__in=order_ints)
                .order_by("pk")
                .only("id", "position")
            )
            by_id = {row.pk: row for row in rows}
            ordered = [by_id[fid] for fid in order_ints if fid in by_id]
            for i, row in enumerate(ordered):
                row.position = count + i
            SwimlaneCustomFieldDefinition.objects.bulk_update(ordered, ["position"])
            for i, row in enumerate(ordered):
                row.position = i
            SwimlaneCustomFieldDefinition.objects.bulk_update(ordered, ["position"])

            data = SwimlaneCustomFieldDefinitionSerializer(
                board.swimlane_custom_field_definitions.order_by("position", "id"),
                many=True,
            ).data
            _broadcast.record_board_event(
                board.id,
                _broadcast.EVT_SWIMLANE_CUSTOM_FIELD_REORDERED,
                {"swimlane_custom_fields": list(data)},
                actor_id=request.user.id,
            )
        return Response(data)
