"""Shared helper functions and constants used across multiple view modules.

This module is internal to the views package — it is not re-exported from
``boards.views.__init__``. External code that needs ``_sanitize_csv_field``
or ``_validate_upload_mime`` imports them from ``boards.views`` which
re-exports them from the appropriate submodule.
"""

from django.shortcuts import get_object_or_404
from django.db.models import Prefetch
from rest_framework.exceptions import PermissionDenied

from ..models import Board, BoardFavorite, BoardMembership, Card
from ..permissions import get_board_role, SITE_ADMIN
from ..serializers import CardSerializer, _card_queryset


def get_board_for_user(board_id, user):
    """Return (board, role) for board_id if user has access; raise 404 or 403 otherwise.

    Loads the board with select_related for owner and the group ancestor chain
    (up to 6 levels) so that get_board_role() and BoardFullSerializer.get_members()
    can traverse the hierarchy without issuing one query per level.

    Also prefetches the requesting user's BoardFavorite rows (to_attr="_user_favorites")
    so BoardFullSerializer.get_is_starred() avoids a per-request EXISTS query.
    """
    board = get_object_or_404(
        Board.objects.select_related(
            "owner",
            "group__parent__parent__parent__parent__parent__parent",
        ).prefetch_related(
            Prefetch(
                "favorites",
                queryset=BoardFavorite.objects.filter(user=user),
                to_attr="_user_favorites",
            )
        ),
        pk=board_id,
    )
    role = get_board_role(user, board)
    if role is None:
        raise PermissionDenied
    return board, role


def _can_modify_others_content(board, role, user):
    """Return True if the user may delete/archive content created by other users.

    Admins, site admins, and board owners always can. Members with the
    is_moderator flag can. Regular members and collaborators cannot.

    Uses the cached membership from get_board_role() when available to
    avoid a redundant database query.
    """
    if role in (BoardMembership.Role.ADMIN, SITE_ADMIN):
        return True
    if board.owner_id == user.id:
        return True
    membership = getattr(board, "_cached_membership", None)
    if membership is not None:
        return membership.is_moderator
    try:
        membership = BoardMembership.objects.get(board=board, user=user)
        return membership.is_moderator
    except BoardMembership.DoesNotExist:
        return False


def _refetched_card_data(card, request, board):
    """Re-fetch a card through the prefetch pipeline and serialize it.

    Mutation endpoints modify a card instance that lacks the prefetch
    annotations CardSerializer needs (labels, attachments, checklist_items,
    movements). This helper issues a single query with all prefetches so
    the serializer can resolve related fields without N+1 queries.
    """
    refetched = _card_queryset(Card.objects.filter(pk=card.pk)).get()
    return CardSerializer(refetched, context={"request": request, "board": board}).data
