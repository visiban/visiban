"""CustomFieldSetViewSet — per-board custom field set CRUD (#2570).

A field set is a display grouping of a board's card custom fields. Role
boundary, the same as the field schema (``custom_fields.py``):

* read (list / retrieve) — any role with access to the board. The card
  detail of every role renders the blocks.
* create / update / delete / reorder / copy — board admin or site admin. There
  is no separate "field-set manager" permission (architect review, 2026-11-24).

Every write takes the board row lock before counting or positioning, and
broadcasts through ``record_board_event`` (persisted, then sent in
``transaction.on_commit``), so a replaying client and a live one see the same
``field_set.*`` frames.
"""

from django.db import transaction
from django.db.models import Max
from rest_framework import serializers as drf_serializers, status, viewsets
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
from ..models import BoardMembership, CustomFieldDefinition, CustomFieldSet
from ..permissions import SITE_ADMIN
from ..serializers import (
    CustomFieldDefinitionSerializer,
    CustomFieldSetSerializer,
    assert_field_set_cap,
)
from ._helpers import get_board_for_user, lock_board_and_row_or_404, lock_board_row_or_404

#: The fields of a definition a copy carries. Everything that shapes how a
#: value is typed and displayed; never ``show_on_card`` (the pin cap is the
#: target board's choice) and never values.
_COPIED_DEFINITION_ATTRS = (
    "field_type", "choices_json", "is_required", "help_text", "number_prefix",
    "number_suffix", "number_decimals", "choice_colors", "threshold_direction",
    "threshold_warn", "threshold_alert", "threshold_warn_days", "threshold_alert_days",
    "is_dimension", "choice_resolutions",
)


def _unique_name(name, taken, suffix):
    """``name``, or ``name`` + suffix (+ a counter) when ``taken`` holds it.

    Truncates the base so the result fits the 100-character name column.
    """
    if name not in taken:
        return name
    for n in range(1, 1000):
        tail = suffix if n == 1 else f"{suffix[:-1]} {n})"
        candidate = f"{name[: 100 - len(tail)]}{tail}"
        if candidate not in taken:
            return candidate
    raise drf_serializers.ValidationError({"name": "Could not find a free name for the copy."})


def plan_field_set_copy(source_set, target_board):
    """Return the per-field copy plan for ``source_set`` onto ``target_board``.

    One entry per source field, in source field order: ``("reuse", local)`` when
    the target has an ungrouped field with the same name and type,
    ``("create", name)`` otherwise, where ``name`` is the source name or, when
    it is taken on the target, "{name} (copied)". The frontend preview applies
    the same three outcomes; the server is the one that decides.
    """
    local = {d.name: d for d in CustomFieldDefinition.objects.filter(board=target_board)}
    taken = set(local)
    plan = []
    for src in sorted(source_set.fields.all(), key=lambda f: (f.position, f.id)):
        match = local.get(src.name)
        if match is not None and match.field_type == src.field_type and match.field_set_id is None:
            plan.append(("reuse", src, match))
            continue
        name = _unique_name(src.name, taken, " (copied)")
        taken.add(name)
        plan.append(("create", src, name))
    return plan


class CustomFieldSetViewSet(viewsets.ModelViewSet):
    """CRUD for a board's custom field sets; writes require the admin role."""

    lookup_value_regex = r"\d+"
    permission_classes = [
        IsAuthenticated,
        MustNotHavePendingPasswordChange,
        MustNotHavePendingUsernameChange,
        TokenHasScope,
    ]
    serializer_class = CustomFieldSetSerializer
    pagination_class = None

    _cached_board_role = None

    def _board_and_role(self):
        if self._cached_board_role is None:
            self._cached_board_role = get_board_for_user(self.kwargs["board_pk"], self.request.user)
        return self._cached_board_role

    def _board(self):
        return self._board_and_role()[0]

    def _require_admin(self):
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        return board

    def get_queryset(self):
        # Board-scoped, so a set id from another board is a 404 here (IDOR).
        return CustomFieldSet.objects.filter(board=self._board()).prefetch_related("fields", "swimlanes")

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        ctx["board"] = self._board()
        return ctx

    def _payload(self, field_set):
        field_set = CustomFieldSet.objects.prefetch_related("fields", "swimlanes").get(pk=field_set.pk)
        return CustomFieldSetSerializer(field_set).data

    def _broadcast_affected(self, board_id, set_ids):
        """``field_set.updated`` for each other set a membership write took fields from."""
        for other in CustomFieldSet.objects.filter(board_id=board_id, pk__in=set_ids).prefetch_related(
            "fields", "swimlanes"
        ):
            _broadcast.record_board_event(
                board_id, _broadcast.EVT_FIELD_SET_UPDATED, CustomFieldSetSerializer(other).data,
                actor_id=self.request.user.id,
            )

    def create(self, request, *args, **kwargs):
        # Admin check before body validation, so a non-admin gets 403, not 400 (#2009).
        self._require_admin()
        return super().create(request, *args, **kwargs)

    def perform_create(self, serializer):
        board = self._require_admin()
        with transaction.atomic():
            lock_board_row_or_404(board)
            assert_field_set_cap(board)
            _max = board.custom_field_sets.aggregate(m=Max("position"))["m"]
            field_set = serializer.save(board=board, position=0 if _max is None else _max + 1)
            _broadcast.record_board_event(
                board.id, _broadcast.EVT_FIELD_SET_CREATED, self._payload(field_set),
                actor_id=self.request.user.id,
            )
            self._broadcast_affected(board.id, getattr(serializer, "affected_set_ids", ()))

    def update(self, request, *args, **kwargs):
        self._require_admin()
        return super().update(request, *args, **kwargs)

    def perform_update(self, serializer):
        board = self._require_admin()
        with transaction.atomic():
            # Board row, then the set row (#1602): an update queued behind a
            # delete answers 404 instead of resurrecting the set.
            lock_board_and_row_or_404(board, CustomFieldSet, serializer.instance.pk)
            serializer.instance.refresh_from_db()
            field_set = serializer.save()
            _broadcast.record_board_event(
                board.id, _broadcast.EVT_FIELD_SET_UPDATED, self._payload(field_set),
                actor_id=self.request.user.id,
            )
            self._broadcast_affected(board.id, getattr(serializer, "affected_set_ids", ()))

    def destroy(self, request, *args, **kwargs):
        self._require_admin()
        return super().destroy(request, *args, **kwargs)

    def perform_destroy(self, instance):
        board = self._require_admin()
        with transaction.atomic():
            lock_board_and_row_or_404(board, CustomFieldSet, instance.pk)
            field_ids = list(instance.fields.values_list("pk", flat=True))
            set_uid, set_id = instance.uid, instance.pk
            # SET_NULL ungroups the fields; their values are untouched.
            instance.delete()
            _broadcast.record_board_event(
                board.id, _broadcast.EVT_FIELD_SET_DELETED,
                {"field_set_uid": set_uid, "field_set_id": set_id, "field_ids": field_ids},
                actor_id=self.request.user.id,
            )

    @extend_schema(
        summary="Reorder field sets",
        description="Admin only. Accepts the board's field set ids in the desired order.",
        request=inline_serializer(
            name="FieldSetReorder",
            fields={"order": drf_serializers.ListField(child=drf_serializers.IntegerField())},
        ),
        responses=CustomFieldSetSerializer(many=True),
    )
    @action(detail=False, methods=["post"])
    def reorder(self, request, board_pk=None):
        board = self._require_admin()
        order = require_json_object(request).get("order", [])
        if not isinstance(order, list) or len(order) > CustomFieldSet.SET_CAP:
            raise drf_serializers.ValidationError({"order": "Expected a list of field set ids."})
        try:
            order_ints = [int(i) for i in order]
        except (TypeError, ValueError):
            raise drf_serializers.ValidationError({"order": "Every entry must be a field set id."}) from None
        if not all(id_in_db_range(i) for i in order_ints):
            raise drf_serializers.ValidationError({"order": "Every entry must be a field set id."})
        with transaction.atomic():
            lock_board_row_or_404(board)
            rows = {r.pk: r for r in CustomFieldSet.objects.filter(board=board, pk__in=order_ints)}
            ordered = [rows[i] for i in dict.fromkeys(order_ints) if i in rows]
            # Sets not listed keep their relative order after the listed ones.
            rest = list(CustomFieldSet.objects.filter(board=board).exclude(pk__in=rows).order_by("position", "pk"))
            for i, row in enumerate(ordered + rest):
                row.position = i
            CustomFieldSet.objects.bulk_update(ordered + rest, ["position"])
            data = CustomFieldSetSerializer(
                CustomFieldSet.objects.filter(board=board).prefetch_related("fields", "swimlanes"), many=True,
            ).data
            _broadcast.record_board_event(
                board.id, _broadcast.EVT_FIELD_SET_REORDERED, {"field_sets": list(data)},
                actor_id=request.user.id,
            )
        return Response(data)

    @extend_schema(
        summary="Copy a field set from another board",
        description=(
            "Admin only on this board; the caller must be able to read the source "
            "board. A one-time copy with no link: each source field reuses an "
            "ungrouped local field of the same name and type, or is created (as "
            "'{name} (copied)' when the name is taken). Values are never copied."
        ),
        request=inline_serializer(
            name="FieldSetCopy",
            fields={
                "source_board": drf_serializers.IntegerField(),
                "source_set": drf_serializers.IntegerField(),
                "name": drf_serializers.CharField(required=False, max_length=100),
            },
        ),
        responses={201: CustomFieldSetSerializer},
    )
    @action(detail=False, methods=["post"])
    def copy(self, request, board_pk=None):
        board = self._require_admin()
        body = require_json_object(request)
        try:
            source_board_id = int(body.get("source_board"))
            source_set_id = int(body.get("source_set"))
        except (TypeError, ValueError):
            raise drf_serializers.ValidationError(
                {"detail": "source_board and source_set must be ids."}
            ) from None
        if not (id_in_db_range(source_board_id) and id_in_db_range(source_set_id)):
            raise drf_serializers.ValidationError({"detail": "source_board and source_set must be ids."})
        # Object-level check: 404 for a board the caller cannot read, the same
        # answer as a board that does not exist.
        source_board, _role = get_board_for_user(source_board_id, request.user)
        source_set = (
            CustomFieldSet.objects.filter(board=source_board, pk=source_set_id)
            .prefetch_related("fields").first()
        )
        if source_set is None:
            return Response({"detail": "Field set not found."}, status=status.HTTP_404_NOT_FOUND)
        name = body.get("name") or source_set.name
        if not isinstance(name, str):
            raise drf_serializers.ValidationError({"name": "Must be a string."})

        with transaction.atomic():
            lock_board_row_or_404(board)
            assert_field_set_cap(board)
            plan = plan_field_set_copy(source_set, board)
            creates = [p for p in plan if p[0] == "create"]
            existing = CustomFieldDefinition.objects.filter(board=board).count()
            room = CustomFieldDefinition.MAX_PER_BOARD - existing
            if len(creates) > room:
                raise drf_serializers.ValidationError({"detail": (
                    f"Copying adds {len(creates)} fields; this board has room for {max(room, 0)}. "
                    "Delete fields or choose a smaller set."
                )})
            taken_sets = set(CustomFieldSet.objects.filter(board=board).values_list("name", flat=True))
            ser = CustomFieldSetSerializer(
                data={
                    "name": _unique_name(name.strip() or source_set.name, taken_sets, " (copy)"),
                    "description": source_set.description,
                    "default_size": source_set.default_size,
                    # Lanes are per board, so a copy always starts on every card.
                    "scope": CustomFieldSet.Scope.ALL,
                },
                context={"board": board},
            )
            ser.is_valid(raise_exception=True)
            _max = board.custom_field_sets.aggregate(m=Max("position"))["m"]
            field_set = ser.save(board=board, position=0 if _max is None else _max + 1)
            _fmax = board.custom_field_definitions.aggregate(m=Max("position"))["m"]
            next_pos = 0 if _fmax is None else _fmax + 1
            created = []
            for kind, src, target in plan:
                if kind == "reuse":
                    target.field_set = field_set
                    target.save(update_fields=["field_set"])
                    continue
                definition = CustomFieldDefinition.objects.create(
                    board=board, name=target, position=next_pos, field_set=field_set,
                    **{attr: getattr(src, attr) for attr in _COPIED_DEFINITION_ATTRS},
                )
                next_pos += 1
                created.append(definition)
            for definition in created:
                _broadcast.record_board_event(
                    board.id, _broadcast.EVT_CUSTOM_FIELD_CREATED,
                    CustomFieldDefinitionSerializer(definition).data, actor_id=request.user.id,
                )
            payload = self._payload(field_set)
            _broadcast.record_board_event(
                board.id, _broadcast.EVT_FIELD_SET_CREATED, payload, actor_id=request.user.id,
            )
        return Response(payload, status=status.HTTP_201_CREATED)
