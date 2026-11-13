"""SwimlaneViewSet — CRUD endpoints for swimlanes on a board."""

from django.db import IntegrityError, transaction
from django.db.models import Max
from rest_framework.generics import get_object_or_404
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
from ..models import Board, BoardMembership, Card, Column, Swimlane, SwimlaneCustomFieldDefinition
from ..permissions import SITE_ADMIN
from ..serializers import (
    SwimlaneSerializer, SwimlaneAdminSerializer, _swimlane_custom_field_prefetch,
    _PARKED_SWIMLANE_CUSTOM_FIELD_VALUES,
)
from ..services.custom_fields import apply_swimlane_custom_field_values
from ._helpers import (
    CONTAINER_CHANGED_409, blocked_peers_of, get_board_for_user, lock_board_and_row_or_404,
    lock_board_row_or_404, lock_container_cascade, missing_limit_columns, publish_blocked_peers,
    require_present_or_404,
    validate_full_reorder_order,
)


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


def _require_live_swimlane_definitions(field_pairs):
    """Answer 400 when a definition in ``field_pairs`` no longer exists.

    The swimlane create and update paths resolve ``custom_field_values``
    definitions at validation, before their transaction. Called once the
    board row is held: every swimlane definition delete takes the board row
    first (``lock_board_and_row_or_404``), so a definition read here stays
    until this transaction commits. A definition a delete already removed is
    reported exactly as the serializer reports an unknown definition, and
    nothing is written (#1602, #1632).
    """
    if not field_pairs:
        return
    wanted = {definition.pk for definition, _ in field_pairs}
    live = set(
        SwimlaneCustomFieldDefinition.objects.filter(pk__in=wanted).values_list(
            "pk", flat=True
        )
    )
    missing = sorted(wanted - live)
    if missing:
        raise ValidationError({
            "custom_field_values": [
                "Unknown swimlane custom field(s) for this board: "
                + ", ".join(str(pk) for pk in missing)
                + "."
            ]
        })


def _require_live_limit_columns(board, validated_data):
    """Answer 400 when a column named in ``limit_column_ids`` was deleted (#1150).

    The serializer resolved the ids before the transaction. Called once the
    board row is held: a column delete holds that row from the start of its
    cascade (``lock_container_cascade``), so a column read here stays until
    this save commits, and one a delete removed meanwhile is reported as the
    serializer reports an unknown id instead of being stored as a stale id the
    delete's cleanup (``prune_swimlane_limit_columns``) already ran past.
    """
    missing = missing_limit_columns(board.pk, validated_data.get("limit_column_ids"))
    if missing:
        raise ValidationError({
            "limit_column_ids": [
                "Unknown column(s) for this board: " + ", ".join(str(pk) for pk in missing) + "."
            ]
        })


# _set_collapsed_impl reads only is_collapsed (#1788); without this the schema
# documented the full swimlane body. Admin-only, so the response is always the
# admin serializer. Schema-only: no runtime effect.
#
# A factory, not one shared decorator, so the snake_case ``set_collapsed`` alias
# alone is marked ``deprecated`` in the schema (#1825): it is due for removal in
# 2.0 (#986 already sends the Deprecation header at runtime), while the
# canonical ``set-collapsed`` route is not deprecated.
def _set_collapsed_schema(**extra):
    return extend_schema(
        # A raw schema, not a serializer: spectacular turns every PATCH serializer
        # into an all-optional "Patched*" body, but the view answers 400 without
        # is_collapsed, so the body and field must be documented as required (the
        # body's own `required` flag is set by schema_hooks.require_declared_request_bodies).
        request={
            "application/json": {
                "type": "object",
                "properties": {
                    "is_collapsed": {
                        "type": "boolean",
                        "description": "The default collapsed state for every board member. Must be a boolean.",
                    },
                },
                "required": ["is_collapsed"],
            }
        },
        responses=SwimlaneAdminSerializer,
        **extra,
    )


_SET_COLLAPSED_SCHEMA = _set_collapsed_schema()
_SET_COLLAPSED_DEPRECATED_SCHEMA = _set_collapsed_schema(
    deprecated=True,
    description=(
        "Deprecated alias of `PATCH .../set-collapsed/`, removed in 2.0. Same body and "
        "responses. A successful (2xx) response also carries `Deprecation: true` and a "
        "`Link` header naming the canonical route; error responses do not."
    ),
)


@extend_schema_view(
    destroy=extend_schema(responses={204: None, 409: CONTAINER_CHANGED_409}),
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
        if getattr(self, "swagger_fake_view", False):
            # drf-spectacular has no request or board_pk (#1788). Without this
            # the lookup below raised KeyError and the schema lost every
            # swimlane request body. Writes are admin-only, so the admin
            # serializer is the one whose fields the write bodies document.
            return SwimlaneAdminSerializer
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
        if getattr(self, "swagger_fake_view", False):
            return ctx  # schema generation: no board_pk to resolve (#1788)
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
        if getattr(self, "swagger_fake_view", False):
            return Swimlane.objects.none()  # schema generation (#1788)
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
        try:
            # Lock the board row for the same reason as ColumnViewSet.perform_create —
            # concurrent swimlane creation could race on Max(position).
            with transaction.atomic():
                lock_board_row_or_404(board)
                # Re-read the definitions under the board row (#1632): they
                # were resolved before the lock, and a definition DELETE that
                # committed meanwhile otherwise failed the value rows' deferred
                # foreign key at COMMIT, which the IntegrityError handler
                # below misreported as a name collision. Every definition
                # delete takes the board row first, so none can commit after
                # this read.
                _require_live_swimlane_definitions(field_pairs)
                _require_live_limit_columns(board, serializer.validated_data)
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
        except IntegrityError:
            # Belt and braces for the race the serializer's validate() cannot fully
            # close (two concurrent creates can both pass validation before either
            # commits): the unique_together(board, name) constraint caught it, so
            # report it the way the serializer would have rather than as a 500.
            raise ValidationError(
                {"name": "A swimlane with this name already exists on this board."}
            ) from None

    def update(self, request, *args, **kwargs):
        """PUT/PATCH: the admin check runs before the body is validated (#2009).

        DRF validates the serializer before ``perform_update``, so a caller below
        admin sending an invalid body got a ``400`` instead of the ``403`` a valid
        one gets. The role is cached per request, so ``perform_update``'s own
        check costs nothing; an access-less caller still gets the ``404`` from
        ``_board_and_role``.
        """
        _, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        return super().update(request, *args, **kwargs)

    def perform_update(self, serializer):
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        field_pairs = serializer.validated_data.pop("custom_field_values", None)
        try:
            with transaction.atomic():
                # Board row, then the swimlane (#1602; see
                # lock_board_and_row_or_404).
                lock_board_and_row_or_404(board, Swimlane, serializer.instance.pk)
                # Reload under the lock (see ColumnViewSet.perform_update):
                # a rename queued behind a reorder must keep the new position.
                serializer.instance.refresh_from_db()
                # The definitions were resolved before the lock; one a
                # concurrent delete removed while this request queued answers
                # 400 and nothing is written.
                _require_live_swimlane_definitions(field_pairs)
                _require_live_limit_columns(board, serializer.validated_data)
                swimlane = serializer.save()
                if field_pairs:
                    apply_swimlane_custom_field_values(
                        swimlane=swimlane, pairs=field_pairs, actor=self.request.user
                    )
                    # get_queryset() prefetches custom_field_values with
                    # to_attr (#1223), and DRF's UpdateModelMixin.update()
                    # only resets the *standard* `_prefetched_objects_cache`
                    # after perform_update() returns — it knows nothing about
                    # a to_attr list, which would otherwise go on serving the
                    # pre-write values in this same request's response body
                    # (the deferred broadcast below is unaffected: it already
                    # re-fetches via _refetch_swimlane()).
                    swimlane.__dict__.pop(_PARKED_SWIMLANE_CUSTOM_FIELD_VALUES, None)
                # Same broadcast-safety constraint as perform_create.
                swimlane_data = SwimlaneSerializer(_refetch_swimlane(swimlane)).data
                board_id = swimlane.board_id
                _broadcast.record_board_event(board_id, _broadcast.EVT_SWIMLANE_UPDATED, swimlane_data, actor_id=self.request.user.id)
        except IntegrityError:
            # Same race as perform_create.
            raise ValidationError(
                {"name": "A swimlane with this name already exists on this board."}
            ) from None

    def perform_destroy(self, instance):
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        board_id = instance.board_id
        swimlane_uid = instance.uid
        with transaction.atomic():
            # Lock the swimlane's cards, then every column of the board,
            # before Django collects the cascade (#1599, #1602): a card child
            # write, or a card created or moved into the swimlane (through any
            # column), that commits mid-cascade otherwise fails this delete's
            # deferred FK check at COMMIT (500). See lock_cards_for_cascade.
            lock_container_cascade(
                instance.cards.all(),
                entry_columns=Column.objects.filter(board_id=instance.board_id),
                boards=Board.objects.filter(pk=instance.board_id),
            )
            # Queued behind a board delete or another delete of this
            # swimlane: answer 404 and emit nothing (see columns.py).
            require_present_or_404(
                Board.objects.filter(pk=instance.board_id),
                Swimlane.objects.filter(pk=instance.pk),
            )
            # Surviving cards the swimlane's cards blocked (#1634; see
            # columns.py): collected before the delete removes the relations.
            peers = blocked_peers_of(Card.objects.filter(swimlane_id=instance.pk))
            instance.delete()
            _broadcast.record_board_event(board_id, _broadcast.EVT_SWIMLANE_DELETED, {"swimlane_uid": swimlane_uid}, actor_id=self.request.user.id)
            publish_blocked_peers(peers, self.request, boards=[board])

    @_SET_COLLAPSED_SCHEMA
    @action(detail=True, methods=["patch"], url_path="set-collapsed")
    def set_collapsed_kebab(self, request, board_pk=None, pk=None):
        """Canonical kebab-case alias for the swimlane is_collapsed toggle (#816).

        All new callers should use ``PATCH /swimlanes/<pk>/set-collapsed/``.
        The snake_case route ``set_collapsed`` below is kept as a deprecated
        alias and scheduled for removal in 2.0; both routes share the exact
        same implementation.
        """
        return self._set_collapsed_impl(request, pk)

    @_SET_COLLAPSED_DEPRECATED_SCHEMA
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
        is_collapsed = require_json_object(request).get("is_collapsed")
        if not isinstance(is_collapsed, bool):
            raise ValidationError({"is_collapsed": "This field must be a boolean."})
        swimlane.is_collapsed = is_collapsed
        with transaction.atomic():
            # Board row, then the swimlane (#1602): queued behind a delete,
            # this answers 404 rather than a 500 from save(update_fields=...).
            lock_board_and_row_or_404(board, Swimlane, swimlane.pk)
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
        description=(
            "Admin only. Accepts this board's full set of swimlane IDs, with no "
            "duplicates, in the desired order, and returns the reordered list. "
            "`order` must be exactly this board's current swimlane IDs — a "
            "partial list, a duplicate, an ID from another board, or an empty "
            "list on a non-empty board is rejected with `400` (#1302, same rule "
            "as checklist-item reorder, #1292)."
        ),
        request=inline_serializer(
            name="SwimlaneReorder",
            fields={
                "order": serializers.ListField(
                    child=serializers.IntegerField(),
                    help_text="This board's swimlane IDs, all of them, no duplicates, in the desired display order.",
                ),
            },
        ),
        # Always the public serializer regardless of caller role — contact_email/notes
        # (admin-only fields) are never included in the reorder response or broadcast.
        responses=SwimlaneSerializer(many=True),
    )
    @action(detail=False, methods=["post"], pagination_class=None)
    def reorder(self, request, board_pk=None):
        """Reorder swimlanes by accepting the full list of swimlane IDs in the desired order (admin only)."""
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        order = require_json_object(request).get("order", [])
        with transaction.atomic():
            # Lock the board row before reading the current swimlane set and
            # updating positions, so a concurrent create/delete/reorder can't
            # slip in between the full-set check below and the position writes
            # it authorizes, and so two concurrent reorder requests can't
            # interleave their UPDATE statements into an inconsistent position
            # sequence (#1302).
            #
            # FOR NO KEY UPDATE, not FOR UPDATE (#1150), the column reorder's
            # mode (#1566): a move checked against a swimlane limit holds that
            # swimlane row (FOR NO KEY UPDATE) and then needs FOR KEY SHARE on
            # this board row for its CardMovement insert. FOR UPDATE here
            # would block that while this reorder waits on the swimlane row:
            # a deadlock. FOR NO KEY UPDATE still conflicts with every other
            # board-row writer and a second reorder.
            lock_board_row_or_404(board, no_key=True)
            existing_ids = set(Swimlane.objects.filter(board=board).values_list("id", flat=True))
            order_ints = validate_full_reorder_order(
                order, existing_ids, item_label="swimlane", scope_label="this board",
            )
            # bulk_update replaces N single-row UPDATEs with one query regardless of
            # swimlane count.  Swimlane has no unique_together on position so a single
            # pass is safe (contrast with ColumnViewSet.reorder which needs two passes).
            lanes = list(Swimlane.objects.filter(board=board, pk__in=order_ints).only("id", "position"))
            id_to_lane = {sl.pk: sl for sl in lanes}
            # The `if swimlane_id in id_to_lane` guard is belt-and-braces, not
            # load-bearing — see the matching comment in ColumnViewSet.reorder.
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
