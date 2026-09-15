"""CardQueryViewSet — read-only, paginated, filterable cross-board card query (#1112).

`GET /api/v1/boards/{board_id}/cards/` is capped at 200 rows with no pagination
signal, and `GET /api/v1/boards/{board_id}/full/` returns every active card
unpaginated — neither can page through a large board, filter by more than a
handful of fields, or answer "what changed since I last synced" across boards.
This module adds `GET /api/v1/cards/` alongside them, unpaginated endpoints
unchanged, to serve large-board table/list views and incremental sync.

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
from django_filters.rest_framework import DjangoFilterBackend

from accounts.permissions import TokenHasScope
from accounts.serializers import BoardUserSerializer
from visiban.permissions import (
    MustNotHavePendingPasswordChange,
    MustNotHavePendingUsernameChange,
)
from visiban.pagination import CardQueryCursorPagination

from ..models import Card
from ..serializers import CustomFieldValueSerializer, LabelSerializer, _card_queryset
from ._helpers import get_accessible_boards_queryset


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

    labels = LabelSerializer(many=True, read_only=True)
    assignee = BoardUserSerializer(read_only=True)
    created_by = BoardUserSerializer(read_only=True)
    # Read-only here, unlike on CardSerializer: this endpoint has no write path
    # at all, so there is nothing to validate a submitted value against. Present
    # rather than omitted because CardQuerySerializerFieldParityTests requires
    # this field set to stay in step with CardSerializer's readable fields —
    # values carry no exposure a reader of the card does not already have, and
    # _card_queryset() already prefetches them, so this costs no extra query.
    custom_field_values = CustomFieldValueSerializer(many=True, read_only=True)
    last_moved_at = serializers.SerializerMethodField()
    attachment_count = serializers.SerializerMethodField()
    checklist_total = serializers.SerializerMethodField()
    checklist_done = serializers.SerializerMethodField()
    is_stale = serializers.SerializerMethodField()

    class Meta:
        model = Card
        fields = [
            "id", "uid", "board", "column", "swimlane", "title", "description",
            "priority", "assignee", "labels", "due_date", "weight", "position",
            "created_by", "created_at", "updated_at", "last_moved_at",
            "attachment_count", "checklist_total", "checklist_done",
            "is_stale", "archived_at", "version", "custom_field_values",
        ]
        read_only_fields = fields

    def get_last_moved_at(self, obj):
        # Use .all() not .first() — .first() bypasses the prefetch cache and
        # issues a new query with ORDER BY + LIMIT 1 for every card.
        movements = obj.movements.all()
        return movements[0].moved_at if movements else None

    def get_attachment_count(self, obj):
        return len(obj.attachments.all())

    def get_checklist_total(self, obj):
        return len(obj.checklist_items.all())

    def get_checklist_done(self, obj):
        return sum(1 for item in obj.checklist_items.all() if item.is_checked)

    def get_is_stale(self, obj):
        # No SQL-level stale_cutoff annotation here (unlike _card_queryset()'s
        # stale_cutoff= param): that annotation applies ONE cutoff to every row,
        # which is correct only when every card belongs to the same board. A
        # cross-board page can mix boards with different
        # staleness_threshold_days, so each row must use its own board's
        # threshold. obj.board is select_related and obj.movements is
        # prefetched by _card_queryset(), so this costs Python time, not
        # queries — the per-row branch here does not affect the query-count
        # guard.
        threshold = obj.board.staleness_threshold_days
        cutoff = timezone.now() - datetime.timedelta(days=threshold)
        movements = obj.movements.all()
        if movements:
            return movements[0].moved_at < cutoff
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

    board = django_filters.NumberFilter(field_name="board_id")
    swimlane = django_filters.NumberFilter(field_name="swimlane_id")
    column = django_filters.NumberFilter(field_name="column_id")
    assignee = django_filters.NumberFilter(field_name="assignee_id")
    label = django_filters.NumberFilter(field_name="labels__id")
    priority = django_filters.CharFilter(field_name="priority", lookup_expr="exact")
    due_before = django_filters.DateFilter(field_name="due_date", lookup_expr="lte")
    due_after = django_filters.DateFilter(field_name="due_date", lookup_expr="gte")
    updated_since = django_filters.DateTimeFilter(field_name="updated_at", lookup_expr="gte")

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

class CardQueryViewSet(mixins.ListModelMixin, viewsets.GenericViewSet):
    """GET /api/v1/cards/ — paginated, filterable, cross-board card query.

    Read-only by design (list only — no retrieve/create/update/delete): this
    endpoint exists for table/list views and incremental sync, not for card
    mutation, which stays on /boards/{board_id}/cards/{id}/.

    Access scoping reuses get_accessible_boards_queryset() — the same
    owner/membership/group-ancestry/site-admin rule BoardViewSet.get_queryset()
    uses for the board list — via a `board_id__in=<queryset>.values_list("id")`
    subquery. This performs the equivalent of a per-card permission check with
    a single subquery rather than a per-card lookup: a non-member's boards
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
    # DjangoFilterBackend only — the global default also includes
    # rest_framework.filters.OrderingFilter, which CardQueryCursorPagination
    # deliberately does not rely on (see its docstring): letting OrderingFilter
    # supply cursor ordering would allow any single serializer field with no
    # forced tiebreaker, breaking cursor stability on ties.
    filter_backends = [DjangoFilterBackend]
    pagination_class = CardQueryCursorPagination

    def get_queryset(self):
        user = self.request.user
        accessible_board_ids = get_accessible_boards_queryset(user).values_list("id", flat=True)
        qs = Card.objects.filter(board_id__in=accessible_board_ids)
        # Archived cards are excluded unless ?include_archived=true — matching
        # /boards/{id}/cards/ and /full/. Applied here (not as a FilterSet
        # field) because django-filter's method= filters only run when the
        # param is present, and this exclusion must apply even when it's not.
        if self.request.query_params.get("include_archived", "").lower() != "true":
            qs = qs.filter(archived_at__isnull=True)
        qs = _card_queryset(qs)
        search = self.request.query_params.get("search", "").strip()
        if search:
            qs = qs.filter(Q(title__icontains=search) | Q(description__icontains=search))
        return qs
