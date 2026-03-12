from django.shortcuts import get_object_or_404
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated, AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Group, GroupMembership, GroupInviteLink
from .serializers import GroupSerializer, GroupMembershipSerializer, GroupInviteLinkSerializer


def _require_group_admin(user, group):
    """Raise PermissionDenied if user is not an admin of this group."""
    from rest_framework.exceptions import PermissionDenied
    if getattr(user, "is_site_admin", False):
        return
    if group.owner_id == user.id:
        return
    try:
        membership = group.memberships.get(user=user)
        if membership.role != GroupMembership.Role.ADMIN:
            raise PermissionDenied
    except GroupMembership.DoesNotExist:
        raise PermissionDenied


def _require_group_member(user, group):
    """Raise PermissionDenied if user is not a member of this group or any ancestor."""
    from rest_framework.exceptions import PermissionDenied
    if getattr(user, "is_site_admin", False):
        return
    if group.owner_id == user.id:
        return
    # Walk up the ancestor chain
    node = group
    depth = 0
    while node and depth < 6:
        if node.memberships.filter(user=user).exists():
            return
        node = node.parent
        depth += 1
    raise PermissionDenied


class GroupViewSet(viewsets.ModelViewSet):
    permission_classes = [IsAuthenticated]
    serializer_class = GroupSerializer

    def get_queryset(self):
        from .models import get_accessible_group_ids
        user = self.request.user
        return Group.objects.filter(
            id__in=get_accessible_group_ids(user)
        ).select_related("owner", "parent")

    def perform_create(self, serializer):
        parent = serializer.validated_data.get("parent")
        if parent is not None:
            _require_group_admin(self.request.user, parent)
        group = serializer.save(owner=self.request.user)
        GroupMembership.objects.create(
            group=group, user=self.request.user, role=GroupMembership.Role.ADMIN
        )

    def destroy(self, request, *args, **kwargs):
        group = self.get_object()
        if group.owner != request.user and not getattr(request.user, "is_site_admin", False):
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
        memberships = group.memberships.select_related("user")
        return Response(GroupMembershipSerializer(memberships, many=True).data)

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
        return Response(GroupSerializer(group.subgroups.all(), many=True).data)

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
            boards = Board.objects.filter(group=group).select_related("owner")
            return Response(BoardSerializer(boards, many=True).data)

        # POST — create a new board inside this group
        _require_group_admin(request.user, group)
        serializer = BoardSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        board = serializer.save(owner=request.user, group=group)

        default_columns = [
            ("Backlog", "#6B7280"),
            ("To Do",   "#3B82F6"),
            ("Doing",   "#F59E0B"),
            ("Done",    "#10B981"),
        ]
        Column.objects.bulk_create([
            Column(board=board, name=name, position=i, color=color, allow_card_creation=(i == 0))
            for i, (name, color) in enumerate(default_columns)
        ])
        Swimlane.objects.create(board=board, name="General", position=0, color="#6B7280")

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
    # Invite link
    # ------------------------------------------------------------------

    @action(detail=True, methods=["post", "delete"], url_path="invite-link")
    def invite_link(self, request, pk=None):
        group = self.get_object()
        _require_group_admin(request.user, group)

        if request.method == "POST":
            link, _ = GroupInviteLink.objects.get_or_create(
                group=group, is_active=True,
                defaults={"created_by": request.user},
            )
            return Response(GroupInviteLinkSerializer(link).data, status=status.HTTP_200_OK)

        # DELETE — deactivate all active links
        GroupInviteLink.objects.filter(group=group, is_active=True).update(is_active=False)
        return Response(status=status.HTTP_204_NO_CONTENT)


class JoinGroupView(APIView):
    """
    GET  /api/groups/join/<token>/  — public: resolve token to group name
    POST /api/groups/join/<token>/  — authenticated: join the group
    """

    def get_permissions(self):
        if self.request.method == "GET":
            return [AllowAny()]
        return [IsAuthenticated()]

    def get(self, request, token):
        link = get_object_or_404(GroupInviteLink, token=token, is_active=True)
        return Response({
            "group_id": link.group_id,
            "group_name": link.group.name,
        })

    def post(self, request, token):
        link = get_object_or_404(GroupInviteLink, token=token, is_active=True)
        membership, created = GroupMembership.objects.get_or_create(
            group=link.group,
            user=request.user,
            defaults={"role": GroupMembership.Role.MEMBER},
        )
        group_data = GroupSerializer(link.group).data
        return Response(group_data, status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)
