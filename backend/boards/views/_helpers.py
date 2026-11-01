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
import datetime

from django.core.exceptions import ValidationError
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db.models import Count, Exists, IntegerField, OuterRef, Prefetch, Q, Subquery
from django.db.models.functions import Coalesce
from django_filters import DateTimeFilter, NumberFilter
from drf_spectacular.utils import OpenApiResponse, inline_serializer
from rest_framework import serializers as _drf_serializers
from rest_framework.exceptions import (
    APIException, NotFound, ValidationError as _DRFValidationError,
)

from visiban.request_shape import id_in_db_range

from ..models import Board, BoardFavorite, BoardMembership, Card, Column
from ..permissions import (
    GROUP_ANCESTOR_SELECT_RELATED,
    can_modify_others_content as _can_modify_others_content,  # noqa: F401
    get_board_role,
)
from ..serializers import CardSerializer, _card_queryset
from ..services import cards as _card_services
from ..services.errors import ContainerChanged
from ..utils import _get_effective_member_ids, _get_assignable_member_ids

logger = logging.getLogger(__name__)

# 64-bit signed integer bounds — every id-backed model in this codebase is a
# plain AutoField/BigAutoField pk, and both SQLite's integer parameter
# binding and Postgres's bigint are 64-bit. No real id is ever outside this
# range, so bounding a NumberFilter to it is a pure robustness fix.
_INT64_MIN = -(2**63)
_INT64_MAX = 2**63 - 1


class _ContainerChangedConflict(APIException):
    """DRF carrier for ``ContainerChanged``: a ``409`` with its exact body."""

    status_code = 409

    def __init__(self, exc):
        super().__init__(detail=exc.body())


# The 409 a column, swimlane or board DELETE answers when lock_container_cascade
# exhausts its retries (#1602). One shared object so the three endpoints
# declare the same ``ContainerChangedConflict`` component.
CONTAINER_CHANGED_409 = OpenApiResponse(
    description=(
        "`container_changed` — cards kept being created in, or moved into, the "
        "container while it was being deleted. Nothing was deleted; retry."
    ),
    response=inline_serializer(
        name="ContainerChangedConflict",
        fields={
            "code": _drf_serializers.CharField(),
            "detail": _drf_serializers.CharField(),
        },
    ),
)


def missing_limit_columns(board_id, column_ids):
    """The ids in a swimlane's ``limit_column_ids`` that are no longer columns
    of the board (#1150), read now.

    Shared by the REST swimlane save (which answers 400) and the Django admin
    swimlane save (which drops them), both called once the board row is held.
    A column delete holds that row from the start of its cascade, so what this
    reads stays true until the caller's save commits; an id a delete removed
    meanwhile would otherwise be stored behind the delete's own cleanup
    (``prune_swimlane_limit_columns``).
    """
    if not column_ids:
        return []
    live = set(Column.objects.filter(board_id=board_id, pk__in=column_ids).values_list("pk", flat=True))
    return [pk for pk in column_ids if pk not in live]


def lock_board_row_or_404(board, *, no_key=False):
    """Lock ``board``'s row for a board-scoped write, or answer 404 if it is gone.

    Every view that serializes on the board row goes through here: column and
    swimlane create and reorder, card and swimlane custom-field definition
    create and reorder, label create, saved-filter create, star, member add
    and removal, the invite caps (shareable link and emailed invite create),
    and the invite join (``JoinBoardView.post``, before the invite row, #1631;
    the registration path takes the same lock through
    ``boards.invites.lock_invite_board``). Updates
    and deletes of one column, swimlane, label or definition take this lock
    ``FOR NO KEY UPDATE`` and then their own row, through
    ``lock_board_and_row_or_404``. A board delete holds that row from the start of its
    cascade (#1602), so a request queued on it finds the row deleted once it
    is granted. A bare ``.get()`` turned that into ``Board.DoesNotExist`` (a
    500), and a bare ``.first()`` let the request go on to insert a row
    whose deferred board foreign key then failed at COMMIT (also a 500).
    The caller keeps its own lock mode through ``no_key``.
    """
    locked = Board.objects.select_for_update(no_key=no_key).filter(pk=board.pk).first()
    if locked is None:
        raise NotFound()
    return locked


def lock_board_and_row_or_404(board, model, pk):
    """Lock the board row, then one of its column, swimlane, label or custom
    field definition rows, for an UPDATE or DELETE of that row; answer 404 if
    either is gone or the row is not on this board (#1602).

    Board -> row, the order column reorder takes. Every container delete
    holds the board row from its start, so an UPDATE writer queued behind
    one finds the board (or the deleted column/swimlane) gone once granted.
    Without the locks it waited on the row itself and then either fell back
    to an INSERT (``serializer.save()`` when the UPDATE matched no row:
    a resurrected row, or an IntegrityError reported as a misleading 400)
    or raised on ``save(update_fields=...)`` (a 500). ``FOR NO KEY UPDATE``
    on both: it is the mode the UPDATE itself takes, so it adds no new
    conflict, and it never blocks a card insert's ``FOR KEY SHARE``.
    """
    lock_board_row_or_404(board, no_key=True)
    rows = model.objects.select_for_update(no_key=True).filter(pk=pk)
    # Scope the row to the board (defense in depth): a pk that belongs to
    # another board answers 404 rather than locking, and then writing, a row
    # this board does not own.
    if any(f.name == "board" for f in model._meta.concrete_fields):
        rows = rows.filter(board_id=board.pk)
    if rows.first() is None:
        raise NotFound()


def require_present_or_404(*querysets):
    """Answer 404 when any of ``querysets`` matches no row (#1602).

    Called after a container delete has taken its locks. A delete that queued
    behind another delete of the same board, column or swimlane is granted
    its locks once that delete committed; ``instance.delete()`` then removes
    nothing, and without this check the request would answer 204 and store and
    broadcast a second deletion event. Raising inside the transaction rolls
    everything back.
    """
    for qs in querysets:
        if not qs.exists():
            raise NotFound()


def lock_container_cascade(cards, entry_columns, boards):
    """Take a column, swimlane or board delete's cascade locks (#1599, #1602).

    The REST adapter over ``lock_cards_for_cascade``: it passes the container's
    board row (``boards``, locked first so the delete queues with column
    create and reorder in the board -> column order) and ``entry_columns`` so a card created or moved into the container mid-delete
    is locked too, and turns the bounded-retry exhaustion (``ContainerChanged``)
    into a ``409`` instead of letting it surface as a ``500``. Called through
    the module attribute so the race tests can wrap the service function.
    Must run inside the delete's ``transaction.atomic()``.
    """
    try:
        _card_services.lock_cards_for_cascade(
            cards, entry_columns=entry_columns, boards=boards,
        )
    except ContainerChanged as exc:
        raise _ContainerChangedConflict(exc) from None


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


# Postgres rejects a timestamptz UTC offset of 16 hours or more ("time zone
# displacement out of range"); Python's datetime accepts up to 24 hours.
_PG_MAX_UTC_OFFSET = datetime.timedelta(hours=16)


def _validate_pg_utc_offset(value):
    offset = value.utcoffset() if value is not None else None
    if offset is not None and abs(offset) >= _PG_MAX_UTC_OFFSET:
        raise ValidationError("UTC offset must be less than 16 hours.", code="invalid")


class BoundedDateTimeFilter(DateTimeFilter):
    """A DateTimeFilter that rejects UTC offsets Postgres cannot store.

    An ISO-8601 value like ``2026-01-01T00:00:00+17:52`` parses fine in Python
    but reaches Postgres as an out-of-range time zone displacement, raising an
    uncaught ``DataError`` as an unhandled 500 instead of a 400 — a
    `backend-schema-fuzz` CI job finding (#1120), the datetime counterpart of
    ``BoundedIdFilter``.
    """

    @property
    def field(self):
        built = super().field
        if _validate_pg_utc_offset not in built.validators:
            built.validators.append(_validate_pg_utc_offset)
        return built


def _count_subquery(model, filt=None):
    """Correlated ``COUNT(*)`` of ``model`` rows per outer board, 0 when none."""
    rows = model.objects.filter(board=OuterRef("pk"))
    if filt is not None:
        rows = rows.filter(filt)
    return Coalesce(
        Subquery(
            rows.order_by().values("board").annotate(c=Count("*")).values("c"),
            output_field=IntegerField(),
        ),
        0,
        output_field=IntegerField(),
    )


def annotate_board_counts(qs):
    """Annotate ``_member_count`` / ``_card_count`` / ``_archived_card_count``.

    Correlated subqueries, not ``Count("memberships") + Count("cards")``: two
    multi-valued joins in one query multiply (members x cards rows per board
    before DISTINCT collapses them), so latency scaled with the product on the
    most-used list endpoint while the query count stayed flat (#1723). Each
    count is now computed independently. Types are unchanged (non-negative
    ints, 0 never null for an empty board). Values are now true totals: the old
    ``Count("memberships")`` was annotated after the access filter on
    ``memberships__user`` and reused that filtered join, so a user who reached
    a board only via direct membership saw ``member_count`` 1.
    """
    return qs.annotate(
        _member_count=_count_subquery(BoardMembership),
        _card_count=_count_subquery(Card, Q(archived_at__isnull=True)),
        _archived_card_count=_count_subquery(Card, Q(archived_at__isnull=False)),
    )


def get_accessible_boards_queryset(user):
    """Return the Board queryset `user` may access: owned, directly a member of,
    inherited via group membership (a member of the board's group or one of its
    ancestors), or — for `can_access_all_content` users — every board.

    A board is in this queryset exactly when `get_board_role()` returns a role.
    The predicates below follow that function's ladder rung for rung: the
    owner first; then the user's explicit BoardMembership, which decides the
    answer on its own (a stored role outside ``BoardMembership.Role`` means no
    access, and group inheritance is not consulted); then group membership.

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
    if user.can_access_all_content:
        return Board.objects.all()
    return Board.objects.filter(board_access_q(user))


def board_access_q(user):
    """Return the ``Q`` that matches the boards on which ``get_board_role()`` resolves a role.

    The single predicate behind ``get_accessible_boards_queryset`` and the group
    board listings (``GroupViewSet.boards`` and the descendant-boards actions,
    #1769), so a listing and the board detail answer the same way for a stored
    role outside ``BoardMembership.Role``. Not meaningful for a
    ``can_access_all_content`` user (every board matches); callers skip it.
    """
    from groups.models import get_group_ids_for_board_access

    # Every term is a row-preserving predicate (owner FK, Exists, group FK ``IN``),
    # so a board can match more than one term without duplicating -- no DISTINCT.
    # Direct membership is an Exists(), not ``Q(memberships__user=...)``: the join
    # multiplies each board by its member count and made every correlated count
    # annotation run once per membership row (#1723). A stored role outside
    # ``BoardMembership.Role`` grants nothing and also blocks group inheritance,
    # mirroring get_board_role() (#1721).
    valid_board_roles = BoardMembership.Role.values
    invalid_explicit = BoardMembership.objects.filter(
        board=OuterRef("pk"), user=user,
    ).exclude(role__in=valid_board_roles)
    valid_explicit = BoardMembership.objects.filter(
        board=OuterRef("pk"), user=user, role__in=valid_board_roles,
    )
    return (
        Q(owner=user) |
        Exists(valid_explicit) |
        (
            Q(group__in=get_group_ids_for_board_access(user))
            & ~Exists(invalid_explicit)
        )
    )


def get_board_for_user(board_id, user, *, slim=False, with_archived_card_count=False):
    """Return (board, role) for board_id if user has access; raise 404 otherwise.

    A board that does not exist and a board the user cannot access both answer
    404, matching ``BoardViewSet.retrieve``, MCP and media. Callers that need a
    minimum role raise 403 themselves once this returns: that is a role
    failure on a board the user can already see.

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

    When ``with_archived_card_count=True`` the board row carries an
    ``_archived_card_count`` annotation (a correlated subquery, so it rides the
    same SELECT and adds no query) for BoardFullSerializer's
    ``archived_card_count`` (#1289). Opt-in so the many write endpoints that
    share this helper do not pay for a count they never read.

    The same ``with_archived_card_count=True`` flag also prefetches
    ``custom_field_definitions`` and ``swimlane_custom_field_definitions`` —
    the board-level and swimlane-level custom field schemas BoardFullSerializer
    reads via plain ``.all()`` — for the same reason: today's only caller that
    passes ``with_archived_card_count=True`` is ``BoardViewSet.full()``
    building a ``BoardFullSerializer`` response, so it doubles as the "this is
    the /full/ load" signal (#1334). Every other caller resolves RBAC only and
    never serializes either relation; prefetching them unconditionally would
    cost 2 extra queries on every card/column/swimlane/label mutation that
    shares this helper for nothing.

    ``columns`` rides the same flag for the same reason (#1351): it is the
    third relation BoardFullSerializer reads via a plain ``.all()``
    (``ColumnSerializer(many=True)``) that this helper did not cover, and
    the CSV/JSON export in ``import_export.py`` prefetches it at its own call
    site (#994); it still does, because export does not pass this flag.
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
    if with_archived_card_count:
        queryset = queryset.prefetch_related(
            # Plain string prefetches: both fields are declared directly on
            # BoardFullSerializer (CustomFieldDefinitionSerializer(many=True)
            # / SwimlaneCustomFieldDefinitionSerializer(many=True)), so DRF's
            # ListSerializer calls .all() with no extra filter/order_by — the
            # model Meta.ordering (["position", "id"]) applies either way, so
            # a plain prefetch matches what the serializer reads (#1334).
            #
            # Note: for this single-board fetch, prefetching does not reduce
            # the *query count* below the unprefetched baseline — Django
            # issues exactly one query per relation either way when there is
            # only one parent row, and neither field is read a second time
            # anywhere in /full/'s serialization (unlike "labels", prefetched
            # above for a real dedup: BoardFullSerializer.get_cards() reads
            # obj.labels.all() a second time). This still closes the gap
            # against the #1212 rule ("every relation on BoardFullSerializer
            # needs a matching prefetch") and costs nothing extra — these two
            # queries were already being issued live.
            "custom_field_definitions",
            "swimlane_custom_field_definitions",
            # ``columns`` (#1351) follows the same rule: BoardFullSerializer
            # declares ColumnSerializer(many=True) with no filter/order_by,
            # and Column.Meta.ordering (["position"]) applies either way. Same
            # zero measured query delta for a single board as above.
            "columns",
        )
        queryset = queryset.annotate(
            _archived_card_count=Coalesce(
                Subquery(
                    Card.objects.filter(board=OuterRef("pk"), archived_at__isnull=False)
                    .order_by()
                    .values("board")
                    .annotate(c=Count("*"))
                    .values("c"),
                    output_field=IntegerField(),
                ),
                0,
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
        # Same body get_object_or_404 produces for a missing board, so the two
        # cases cannot be told apart from the response.
        raise NotFound("No Board matches the given query.")
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
    try:
        refetched = _card_queryset(Card.objects.filter(pk=card.pk)).get()
    except Card.DoesNotExist:
        # A concurrent delete of the card committed between this request's
        # read and its write-then-refetch (#1584). The card is really gone, so
        # the honest answer is 404. Every caller invokes this inside its
        # ``transaction.atomic()`` and before ``record_board_event``, so the
        # raise rolls back the half-applied child write and no broadcast is
        # recorded for a deleted card.
        raise NotFound("Card not found.") from None
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


def blocked_peers_of(cards, *, active_blockers_only=True):
    """Collect, before a cascading delete of ``cards``, the surviving cards
    they block (#1634). See ``services.cards.blocked_peer_ids_by_board``."""
    return _card_services.blocked_peer_ids_by_board(
        cards, active_blockers_only=active_blockers_only,
    )


def card_payload_context(board, request=None):
    """The ``CardSerializer`` context for rendering cards of ``board`` outside a
    ``CardViewSet``: the board-level lookups precomputed once, so a serializer
    over a ``_card_queryset`` instance issues no per-card query for them.

    Shared by ``render_card_payloads`` and the MCP create/move/update tools,
    which render a single card for their broadcast (#1926).
    """
    return {
        "request": request,
        "board": board,
        "_member_ids": _get_effective_member_ids(board),
        "_assignable_member_ids": _get_assignable_member_ids(board),
        "_board_labels_qs": board.labels.all(),
    }


def render_card_payloads(board, card_ids, request=None):
    """Render the cards ``card_ids`` on ``board`` in one prefetch pass (#1634).

    The full ``CardSerializer`` payload every ``card.updated`` frame carries,
    built the way ``CardViewSet._batch_card_payloads`` builds it for
    ``delete_card``'s and ``archive_card``'s peers: one ``_card_queryset``
    pass for all of them rather than one per card. For callers outside a
    ``CardViewSet`` — the container deletes, the Django admin and the MCP
    archive tool — which have no per-request board-context cache.

    Filtered to ``board``, so a card that moved to another board is never
    rendered for this one. ``request`` is optional: nothing in this payload
    depends on it.
    """
    ctx = card_payload_context(board, request)
    return [
        CardSerializer(c, context=ctx).data
        for c in _card_queryset(Card.objects.filter(pk__in=list(card_ids), board_id=board.pk))
    ]


def publish_blocked_peers(peers_by_board, request, *, boards=()):
    """Publish ``card.updated`` for the cards a cascading delete unblocked (#1634).

    The column, swimlane and board deletes (REST and Django admin) and the
    admin card deletes cascade a set of cards. A card outside that set that
    one of them blocked keeps its row but its ``blocker_count`` drops, and
    without a frame every connected client keeps rendering a blocked indicator
    for a blocker that is gone — the container-delete twin of what
    ``delete_card`` already publishes for a single card (#449). The Django
    admin card form uses it too when an edit archives or restores the card,
    the twin of ``archive_card`` / ``unarchive_card``.

    ``peers_by_board`` comes from ``blocked_peers_of`` (called before the
    delete); this is called after it, inside the same transaction, so each
    peer renders with its post-delete count and its change-feed row commits
    with the delete. Rendering is the same as ``CardViewSet._batch_card_payloads``
    uses for ``delete_card``'s peers — one ``_card_queryset`` prefetch pass —
    run once per peer *board*, not per peer card, so the cost is bounded by
    the number of boards (one, unless the admin moved a card with relations
    across boards).

    ``boards`` are board instances the caller already holds, to skip the
    lookup; any other peer board is fetched in one ``in_bulk`` query. Each
    render is filtered to the board it is published on, so a peer that moved
    board meanwhile is never published to a board it is no longer on.
    """
    if not peers_by_board:
        return
    known = {b.pk: b for b in boards}
    missing = [bid for bid in peers_by_board if bid not in known]
    if missing:
        known.update(Board.objects.in_bulk(missing))

    def render_many(board_id, card_ids):
        board = known.get(board_id)
        if board is None:
            return []
        return render_card_payloads(board, card_ids, request)

    _card_services.broadcast_blocked_peers_by_board(peers_by_board, request.user, render_many)


def validate_full_reorder_order(order, existing_ids, *, item_label, scope_label):
    """Validate a `reorder` action's ``order`` list against the full set it must match.

    Every `reorder` action in this codebase (checklist items, columns,
    swimlanes) takes the same contract: `order` must be exactly the scoped
    resource's current full set of IDs, no more, no fewer, no duplicates.
    A partial list left unlisted rows' `position` wherever the previous
    write last put them — for columns (`unique_together(board, position)`)
    that could collide into an IntegrityError, for swimlanes it left two
    rows sharing a `position` silently. A duplicate ID meant the last
    occurrence silently won. Rejecting any mismatch outright, before any
    write, avoids all three (#1292 for checklist items; #1302 extends the
    same rule to columns and swimlanes — a partial/duplicate/foreign/empty
    list is invalid input, not something to filter and partially apply).

    Returns the validated list of IDs as ints, in the submitted order.
    Raises DRF ``ValidationError`` (naming the ``order`` field, same shape
    for all three callers) on any mismatch. Callers must call this before
    opening the write transaction (or, if the transaction is needed first to
    lock a parent row against a concurrent add/delete race, before issuing
    any write within it) so that a rejected request leaves every position
    untouched.
    """
    try:
        # Cast IDs to int — request JSON sends strings, DB PKs are ints. A
        # non-integer entry (or a body where `order` isn't even a list)
        # must surface as a 400 naming the field, not a 500 from int()
        # reached unguarded mid-transaction.
        order_ints = [int(iid) for iid in order]
    except (TypeError, ValueError):
        raise _DRFValidationError(
            {"order": f"order must be a list of integer {item_label} IDs."}
        ) from None
    # An id beyond the database integer range would overflow in the lookup (a
    # 500) rather than simply not match (#1669).
    if not all(id_in_db_range(i) for i in order_ints):
        raise _DRFValidationError(
            {"order": f"order must be a list of integer {item_label} IDs."}
        )
    if len(order_ints) != len(set(order_ints)):
        raise _DRFValidationError(
            {"order": f"order must not contain duplicate {item_label} IDs."}
        )
    if set(order_ints) != existing_ids:
        raise _DRFValidationError(
            {
                "order": (
                    f"order must contain exactly {scope_label}'s {item_label} IDs, "
                    "no more and no fewer."
                )
            }
        )
    return order_ints
