"""LabelViewSet — CRUD endpoints for labels on a board."""

from django.db import IntegrityError, transaction
from rest_framework import viewsets
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated

from accounts.permissions import TokenHasScope
from visiban.permissions import (
    MustNotHavePendingPasswordChange,
    MustNotHavePendingUsernameChange,
)

from .. import broadcast as _broadcast
from ..models import BoardMembership, Label
from ..permissions import SITE_ADMIN
from ..serializers import LabelSerializer
from ._helpers import get_board_for_user


class LabelViewSet(viewsets.ModelViewSet):
    """CRUD endpoints for labels on a board; write operations require admin role."""

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
    serializer_class = LabelSerializer

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
        return Label.objects.filter(board=self._board())

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        # LabelSerializer.validate() needs the board to check unique_together(board,
        # name) — `board` is not a serializer field, so without this the serializer
        # skips the check and only the IntegrityError catch below fires.
        ctx["board"] = self._board()
        return ctx

    def perform_create(self, serializer):
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        try:
            with transaction.atomic():
                label = serializer.save(board=board)
                label_data = LabelSerializer(label).data
                board_id = board.id
                _broadcast.record_board_event(board_id, _broadcast.EVT_LABEL_CREATED, label_data, actor_id=self.request.user.id)
        except IntegrityError:
            # Belt and braces for the race the serializer's validate() cannot fully
            # close (two concurrent creates can both pass validation before either
            # commits): the unique_together(board, name) constraint caught it, so
            # report it the way the serializer would have rather than as a 500.
            raise ValidationError(
                {"name": "A label with this name already exists on this board."}
            ) from None

    def perform_update(self, serializer):
        _, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        try:
            with transaction.atomic():
                label = serializer.save()
                label_data = LabelSerializer(label).data
                board_id = label.board_id
                _broadcast.record_board_event(board_id, _broadcast.EVT_LABEL_UPDATED, label_data, actor_id=self.request.user.id)
        except IntegrityError:
            # Same race as perform_create.
            raise ValidationError(
                {"name": "A label with this name already exists on this board."}
            ) from None

    def perform_destroy(self, instance):
        _, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        board_id = instance.board_id
        label_uid = instance.uid
        with transaction.atomic():
            instance.delete()
            _broadcast.record_board_event(board_id, _broadcast.EVT_LABEL_DELETED, {"label_uid": label_uid}, actor_id=self.request.user.id)
