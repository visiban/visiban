"""LabelViewSet — CRUD endpoints for labels on a board."""

from django.db import transaction
from rest_framework import viewsets
from rest_framework.exceptions import PermissionDenied

from .. import broadcast as _broadcast
from ..models import BoardMembership, Label
from ..permissions import SITE_ADMIN
from ..serializers import LabelSerializer
from ._helpers import get_board_for_user


class LabelViewSet(viewsets.ModelViewSet):
    """CRUD endpoints for labels on a board; write operations require admin role."""

    serializer_class = LabelSerializer

    def _board_and_role(self):
        return get_board_for_user(self.kwargs["board_pk"], self.request.user)

    def _board(self):
        return self._board_and_role()[0]

    def get_queryset(self):
        return Label.objects.filter(board=self._board())

    def perform_create(self, serializer):
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        label = serializer.save(board=board)
        label_data = LabelSerializer(label).data
        board_id = board.id
        transaction.on_commit(lambda: _broadcast.broadcast_board_event(board_id, "label.created", label_data))

    def perform_update(self, serializer):
        _, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        label = serializer.save()
        label_data = LabelSerializer(label).data
        board_id = label.board_id
        transaction.on_commit(lambda: _broadcast.broadcast_board_event(board_id, "label.updated", label_data))

    def perform_destroy(self, instance):
        _, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        board_id = instance.board_id
        label_id = instance.id
        instance.delete()
        transaction.on_commit(lambda: _broadcast.broadcast_board_event(board_id, "label.deleted", {"label_id": label_id}))
