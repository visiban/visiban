"""CardViewSet — CRUD endpoints for cards on a board, including move, archive, comments, etc."""

import datetime
import logging
import os
from urllib.parse import urlencode

import django_filters
from django.db import IntegrityError, connection, transaction
from django.db.models import Count, Prefetch, Q, Window
from django.shortcuts import get_object_or_404
from rest_framework import serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from drf_spectacular.utils import (
    extend_schema, inline_serializer, OpenApiParameter, OpenApiResponse, OpenApiTypes,
)

from django.conf import settings as django_settings
from accounts.models import User, get_uploads_enabled
from accounts.permissions import TokenHasScope
from visiban.permissions import (
    MustNotHavePendingPasswordChange,
    MustNotHavePendingUsernameChange,
)

from .. import broadcast as _broadcast
from ..services import cards as card_services
from ..services.errors import CardServiceError
from ..utils import extract_mentions, _get_effective_member_ids, _get_assignable_member_ids
from ..models import (
    BoardMembership, Card, CardActivity, CardAttachment,
    CardChecklist, CardComment, CardMovement, CardRelation, Label,
    Notification,
)
from ..permissions import SITE_ADMIN
from ..serializers import (
    CardSerializer, CardMovementSerializer, CardCommentSerializer,
    CardActivitySerializer, CardAttachmentSerializer, CardChecklistSerializer,
    CardRelationCreateSerializer, CardRelationSerializer,
    CardTimelineEntrySerializer,
    _card_queryset,
)
from ._helpers import get_board_for_user, _can_modify_others_content, _refetched_card_data

logger = logging.getLogger(__name__)

# Broadcast event names — extracted to avoid string duplication.
_EVT_CARD_UPDATED = "card.updated"

# Permission error messages — extracted to avoid string duplication.
_PERM_DENIED = "You do not have permission to perform this action."
_VIEWER_DENIED = "Viewers cannot perform this action."


# ---------------------------------------------------------------------------
# Upload validation helpers (used by attachments action)
# ---------------------------------------------------------------------------

# Magic-byte signatures for allowed file types.  We read only the first 12
# bytes so this check is fast and cannot be spoofed by renaming the file or
# supplying a fraudulent Content-Type header.
_MAGIC_SIGNATURES: list[tuple[bytes, str]] = [
    # JPEG
    (b"\xff\xd8\xff", "image/jpeg"),
    # PNG
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    # GIF87a / GIF89a
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    # WEBP (RIFF....WEBP)
    (b"RIFF", "image/webp"),
    # PDF
    (b"%PDF-", "application/pdf"),
    # ZIP (also covers DOCX/XLSX/PPTX which are ZIP-based OOXML)
    (b"PK\x03\x04", "application/zip"),
    # Plain text / CSV — no magic bytes; allowed by MIME type check below
]

# Allowlist of MIME types that may be uploaded as card attachments.
# Anything not in this set is rejected with HTTP 400.
_ALLOWED_MIME_TYPES: frozenset[str] = frozenset([
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "application/pdf",
    # OOXML office formats (all stored as ZIP internally)
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/zip",
    "text/plain",
    "text/csv",
])


def _sanitize_attachment_filename(raw_name: str) -> str:
    """Return a filename safe for use in a Content-Disposition header.

    django.utils.text.get_valid_filename() removes path separators and most
    special characters.  We additionally strip CR, LF, and null bytes which
    can inject extra HTTP headers or terminate the header value prematurely
    if a browser supplies a crafted filename.
    """
    from django.core.exceptions import SuspiciousFileOperation
    from django.utils.text import get_valid_filename
    try:
        safe = get_valid_filename(os.path.basename(raw_name))
    except SuspiciousFileOperation:
        return "attachment"
    # Strip characters that cannot appear in a quoted Content-Disposition value.
    safe = safe.translate({ord("\r"): None, ord("\n"): None, ord("\x00"): None})
    return safe or "attachment"


def _validate_upload_mime(file) -> str | None:
    """Validate a file upload against the allowlist and magic bytes.

    Returns an error message string if the file should be rejected, or None if
    it is acceptable.

    We do NOT trust the client-supplied Content-Type or the filename extension.
    Instead we read the first 12 bytes and compare against known magic-byte
    signatures.  For text-based formats (plain text, CSV) that have no
    distinguishing magic bytes we fall back to the declared MIME type — but
    only after the type itself has been checked against the allowlist.
    """
    declared_type = (file.content_type or "application/octet-stream").split(";")[0].strip().lower()

    if declared_type not in _ALLOWED_MIME_TYPES:
        return (
            f"File type '{declared_type}' is not allowed. "
            "Accepted types: images (JPEG, PNG, GIF, WebP), PDF, "
            "Office documents (DOCX, XLSX, PPTX), plain text, CSV, ZIP."
        )

    # Read magic bytes without consuming the file object — seek back afterwards.
    header = file.read(12)
    file.seek(0)

    # Text-based types have no reliable magic bytes; allow them through if the
    # declared MIME type is in the allowlist (already checked above).  However,
    # reject files whose first 4 KB contains HTML/SVG markers that could enable
    # stored XSS if a browser renders the file inline (#372).
    text_types = {"text/plain", "text/csv"}
    if declared_type in text_types:
        sniff = file.read(4096)
        file.seek(0)
        sniff_lower = sniff.lower()
        if any(marker in sniff_lower for marker in [b"<script", b"<svg", b"<!doctype", b"<html", b"<iframe"]):
            return (
                "File contains HTML/script content and cannot be uploaded as "
                f"{declared_type}. Rename it with an appropriate extension or "
                "remove the embedded markup."
            )
        return None

    # For binary types, require at least one known signature to match.
    for magic, _ in _MAGIC_SIGNATURES:
        if header[:len(magic)] == magic:
            return None

    return (
        "File content does not match a recognized safe format. "
        "The file may be corrupt or its type may have been misrepresented."
    )


# ---------------------------------------------------------------------------
# Card filter
# ---------------------------------------------------------------------------

class CardFilter(django_filters.FilterSet):
    """django-filters FilterSet for cards; supports priority, assignee, column, swimlane, and due-date filters."""

    priority = django_filters.CharFilter(field_name="priority", lookup_expr="exact")
    assignee = django_filters.NumberFilter(field_name="assignee__id")
    unassigned = django_filters.BooleanFilter(field_name="assignee", lookup_expr="isnull")
    column = django_filters.NumberFilter(field_name="column__id")
    swimlane = django_filters.NumberFilter(field_name="swimlane__id")
    due_before = django_filters.DateFilter(field_name="due_date", lookup_expr="lte")
    due_after = django_filters.DateFilter(field_name="due_date", lookup_expr="gte")
    overdue = django_filters.BooleanFilter(method="filter_overdue")

    def filter_overdue(self, queryset, name, value):
        today = datetime.date.today()
        if value:
            return queryset.filter(due_date__lt=today)
        return queryset.exclude(due_date__lt=today)

    class Meta:
        model = Card
        fields = ["priority", "assignee", "column", "swimlane"]


# ---------------------------------------------------------------------------
# CardViewSet
# ---------------------------------------------------------------------------

class CardViewSet(viewsets.ModelViewSet):
    """CRUD endpoints for cards on a board; viewers cannot create/edit/delete."""

    # See BoardViewSet.lookup_value_regex — same fix, own `pk` segment.
    lookup_value_regex = r"\d+"

    # Explicitly enumerate the global default permission chain (#989/#1050) so an
    # accidental change to DEFAULT_PERMISSION_CLASSES cannot silently drop the auth
    # gate from this viewset without a visible diff here.
    permission_classes = [
        IsAuthenticated,
        MustNotHavePendingPasswordChange,
        MustNotHavePendingUsernameChange,
        TokenHasScope,
    ]
    serializer_class = CardSerializer
    filterset_class = CardFilter
    # Disable pagination: the full board state is loaded via the /full/ endpoint; individual
    # card list calls (e.g. search) return plain arrays consumed directly by the frontend.
    pagination_class = None
    ordering_fields = ["position", "due_date", "created_at", "priority"]
    ordering = ["position"]
    # Cards are always scoped to a single board so paginating the list endpoint
    # would silently truncate results for busy boards. Disable pagination here;
    # the board-full endpoint already returns all cards without pagination.
    pagination_class = None

    # Cache the (board, role) tuple for the lifetime of the request so that
    # multiple _board_and_role() / _board() calls within one action (e.g.
    # get_queryset() + get_serializer_context() + perform_update()) do not
    # each issue a full select_related board fetch.  Matches the pattern
    # already used by ColumnViewSet and SwimlaneViewSet.
    _cached_board_role = None
    _cached_board_ctx = None

    def _board_and_role(self):
        if self._cached_board_role is None:
            self._cached_board_role = get_board_for_user(
                self.kwargs["board_pk"], self.request.user
            )
        return self._cached_board_role

    def _board(self):
        return self._board_and_role()[0]

    def _board_context(self):
        """Return per-request cached member IDs, assignable IDs, and labels qs.

        Mutation endpoints call `_refetched_card_data` once each; without a
        cache, every call re-fires `_get_effective_member_ids` +
        `_get_assignable_member_ids` (1-2 queries each) and a Label query.
        Cache once per request so consecutive mutation responses share the
        same resolved sets.
        """
        if self._cached_board_ctx is None:
            board = self._board()
            self._cached_board_ctx = {
                "board": board,
                "member_ids": _get_effective_member_ids(board),
                "assignable_ids": _get_assignable_member_ids(board),
                "labels_qs": board.labels.all(),
            }
        return self._cached_board_ctx

    def _refetch_card_data(self, card):
        bc = self._board_context()
        return _refetched_card_data(
            card, self.request, bc["board"],
            member_ids=bc["member_ids"],
            assignable_ids=bc["assignable_ids"],
            labels_qs=bc["labels_qs"],
        )

    def _batch_card_payloads(self, card_ids):
        """Serialize several cards in ONE prefetch pass (#449).

        `_refetch_card_data` runs the whole `_card_queryset` chain per call, so
        rendering N cards one at a time costs 7N queries. The chain costs the
        same for an N-row queryset as for a one-row one, so anything that has to
        render a set of cards — the peer cards whose blocker_count moves when a
        card is archived or deleted — goes through here instead.
        """
        bc = self._board_context()
        ctx = {
            "request": self.request,
            "board": bc["board"],
            "_member_ids": bc["member_ids"],
            "_assignable_member_ids": bc["assignable_ids"],
            "_board_labels_qs": bc["labels_qs"],
        }
        return [
            CardSerializer(c, context=ctx).data
            for c in _card_queryset(Card.objects.filter(pk__in=list(card_ids)))
        ]

    def get_queryset(self):
        # Exclude archived cards from all standard list/detail endpoints.
        # Archived cards are accessible via the separate /archived/ action.
        qs = _card_queryset(Card.objects.filter(board=self._board(), archived_at__isnull=True))
        # Server-side text search — applied only when the ?search= param is present and non-empty.
        # This intentionally does not use DRF SearchFilter or CardFilter so that the search param
        # remains distinct from the django-filters params and the filter logic is easy to trace.
        q = self.request.query_params.get("search", "").strip()
        if q:
            qs = qs.filter(Q(title__icontains=q) | Q(description__icontains=q))
        return qs

    # Hard row cap on /cards/ list responses. The /full/ endpoint is the only
    # path that returns the complete board; /cards/ is for targeted lookups
    # (search, priority filter, etc.) and must bound its response so a board
    # with thousands of matching cards cannot return an unbounded payload.
    _LIST_MAX_ROWS = 200

    def list(self, request, *args, **kwargs):
        queryset = self.filter_queryset(self.get_queryset())
        # Cap results after ordering is applied — slicing before filter_queryset()
        # would prevent OrderingFilter from calling .order_by() on the queryset.
        queryset = queryset[:self._LIST_MAX_ROWS]
        serializer = self.get_serializer(queryset, many=True)
        return Response(serializer.data)

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        bc = self._board_context()
        ctx["board"] = bc["board"]
        ctx["_member_ids"] = bc["member_ids"]
        ctx["_assignable_member_ids"] = bc["assignable_ids"]
        ctx["_board_labels_qs"] = bc["labels_qs"]
        return ctx

    def handle_exception(self, exc):
        """Translate a card-service domain error into its frozen HTTP response.

        One clause covers every mutation action because each error in
        ``boards.services.errors`` carries the exact status and body its
        endpoint returned before the service extraction (#1107).

        This deliberately does not go through a DRF ``APIException``: DRF's
        ``_get_error_details`` coerces every value in an exception detail to a
        string, which would turn ``current_count``, ``wip_limit``,
        ``card_weight`` and ``current_version`` into strings and break the
        clients that compare them numerically.
        """
        if isinstance(exc, CardServiceError):
            return Response(exc.body(), status=exc.status)
        return super().handle_exception(exc)

    def perform_create(self, serializer):
        board, role = self._board_and_role()
        card_services.create_card(
            actor=self.request.user,
            board=board,
            role=role,
            column_id=serializer.validated_data["column"].pk,
            swimlane_id=serializer.validated_data["swimlane"].pk,
            # The serializer stays the validation and persistence mechanism —
            # its querysets are board-scoped, so a cross-board column, swimlane,
            # label or assignee id is already a 400 by the time we get here. The
            # service decides *where in the cell* the card lands.
            save=lambda position: serializer.save(
                board=board, created_by=self.request.user, position=position,
            ),
            render=self._refetch_card_data,
        )
        # No return value: DRF's CreateModelMixin renders the 201 body from
        # serializer.data, exactly as it did before. The service's rendered
        # payload is the broadcast payload.

    def perform_destroy(self, instance):
        board, role = self._board_and_role()
        card_services.delete_card(
            actor=self.request.user, board=board, role=role, card=instance,
            # Lets the service publish card.updated for any card this one was
            # blocking, whose blocker_count drops when the relations cascade
            # away (#449).
            render_many=self._batch_card_payloads,
        )

    @action(detail=True, methods=["get"], url_path="status")
    def card_status(self, request, board_pk=None, pk=None):
        """GET /api/boards/{board_pk}/cards/{pk}/status/

        Returns the archived state of a card regardless of whether it has been
        archived. This is used by the deep-link handler (``?card=``) to show a
        contextual message when the target card is not in the active board view:
        ``{"archived": true}`` means the card exists but is archived; a 404
        response means the card does not belong to this board or has been hard-
        deleted.

        All board members (including viewers) may call this endpoint — it is a
        read operation that exposes no sensitive data beyond what they already
        have access to via the board full endpoint.
        """
        board, _ = self._board_and_role()
        card = get_object_or_404(Card.objects.filter(board=board), pk=pk)
        return Response({"archived": card.archived_at is not None})

    def _plain_card_payload(self, card):
        """Serialize a card with the bare context the archive actions have always used.

        Deliberately *not* ``_refetch_card_data``: that path also threads the
        per-request member-id / assignable-id / label caches into the serializer
        context, which would change this response's query count. Switching these
        two actions onto the cached path is a worthwhile change, but a separate
        and separately measured one — not a side effect of the #1107 extraction.

        ``board`` is the instance already fetched by ``_board_and_role()``, which
        avoids a deferred ``card.board`` FK hit since board is not in
        ``select_related`` here.
        """
        return CardSerializer(
            _card_queryset(Card.objects.filter(pk=card.pk)).get(),
            context={"request": self.request, "board": self._board()},
        ).data

    @action(detail=True, methods=["post"])
    def archive(self, request, board_pk=None, pk=None):
        """Soft-delete a card by setting archived_at to now.

        Member+ role required — same boundary as edit/delete. The card is
        removed from the active board view; analytics counts it only for the
        period it was active (entry -> archive timestamp).

        Archiving an already-archived card is a no-op that still returns the
        card, which is why the service reads it through the unfiltered manager.
        """
        board, role = self._board_and_role()
        result = card_services.archive_card(
            actor=request.user, board=board, role=role, card_id=pk,
            render=self._plain_card_payload,
            # Archiving a blocker drops its targets' blocker_count, so those
            # cards need their own card.updated frames (#449) — batched.
            render_many=self._batch_card_payloads,
        )
        return Response(result.payload)

    @action(detail=True, methods=["post"])
    def unarchive(self, request, board_pk=None, pk=None):
        """Restore a card by clearing archived_at.

        The card re-enters its original column/swimlane position. Because
        get_queryset() filters out archived cards, the service reads the raw
        manager directly.
        """
        board, role = self._board_and_role()
        result = card_services.unarchive_card(
            actor=request.user, board=board, role=role, card_id=pk,
            render=self._plain_card_payload,
            render_many=self._batch_card_payloads,
        )
        return Response(result.payload)

    _ARCHIVED_PAGE_SIZE = 50

    @action(detail=False, methods=["get"], url_path="archived")
    def archived(self, request, board_pk=None):
        """List archived cards for this board, newest first.

        Returns a paginated window of up to 50 cards.  Use the ``offset``
        query parameter to page through results; the response includes
        ``count``, ``offset``, ``page_size``, and ``results``.

        Read access is intentionally open to all board members including
        viewers — listing archived cards is a read operation, consistent with
        viewer access to all other read endpoints. Only archive/unarchive
        (write operations) are restricted to member+.
        """
        board = self._board()
        qs = _card_queryset(Card.objects.filter(board=board, archived_at__isnull=False)).order_by("-archived_at")
        try:
            offset = max(0, int(request.query_params.get("offset", 0)))
        except (ValueError, TypeError):
            offset = 0
        # Annotate `_total` via window function so the page fetch returns the
        # total count alongside each row — saves a second `COUNT(*)` round-trip
        # on boards with long archived history.  Matches the pattern in
        # analytics.py:movements (#929).
        page_qs = list(
            qs.annotate(_total=Window(Count("id")))[offset: offset + self._ARCHIVED_PAGE_SIZE]
        )
        total = page_qs[0]._total if page_qs else 0
        # Pre-compute shared context values so CardSerializer does not call
        # _get_effective_member_ids() once per card instance (O(n) queries).
        member_ids = _get_effective_member_ids(board)
        assignable_ids = _get_assignable_member_ids(board)
        board_labels_qs = Label.objects.filter(board=board)
        serializer = CardSerializer(page_qs, many=True, context={
            "request": request,
            "board": board,
            "_member_ids": member_ids,
            "_assignable_member_ids": assignable_ids,
            "_board_labels_qs": board_labels_qs,
        })
        return Response({
            "count": total,
            "offset": offset,
            "page_size": self._ARCHIVED_PAGE_SIZE,
            "results": serializer.data,
        })

    def update(self, request, *args, **kwargs):
        """Update card fields, recording a CardActivity entry per changed field.

        The invariants — role allow-list, ownership gate, the #1106 rejection of
        a column/swimlane change, the activity diff, the assignee notification,
        the version bump and the deferred broadcast — all live in
        ``boards.services.cards.update_card``. This method parses the request and
        hands the serializer down as the validated-write callable.
        """
        board, role = self._board_and_role()
        # Checked before get_object() so that a caller without the role gets 403
        # rather than 404 on a card that does not exist. The rule still lives in
        # the service; only the ordering is the adapter's concern.
        card_services.require_mutation_role(actor=request.user, board=board, role=role)
        partial = kwargs.pop("partial", False)
        card = self.get_object()

        # request.data need not be a dict (a top-level JSON list, say). Normalize
        # so the service can test field presence with `in`; a non-dict body then
        # fails the serializer's own validation below, exactly as before.
        submitted = request.data if isinstance(request.data, dict) else {}

        def apply():
            serializer = self.get_serializer(card, data=request.data, partial=partial)
            serializer.is_valid(raise_exception=True)
            self.perform_update(serializer)

        result = card_services.update_card(
            actor=request.user,
            board=board,
            role=role,
            card=card,
            submitted=submitted,
            apply=apply,
            render=self._refetch_card_data,
        )
        return Response(result.payload)

    @extend_schema(
        summary="Move a card to a new column, swimlane, or position",
        description=(
            "Moves a card, creating a CardMovement audit record when the column or "
            "swimlane changes. Enforces per-column WIP/weight limits and optimistic "
            "concurrency control (OCC) via the optional `version` field. This is the "
            "only endpoint that may change a card's `column`/`swimlane` — PATCH/PUT on "
            "the card detail endpoint rejects such changes with `use_move_endpoint`."
        ),
        parameters=[
            OpenApiParameter(
                name="force",
                type=OpenApiTypes.BOOL,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "Board admins/site admins only: pass `true` to override a soft "
                    "WIP or weight limit (`wip_limit_exceeded` / `weight_limit_exceeded`). "
                    "Ignored — the move is always blocked — when the board's hard WIP "
                    "mode (`wip_hard_blocked`) is active."
                ),
            ),
        ],
        request=inline_serializer(
            name="CardMoveRequest",
            fields={
                "column_id": serializers.IntegerField(),
                "swimlane_id": serializers.IntegerField(),
                "position": serializers.IntegerField(
                    required=False, default=0,
                    help_text="Zero-based target index within the destination column/swimlane cell.",
                ),
                "version": serializers.IntegerField(
                    required=False, allow_null=True,
                    help_text="OCC version the client last observed; omit to skip the conflict check.",
                ),
            },
        ),
        responses={
            200: inline_serializer(
                name="CardMoveResponse",
                fields={
                    "card": CardSerializer(),
                    "movement": CardMovementSerializer(required=False),
                },
            ),
            400: OpenApiResponse(
                description="`version` was supplied but was not an integer.",
                response=inline_serializer(name="CardMoveVersionTypeError", fields={"detail": serializers.CharField()}),
            ),
            403: OpenApiResponse(
                description=(
                    "Moving a card assigned to another member requires Moderator/Admin "
                    "access (`permission_denied`), or a non-admin attempted to force past "
                    "a WIP/weight limit."
                ),
                response=inline_serializer(
                    name="CardMovePermissionDenied",
                    fields={"code": serializers.CharField(required=False), "detail": serializers.CharField()},
                ),
            ),
            409: OpenApiResponse(
                description=(
                    "`version_conflict` — the card was modified since the client's version; "
                    "`wip_limit_exceeded` / `wip_hard_blocked` — target column is at its WIP "
                    "limit; `weight_limit_exceeded` — target column is at its weight limit."
                ),
                response=inline_serializer(
                    name="CardMoveConflict",
                    fields={
                        "code": serializers.CharField(),
                        "detail": serializers.CharField(required=False),
                        "current_version": serializers.IntegerField(required=False),
                        "column_name": serializers.CharField(required=False),
                        "current_count": serializers.IntegerField(required=False),
                        "wip_limit": serializers.IntegerField(required=False),
                        "current_weight": serializers.IntegerField(required=False),
                        "weight_limit": serializers.IntegerField(required=False),
                        "card_weight": serializers.IntegerField(required=False),
                    },
                ),
            ),
        },
    )
    @action(detail=True, methods=["post"])
    def move(self, request, board_pk=None, pk=None):
        """Move a card to a new column/swimlane/position, creating a CardMovement.

        Every invariant — the row locks and their order, WIP soft/hard and weight
        enforcement, the force-override authorization, OCC, source-cell
        compaction and target-cell shift — lives in
        ``boards.services.cards.move_card``, which also owns the transaction.
        This method only parses the request body and query string.

        Note there is no ``@transaction.atomic`` here any more: the service opens
        the transaction, and it must be the one to do so because the card row is
        read under ``select_for_update()`` as its first statement. Nothing in
        this method may issue a locking or mutating query before the call.
        """
        board, role = self._board_and_role()

        def render(card, movement):
            # Re-fetch through _card_queryset so CardSerializer has every
            # prefetch populated — the instance the service holds was loaded for
            # locking and would otherwise trigger ~7 extra queries.
            data = {
                "card": CardSerializer(
                    _card_queryset(Card.objects.filter(pk=card.pk)).get(),
                    context={"request": request, "board": board},
                ).data
            }
            if movement is not None:
                # Re-fetch with FK relations loaded so CardMovementSerializer does
                # not issue separate queries for moved_by, card.uid and card.title.
                movement = CardMovement.objects.select_related(
                    "moved_by", "card", "from_column", "to_column",
                    "from_swimlane", "to_swimlane",
                ).get(pk=movement.pk)
                data["movement"] = CardMovementSerializer(movement).data
            return data

        result = card_services.move_card(
            actor=request.user,
            board=board,
            role=role,
            card_id=pk,
            target_column_id=request.data.get("column_id"),
            target_swimlane_id=request.data.get("swimlane_id"),
            position=request.data.get("position", 0),
            # Passed raw: the service coerces it, so the "version must be an
            # integer" 400 lands after the role, lookup and assignment checks
            # exactly as it did before the extraction.
            expected_version=request.data.get("version"),
            force=request.query_params.get("force", "").lower() == "true",
            render=render,
        )
        return Response(result.payload)

    @action(detail=True, methods=["get"])
    def movements(self, request, board_pk=None, pk=None):
        """Return the full movement history for a card."""
        board = self._board()
        card = get_object_or_404(Card, pk=pk, board=board)
        movements = card.movements.select_related(
            "card", "from_column", "to_column", "from_swimlane", "to_swimlane", "moved_by"
        )
        return Response(CardMovementSerializer(movements, many=True, context={"request": request}).data)

    @action(detail=True, methods=["get"])
    def activities(self, request, board_pk=None, pk=None):
        """Return the field-change activity log for a card."""
        board = self._board()
        card = get_object_or_404(Card, pk=pk, board=board)
        serializer = CardActivitySerializer(card.activities.select_related("actor"), many=True)
        return Response(serializer.data)

    # ---------------------------------------------------------------------------
    # Unified timeline endpoint (#746)
    # ---------------------------------------------------------------------------

    # Maps ?event_types filter group names to their concrete event_type values
    # in CardActivity. "move" is handled separately (CardMovement items).
    _TIMELINE_ACTIVITY_GROUPS = {
        "comment": ["comment_added"],
        "field": [
            "priority_change", "weight_change", "assignee_change",
            "label_change", "title_change", "description_change", "due_date_change",
        ],
        "checklist": [
            "checklist_item_added", "checklist_item_checked",
            "checklist_item_unchecked", "checklist_item_deleted",
        ],
        "attachment": ["attachment_added", "attachment_deleted"],
        "system": ["archived", "reactivated"],
    }

    @action(detail=True, methods=["get"])
    def timeline(self, request, board_pk=None, pk=None):
        """Return a unified, paginated timeline of card movements and field-change activities.

        Query params:
          event_types  Comma-separated filter groups: move, comment, field, checklist,
                       attachment, system. Omit to include all events.
          limit        Page size (default 50, max 200).
          offset       Page offset (default 0).

        Response shape:
          { count, next, previous, results: [CardTimelineEntry, ...] }

        Entries are sorted newest-first. Movements and activities are merged at the
        Python level because QuerySet.union() does not preserve per-model fields.
        """
        board = self._board()
        card = get_object_or_404(Card, pk=pk, board=board)

        # --- Parse pagination params ---
        try:
            limit = min(int(request.query_params.get("limit", 50)), 200)
        except (TypeError, ValueError):
            limit = 50
        try:
            offset = max(int(request.query_params.get("offset", 0)), 0)
        except (TypeError, ValueError):
            offset = 0

        # --- Parse optional event_types filter ---
        raw_types = request.query_params.get("event_types", "")
        requested_groups = [g.strip() for g in raw_types.split(",") if g.strip()] if raw_types else []

        # Validate: unknown group names are a client error, not a silent empty page.
        # "move" is handled separately from the activity group map; add it explicitly
        # so validation accepts it.
        valid_groups = set(self._TIMELINE_ACTIVITY_GROUPS.keys()) | {"move"}
        invalid = [g for g in requested_groups if g not in valid_groups]
        if invalid:
            return Response(
                {"detail": f"Invalid event_types: {', '.join(sorted(set(invalid)))}. "
                           f"Valid groups: {', '.join(sorted(valid_groups))}."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        include_moves = not requested_groups or "move" in requested_groups

        # Collect activity event_type values for the requested groups
        activity_event_types: list[str] = []
        if not requested_groups:
            # All groups
            for values in self._TIMELINE_ACTIVITY_GROUPS.values():
                activity_event_types.extend(values)
        else:
            for group in requested_groups:
                if group in self._TIMELINE_ACTIVITY_GROUPS:
                    activity_event_types.extend(self._TIMELINE_ACTIVITY_GROUPS[group])

        # --- Build raw entry lists ---
        # Use unsliced querysets for accurate total counts, then cap each at
        # offset+limit rows before iterating. Both querysets are ordered newest-
        # first, so the top (offset+limit) rows from each source are guaranteed
        # to contain every row that could appear on the requested page.
        raw_entries: list[dict] = []

        fetch_cap = offset + limit

        # Annotate `_total` via window function so the page fetch carries the
        # full count alongside each row — avoids a separate COUNT(*) round-trip
        # for movements and activities (#798).
        if include_moves:
            movements_qs = (
                CardMovement.objects.filter(card=card)
                .select_related("moved_by")
                .order_by("-moved_at")
            )
            capped_movements = list(
                movements_qs.annotate(_total=Window(Count("id")))[:fetch_cap]
            )
            move_count = capped_movements[0]._total if capped_movements else 0
        else:
            move_count = 0
            capped_movements = []

        if activity_event_types:
            activities_qs = (
                CardActivity.objects.filter(card=card, event_type__in=activity_event_types)
                .select_related("actor")
                .order_by("-created_at")
            )
            capped_activities = list(
                activities_qs.annotate(_total=Window(Count("id")))[:fetch_cap]
            )
            activity_count = capped_activities[0]._total if capped_activities else 0
        else:
            activity_count = 0
            capped_activities = []

        total_count = move_count + activity_count

        for m in capped_movements:
            actor_obj = m.moved_by
            raw_entries.append({
                "id": m.id,
                "kind": "move",
                "ts": m.moved_at,
                "actor": actor_obj,
                "event_type": m.movement_type or "move",
                "data": {
                    "id": m.id,
                    "from_column": m.from_column_id,
                    "from_column_name": m.from_column_name,
                    "to_column": m.to_column_id,
                    "to_column_name": m.to_column_name,
                    "from_swimlane": m.from_swimlane_id,
                    "from_swimlane_name": m.from_swimlane_name,
                    "to_swimlane": m.to_swimlane_id,
                    "to_swimlane_name": m.to_swimlane_name,
                    "moved_at": m.moved_at.isoformat(),
                    "movement_type": m.movement_type,
                    "notes": m.notes,
                },
            })

        for a in capped_activities:
            actor_obj = a.actor
            raw_entries.append({
                "id": a.id,
                "kind": "activity",
                "ts": a.created_at,
                "actor": actor_obj,
                "event_type": a.event_type,
                "data": {
                    "event_type": a.event_type,
                    "from_value": a.from_value,
                    "to_value": a.to_value,
                },
            })

        # --- Sort merged list newest-first ---
        raw_entries.sort(key=lambda e: e["ts"], reverse=True)

        # --- Slice for pagination ---
        page = raw_entries[offset: offset + limit]

        # --- Build next/previous URLs ---
        base_url = request.build_absolute_uri(request.path)
        query_base = {}
        if raw_types:
            query_base["event_types"] = raw_types
        query_base["limit"] = limit

        def _page_url(new_offset: int) -> str | None:
            if new_offset < 0 or new_offset >= total_count:
                return None
            params = {**query_base, "offset": new_offset}
            return f"{base_url}?{urlencode(params)}"

        next_url = _page_url(offset + limit)
        previous_url = _page_url(offset - limit) if offset > 0 else None

        serializer = CardTimelineEntrySerializer(page, many=True)
        return Response({
            "count": total_count,
            "next": next_url,
            "previous": previous_url,
            "results": serializer.data,
        })

    @extend_schema(
        summary="List comments on a card",
        methods=["GET"],
        responses=CardCommentSerializer(many=True),
    )
    @extend_schema(
        summary="Add a comment on a card",
        description="Also parses @mentions in the comment body and notifies mentioned board members.",
        methods=["POST"],
        request=CardCommentSerializer,
        responses={
            201: CardCommentSerializer,
            403: OpenApiResponse(
                description="Viewers cannot comment (collaborators and above may).",
                response=inline_serializer(name="CommentViewerDenied", fields={"detail": serializers.CharField()}),
            ),
        },
    )
    @action(detail=True, methods=["post", "get"])
    def comments(self, request, board_pk=None, pk=None):
        """List or add comments on a card; POST also handles @mention notifications."""
        board, role = self._board_and_role()
        card = get_object_or_404(Card, pk=pk, board=board)
        if request.method == "GET":
            return Response(CardCommentSerializer(card.comments.select_related("author"), many=True).data)
        # Only viewers are blocked — collaborators are intentionally allowed to
        # comment on cards.  See docs/features/rbac/roles.md permission table.
        if role == BoardMembership.Role.VIEWER:
            return Response(
                {"detail": _VIEWER_DENIED},
                status=status.HTTP_403_FORBIDDEN,
            )
        serializer = CardCommentSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        with transaction.atomic():
            comment = serializer.save(card=card, author=request.user)
            CardActivity.objects.create(
                card=card, event_type=CardActivity.EventType.COMMENT_ADDED,
                from_value="", to_value="", actor=request.user,
            )
            card_data = self._refetch_card_data(card)
            board_id = board.id
            _broadcast.record_board_event(board_id, _EVT_CARD_UPDATED, card_data, actor_id=request.user.id)
            # Parse @username mentions and notify each mentioned board member.
            # Comments don't need a re-notification guard — each comment is a new event.
            mentioned_usernames = extract_mentions(comment.body)
            if mentioned_usernames:
                eff_ids = self._board_context()["member_ids"]
                member_users = User.objects.filter(
                    username__in=mentioned_usernames,
                    pk__in=eff_ids,
                    notif_mentioned=True,
                ).exclude(pk=request.user.pk)
                Notification.objects.bulk_create([
                    Notification(
                        recipient=u,
                        actor=request.user,
                        action_type=Notification.ActionType.MENTIONED,
                        verb=f"{request.user.username} mentioned you in \"{card.title}\"",
                        card=card,
                        board=board,
                    )
                    for u in member_users
                ])
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["delete"], url_path=r"comments/(?P<comment_pk>[0-9]+)")
    def delete_comment(self, request, board_pk=None, pk=None, comment_pk=None):
        """Delete a comment. Non-moderator members and collaborators may only delete their own."""
        board, role = self._board_and_role()
        # Only viewers are blocked — collaborators may delete their own comments.
        # See docs/features/rbac/roles.md permission table.
        if role == BoardMembership.Role.VIEWER:
            return Response(
                {"detail": _VIEWER_DENIED},
                status=status.HTTP_403_FORBIDDEN,
            )
        card = get_object_or_404(Card, pk=pk, board=board)
        comment = get_object_or_404(CardComment, pk=comment_pk, card=card)
        # Ownership gate: members and collaborators may only delete their own
        # comments unless the member has the moderator entitlement (#362).
        if comment.author_id != request.user.id:
            if not _can_modify_others_content(board, role, request.user):
                return Response(
                    {"detail": "You can only delete your own comments."},
                    status=status.HTTP_403_FORBIDDEN,
                )
        with transaction.atomic():
            comment.delete()
            card_data = self._refetch_card_data(card)
            board_id = board.id
            _broadcast.record_board_event(board_id, _EVT_CARD_UPDATED, card_data, actor_id=request.user.id)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["get", "post"], url_path="attachments")
    def attachments(self, request, board_pk=None, pk=None):
        """List attachments on a card or upload a new one (max 10 MB)."""
        board, role = self._board_and_role()
        card = get_object_or_404(Card, pk=pk, board=board)

        if request.method == "GET":
            serializer = CardAttachmentSerializer(
                card.attachments.select_related("uploaded_by"), many=True, context={"request": request}
            )
            return Response(serializer.data)

        # Only viewers are blocked — collaborators are intentionally allowed to
        # upload attachments.  See docs/features/rbac/roles.md permission table.
        if role == BoardMembership.Role.VIEWER:
            return Response(
                {"detail": _VIEWER_DENIED},
                status=status.HTTP_403_FORBIDDEN,
            )

        # Check instance-wide feature toggle. This applies to all users
        # including admins — disabling uploads halts all new uploads.
        if not get_uploads_enabled():
            return Response(
                {"code": "feature_disabled", "detail": "File uploads are disabled by the site administrator."},
                status=status.HTTP_403_FORBIDDEN,
            )

        file = request.FILES.get("file")
        if not file:
            return Response({"detail": "No file provided."}, status=status.HTTP_400_BAD_REQUEST)

        max_size = getattr(django_settings, "MAX_UPLOAD_SIZE", 10 * 1024 * 1024)
        if file.size > max_size:
            return Response(
                {"detail": f"File too large. Maximum size is {max_size // (1024 * 1024)} MB."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Validate MIME type and magic bytes against the allowlist.  This must
        # happen before the file is saved to storage so that an invalid upload
        # never touches the filesystem or object store.
        mime_error = _validate_upload_mime(file)
        if mime_error:
            # Log every rejection so an active probe (many failures from one user
            # or one IP) can be distinguished from benign user errors during an
            # incident review.  The filename is intentionally omitted — it can
            # contain PII supplied by the uploader (#923).
            logger.warning(
                "Attachment upload rejected: declared_type=%s board=%s card=%s user=%s reason=%s",
                getattr(file, "content_type", None),
                board.id,
                card.id,
                request.user.id,
                mime_error,
            )
            return Response({"detail": mime_error}, status=status.HTTP_400_BAD_REQUEST)

        # Wrap create + broadcast in an atomic block so that on_commit only fires
        # after both the CardAttachment row and the serialized card_data are
        # consistent.  Without this, on_commit fires immediately on Django's
        # default ATOMIC_REQUESTS=False configuration, which can broadcast a
        # partial card state if the serializer raises after the row is saved.
        with transaction.atomic():
            attachment = CardAttachment.objects.create(
                card=card,
                file=file,
                # Sanitize filename for safe use in Content-Disposition headers.
                # get_valid_filename() removes path traversal characters and
                # replaces spaces/special chars. We additionally strip CR, LF,
                # and null bytes which can inject extra headers or terminate the
                # header value early if the browser sends a crafted filename.
                filename=_sanitize_attachment_filename(file.name),
                size=file.size,
                uploaded_by=request.user,
            )
            card_data = self._refetch_card_data(card)
            board_id = board.id
            _broadcast.record_board_event(board_id, _EVT_CARD_UPDATED, card_data, actor_id=request.user.id)
        serializer = CardAttachmentSerializer(attachment, context={"request": request})
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["delete"], url_path=r"attachments/(?P<attachment_pk>[0-9]+)")
    def delete_attachment(self, request, board_pk=None, pk=None, attachment_pk=None):
        """Delete an attachment and its underlying file from storage."""
        board, role = self._board_and_role()
        # Only viewers are blocked — collaborators may delete their own attachments.
        # See docs/features/rbac/roles.md permission table.
        if role == BoardMembership.Role.VIEWER:
            return Response(
                {"detail": _VIEWER_DENIED},
                status=status.HTTP_403_FORBIDDEN,
            )
        card = get_object_or_404(Card, pk=pk, board=board)
        attachment = get_object_or_404(CardAttachment, pk=attachment_pk, card=card)
        # Ownership gate: members and collaborators may only delete their own
        # attachments unless the member has the moderator entitlement (#362).
        # This mirrors the ownership check on delete_comment.
        if attachment.uploaded_by != request.user:
            if not _can_modify_others_content(board, role, request.user):
                return Response(
                    {"detail": "You can only delete your own attachments."},
                    status=status.HTTP_403_FORBIDDEN,
                )
        with transaction.atomic():
            attachment.file.delete(save=False)
            attachment.delete()
            card_data = self._refetch_card_data(card)
            board_id = board.id
            _broadcast.record_board_event(board_id, _EVT_CARD_UPDATED, card_data, actor_id=request.user.id)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @extend_schema(
        summary="List checklist items on a card",
        methods=["GET"],
        responses=CardChecklistSerializer(many=True),
    )
    @extend_schema(
        summary="Add a checklist item to a card",
        description="`position` is assigned server-side (appended to the end); any client-supplied value is ignored.",
        methods=["POST"],
        request=CardChecklistSerializer,
        responses={
            201: CardChecklistSerializer,
            403: OpenApiResponse(
                description="Viewers cannot add checklist items.",
                response=inline_serializer(name="ChecklistViewerDenied", fields={"detail": serializers.CharField()}),
            ),
        },
    )
    @action(detail=True, methods=["get", "post"], url_path="checklist")
    def checklist(self, request, board_pk=None, pk=None):
        """List checklist items on a card or add a new one."""
        board, role = self._board_and_role()
        # select_related("created_by") inside the prefetch avoids an N+1: the
        # GET path serializes each item with CardChecklistSerializer, whose
        # ``created_by`` is a nested user serializer (#995 follow-up).
        card = get_object_or_404(
            Card.objects.prefetch_related(
                Prefetch(
                    "checklist_items",
                    queryset=CardChecklist.objects.select_related("created_by"),
                )
            ),
            pk=pk,
            board=board,
        )
        if request.method == "GET":
            items = card.checklist_items.all()
            return Response(CardChecklistSerializer(items, many=True).data)
        # Allow-list: collaborator, member, admin, and site_admin may add
        # checklist items; only viewers are blocked. Using an allow-list rather
        # than a block-list ensures any future role must be explicitly granted
        # access rather than inheriting it silently.
        # SITE_ADMIN access is handled upstream by can_access_all_content.
        if role not in (BoardMembership.Role.COLLABORATOR, BoardMembership.Role.MEMBER, BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied(_PERM_DENIED)
        serializer = CardChecklistSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        # Read from the prefetch cache populated by the get_object_or_404
        # call above (#995).  ``.count()`` always issues a fresh COUNT(*)
        # and would defeat the prefetch that was the entire point of the fetch.
        position = len(card.checklist_items.all())
        with transaction.atomic():
            item = serializer.save(card=card, position=position, created_by=request.user)
            CardActivity.objects.create(
                card=card, event_type=CardActivity.EventType.CHECKLIST_ITEM_ADDED,
                from_value="", to_value=item.text, actor=request.user,
            )
            card_data = self._refetch_card_data(card)
            board_id = board.id
            _broadcast.record_board_event(board_id, _EVT_CARD_UPDATED, card_data, actor_id=request.user.id)
        return Response(CardChecklistSerializer(item).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["patch", "delete"], url_path=r"checklist/(?P<item_pk>[0-9]+)")
    def checklist_item(self, request, board_pk=None, pk=None, item_pk=None):
        """Update (PATCH) or delete a single checklist item."""
        board, role = self._board_and_role()
        # Allow-list: collaborator, member, admin, and site_admin may edit/delete
        # checklist items; only viewers are blocked. Using an allow-list rather
        # than a block-list ensures any future role must be explicitly granted
        # access rather than inheriting it silently.
        # SITE_ADMIN access is handled upstream by can_access_all_content.
        if role not in (BoardMembership.Role.COLLABORATOR, BoardMembership.Role.MEMBER, BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied(_PERM_DENIED)
        card = get_object_or_404(Card, pk=pk, board=board)
        item = get_object_or_404(CardChecklist, pk=item_pk, card=card)
        # Ownership gate: collaborators and members may only edit/delete items
        # they created. Admins and moderators may edit any item. Null created_by
        # (pre-migration rows) is treated as unrestricted for backward compat.
        if item.created_by_id and item.created_by_id != request.user.id:
            if not _can_modify_others_content(board, role, request.user):
                raise PermissionDenied("You can only edit checklist items you created.")
        if request.method == "DELETE":
            with transaction.atomic():
                CardActivity.objects.create(
                    card=card, event_type=CardActivity.EventType.CHECKLIST_ITEM_DELETED,
                    from_value=item.text, to_value="", actor=request.user,
                )
                item.delete()
                card_data = self._refetch_card_data(card)
                board_id = board.id
                _broadcast.record_board_event(board_id, _EVT_CARD_UPDATED, card_data, actor_id=request.user.id)
            return Response(status=status.HTTP_204_NO_CONTENT)
        old_checked = item.is_checked
        serializer = CardChecklistSerializer(item, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        with transaction.atomic():
            serializer.save()
            if "is_checked" in request.data and request.data["is_checked"] != old_checked:
                checklist_event_type = (
                    CardActivity.EventType.CHECKLIST_ITEM_CHECKED
                    if item.is_checked
                    else CardActivity.EventType.CHECKLIST_ITEM_UNCHECKED
                )
                CardActivity.objects.create(
                    card=card, event_type=checklist_event_type,
                    from_value="", to_value=item.text, actor=request.user,
                )
            card_data = self._refetch_card_data(card)
            board_id = board.id
            _broadcast.record_board_event(board_id, _EVT_CARD_UPDATED, card_data, actor_id=request.user.id)
        return Response(serializer.data)

    # -- card relations (#449) ----------------------------------------------

    def _resolve_relations(self, card):
        """Return ``card``'s relations as view rows, resolved to its point of view.

        The model stores one canonical direction per relation (see
        ``CardRelation``), so the same row reads as "blocks" from one end and
        "blocked by" from the other. This is where that resolution happens:
        rows where ``card`` is ``from_card`` read forwards, rows where it is
        ``to_card`` read backwards, and the symmetric types read the same
        either way.

        Two queries total, each with the neighbor card joined — the join is
        what keeps ``LinkedCardSerializer`` from resolving a FK per row.
        Archived neighbors are deliberately included; they are flagged rather
        than hidden so a relation left dangling by an archive is visible enough
        to delete.
        """
        outgoing = card.outgoing_relations.select_related("to_card")
        incoming = card.incoming_relations.select_related("from_card")
        rows = []
        for rel in outgoing:
            rows.append({
                "id": rel.id,
                "relation_type": rel.relation_type,
                "direction": rel.relation_type,
                "card": rel.to_card,
                "created_at": rel.created_at,
            })
        for rel in incoming:
            rows.append({
                "id": rel.id,
                "relation_type": rel.relation_type,
                # A symmetric type reads identically from either end, so only
                # the asymmetric ones get an inverted direction label.
                "direction": (
                    rel.relation_type
                    if rel.relation_type in CardRelation.SYMMETRIC_TYPES
                    else "blocked_by"
                ),
                "card": rel.from_card,
                "created_at": rel.created_at,
            })
        # Stable, meaningful order: what blocks me first (it is the thing I can
        # act on), then what I block, then loose associations. Sorting in
        # Python rather than SQL because the two directions come from two
        # queries and the rank is a property of the resolved row, not the row
        # on disk.
        rank = {"blocked_by": 0, "blocks": 1}
        rows.sort(key=lambda r: (rank.get(r["direction"], 2), r["created_at"], r["id"]))
        return rows

    @extend_schema(
        methods=["GET"],
        responses={200: CardRelationSerializer(many=True)},
        description=(
            "List this card's relations, resolved to this card's point of view "
            "(`blocks`, `blocked_by`, `relates_to`)."
        ),
    )
    @extend_schema(
        methods=["POST"],
        request=CardRelationCreateSerializer,
        responses={201: CardRelationSerializer},
        description=(
            "Link this card to another card on the same board. Minimum role: "
            "collaborator. Cross-board targets, self-relations, duplicates and "
            "mutual blocks are rejected with 400."
        ),
    )
    @action(detail=True, methods=["get", "post"], url_path="relations")
    def relations(self, request, board_pk=None, pk=None):
        """List this card's relations, or link it to another card on the board."""
        board, role = self._board_and_role()
        # Object-level authorization: `board=board` scopes the lookup to a board
        # this user was already resolved onto by _board_and_role(), so a card
        # PK from another board 404s instead of being operated on (IDOR).
        card = get_object_or_404(Card, pk=pk, board=board)

        if request.method == "GET":
            return Response(
                CardRelationSerializer(self._resolve_relations(card), many=True).data
            )

        # Allow-list: member, admin and site_admin may link cards. Viewers and
        # **collaborators** are both blocked. An allow-list rather than a
        # block-list means any future role must be granted access explicitly
        # rather than inheriting it silently.
        #
        # Deliberately one tier stricter than the checklist actions in this
        # same file, which admit collaborators. A checklist item is an
        # annotation *on* a card; a relation changes how a *different* card
        # reads for everyone on the board, because `blocker_count` renders on
        # every viewer's card face. The role docs describe collaborators as
        # having read-only access to cards themselves — they annotate, they do
        # not change card state — and a relation falls on the card-state side
        # of that line.
        #
        # This is also the reversible direction. Loosening a permission later
        # is backward compatible; tightening one is a breaking change for
        # anyone who had come to rely on it. Starting at member and relaxing to
        # collaborator later if that proves wrong costs nothing; the reverse
        # would need a major version. Keep this in step with `canEdit` in
        # frontend/src/components/Card/CardDetail.tsx, which gates the UI on
        # exactly this set.
        if role not in (BoardMembership.Role.MEMBER, BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied(_PERM_DENIED)

        # `board` in context is the second half of the IDOR gate: it scopes the
        # `to_card` lookup to this board, so the *target* card is verified to
        # belong to a board this user is a member of, not just the card in the
        # URL. Without it a member of board A could link to an arbitrary card on
        # board B and read back its id, title and column.
        serializer = CardRelationCreateSerializer(
            data=request.data, context={"board": board, "from_card": card},
        )

        # Validation runs INSIDE the transaction, behind a row lock on both
        # endpoint cards. The duplicate and mutual-block guards in the
        # serializer are `.exists()` reads, and under READ COMMITTED two
        # concurrent opposite-direction requests would each miss the other's
        # uncommitted insert and both commit — producing exactly the A-blocks-B
        # -and-B-blocks-A state the model docstring says cannot exist.
        # `unique_together` does not backstop that: (A, B, blocks) and
        # (B, A, blocks) are two different tuples.
        #
        # Locking is ordered by pk so two requests naming the same pair in
        # opposite directions queue instead of deadlocking, and it is
        # board-scoped so it can only ever lock rows the caller already has
        # access to. On a backend without SELECT FOR UPDATE (SQLite, used by
        # the test harness) it is skipped — SQLite serializes writers at the
        # database level, so the race it guards against cannot occur there.
        # A ValidationError raised in here rolls back an empty transaction and
        # still reaches DRF as a 400.
        with transaction.atomic():
            if connection.features.has_select_for_update:
                lock_ids = {card.pk}
                raw_target = request.data.get("to_card")
                try:
                    lock_ids.add(int(raw_target))
                except (TypeError, ValueError):
                    # Not a usable id — the serializer will reject it in a
                    # moment; locking only the card in the URL is enough.
                    pass
                list(
                    Card.objects.select_for_update()
                    .filter(board=board, pk__in=sorted(lock_ids))
                    .order_by("pk")
                )

            serializer.is_valid(raise_exception=True)
            # from_card/to_card come back resolved and ordered by the
            # serializer: a `blocked_by` request inverts them, and a
            # `relates_to` request is normalized by card id. The view stores
            # what it is handed.
            from_card = serializer.validated_data["from_card"]
            to_card = serializer.validated_data["to_card"]

            try:
                relation = CardRelation.objects.create(
                    from_card=from_card,
                    to_card=to_card,
                    relation_type=serializer.validated_data["relation_type"],
                    created_by=request.user,
                )
            except IntegrityError:
                # Belt and braces for the same race on a backend where the lock
                # above was skipped: the unique constraint caught it, so report
                # it the way the serializer would have rather than as a 500.
                raise serializers.ValidationError(
                    {"code": "relation_exists", "detail": "That relation already exists."}
                ) from None
            self._broadcast_relation_change(board, from_card, to_card, request)

        # Serialize from the requesting card's point of view, which may be
        # either end of the row once a symmetric type has been normalized.
        rows = [r for r in self._resolve_relations(card) if r["id"] == relation.id]
        return Response(
            CardRelationSerializer(rows[0]).data, status=status.HTTP_201_CREATED
        )

    @extend_schema(
        responses={204: OpenApiResponse(description="Relation removed.")},
        description=(
            "Remove a relation. The relation must involve this card at one end. "
            "Minimum role: collaborator."
        ),
    )
    @action(detail=True, methods=["delete"], url_path="relations/(?P<relation_pk>[^/.]+)")
    def relation_detail(self, request, board_pk=None, pk=None, relation_pk=None):
        """Delete one relation, from either end of it."""
        board, role = self._board_and_role()
        # Same allow-list as creating one — see the reasoning there.
        if role not in (BoardMembership.Role.MEMBER, BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied(_PERM_DENIED)
        card = get_object_or_404(Card, pk=pk, board=board)
        # The Q() is the object-level authorization for the relation itself:
        # without it, any relation PK on the instance could be deleted through
        # any card the user can reach. A relation is deletable from *either*
        # end because both cards display it, and the permission to unlink is
        # the same permission from both sides.
        #
        # There is deliberately **no** per-creator ownership gate here, unlike
        # `checklist_item` above. That gate exists because collaborators can
        # add checklist items and should not edit each other's; relations are
        # member-and-above only, and a member can already retitle, reassign and
        # move any card on the board. Withholding "unlink these two cards" from
        # someone who can rewrite both of them would be an arbitrary line. A
        # relation is also two-sided — `created_by` names who drew the link,
        # not who owns either endpoint — so "your own relation" is not a
        # coherent notion the way "your own comment" is. `created_by` is
        # retained for attribution and audit, not for authorization.
        relation = get_object_or_404(
            CardRelation.objects.select_related("from_card", "to_card"),
            Q(from_card=card) | Q(to_card=card),
            pk=relation_pk,
        )
        from_card, to_card = relation.from_card, relation.to_card

        with transaction.atomic():
            relation.delete()
            self._broadcast_relation_change(board, from_card, to_card, request)
        return Response(status=status.HTTP_204_NO_CONTENT)

    def _broadcast_relation_change(self, board, from_card, to_card, request):
        """Publish ``card.updated`` for BOTH ends of a relation (#449).

        A relation change is one write that alters two cards: the blocked card's
        `blocker_count` moves, and both cards' Relations lists do. The board
        store applies `card.updated` by replacing the card with that id
        wholesale, so a single frame structurally cannot update two cards, and a
        partial `{id, blocker_count}` payload would wipe every other field of
        that card in every connected client. Hence two frames, each carrying a
        complete re-serialized card.

        Both go through ``record_board_event`` inside the caller's
        ``transaction.atomic()``: each feed row and its deferred publish commit
        or roll back with the relation write, so a rolled-back relation
        broadcasts nothing. Two feed rows is the correct count for the
        resumable cursor (#1114), not waste — a client resuming past only one
        of them would hold the other card stale forever.

        Both cards are re-fetched in **one** ``_card_queryset`` pass rather than
        one per card: the prefetch chain costs the same for a two-row queryset
        as for a one-row one, so calling ``_refetch_card_data`` twice would
        duplicate the whole seven-query chain for nothing. The fetch happens
        after the relation row is written and inside the caller's transaction,
        so each payload's ``blocker_count`` reflects the write rather than a
        pre-write cache.
        """
        bc = self._board_context()
        by_id = {
            c.pk: c
            for c in _card_queryset(Card.objects.filter(pk__in=[from_card.pk, to_card.pk]))
        }
        for card_pk in (from_card.pk, to_card.pk):
            refetched = by_id.get(card_pk)
            if refetched is None:
                continue
            _broadcast.record_board_event(
                board.id,
                _EVT_CARD_UPDATED,
                CardSerializer(
                    refetched,
                    context={
                        "request": request,
                        "board": bc["board"],
                        "_member_ids": bc["member_ids"],
                        "_assignable_member_ids": bc["assignable_ids"],
                        "_board_labels_qs": bc["labels_qs"],
                    },
                ).data,
                actor_id=request.user.id,
            )
