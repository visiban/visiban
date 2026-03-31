import logging

from django.db.models import Count, Exists, OuterRef
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated, AllowAny

from visiban.permissions import MustNotHavePendingPasswordChange, MustNotHavePendingUsernameChange
from visiban.utils import get_client_ip
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView

from .models import Group, GroupFavorite, GroupLabel, GroupMembership, GroupInviteLink
from .serializers import GroupSerializer, GroupDetailSerializer, GroupLabelSerializer, GroupMembershipSerializer, GroupInviteLinkSerializer

logger = logging.getLogger(__name__)


def _require_group_admin(user, group):
    """Raise PermissionDenied if user is not an admin of this group or any ancestor.

    Collects all ancestor PKs in a single traversal, then issues one batched
    membership query instead of one query per level to avoid N+1 on deep trees.
    Traversal is capped at _GROUP_TRAVERSAL_MAX_DEPTH levels.
    """
    from rest_framework.exceptions import PermissionDenied
    from django.utils.translation import gettext_lazy as _
    from .models import _GROUP_TRAVERSAL_MAX_DEPTH
    if getattr(user, "can_access_all_content", False):
        return
    ancestor_ids = []
    node = group
    depth = 0
    while node and depth < _GROUP_TRAVERSAL_MAX_DEPTH:
        ancestor_ids.append(node.pk)
        node = node.parent
        depth += 1
    if GroupMembership.objects.filter(
        group_id__in=ancestor_ids,
        user=user,
        role=GroupMembership.Role.ADMIN,
    ).exists():
        return
    raise PermissionDenied(_("You must be a group admin to perform this action."))


def _require_group_member(user, group):
    """Raise PermissionDenied if user is not a member of this group or any ancestor.

    Collects all ancestor PKs in a single traversal, then issues one batched
    membership query instead of one query per level to avoid N+1 on deep trees.
    Traversal is capped at _GROUP_TRAVERSAL_MAX_DEPTH levels.
    """
    from rest_framework.exceptions import PermissionDenied
    from django.utils.translation import gettext_lazy as _
    from .models import _GROUP_TRAVERSAL_MAX_DEPTH
    if getattr(user, "can_access_all_content", False):
        return
    ancestor_ids = []
    node = group
    depth = 0
    while node and depth < _GROUP_TRAVERSAL_MAX_DEPTH:
        ancestor_ids.append(node.pk)
        node = node.parent
        depth += 1
    if GroupMembership.objects.filter(
        group_id__in=ancestor_ids,
        user=user,
    ).exists():
        return
    raise PermissionDenied(_("You must be a group member to perform this action."))


class GroupViewSet(viewsets.ModelViewSet):
    """CRUD endpoints for groups, scoped to groups the requesting user is a member of."""

    serializer_class = GroupSerializer

    def get_serializer_class(self):
        # Use the richer GroupDetailSerializer only for single-object retrieval.
        # The list endpoint omits `ancestors` to avoid per-group N+1 queries.
        if self.action == "retrieve":
            return GroupDetailSerializer
        return GroupSerializer

    def get_queryset(self):
        from .models import get_accessible_group_ids
        user = self.request.user
        # Base relations needed for all actions.
        related = ["owner", "parent"]
        if self.action == "retrieve":
            # Pre-fetch the full ancestor chain so GroupDetailSerializer can call
            # obj.ancestors() without issuing a separate query per level.
            # Six chained parent__ lookups matches _GROUP_TRAVERSAL_MAX_DEPTH.
            related += ["__".join(["parent"] * d) for d in range(2, 7)]
        qs = Group.objects.filter(
            id__in=get_accessible_group_ids(user)
        ).select_related(*related).annotate(
            # Annotate counts so GroupSerializer can read _member_count etc.
            # directly from the object instead of issuing 3-4 extra queries per group.
            _member_count=Count("memberships", distinct=True),
            _board_count=Count("boards", distinct=True),
            _subgroup_count=Count("subgroups", distinct=True),
            _is_starred=Exists(
                GroupFavorite.objects.filter(user=user, group=OuterRef("pk"))
            ),
        )
        if self.request.query_params.get("starred") == "true":
            qs = qs.filter(favorites__user=user)
        return qs

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context["request"] = self.request
        return context

    def perform_create(self, serializer):
        parent = serializer.validated_data.get("parent")
        if parent is not None:
            _require_group_admin(self.request.user, parent)
        group = serializer.save(owner=self.request.user)
        GroupMembership.objects.create(
            group=group, user=self.request.user, role=GroupMembership.Role.ADMIN
        )

    def update(self, request, *args, **kwargs):
        # Only group admins may rename or re-parent a group.
        # The default ModelViewSet inherits no admin guard here — add it explicitly.
        _require_group_admin(request.user, self.get_object())
        return super().update(request, *args, **kwargs)

    def partial_update(self, request, *args, **kwargs):
        _require_group_admin(request.user, self.get_object())
        return super().partial_update(request, *args, **kwargs)

    def destroy(self, request, *args, **kwargs):
        group = self.get_object()
        if group.owner != request.user and not getattr(request.user, "can_access_all_content", False):
            return Response(status=status.HTTP_403_FORBIDDEN)
        group.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    # ------------------------------------------------------------------
    # Members
    # ------------------------------------------------------------------

    @action(detail=True, methods=["get"])
    def members(self, request, pk=None):
        group = self.get_object()
        _require_group_member(request.user, group)

        from accounts.serializers import BoardUserSerializer

        # Direct memberships
        direct = list(group.memberships.select_related("user"))
        seen_user_ids = {m.user_id for m in direct}

        result = [
            {
                "id": m.id,
                "user": BoardUserSerializer(m.user).data,
                "role": m.role,
                "joined_at": m.joined_at,
                "is_inherited": False,
                "inherited_from": None,
            }
            for m in direct
        ]

        # Inherited memberships from ancestor groups (nearest ancestor wins,
        # ancestors() returns nearest-first).
        for ancestor in group.ancestors():
            for m in ancestor.memberships.select_related("user"):
                if m.user_id not in seen_user_ids:
                    result.append({
                        "id": None,
                        "user": BoardUserSerializer(m.user).data,
                        "role": m.role,
                        "joined_at": m.joined_at,
                        "is_inherited": True,
                        "inherited_from": ancestor.name,
                    })
                    seen_user_ids.add(m.user_id)

        return Response(result)

    @action(detail=True, methods=["patch", "delete"], url_path=r"members/(?P<user_id>[^/.]+)")
    def update_member(self, request, pk=None, user_id=None):
        from accounts.models import User
        group = self.get_object()
        _require_group_admin(request.user, group)
        target_user = get_object_or_404(User, pk=user_id)
        if target_user.is_site_admin and not request.user.is_site_admin:
            return Response(
                {"detail": "Cannot modify a site admin's group membership."},
                status=status.HTTP_403_FORBIDDEN,
            )
        if request.method == "DELETE":
            GroupMembership.objects.filter(group=group, user=target_user).delete()
            return Response(status=status.HTTP_204_NO_CONTENT)
        # PATCH — update role
        membership = get_object_or_404(GroupMembership, group=group, user=target_user)
        role = request.data.get("role")
        if role not in GroupMembership.Role.values:
            return Response({"role": f"Must be one of: {', '.join(GroupMembership.Role.values)}"}, status=status.HTTP_400_BAD_REQUEST)
        membership.role = role
        membership.save()
        return Response(GroupMembershipSerializer(membership).data)

    # ------------------------------------------------------------------
    # Subgroups
    # ------------------------------------------------------------------

    @action(detail=True, methods=["get"])
    def subgroups(self, request, pk=None):
        group = self.get_object()
        _require_group_member(request.user, group)
        # Filter subgroups to only those the requesting user is a direct member of
        # (or owns, or is a site admin). get_accessible_group_ids includes descendants
        # of groups the user is a member of, which would expose subgroups the user
        # has no explicit membership in. Use a direct-membership filter instead.
        if getattr(request.user, "can_access_all_content", False):
            subgroups = group.subgroups.all()
        else:
            from django.db.models import Q
            accessible_ids = set(
                Group.objects.filter(
                    Q(owner=request.user) | Q(memberships__user=request.user)
                ).values_list("id", flat=True)
            )
            subgroups = group.subgroups.filter(id__in=accessible_ids)
        return Response(GroupSerializer(subgroups, many=True, context={"request": request}).data)

    # ------------------------------------------------------------------
    # Boards
    # ------------------------------------------------------------------

    @action(detail=True, methods=["get", "post"])
    def boards(self, request, pk=None):
        from boards.models import Board, Column, Swimlane
        from boards.serializers import BoardSerializer

        group = self.get_object()
        _require_group_member(request.user, group)

        if request.method == "GET":
            # Group membership implies access to all boards in the group —
            # no separate BoardMembership required.
            # Annotations mirror BoardViewSet.get_queryset() so BoardSerializer
            # can use the cached values instead of issuing 3 extra queries per board.
            from boards.models import BoardFavorite
            boards = (
                Board.objects.filter(group=group)
                .select_related("owner")
                .annotate(
                    _member_count=Count("memberships", distinct=True),
                    _card_count=Count("cards", distinct=True),
                    _is_starred=Exists(
                        BoardFavorite.objects.filter(board=OuterRef("pk"), user=request.user)
                    ),
                )
            )
            return Response(BoardSerializer(boards, many=True, context={"request": request}).data)

        # POST — create a new board inside this group
        _require_group_admin(request.user, group)
        serializer = BoardSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        board = serializer.save(owner=request.user, group=group)

        from boards.templates import BOARD_TEMPLATES
        template_key = (request.data.get("template") or "simple_kanban").strip()
        template = BOARD_TEMPLATES.get(template_key, BOARD_TEMPLATES["simple_kanban"])
        if template["columns"]:
            Column.objects.bulk_create([
                Column(board=board, name=col["name"], position=i, color=col["color"], allow_card_creation=(i == 0))
                for i, col in enumerate(template["columns"])
            ])

        swimlane_name = ((request.data.get("swimlane_name") or "").strip() or template.get("default_swimlane") or "General")[:255]
        Swimlane.objects.create(board=board, name=swimlane_name, position=0, color="#6B7280")

        # Apply group defaults: copy shared labels and allowed priorities
        from boards.models import Label as BoardLabel
        group_labels = group.labels.all()
        if group_labels.exists():
            BoardLabel.objects.bulk_create([
                BoardLabel(board=board, name=gl.name, color=gl.color)
                for gl in group_labels
            ], ignore_conflicts=True)

        allowed = group.get_allowed_priorities()
        if allowed != ["low", "medium", "high", "urgent"]:
            board.allowed_priorities = allowed
            board.save(update_fields=["allowed_priorities"])

        return Response(BoardSerializer(board).data, status=status.HTTP_201_CREATED)

    # ------------------------------------------------------------------
    # Ownership transfer
    # ------------------------------------------------------------------

    @action(detail=True, methods=["post"], url_path="transfer-ownership")
    def transfer_ownership(self, request, pk=None):
        from rest_framework.exceptions import PermissionDenied
        group = self.get_object()

        # Only current owner can transfer
        if group.owner_id != request.user.id:
            raise PermissionDenied("Only the group owner can transfer ownership.")

        new_owner_id = request.data.get("new_owner_id")
        confirmation = request.data.get("confirmation", "")

        # Require typing the group name as confirmation
        if confirmation != group.name:
            return Response(
                {"detail": "Confirmation does not match the group name."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # New owner must be a current admin member
        try:
            membership = GroupMembership.objects.get(group=group, user_id=new_owner_id)
        except GroupMembership.DoesNotExist:
            return Response(
                {"detail": "New owner must already be a group member."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if membership.role != GroupMembership.Role.ADMIN:
            return Response(
                {"detail": "New owner must be an admin of this group."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Transfer: new owner gets owner role, previous owner becomes admin
        from django.db import transaction
        with transaction.atomic():
            group.owner_id = new_owner_id
            group.save(update_fields=["owner_id"])
            # Ensure previous owner stays as admin member
            GroupMembership.objects.update_or_create(
                group=group, user=request.user,
                defaults={"role": GroupMembership.Role.ADMIN},
            )

        return Response(GroupSerializer(group, context={"request": request}).data)

    # ------------------------------------------------------------------
    # Invite links
    # ------------------------------------------------------------------

    @action(detail=True, methods=["get", "post"], url_path="invite-links")
    def invite_links(self, request, pk=None):
        group = self.get_object()
        _require_group_admin(request.user, group)

        if request.method == "GET":
            links = GroupInviteLink.objects.filter(group=group, is_active=True).order_by("created_at")
            return Response(GroupInviteLinkSerializer(links, many=True).data)

        # POST — create a new invite link (max 5 active per group)
        active_count = GroupInviteLink.objects.filter(group=group, is_active=True).count()
        if active_count >= 5:
            return Response(
                {"detail": "Maximum of 5 active invite links per group."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        name = request.data.get("name", "")
        role = request.data.get("role", GroupInviteLink.Role.MEMBER)
        if role not in GroupInviteLink.Role.values:
            return Response(
                {"role": f"Must be one of: {', '.join(GroupInviteLink.Role.values)}"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        expiry_days = request.data.get("expiry_days")
        expires_at = None
        if expiry_days is not None:
            import datetime
            try:
                expiry_days = int(expiry_days)
            except (TypeError, ValueError):
                return Response(
                    {"expiry_days": "Must be an integer number of days."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if expiry_days > 0:
                expires_at = timezone.now() + datetime.timedelta(days=expiry_days)

        link, raw_token = GroupInviteLink.generate(
            group=group,
            created_by=request.user,
            name=name,
            role=role,
            expires_at=expires_at,
        )
        data = GroupInviteLinkSerializer(link).data
        data["token"] = raw_token
        return Response(data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["delete"], url_path=r"invite-links/(?P<link_id>[^/.]+)")
    def revoke_invite_link(self, request, pk=None, link_id=None):
        group = self.get_object()
        _require_group_admin(request.user, group)
        link = get_object_or_404(GroupInviteLink, pk=link_id, group=group, is_active=True)
        link.is_active = False
        link.save(update_fields=["is_active"])
        return Response(status=status.HTTP_204_NO_CONTENT)

    # ------------------------------------------------------------------
    # Board defaults (shared labels, allowed priorities, default role)
    # ------------------------------------------------------------------

    @action(detail=True, methods=["get", "post"], url_path="labels")
    def group_labels(self, request, pk=None):
        """GET/POST group-level shared label library."""
        group = self.get_object()
        _require_group_member(request.user, group)

        if request.method == "GET":
            return Response(GroupLabelSerializer(group.labels.all(), many=True).data)

        # POST — create a label (admin only)
        _require_group_admin(request.user, group)
        serializer = GroupLabelSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        label = serializer.save(group=group)
        return Response(GroupLabelSerializer(label).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["patch", "delete"], url_path=r"labels/(?P<label_id>[^/.]+)")
    def update_group_label(self, request, pk=None, label_id=None):
        """PATCH or DELETE a group shared label."""
        group = self.get_object()
        _require_group_admin(request.user, group)
        label = get_object_or_404(GroupLabel, pk=label_id, group=group)

        if request.method == "DELETE":
            label.delete()
            return Response(status=status.HTTP_204_NO_CONTENT)

        # PATCH — update name/color
        serializer = GroupLabelSerializer(label, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(GroupLabelSerializer(label).data)

    @action(detail=True, methods=["patch"], url_path="board-defaults")
    def board_defaults(self, request, pk=None):
        """PATCH group board defaults: default_board_member_role, allowed_priorities."""
        group = self.get_object()
        _require_group_admin(request.user, group)

        allowed_fields = {"default_board_member_role", "allowed_priorities"}
        data = {k: v for k, v in request.data.items() if k in allowed_fields}

        serializer = GroupSerializer(group, data=data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(GroupSerializer(group).data)

    # ------------------------------------------------------------------
    # Favorites (star / unstar)
    # ------------------------------------------------------------------

    @action(detail=True, methods=["post", "delete"], url_path="star")
    def star(self, request, pk=None):
        group = self.get_object()
        # Confirm the requesting user is actually a member of this group before
        # allowing a star/unstar — get_object() only checks visibility (accessible
        # group ids), but starring is a member-level action.
        _require_group_member(request.user, group)
        if request.method == "DELETE":
            GroupFavorite.objects.filter(user=request.user, group=group).delete()
            return Response(status=status.HTTP_204_NO_CONTENT)
        _, created = GroupFavorite.objects.get_or_create(user=request.user, group=group)
        return Response({"starred": True}, status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)


class JoinGroupRateThrottle(AnonRateThrottle):
    """Shared rate limit for invite-link redemption attempts.

    Applied to both the anonymous GET (token preview) and authenticated POST
    (join) endpoints. 10 requests per hour prevents brute-force token scanning
    while still allowing a user to retry after a network error or browser
    back-navigation within the same hour.
    """

    scope = "join_group"

    def get_cache_key(self, request, view):
        # Use IP address for both anon and authenticated requests so that an
        # attacker cannot escape the limit by logging in.
        ident = self.get_ident(request)
        return self.cache_format % {"scope": self.scope, "ident": ident}


class JoinGroupView(APIView):
    """
    Invite-link join flow.

    GET  /api/groups/join/<token>/ — public; resolve token to group name and role.
    POST /api/groups/join/<token>/ — authenticated; add the requesting user to the group.
    """

    throttle_classes = [JoinGroupRateThrottle]

    def get_permissions(self):
        if self.request.method == "GET":
            return [AllowAny()]
        return [IsAuthenticated(), MustNotHavePendingPasswordChange(), MustNotHavePendingUsernameChange()]

    def get(self, request, token):
        # Truncate token in log to avoid leaking the full value into log files
        # while still making it possible to correlate with an audit trail.
        token_hint = str(token)[:8]
        ip = get_client_ip(request)
        link = GroupInviteLink.lookup_by_token(str(token))
        if link is None:
            return Response(
                {"detail": "Not found."},
                status=status.HTTP_404_NOT_FOUND,
            )
        if link.is_expired:
            logger.info(
                "Invite token lookup failed: expired. token=%s ip=%s",
                token_hint,
                ip,
            )
            return Response(
                {"detail": "This invite link has expired."},
                status=status.HTTP_410_GONE,
            )
        logger.info(
            "Invite token preview. token=%s group_id=%s ip=%s",
            token_hint,
            link.group_id,
            ip,
        )
        return Response({
            "group_id": link.group_id,
            "group_name": link.group.name,
            "role": link.role,
        })

    def post(self, request, token):
        token_hint = str(token)[:8]
        ip = get_client_ip(request)
        link = GroupInviteLink.lookup_by_token(str(token))
        if link is None:
            return Response(
                {"detail": "Not found."},
                status=status.HTTP_404_NOT_FOUND,
            )
        if link.is_expired:
            logger.info(
                "Invite token redemption failed: expired. token=%s user_id=%s ip=%s outcome=failure",
                token_hint,
                request.user.pk,
                ip,
            )
            return Response(
                {"detail": "This invite link has expired."},
                status=status.HTTP_410_GONE,
            )
        # get_or_create: if the user is already a member, their existing role is preserved.
        # Invite links never downgrade or upgrade an existing membership — this is intentional.
        # An admin must explicitly change the role via the members API.
        membership, created = GroupMembership.objects.get_or_create(
            group=link.group,
            user=request.user,
            defaults={"role": link.role},
        )
        logger.info(
            "Invite token redeemed. token=%s group_id=%s user_id=%s new_member=%s ip=%s outcome=success",
            token_hint,
            link.group_id,
            request.user.pk,
            created,
            ip,
        )
        group_data = GroupSerializer(link.group).data
        return Response(group_data, status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)
