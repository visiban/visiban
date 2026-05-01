"""Shared helper functions and constants used across multiple view modules.

This module is internal to the views package — it is not re-exported from
``boards.views.__init__``. External code that needs ``_sanitize_csv_field``
or ``_validate_upload_mime`` imports them from ``boards.views`` which
re-exports them from the appropriate submodule.
"""

import logging

from django.shortcuts import get_object_or_404
from django.db.models import Prefetch
from rest_framework.exceptions import PermissionDenied

from ..models import Board, BoardFavorite, BoardMembership, Card
from ..permissions import get_board_role, SITE_ADMIN
from ..serializers import CardSerializer, _card_queryset
from ..utils import _get_effective_member_ids, _get_assignable_member_ids

logger = logging.getLogger(__name__)


def get_board_for_user(board_id, user, *, slim=False):
    """Return (board, role) for board_id if user has access; raise 404 or 403 otherwise.

    Loads the board with select_related for owner and the group ancestor chain
    (up to 6 levels) so that get_board_role() and BoardFullSerializer.get_members()
    can traverse the hierarchy without issuing one query per level.

    Also prefetches the requesting user's BoardFavorite rows (to_attr="_user_favorites")
    so BoardFullSerializer.get_is_starred() avoids a per-request EXISTS query.

    Prefetches memberships with their users (to_attr="_prefetched_memberships") so
    BoardFullSerializer.get_members() reads from cache rather than issuing a live
    select_related query on every /full/ request.

    When ``slim=True`` the favorites, labels, and memberships prefetches are
    skipped (#928).  Use this for read-only aggregate endpoints (e.g. summary,
    analytics) that only need the board PK + RBAC role and never touch
    favorites/labels/members on the board instance.  The group ancestor
    select_related is retained because ``get_board_role`` still walks the
    chain to resolve inherited memberships.
    """
    queryset = Board.objects.select_related(
        "owner",
        "group__parent__parent__parent__parent__parent__parent",
    )
    if not slim:
        queryset = queryset.prefetch_related(
            Prefetch(
                "favorites",
                queryset=BoardFavorite.objects.filter(user=user),
                to_attr="_user_favorites",
            ),
            # Pre-load labels so BoardFullSerializer.get_cards() can call
            # obj.labels.all() and hit the prefetch cache rather than issuing
            # a second Label query alongside the _card_queryset prefetch chain.
            "labels",
            # Pre-load memberships with users so get_members() avoids a live
            # select_related query on every /full/ request.
            Prefetch(
                "memberships",
                queryset=BoardMembership.objects.select_related("user"),
                to_attr="_prefetched_memberships",
            ),
        )
    board = get_object_or_404(queryset, pk=board_id)
    role = get_board_role(user, board)
    if role is None:
        logger.warning(
            "board.access_denied board_id=%s user_id=%s",
            board_id,
            getattr(user, "pk", "anon"),
        )
        raise PermissionDenied
    return board, role


def _can_modify_others_content(board, role, user):
    """Return True if the user may delete/archive content created by other users.

    Admins, site admins, and board owners always can. Members with the
    is_moderator flag can. Regular members and collaborators cannot.

    Uses the cached membership from get_board_role() when available to
    avoid a redundant database query.

    Note: board admins unconditionally return True here — they can edit or
    delete any card on the board regardless of who created it. This is
    intentional; the role table says "Member (own) / Admin (any)" for edit.
    """
    if role in (BoardMembership.Role.ADMIN, SITE_ADMIN):
        return True
    if board.owner_id == user.id:
        return True
    membership = getattr(board, "_cached_membership", None)
    if membership is not None:
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


def _refetched_card_data(card, request, board, *, member_ids=None, assignable_ids=None, labels_qs=None):
    """Re-fetch a card through the prefetch pipeline and serialize it.

    Mutation endpoints modify a card instance that lacks the prefetch
    annotations CardSerializer needs (labels, attachments, checklist_items,
    movements). This helper issues a single query with all prefetches so
    the serializer can resolve related fields without N+1 queries.

    Callers that have already computed the board context for the request
    (e.g. CardViewSet) should pass ``member_ids``, ``assignable_ids``, and
    ``labels_qs`` to avoid re-issuing the same lookups on every mutation —
    without the cache this adds 2–4 extra queries per mutation response.
    ``labels_qs`` defaults to ``board.labels.all()`` which hits the prefetch
    cache populated by ``get_board_for_user`` when the board came through
    that path.
    """
    if member_ids is None:
        member_ids = _get_effective_member_ids(board)
    if assignable_ids is None:
        assignable_ids = _get_assignable_member_ids(board)
    if labels_qs is None:
        labels_qs = board.labels.all()
    refetched = _card_queryset(Card.objects.filter(pk=card.pk)).get()
    return CardSerializer(
        refetched,
        context={
            "request": request,
            "board": board,
            "_member_ids": member_ids,
            "_assignable_member_ids": assignable_ids,
            "_board_labels_qs": labels_qs,
        },
    ).data
