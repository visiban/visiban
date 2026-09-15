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

# select_related path that pre-loads the whole group ancestor chain the role
# ladder walks, so the in-Python traversal below never triggers a lazy FK fetch.
# Callers of get_board_roles() should apply this to their queryset; without it
# the walk is an N+1 across the ancestor levels of every board.
GROUP_ANCESTOR_SELECT_RELATED = "__".join(
    ["group"] + ["parent"] * _GROUP_TRAVERSAL_MAX_DEPTH
)


# ---------------------------------------------------------------------------
# Role precedence ladder
#
# The ladder itself lives in the three helpers below so that the single-board
# and bulk resolvers cannot drift apart (#1107). Before this split,
# mcp_server/tools.py::_resolve_roles carried a second copy of the precedence
# rules with a "must be kept in step with it" comment — an admission that
# nothing enforced it. Both public resolvers now delegate here; only the way
# they *load* memberships differs, which is the part that genuinely has to
# (one board at a time vs. batched), and which is why the helpers take their
# sources as arguments rather than querying.
# ---------------------------------------------------------------------------

def _role_before_groups(user, board, explicit_membership):
    """Apply the first three rungs of the ladder.

    Returns ``(role, decided)``. ``decided`` is False only when the answer
    depends on group-inherited access, which the two callers resolve
    differently.

    Caches a found membership on the board as ``_cached_membership`` so
    ``can_modify_others_content`` can reuse it without a second query — the
    same side effect ``get_board_role`` has always had. Consumers of that cache
    must confirm it belongs to the user they are asking about; see
    ``can_modify_others_content``.
    """
    # can_access_all_content wins outright. Note that is_site_admin alone does
    # NOT grant board access; it only gates the /api/admin/* routes.
    if user.can_access_all_content:
        return SITE_ADMIN, True
    # Board owner is implicitly ADMIN even without a BoardMembership row.
    if board.owner_id == user.id:
        return BoardMembership.Role.ADMIN, True
    # Explicit per-board membership overrides any group-inherited role.
    if explicit_membership is not None:
        board._cached_membership = explicit_membership
        return explicit_membership.role, True
    return None, False


def _group_ancestor_ids(board):
    """Return the board's group ancestor ids, nearest first, capped at
    ``_GROUP_TRAVERSAL_MAX_DEPTH``.

    Relies on the ``group__parent__parent…`` select_related chain applied by
    ``get_board_for_user`` / ``GROUP_ANCESTOR_SELECT_RELATED``, so the
    ``.parent`` traversal hits the ORM cache rather than the database. Emits a
    warning when the chain is deeper than the cap so operators can detect that
    memberships at deeper levels were not evaluated.
    """
    if not board.group_id:
        return []
    ancestor_ids = []
    node = board.group
    depth = 0
    while node and depth < _GROUP_TRAVERSAL_MAX_DEPTH:
        ancestor_ids.append(node.pk)
        node = node.parent
        depth += 1
    if node is not None:
        logger.warning(
            "Group ancestry traversal capped at depth %d for board %s (group %s). "
            "Memberships at deeper levels were not evaluated.",
            _GROUP_TRAVERSAL_MAX_DEPTH,
            board.pk,
            board.group_id,
        )
    return ancestor_ids


def _stamp_resolved_role(board, user, role):
    """Record on the board instance which role was resolved, and for whom.

    Services accept an already-resolved role so an adapter that has just
    resolved it does not pay for it twice. That parameter is only safe if a
    wrong value cannot be believed, so the resolvers leave this memo behind and
    ``boards.services.cards._resolve_role`` refuses any role that does not
    match it — see that function. The memo carries the user id as well as the
    role, so neither another user's role nor another board's role can satisfy
    it.

    Set by the resolvers alone. It is a memo of work already done, never an
    input: a caller cannot widen its own access by supplying one, because a
    mismatch makes the service derive the role from the database instead.
    """
    board._resolved_role = (user.id, role)
    return role


def _nearest_ancestor_role(ancestor_ids, group_roles):
    """Return the role from the closest ancestor group the user belongs to.

    ``ancestor_ids`` is ordered nearest-first, so the first hit wins.
    """
    for gid in ancestor_ids:
        if gid in group_roles:
            return group_roles[gid]
    return None


def get_board_role(user, board):
    """Return the effective role of *user* on *board*, or None if they have no access.

    Precedence (highest to lowest):
      1. can_access_all_content — always return SITE_ADMIN regardless of explicit membership.
         Note: is_site_admin alone does NOT grant board access; it only gates the /api/admin/* routes.
      2. Board owner — implicitly ADMIN even without a BoardMembership row.
      3. Explicit BoardMembership — takes priority over any group-inherited role.
      4. Group-inherited — walk up the group ancestor chain (capped at
         _GROUP_TRAVERSAL_MAX_DEPTH levels to prevent runaway queries on deep
         trees) and return the first match found.

    Returns None if the user has no access at any level.

    The ladder itself is in ``_role_before_groups`` / ``_group_ancestor_ids`` /
    ``_nearest_ancestor_role``, shared with ``get_board_roles``. What is local
    to this function is only *how* the two membership sources are loaded: one
    board's explicit membership from the prefetch cache or a single live query,
    and the group memberships scoped to that board's ancestors.
    """
    # Explicit per-board membership: use the prefetch cache populated by
    # get_board_for_user() when available to avoid a redundant live query on
    # every board-scoped request.
    explicit = None
    prefetched = getattr(board, "_prefetched_memberships", None)
    if prefetched is not None:
        for m in prefetched:
            if m.user_id == user.id:
                explicit = m
                break
        # Not found in the prefetched list — no explicit per-board membership.
    elif not user.can_access_all_content and board.owner_id != user.id:
        # Only worth a query when the first two rungs cannot already decide it.
        try:
            explicit = board.memberships.get(user=user)
        except BoardMembership.DoesNotExist:
            explicit = None

    role, decided = _role_before_groups(user, board, explicit)
    if decided:
        return _stamp_resolved_role(board, user, role)

    ancestor_ids = _group_ancestor_ids(board)
    if not ancestor_ids:
        return _stamp_resolved_role(board, user, None)

    # Load all matching memberships in one round-trip. Scoped to this board's
    # ancestors rather than to every group the user belongs to, because this
    # resolver runs on the hot single-board path.
    from groups.models import GroupMembership

    group_roles = {
        gm.group_id: gm.role
        for gm in GroupMembership.objects.filter(
            group_id__in=ancestor_ids, user=user
        )
    }
    return _stamp_resolved_role(
        board, user, _nearest_ancestor_role(ancestor_ids, group_roles)
    )


def get_board_roles(user, boards):
    """Return ``{board_id: effective_role_or_None}`` for *boards* in bulk.

    Same precedence as :func:`get_board_role` — it shares the ladder helpers —
    but resolves an arbitrary number of boards in a **fixed two queries** (zero
    for a ``can_access_all_content`` user) instead of one to several per board.

    Use this wherever a role is needed for a *list* of boards. Calling
    ``get_board_role`` in a loop is an N+1 on any board that derives its role
    from a group, and re-implementing the ladder to avoid that is how
    ``mcp_server/tools.py::_resolve_roles`` came to carry a second copy of
    these rules (#1107).

    *boards* must be loaded with :data:`GROUP_ANCESTOR_SELECT_RELATED` applied
    (``get_board_for_user`` already does the equivalent). Without it the
    ancestor walk lazily fetches each ``.parent`` and the N+1 this function
    exists to remove reappears one level down.

    A ``None`` value means the user has no access to that board at all — which
    is not the same as "not in the dict". Every board passed in gets a key.
    """
    boards = list(boards)
    if not boards:
        return {}

    # Short-circuit: a can_access_all_content user is SITE_ADMIN everywhere, so
    # neither membership lookup can change the answer.
    if user.can_access_all_content:
        return {
            board.pk: _stamp_resolved_role(board, user, SITE_ADMIN)
            for board in boards
        }

    from groups.models import GroupMembership

    # Two batched lookups replace what would otherwise be several queries per
    # board. Both are filtered to `user` before use, so a role can never be
    # read from another user's row.
    memberships_by_board = {
        m.board_id: m
        for m in BoardMembership.objects.filter(
            board__in=boards, user=user
        ).only("board_id", "user_id", "role", "is_moderator")
    }
    # Scoped to the user rather than to these boards' ancestors: one query for
    # the whole batch, where per-board ancestor scoping would need either one
    # query per board or an ancestor set assembled up front.
    group_roles = dict(
        GroupMembership.objects.filter(user=user).values_list("group_id", "role")
    )

    roles = {}
    for board in boards:
        role, decided = _role_before_groups(
            user, board, memberships_by_board.get(board.pk)
        )
        if not decided:
            role = _nearest_ancestor_role(
                _group_ancestor_ids(board), group_roles
            )
        roles[board.pk] = _stamp_resolved_role(board, user, role)
    return roles


def can_modify_others_content(board, role, user):
    """Return True if the user may edit/delete/archive content created by others.

    Admins, site admins, and board owners always can. Members with the
    ``is_moderator`` flag can. Regular members and collaborators cannot.

    Uses the membership cached by ``get_board_role`` when available to avoid a
    redundant database query.

    Note: board admins unconditionally return True here — they can edit or
    delete any card on the board regardless of who created it. This is
    intentional; the role table says "Member (own) / Admin (any)" for edit.

    Lives here rather than in ``boards.views._helpers`` (where it was defined
    until #1107) because it is an authorization predicate, and
    ``boards.services`` needs it — a service importing from the views package
    would invert the layering and risk an import cycle. ``boards.views._helpers``
    re-exports it under its old private name for existing callers.
    """
    if role in (BoardMembership.Role.ADMIN, SITE_ADMIN):
        return True
    if board.owner_id == user.id:
        return True
    membership = getattr(board, "_cached_membership", None)
    # Verify whose membership the cache holds before trusting its moderator
    # flag. The prefetch branch below has always checked `user_id`; this branch
    # did not, which was safe only because exactly one board instance carried a
    # stamp at a time. `get_board_roles` now stamps a whole batch of boards in a
    # loop, so an unchecked fast path here would be a moderator-flag escalation
    # waiting for its first caller. On the hot path the ids match and this costs
    # nothing; on a mismatch we fall through to the scan and the live query,
    # which are correct rather than fast (security-review, #1107).
    if membership is not None and membership.user_id == user.id:
        return membership.is_moderator
    # _prefetched_memberships is loaded by get_board_for_user() — scan it first
    # before issuing a live query on every mutation request.
    prefetched = getattr(board, "_prefetched_memberships", None)
    if prefetched is not None:
        for m in prefetched:
            if m.user_id == user.id:
                return m.is_moderator
        return False
    try:
        membership = BoardMembership.objects.get(board=board, user=user)
        return membership.is_moderator
    except BoardMembership.DoesNotExist:
        return False


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
