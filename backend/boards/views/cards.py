"""CardViewSet — CRUD endpoints for cards on a board, including move, archive, comments, etc."""

import datetime
import os
from urllib.parse import urlencode

import django_filters
from django.db import transaction
from django.db.models import F, Q, Sum, prefetch_related_objects
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response

from django.conf import settings as django_settings
from accounts.models import User, get_uploads_enabled

from .. import broadcast as _broadcast
from ..utils import extract_mentions, _get_effective_member_ids, _get_assignable_member_ids, notify_new_mentions
from ..models import (
    BoardMembership, Card, CardActivity, CardAttachment,
    CardChecklist, CardComment, CardMovement, Column, Label,
    Notification, Swimlane,
)
from ..permissions import SITE_ADMIN
from ..serializers import (
    CardSerializer, CardMovementSerializer, CardCommentSerializer,
    CardActivitySerializer, CardAttachmentSerializer, CardChecklistSerializer,
    CardTimelineEntrySerializer,
    _card_queryset,
)
from ._helpers import get_board_for_user, _can_modify_others_content, _refetched_card_data

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

    def perform_create(self, serializer):
        board, role = self._board_and_role()
        # Allow-list: only member, admin, or site_admin may create cards.
        # A block-list (VIEWER, COLLABORATOR) would silently allow any future
        # role added to the system — the allow-list is the safe default.
        if role not in (BoardMembership.Role.MEMBER, BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied(_PERM_DENIED)
        column = get_object_or_404(Column, pk=serializer.validated_data["column"].pk, board=board)
        if not column.allow_card_creation:
            raise ValidationError({"column": "Card creation is not allowed in this column."})
        swimlane = get_object_or_404(Swimlane, pk=serializer.validated_data["swimlane"].pk, board=board)
        max_pos = Card.objects.filter(board=board, column=column, swimlane=swimlane).count()
        with transaction.atomic():
            card = serializer.save(board=board, created_by=self.request.user, position=max_pos)
            CardMovement.objects.create(
                card=card,
                from_column=None,
                from_column_name="",
                from_column_uid="",
                from_swimlane=None,
                from_swimlane_name="",
                from_swimlane_uid="",
                to_column=column,
                to_column_name=column.name,
                to_column_uid=column.uid,
                to_swimlane=swimlane,
                to_swimlane_name=swimlane.name,
                to_swimlane_uid=swimlane.uid,
                moved_by=self.request.user,
                notes="Card created",
            )
            card_data = self._refetch_card_data(card)
            transaction.on_commit(lambda: _broadcast.broadcast_board_event(board.id, "card.created", card_data))
            if card.description:
                # Notify any @mentioned board members in the initial description.
                # Captured in local vars to avoid closure mutation after the lambda is registered.
                _card, _actor, _desc = card, self.request.user, card.description
                transaction.on_commit(lambda: notify_new_mentions(_card, _actor, "", _desc))

    def perform_destroy(self, instance):
        board, role = self._board_and_role()
        # Allow-list: same pattern as perform_create — safer than block-list.
        if role not in (BoardMembership.Role.MEMBER, BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied(_PERM_DENIED)
        # Ownership gate: members may only delete cards they created, unless
        # they have the moderator entitlement (#362).
        if instance.created_by_id != self.request.user.id:
            if not _can_modify_others_content(board, role, self.request.user):
                raise PermissionDenied("You can only delete cards you created.")
        board_id = instance.board_id
        card_uid = instance.uid
        with transaction.atomic():
            instance.delete()
            transaction.on_commit(lambda: _broadcast.broadcast_board_event(board_id, "card.deleted", {"card_uid": card_uid}))

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

    @action(detail=True, methods=["post"])
    def archive(self, request, board_pk=None, pk=None):
        """Soft-delete a card by setting archived_at to now.

        Member+ role required — same boundary as edit/delete. The card is
        removed from the active board view; analytics counts it only for the
        period it was active (entry -> archive timestamp).
        """
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.MEMBER, BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        # Use the unfiltered manager so archiving an already-archived card is
        # a no-op rather than a 404.
        # select_related avoids extra queries when accessing card.column.name
        # and card.swimlane.name in the CardMovement creation below.
        card = get_object_or_404(
            Card.objects.select_related("column", "swimlane"),
            pk=pk, board=board,
        )
        # Ownership gate: members may only archive cards they created (#362).
        if card.created_by_id != request.user.id:
            if not _can_modify_others_content(board, role, request.user):
                raise PermissionDenied("You can only archive cards you created.")
        if card.archived_at is None:
            board_id = card.board_id
            card_uid = card.uid
            with transaction.atomic():
                card.archived_at = timezone.now()
                card.save(update_fields=["archived_at"])
                # Record an archive event in movement history so the audit trail
                # is complete and cycle-time calculations can use archived_at as
                # the terminal timestamp. from/to columns are both the current
                # column (position hasn't changed — just the archive state).
                CardMovement.objects.create(
                    card=card,
                    from_column=card.column,
                    from_column_name=card.column.name if card.column else "",
                    from_column_uid=card.column.uid if card.column else "",
                    to_column=card.column,
                    to_column_name=card.column.name if card.column else "",
                    to_column_uid=card.column.uid if card.column else "",
                    from_swimlane=card.swimlane,
                    from_swimlane_name=card.swimlane.name if card.swimlane else "",
                    from_swimlane_uid=card.swimlane.uid if card.swimlane else "",
                    to_swimlane=card.swimlane,
                    to_swimlane_name=card.swimlane.name if card.swimlane else "",
                    to_swimlane_uid=card.swimlane.uid if card.swimlane else "",
                    moved_by=request.user,
                    movement_type=CardMovement.MovementType.ARCHIVED,
                )
                transaction.on_commit(lambda: _broadcast.broadcast_board_event(board_id, "card.archived", {"card_uid": card_uid}))
        return Response(CardSerializer(
            _card_queryset(Card.objects.filter(pk=card.pk)).get(),
            # Use the board already fetched by _board_and_role() — avoids a
            # deferred card.board FK hit since board is not in select_related here.
            context={"request": request, "board": board},
        ).data)

    @action(detail=True, methods=["post"])
    def unarchive(self, request, board_pk=None, pk=None):
        """Restore a card by clearing archived_at.

        The card re-enters its original column/swimlane position. Because
        get_queryset() filters out archived cards, we bypass it here and
        query the raw manager directly.
        """
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.MEMBER, BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        # select_related avoids extra queries when accessing card.column.name
        # and card.swimlane.name in the CardMovement creation below.
        card = get_object_or_404(
            Card.objects.select_related("column", "swimlane"),
            pk=pk, board=board,
        )
        # Ownership gate: members may only unarchive cards they created (#362).
        if card.created_by_id != request.user.id:
            if not _can_modify_others_content(board, role, request.user):
                raise PermissionDenied("You can only restore cards you created.")
        if card.archived_at is not None:
            board_id = card.board_id
            # Capture the board object now (not via card.board inside the lambda)
            # so the closure holds a plain reference rather than a deferred FK
            # accessor that may re-query or reference a stale object at call time.
            _board = board

            # Capture board_id (an integer) rather than closing over card.board
            # (an ORM instance) — consistent with every other broadcast site and
            # avoids a stale-instance dependency after the atomic block exits.
            card_pk = card.pk

            def card_data_fn():
                return CardSerializer(
                    _card_queryset(Card.objects.filter(pk=card_pk)).get(),
                    context={"request": request, "board": _board},
                ).data

            with transaction.atomic():
                card.archived_at = None
                card.save(update_fields=["archived_at"])
                # Record a restore event so the audit trail captures when a card
                # re-entered the active board. This is a companion to the ARCHIVED
                # movement and uses the same from/to pattern (card stays in its
                # column; only archived_at changes).
                CardMovement.objects.create(
                    card=card,
                    from_column=card.column,
                    from_column_name=card.column.name if card.column else "",
                    from_column_uid=card.column.uid if card.column else "",
                    to_column=card.column,
                    to_column_name=card.column.name if card.column else "",
                    to_column_uid=card.column.uid if card.column else "",
                    from_swimlane=card.swimlane,
                    from_swimlane_name=card.swimlane.name if card.swimlane else "",
                    from_swimlane_uid=card.swimlane.uid if card.swimlane else "",
                    to_swimlane=card.swimlane,
                    to_swimlane_name=card.swimlane.name if card.swimlane else "",
                    to_swimlane_uid=card.swimlane.uid if card.swimlane else "",
                    moved_by=request.user,
                    movement_type=CardMovement.MovementType.UNARCHIVED,
                )
                transaction.on_commit(lambda: _broadcast.broadcast_board_event(board_id, "card.unarchived", card_data_fn()))
        return Response(CardSerializer(
            _card_queryset(Card.objects.filter(pk=card.pk)).get(),
            # Use the board already fetched by _board_and_role() — avoids a
            # deferred card.board FK hit since board is not in select_related here.
            context={"request": request, "board": board},
        ).data)

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
        total = qs.count()
        page_qs = qs[offset: offset + self._ARCHIVED_PAGE_SIZE]
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
        """Update card fields and record a CardActivity entry for each changed field.

        A snapshot of mutable fields is taken before the save, then compared
        afterwards to determine which fields actually changed. Only fields present
        in the request body are considered for title/description (to avoid spurious
        activity entries when a partial PATCH omits them). Label changes are
        expressed as a single activity entry listing added (+) and removed (-)
        names. A Notification is created for the new assignee when the assignee
        changes to someone other than the current user.

        The entire sequence (card save -> activity creation -> notification creation
        -> on_commit broadcast registration) runs inside a single atomic block so
        that a failure at any step rolls back all side-effects rather than leaving
        the card saved but with a missing activity trail or notification.
        """
        board, role = self._board_and_role()
        # Allow-list: same pattern as perform_create — safer than block-list.
        if role not in (BoardMembership.Role.MEMBER, BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        partial = kwargs.pop("partial", False)
        card = self.get_object()
        # Ownership gate: members may only edit cards they created, unless
        # they have the moderator entitlement (#362). Mirrors the check in
        # perform_destroy, archive, and unarchive.
        if card.created_by_id != request.user.id:
            if not _can_modify_others_content(board, role, request.user):
                if "assignee_id" in request.data:
                    raise PermissionDenied(
                        "Assigning cards requires Moderator or Admin access — ask a board admin."
                    )
                raise PermissionDenied("You can only edit cards you created.")
        with transaction.atomic():
            # Snapshot before update
            old_title = card.title
            old_priority = card.priority
            old_weight = card.weight
            old_assignee_id = card.assignee_id
            old_assignee_name = card.assignee.username if card.assignee else "Unassigned"
            old_description = card.description
            old_label_ids = {label.id for label in card.labels.all()}
            old_due_date = card.due_date.isoformat() if card.due_date else ""

            serializer = self.get_serializer(card, data=request.data, partial=partial)
            serializer.is_valid(raise_exception=True)
            self.perform_update(serializer)
            # OCC: bump version on every mutation so stale clients detect conflicts.
            Card.objects.filter(pk=card.pk).update(version=F("version") + 1)
            # Only reload version — scoping fields= prevents clearing the labels
            # prefetch cache, which would cause card.labels.all() below to re-query.
            card.refresh_from_db(fields=["version"])
            # Re-prefetch labels since perform_update may have changed the M2M.
            prefetch_related_objects([card], "labels")

            activities = []
            ET = CardActivity.EventType

            if old_title != card.title and "title" in request.data:
                activities.append(CardActivity(
                    card=card, event_type=ET.TITLE_CHANGE,
                    from_value=old_title, to_value=card.title, actor=request.user,
                ))
            if old_priority != card.priority:
                activities.append(CardActivity(
                    card=card, event_type=ET.PRIORITY_CHANGE,
                    from_value=old_priority, to_value=card.priority, actor=request.user,
                ))
            if old_weight != card.weight:
                activities.append(CardActivity(
                    card=card, event_type=ET.WEIGHT_CHANGE,
                    from_value=str(old_weight), to_value=str(card.weight), actor=request.user,
                ))
            if old_assignee_id != card.assignee_id:
                new_name = card.assignee.username if card.assignee else "Unassigned"
                activities.append(CardActivity(
                    card=card, event_type=ET.ASSIGNEE_CHANGE,
                    from_value=old_assignee_name, to_value=new_name, actor=request.user,
                ))
                # Notify new assignee if they have not opted out of assignment notifications.
                if card.assignee and card.assignee != request.user and card.assignee.notif_card_assigned:
                    Notification.objects.create(
                        recipient=card.assignee,
                        actor=request.user,
                        action_type=Notification.ActionType.ASSIGNED,
                        verb=f"You were assigned to \"{card.title}\"",
                        card=card,
                        board=card.board,
                    )
            if old_description != card.description and "description" in request.data:
                activities.append(CardActivity(
                    card=card, event_type=ET.DESCRIPTION_CHANGE,
                    from_value="", to_value="", actor=request.user,
                ))
                # Notify newly @mentioned board members; deferred so the updated
                # description is already committed when notifications are created.
                _card, _actor, _old, _new = card, request.user, old_description, card.description
                transaction.on_commit(lambda: notify_new_mentions(_card, _actor, _old, _new))
            new_label_ids = {label.id for label in card.labels.all()}
            if old_label_ids != new_label_ids:
                added = new_label_ids - old_label_ids
                removed = old_label_ids - new_label_ids
                parts = []
                # Build a name map from the in-memory labels already loaded by
                # prefetch_related_objects() above — avoids two live DB queries.
                label_name_by_id = {lbl.id: lbl.name for lbl in card.labels.all()}
                if added:
                    names = [label_name_by_id[lid] for lid in added if lid in label_name_by_id]
                    parts.append(f"+{', '.join(names)}")
                if removed:
                    names = [label_name_by_id[lid] for lid in removed if lid in label_name_by_id]
                    parts.append(f"-{', '.join(names)}")
                activities.append(CardActivity(
                    card=card, event_type=ET.LABEL_CHANGE,
                    from_value="", to_value=", ".join(parts), actor=request.user,
                ))
            new_due_date = card.due_date.isoformat() if card.due_date else ""
            if old_due_date != new_due_date:
                activities.append(CardActivity(
                    card=card, event_type=ET.DUE_DATE_CHANGE,
                    from_value=old_due_date, to_value=new_due_date, actor=request.user,
                ))

            if activities:
                CardActivity.objects.bulk_create(activities)

            board_id = card.board_id
            card_data = serializer.data
            transaction.on_commit(lambda: _broadcast.broadcast_board_event(board_id, _EVT_CARD_UPDATED, card_data))
        return Response(serializer.data)

    @action(detail=True, methods=["post"])
    @transaction.atomic
    def move(self, request, board_pk=None, pk=None):
        """Move a card to a new column/swimlane/position, creating a CardMovement record."""
        board, role = self._board_and_role()
        # Allow-list: same pattern as perform_create — safer than block-list.
        if role not in (BoardMembership.Role.MEMBER, BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        card = get_object_or_404(
            Card.objects.select_for_update().select_related("column", "swimlane"),
            pk=pk, board=board,
        )

        # Ownership/assignment gate: any member may move unassigned cards or
        # cards they created. The assignee of a card may also move it (they own
        # the work). Moving a card assigned to a different user and not created
        # by the requestor requires Moderator or Admin access.
        if (
            card.assignee_id is not None
            and card.created_by_id != request.user.id
            and card.assignee_id != request.user.id
            and not _can_modify_others_content(board, role, request.user)
        ):
            return Response(
                {
                    "code": "permission_denied",
                    "detail": (
                        "Moving a card assigned to another member requires "
                        "Moderator or Admin access — ask a board admin."
                    ),
                },
                status=status.HTTP_403_FORBIDDEN,
            )

        # Optimistic concurrency control — reject stale writes.  Clients send
        # the version they have; if it doesn't match the DB, another user has
        # modified the card since the client last fetched it.  The check is
        # optional for backward compatibility: omitting version skips OCC.
        client_version = request.data.get("version")
        if client_version is not None:
            try:
                client_version = int(client_version)
            except (TypeError, ValueError):
                return Response(
                    {"detail": "version must be an integer."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if card.version != client_version:
                return Response(
                    {
                        "code": "version_conflict",
                        "detail": "This card was modified by another user. Please refresh and try again.",
                        "current_version": card.version,
                    },
                    status=status.HTTP_409_CONFLICT,
                )

        target_column_id = request.data.get("column_id")
        target_swimlane_id = request.data.get("swimlane_id")
        new_position = request.data.get("position", 0)

        target_column = get_object_or_404(Column, pk=target_column_id, board=board)
        target_swimlane = get_object_or_404(Swimlane, pk=target_swimlane_id, board=board)

        column_changed = card.column_id != target_column.pk
        swimlane_changed = card.swimlane_id != target_swimlane.pk

        # Lock the target column row once before both limit checks to prevent
        # concurrent moves from racing past either check. A single lock covers
        # both WIP and weight enforcement; acquiring it twice on the same row
        # would be a redundant round-trip.
        wip_enforced = board.enforce_wip_limits or board.enforce_wip_hard
        if column_changed and (
            (wip_enforced and target_column.wip_limit is not None)
            or (board.enforce_weight_limits and target_column.weight_limit is not None)
        ):
            Column.objects.select_for_update().get(pk=target_column.pk)

        # WIP limit enforcement — only checked when the card is entering a different
        # column (pure swimlane moves within the same column also count). Pure
        # position reorders within the same column+swimlane are exempt.
        #
        # Hard mode (enforce_wip_hard) is independent of soft enforcement
        # (enforce_wip_limits): it activates even when soft mode is off, and no
        # force-override is accepted — not even from board admins. Hard mode
        # must be checked BEFORE the ?force param is evaluated so the admin
        # override path cannot be entered when hard mode is active.
        if wip_enforced and column_changed and target_column.wip_limit is not None:
            wip_count = (
                Card.objects.filter(board=board, column=target_column, archived_at__isnull=True)
                .exclude(pk=card.pk)
                .count()
            )
            if wip_count >= target_column.wip_limit:
                if board.enforce_wip_hard:
                    # Hard block: no bypass for any role. Return before reading
                    # the ?force param so the force path is never reachable.
                    return Response(
                        {
                            "code": "wip_hard_blocked",
                            "column_name": target_column.name,
                            "current_count": wip_count,
                            "wip_limit": target_column.wip_limit,
                        },
                        status=status.HTTP_409_CONFLICT,
                    )
                force = request.query_params.get("force", "").lower() == "true"
                if force:
                    # Only board admins and site admins may force past the limit.
                    if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
                        return Response(
                            {"detail": "Only board admins can override a WIP limit."},
                            status=status.HTTP_403_FORBIDDEN,
                        )
                    # Admin with force=true — fall through and allow the move.
                else:
                    return Response(
                        {
                            "code": "wip_limit_exceeded",
                            "column_name": target_column.name,
                            "current_count": wip_count,
                            "wip_limit": target_column.wip_limit,
                        },
                        status=status.HTTP_409_CONFLICT,
                    )

        # Weight limit enforcement — same pattern as WIP: checked only on column
        # change, skipped for pure reorders. Column row already locked above.
        if board.enforce_weight_limits and column_changed and target_column.weight_limit is not None:
            current_weight = (
                Card.objects.filter(board=board, column=target_column, archived_at__isnull=True)
                .exclude(pk=card.pk)
                .aggregate(total=Sum("weight"))["total"]
            ) or 0
            if current_weight + card.weight > target_column.weight_limit:
                force = request.query_params.get("force", "").lower() == "true"
                if force:
                    if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
                        return Response(
                            {"detail": "Only board admins can override a weight limit."},
                            status=status.HTTP_403_FORBIDDEN,
                        )
                    # Admin with force=true — fall through and allow the move.
                else:
                    return Response(
                        {
                            "code": "weight_limit_exceeded",
                            "column_name": target_column.name,
                            "current_weight": current_weight,
                            "weight_limit": target_column.weight_limit,
                            "card_weight": card.weight,
                        },
                        status=status.HTTP_409_CONFLICT,
                    )

        movement = None
        if column_changed or swimlane_changed:
            movement = CardMovement.objects.create(
                card=card,
                from_column=card.column,
                from_column_name=card.column.name,
                from_column_uid=card.column.uid,
                to_column=target_column,
                to_column_name=target_column.name,
                to_column_uid=target_column.uid,
                from_swimlane=card.swimlane,
                from_swimlane_name=card.swimlane.name,
                from_swimlane_uid=card.swimlane.uid,
                to_swimlane=target_swimlane,
                to_swimlane_name=target_swimlane.name,
                to_swimlane_uid=target_swimlane.uid,
                moved_by=request.user,
            )

        # Lock cards in affected cells to prevent deadlocks from concurrent moves.
        # select_for_update with consistent ordering ensures transactions wait
        # rather than deadlock when bulk operations fire parallel requests.
        if column_changed or swimlane_changed:
            # Lock source cell cards, then compact the gap left by the moved card.
            # Using a single bulk UPDATE (decrement positions after the moved card)
            # instead of a per-row save() loop avoids O(N) queries when the source
            # cell is large.  Positions are always kept compact by this endpoint so
            # a simple -1 decrement is equivalent to a full renumber.
            list(Card.objects.filter(
                board=board, column=card.column, swimlane=card.swimlane
            ).exclude(pk=card.pk).order_by("pk").select_for_update())
            Card.objects.filter(
                board=board, column=card.column, swimlane=card.swimlane,
                archived_at__isnull=True,
            ).exclude(pk=card.pk).filter(position__gt=card.position).update(
                position=F("position") - 1
            )

        # Lock target cell cards, then shift to make room
        list(Card.objects.filter(
            board=board, column=target_column, swimlane=target_swimlane
        ).exclude(pk=card.pk).order_by("pk").select_for_update())
        Card.objects.filter(
            board=board, column=target_column, swimlane=target_swimlane
        ).exclude(pk=card.pk).filter(position__gte=new_position).update(
            position=F("position") + 1
        )

        card.column = target_column
        card.swimlane = target_swimlane
        card.position = new_position
        card.version = F("version") + 1
        card.save(update_fields=["column", "swimlane", "position", "version"])
        card.refresh_from_db(fields=["version"])

        # Re-fetch the card through _card_queryset so CardSerializer has all
        # prefetches populated — the card instance at this point is bare (loaded
        # by get_object_or_404 earlier) and would trigger ~7 extra queries.
        card_data = CardSerializer(
            _card_queryset(Card.objects.filter(pk=card.pk)).get(),
            context={"request": request, "board": board},
        ).data
        response_data = {"card": card_data}
        if movement:
            # Re-fetch movement with its FK relations loaded so CardMovementSerializer
            # does not issue a separate query for moved_by, card.uid, and card.title.
            movement = CardMovement.objects.select_related(
                "moved_by", "card", "from_column", "to_column", "from_swimlane", "to_swimlane"
            ).get(pk=movement.pk)
            response_data["movement"] = CardMovementSerializer(movement).data

        # Broadcast the same shape as the REST response so WS clients can update
        # movement history without re-polling /movements/.
        broadcast_data = dict(response_data)
        transaction.on_commit(lambda: _broadcast.broadcast_board_event(board.id, "card.moved", broadcast_data))
        return Response(response_data)

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

        if include_moves:
            movements_qs = (
                CardMovement.objects.filter(card=card)
                .select_related("moved_by")
                .order_by("-moved_at")
            )
            move_count = movements_qs.count()
            capped_movements = movements_qs[:fetch_cap]
        else:
            move_count = 0
            capped_movements = []

        if activity_event_types:
            activities_qs = (
                CardActivity.objects.filter(card=card, event_type__in=activity_event_types)
                .select_related("actor")
                .order_by("-created_at")
            )
            activity_count = activities_qs.count()
            capped_activities = activities_qs[:fetch_cap]
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
            transaction.on_commit(lambda: _broadcast.broadcast_board_event(board_id, _EVT_CARD_UPDATED, card_data))
            # Parse @username mentions and notify each mentioned board member.
            # Comments don't need a re-notification guard — each comment is a new event.
            mentioned_usernames = extract_mentions(comment.body)
            if mentioned_usernames:
                eff_ids = _get_effective_member_ids(board)
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

    @action(detail=True, methods=["delete"], url_path="comments/(?P<comment_pk>[^/.]+)")
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
            transaction.on_commit(lambda: _broadcast.broadcast_board_event(board_id, _EVT_CARD_UPDATED, card_data))
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
            transaction.on_commit(lambda: _broadcast.broadcast_board_event(board_id, _EVT_CARD_UPDATED, card_data))
        serializer = CardAttachmentSerializer(attachment, context={"request": request})
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["delete"], url_path="attachments/(?P<attachment_pk>[^/.]+)")
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
            transaction.on_commit(lambda: _broadcast.broadcast_board_event(board_id, _EVT_CARD_UPDATED, card_data))
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["get", "post"], url_path="checklist")
    def checklist(self, request, board_pk=None, pk=None):
        """List checklist items on a card or add a new one."""
        board, role = self._board_and_role()
        card = get_object_or_404(
            Card.objects.prefetch_related("checklist_items"), pk=pk, board=board
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
        position = card.checklist_items.count()
        with transaction.atomic():
            item = serializer.save(card=card, position=position, created_by=request.user)
            CardActivity.objects.create(
                card=card, event_type=CardActivity.EventType.CHECKLIST_ITEM_ADDED,
                from_value="", to_value=item.text, actor=request.user,
            )
            card_data = self._refetch_card_data(card)
            board_id = board.id
            transaction.on_commit(lambda: _broadcast.broadcast_board_event(board_id, _EVT_CARD_UPDATED, card_data))
        return Response(CardChecklistSerializer(item).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["patch", "delete"], url_path="checklist/(?P<item_pk>[^/.]+)")
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
                transaction.on_commit(lambda: _broadcast.broadcast_board_event(board_id, _EVT_CARD_UPDATED, card_data))
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
            transaction.on_commit(lambda: _broadcast.broadcast_board_event(board_id, _EVT_CARD_UPDATED, card_data))
        return Response(serializer.data)
