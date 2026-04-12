"""Notification views — list, mark-read, and unread-count endpoints."""

from rest_framework import serializers
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from visiban.permissions import (
    MustNotHavePendingPasswordChange,
    MustNotHavePendingUsernameChange,
)
from ..models import Notification


class NotificationSerializer(serializers.ModelSerializer):
    """Serializes a Notification for the current user's inbox.

    card_title and board_name are sourced from select_related relations rather
    than nested serializers so this stays a single flat response object — the
    frontend notification dropdown has no need for full Card or Board objects.
    """

    card_title = serializers.CharField(source="card.title", default=None, read_only=True)
    board_name = serializers.CharField(source="board.name", default=None, read_only=True)

    class Meta:
        model = Notification
        fields = [
            "id",
            "verb",
            "card_id",
            "card_title",
            "board_id",
            "board_name",
            "action_type",
            "read",
            "created_at",
        ]
        read_only_fields = fields


class NotificationListView(APIView):
    """GET /api/notifications/ — last 50 notifications for current user"""

    permission_classes = [
        IsAuthenticated,
        MustNotHavePendingPasswordChange,
        MustNotHavePendingUsernameChange,
    ]

    def get(self, request):
        qs = Notification.objects.filter(recipient=request.user, read=False).select_related("card", "board")[:50]
        return Response(NotificationSerializer(qs, many=True).data)


class NotificationMarkReadView(APIView):
    """POST /api/notifications/mark-read/"""

    permission_classes = [
        IsAuthenticated,
        MustNotHavePendingPasswordChange,
        MustNotHavePendingUsernameChange,
    ]

    def post(self, request):
        if request.data.get("all"):
            Notification.objects.filter(recipient=request.user, read=False).update(read=True)
        else:
            ids = request.data.get("ids", [])
            Notification.objects.filter(recipient=request.user, id__in=ids).update(read=True)
        return Response({"ok": True})


class NotificationUnreadCountView(APIView):
    """GET /api/notifications/unread-count/"""

    permission_classes = [
        IsAuthenticated,
        MustNotHavePendingPasswordChange,
        MustNotHavePendingUsernameChange,
    ]

    def get(self, request):
        count = Notification.objects.filter(recipient=request.user, read=False).count()
        return Response({"count": count})
