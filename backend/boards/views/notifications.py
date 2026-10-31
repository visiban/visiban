"""Notification views — list, mark-read, and unread-count endpoints."""

from django.db.models import Q
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.serializers import BoardUserSerializer
from accounts.permissions import TokenHasScope
from visiban.permissions import (
    MustNotHavePendingPasswordChange,
    MustNotHavePendingUsernameChange,
)
from visiban.request_shape import coerce_int_id, require_json_object

from ..models import Board, Notification
from ._helpers import board_access_q


class NotificationSerializer(serializers.ModelSerializer):
    """Serializes a Notification for the current user's inbox.

    card_title and board_name are sourced from select_related relations rather
    than nested serializers so this stays a single flat response object — the
    frontend notification dropdown has no need for full Card or Board objects.

    ``actor`` is exposed as a slim ``BoardUser`` object (#1007) so clients can
    render avatars and group notifications by author without re-parsing the
    human-readable ``verb`` string. The slim shape carries
    ``id, username, display_name, avatar_url`` only — no email or other PII.
    """

    # allow_null=True (#1209): a notification with no card/board (e.g. a
    # board_invite notification) has no `card`/`board` to traverse, so DRF's
    # dotted-source lookup catches the AttributeError and falls back to
    # `default=None` — this already serializes as null today. Declaring
    # `allow_null=True` here is schema-only: it makes the published OpenAPI
    # schema (only reachable now that NotificationListView has response
    # wiring) match the response DRF was already producing. Same
    # declared-vs-actual gap as #1192; surfaced by regression-check while
    # auditing #1209's schema wiring.
    # SerializerMethodFields, not dotted-source CharFields with default=None
    # (#1226): DRF's get_default() raises SkipField under partial=True, which
    # would silently drop these keys (same mechanism as #1166/#1225). Dormant
    # today — this serializer is only bound read-only.
    card_title = serializers.SerializerMethodField(allow_null=True)
    board_name = serializers.SerializerMethodField(allow_null=True)
    # allow_null=True (#1192): actor is a SET_NULL FK with null=True — a
    # system-generated notification (e.g. stale-card alerts) has no human
    # actor and serializes with `actor: null`. Same declared-nested-field gap
    # as CardCommentSerializer.author (#1139); found during the #1192 sweep,
    # outside the originally reported four sites.
    actor = BoardUserSerializer(read_only=True, allow_null=True)

    class Meta:
        model = Notification
        fields = [
            "id",
            "verb",
            "actor",
            "card_id",
            "card_title",
            "board_id",
            "board_name",
            "action_type",
            "read",
            "created_at",
        ]
        read_only_fields = fields

    def get_card_title(self, obj) -> str | None:
        return obj.card.title if obj.card_id else None

    def get_board_name(self, obj) -> str | None:
        return obj.board.name if obj.board_id else None


def _accessible_unread_notifications(user):
    """Unread notifications for *user*, limited to boards they can still access (#987, #1959).

    Notifications retain ``card_title`` / ``board_name`` for boards the user
    was a member of when the notification was created.  If the user is later
    removed from the board (and from any group that grants inherited access),
    those fields would continue to surface board content the user has lost
    access to, so rows on such boards are dropped.  Rows with no board always
    pass.

    The access rule is applied in SQL via ``board_access_q`` -- the predicate
    that mirrors ``get_board_role()`` -- rather than resolving a role per board
    in Python.  That keeps the query count constant however many boards the
    notifications span (the old per-board loop was an N+1 on a path the bell
    badge polls on every page load), and, because the filter runs *before* any
    ``[:50]`` slice, inaccessible rows can no longer crowd accessible ones out
    of the window or hide them from the count.
    """
    qs = Notification.objects.filter(recipient=user, read=False)
    if user.can_access_all_content:
        return qs
    return qs.filter(
        Q(board__isnull=True) | Q(board__in=Board.objects.filter(board_access_q(user)))
    )


class NotificationListView(APIView):
    """GET /api/notifications/ — last 50 notifications for current user"""

    permission_classes = [
        IsAuthenticated,
        MustNotHavePendingPasswordChange,
        MustNotHavePendingUsernameChange,
        TokenHasScope,
    ]

    @extend_schema(
        summary="List the current user's unread notifications",
        responses=NotificationSerializer(many=True),
    )
    def get(self, request):
        notifications = list(
            _accessible_unread_notifications(request.user)
            .select_related("card", "board", "actor")[:50]
        )
        return Response(NotificationSerializer(notifications, many=True).data)


class NotificationMarkReadView(APIView):
    """POST /api/notifications/mark-read/"""

    permission_classes = [
        IsAuthenticated,
        MustNotHavePendingPasswordChange,
        MustNotHavePendingUsernameChange,
        TokenHasScope,
    ]

    # Schema only (#1783): the body and the response were undocumented. Both
    # keys are optional; an empty object marks nothing.
    @extend_schema(
        request=inline_serializer(
            name="NotificationMarkRead",
            fields={
                "all": serializers.BooleanField(
                    required=False, help_text="When true, marks every unread notification read; `ids` is ignored.",
                ),
                "ids": serializers.ListField(
                    child=serializers.IntegerField(), required=False,
                    help_text="Ids of the requesting user's notifications to mark read.",
                ),
            },
        ),
        responses={200: inline_serializer(name="NotificationMarkReadResponse", fields={"ok": serializers.BooleanField()})},
    )
    def post(self, request):
        body = require_json_object(request)
        if body.get("all"):
            Notification.objects.filter(recipient=request.user, read=False).update(read=True)
        else:
            ids = body.get("ids", [])
            if not isinstance(ids, list):
                raise ValidationError({"ids": "ids must be a list of integer notification IDs."})
            ids = [coerce_int_id(i, "ids") for i in ids]
            Notification.objects.filter(recipient=request.user, id__in=ids).update(read=True)
        return Response({"ok": True})


class NotificationUnreadCountView(APIView):
    """GET /api/notifications/unread-count/"""

    permission_classes = [
        IsAuthenticated,
        MustNotHavePendingPasswordChange,
        MustNotHavePendingUsernameChange,
        TokenHasScope,
    ]

    def get(self, request):
        # Filter to currently-accessible boards so the count stays in sync
        # with the list endpoint (#987) -- otherwise the bell would show a
        # number the user can never reach by opening the dropdown. Counted in
        # SQL, uncapped, as documented (#1959).
        count = _accessible_unread_notifications(request.user).count()
        return Response({"count": count})
