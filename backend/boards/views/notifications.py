"""Notification views — list, mark-read, and unread-count endpoints."""

from rest_framework import serializers
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.serializers import BoardUserSerializer
from visiban.permissions import (
    MustNotHavePendingPasswordChange,
    MustNotHavePendingUsernameChange,
)
from ..models import Notification
from ..permissions import get_board_role


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

    card_title = serializers.CharField(source="card.title", default=None, read_only=True)
    board_name = serializers.CharField(source="board.name", default=None, read_only=True)
    actor = BoardUserSerializer(read_only=True)

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


def _filter_to_accessible_boards(notifications, user):
    """Filter out notifications whose ``board`` the user no longer has access to (#987).

    Notifications retain ``card_title`` / ``board_name`` for boards the user
    was a member of when the notification was created.  If the user is later
    removed from the board (and from any group that grants inherited access),
    those fields would continue to surface board content the user has lost
    access to.  This helper resolves the current role for each unique board
    referenced in the list and drops notifications where access has been
    revoked.

    Per-request cost is one ``get_board_role`` call per *distinct* board in
    the notification list — bounded by the [:50] cap on the calling queryset
    and typically only a handful of distinct boards.
    """
    unique_boards = {n.board_id: n.board for n in notifications if n.board_id is not None}
    accessible_ids = {
        board_id for board_id, board in unique_boards.items()
        if get_board_role(user, board) is not None
    }
    return [n for n in notifications if n.board_id is None or n.board_id in accessible_ids]


class NotificationListView(APIView):
    """GET /api/notifications/ — last 50 notifications for current user"""

    permission_classes = [
        IsAuthenticated,
        MustNotHavePendingPasswordChange,
        MustNotHavePendingUsernameChange,
    ]

    def get(self, request):
        qs = (
            Notification.objects
            .filter(recipient=request.user, read=False)
            # Pre-load the full group ancestor chain so _filter_to_accessible_boards
            # can call get_board_role() without issuing per-level FK queries (#1015).
            # Without this, each distinct grouped board triggers up to 6 lazy queries
            # when walking the ancestor chain inside get_board_role().
            .select_related(
                "card",
                "board",
                "board__group",
                "board__group__parent",
                "board__group__parent__parent",
                "board__group__parent__parent__parent",
                "board__group__parent__parent__parent__parent",
                "board__group__parent__parent__parent__parent__parent",
                "actor",
            )
            [:50]
        )
        notifications = _filter_to_accessible_boards(list(qs), request.user)
        return Response(NotificationSerializer(notifications, many=True).data)


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
        # Filter to currently-accessible boards so the count stays in sync
        # with the list endpoint (#987) — otherwise the bell would show a
        # number the user can never reach by opening the dropdown.
        # Pre-load the full group ancestor chain — same reasoning as NotificationListView (#1015).
        #
        # Cap at 50 to match NotificationListView: the dropdown never shows
        # more than 50 unread notifications, so the badge count cannot
        # meaningfully exceed that either. Without the cap this endpoint —
        # polled on every page load — would load every unread row into memory
        # and call get_board_role() per distinct board, scaling unbounded with
        # a user's unread backlog.
        qs = Notification.objects.filter(recipient=request.user, read=False).select_related(
            "board",
            "board__group",
            "board__group__parent",
            "board__group__parent__parent",
            "board__group__parent__parent__parent",
            "board__group__parent__parent__parent__parent",
            "board__group__parent__parent__parent__parent__parent",
        )[:50]
        count = len(_filter_to_accessible_boards(list(qs), request.user))
        return Response({"count": count})
