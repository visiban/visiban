from rest_framework.permissions import BasePermission
from .models import BoardMembership


SITE_ADMIN = "site_admin"


def get_board_role(user, board):
    """Return the effective role of *user* on *board*, or None if they have no access.

    Precedence (highest to lowest):
      1. Site admins — always return SITE_ADMIN regardless of explicit membership.
      2. Board owner — implicitly ADMIN even without a BoardMembership row.
      3. Explicit BoardMembership — takes priority over any group-inherited role.
      4. Group-inherited — walk up the group ancestor chain (capped at 6 levels to
         prevent runaway queries on deep trees) and return the first match found.

    Returns None if the user has no access at any level.
    """
    if user.is_site_admin:
        return SITE_ADMIN
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
    """Allow any board member (including owner and site admins)."""
    def has_object_permission(self, request, view, obj):
        board = getattr(obj, "board", obj)
        return get_board_role(request.user, board) is not None


class IsBoardAdminOrOwner(BasePermission):
    """Allow only board admins, site admins, or the owner."""
    def has_object_permission(self, request, view, obj):
        board = getattr(obj, "board", obj)
        role = get_board_role(request.user, board)
        return role in (BoardMembership.Role.ADMIN, SITE_ADMIN)
