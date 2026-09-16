"""Shared helper functions and constants used across multiple view modules.

This module is internal to the views package — it is not re-exported from
``boards.views.__init__``. External code that needs ``_sanitize_csv_field``
or ``_validate_upload_mime`` imports them from ``boards.views`` which
re-exports them from the appropriate submodule.
"""

import logging

# rest_framework.generics.get_object_or_404, NOT django.shortcuts' — DRF's
# wrapper additionally catches TypeError/ValueError/ValidationError and
# re-raises them as Http404 (see rest_framework/generics.py). Every pk here
# comes straight from a URL path segment, and board_id in particular is an
# IntegerField pk: a non-numeric board_pk (e.g. schemathesis fuzzing the
# path) hits django.shortcuts.get_object_or_404 with a raw, uncaught
# ValueError -> unhandled 500 instead of the documented 404 (#1120 baseline
# finding — every nested board-resource viewset routes board_pk resolution
# through this one function, so fixing it here was the single highest-yield
# fix for that finding).
from rest_framework.generics import get_object_or_404
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db.models import Prefetch, Q
from django_filters import NumberFilter
from rest_framework.exceptions import PermissionDenied

from ..models import Board, BoardFavorite, BoardMembership, Card

# 64-bit signed integer bounds — every id-backed model in this codebase is a
# plain AutoField/BigAutoField pk, and both SQLite's integer parameter
# binding and Postgres's bigint are 64-bit. No real id is ever outside this
# range, so bounding a NumberFilter to it is a pure robustness fix.
_INT64_MIN = -(2**63)
_INT64_MAX = 2**63 - 1


class BoundedIdFilter(NumberFilter):
    """A NumberFilter for an id/pk field, bounded to the 64-bit integer range.

    ``django_filters.NumberFilter``'s own default max validator
    (``MaxValueValidator(1e50)``) is far looser than what the database can
    actually store: a filter value outside the 64-bit range (e.g.
    ``?column=1.03e34``) reaches the DB driver's parameter binding and raises
    ``OverflowError``, uncaught, as an unhandled 500 instead of the
    documented 400 — a `backend-schema-fuzz` CI job baseline finding (#1120).
    Use this in place of a bare ``NumberFilter`` for any filter whose
    ``field_name`` targets an id/pk column.
    """

    def get_max_validator(self):
        return MaxValueValidator(_INT64_MAX)

    @property
    def field(self):
        built = super().field
        if not any(isinstance(v, MinValueValidator) for v in built.validators):
            built.validators.append(MinValueValidator(_INT64_MIN))
        return built
from ..permissions import (
    GROUP_ANCESTOR_SELECT_RELATED,
    can_modify_others_content as _can_modify_others_content,  # noqa: F401
    get_board_role,
)
from ..serializers import CardSerializer, _card_queryset
from ..utils import _get_effective_member_ids, _get_assignable_member_ids

logger = logging.getLogger(__name__)


def get_accessible_boards_queryset(user):
    """Return the Board queryset `user` may access: owned, directly a member of,
    inherited via group ancestry, or — for `can_access_all_content` users — every
    board.

    Factored out of `BoardViewSet.get_queryset()` so the board-list endpoint and
    the cross-board card query endpoint (#1112) share one access-scoping rule
    rather than two copies that can drift. Callers that need board-list-specific
    behavior (the `?starred=` filter, `select_related`/`annotate` for
    `BoardSerializer`) apply that on top of this queryset, same as before.

    Uses `get_group_ids_for_board_access()`, NOT `get_accessible_group_ids()`.
    The latter also walks UP to a user's ancestor groups (for sidebar
    navigation — its own docstring calls those ancestors "read-only") and
    `get_board_role()` grants no role via that direction, so using it here
    would let group-inherited access flow upward — a user in a low-level
    subgroup could see (and, via the card query endpoint, read every card of)
    boards belonging to that subgroup's ancestors, where `get_board_role()`
    would return None (#1112 rbac-check finding).
    """
    from groups.models import get_group_ids_for_board_access

    if user.can_access_all_content:
        return Board.objects.all()
    return Board.objects.filter(
        Q(owner=user) |
        Q(memberships__user=user) |
        Q(group__in=get_group_ids_for_board_access(user))
    ).distinct()


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
        # Shared with get_board_roles() rather than spelled out here, so a
        # change to _GROUP_TRAVERSAL_MAX_DEPTH cannot leave one copy of the
        # ancestor chain shorter than the ladder that walks it (#1107).
        GROUP_ANCESTOR_SELECT_RELATED,
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


# _can_modify_others_content moved to boards.permissions.can_modify_others_content
# in #1107 so boards.services can call it without importing from the views
# package (which would invert the layering and risk an import cycle). It is
# imported above under its original private name so every existing caller in
# this package — and boards.views.__init__'s re-export, which tests patch —
# keeps working unchanged.


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
