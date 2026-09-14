"""MCP tool implementations.

Tools return plain Python dicts and take plain arguments — no MCP SDK types
appear here. The SDK-facing registration lives in :mod:`mcp_server.server`, so
an SDK API change is a one-file edit there rather than a rewrite of every tool
(#511). Later tool waves (#512 CRUD, #513 resources) add functions here and
register them there, and inherit authentication from the transport middleware
without writing any auth code of their own.
"""
from django.db.models import Count, Q

from boards.models import Board, BoardMembership
from boards.permissions import SITE_ADMIN, _GROUP_TRAVERSAL_MAX_DEPTH
from groups.models import GroupMembership, get_accessible_group_ids

from .context import get_current_user

# Depth of the group ancestor chain pre-loaded via select_related, so the
# in-Python walk below never triggers a lazy FK fetch. Matches the cap
# get_board_role() applies.
_GROUP_SELECT_RELATED = "__".join(
    ["group"] + ["parent"] * _GROUP_TRAVERSAL_MAX_DEPTH
)


def _resolve_roles(user, boards, memberships_by_board, group_roles):
    """Resolve every board's effective role without a query per board.

    This mirrors the precedence documented on
    ``boards.permissions.get_board_role`` — site admin, then owner, then
    explicit membership, then the nearest group ancestor the user belongs to —
    and must be kept in step with it.

    It exists because ``get_board_role`` resolves ONE board: it consults a
    prefetched membership list, but still issues a GroupMembership query per
    board for group-derived access, which is an N+1 across a board list. Here
    both membership sources are pre-loaded once and the ancestor chain is
    walked in memory against ``select_related`` data.
    """
    roles = {}
    for board in boards:
        if user.can_access_all_content:
            roles[board.id] = SITE_ADMIN
            continue
        if board.owner_id == user.id:
            roles[board.id] = BoardMembership.Role.ADMIN
            continue

        membership = memberships_by_board.get(board.id)
        if membership is not None:
            # An explicit per-board membership always wins over an inherited one.
            roles[board.id] = membership.role
            continue

        # Walk up the group chain; the closest ancestor the user belongs to
        # wins, matching get_board_role's first-match-from-the-board behavior.
        role = None
        node = board.group
        depth = 0
        while node is not None and depth < _GROUP_TRAVERSAL_MAX_DEPTH:
            if node.pk in group_roles:
                role = group_roles[node.pk]
                break
            node = node.parent
            depth += 1
        roles[board.id] = role
    return roles


def _serialize_board(board, role):
    """Shape one board for the MCP wire format.

    ``id`` is the integer pk, matching how the REST API addresses boards, so a
    future write tool (#512) can reuse the identifier a caller already holds.
    """
    return {
        "id": board.id,
        "uid": board.uid,
        "name": board.name,
        "description": board.description,
        "role": role,
        "column_count": board._column_count,
        "swimlane_count": board._swimlane_count,
        "card_count": board._card_count,
        "created_at": board.created_at.isoformat(),
        "updated_at": board.updated_at.isoformat(),
    }


def list_boards():
    """Return every board the authenticated MCP caller can access.

    The access rule deliberately mirrors ``BoardViewSet.get_queryset()``
    exactly — ownership, direct membership, group-inherited access, and the
    site-admin bypass — rather than the narrower "has a BoardMembership row"
    reading. A board a user can open in the web UI but which the tool omits
    would be silently invisible to an AI agent acting on their behalf, which is
    a correctness bug, not a conservative default.

    ``role`` is therefore the *effective* role from ``get_board_role()``, not a
    raw ``BoardMembership.role`` column: it is ``"admin"`` for an owner with no
    membership row, the inherited role for group-derived access, and
    ``"site_admin"`` for a user with ``can_access_all_content``.
    """
    user = get_current_user()

    if user.can_access_all_content:
        qs = Board.objects.all()
    else:
        qs = Board.objects.filter(
            Q(owner=user) |
            Q(memberships__user=user) |
            Q(group__in=get_accessible_group_ids(user))
        ).distinct()

    # distinct=True on every Count is load-bearing, not defensive. columns,
    # swimlanes and cards are three INDEPENDENT one-to-many children of Board,
    # so the three LEFT OUTER JOINs cross-multiply before aggregation: without
    # it a board with 5 columns, 3 swimlanes and 10 cards reports 150 for all
    # three counts. card_count excludes archived cards to match the count the
    # REST board list reports.
    qs = qs.select_related(_GROUP_SELECT_RELATED).annotate(
        _column_count=Count("columns", distinct=True),
        _swimlane_count=Count("swimlanes", distinct=True),
        _card_count=Count(
            "cards", filter=Q(cards__archived_at__isnull=True), distinct=True
        ),
    )

    boards = list(qs)

    # Two batched lookups replace what would otherwise be several queries per
    # board: the caller's own board memberships, and their group memberships.
    # Both are filtered to `user` before use, so a role can never be read from
    # another user's row.
    memberships_by_board = {
        m.board_id: m
        for m in BoardMembership.objects.filter(
            board__in=boards, user=user
        ).only("board_id", "user_id", "role", "is_moderator")
    }
    group_roles = dict(
        GroupMembership.objects.filter(user=user).values_list("group_id", "role")
    )

    roles = _resolve_roles(user, boards, memberships_by_board, group_roles)

    results = []
    for board in boards:
        role = roles[board.id]
        if role is None:
            # Reachable for a board whose group is an *ancestor* of one the
            # user belongs to: get_accessible_group_ids() includes ancestors so
            # the sidebar tree can be navigated, but they confer no role. Such a
            # board is not really readable, so omit it rather than report a
            # null role.
            continue
        results.append(_serialize_board(board, role))
    return results
