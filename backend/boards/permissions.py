import logging

from rest_framework.permissions import BasePermission
from .models import BoardMembership

logger = logging.getLogger(__name__)

SITE_ADMIN = "site_admin"

# Maximum number of ancestor levels walked during group-based permission checks.
# The cap exists to prevent unbounded query chains on deeply nested group trees
# (e.g. a cycle caused by a data bug, or a legitimate but very deep hierarchy).
# Six levels is generous for real-world usage; if a hierarchy legitimately
# exceeds this depth, memberships at levels 7+ will not be honored and a
# warning will be emitted so operators can detect the truncation.
_GROUP_TRAVERSAL_MAX_DEPTH = 6


def get_board_role(user, board):
    """Return the effective role of *user* on *board*, or None if they have no access.

    Precedence (highest to lowest):
      1. Site admins — always return SITE_ADMIN regardless of explicit membership.
      2. Board owner — implicitly ADMIN even without a BoardMembership row.
      3. Explicit BoardMembership — takes priority over any group-inherited role.
      4. Group-inherited — walk up the group ancestor chain (capped at
         _GROUP_TRAVERSAL_MAX_DEPTH levels to prevent runaway queries on deep
         trees) and return the first match found.

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
        while node and depth < _GROUP_TRAVERSAL_MAX_DEPTH:
            try:
                return node.memberships.get(user=user).role
            except GroupMembership.DoesNotExist:
                node = node.parent
                depth += 1
        if node is not None:
            # We exited the loop because we hit the depth cap, not because we
            # reached the root.  This means some ancestor memberships were NOT
            # checked.  Emit a warning so operators can detect overly deep
            # group trees that may be masking legitimate access.
            logger.warning(
                "Group ancestry traversal capped at depth %d for board %s (group %s). "
                "Memberships at deeper levels were not evaluated.",
                _GROUP_TRAVERSAL_MAX_DEPTH,
                board.pk,
                board.group_id,
            )
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
