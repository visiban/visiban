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
from ._helpers import (
    get_board_for_user,
    lock_board_and_row_or_404,
    lock_board_row_or_404,
)


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
            with transaction.atomic():
                # Board row first (#1602): a label committed between a board
                # delete's cascade read and its DELETE fails the delete's
                # deferred FK check at COMMIT, and one created after it
                # reported "name already exists". Queued behind the delete it
                # now answers 404.
                lock_board_row_or_404(board, no_key=True)
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
        try:
            with transaction.atomic():
                # Board row, then the label row (#1602): a PATCH queued behind
                # a DELETE of the same label UPDATEd 0 rows and fell back to an
                # INSERT under the same pk, resurrecting it without its card
                # associations; behind a board delete the INSERT's board FK
                # failure was reported as a misleading 400. Now both are 404.
                lock_board_and_row_or_404(board, Label, serializer.instance.pk)
                # Reload under the lock: save() writes every column and the
                # instance predates the lock.
                serializer.instance.refresh_from_db()
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
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        board_id = instance.board_id
        label_uid = instance.uid
        with transaction.atomic():
            # Same order as perform_update (#1602): a second delete, or a
            # delete after an update, serializes and answers 404.
            lock_board_and_row_or_404(board, Label, instance.pk)
            instance.delete()
            _broadcast.record_board_event(board_id, _broadcast.EVT_LABEL_DELETED, {"label_uid": label_uid}, actor_id=self.request.user.id)
