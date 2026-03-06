from rest_framework.permissions import BasePermission
from .models import BoardMembership


def get_board_role(user, board):
    if board.owner_id == user.id:
        return BoardMembership.Role.ADMIN
    # Explicit per-board membership overrides group membership
    try:
        return board.memberships.get(user=user).role
    except BoardMembership.DoesNotExist:
        pass
    # Walk up the group ancestor chain
    if board.group_id:
        from groups.models import GroupMembership
        node = board.group
        depth = 0
        while node and depth < 6:
            try:
                return node.memberships.get(user=user).role
            except GroupMembership.DoesNotExist:
                node = node.parent
                depth += 1
    return None


class IsBoardMember(BasePermission):
    """Allow any board member (including owner)."""
    def has_object_permission(self, request, view, obj):
        board = getattr(obj, "board", obj)
        return get_board_role(request.user, board) is not None


class IsBoardAdminOrOwner(BasePermission):
    """Allow only board admins or the owner."""
    def has_object_permission(self, request, view, obj):
        board = getattr(obj, "board", obj)
        role = get_board_role(request.user, board)
        return role == BoardMembership.Role.ADMIN
