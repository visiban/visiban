import csv
import datetime
import io
import json
import statistics

import django_filters
from django.conf import settings as django_settings
from django.db import transaction
from django.db.models import Count, Exists, F, Max, OuterRef, Prefetch, Q, Sum
from django.http import HttpResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.text import slugify
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.parsers import MultiPartParser
from rest_framework.response import Response
from rest_framework.throttling import SimpleRateThrottle
from rest_framework.views import APIView
from drf_spectacular.utils import extend_schema, OpenApiTypes

from accounts.models import User, get_uploads_enabled
from groups.models import Group, GroupMembership, get_accessible_group_ids

from .broadcast import broadcast_board_event
from .utils import extract_mentions, _get_effective_member_ids, notify_new_mentions
from .models import (
    Board, BoardFavorite, BoardMembership, BoardTemplate, Column, Swimlane, Label,
    Card, CardMovement, CardActivity, CardAttachment, CardChecklist, CardComment,
    Notification, SavedFilter,
)
from .permissions import get_board_role, SITE_ADMIN
from .serializers import (
    BoardSerializer, BoardFullSerializer, BoardMembershipSerializer,
    BoardTemplateSerializer,
    ColumnSerializer, SwimlaneSerializer, SwimlaneAdminSerializer, LabelSerializer,
    CardSerializer, CardMovementSerializer, CardCommentSerializer,
    CardActivitySerializer, CardAttachmentSerializer, CardChecklistSerializer,
    SavedFilterSerializer, PublicBoardSerializer,
    _card_queryset,
)
from .templates import BOARD_TEMPLATES


# ---------------------------------------------------------------------------
# Throttle classes
# ---------------------------------------------------------------------------

class ShareLinkThrottle(SimpleRateThrottle):
    """Rate-limit unauthenticated reads of public share-link boards.

    Scope 'share_link' maps to DEFAULT_THROTTLE_RATES['share_link'] in settings
    (120/hour in production).  Keyed on client IP so the limit applies per
    visitor, not per token.
    """

    scope = "share_link"

    def get_cache_key(self, request, view):
        return self.cache_format % {
            "scope": self.scope,
            "ident": self.get_ident(request),
        }


# ---------------------------------------------------------------------------
# Attachment upload helpers
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


def _sanitize_csv_field(value: str) -> str:
    """Strip leading characters that spreadsheet applications interpret as formula prefixes.

    Spreadsheet programs (Excel, Google Sheets, LibreOffice Calc) execute any
    cell value that starts with =, +, -, @, tab, or carriage-return as a
    formula.  User-controlled strings in a CSV export (card titles, descriptions,
    usernames, etc.) could exploit this to run arbitrary macros when the CSV is
    opened.  Stripping those prefix characters neutralizes the injection vector
    without distorting the actual content in any meaningful way.
    """
    if not isinstance(value, str):
        return value
    return value.lstrip("=+-@\t\r")


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


# ---------------------------------------------------------------------------
# Boards
# ---------------------------------------------------------------------------

class BoardViewSet(viewsets.ModelViewSet):
    """CRUD endpoints for boards, scoped to boards the requesting user has access to."""

    serializer_class = BoardSerializer

    def get_queryset(self):
        user = self.request.user
        if user.can_access_all_content:
            qs = Board.objects.all()
        else:
            qs = Board.objects.filter(
                Q(owner=user) |
                Q(memberships__user=user) |
                Q(group__in=get_accessible_group_ids(user))
            ).distinct()
        if self.request.query_params.get("starred") == "true":
            qs = qs.filter(favorites__user=user)
        # select_related("owner", "group") prevents one JOIN-per-board for the
        # owner and group_name serializer fields. Annotate to avoid 3 further
        # subqueries per board (member_count, card_count, is_starred).
        return qs.select_related("owner", "group").annotate(
            _member_count=Count("memberships", distinct=True),
            _card_count=Count("cards", distinct=True),
            _is_starred=Exists(
                BoardFavorite.objects.filter(board=OuterRef("pk"), user=user)
            ),
        )

    def perform_create(self, serializer):
        board = serializer.save(owner=self.request.user)
        BoardMembership.objects.create(board=board, user=self.request.user, role=BoardMembership.Role.ADMIN)

        template_key = self.request.data.get("template", "simple_kanban")
        template = BOARD_TEMPLATES.get(template_key, BOARD_TEMPLATES["simple_kanban"])

        if template["columns"]:
            Column.objects.bulk_create([
                Column(
                    board=board,
                    name=col["name"],
                    position=i,
                    color=col["color"],
                    allow_card_creation=(i == 0),
                    is_done=col.get("is_done", False),
                )
                for i, col in enumerate(template["columns"])
            ])

        # Prefer the user-supplied swimlane name from the modal prompt;
        # fall back to the legacy static default for backwards compatibility.
        swimlane_name = (self.request.data.get("swimlane_name") or "").strip()
        if not swimlane_name:
            swimlane_name = template.get("default_swimlane") or ""
        if swimlane_name:
            Swimlane.objects.create(board=board, name=swimlane_name, position=0, color="#6B7280")

    def perform_update(self, serializer):
        """Guard board-level updates: only admins can edit any board field.

        Viewers and collaborators have read-only access. Members and above can
        read but only admins can change the board name, description, settings, or
        enforcement flags. Previously only enforcement flags were guarded, which
        allowed viewers and members to rename boards via PATCH.
        """
        board = serializer.instance
        role = get_board_role(self.request.user, board)
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied("Only board admins can edit board settings.")
        serializer.save()
        board = serializer.instance
        board_id = board.id
        board_data = BoardSerializer(board, context={"request": self.request}).data
        transaction.on_commit(
            lambda: broadcast_board_event(board_id, "board.updated", board_data)
        )

    def destroy(self, request, *args, **kwargs):
        board = self.get_object()
        role = get_board_role(request.user, board)
        if board.owner != request.user and role != SITE_ADMIN:
            raise PermissionDenied
        board_id = board.id
        board.delete()
        transaction.on_commit(
            lambda: broadcast_board_event(board_id, "board.deleted", {"board_id": board_id})
        )
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["post", "delete"], url_path="star")
    def star(self, request, pk=None):
        """Star or unstar a board for the requesting user."""
        board = self.get_object()
        if request.method == "POST":
            BoardFavorite.objects.get_or_create(user=request.user, board=board)
        else:
            BoardFavorite.objects.filter(user=request.user, board=board).delete()
        # Re-fetch via get_queryset() so the _is_starred annotation reflects the
        # change just made — the object fetched by get_object() above is stale.
        board = self.get_queryset().get(pk=board.pk)
        return Response(self.get_serializer(board).data)

    @action(detail=True, methods=["post", "delete"], url_path="share")
    def share(self, request, pk=None):
        """Enable or revoke the public share link for a board.

        POST  — generates a fresh UUID token (replaces any existing token).
        DELETE — clears the token, immediately invalidating any live share link.
        Both operations are admin-only; the token is a public credential.
        """
        import uuid as _uuid
        board, role = get_board_for_user(pk, request.user)
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        if request.method == "POST":
            board.share_token = _uuid.uuid4()
            board.save(update_fields=["share_token"])
            share_url = request.build_absolute_uri(f"/share/{board.share_token}")
            response_data = {"share_token": str(board.share_token), "share_url": share_url}
        else:
            # DELETE
            board.share_token = None
            board.save(update_fields=["share_token"])
            response_data = {"share_token": None}

        # Notify connected clients so the Sharing tab updates without a reload.
        board_id = board.pk
        board_summary = BoardSerializer(board, context={"request": request}).data
        transaction.on_commit(
            lambda: broadcast_board_event(board_id, "board.updated", board_summary)
        )
        return Response(response_data)

    @action(detail=True, methods=["post"], url_path="move-group")
    def move_group(self, request, pk=None):
        """Move a board into a group (or back to personal) that the requesting user belongs to."""
        board, role = get_board_for_user(pk, request.user)
        if board.owner != request.user and role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied

        group_id = request.data.get("group_id")  # None = move to personal
        if group_id is not None:
            group = get_object_or_404(Group, pk=group_id)
            is_member = (
                group.owner_id == request.user.id or
                GroupMembership.objects.filter(group=group, user=request.user).exists()
            )
            if not is_member:
                raise PermissionDenied("You are not a member of the target group.")
            board.group = group
        else:
            board.group = None

        board.save()
        board_id = board.id
        board_data = BoardSerializer(board, context={"request": request}).data
        transaction.on_commit(
            lambda: broadcast_board_event(board_id, "board.updated", board_data)
        )
        return Response(board_data)

    @extend_schema(
        request={"multipart/form-data": {"type": "object", "properties": {"file": {"type": "string", "format": "binary"}}}},
        responses={200: OpenApiTypes.OBJECT},
    )
    @action(detail=False, methods=["post"], url_path="import", parser_classes=[MultiPartParser])
    def import_board(self, request):
        """Import a board from a Visiban JSON or CSV export file."""
        file = request.FILES.get("file")
        if not file:
            return Response({"detail": "No file provided."}, status=status.HTTP_400_BAD_REQUEST)

        max_size = getattr(django_settings, "MAX_UPLOAD_SIZE", 10 * 1024 * 1024)
        if file.size > max_size:
            return Response(
                {"detail": f"File too large. Maximum size is {max_size // (1024 * 1024)} MB."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        filename = file.name.lower() if file.name else ""
        content_type = file.content_type or ""

        if filename.endswith(".json") or "json" in content_type:
            return self._import_json(request, file)
        elif filename.endswith(".csv") or "csv" in content_type:
            return self._import_csv(request, file)
        else:
            return Response(
                {"detail": "Unsupported file format. Upload a .json or .csv file."},
                status=status.HTTP_400_BAD_REQUEST,
            )

    def _resolve_import_group(self, request):
        """Return the Group instance if group_id is provided, else None."""
        group_id = request.data.get("group_id")
        if not group_id:
            return None
        group = get_object_or_404(Group, pk=group_id)
        is_member = (
            group.owner_id == request.user.id
            or request.user.can_access_all_content
            or GroupMembership.objects.filter(group=group, user=request.user).exists()
        )
        if not is_member:
            raise PermissionDenied("You are not a member of the target group.")
        return group

    def _import_json(self, request, file):
        """Create a new board from a Visiban JSON export file.

        Expected top-level shape::

            {
              "name": str,
              "description": str (optional),
              "columns": [{"name": str, "position": int, "color": str, ...}],
              "swimlanes": [{"name": str, ...}],
              "labels": [{"name": str, "color": str}],
              "cards": [{"title": str, "column": str, "swimlane": str, ...}]
            }

        Columns and swimlanes are referenced by name from cards. The entire
        board is created inside a single atomic transaction so a validation
        failure mid-way leaves no partial state.
        """
        try:
            raw = file.read().decode("utf-8")
            data = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            return Response({"detail": f"Invalid JSON: {exc}"}, status=status.HTTP_400_BAD_REQUEST)

        if not isinstance(data, dict):
            return Response({"detail": "Invalid JSON: expected an object at the top level."}, status=status.HTTP_400_BAD_REQUEST)

        # Schema version guard — warn on missing (pre-versioning files) or future versions.
        # The current importer understands schema_version 1.  Files without the field are
        # treated as version 0 (pre-1.0 exports) and imported on a best-effort basis.
        _SUPPORTED_SCHEMA_VERSION = 1
        schema_version = data.get("schema_version", 0)
        if schema_version > _SUPPORTED_SCHEMA_VERSION:
            import logging as _logging
            _logging.getLogger(__name__).warning(
                "Importing board JSON with schema_version=%s (importer supports up to %s). "
                "Some fields may be ignored.",
                schema_version,
                _SUPPORTED_SCHEMA_VERSION,
            )

        # Enforce per-import item ceilings before touching the database.  These
        # limits prevent a single large import from exhausting server resources
        # or producing a board that is impractical to use.
        _IMPORT_MAX_CARDS = 500
        _IMPORT_MAX_COLUMNS = 50
        _IMPORT_MAX_SWIMLANES = 100

        card_count = len(data.get("cards", []))
        column_count = len(data.get("columns", []))
        swimlane_count = len(data.get("swimlanes", []))

        if card_count > _IMPORT_MAX_CARDS:
            return Response(
                {"detail": f"Import contains {card_count} cards, which exceeds the limit of {_IMPORT_MAX_CARDS}."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if column_count > _IMPORT_MAX_COLUMNS:
            return Response(
                {"detail": f"Import contains {column_count} columns, which exceeds the limit of {_IMPORT_MAX_COLUMNS}."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if swimlane_count > _IMPORT_MAX_SWIMLANES:
            return Response(
                {"detail": f"Import contains {swimlane_count} swimlanes, which exceeds the limit of {_IMPORT_MAX_SWIMLANES}."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Validate required fields
        if "name" not in data:
            return Response({"detail": "Missing required field: name"}, status=status.HTTP_400_BAD_REQUEST)
        if not data.get("columns"):
            return Response({"detail": "Missing required field: columns"}, status=status.HTTP_400_BAD_REQUEST)
        if not data.get("swimlanes"):
            return Response({"detail": "Missing required field: swimlanes"}, status=status.HTTP_400_BAD_REQUEST)

        # Validate cards have required fields
        for i, card_data in enumerate(data.get("cards", [])):
            for field in ("title", "column", "swimlane"):
                if not card_data.get(field):
                    return Response(
                        {"detail": f"Card at index {i} is missing required field: {field}"},
                        status=status.HTTP_400_BAD_REQUEST,
                    )

        board_name = request.data.get("name") or data["name"]
        group = self._resolve_import_group(request)

        with transaction.atomic():
            board = Board.objects.create(
                name=board_name,
                description=data.get("description", ""),
                owner=request.user,
                group=group,
            )
            BoardMembership.objects.create(
                board=board, user=request.user, role=BoardMembership.Role.ADMIN
            )

            # Create columns
            column_map = {}
            for i, col in enumerate(data["columns"]):
                column = Column.objects.create(
                    board=board,
                    name=col["name"],
                    position=col.get("position", i),
                    color=col.get("color", "#6B7280"),
                    wip_limit=col.get("wip_limit"),
                    weight_limit=col.get("weight_limit"),
                    allow_card_creation=col.get("allow_card_creation", i == 0),
                    is_done=col.get("is_done", False),
                )
                column_map[col["name"]] = column

            # Create swimlanes
            swimlane_map = {}
            for i, sw in enumerate(data["swimlanes"]):
                swimlane = Swimlane.objects.create(
                    board=board,
                    name=sw["name"],
                    position=sw.get("position", i),
                    color=sw.get("color", "#3B82F6"),
                    contact_email=sw.get("contact_email", ""),
                    notes=sw.get("notes", ""),
                )
                swimlane_map[sw["name"]] = swimlane

            # Create labels
            label_map = {}
            for lbl in data.get("labels", []):
                label = Label.objects.create(
                    board=board,
                    name=lbl["name"],
                    color=lbl.get("color", "#EAB308"),
                )
                label_map[lbl["name"]] = label

            # Bulk-load all referenced usernames so the card loop does not
            # issue a per-card query for assignee, moved_by, or actor (#420).
            all_usernames = set()
            for card_data in data.get("cards", []):
                if card_data.get("assignee"):
                    all_usernames.add(card_data["assignee"])
                for mv in card_data.get("movements", []):
                    if mv.get("moved_by"):
                        all_usernames.add(mv["moved_by"])
                for act in card_data.get("activities", []):
                    if act.get("actor"):
                        all_usernames.add(act["actor"])
            user_map = {u.username: u for u in User.objects.filter(username__in=all_usernames)}

            # Create cards
            for card_data in data.get("cards", []):
                column = column_map.get(card_data["column"])
                swimlane = swimlane_map.get(card_data["swimlane"])
                if not column or not swimlane:
                    continue

                priority = card_data.get("priority", "medium")
                if priority not in [c[0] for c in Card.Priority.choices]:
                    priority = "medium"

                # Resolve assignee by username if present; silently skip unknown users.
                assignee_username = card_data.get("assignee")
                assignee = user_map.get(assignee_username) if assignee_username else None

                card = Card.objects.create(
                    board=board,
                    column=column,
                    swimlane=swimlane,
                    title=card_data["title"],
                    description=card_data.get("description", ""),
                    priority=priority,
                    assignee=assignee,
                    due_date=card_data.get("due_date") or None,
                    weight=card_data.get("weight", 1),
                    position=card_data.get("position", 0),
                    created_by=request.user,
                )

                # Assign labels
                card_labels = []
                for label_name in card_data.get("labels", []):
                    label = label_map.get(label_name)
                    if label:
                        card_labels.append(label)
                if card_labels:
                    card.labels.set(card_labels)

                # Create comments
                for comment_data in card_data.get("comments", []):
                    CardComment.objects.create(
                        card=card,
                        author=request.user,
                        body=comment_data.get("body", ""),
                    )

                # Create checklist items
                for ci_idx, checklist_data in enumerate(card_data.get("checklist", [])):
                    CardChecklist.objects.create(
                        card=card,
                        text=checklist_data.get("text", ""),
                        is_checked=checklist_data.get("is_checked", False),
                        position=ci_idx,
                    )

                # Create movement history. Unknown usernames fall back to the
                # importing user so history is never orphaned.
                for mv_data in card_data.get("movements", []):
                    from_col_name = mv_data.get("from_column") or ""
                    to_col_name = mv_data.get("to_column") or ""
                    from_sw_name = mv_data.get("from_swimlane") or ""
                    to_sw_name = mv_data.get("to_swimlane") or ""
                    from_col = column_map.get(from_col_name)
                    to_col = column_map.get(to_col_name)
                    from_sw = swimlane_map.get(from_sw_name)
                    to_sw = swimlane_map.get(to_sw_name)
                    moved_by_username = mv_data.get("moved_by")
                    moved_by = (
                        user_map.get(moved_by_username) if moved_by_username else None
                    ) or request.user
                    mv = CardMovement.objects.create(
                        card=card,
                        from_column=from_col,
                        to_column=to_col,
                        from_swimlane=from_sw,
                        to_swimlane=to_sw,
                        from_column_name=from_col.name if from_col else from_col_name,
                        to_column_name=to_col.name if to_col else to_col_name,
                        from_swimlane_name=from_sw.name if from_sw else from_sw_name,
                        to_swimlane_name=to_sw.name if to_sw else to_sw_name,
                        from_column_uid=from_col.uid if from_col else "",
                        to_column_uid=to_col.uid if to_col else "",
                        from_swimlane_uid=from_sw.uid if from_sw else "",
                        to_swimlane_uid=to_sw.uid if to_sw else "",
                        moved_by=moved_by,
                    )
                    if mv_data.get("moved_at"):
                        CardMovement.objects.filter(pk=mv.pk).update(
                            moved_at=mv_data["moved_at"]
                        )

                # Create activity log entries (field-change history).
                for act_data in card_data.get("activities", []):
                    event_type = act_data.get("event_type", "")
                    valid_types = [e[0] for e in CardActivity.EventType.choices]
                    if event_type not in valid_types:
                        continue
                    actor_username = act_data.get("actor")
                    actor = (
                        user_map.get(actor_username) if actor_username else None
                    ) or request.user
                    act = CardActivity.objects.create(
                        card=card,
                        event_type=event_type,
                        from_value=act_data.get("from_value", ""),
                        to_value=act_data.get("to_value", ""),
                        actor=actor,
                    )
                    if act_data.get("created_at"):
                        CardActivity.objects.filter(pk=act.pk).update(
                            created_at=act_data["created_at"]
                        )

        return Response(BoardSerializer(board).data, status=status.HTTP_201_CREATED)

    def _import_csv(self, request, file):
        """Create a new board from a CSV file with one card per row.

        Required headers: Title, Column, Swimlane.
        Optional headers: Description, Priority, Weight, Labels (comma-separated),
                          Assignee (username), Due Date (YYYY-MM-DD).

        Columns, swimlanes, and labels are auto-created from the values seen in
        the file. Their order matches their first appearance in the CSV so that
        column/swimlane ordering reflects the original export. All objects are
        created inside a single atomic transaction.
        """
        try:
            raw = file.read().decode("utf-8")
            reader = csv.DictReader(io.StringIO(raw))
            rows = list(reader)
        except (UnicodeDecodeError, csv.Error) as exc:
            return Response({"detail": f"Invalid CSV: {exc}"}, status=status.HTTP_400_BAD_REQUEST)

        if not rows:
            return Response({"detail": "CSV file is empty."}, status=status.HTTP_400_BAD_REQUEST)

        # Normalize headers to canonical casing so that exports from external tools
        # (which commonly use lowercase or snake_case) import cleanly.  Unknown
        # headers are preserved as-is and simply ignored during card creation.
        _HEADER_MAP = {
            "title": "Title",
            "column": "Column",
            "swimlane": "Swimlane",
            "description": "Description",
            "priority": "Priority",
            "weight": "Weight",
            "labels": "Labels",
            "assignee": "Assignee",
            "duedate": "Due Date",
            "due_date": "Due Date",
            "due date": "Due Date",  # defensive: handles pre-normalized header with space and lowercase
        }
        rows = [
            {_HEADER_MAP.get(k.strip().lower(), k.strip()): v for k, v in row.items() if k is not None}
            for row in rows
        ]
        # Rebuild fieldnames from the normalized first row so header validation works.
        # Filter None entries — DictReader produces None keys for trailing commas in headers.
        if reader.fieldnames is not None:
            reader.fieldnames = [
                _HEADER_MAP.get(f.strip().lower(), f.strip()) for f in reader.fieldnames if f is not None
            ]

        # Enforce row (card) ceiling early — before scanning for columns/swimlanes —
        # so that oversized imports are rejected without building intermediate data
        # structures.  Column and swimlane counts are validated after the first
        # pass collects unique names.
        _IMPORT_MAX_CARDS = 500
        if len(rows) > _IMPORT_MAX_CARDS:
            return Response(
                {"detail": f"Import contains {len(rows)} rows, which exceeds the card limit of {_IMPORT_MAX_CARDS}."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Validate required headers
        required_headers = {"Title", "Column", "Swimlane"}
        if reader.fieldnames is None:
            return Response({"detail": "CSV file has no headers."}, status=status.HTTP_400_BAD_REQUEST)
        headers = set(reader.fieldnames)
        missing = required_headers - headers
        if missing:
            return Response(
                {"detail": f"CSV is missing required headers: {', '.join(sorted(missing))}"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Validate each row has required fields
        for i, row in enumerate(rows):
            for field in ("Title", "Column", "Swimlane"):
                if not row.get(field, "").strip():
                    return Response(
                        {"detail": f"Row {i + 2} is missing required field: {field}"},
                        status=status.HTTP_400_BAD_REQUEST,
                    )

        # Count unique columns and swimlanes from the CSV rows so we can enforce
        # the same per-import ceilings as the JSON import path.
        _IMPORT_MAX_COLUMNS = 50
        _IMPORT_MAX_SWIMLANES = 100
        unique_columns = {row["Column"].strip() for row in rows if row.get("Column", "").strip()}
        unique_swimlanes = {row["Swimlane"].strip() for row in rows if row.get("Swimlane", "").strip()}
        if len(unique_columns) > _IMPORT_MAX_COLUMNS:
            return Response(
                {"detail": f"Import contains {len(unique_columns)} columns, which exceeds the limit of {_IMPORT_MAX_COLUMNS}."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if len(unique_swimlanes) > _IMPORT_MAX_SWIMLANES:
            return Response(
                {"detail": f"Import contains {len(unique_swimlanes)} swimlanes, which exceeds the limit of {_IMPORT_MAX_SWIMLANES}."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        board_name = request.data.get("name") or "Imported Board"
        group = self._resolve_import_group(request)

        with transaction.atomic():
            board = Board.objects.create(
                name=board_name,
                description="",
                owner=request.user,
                group=group,
            )
            BoardMembership.objects.create(
                board=board, user=request.user, role=BoardMembership.Role.ADMIN
            )

            # Extract unique columns and swimlanes in order of first appearance
            column_map = {}
            swimlane_map = {}
            label_map = {}

            for row in rows:
                col_name = row["Column"].strip()
                if col_name and col_name not in column_map:
                    column_map[col_name] = None

                sw_name = row["Swimlane"].strip()
                if sw_name and sw_name not in swimlane_map:
                    swimlane_map[sw_name] = None

                labels_str = row.get("Labels", "").strip()
                if labels_str:
                    for label_name in labels_str.split(","):
                        label_name = label_name.strip()
                        if label_name and label_name not in label_map:
                            label_map[label_name] = None

            # Create columns
            for i, col_name in enumerate(column_map):
                column_map[col_name] = Column.objects.create(
                    board=board,
                    name=col_name,
                    position=i,
                    color="#6B7280",
                    allow_card_creation=(i == 0),
                )

            # Create swimlanes
            for i, sw_name in enumerate(swimlane_map):
                swimlane_map[sw_name] = Swimlane.objects.create(
                    board=board,
                    name=sw_name,
                    position=i,
                    color="#3B82F6",
                )

            # Create labels
            for label_name in label_map:
                label_map[label_name] = Label.objects.create(
                    board=board,
                    name=label_name,
                    color="#EAB308",
                )

            # Create cards
            for row in rows:
                column = column_map.get(row["Column"].strip())
                swimlane = swimlane_map.get(row["Swimlane"].strip())
                if not column or not swimlane:
                    continue

                priority = row.get("Priority", "medium").strip().lower()
                if priority not in [c[0] for c in Card.Priority.choices]:
                    priority = "medium"

                due_date = row.get("Due Date", "").strip() or None

                weight_str = row.get("Weight", "1").strip()
                try:
                    weight = int(weight_str)
                except (ValueError, TypeError):
                    weight = 1

                card = Card.objects.create(
                    board=board,
                    column=column,
                    swimlane=swimlane,
                    title=row["Title"].strip(),
                    description=row.get("Description", "").strip(),
                    priority=priority,
                    due_date=due_date,
                    weight=weight,
                    position=0,
                    created_by=request.user,
                )

                # Assign labels
                labels_str = row.get("Labels", "").strip()
                if labels_str:
                    card_labels = []
                    for label_name in labels_str.split(","):
                        label_name = label_name.strip()
                        label = label_map.get(label_name)
                        if label:
                            card_labels.append(label)
                    if card_labels:
                        card.labels.set(card_labels)

        return Response(BoardSerializer(board).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["get"])
    def full(self, request, pk=None):
        """Return the full board state: columns, swimlanes, cards, labels, and members.

        The resolved role is threaded into serializer context so that
        get_current_user_role() and get_swimlanes() can reuse it without
        issuing a second get_board_role() query.
        """
        board, role = get_board_for_user(pk, request.user)
        return Response(BoardFullSerializer(board, context={"request": request, "role": role}).data)

    @action(detail=True, methods=["get", "post"], url_path="saved-filters")
    def saved_filters(self, request, pk=None):
        """List or create saved filter presets for the requesting user on this board.

        GET  — returns all saved filters belonging to the requesting user on this board.
        POST — creates a new saved filter; name must be unique per user per board.

        Saved filters are private to the requesting user. Any board member (including
        viewer-role) can save and restore their own filter presets; no shared presets.
        """
        board, _ = get_board_for_user(pk, request.user)

        if request.method == "GET":
            qs = SavedFilter.objects.filter(user=request.user, board=board)
            return Response(SavedFilterSerializer(qs, many=True).data)

        # POST — create a new saved filter for this user on this board.
        name = (request.data.get("name") or "").strip()
        if not name:
            return Response({"detail": "name is required."}, status=status.HTTP_400_BAD_REQUEST)
        if len(name) > 100:
            return Response(
                {"detail": "name must be 100 characters or fewer."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        state_json = request.data.get("state_json")
        if state_json is None:
            return Response({"detail": "state_json is required."}, status=status.HTTP_400_BAD_REQUEST)
        if not isinstance(state_json, dict):
            return Response(
                {"detail": "state_json must be an object."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            saved = SavedFilter.objects.create(
                user=request.user,
                board=board,
                name=name,
                state_json=state_json,
            )
        except Exception:
            # unique_together violation — a filter with this name already exists.
            return Response(
                {"detail": "A saved filter with this name already exists on this board."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        return Response(SavedFilterSerializer(saved).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["delete"], url_path=r"saved-filters/(?P<filter_pk>[0-9]+)")
    def saved_filter_delete(self, request, pk=None, filter_pk=None):
        """Delete a single saved filter preset owned by the requesting user.

        The queryset is scoped to request.user — attempting to delete another
        user's saved filter returns 404, not 403, to avoid confirming existence.
        """
        board, _ = get_board_for_user(pk, request.user)
        try:
            saved = SavedFilter.objects.get(pk=filter_pk, user=request.user, board=board)
        except SavedFilter.DoesNotExist:
            return Response(status=status.HTTP_404_NOT_FOUND)
        saved.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["get"])
    def summary(self, request, pk=None):
        """Per-swimlane card counts, stage distribution, velocity, and cycle-time metrics.

        Uses aggregate queries regardless of board size instead of the
        previous S×(C+4) loop (one filter per swimlane×column cell).

        New in #342: active_cards, done_30d, and avg_cycle_days are computed
        with SQL aggregates keyed on swimlane, using Column.is_done to identify
        completion columns. avg_cycle_days measures the time from a card's first
        movement to its first entry into a done column.
        """
        from django.db.models import Count, Min
        board, _ = get_board_for_user(pk, request.user)
        now = timezone.now()
        cutoff_7d = now - datetime.timedelta(days=7)
        cutoff_30d = now - datetime.timedelta(days=30)

        columns = list(board.columns.order_by("position"))
        swimlanes = list(board.swimlanes.order_by("position"))
        done_column_ids = {col.id for col in columns if col.is_done}

        # Query 1: card count per (swimlane, column) in one shot.
        raw_counts = (
            board.cards.filter(archived_at__isnull=True)
            .values("swimlane_id", "column_id")
            .annotate(cnt=Count("id"))
        )
        counts: dict[int, dict[int, int]] = {}
        for row in raw_counts:
            counts.setdefault(row["swimlane_id"], {})[row["column_id"]] = row["cnt"]

        # Query 2: velocity + done_30d per swimlane using is_done columns.
        vel_by_swimlane: dict[int, dict] = {}
        if done_column_ids:
            vel_qs = (
                CardMovement.objects
                .filter(card__board=board, card__archived_at__isnull=True, to_column_id__in=done_column_ids, movement_type=CardMovement.MovementType.MOVE)
                .values("card__swimlane_id")
                .annotate(
                    vel_7d=Count("id", filter=Q(moved_at__gte=cutoff_7d)),
                    vel_30d=Count("id", filter=Q(moved_at__gte=cutoff_30d)),
                )
            )
            vel_by_swimlane = {r["card__swimlane_id"]: r for r in vel_qs}

        # Query 3: avg cycle time per swimlane — time from first movement to first
        # done-column entry, averaged across cards completed in the last 30d.
        avg_cycle_by_swimlane: dict[int, float | None] = {}
        if done_column_ids:
            from django.db.models import Min
            # 3a: first done-column entry per card in the last 30d.
            done_entries = {
                r["card_id"]: r
                for r in CardMovement.objects
                .filter(
                    card__board=board,
                    card__archived_at__isnull=True,
                    to_column_id__in=done_column_ids,
                    moved_at__gte=cutoff_30d,
                )
                .values("card_id", "card__swimlane_id")
                .annotate(done_at=Min("moved_at"))
            }
            if done_entries:
                # 3b: first movement per card (proxy for work-start) — single query.
                start_by_card = {
                    r["card_id"]: r["start_at"]
                    for r in CardMovement.objects
                    .filter(card_id__in=done_entries.keys())
                    .values("card_id")
                    .annotate(start_at=Min("moved_at"))
                }
                buckets: dict[int, list[float]] = {}
                for card_id, entry in done_entries.items():
                    start = start_by_card.get(card_id)
                    done_at = entry["done_at"]
                    if start and done_at and done_at > start:
                        days = (done_at - start).total_seconds() / 86400
                        buckets.setdefault(entry["card__swimlane_id"], []).append(days)
                avg_cycle_by_swimlane = {
                    k: round(sum(v) / len(v), 1) for k, v in buckets.items()
                }

        result = []
        for swimlane in swimlanes:
            col_counts = counts.get(swimlane.id, {})
            vel = vel_by_swimlane.get(swimlane.id, {})
            done_card_count = sum(col_counts.get(cid, 0) for cid in done_column_ids)
            active_cards = sum(col_counts.values()) - done_card_count
            result.append({
                "id": swimlane.id,
                "name": swimlane.name,
                "color": swimlane.color,
                "total_cards": sum(col_counts.values()),
                "stage_distribution": {col.name: col_counts.get(col.id, 0) for col in columns},
                "velocity_7d": vel.get("vel_7d", 0),
                "velocity_30d": vel.get("vel_30d", 0),
                "active_cards": active_cards,
                "done_30d": vel.get("vel_30d", 0),
                "avg_cycle_days": avg_cycle_by_swimlane.get(swimlane.id),
            })

        return Response({"swimlanes": result, "extension_panels": []})

    @action(detail=True, methods=["get"])
    def analytics(self, request, pk=None):
        """Time-in-stage heatmap with outlier detection and stalled cards.

        Query params:
          - ``days`` (int, default 30): window for dwell-time and velocity calculations.
          - ``stalled_days`` (int, optional): overrides ``board.staleness_threshold_days``
            for this request when explicitly provided; omit to use the board setting.

        Dwell time is measured as the number of days a card spent in each column:
        the gap between consecutive movement timestamps (or "now" for the current
        position). Period-cutoff math uses ``effective_entry = max(mv.moved_at,
        period_cutoff)`` so cards that entered a column before the selected window
        correctly contribute only the in-window portion of their dwell time rather
        than showing zero.

        ``is_outlier`` is ``True`` when a swimlane/column cell's average dwell time
        meets or exceeds ``staleness_threshold_days`` (previously used a 2× board
        median heuristic — changed to an absolute threshold in this fix).
        ``board_medians`` is retained in the response for backward compatibility.
        """
        board, _ = get_board_for_user(pk, request.user)
        try:
            days = int(request.query_params.get("days", 30))
        except (ValueError, TypeError):
            return Response(
                {"detail": "Query param 'days' must be a positive integer."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if days <= 0:
            return Response(
                {"detail": "Query param 'days' must be a positive integer."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if days > 365:
            return Response(
                {"detail": "Query param 'days' must not exceed 365."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        now = timezone.now()
        # Stall threshold is a board-level setting, independent of the period selector.
        # The period controls the dwell-time analysis window; staleness is how long a
        # card must sit unmoved before it is considered stuck — these are separate concepts.
        # The stalled_days query param overrides the board setting for this request when
        # explicitly provided; omit it to use board.staleness_threshold_days.
        if "stalled_days" in request.query_params:
            try:
                stalled_days_param = int(request.query_params["stalled_days"])
            except (ValueError, TypeError):
                return Response(
                    {"detail": "Query param 'stalled_days' must be a positive integer."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if stalled_days_param <= 0:
                return Response(
                    {"detail": "Query param 'stalled_days' must be a positive integer."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if stalled_days_param > 90:
                return Response(
                    {"detail": "Query param 'stalled_days' must not exceed 90."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            effective_stalled_days = stalled_days_param
        else:
            effective_stalled_days = board.staleness_threshold_days
        stall_cutoff = now - datetime.timedelta(days=effective_stalled_days)
        # The period window controls which dwell-time data feeds the heatmap.
        period_cutoff = now - datetime.timedelta(days=days)

        columns = list(board.columns.order_by("position"))
        # Partition columns into active (dwell tracked) and done (terminal — clock stops
        # on entry). col_id_to_name and col_name_set are built from ALL columns so the
        # denormalized-name fallback for deleted/recreated columns continues to work.
        done_col_ids = {c.id for c in columns if c.is_done}
        done_col_names = {c.name for c in columns if c.is_done}
        active_columns = [c for c in columns if not c.is_done]
        col_id_to_name = {c.id: c.name for c in columns}
        # Set of current column names for the denormalized-name fallback below.
        col_name_set = {c.name for c in columns}

        swimlane_results = []
        all_col_dwells: dict[str, list[float]] = {c.name: [] for c in active_columns}

        # Load all cards and their movements in two queries (cards + prefetch),
        # then group by swimlane to avoid O(swimlanes) extra card+movement queries.
        all_cards = list(
            board.cards.prefetch_related("movements").order_by("swimlane_id", "position")
        )
        cards_by_swimlane: dict[int, list] = {}
        for _c in all_cards:
            cards_by_swimlane.setdefault(_c.swimlane_id, []).append(_c)

        for swimlane in board.swimlanes.order_by("position"):
            cards = cards_by_swimlane.get(swimlane.id, [])
            col_dwells: dict[str, list[float]] = {c.name: [] for c in active_columns}
            stalled_cards = []
            deal_velocity_days = []

            for card in cards:
                # Use .all() to read from the prefetch cache; re-sorting in Python
                # avoids an extra ORDER BY query per card.
                movements = sorted(card.movements.all(), key=lambda m: m.moved_at)
                if not movements:
                    continue
                for i, mv in enumerate(movements):
                    col_name = col_id_to_name.get(mv.to_column_id)
                    # Fall back to the denormalized name field when the FK no longer
                    # resolves — this happens when a column was deleted and recreated
                    # with a new PK while the name stayed the same.
                    # Guard: only trigger when to_column_id is genuinely absent from
                    # this board's column set (not just a None FK). If two active
                    # columns share the same name the fallback is ambiguous and will
                    # attribute dwell to whichever name appears in col_name_set; this
                    # is a known limitation accepted because duplicate column names on
                    # a single board are rare in practice.
                    if mv.to_column_id not in col_id_to_name and mv.to_column_name in col_name_set:
                        col_name = mv.to_column_name
                    if not col_name:
                        continue
                    # Done columns are terminal — dwell is not tracked here. The card's
                    # clock stops at entry into a done column; counting time spent there
                    # would inflate the heatmap with post-completion idle time.
                    if mv.to_column_id in done_col_ids or col_name in done_col_names:
                        continue
                    # For archived cards use archived_at as the terminal timestamp so
                    # dwell time covers only the active period, not time since archiving.
                    exit_ = movements[i + 1].moved_at if i + 1 < len(movements) else (card.archived_at or now)
                    # Skip movements that ended entirely before the analysis window.
                    if exit_ <= period_cutoff:
                        continue
                    # Clamp the entry to the period cutoff so cards that entered a column
                    # before the window still contribute their in-window dwell time.
                    # Without this, a card sitting in "In Progress" for 60 days would show
                    # no data in the 7d or 30d views — even though it is actively dwelling.
                    effective_entry = max(mv.moved_at, period_cutoff)
                    dwell_days = (exit_ - effective_entry).total_seconds() / 86400
                    col_dwells[col_name].append(dwell_days)
                    all_col_dwells[col_name].append(dwell_days)
                # Velocity: only count cards whose last movement fell within the window,
                # so the metric reflects recent throughput rather than all-time history.
                if len(movements) > 1 and movements[-1].moved_at >= period_cutoff:
                    deal_velocity_days.append(
                        (movements[-1].moved_at - movements[0].moved_at).total_seconds() / 86400
                    )
                # Cards in done columns are excluded from stalled detection — they have
                # completed the workflow. Note: done_col_ids reflects current is_done
                # state, so a column later re-flagged as done retroactively excludes
                # its cards from stalled detection.
                last_mv = movements[-1]
                last_col_is_done = (
                    last_mv.to_column_id in done_col_ids
                    or last_mv.to_column_name in done_col_names
                )
                if card.archived_at is None and not last_col_is_done and last_mv.moved_at < stall_cutoff:
                    stalled_cards.append({
                        "id": card.id,
                        "title": card.title,
                        "days_since_move": (now - movements[-1].moved_at).days,
                    })

            avg_days = {
                col.name: (
                    round(sum(col_dwells[col.name]) / len(col_dwells[col.name]), 1)
                    if col_dwells[col.name] else None
                )
                for col in active_columns
            }
            swimlane_results.append({
                "id": swimlane.id,
                "name": swimlane.name,
                "avg_days_per_column": avg_days,
                "deal_velocity_days": (
                    round(sum(deal_velocity_days) / len(deal_velocity_days), 1)
                    if deal_velocity_days else None
                ),
                "stalled_cards": stalled_cards,
                "is_outlier": {},
            })

        board_medians = {
            col.name: (
                round(statistics.median(all_col_dwells[col.name]), 1)
                if all_col_dwells[col.name] else None
            )
            for col in active_columns
        }
        # is_outlier intentionally uses board.staleness_threshold_days (not effective_stalled_days)
        # so that heatmap cell coloring is always anchored to the board's configured threshold,
        # regardless of any stalled_days query-param override. The override affects only the
        # stalled_cards list — it is an ad-hoc investigation tool, not a permanent display mode.
        # Callers that pass stalled_days should not expect the heatmap colors to shift.
        for sw in swimlane_results:
            sw["is_outlier"] = {
                col.name: (
                    sw["avg_days_per_column"][col.name] is not None
                    and sw["avg_days_per_column"][col.name] >= board.staleness_threshold_days
                )
                for col in active_columns
            }

        return Response({
            "days": days,
            "columns": [c.name for c in columns],
            "done_columns": [c.name for c in columns if c.is_done],
            "board_medians": board_medians,  # kept for backward compat
            "swimlanes": swimlane_results,
            "stalled_threshold_days": effective_stalled_days,
            "staleness_threshold_days": board.staleness_threshold_days,
            "stale_warning_pct": board.stale_warning_pct,
        })

    @action(detail=True, methods=["get"])
    def export(self, request, pk=None):
        """Export board data as CSV or JSON. Requires member or admin access."""
        board, role = get_board_for_user(pk, request.user)
        if role not in (BoardMembership.Role.MEMBER, BoardMembership.Role.ADMIN, SITE_ADMIN):
            return Response(
                {"detail": "Board export requires member or admin access."},
                status=status.HTTP_403_FORBIDDEN,
            )
        export_format = request.query_params.get("format", "csv")
        today = datetime.date.today().isoformat()
        safe_name = slugify(board.name) or "board"

        cards = (
            Card.objects.filter(board=board)
            .select_related("column", "swimlane", "assignee", "created_by")
            .prefetch_related(
                "labels",
                "movements__from_column",
                "movements__to_column",
                "movements__moved_by",
                "comments__author",
                "checklist_items",
            )
            .order_by("position")
        )

        if export_format == "json":
            columns = board.columns.order_by("position")
            swimlanes = board.swimlanes.order_by("position")
            labels = board.labels.all()

            cards_data = []
            for card in cards:
                # Use .all() + sorted() to read from the prefetch cache instead of
                # issuing an ORDER BY query per card for movements, comments, and checklist.
                movements = sorted(card.movements.all(), key=lambda m: m.moved_at)
                cards_data.append({
                    "title": card.title,
                    "description": card.description,
                    "column": card.column.name,
                    "swimlane": card.swimlane.name,
                    "priority": card.priority,
                    "assignee": card.assignee.username if card.assignee else None,
                    "labels": [lb.name for lb in card.labels.all()],
                    "due_date": card.due_date.isoformat() if card.due_date else None,
                    "weight": card.weight,
                    "position": card.position,
                    "created_at": card.created_at.isoformat(),
                    "created_by": card.created_by.username if card.created_by else None,
                    "comments": [
                        {
                            "author": c.author.username if c.author else None,
                            "body": c.body,
                            "created_at": c.created_at.isoformat(),
                        }
                        for c in sorted(card.comments.all(), key=lambda c: c.created_at)
                    ],
                    "checklist": [
                        {
                            "text": item.text,
                            "is_checked": item.is_checked,
                        }
                        for item in sorted(card.checklist_items.all(), key=lambda i: i.position)
                    ],
                })

            payload = {
                "name": board.name,
                "description": board.description,
                "columns": [
                    {
                        "name": col.name,
                        "position": col.position,
                        "color": col.color,
                        "wip_limit": col.wip_limit,
                        "weight_limit": col.weight_limit,
                        "allow_card_creation": col.allow_card_creation,
                        "is_done": col.is_done,
                    }
                    for col in columns
                ],
                "swimlanes": [
                    {
                        "name": sw.name,
                        "position": sw.position,
                        "color": sw.color,
                        # Only admins may see swimlane PII (contact_email, notes)
                        # — consistent with SwimlaneAdminSerializer vs SwimlaneSerializer.
                        **(
                            {"contact_email": sw.contact_email, "notes": sw.notes}
                            if role in (BoardMembership.Role.ADMIN, SITE_ADMIN)
                            else {}
                        ),
                    }
                    for sw in swimlanes
                ],
                "labels": [
                    {"name": lb.name, "color": lb.color}
                    for lb in labels
                ],
                "cards": cards_data,
            }

            content = json.dumps(payload, indent=2, ensure_ascii=False)
            response = HttpResponse(content, content_type="application/json")
            response["Content-Disposition"] = f'attachment; filename="{safe_name}-{today}.json"'
            return response

        # Default: CSV export
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow([
            "Card ID", "Title", "Description", "Column", "Swimlane",
            "Priority", "Assignee", "Labels", "Due Date", "Weight",
            "Created At", "Created By", "Last Moved At", "Movement Count",
            "Movement History",
        ])

        s = _sanitize_csv_field  # local alias for brevity in the writerow calls below
        for card in cards:
            movements = sorted(card.movements.all(), key=lambda m: m.moved_at)
            label_names = ", ".join(s(lb.name) for lb in card.labels.all())
            last_moved = movements[-1].moved_at.isoformat() if movements else ""
            history_parts = []
            for mv in movements:
                from_col = s(mv.from_column.name) if mv.from_column else ""
                to_col = s(mv.to_column.name) if mv.to_column else ""
                moved_by = s(mv.moved_by.username) if mv.moved_by else ""
                history_parts.append(
                    f"{mv.moved_at.isoformat()}|{from_col}|{to_col}|{moved_by}"
                )
            history = "; ".join(history_parts)

            writer.writerow([
                card.id,
                s(card.title),
                s(card.description),
                s(card.column.name),
                s(card.swimlane.name),
                card.priority,
                s(card.assignee.username) if card.assignee else "",
                label_names,
                card.due_date.isoformat() if card.due_date else "",
                card.weight,
                card.created_at.isoformat(),
                s(card.created_by.username) if card.created_by else "",
                last_moved,
                len(movements),
                history,
            ])

        response = HttpResponse(buf.getvalue(), content_type="text/csv")
        response["Content-Disposition"] = f'attachment; filename="{safe_name}-{today}.csv"'
        return response

    @action(detail=True, methods=["get"], url_path="movements")
    def movements(self, request, pk=None):
        """Board-level movement history with filtering and offset pagination.

        Returns CardMovement records for the board, newest first, with card
        title and uid denormalized for display. All board members (including
        viewers) may read movement history.

        Query params:
          - ``swimlane_id`` (int): filter by the card's current swimlane.
          - ``to_column_id`` (int): filter by destination column.
          - ``assignee_id`` (int): filter by card assignee.
          - ``moved_after`` (ISO date): include movements on or after this date.
          - ``moved_before`` (ISO date): include movements on or before this date.
          - ``exclude_type`` (comma-separated): movement_type values to exclude
            (e.g. ``archived,unarchived`` hides system events).
          - ``offset`` (int, default 0): pagination offset.

        Defaults to the last 30 days when no date params are provided.
        Page size is fixed at 50.
        """
        board, _ = get_board_for_user(pk, request.user)
        now = timezone.now()
        PAGE_SIZE = 50

        qs = (
            CardMovement.objects
            .filter(card__board=board)
            .select_related("card", "moved_by", "from_column", "to_column", "from_swimlane", "to_swimlane")
            .order_by("-moved_at")
        )

        # Date range — default to last 30 days when neither param is supplied.
        moved_after = request.query_params.get("moved_after")
        moved_before = request.query_params.get("moved_before")
        if not moved_after and not moved_before:
            qs = qs.filter(moved_at__gte=now - datetime.timedelta(days=30))
        else:
            if moved_after:
                try:
                    qs = qs.filter(moved_at__date__gte=moved_after)
                except (ValueError, TypeError):
                    return Response({"detail": "moved_after must be a valid ISO date."}, status=status.HTTP_400_BAD_REQUEST)
            if moved_before:
                try:
                    qs = qs.filter(moved_at__date__lte=moved_before)
                except (ValueError, TypeError):
                    return Response({"detail": "moved_before must be a valid ISO date."}, status=status.HTTP_400_BAD_REQUEST)

        swimlane_id = request.query_params.get("swimlane_id")
        if swimlane_id:
            qs = qs.filter(card__swimlane_id=swimlane_id)

        to_column_id = request.query_params.get("to_column_id")
        if to_column_id:
            qs = qs.filter(to_column_id=to_column_id)

        assignee_id = request.query_params.get("assignee_id")
        if assignee_id:
            qs = qs.filter(card__assignee_id=assignee_id)

        exclude_type = request.query_params.get("exclude_type")
        if exclude_type:
            exclude_types = [t.strip() for t in exclude_type.split(",") if t.strip()]
            qs = qs.exclude(movement_type__in=exclude_types)

        try:
            offset = int(request.query_params.get("offset", 0))
        except (ValueError, TypeError):
            offset = 0

        total = qs.count()
        page = qs[offset: offset + PAGE_SIZE]

        serializer = CardMovementSerializer(page, many=True, context={"request": request})
        return Response({
            "count": total,
            "offset": offset,
            "page_size": PAGE_SIZE,
            "results": serializer.data,
        })

    @action(detail=True, methods=["post"])
    def members(self, request, pk=None):
        """Add or update a member's role on the board (admin only)."""
        board, role = get_board_for_user(pk, request.user)
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        user_id = request.data.get("user_id")
        member_role = request.data.get("role", BoardMembership.Role.MEMBER)
        target_user = get_object_or_404(User, pk=user_id)
        # Only site admins can add/change other site admins
        if target_user.is_site_admin and role != SITE_ADMIN:
            raise PermissionDenied("Cannot modify a site admin's board membership.")
        raw_mod = request.data.get("is_moderator")
        # Normalize: None means "not provided", else coerce to bool.
        # Multipart forms send "false"/"true" as strings.
        if raw_mod is None:
            is_moderator = None
        elif isinstance(raw_mod, str):
            is_moderator = raw_mod.lower() not in ("false", "0", "")
        else:
            is_moderator = bool(raw_mod)
        if is_moderator and member_role in (
            BoardMembership.Role.COLLABORATOR,
            BoardMembership.Role.VIEWER,
        ):
            return Response(
                {"detail": "Moderator entitlement can only be granted to members or admins."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        defaults = {"role": member_role}
        if is_moderator is not None:
            defaults["is_moderator"] = is_moderator
        membership, created = BoardMembership.objects.get_or_create(
            board=board, user=target_user, defaults=defaults
        )
        if not created:
            membership.role = member_role
            if is_moderator is not None:
                membership.is_moderator = is_moderator
            # Clear moderator flag when demoting to collaborator/viewer
            if member_role in (BoardMembership.Role.COLLABORATOR, BoardMembership.Role.VIEWER):
                membership.is_moderator = False
            membership.save()
        membership_data = BoardMembershipSerializer(membership).data
        board_id = board.id
        ws_event = "member.added" if created else "member.updated"
        transaction.on_commit(lambda: broadcast_board_event(board_id, ws_event, membership_data))
        return Response(membership_data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["delete"], url_path="members/(?P<user_id>[^/.]+)")
    def remove_member(self, request, pk=None, user_id=None):
        """Remove a member from the board (admin only)."""
        board, role = get_board_for_user(pk, request.user)
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        target_user = get_object_or_404(User, pk=user_id)
        if target_user.is_site_admin and role != SITE_ADMIN:
            raise PermissionDenied("Cannot remove a site admin from a board.")
        board_id = board.id
        removed_user_id = target_user.id
        BoardMembership.objects.filter(board=board, user=target_user).delete()
        transaction.on_commit(lambda: broadcast_board_event(board_id, "member.removed", {"user_id": removed_user_id}))
        return Response(status=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Columns
# ---------------------------------------------------------------------------

class ColumnViewSet(viewsets.ModelViewSet):
    """CRUD endpoints for columns on a board; write operations require admin role."""

    serializer_class = ColumnSerializer

    def _board_and_role(self):
        return get_board_for_user(self.kwargs["board_pk"], self.request.user)

    def _board(self):
        return self._board_and_role()[0]

    def get_queryset(self):
        return Column.objects.filter(board=self._board())

    def perform_create(self, serializer):
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        # Lock the board row before computing the next position to prevent a race
        # condition where two concurrent requests both read the same Max(position) and
        # attempt to insert two columns with the same value, violating unique_together.
        with transaction.atomic():
            Board.objects.select_for_update().get(pk=board.pk)
            _max = board.columns.aggregate(m=Max("position"))["m"]
            max_pos = 0 if _max is None else _max + 1
            column = serializer.save(board=board, position=max_pos)
        column_data = ColumnSerializer(column).data
        board_id = board.id
        transaction.on_commit(lambda: broadcast_board_event(board_id, "column.created", column_data))

    def perform_update(self, serializer):
        _, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        column = serializer.save()
        column_data = ColumnSerializer(column).data
        board_id = column.board_id
        transaction.on_commit(lambda: broadcast_board_event(board_id, "column.updated", column_data))

    def perform_destroy(self, instance):
        _, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        board_id = instance.board_id
        column_id = instance.id
        instance.delete()
        transaction.on_commit(lambda: broadcast_board_event(board_id, "column.deleted", {"column_id": column_id}))

    @action(detail=False, methods=["post"])
    def reorder(self, request, board_pk=None):
        """Reorder columns by accepting a list of column IDs in the desired order (admin only)."""
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        order = request.data.get("order", [])  # list of column IDs in new order
        with transaction.atomic():
            # Two-pass update to avoid unique_together(board, position) violations.
            # First pass: shift to high positions so no two columns share a position mid-update.
            count = board.columns.count()
            for i, col_id in enumerate(order):
                Column.objects.filter(board=board, pk=col_id).update(position=count + i)
            # Second pass: assign final positions.
            for pos, col_id in enumerate(order):
                Column.objects.filter(board=board, pk=col_id).update(position=pos)
        cols_data = ColumnSerializer(board.columns.order_by("position"), many=True).data
        board_id = board.id
        transaction.on_commit(lambda: broadcast_board_event(board_id, "columns.reordered", {"columns": list(cols_data)}))
        return Response(cols_data)


# ---------------------------------------------------------------------------
# Swimlanes
# ---------------------------------------------------------------------------

class SwimlaneViewSet(viewsets.ModelViewSet):
    """CRUD endpoints for swimlanes on a board; write operations require admin role."""


    def get_serializer_class(self):
        # Admin and site_admin members see contact_email and notes; all others get the
        # public serializer which omits those fields to prevent viewer-role PII exposure.
        _, role = self._board_and_role()
        if role in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            return SwimlaneAdminSerializer
        return SwimlaneSerializer

    def _board_and_role(self):
        return get_board_for_user(self.kwargs["board_pk"], self.request.user)

    def _board(self):
        return self._board_and_role()[0]

    def get_queryset(self):
        return Swimlane.objects.filter(board=self._board())

    def perform_create(self, serializer):
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        # Lock the board row for the same reason as ColumnViewSet.perform_create —
        # concurrent swimlane creation could race on Max(position).
        with transaction.atomic():
            Board.objects.select_for_update().get(pk=board.pk)
            _max = board.swimlanes.aggregate(m=Max("position"))["m"]
            max_pos = 0 if _max is None else _max + 1
            swimlane = serializer.save(board=board, position=max_pos)
        # Broadcast uses the public serializer — contact_email and notes must not be
        # sent to viewer-role members who are connected via WebSocket.
        swimlane_data = SwimlaneSerializer(swimlane).data
        board_id = board.id
        transaction.on_commit(lambda: broadcast_board_event(board_id, "swimlane.created", swimlane_data))

    def perform_update(self, serializer):
        _, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        swimlane = serializer.save()
        # Same broadcast-safety constraint as perform_create.
        swimlane_data = SwimlaneSerializer(swimlane).data
        board_id = swimlane.board_id
        transaction.on_commit(lambda: broadcast_board_event(board_id, "swimlane.updated", swimlane_data))

    def perform_destroy(self, instance):
        _, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        board_id = instance.board_id
        swimlane_id = instance.id
        instance.delete()
        transaction.on_commit(lambda: broadcast_board_event(board_id, "swimlane.deleted", {"swimlane_id": swimlane_id}))

    @action(detail=False, methods=["post"])
    def reorder(self, request, board_pk=None):
        """Reorder swimlanes by accepting a list of swimlane IDs in the desired order (admin only)."""
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        order = request.data.get("order", [])
        with transaction.atomic():
            # Single-pass update is safe here: Swimlane has unique_together on
            # (board, name), NOT (board, position), so mid-update position
            # collisions cannot cause an IntegrityError.  Contrast with
            # ColumnViewSet.reorder which requires a two-pass approach because
            # Column has unique_together = ["board", "position"].
            for pos, swimlane_id in enumerate(order):
                Swimlane.objects.filter(board=board, pk=swimlane_id).update(position=pos)
        lanes_data = SwimlaneSerializer(board.swimlanes.order_by("position"), many=True).data
        board_id = board.id
        transaction.on_commit(lambda: broadcast_board_event(board_id, "swimlanes.reordered", {"swimlanes": list(lanes_data)}))
        return Response(lanes_data)


# ---------------------------------------------------------------------------
# Labels
# ---------------------------------------------------------------------------

class LabelViewSet(viewsets.ModelViewSet):
    """CRUD endpoints for labels on a board; write operations require admin role."""

    serializer_class = LabelSerializer

    def _board_and_role(self):
        return get_board_for_user(self.kwargs["board_pk"], self.request.user)

    def _board(self):
        return self._board_and_role()[0]

    def get_queryset(self):
        return Label.objects.filter(board=self._board())

    def perform_create(self, serializer):
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        label = serializer.save(board=board)
        label_data = LabelSerializer(label).data
        board_id = board.id
        transaction.on_commit(lambda: broadcast_board_event(board_id, "label.created", label_data))

    def perform_update(self, serializer):
        _, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        label = serializer.save()
        label_data = LabelSerializer(label).data
        board_id = label.board_id
        transaction.on_commit(lambda: broadcast_board_event(board_id, "label.updated", label_data))

    def perform_destroy(self, instance):
        _, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        board_id = instance.board_id
        label_id = instance.id
        instance.delete()
        transaction.on_commit(lambda: broadcast_board_event(board_id, "label.deleted", {"label_id": label_id}))


# ---------------------------------------------------------------------------
# Cards
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

    def _board_and_role(self):
        return get_board_for_user(self.kwargs["board_pk"], self.request.user)

    def _board(self):
        return self._board_and_role()[0]

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

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        ctx["board"] = self._board()
        return ctx

    def perform_create(self, serializer):
        board, role = self._board_and_role()
        # Allow-list: only member, admin, or site_admin may create cards.
        # A block-list (VIEWER, COLLABORATOR) would silently allow any future
        # role added to the system — the allow-list is the safe default.
        if role not in (BoardMembership.Role.MEMBER, BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied("You do not have permission to perform this action.")
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
        card_data = _refetched_card_data(card, self.request, board)
        transaction.on_commit(lambda: broadcast_board_event(board.id, "card.created", card_data))
        if card.description:
            # Notify any @mentioned board members in the initial description.
            # Captured in local vars to avoid closure mutation after the lambda is registered.
            _card, _actor, _desc = card, self.request.user, card.description
            transaction.on_commit(lambda: notify_new_mentions(_card, _actor, "", _desc))

    def perform_destroy(self, instance):
        board, role = self._board_and_role()
        # Allow-list: same pattern as perform_create — safer than block-list.
        if role not in (BoardMembership.Role.MEMBER, BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied("You do not have permission to perform this action.")
        # Ownership gate: members may only delete cards they created, unless
        # they have the moderator entitlement (#362).
        if instance.created_by_id != self.request.user.id:
            if not _can_modify_others_content(board, role, self.request.user):
                raise PermissionDenied("You can only delete cards you created.")
        board_id = instance.board_id
        card_id = instance.id
        instance.delete()
        transaction.on_commit(lambda: broadcast_board_event(board_id, "card.deleted", {"card_id": card_id}))

    @action(detail=True, methods=["post"])
    def archive(self, request, board_pk=None, pk=None):
        """Soft-delete a card by setting archived_at to now.

        Member+ role required — same boundary as edit/delete. The card is
        removed from the active board view; analytics counts it only for the
        period it was active (entry → archive timestamp).
        """
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.MEMBER, BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        # Use the unfiltered manager so archiving an already-archived card is
        # a no-op rather than a 404.
        card = get_object_or_404(Card, pk=pk, board=board)
        # Ownership gate: members may only archive cards they created (#362).
        if card.created_by_id != request.user.id:
            if not _can_modify_others_content(board, role, request.user):
                raise PermissionDenied("You can only archive cards you created.")
        if card.archived_at is None:
            board_id = card.board_id
            card_id = card.id
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
            transaction.on_commit(lambda: broadcast_board_event(board_id, "card.archived", {"card_id": card_id}))
        return Response(CardSerializer(
            _card_queryset(Card.objects.filter(pk=card.pk)).get(),
            context={"request": request, "board": card.board},
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
        card = get_object_or_404(Card, pk=pk, board=board)
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
            transaction.on_commit(lambda: broadcast_board_event(board_id, "card.unarchived", card_data_fn()))
        return Response(CardSerializer(
            _card_queryset(Card.objects.filter(pk=card.pk)).get(),
            context={"request": request, "board": card.board},
        ).data)

    @action(detail=False, methods=["get"], url_path="archived")
    def archived(self, request, board_pk=None):
        """List archived cards for this board, newest first.

        Read access is intentionally open to all board members including
        viewers — listing archived cards is a read operation, consistent with
        viewer access to all other read endpoints. Only archive/unarchive
        (write operations) are restricted to member+.
        """
        board = self._board()
        qs = _card_queryset(Card.objects.filter(board=board, archived_at__isnull=False)).order_by("-archived_at")
        serializer = CardSerializer(qs, many=True, context={"request": request, "board": board})
        return Response(serializer.data)

    def update(self, request, *args, **kwargs):
        """Update card fields and record a CardActivity entry for each changed field.

        A snapshot of mutable fields is taken before the save, then compared
        afterwards to determine which fields actually changed. Only fields present
        in the request body are considered for title/description (to avoid spurious
        activity entries when a partial PATCH omits them). Label changes are
        expressed as a single activity entry listing added (+) and removed (-)
        names. A Notification is created for the new assignee when the assignee
        changes to someone other than the current user.

        The entire sequence (card save → activity creation → notification creation
        → on_commit broadcast registration) runs inside a single atomic block so
        that a failure at any step rolls back all side-effects rather than leaving
        the card saved but with a missing activity trail or notification.
        """
        _, role = self._board_and_role()
        if role in (BoardMembership.Role.VIEWER, BoardMembership.Role.COLLABORATOR):
            raise PermissionDenied
        partial = kwargs.pop("partial", False)
        card = self.get_object()
        with transaction.atomic():
            # Snapshot before update
            old_title = card.title
            old_priority = card.priority
            old_weight = card.weight
            old_assignee_id = card.assignee_id
            old_assignee_name = card.assignee.username if card.assignee else "Unassigned"
            old_description = card.description
            old_label_ids = set(card.labels.values_list("id", flat=True))
            old_due_date = card.due_date.isoformat() if card.due_date else ""

            serializer = self.get_serializer(card, data=request.data, partial=partial)
            serializer.is_valid(raise_exception=True)
            self.perform_update(serializer)
            card.refresh_from_db()

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
            new_label_ids = set(card.labels.values_list("id", flat=True))
            if old_label_ids != new_label_ids:
                added = new_label_ids - old_label_ids
                removed = old_label_ids - new_label_ids
                parts = []
                if added:
                    names = list(Label.objects.filter(id__in=added).values_list("name", flat=True))
                    parts.append(f"+{', '.join(names)}")
                if removed:
                    names = list(Label.objects.filter(id__in=removed).values_list("name", flat=True))
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
            transaction.on_commit(lambda: broadcast_board_event(board_id, "card.updated", card_data))
        return Response(serializer.data)

    @action(detail=True, methods=["post"])
    @transaction.atomic
    def move(self, request, board_pk=None, pk=None):
        """Move a card to a new column/swimlane/position, creating a CardMovement record."""
        board, role = self._board_and_role()
        if role in (BoardMembership.Role.VIEWER, BoardMembership.Role.COLLABORATOR):
            raise PermissionDenied
        card = get_object_or_404(Card, pk=pk, board=board)

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
        card.save(update_fields=["column", "swimlane", "position"])

        # Re-fetch the card through _card_queryset so CardSerializer has all
        # prefetches populated — the card instance at this point is bare (loaded
        # by get_object_or_404 earlier) and would trigger ~7 extra queries.
        card_data = CardSerializer(
            _card_queryset(Card.objects.filter(pk=card.pk)).get(),
            context={"request": request, "board": board},
        ).data
        response_data = {"card": card_data}
        if movement:
            response_data["movement"] = CardMovementSerializer(movement).data

        # Broadcast the same shape as the REST response so WS clients can update
        # movement history without re-polling /movements/.
        broadcast_data = dict(response_data)
        transaction.on_commit(lambda: broadcast_board_event(board.id, "card.moved", broadcast_data))
        return Response(response_data)

    @action(detail=True, methods=["get"])
    def movements(self, request, board_pk=None, pk=None):
        """Return the full movement history for a card."""
        board = self._board()
        card = get_object_or_404(Card, pk=pk, board=board)
        movements = card.movements.select_related(
            "card", "from_column", "to_column", "from_swimlane", "to_swimlane", "moved_by"
        )
        return Response(CardMovementSerializer(movements, many=True).data)

    @action(detail=True, methods=["get"])
    def activities(self, request, board_pk=None, pk=None):
        """Return the field-change activity log for a card."""
        board = self._board()
        card = get_object_or_404(Card, pk=pk, board=board)
        serializer = CardActivitySerializer(card.activities.select_related("actor"), many=True)
        return Response(serializer.data)

    @action(detail=True, methods=["post", "get"])
    def comments(self, request, board_pk=None, pk=None):
        """List or add comments on a card; POST also handles @mention notifications."""
        board, role = self._board_and_role()
        card = get_object_or_404(Card, pk=pk, board=board)
        if request.method == "GET":
            return Response(CardCommentSerializer(card.comments.select_related("author"), many=True).data)
        if role == BoardMembership.Role.VIEWER:
            return Response(
                {"detail": "Viewers cannot perform this action."},
                status=status.HTTP_403_FORBIDDEN,
            )
        serializer = CardCommentSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        comment = serializer.save(card=card, author=request.user)
        CardActivity.objects.create(
            card=card, event_type=CardActivity.EventType.COMMENT_ADDED,
            from_value="", to_value="", actor=request.user,
        )
        card_data = _refetched_card_data(card, request, board)
        board_id = board.id
        transaction.on_commit(lambda: broadcast_board_event(board_id, "card.updated", card_data))
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
        if role == BoardMembership.Role.VIEWER:
            return Response(
                {"detail": "Viewers cannot perform this action."},
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
        comment.delete()
        card_data = _refetched_card_data(card, request, board)
        board_id = board.id
        transaction.on_commit(lambda: broadcast_board_event(board_id, "card.updated", card_data))
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

        if role == BoardMembership.Role.VIEWER:
            return Response(
                {"detail": "Viewers cannot perform this action."},
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
                filename=file.name,
                size=file.size,
                uploaded_by=request.user,
            )
            card.refresh_from_db()
            card_data = _refetched_card_data(card, request, board)
            board_id = board.id
            transaction.on_commit(lambda: broadcast_board_event(board_id, "card.updated", card_data))
        serializer = CardAttachmentSerializer(attachment, context={"request": request})
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["delete"], url_path="attachments/(?P<attachment_pk>[^/.]+)")
    def delete_attachment(self, request, board_pk=None, pk=None, attachment_pk=None):
        """Delete an attachment and its underlying file from storage."""
        board, role = self._board_and_role()
        if role == BoardMembership.Role.VIEWER:
            return Response(
                {"detail": "Viewers cannot perform this action."},
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
        attachment.file.delete(save=False)
        attachment.delete()
        card_data = _refetched_card_data(card, request, board)
        board_id = board.id
        transaction.on_commit(lambda: broadcast_board_event(board_id, "card.updated", card_data))
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["get", "post"], url_path="checklist")
    def checklist(self, request, board_pk=None, pk=None):
        """List checklist items on a card or add a new one."""
        board, role = self._board_and_role()
        card = get_object_or_404(Card, pk=pk, board=board)
        if request.method == "GET":
            items = card.checklist_items.all()
            return Response(CardChecklistSerializer(items, many=True).data)
        if role == BoardMembership.Role.VIEWER:
            return Response(
                {"detail": "Viewers cannot perform this action."},
                status=status.HTTP_403_FORBIDDEN,
            )
        serializer = CardChecklistSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        position = card.checklist_items.count()
        item = serializer.save(card=card, position=position)
        CardActivity.objects.create(
            card=card, event_type=CardActivity.EventType.CHECKLIST_ITEM_ADDED,
            from_value="", to_value=item.text, actor=request.user,
        )
        card_data = _refetched_card_data(card, request, board)
        board_id = board.id
        transaction.on_commit(lambda: broadcast_board_event(board_id, "card.updated", card_data))
        return Response(CardChecklistSerializer(item).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["patch", "delete"], url_path="checklist/(?P<item_pk>[^/.]+)")
    def checklist_item(self, request, board_pk=None, pk=None, item_pk=None):
        """Update (PATCH) or delete a single checklist item."""
        board, role = self._board_and_role()
        if role == BoardMembership.Role.VIEWER:
            return Response(
                {"detail": "Viewers cannot perform this action."},
                status=status.HTTP_403_FORBIDDEN,
            )
        card = get_object_or_404(Card, pk=pk, board=board)
        item = get_object_or_404(CardChecklist, pk=item_pk, card=card)
        if request.method == "DELETE":
            CardActivity.objects.create(
                card=card, event_type=CardActivity.EventType.CHECKLIST_ITEM_DELETED,
                from_value=item.text, to_value="", actor=request.user,
            )
            item.delete()
            card_data = _refetched_card_data(card, request, board)
            board_id = board.id
            transaction.on_commit(lambda: broadcast_board_event(board_id, "card.updated", card_data))
            return Response(status=status.HTTP_204_NO_CONTENT)
        old_checked = item.is_checked
        serializer = CardChecklistSerializer(item, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
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
        card_data = _refetched_card_data(card, request, board)
        board_id = board.id
        transaction.on_commit(lambda: broadcast_board_event(board_id, "card.updated", card_data))
        return Response(serializer.data)



# ---------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------

class NotificationListView(APIView):
    """GET /api/notifications/ — last 50 notifications for current user"""

    def get(self, request):
        qs = Notification.objects.filter(recipient=request.user, read=False).select_related("card", "board")[:50]
        data = [
            {
                "id": n.id,
                "verb": n.verb,
                "card_id": n.card_id,
                "card_title": n.card.title if n.card else None,
                "board_id": n.board_id,
                "board_name": n.board.name if n.board else None,
                "read": n.read,
                "created_at": n.created_at,
            }
            for n in qs
        ]
        return Response(data)


class NotificationMarkReadView(APIView):
    """POST /api/notifications/mark-read/"""

    def post(self, request):
        if request.data.get("all"):
            Notification.objects.filter(recipient=request.user, read=False).update(read=True)
        else:
            ids = request.data.get("ids", [])
            Notification.objects.filter(recipient=request.user, id__in=ids).update(read=True)
        return Response({"ok": True})


class NotificationUnreadCountView(APIView):
    """GET /api/notifications/unread-count/"""

    def get(self, request):
        count = Notification.objects.filter(recipient=request.user, read=False).count()
        return Response({"count": count})


class VersionView(APIView):
    """GET /api/version/ — returns the running application version."""

    def get(self, request):
        return Response({"version": django_settings.APP_VERSION})


# ---------------------------------------------------------------------------
# Health checks (#84)
# ---------------------------------------------------------------------------

class LivenessView(APIView):
    """GET /api/health/liveness/ — K8s liveness probe. Returns 200 if the process is alive."""
    permission_classes = []
    authentication_classes = []
    throttle_classes = []

    def get(self, request):
        return Response({"status": "ok"})


class ReadinessView(APIView):
    """GET /api/health/readiness/ — K8s readiness probe. Checks DB and Redis."""
    permission_classes = []
    authentication_classes = []
    throttle_classes = []

    def get(self, request):
        errors = {}

        # Check database
        try:
            from django.db import connection
            connection.ensure_connection()
        except Exception as exc:
            errors["db"] = str(exc)

        # Check Redis cache
        try:
            from django.core.cache import cache
            cache.set("_health", "ok", timeout=5)
            if cache.get("_health") != "ok":
                errors["redis"] = "cache read/write mismatch"
        except Exception as exc:
            errors["redis"] = str(exc)

        if errors:
            return Response({"status": "error", "errors": errors}, status=503)
        return Response({"status": "ok"})


# ---------------------------------------------------------------------------
# Board templates
# ---------------------------------------------------------------------------

class BoardTemplateListView(APIView):
    """Return the list of active board templates for the board creation modal.

    Only active templates are returned, ordered by sort_order.
    Authentication is required — the templates contain no sensitive data, but
    an unauthed caller has no reason to query this endpoint and requiring auth
    aligns with the rest of the boards API.
    """


    def get(self, request):
        templates = BoardTemplate.objects.filter(is_active=True).order_by("sort_order", "name")
        return Response(BoardTemplateSerializer(templates, many=True).data)


# ---------------------------------------------------------------------------
# Authenticated media serving
# ---------------------------------------------------------------------------

class ServeMediaView(APIView):
    """Serve uploaded attachment files with authentication and board-membership checks.

    In production, Django authenticates the request and confirms board membership,
    then delegates the actual file transfer to Nginx via X-Accel-Redirect (zero
    Python I/O overhead). In development (DEBUG=True), Django serves the file
    directly so the stack works without Nginx.

    This replaces the unauthenticated /media/ Nginx proxy — see nginx/app.conf.template.
    Any request that reaches this view but cannot be matched to a known attachment
    (deleted, never existed, or path tampered) receives 404, not 403, to avoid
    leaking whether a path is a valid attachment.
    """


    def get(self, request, path):
        try:
            attachment = (
                CardAttachment.objects
                .select_related("card__board")
                .get(file=path)
            )
        except CardAttachment.DoesNotExist:
            from django.http import Http404
            raise Http404

        board = attachment.card.board
        role = get_board_role(request.user, board)
        if not role:
            # Return 404 (not 403) to avoid leaking whether a file path is a
            # valid attachment — an attacker who knows a valid path should not
            # receive confirmation of that fact via a 403.
            from django.http import Http404
            raise Http404

        # Determine Content-Type from the stored filename (not the URL path,
        # which could be tampered) and set Content-Disposition to prevent
        # browsers from rendering uploaded files inline as HTML (#372).
        import mimetypes
        content_type, _ = mimetypes.guess_type(attachment.filename)
        content_type = content_type or "application/octet-stream"
        # Only allow inline display for known-safe image types; everything
        # else is forced to download to prevent stored XSS via polyglot files.
        _safe_inline_types = {"image/jpeg", "image/png", "image/gif", "image/webp"}
        if content_type in _safe_inline_types:
            disposition = "inline"
        else:
            disposition = f'attachment; filename="{attachment.filename}"'

        if django_settings.DEBUG:
            # Development: serve the file directly through Django. Not used in
            # production where Nginx handles the transfer via X-Accel-Redirect.
            from django.http import FileResponse
            import os
            file_path = os.path.join(django_settings.MEDIA_ROOT, path)
            resp = FileResponse(open(file_path, "rb"), content_type=content_type)
            resp["Content-Disposition"] = disposition
            return resp

        response = HttpResponse()
        response["X-Accel-Redirect"] = f"/protected-media/{path}"
        response["Content-Type"] = content_type
        response["Content-Disposition"] = disposition
        return response


# ---------------------------------------------------------------------------
# Public board share-link
# ---------------------------------------------------------------------------

class ShareBoardView(APIView):
    """GET /api/share/<token>/ — public read-only board view, no authentication required.

    The UUID token is the sole credential. Returns a stripped board payload
    (columns, swimlanes, cards, labels) with all PII removed:
    - No user PKs or emails in assignee or any nested user object
    - No swimlane contact_email or notes
    - No comments, movement history, or member list
    - No share_token in the response body
    """

    permission_classes = []
    authentication_classes = []
    throttle_classes = [ShareLinkThrottle]

    def get(self, request, token):
        import uuid as _uuid
        try:
            token_uuid = _uuid.UUID(token)
        except ValueError:
            from django.http import Http404
            raise Http404
        board = get_object_or_404(
            Board.objects.prefetch_related("columns", "swimlanes", "labels"),
            share_token=token_uuid,
        )
        return Response(PublicBoardSerializer(board).data)
