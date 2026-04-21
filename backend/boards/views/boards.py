"""BoardViewSet — the primary viewset for board CRUD and board-scoped actions."""

import logging

from django.db import IntegrityError, transaction
from django.db.models import Count, Exists, OuterRef, Q
from django.shortcuts import get_object_or_404
from rest_framework import serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from accounts.models import User
from groups.models import Group, GroupMembership, get_accessible_group_ids

from .. import broadcast as _broadcast
from ..models import (
    Board, BoardFavorite, BoardMembership, Column, Notification, SavedFilter, Swimlane,
)
from ..permissions import get_board_role, SITE_ADMIN
from ..serializers import (
    BoardSerializer, BoardFullSerializer, BoardMembershipSerializer,
    SavedFilterSerializer,
)
from ..templates import BOARD_TEMPLATES
from ._helpers import get_board_for_user
from .analytics import BoardAnalyticsMixin
from .import_export import BoardImportExportMixin

logger = logging.getLogger(__name__)

_EVT_BOARD_UPDATED = "board.updated"


class BoardViewSet(
    BoardAnalyticsMixin,
    BoardImportExportMixin,
    viewsets.ModelViewSet,
):
    """CRUD endpoints for boards, scoped to boards the requesting user has access to."""

    serializer_class = BoardSerializer

    def get_queryset(self):
        user = self.request.user
        if user.can_access_all_content:
            qs = Board.objects.all()
        else:
            qs = Board.objects.filter(
                Q(owner=user) |
                Q(memberships__user=user) |
                Q(group__in=get_accessible_group_ids(user))
            ).distinct()
        if self.request.query_params.get("starred") == "true":
            qs = qs.filter(favorites__user=user)
        # select_related("owner", "group") prevents one JOIN-per-board for the
        # owner and group_name serializer fields. Annotate to avoid 3 further
        # subqueries per board (member_count, card_count, is_starred). The
        # /full/ endpoint loads card data via its own queryset in
        # get_board_for_user(); BoardSerializer (used by list/retrieve) never
        # reads card fields so prefetching cards__labels / cards__assignee
        # here only loaded data that was immediately discarded.
        return qs.select_related("owner", "group").annotate(
            _member_count=Count("memberships", distinct=True),
            _card_count=Count("cards", filter=Q(cards__archived_at__isnull=True), distinct=True),
            _is_starred=Exists(
                BoardFavorite.objects.filter(board=OuterRef("pk"), user=user)
            ),
        )

    def perform_create(self, serializer):
        # Wrap the entire creation sequence in a transaction so a failure
        # in any step (e.g. swimlane creation) rolls back the board,
        # membership, and columns — preventing orphaned records.
        with transaction.atomic():
            board = serializer.save(owner=self.request.user)
            BoardMembership.objects.create(board=board, user=self.request.user, role=BoardMembership.Role.ADMIN)

            template_key = self.request.data.get("template", "simple_kanban")
            template = BOARD_TEMPLATES.get(template_key, BOARD_TEMPLATES["simple_kanban"])

            if template["columns"]:
                Column.objects.bulk_create([
                    Column(
                        board=board,
                        name=col["name"],
                        position=i,
                        color=col["color"],
                        allow_card_creation=(i == 0),
                        is_done=col.get("is_done", False),
                    )
                    for i, col in enumerate(template["columns"])
                ])

            # Prefer the user-supplied swimlane name from the modal prompt;
            # fall back to the legacy static default for backwards compatibility.
            swimlane_name = (self.request.data.get("swimlane_name") or "").strip()
            if not swimlane_name:
                swimlane_name = template.get("default_swimlane") or ""
            if swimlane_name:
                Swimlane.objects.create(board=board, name=swimlane_name, position=0, color="#6B7280")

            # Broadcast board.created so group members and dashboard subscribers
            # can refresh their board list without a manual reload.
            # NOTE: this event goes to channel board_{id}, which currently has no
            # subscribers at creation time.  A future user-level notification channel
            # will relay it to the dashboard.  The backend broadcast is added now so
            # the event shape is established as a 1.0 contract.
            board_id = board.id
            # Re-fetch through get_queryset() so the broadcast payload uses the
            # annotated row (_member_count, _card_count, _is_starred) rather
            # than the bare post-save instance. Without the annotations,
            # BoardSerializer.get_is_starred() falls through to a live EXISTS
            # query on every board.created broadcast.
            annotated = self.get_queryset().get(pk=board_id)
            board_data = BoardSerializer(annotated, context={"request": self.request}).data
            transaction.on_commit(
                lambda: _broadcast.broadcast_board_event(board_id, "board.created", board_data)
            )

    def perform_update(self, serializer):
        """Guard board-level updates: only admins can edit any board field.

        Viewers and collaborators have read-only access. Members and above can
        read but only admins can change the board name, description, settings, or
        enforcement flags. Previously only enforcement flags were guarded, which
        allowed viewers and members to rename boards via PATCH.
        """
        board = serializer.instance
        role = get_board_role(self.request.user, board)
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied("Only board admins can edit board settings.")
        with transaction.atomic():
            serializer.save()
            board = serializer.instance
            board_id = board.id
            # Re-fetch through get_queryset() so the serializer response includes
            # annotations (_member_count, _card_count, _is_starred) rather than
            # triggering per-field subqueries from the bare post-save instance (#647).
            annotated = self.get_queryset().get(pk=board_id)
            board_data = BoardSerializer(annotated, context={"request": self.request}).data
            transaction.on_commit(
                lambda: _broadcast.broadcast_board_event(board_id, _EVT_BOARD_UPDATED, board_data)
            )

    def destroy(self, request, *args, **kwargs):
        board = self.get_object()
        role = get_board_role(request.user, board)
        # Board deletion is intentionally restricted to the owner and site admins.
        # Board admins (non-owners) can manage board structure but cannot delete
        # the board — deletion is irreversible and only the owner should hold that
        # authority. See docs/features/rbac/roles.md for the full role matrix.
        if board.owner != request.user and role != SITE_ADMIN:
            raise PermissionDenied
        board_id = board.id
        board_uid = board.uid
        logger.info(
            "board.deleted board_id=%d board_name=%s deleted_by=%d deleted_by_username=%s",
            board.id, board.name, request.user.pk, request.user.username,
        )
        with transaction.atomic():
            board.delete()
            # board_uid is the stable identifier for this event; board_id is kept
            # for backward compatibility with pre-1.1 clients and must not be
            # removed until a major-version bump.
            transaction.on_commit(
                lambda: _broadcast.broadcast_board_event(
                    board_id, "board.deleted", {"board_uid": board_uid, "board_id": board_id}
                )
            )
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["post", "delete"], url_path="star")
    def star(self, request, pk=None):
        """Star or unstar a board for the requesting user."""
        board = self.get_object()
        if request.method == "POST":
            BoardFavorite.objects.get_or_create(user=request.user, board=board)
        else:
            BoardFavorite.objects.filter(user=request.user, board=board).delete()
        # Re-fetch via get_queryset() so the _is_starred annotation reflects the
        # change just made — the object fetched by get_object() above is stale.
        board = self.get_queryset().get(pk=board.pk)
        return Response(self.get_serializer(board).data)

    @action(detail=True, methods=["post", "delete"], url_path="share")
    def share(self, request, pk=None):
        """Enable or revoke the public share link for a board.

        POST  — generates a fresh UUID token (replaces any existing token).
        DELETE — clears the token, immediately invalidating any live share link.
        Both operations are admin-only; the token is a public credential.
        """
        import uuid as _uuid
        board, role = get_board_for_user(pk, request.user)
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        with transaction.atomic():
            if request.method == "POST":
                board.share_token = _uuid.uuid4()
                board.save(update_fields=["share_token"])
                share_url = request.build_absolute_uri(f"/api/share/{board.share_token}")
                response_data = {"share_token": str(board.share_token), "share_url": share_url}
            else:
                # DELETE
                board.share_token = None
                board.save(update_fields=["share_token"])
                response_data = {"share_token": None}

            # Notify connected clients so the Sharing tab updates without a reload.
            # Re-fetch through get_queryset() so the broadcast payload includes
            # annotations (_member_count, _card_count, _is_starred) rather than
            # triggering per-field subqueries from the bare post-save instance (#647).
            board_id = board.pk
            annotated = self.get_queryset().get(pk=board_id)
            board_summary = BoardSerializer(annotated, context={"request": request}).data
            transaction.on_commit(
                lambda: _broadcast.broadcast_board_event(board_id, _EVT_BOARD_UPDATED, board_summary)
            )
        return Response(response_data)

    @action(detail=True, methods=["post"], url_path="move-group")
    def move_group(self, request, pk=None):
        """Move a board into a group (or back to personal) that the requesting user belongs to."""
        board, role = get_board_for_user(pk, request.user)
        if board.owner != request.user and role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied

        group_id = request.data.get("group_id")  # None = move to personal
        if group_id is not None:
            group = get_object_or_404(Group, pk=group_id)
            is_member = (
                group.owner_id == request.user.id or
                GroupMembership.objects.filter(group=group, user=request.user).exists()
            )
            if not is_member:
                raise PermissionDenied("You are not a member of the target group.")
            board.group = group
        else:
            board.group = None

        with transaction.atomic():
            board.save()
            board_id = board.id
            # Re-fetch through get_queryset() so the response and broadcast include
            # annotations (_member_count, _card_count, _is_starred) rather than
            # triggering per-field subqueries from the bare post-save instance (#647).
            annotated = self.get_queryset().get(pk=board_id)
            board_data = BoardSerializer(annotated, context={"request": request}).data
            transaction.on_commit(
                lambda: _broadcast.broadcast_board_event(board_id, _EVT_BOARD_UPDATED, board_data)
            )
        return Response(board_data)

    @action(detail=True, methods=["get"])
    def full(self, request, pk=None):
        """Return the full board state: columns, swimlanes, cards, labels, and members.

        The resolved role is threaded into serializer context so that
        get_current_user_role() and get_swimlanes() can reuse it without
        issuing a second get_board_role() query.
        """
        board, role = get_board_for_user(pk, request.user)
        return Response(BoardFullSerializer(board, context={"request": request, "role": role}).data)

    @action(detail=True, methods=["get", "post"], url_path="saved-filters")
    def saved_filters(self, request, pk=None):
        """List or create saved filter presets for the requesting user on this board.

        GET  — returns all saved filters belonging to the requesting user on this board.
        POST — creates a new saved filter; name must be unique per user per board.

        Saved filters are private to the requesting user. Any board member (including
        viewer-role) can save and restore their own filter presets; no shared presets.
        """
        board, _ = get_board_for_user(pk, request.user)

        if request.method == "GET":
            qs = SavedFilter.objects.filter(user=request.user, board=board)
            return Response(SavedFilterSerializer(qs, many=True).data)

        # POST — create a new saved filter for this user on this board.
        name = (request.data.get("name") or "").strip()
        if not name:
            return Response({"detail": "name is required."}, status=status.HTTP_400_BAD_REQUEST)
        if len(name) > 100:
            return Response(
                {"detail": "name must be 100 characters or fewer."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        state_json = request.data.get("state_json")
        if state_json is None:
            return Response({"detail": "state_json is required."}, status=status.HTTP_400_BAD_REQUEST)
        if not isinstance(state_json, dict):
            return Response(
                {"detail": "state_json must be an object."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        import json as _json
        if len(_json.dumps(state_json)) > 65_536:
            return Response(
                {"detail": "state_json exceeds the maximum allowed size (64 KB)."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Shape-check state_json via the serializer so malformed payloads
        # (unknown keys, wrong types) are rejected in one place — the same
        # validator will protect a future board-import flow (#698).
        try:
            SavedFilterSerializer().validate_state_json(state_json)
        except serializers.ValidationError as exc:
            detail = exc.detail
            if isinstance(detail, list) and detail:
                detail = detail[0]
            return Response({"detail": str(detail)}, status=status.HTTP_400_BAD_REQUEST)

        # state_version is optional on write (defaults to 1 for clients that
        # predate the versioning scheme). We accept unknown higher versions
        # so a mixed-version deploy where a newer client posts v2 to an older
        # server does not silently drop the user's save (#698).
        raw_version = request.data.get("state_version", 1)
        if not isinstance(raw_version, int) or isinstance(raw_version, bool) or raw_version < 1:
            return Response(
                {"detail": "state_version must be a positive integer."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            saved = SavedFilter.objects.create(
                user=request.user,
                board=board,
                name=name,
                state_json=state_json,
                state_version=raw_version,
            )
        except IntegrityError:
            # unique_together violation — a filter with this name already exists.
            return Response(
                {"detail": "A saved filter with this name already exists on this board."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        return Response(SavedFilterSerializer(saved).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["delete"], url_path=r"saved-filters/(?P<filter_pk>[0-9]+)")
    def saved_filter_delete(self, request, pk=None, filter_pk=None):
        """Delete a single saved filter preset owned by the requesting user.

        The queryset is scoped to request.user — attempting to delete another
        user's saved filter returns 404, not 403, to avoid confirming existence.
        """
        board, _ = get_board_for_user(pk, request.user)
        try:
            saved = SavedFilter.objects.get(pk=filter_pk, user=request.user, board=board)
        except SavedFilter.DoesNotExist:
            return Response(status=status.HTTP_404_NOT_FOUND)
        saved.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["post"])
    def members(self, request, pk=None):
        """Add or update a member's role on the board (admin only)."""
        board, role = get_board_for_user(pk, request.user)
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        user_id = request.data.get("user_id")
        member_role = request.data.get("role", BoardMembership.Role.MEMBER)
        target_user = get_object_or_404(User, pk=user_id)
        # Only site admins can add/change other site admins
        if target_user.is_site_admin and role != SITE_ADMIN:
            raise PermissionDenied("Cannot modify a site admin's board membership.")
        raw_mod = request.data.get("is_moderator")
        # Normalize: None means "not provided", else coerce to bool.
        # Multipart forms send "false"/"true" as strings.
        if raw_mod is None:
            is_moderator = None
        elif isinstance(raw_mod, str):
            is_moderator = raw_mod.lower() not in ("false", "0", "")
        else:
            is_moderator = bool(raw_mod)
        if is_moderator and member_role in (
            BoardMembership.Role.COLLABORATOR,
            BoardMembership.Role.VIEWER,
        ):
            return Response(
                {"detail": "Moderator entitlement can only be granted to members or admins."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        defaults = {"role": member_role}
        if is_moderator is not None:
            defaults["is_moderator"] = is_moderator
        with transaction.atomic():
            membership, created = BoardMembership.objects.get_or_create(
                board=board, user=target_user, defaults=defaults
            )
            if not created:
                membership.role = member_role
                if is_moderator is not None:
                    membership.is_moderator = is_moderator
                # Clear moderator flag when demoting to collaborator/viewer
                if member_role in (BoardMembership.Role.COLLABORATOR, BoardMembership.Role.VIEWER):
                    membership.is_moderator = False
                membership.save()
            # Assign user directly so BoardMembershipSerializer does not issue a
            # separate query to load the FK — target_user is already in scope.
            membership.user = target_user
            membership_data = BoardMembershipSerializer(membership).data
            board_id = board.id
            ws_event = "member.added" if created else "member.updated"
            transaction.on_commit(lambda: _broadcast.broadcast_board_event(board_id, ws_event, membership_data))
            # Notify the invited user when they are newly added (not on role updates).
            # Skipped if they added themselves or have opted out of board invite notifications.
            if created and target_user != request.user and target_user.notif_board_invite:
                Notification.objects.create(
                    recipient=target_user,
                    actor=request.user,
                    action_type=Notification.ActionType.BOARD_INVITE,
                    verb=f"{request.user.username} added you to \"{board.name}\"",
                    board=board,
                )
        # 201 for a new membership, 200 for a role update on an existing one.
        return Response(membership_data, status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)

    @action(detail=True, methods=["delete"], url_path="members/(?P<user_id>[^/.]+)")
    def remove_member(self, request, pk=None, user_id=None):
        """Remove a member from the board (admin only)."""
        board, role = get_board_for_user(pk, request.user)
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        target_user = get_object_or_404(User, pk=user_id)
        if target_user.is_site_admin and role != SITE_ADMIN:
            raise PermissionDenied("Cannot remove a site admin from a board.")
        board_id = board.id
        removed_user_id = target_user.id
        with transaction.atomic():
            BoardMembership.objects.filter(board=board, user=target_user).delete()
            transaction.on_commit(lambda: _broadcast.broadcast_board_event(board_id, "member.removed", {"user_id": removed_user_id}))
        return Response(status=status.HTTP_204_NO_CONTENT)
