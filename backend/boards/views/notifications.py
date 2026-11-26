"""Notification views — list, mark-read, and unread-count endpoints."""

from django.db.models import BooleanField, Case, Q, Value, When
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
    # Since 1.3 (#2081): whether the recipient can still open the
    # notification's link. Read from the ``_target_available`` annotation that
    # ``NotificationListView`` computes in SQL with the board 404's own access
    # predicate (``board_access_q``), so it costs no per-row query. A board that
    # was deleted takes its notifications with it (``on_delete=CASCADE``), and a
    # board the recipient lost access to is answered the same way as one that
    # never existed, so the field cannot tell the two apart.
    target_available = serializers.SerializerMethodField()

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
            # Since 1.3 (#2203): "comment" or "description" on a mentioned
            # notification, null otherwise and on rows written before 1.3.
            "mention_source",
            "read",
            "created_at",
            "target_available",
        ]
        read_only_fields = fields

    def get_card_title(self, obj) -> str | None:
        return obj.card.title if obj.card_id else None

    def get_board_name(self, obj) -> str | None:
        return obj.board.name if obj.board_id else None

    def get_target_available(self, obj) -> bool:
        # Absent-input guard (#1075): a row serialized without the annotation
        # (any caller other than the list view) reports False, never True. Only
        # a computed True from the access predicate says the target is reachable.
        return getattr(obj, "_target_available", None) is True


def _target_available_q(user):
    """``Q`` over ``Notification``: rows whose target *user* can still open (#2081).

    The same rule as the board 404 (``get_board_for_user``): a row with no board
    links to the app itself and is always available; a row on a board is
    available when ``board_access_q`` matches it, or the user can access all
    content. Built once per request so the group walk inside ``board_access_q``
    runs once however many times the ``Q`` is reused.

    Absent-input guard (#1075): with no authenticated user there is no one to
    authorize against, so the ``Q`` matches nothing rather than everything.
    """
    if user is None or not getattr(user, "is_authenticated", False):
        return Q(pk__in=[])
    if user.can_access_all_content:
        return Q(pk__isnull=False)
    return Q(board__isnull=True) | Q(board__in=Board.objects.filter(board_access_q(user)))


def _mark_unavailable_targets_read(user, available_q):
    """Mark *user*'s unread notifications whose target is gone as read (#2081).

    Owner decision on #2081: a notification whose board the recipient can no
    longer open drops out of the bell by becoming read on the server, rather
    than staying unread forever behind the list filter. One ``UPDATE``, scoped
    to the requesting user's own rows (``recipient=user``), so it can never
    touch another user's notifications and adds a constant one query.

    Rows on a deleted board never reach this: ``Notification.board`` is
    ``on_delete=CASCADE``, so they are gone, and the response for a deleted
    board and for revoked access is the same (the row is simply absent).
    Returns the number of rows marked read; 0 when there is no user (#1075).
    """
    if user is None or not getattr(user, "is_authenticated", False):
        return 0
    return (
        Notification.objects.filter(recipient=user, read=False)
        .exclude(available_q)
        .update(read=True)
    )


def _accessible_unread_notifications(user, available_q=None):
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
    if available_q is None:
        available_q = _target_available_q(user)
    return Notification.objects.filter(available_q, recipient=user, read=False)


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
        user = request.user
        available_q = _target_available_q(user)
        # Marked before the select (#2081), so the rows it marks never take a
        # place in the [:50] window. The select still filters on the same
        # predicate: a board the user loses access to between the two queries
        # is dropped, never serialized with its board_name / card_title (#987).
        _mark_unavailable_targets_read(user, available_q)
        notifications = list(
            _accessible_unread_notifications(user, available_q)
            .annotate(
                _target_available=Case(
                    When(available_q, then=Value(True)),
                    default=Value(False),
                    output_field=BooleanField(),
                )
            )
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

    # Declared (#1793): a hand-built body published as a bodiless 200.
    @extend_schema(
        responses={200: inline_serializer(name="NotificationUnreadCount", fields={"count": serializers.IntegerField()})},
    )
    def get(self, request):
        # Filter to currently-accessible boards so the count stays in sync
        # with the list endpoint (#987) -- otherwise the bell would show a
        # number the user can never reach by opening the dropdown. Counted in
        # SQL, uncapped, as documented (#1959).
        count = _accessible_unread_notifications(request.user).count()
        return Response({"count": count})
