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
from boards.permissions import get_board_role
from groups.models import get_accessible_group_ids

from .context import get_current_user


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
    qs = qs.select_related("owner", "group").annotate(
        _column_count=Count("columns", distinct=True),
        _swimlane_count=Count("swimlanes", distinct=True),
        _card_count=Count(
            "cards", filter=Q(cards__archived_at__isnull=True), distinct=True
        ),
    )

    # get_board_role() reads board._prefetched_memberships when present, so
    # priming it here resolves every role without a per-board query.
    boards = list(qs)
    memberships = BoardMembership.objects.filter(
        board__in=boards, user=user
    ).only("board_id", "user_id", "role", "is_moderator")
    by_board = {}
    for membership in memberships:
        by_board.setdefault(membership.board_id, []).append(membership)
    for board in boards:
        board._prefetched_memberships = by_board.get(board.id, [])

    results = []
    for board in boards:
        role = get_board_role(user, board)
        if role is None:
            # Defensive: the queryset above should already exclude these.
            continue
        results.append(_serialize_board(board, role))
    return results
