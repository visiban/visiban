"""CardQueryViewSet — read-only, paginated, filterable cross-board card query (#1112).

`GET /api/v1/boards/{board_id}/cards/` returns a bare array of at most 200
rows per request; since #1724 it reports the total in X-Total-Count /
X-Truncated and offset-pages with limit/offset, but it is single-board, has a
fixed filter set, and offset paging can skip or repeat rows under concurrent
writes. `GET /api/v1/boards/{board_id}/full/` returns every active card in one
unpaginated response. Neither answers "what changed since I last synced"
across boards. This module adds the cursor-paginated `GET /api/v1/cards/`
alongside them, leaving both response shapes unchanged, to serve large-board
table/list views and incremental sync.

Deliberately kept out of cards.py: a concurrent MR (#1106) is editing
CardViewSet.update()/CardSerializer in that file, so this endpoint lives in its
own module and only imports from cards.py/serializers.py rather than touching
either.
"""

import datetime

import django_filters
from django.db.models import Q
from django.utils import timezone
from rest_framework import mixins, serializers, viewsets
from rest_framework.permissions import IsAuthenticated
from rest_framework.throttling import UserRateThrottle

from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema, extend_schema_view

from accounts.permissions import TokenHasScope
from accounts.serializers import BoardUserSerializer
from visiban.permissions import (
    MustNotHavePendingPasswordChange,
    MustNotHavePendingUsernameChange,
)
from visiban.exceptions import INVALID_QUERY_PARAM_SCHEMA
from visiban.filters import CodedDjangoFilterBackend
from visiban.pagination import CardQueryCursorPagination
from visiban.request_shape import query_text

from ..models import Card
from ..serializers import (
    CustomFieldValueSerializer, ExternalRefSerializer, LabelSerializer,
    ParkedCustomFieldValueListSerializer, ParkedLabelListSerializer, _blocker_count,
    _card_attachments, _is_blocked, _card_checklist_items, _card_queryset, _column_entered_at,
    _last_moved_at, _last_move_is_creation,
)
from ._helpers import BoundedDateTimeFilter, BoundedIdFilter, get_accessible_boards_queryset


# ---------------------------------------------------------------------------
# Serializer
# ---------------------------------------------------------------------------

class CardQuerySerializer(serializers.ModelSerializer):
    """Read-only card representation for the cross-board query endpoint.

    Deliberately NOT a reuse of boards.serializers.CardSerializer. That
    serializer's __init__ rescopes its write-only label_ids/assignee_id fields
    to a single context["board"], and BoardFullSerializer/CardViewSet
    precompute member_ids/assignable_ids/board_labels_qs once per *board* to
    keep query count flat — neither trick has an equivalent when a single page
    mixes cards from many boards, and reusing CardSerializer unchanged would
    either silently mis-scope those write fields or reintroduce an N+1 (one
    lookup per distinct board on the page). This endpoint has no write path,
    so it needs none of that: a plain serializer with no board context.

    Field set mirrors CardSerializer's authenticated fields (not the reduced
    set PublicCardSerializer exposes to anonymous share-link viewers) plus
    `board`, which single-board endpoints omit because the URL already scopes
    to one board — a cross-board list must say which board each row is on.

    Viewer-role PII: CardSerializer has no role-conditional fields, and
    BoardFullSerializer.get_cards() renders it identically for every role —
    the only role-gated serializers in this codebase are the swimlane ones
    (SwimlaneSerializer vs SwimlaneAdminSerializer), which are not embedded
    here. Matching that: this serializer's output is also role-invariant.
    assignee/created_by go through BoardUserSerializer, same as everywhere
    else, which already excludes notification prefs, email, and
    can_access_all_content for every role.
    """

    # ParkedLabelListSerializer (#1223, same pattern as custom_field_values
    # below, #1212) reads the to_attr list _card_queryset() parks the labels
    # on; a plain LabelSerializer(many=True) would call .all() on the M2M
    # manager, miss that list, and query once per card.
    labels = ParkedLabelListSerializer(child=LabelSerializer(), read_only=True)
    # allow_null=True (#1172): Card.assignee is nullable (unassigned cards are
    # the common case) — without it drf-spectacular documents this field as
    # always an object, which is wrong for every unassigned card in the response.
    # Same gap as CardSerializer.assignee (#1108).
    assignee = BoardUserSerializer(read_only=True, allow_null=True)
    # allow_null=True (#1172): created_by is a SET_NULL FK — the creating user
    # can be deleted, and rows predating the ownership migration carry it null
    # outright. Same declared-nested-field gap CardSerializer.created_by had
    # before #1138.
    created_by = BoardUserSerializer(read_only=True, allow_null=True)
    # Read-only here, unlike on CardSerializer: this endpoint has no write path
    # at all, so there is nothing to validate a submitted value against. Present
    # rather than omitted because CardQuerySerializerFieldParityTests requires
    # this field set to stay in step with CardSerializer's readable fields —
    # values carry no exposure a reader of the card does not already have, and
    # _card_queryset() already prefetches them, so this costs no extra query.
    # The Parked* list serializer reads the to_attr list _card_queryset()
    # parks the rows on (#1212); a plain many=True would call .all() on the
    # manager, miss that list, and query once per card.
    custom_field_values = ParkedCustomFieldValueListSerializer(
        child=CustomFieldValueSerializer(), read_only=True,
    )
    last_moved_at = serializers.SerializerMethodField()
    last_move_is_creation = serializers.SerializerMethodField()
    column_entered_at = serializers.SerializerMethodField()
    attachment_count = serializers.SerializerMethodField()
    checklist_total = serializers.SerializerMethodField()
    checklist_done = serializers.SerializerMethodField()
    is_stale = serializers.SerializerMethodField()
    blocker_count = serializers.SerializerMethodField()
    is_blocked = serializers.SerializerMethodField()
    # MR/PR link (#352). Read-only here for the same reason as
    # custom_field_values above; _card_queryset() select_related()s it.
    external_ref = ExternalRefSerializer(read_only=True, allow_null=True)

    class Meta:
        model = Card
        fields = [
            "id", "uid", "board", "column", "swimlane", "title", "description",
            "priority", "assignee", "labels", "due_date", "weight", "position",
            "created_by", "created_at", "updated_at", "last_moved_at",
            "last_move_is_creation", "column_entered_at", "attachment_count", "checklist_total", "checklist_done",
            "is_stale", "archived_at", "version", "custom_field_values",
            "blocker_count", "external_ref",
            # Manual blocked state (#1149), as on CardSerializer.
            "is_blocked", "blocked_at", "blocked_reason",
        ]
        read_only_fields = fields

    def get_last_moved_at(self, obj) -> datetime.datetime | None:
        # Use .all() not .first() — .first() bypasses the prefetch cache and
        # issues a new query with ORDER BY + LIMIT 1 for every card.
        # Return type is annotated (#1120, same pattern as CardSerializer's
        # #1108 fix): a never-moved card returns None, and without the hint
        # drf-spectacular defaulted this to a non-nullable "string" here too
        # — this serializer duplicates CardSerializer's method fields (see
        # the class docstring) but was added after #1108 and didn't inherit
        # its type hints.
        # The _card_* accessors read the lists _card_queryset() parks with
        # to_attr (#1212) — obj.<relation>.all() would miss them.
        return _last_moved_at(obj)

    def get_last_move_is_creation(self, obj) -> bool:
        # Present because CardQuerySerializerFieldParityTests requires this
        # field set to stay in step with CardSerializer's readable fields.
        # Reads the last-move annotations _card_queryset() adds — no query.
        return _last_move_is_creation(obj)

    def get_column_entered_at(self, obj) -> datetime.datetime | None:
        # Same parity reason; reads the annotation _card_queryset() adds (#459).
        return _column_entered_at(obj)

    def get_attachment_count(self, obj) -> int:
        return len(_card_attachments(obj))

    def get_checklist_total(self, obj) -> int:
        return len(_card_checklist_items(obj))

    def get_checklist_done(self, obj) -> int:
        return sum(1 for item in _card_checklist_items(obj) if item.is_checked)

    def get_blocker_count(self, obj) -> int:
        # Present because CardQuerySerializerFieldParityTests requires this
        # field set to stay in step with CardSerializer's readable fields.
        # _card_queryset() prefetches active_blockers, so this costs no query;
        # the scalar discloses nothing a reader of the card does not already
        # have, since relations are same-board only (#449).
        return _blocker_count(obj)

    def get_is_blocked(self, obj) -> bool:
        # Same helper as CardSerializer (#1149), so the two cannot disagree.
        return _is_blocked(obj)

    def get_is_stale(self, obj) -> bool:
        # No SQL-level stale_cutoff annotation here (unlike _card_queryset()'s
        # stale_cutoff= param): that annotation applies ONE cutoff to every row,
        # which is correct only when every card belongs to the same board. A
        # cross-board page can mix boards with different
        # staleness_threshold_days, so each row must use its own board's
        # threshold. obj.board is select_related and the newest movement is
        # annotated by _card_queryset(), so this costs Python time, not
        # queries — the per-row branch here does not affect the query-count
        # guard.
        threshold = obj.board.staleness_threshold_days
        cutoff = timezone.now() - datetime.timedelta(days=threshold)
        last_moved_at = _last_moved_at(obj)
        if last_moved_at is not None:
            return last_moved_at < cutoff
        return (timezone.now() - obj.created_at).days >= threshold


# ---------------------------------------------------------------------------
# Throttle
# ---------------------------------------------------------------------------

class CardQueryRateThrottle(UserRateThrottle):
    """Tighter per-user rate limit for the cross-board card query endpoint.

    Every other card read is scoped to one board; this is the first endpoint
    that can return a member's entire accessible-card corpus (every board
    they belong to) via ?search=/paging, so it gets its own scope rather than
    the generic 5000/hour default — same rationale as UserSearchRateThrottle
    (accounts/views.py) and ShareLinkThrottle (boards/views/share.py).
    """

    scope = "card_query"


# ---------------------------------------------------------------------------
# Filter
# ---------------------------------------------------------------------------

class CardQueryFilter(django_filters.FilterSet):
    """django-filters FilterSet for the cross-board card query endpoint.

    Mirrors boards.views.cards.CardFilter's field shapes (assignee/priority/
    due_before/due_after) for consistency between the two filterable card
    surfaces, plus board/swimlane/column/label/updated_since/include_archived
    which CardFilter does not need (it is already scoped to one board by the
    URL and has no incremental-sync use case).
    """

    # BoundedIdFilter, not a bare NumberFilter (#1120) — see its docstring in
    # ._helpers: an out-of-64-bit-range id value (e.g. ?column=1.03e34)
    # crashes with an uncaught OverflowError otherwise.
    # help_text is the parameter description drf-spectacular publishes (#1887);
    # keep it in step with the query parameter table in docs/api/cards.md.
    board = BoundedIdFilter(field_name="board_id", help_text="Restrict to one board (board ID).")
    swimlane = BoundedIdFilter(field_name="swimlane_id", help_text="Filter by swimlane ID.")
    column = BoundedIdFilter(field_name="column_id", help_text="Filter by column ID.")
    assignee = BoundedIdFilter(field_name="assignee_id", help_text="Filter by assignee user ID.")
    label = BoundedIdFilter(field_name="labels__id", help_text="Filter by label ID.")
    priority = django_filters.CharFilter(
        field_name="priority", lookup_expr="exact",
        help_text="Filter by priority (`low`, `medium`, `high`, `urgent`).",
    )
    due_before = django_filters.DateFilter(
        field_name="due_date", lookup_expr="lte",
        help_text="Cards with a due date on or before this date (`YYYY-MM-DD`).",
    )
    due_after = django_filters.DateFilter(
        field_name="due_date", lookup_expr="gte",
        help_text="Cards with a due date on or after this date (`YYYY-MM-DD`).",
    )
    # BoundedDateTimeFilter (#1120): an out-of-range UTC offset otherwise 500s on Postgres.
    updated_since = BoundedDateTimeFilter(
        field_name="updated_at", lookup_expr="gte",
        help_text=(
            "Cards updated at or after this ISO 8601 timestamp (the incremental-sync "
            "filter). A UTC offset of 16 hours or more is a 400."
        ),
    )

    # include_archived is intentionally NOT a FilterSet field: django-filter's
    # method= filters only run when the query param is present, so they can't
    # express "excluded by default, included on request" — the exclusion has
    # to apply even when the param is absent. See CardQueryViewSet.get_queryset().

    class Meta:
        model = Card
        fields = ["board", "swimlane", "column", "assignee", "label", "priority"]


# ---------------------------------------------------------------------------
# ViewSet
# ---------------------------------------------------------------------------

@extend_schema_view(
    list=extend_schema(
        # The two parameters get_queryset() parses by hand (#1887). The
        # CardQueryFilter ones come from the filter backend, and cursor,
        # page_size and ordering from CardQueryCursorPagination.
        parameters=[
            OpenApiParameter(
                name="include_archived",
                type=OpenApiTypes.BOOL,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "`true` (case-insensitive) includes archived cards. Omitted, "
                    "`false` or any other value excludes them (the default)."
                ),
            ),
            OpenApiParameter(
                name="search",
                type=OpenApiTypes.STR,
                location=OpenApiParameter.QUERY,
                required=False,
                description="Filter by title and description (partial, case-insensitive).",
            ),
        ],
        responses={
            200: CardQuerySerializer(many=True),
            400: OpenApiResponse(
                description=(
                    "A malformed `cursor`, a `search` containing a NUL (0x00) character, "
                    "or a filter value that fails its type check "
                    '(`{"detail": ..., "code": "invalid_query_param"}`; a filter error also '
                    "keeps its field-keyed entry, e.g. `updated_since`)."
                ),
                response=INVALID_QUERY_PARAM_SCHEMA,
            ),
        },
    ),
)
class CardQueryViewSet(mixins.ListModelMixin, viewsets.GenericViewSet):
    """GET /api/v1/cards/ — paginated, filterable, cross-board card query.

    Read-only by design (list only — no retrieve/create/update/delete): this
    endpoint exists for table/list views and incremental sync, not for card
    mutation, which stays on /boards/{board_id}/cards/{id}/.

    Access scoping reuses get_accessible_boards_queryset() — the same
    owner/membership/group-ancestry/site-admin rule BoardViewSet.get_queryset()
    uses for the board list. It evaluates that queryset's ids once per request
    and filters cards with `board_id__in=<that list>` (a list, not a subquery,
    for planning cost; see get_queryset(), #1805). This performs the
    equivalent of a per-card permission check with one board-id query rather
    than a per-card lookup: a non-member's boards
    never enter the `IN`, so their cards cannot appear regardless of what
    filters are supplied (IDOR prevention). The invariant this endpoint relies
    on is `board_id in get_accessible_boards_queryset(user)` <=>
    `get_board_role(user, board) is not None` for every board — see
    get_accessible_boards_queryset()'s own docstring for why it uses
    get_group_ids_for_board_access() (descendants only) rather than
    get_accessible_group_ids() (which also walks up to ancestors and would
    break that equivalence). There is no additional per-endpoint role floor
    beyond board access — this matches the implicit floor on
    GET /boards/{id}/cards/, which is likewise available to any role
    (including viewer) that has board access at all.
    """

    permission_classes = [
        IsAuthenticated,
        MustNotHavePendingPasswordChange,
        MustNotHavePendingUsernameChange,
        TokenHasScope,
    ]
    throttle_classes = [CardQueryRateThrottle]
    serializer_class = CardQuerySerializer
    filterset_class = CardQueryFilter
    # The filter backend only (CodedDjangoFilterBackend: DjangoFilterBackend
    # plus the #1832 ``detail``/``code`` on its 400) — the global default also includes
    # rest_framework.filters.OrderingFilter, which CardQueryCursorPagination
    # deliberately does not rely on (see its docstring): letting OrderingFilter
    # supply cursor ordering would allow any single serializer field with no
    # forced tiebreaker, breaking cursor stability on ties.
    filter_backends = [CodedDjangoFilterBackend]
    pagination_class = CardQueryCursorPagination

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            # Schema generation runs with an AnonymousUser and no real request
            # (#1887). Without this guard get_accessible_boards_queryset()
            # raised, drf-spectacular could not resolve the view's model, and
            # its django-filter extension silently dropped every CardQueryFilter
            # parameter from the published schema. Never true on a request.
            return Card.objects.none()
        user = self.request.user
        # Evaluate the accessible board ids up front (one small query) and pass
        # them as a literal list. Do not hand the queryset itself to
        # ``board_id__in``. As a subquery, PostgreSQL pulls it up into the
        # card SELECT's 7-table join, and planning that join cost more than
        # running it: on the nightly-load-test fixture the planner spent about
        # 20ms per request on the Exists() form #1723 introduced (11-15ms on
        # the older DISTINCT-join form), against about 5ms for literal ids. With
        # the ids known, the planner can also walk card_board_updated_idx in
        # cursor order and stop at the page size instead of sorting every match
        # (#1805). The rule is unchanged: the same
        # get_accessible_boards_queryset() still decides which boards are in
        # the list, so the IDOR invariant in the class docstring holds. The list
        # grows with the user's accessible boards (every board for a
        # can_access_all_content user). That is one id per board, not per card.
        # The ids and the cards are now two statements instead of one, so a
        # membership revoked between them takes effect on the next request:
        # the same check-then-read window as get_board_for_user() endpoints.
        # An empty list makes Django skip the card query and return no rows.
        accessible_board_ids = list(
            get_accessible_boards_queryset(user).values_list("id", flat=True),
        )
        qs = Card.objects.filter(board_id__in=accessible_board_ids)
        # Archived cards are excluded unless ?include_archived=true — matching
        # /boards/{id}/cards/ and /full/. Applied here (not as a FilterSet
        # field) because django-filter's method= filters only run when the
        # param is present, and this exclusion must apply even when it's not.
        if self.request.query_params.get("include_archived", "").lower() != "true":
            qs = qs.filter(archived_at__isnull=True)
        qs = _card_queryset(qs)
        search = query_text(self.request, "search").strip()
        if search:
            qs = qs.filter(Q(title__ci_contains=search) | Q(description__ci_contains=search))
        return qs
