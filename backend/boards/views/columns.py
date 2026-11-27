"""ColumnViewSet — CRUD endpoints for columns on a board."""

from django.db import IntegrityError, transaction
from django.db.models import Max, prefetch_related_objects
from rest_framework import serializers, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from drf_spectacular.utils import extend_schema, extend_schema_view, inline_serializer

from accounts.permissions import TokenHasScope
from visiban.permissions import (
    MustNotHavePendingPasswordChange,
    MustNotHavePendingUsernameChange,
)
from visiban.request_shape import require_json_object

from .. import broadcast as _broadcast
from ..models import Board, BoardMembership, Card, Column
from ..permissions import SITE_ADMIN
from ..serializers import ColumnSerializer, entry_requirements_prefetch as _entry_requirements_prefetch
from ..services.card_links import (
    announce_cards_removal, announce_column_rollup_changed, column_rollup_state,
)
from ._helpers import (
    CONTAINER_CHANGED_409, blocked_peers_of, get_board_for_user, lock_board_and_row_or_404,
    lock_board_row_or_404, lock_container_cascade, publish_blocked_peers,
    require_present_or_404,
    validate_full_reorder_order,
)


@extend_schema_view(
    destroy=extend_schema(responses={204: None, 409: CONTAINER_CHANGED_409}),
)
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
        # sub_columns / tracks (#1102, #1921) are nested on ColumnSerializer.
        return Column.objects.filter(board=self._board()).prefetch_related(
            "sub_columns", "stage_tracks__field_definition", _entry_requirements_prefetch(),
        )

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        # ColumnSerializer.validate() needs the board to check unique_together(board,
        # name)/(board, position) — `board` is not a serializer field, so without this
        # the serializer skips the check and only the IntegrityError catch below fires.
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
        _, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        return super().create(request, *args, **kwargs)

    def perform_create(self, serializer):
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        try:
            # Lock the board row before computing the next position to prevent a race
            # condition where two concurrent requests both read the same Max(position) and
            # attempt to insert two columns with the same value, violating unique_together.
            with transaction.atomic():
                lock_board_row_or_404(board)
                _max = board.columns.aggregate(m=Max("position"))["m"]
                max_pos = 0 if _max is None else _max + 1
                column = serializer.save(board=board, position=max_pos)
                prefetch_related_objects([column], "sub_columns", "stage_tracks__field_definition", _entry_requirements_prefetch())
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

    def update(self, request, *args, **kwargs):
        """PUT/PATCH: the admin check runs before the body is validated (#2009).

        DRF validates the serializer before ``perform_update``, so a caller below
        admin sending an invalid body got a ``400`` instead of the ``403`` a valid
        one gets; ``CardViewSet.update`` already checks first. The role is cached
        per request, so ``perform_update``'s own check below costs nothing.
        """
        _, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        return super().update(request, *args, **kwargs)

    def perform_update(self, serializer):
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        try:
            with transaction.atomic():
                # Board row, then the column (#1602; see
                # lock_board_and_row_or_404): a PATCH queued behind a delete
                # answers 404 instead of save() re-inserting the column.
                lock_board_and_row_or_404(board, Column, serializer.instance.pk)
                # Reload under the lock: save() writes every column, and the
                # instance predates the lock, so a rename that queued behind
                # a reorder would write the old position back.
                serializer.instance.refresh_from_db()
                old_name = serializer.instance.name
                # is_done buckets a child in its parent's rollup (#2500), so
                # snapshot only when the body writes it; a rename or color edit
                # costs nothing extra. (Position is rejected here: reorder.)
                rollup_before = (
                    column_rollup_state(board) if "is_done" in serializer.validated_data else None
                )
                column = serializer.save()
                # One bounded, ids-only ping per parent board, on commit, and
                # only when a child's bucket actually changed (#2500).
                announce_column_rollup_changed(board, rollup_before, actor_id=self.request.user.id)
                # A parent's column name shows on each child (#2416): one
                # coalesced, ids-only ping per child board, on commit.
                if column.name != old_name:
                    from ..services.card_links import announce_parent_container_renamed
                    announce_parent_container_renamed(
                        board, column_id=column.pk, actor_id=self.request.user.id,
                    )
                prefetch_related_objects([column], "sub_columns", "stage_tracks__field_definition", _entry_requirements_prefetch())
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
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        board_id = instance.board_id
        column_uid = instance.uid
        with transaction.atomic():
            # Lock the column's cards, then the column row itself, before
            # Django collects the cascade (#1599, #1602): a card child write,
            # or a card created or moved into the column, that commits
            # mid-cascade otherwise fails this delete's deferred FK check at
            # COMMIT (500). See lock_cards_for_cascade for the lock order.
            lock_container_cascade(
                instance.cards.all(),
                entry_columns=Column.objects.filter(pk=instance.pk),
                boards=Board.objects.filter(pk=instance.board_id),
            )
            # Queued behind a board delete or another delete of this column:
            # nothing is left to delete, so answer 404 and emit nothing.
            require_present_or_404(
                Board.objects.filter(pk=instance.board_id),
                Column.objects.filter(pk=instance.pk),
            )
            # Cards outside the column that its cards were blocking keep a
            # stale blocker_count unless told (#1634). Collected under the
            # cascade locks and before the delete, which removes the relations.
            peers = blocked_peers_of(Card.objects.filter(column_id=instance.pk))
            # Parent/child links CASCADE too (#1104): record the unlink on each
            # surviving peer and ping its board, while the link rows still exist.
            announce_cards_removal(Card.objects.filter(column_id=instance.pk), actor=self.request.user)
            # Deleting the first column promotes the next one, and its live
            # children re-bucket into "to do" with no card write to ping on
            # (#2500). Snapshot under the locks, diff after the delete.
            rollup_before = column_rollup_state(board)
            # Planned children needed at this column become "Needed: Now"
            # (#2371): the history note, before SET_NULL clears the field.
            from ..services.planned_children import clear_for_deleted_column
            clear_for_deleted_column(instance, actor=self.request.user)
            instance.delete()
            announce_column_rollup_changed(board, rollup_before, actor_id=self.request.user.id)
            _broadcast.record_board_event(board_id, _broadcast.EVT_COLUMN_DELETED, {"column_uid": column_uid}, actor_id=self.request.user.id)
            publish_blocked_peers(peers, self.request, boards=[board])

    @extend_schema(
        summary="Save a column's stage settings (sub-columns, tracks, lane exceptions)",
        description=(
            "Gated stages (#1102) and stage tracks (#1921). Board admins only. Every key "
            "is optional; an omitted key is left unchanged. `sub_columns` is the ordered "
            "list (`[]` or at least two, at most 4); an entry with an `id` keeps and may "
            "rename that sub-column, one without is new, and the list order is the new "
            "order: kept sub-columns may be reordered (not in the same request that removes "
            "one: that is a 400, 'Reorder and remove sub-columns in separate saves'), "
            "and a card follows its own "
            "sub-column to its new index without a gate transition. Removing a sub-column moves each card past it back one, recording "
            "a `stage_edited` gate transition; the response's `remapped` lists them. "
            "`tracks` is the ordered list of dimension field ids; removing one unbinds it "
            "only. `not_applicable` replaces the lane exceptions for this stage's tracks."
        ),
        request=inline_serializer(
            name="ColumnStage",
            fields={
                "sub_columns": serializers.ListField(
                    child=inline_serializer(
                        name="ColumnStageSubColumn",
                        fields={
                            "id": serializers.IntegerField(required=False),
                            "name": serializers.CharField(max_length=100),
                        },
                    ),
                    required=False,
                ),
                "tracks": serializers.ListField(child=serializers.IntegerField(), required=False),
                "not_applicable": serializers.ListField(
                    child=inline_serializer(
                        name="ColumnStageNotApplicable",
                        fields={
                            "swimlane_id": serializers.IntegerField(),
                            "field_id": serializers.IntegerField(),
                        },
                    ),
                    required=False,
                ),
            },
        ),
        responses={200: inline_serializer(
            name="ColumnStageResponse",
            fields={
                "column": ColumnSerializer(),
                "remapped": serializers.ListField(child=inline_serializer(
                    name="ColumnStageRemapped",
                    fields={
                        "id": serializers.IntegerField(),
                        "gates_passed": serializers.IntegerField(),
                        "version": serializers.IntegerField(),
                    },
                )),
            },
        )},
    )
    @action(detail=True, methods=["put"], pagination_class=None)
    def stage(self, request, board_pk=None, pk=None):
        """Save sub-columns, tracks and lane exceptions in one transaction.

        A dedicated action rather than nested writes on ColumnSerializer, so a
        column PATCH keeps its 1.x shape. The lock order (cards, then the
        column) is the move contract; see ``boards.services.stages``.
        """
        from ..services import stages as stage_services
        from ..services.errors import CardServiceError

        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        data = require_json_object(request)
        try:
            column, remapped, _lanes = stage_services.save_stage(
                actor=request.user, board=board, column_id=pk, data=data,
            )
        except stage_services.StageValidationError as exc:
            raise ValidationError(exc.errors) from None
        except CardServiceError as exc:
            return Response(exc.body(), status=exc.status)
        fresh = Column.objects.prefetch_related(
            "sub_columns", "stage_tracks__field_definition", _entry_requirements_prefetch(),
        ).get(pk=column.pk)
        return Response({"column": ColumnSerializer(fresh).data, "remapped": remapped})

    @extend_schema(
        summary="Replace a column's entry requirements",
        description=(
            "Board admins only (#1923). Replace-all: the body's `requirements` "
            "list becomes the column's whole list (at most 10), in order. "
            "`entry_enforcement` (`warn`, `block`, `hard` or null) is optional: "
            "a column's first requirements start in `warn`, and null keeps the "
            "rows but stops evaluating them. Emits `column.updated`."
        ),
        request=inline_serializer(
            name="ColumnEntryRequirementsWrite",
            fields={
                "entry_enforcement": serializers.ChoiceField(
                    choices=["warn", "block", "hard"], allow_null=True, required=False,
                ),
                "requirements": serializers.ListField(child=inline_serializer(
                    name="ColumnEntryRequirementWrite",
                    fields={
                        "field_uid": serializers.CharField(required=False),
                        "field_set_uid": serializers.CharField(required=False),
                        "operator": serializers.ChoiceField(choices=[
                            "filled", "min_count", "gt", "gte", "satisfied", "set_complete",
                        ]),
                        "operand": serializers.CharField(required=False, allow_null=True),
                    },
                )),
            },
        ),
        responses={200: ColumnSerializer},
    )
    @action(
        detail=True, methods=["put"], url_path="entry-requirements", pagination_class=None,
    )
    def entry_requirements(self, request, board_pk=None, pk=None):
        """Replace a column's entry requirements and mode (#1923).

        A dedicated action, like ``stage``, so a column PATCH keeps its 1.x
        shape and the settings editor has its own save. Board, then column
        lock (``lock_board_and_row_or_404``): the 10-row cap is a count over
        the column's rows, and a move evaluating them locks the same column.
        """
        from ..services import entry_requirements as entry_services

        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        data = require_json_object(request)
        with transaction.atomic():
            lock_board_and_row_or_404(board, Column, pk)
            column = Column.objects.get(pk=pk, board=board)
            try:
                entry_services.save_requirements(board=board, column=column, data=data)
            except entry_services.EntryRequirementsInvalid as exc:
                raise ValidationError(exc.errors) from None
            fresh = Column.objects.prefetch_related(
                "sub_columns", "stage_tracks__field_definition", _entry_requirements_prefetch(),
            ).get(pk=column.pk)
            column_data = ColumnSerializer(fresh).data
            # Same frame as a stage save, so the socket handler needs no new
            # branch; record_board_event defers the send to on_commit.
            _broadcast.record_board_event(
                board.id, _broadcast.EVT_COLUMN_UPDATED, {**column_data, "remapped": []},
                actor_id=request.user.id,
            )
        return Response(column_data)

    @extend_schema(
        summary="Count the cards in each sub-column of a stage",
        description=(
            "Board admins only (#2368). For the Stage settings \"N cards will move\" "
            "summary: one entry per sub-column, in order, with its active `cards` and "
            "its `archived_cards`. Archived cards keep their sub-column and are "
            "remapped by a stage save too. A card past the last sub-column counts "
            "in the last one. A plain column returns `[]`."
        ),
        responses={200: inline_serializer(
            name="ColumnStageCardCounts",
            fields={
                "sub_columns": serializers.ListField(child=inline_serializer(
                    name="ColumnStageCardCount",
                    fields={
                        "id": serializers.IntegerField(),
                        "cards": serializers.IntegerField(),
                        "archived_cards": serializers.IntegerField(),
                    },
                )),
            },
        )},
    )
    @action(detail=True, methods=["get"], url_path="stage-card-counts", pagination_class=None)
    def stage_card_counts(self, request, board_pk=None, pk=None):
        """Per-sub-column card counts, archived included, for the save preview."""
        from ..services import stages as stage_services
        from ..services.errors import CardServiceError

        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        try:
            counts = stage_services.stage_card_counts(board=board, column_id=pk)
        except CardServiceError as exc:
            return Response(exc.body(), status=exc.status)
        return Response({"sub_columns": counts})

    @extend_schema(
        summary="Reorder columns",
        description=(
            "Admin only. Accepts this board's full set of column IDs, with no "
            "duplicates, in the desired order, and returns the reordered list. "
            "`order` must be exactly this board's current column IDs — a partial "
            "list, a duplicate, an ID from another board, or an empty list on a "
            "non-empty board is rejected with `400` (#1302, same rule as "
            "checklist-item reorder, #1292). Since 1.3 (#2553) it also releases planned "
            "children whose Needed column now sits at or before the parent's current column, "
            "and sends `card.parent_changed` to the affected child boards."
        ),
        request=inline_serializer(
            name="ColumnReorder",
            fields={
                "order": serializers.ListField(
                    child=serializers.IntegerField(),
                    help_text="This board's column IDs, all of them, no duplicates, in the desired display order.",
                ),
            },
        ),
        responses=ColumnSerializer(many=True),
    )
    @action(detail=False, methods=["post"], pagination_class=None)
    def reorder(self, request, board_pk=None):
        """Reorder columns by accepting the full list of column IDs in the desired order (admin only)."""
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        order = require_json_object(request).get("order", [])  # list of column IDs in new order
        with transaction.atomic():
            # Lock the board row before reading the current column set, same as
            # perform_create/perform_update, so a concurrent create/delete can't
            # slip in between the full-set check below and the position writes
            # it authorizes (#1302).
            #
            # FOR NO KEY UPDATE, not FOR UPDATE (#1566): this request goes on to
            # wait for column row locks, and a card insert (create_card, the
            # admin card form) holds its column lock and needs FOR KEY SHARE on
            # this board row at commit for its foreign key. FOR UPDATE blocks
            # that key-share, so the two wait on each other and PostgreSQL
            # aborts one with a deadlock (500). FOR NO KEY UPDATE does not block
            # key-share but still conflicts with FOR UPDATE and FOR NO KEY
            # UPDATE, which is every other board-row lock (column/swimlane/
            # custom-field create, invite caps) and a second reorder, so the
            # serialization #1302 needs is unchanged.
            lock_board_row_or_404(board, no_key=True)
            existing_ids = set(Column.objects.filter(board=board).values_list("id", flat=True))
            # A reorder can change which column is first, the "to do" bucket
            # of a child's parent rollup (#2500): snapshot under the lock.
            rollup_before = column_rollup_state(board)
            order_ints = validate_full_reorder_order(
                order, existing_ids, item_label="column", scope_label="this board",
            )
            # Two-pass bulk_update to avoid unique_together(board, position) violations.
            # First pass: shift all positions to high values so no two columns share a
            # position mid-update.  Second pass: assign final positions.
            # Using bulk_update reduces 2N single-row UPDATEs to 2 queries regardless
            # of column count. `count` is len(order_ints), not a separate query — the
            # full-set check above already guarantees it equals the board's column count.
            count = len(order_ints)
            # Lock every column row in pk order before the position writes
            # (#1522). bulk_update locks rows in whatever order its UPDATE scans
            # them; a card move locks its source and target columns in pk order
            # (boards.services.cards._lock_move_columns), and the two orders
            # must agree or a reorder racing a move deadlocks.
            cols = list(
                Column.objects.filter(board=board, pk__in=order_ints)
                .order_by("pk")
                .select_for_update()
                .only("id", "position")
            )
            id_to_col = {c.pk: c for c in cols}
            # The `if col_id in id_to_col` guards below are belt-and-braces, not load-
            # bearing: validate_full_reorder_order already guarantees order_ints is
            # exactly this board's column IDs. They only matter if a column is deleted
            # in the narrow window between the read above and this write (the board
            # lock closes that window for another *reorder* request, not for every
            # possible concurrent write) — cheap insurance against a KeyError/500 in
            # that edge case rather than a case this branch expects to hit.
            for i, col_id in enumerate(order_ints):
                if col_id in id_to_col:
                    id_to_col[col_id].position = count + i
            Column.objects.bulk_update([id_to_col[cid] for cid in order_ints if cid in id_to_col], ["position"])
            for pos, col_id in enumerate(order_ints):
                if col_id in id_to_col:
                    id_to_col[col_id].position = pos
            Column.objects.bulk_update([id_to_col[cid] for cid in order_ints if cid in id_to_col], ["position"])
            cols_data = ColumnSerializer(
                board.columns.order_by("position").prefetch_related("sub_columns", "stage_tracks__field_definition", _entry_requirements_prefetch()),
                many=True,
            ).data
            board_id = board.id
            _broadcast.record_board_event(
                board_id, _broadcast.EVT_COLUMN_REORDERED, {"columns": list(cols_data)},
                actor_id=request.user.id,
            )
            announce_column_rollup_changed(board, rollup_before, actor_id=request.user.id)
            # Planned children whose Needed column is now at or before the
            # parent's (#2553): released like a parent move would.
            from ..services.planned_children import release_on_reorder
            release_on_reorder(board, actor=request.user)
        return Response(cols_data)
