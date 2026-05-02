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
from groups.broadcast import broadcast_group_event as _broadcast_group_event
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

    def get_serializer_context(self):
        context = super().get_serializer_context()
        # When ?expand=group is requested on a list response, build a one-query
        # ancestor map so GroupBriefSerializer.get_ancestors() can resolve every
        # ancestor without walking parent pointers per board (#919).
        if self.action == "list":
            expand = self.request.query_params.get("expand", "")
            if "group" in {p.strip() for p in expand.split(",") if p.strip()}:
                from groups.models import Group as _Group
                group_ids = set(
                    self.get_queryset()
                    .exclude(group_id=None)
                    .values_list("group_id", flat=True)
                )
                if group_ids:
                    # Include the direct groups AND all their ancestors so the
                    # walker in GroupBriefSerializer.get_ancestors() can traverse
                    # the full chain without issuing per-level FK queries.
                    groups = _Group.objects.filter(pk__in=group_ids).select_related(
                        *["__".join(["parent"] * d) for d in range(1, 7)]
                    )
                    ancestor_map: dict = {}
                    for g in groups:
                        node = g
                        while node is not None:
                            ancestor_map[node.pk] = {
                                "name": node.name,
                                "parent_id": node.parent_id,
                            }
                            node = node.parent  # pre-loaded via select_related
                    context["group_ancestor_map"] = ancestor_map
        return context

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
        # When ?expand=group is requested, pre-load the full 6-level ancestor
        # chain so GroupBriefSerializer.get_ancestors() can walk parent pointers
        # without issuing one FK query per ancestor level per board (#819).
        expand = self.request.query_params.get("expand", "")
        expand_group = "group" in {p.strip() for p in expand.split(",") if p.strip()}
        if expand_group:
            group_related = "__".join(["group"] + ["parent"] * 6)
        else:
            group_related = "group"
        return qs.select_related("owner", group_related).annotate(
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
            # Group-scoped broadcast powers the boards-list live view (#753). Keyed
            # off the annotated row so the frontend can insert without a refetch.
            group_id = annotated.group_id
            def _broadcast_created(bid=board_id, bd=board_data, gid=group_id):
                _broadcast.broadcast_board_event(bid, "board.created", bd)
                if gid is not None:
                    _broadcast_group_event(gid, "board.created", bd)
            transaction.on_commit(_broadcast_created)

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
            group_id = annotated.group_id
            def _broadcast_updated(bid=board_id, bd=board_data, gid=group_id):
                _broadcast.broadcast_board_event(bid, _EVT_BOARD_UPDATED, bd)
                if gid is not None:
                    _broadcast_group_event(gid, "board.updated", bd)
            transaction.on_commit(_broadcast_updated)

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
        group_id = board.group_id
        logger.info(
            "board.deleted board_id=%d board_name=%s deleted_by=%d deleted_by_username=%s",
            board.id, board.name, request.user.pk, request.user.username,
        )
        with transaction.atomic():
            board.delete()
            # board_uid is the stable identifier for terminal events (#979).
            # All deletion events (card/column/swimlane/label/saved_filter)
            # carry only the *_uid; board.deleted matches that contract.
            payload = {"board_uid": board_uid}
            def _broadcast_deleted(bid=board_id, gid=group_id, pl=payload):
                _broadcast.broadcast_board_event(bid, "board.deleted", pl)
                if gid is not None:
                    _broadcast_group_event(gid, "board.deleted", pl)
            transaction.on_commit(_broadcast_deleted)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["post", "delete"], url_path="star")
    def star(self, request, pk=None):
        """Star or unstar a board for the requesting user."""
        board = self.get_object()
        with transaction.atomic():
            if request.method == "POST":
                BoardFavorite.objects.get_or_create(user=request.user, board=board)
                is_starred = True
            else:
                BoardFavorite.objects.filter(user=request.user, board=board).delete()
                is_starred = False
            # Re-fetch via get_queryset() so the _is_starred annotation reflects the
            # change just made — the object fetched by get_object() above is stale.
            board = self.get_queryset().get(pk=board.pk)
            # Star is per-user state, but a user may have multiple tabs open on
            # the same board; broadcast so other sessions of the same user sync
            # without a full refetch. Clients filter on user_id === me (#814).
            board_uid = board.uid
            board_id = board.pk
            group_id = board.group_id
            user_id = request.user.id
            star_payload = {"uid": board_uid, "user_id": user_id, "is_starred": is_starred}

            def _broadcast_star() -> None:
                _broadcast.broadcast_board_event(board_id, "board.star_changed", star_payload)
                if group_id is not None:
                    # Also fan out to the group channel so the GroupDetail page
                    # updates the star indicator in real time without a refetch
                    # (#952).  Same per-user filter applies — clients ignore
                    # events whose user_id does not match their own.
                    _broadcast_group_event(group_id, "board.star_changed", star_payload)

            transaction.on_commit(_broadcast_star)
        return Response(self.get_serializer(board).data)

    @action(detail=True, methods=["post", "delete"], url_path="share")
    def share(self, request, pk=None):
        """Enable or revoke the public share link for a board.

        POST  — generates a fresh UUID token (replaces any existing token).
        DELETE — clears the token, immediately invalidating any live share link.
        Both operations are admin-only; the token is a public credential.
        """
        import uuid as _uuid
        from datetime import timedelta
        from django.utils import timezone
        board, role = get_board_for_user(pk, request.user)
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        # Optional TTL (#804). Null or missing means "never expires"; any
        # integer in ALLOWED_TTL_DAYS sets share_token_expires_at to now+N days.
        # Kept as a fixed allowlist rather than an arbitrary int so that UI
        # copy and docs ("Expire in 7/30/90 days / never") stay authoritative.
        ALLOWED_TTL_DAYS = {7, 30, 90}
        with transaction.atomic():
            if request.method == "POST":
                expires_in_days = request.data.get("expires_in_days") if hasattr(request, "data") else None
                expires_at = None
                if expires_in_days is not None:
                    try:
                        days = int(expires_in_days)
                    except (TypeError, ValueError):
                        return Response(
                            {"detail": "expires_in_days must be an integer or null."},
                            status=status.HTTP_400_BAD_REQUEST,
                        )
                    if days not in ALLOWED_TTL_DAYS:
                        return Response(
                            {"detail": f"expires_in_days must be one of {sorted(ALLOWED_TTL_DAYS)} or null."},
                            status=status.HTTP_400_BAD_REQUEST,
                        )
                    expires_at = timezone.now() + timedelta(days=days)
                board.share_token = _uuid.uuid4()
                board.share_token_expires_at = expires_at
                board.save(update_fields=["share_token", "share_token_expires_at"])
                share_url = request.build_absolute_uri(f"/api/share/{board.share_token}")
                response_data = {
                    "share_token": str(board.share_token),
                    "share_url": share_url,
                    "share_token_expires_at": expires_at.isoformat() if expires_at else None,
                }
            else:
                # DELETE — clear both the token and the TTL so re-enabling
                # starts from a clean "never expires" default.
                board.share_token = None
                board.share_token_expires_at = None
                board.save(update_fields=["share_token", "share_token_expires_at"])
                response_data = {"share_token": None, "share_token_expires_at": None}

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

        old_group_id = board.group_id
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
            new_group_id = annotated.group_id
            # Single on_commit callback so subscribers on the old and new group
            # channels observe the move atomically (#753).
            def _broadcast_move(
                bid=board_id, bd=board_data,
                og=old_group_id, ng=new_group_id,
            ):
                _broadcast.broadcast_board_event(bid, _EVT_BOARD_UPDATED, bd)
                if og is not None and og != ng:
                    _broadcast_group_event(og, "board.deleted", {
                        "board_uid": bd.get("uid"), "board_id": bid,
                    })
                if ng is not None and ng != og:
                    _broadcast_group_event(ng, "board.created", bd)
                elif ng is not None:
                    # Same group — treat as a metadata update.
                    _broadcast_group_event(ng, "board.updated", bd)
            transaction.on_commit(_broadcast_move)
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

        board_id = board.id
        user_id = request.user.id
        try:
            with transaction.atomic():
                saved = SavedFilter.objects.create(
                    user=request.user,
                    board=board,
                    name=name,
                    state_json=state_json,
                    state_version=raw_version,
                )
                filter_id = saved.id
                # Broadcast only the filter ID so other members know a new filter exists
                # without receiving the state_json contents (which are that user's personal
                # configuration and should not be pushed to all co-members on the board).
                # The creating user receives the full payload via the HTTP response below.
                transaction.on_commit(
                    lambda: _broadcast.broadcast_board_event(
                        board_id, "saved_filter.created", {"filter_id": filter_id, "user_id": user_id}
                    )
                )
        except IntegrityError:
            # unique_together violation — a filter with this name already exists.
            return Response(
                {"detail": "A saved filter with this name already exists on this board."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        serialized = SavedFilterSerializer(saved).data
        return Response(serialized, status=status.HTTP_201_CREATED)

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
        board_id = board.id
        filter_id = saved.id
        user_id = request.user.id
        with transaction.atomic():
            saved.delete()
            transaction.on_commit(
                lambda: _broadcast.broadcast_board_event(
                    board_id, "saved_filter.deleted", {"filter_id": filter_id, "user_id": user_id}
                )
            )
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
