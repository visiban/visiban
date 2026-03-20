import csv
import datetime
import io
import json
import statistics

import django_filters
from django.conf import settings as django_settings
from django.db import transaction
from django.db.models import F, Max, Q
from django.http import HttpResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.text import slugify
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.parsers import MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.models import User
from groups.models import Group, GroupMembership, get_accessible_group_ids

from .broadcast import broadcast_board_event
from .utils import extract_mentions, _get_effective_member_ids, notify_new_mentions
from .models import (
    Board, BoardFavorite, BoardMembership, BoardTemplate, Column, Swimlane, Label,
    Card, CardMovement, CardActivity, CardAttachment, CardChecklist, CardComment,
    Notification,
)
from .permissions import get_board_role, SITE_ADMIN
from .serializers import (
    BoardSerializer, BoardFullSerializer, BoardMembershipSerializer,
    BoardTemplateSerializer,
    ColumnSerializer, SwimlaneSerializer, LabelSerializer,
    CardSerializer, CardMovementSerializer, CardCommentSerializer,
    CardActivitySerializer, CardAttachmentSerializer, CardChecklistSerializer,
    _card_queryset,
)
from .templates import BOARD_TEMPLATES


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
    # declared MIME type is in the allowlist (already checked above).
    text_types = {"text/plain", "text/csv"}
    if declared_type in text_types:
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
    """Return (board, role) for board_id if user has access; raise 404 or 403 otherwise."""
    board = get_object_or_404(Board, pk=board_id)
    role = get_board_role(user, board)
    if role is None:
        raise PermissionDenied
    return board, role


# ---------------------------------------------------------------------------
# Boards
# ---------------------------------------------------------------------------

class BoardViewSet(viewsets.ModelViewSet):
    """CRUD endpoints for boards, scoped to boards the requesting user has access to."""

    permission_classes = [IsAuthenticated]
    serializer_class = BoardSerializer

    def get_queryset(self):
        user = self.request.user
        if user.is_site_admin:
            qs = Board.objects.all()
        else:
            qs = Board.objects.filter(
                Q(owner=user) |
                Q(memberships__user=user) |
                Q(group__in=get_accessible_group_ids(user))
            ).distinct()
        if self.request.query_params.get("starred") == "true":
            qs = qs.filter(favorites__user=user)
        return qs

    def perform_create(self, serializer):
        board = serializer.save(owner=self.request.user)
        BoardMembership.objects.create(board=board, user=self.request.user, role=BoardMembership.Role.ADMIN)

        template_key = self.request.data.get("template", "simple_kanban")
        template = BOARD_TEMPLATES.get(template_key, BOARD_TEMPLATES["simple_kanban"])

        if template["columns"]:
            Column.objects.bulk_create([
                Column(board=board, name=col["name"], position=i, color=col["color"], allow_card_creation=(i == 0))
                for i, col in enumerate(template["columns"])
            ])

        # Prefer the user-supplied swimlane name from the modal prompt;
        # fall back to the legacy static default for backwards compatibility.
        swimlane_name = (self.request.data.get("swimlane_name") or "").strip()
        if not swimlane_name:
            swimlane_name = template.get("default_swimlane") or ""
        if swimlane_name:
            Swimlane.objects.create(board=board, name=swimlane_name, position=0, color="#6B7280")

    def destroy(self, request, *args, **kwargs):
        board = self.get_object()
        role = get_board_role(request.user, board)
        if board.owner != request.user and role != SITE_ADMIN:
            raise PermissionDenied
        board.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["post", "delete"], url_path="star")
    def star(self, request, pk=None):
        """Star or unstar a board for the requesting user."""
        board = self.get_object()
        if request.method == "POST":
            BoardFavorite.objects.get_or_create(user=request.user, board=board)
        else:
            BoardFavorite.objects.filter(user=request.user, board=board).delete()
        return Response(self.get_serializer(board).data)

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
        return Response(BoardSerializer(board).data)

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
            or request.user.is_site_admin
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

            # Create cards
            for card_data in data.get("cards", []):
                column = column_map.get(card_data["column"])
                swimlane = swimlane_map.get(card_data["swimlane"])
                if not column or not swimlane:
                    continue

                priority = card_data.get("priority", "medium")
                if priority not in [c[0] for c in Card.Priority.choices]:
                    priority = "medium"

                card = Card.objects.create(
                    board=board,
                    column=column,
                    swimlane=swimlane,
                    title=card_data["title"],
                    description=card_data.get("description", ""),
                    priority=priority,
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
        """Return the full board state: columns, swimlanes, cards, labels, and members."""
        board, _ = get_board_for_user(pk, request.user)
        return Response(BoardFullSerializer(board, context={"request": request}).data)

    @action(detail=True, methods=["get"])
    def summary(self, request, pk=None):
        """Per-swimlane card counts, stage distribution, and velocity.

        Uses three aggregate queries regardless of board size instead of the
        previous S×(C+4) loop (one filter per swimlane×column cell).
        """
        from django.db.models import Count
        board, _ = get_board_for_user(pk, request.user)
        now = timezone.now()
        cutoff_7d = now - datetime.timedelta(days=7)
        cutoff_30d = now - datetime.timedelta(days=30)

        columns = list(board.columns.order_by("position"))
        swimlanes = list(board.swimlanes.order_by("position"))
        last_column = columns[-1] if columns else None

        # Query 1: card count per (swimlane, column) in one shot.
        raw_counts = (
            board.cards.filter(archived_at__isnull=True)
            .values("swimlane_id", "column_id")
            .annotate(cnt=Count("id"))
        )
        counts: dict[int, dict[int, int]] = {}
        for row in raw_counts:
            counts.setdefault(row["swimlane_id"], {})[row["column_id"]] = row["cnt"]

        # Query 2: velocity per swimlane — conditional COUNT avoids two round-trips.
        vel_by_swimlane: dict[int, dict] = {}
        if last_column:
            vel_qs = (
                CardMovement.objects
                .filter(card__board=board, card__archived_at__isnull=True, to_column=last_column)
                .values("card__swimlane_id")
                .annotate(
                    vel_7d=Count("id", filter=Q(moved_at__gte=cutoff_7d)),
                    vel_30d=Count("id", filter=Q(moved_at__gte=cutoff_30d)),
                )
            )
            vel_by_swimlane = {r["card__swimlane_id"]: r for r in vel_qs}

        result = []
        for swimlane in swimlanes:
            col_counts = counts.get(swimlane.id, {})
            vel = vel_by_swimlane.get(swimlane.id, {})
            result.append({
                "id": swimlane.id,
                "name": swimlane.name,
                "color": swimlane.color,
                "total_cards": sum(col_counts.values()),
                "stage_distribution": {col.name: col_counts.get(col.id, 0) for col in columns},
                "velocity_7d": vel.get("vel_7d", 0),
                "velocity_30d": vel.get("vel_30d", 0),
            })

        return Response({"swimlanes": result})

    @action(detail=True, methods=["get"])
    def analytics(self, request, pk=None):
        """Time-in-stage heatmap with outlier detection and stalled cards.

        Query params:
          - ``days`` (int, default 30): window for velocity calculations.
          - ``stalled_days`` (int, default 7): a card is "stalled" if its last
            movement was more than this many days ago.

        Dwell time is measured as the number of days a card spent in each column:
        the gap between consecutive movement timestamps (or "now" for the current
        position). Per-swimlane averages are compared against board-wide medians;
        a swimlane/column cell is flagged as an outlier when its average exceeds
        2× the board median for that column.
        """
        board, _ = get_board_for_user(pk, request.user)
        days = int(request.query_params.get("days", 30))
        stalled_days = int(request.query_params.get("stalled_days", 7))
        now = timezone.now()
        stall_cutoff = now - datetime.timedelta(days=stalled_days)

        columns = list(board.columns.order_by("position"))
        col_id_to_name = {c.id: c.name for c in columns}

        swimlane_results = []
        all_col_dwells: dict[str, list[float]] = {c.name: [] for c in columns}

        for swimlane in board.swimlanes.order_by("position"):
            cards = list(
                board.cards.filter(swimlane=swimlane).prefetch_related("movements")
            )
            col_dwells: dict[str, list[float]] = {c.name: [] for c in columns}
            stalled_cards = []
            deal_velocity_days = []

            for card in cards:
                movements = list(card.movements.order_by("moved_at"))
                if not movements:
                    continue
                for i, mv in enumerate(movements):
                    col_name = col_id_to_name.get(mv.to_column_id)
                    if not col_name:
                        continue
                    entry = mv.moved_at
                    # For archived cards use archived_at as the terminal timestamp so
                    # dwell time covers only the active period, not time since archiving.
                    exit_ = movements[i + 1].moved_at if i + 1 < len(movements) else (card.archived_at or now)
                    dwell_days = (exit_ - entry).total_seconds() / 86400
                    col_dwells[col_name].append(dwell_days)
                    all_col_dwells[col_name].append(dwell_days)
                if len(movements) > 1:
                    deal_velocity_days.append(
                        (movements[-1].moved_at - movements[0].moved_at).total_seconds() / 86400
                    )
                # Archived cards are excluded from stalled detection — they are no
                # longer in-flight, so flagging them as stalled would be misleading.
                if card.archived_at is None and movements[-1].moved_at < stall_cutoff:
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
                for col in columns
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
            for col in columns
        }
        for sw in swimlane_results:
            sw["is_outlier"] = {
                col.name: (
                    sw["avg_days_per_column"][col.name] is not None
                    and board_medians[col.name] is not None
                    and board_medians[col.name] > 0
                    and sw["avg_days_per_column"][col.name] > 2 * board_medians[col.name]
                )
                for col in columns
            }

        return Response({
            "days": days,
            "columns": [c.name for c in columns],
            "board_medians": board_medians,
            "swimlanes": swimlane_results,
            "stalled_threshold_days": stalled_days,
        })

    @action(detail=True, methods=["get"])
    def export(self, request, pk=None):
        """Export board data as CSV or JSON."""
        board, _ = get_board_for_user(pk, request.user)
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
                movements = list(card.movements.order_by("moved_at"))
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
                        for c in card.comments.order_by("created_at")
                    ],
                    "checklist": [
                        {
                            "text": item.text,
                            "is_checked": item.is_checked,
                        }
                        for item in card.checklist_items.order_by("position")
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
                    }
                    for col in columns
                ],
                "swimlanes": [
                    {
                        "name": sw.name,
                        "position": sw.position,
                        "color": sw.color,
                        "contact_email": sw.contact_email,
                        "notes": sw.notes,
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
            movements = list(card.movements.order_by("moved_at"))
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
        membership, created = BoardMembership.objects.get_or_create(
            board=board, user=target_user, defaults={"role": member_role}
        )
        if not created:
            membership.role = member_role
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

    permission_classes = [IsAuthenticated]
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

    permission_classes = [IsAuthenticated]
    serializer_class = SwimlaneSerializer

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
        _max = board.swimlanes.aggregate(m=Max("position"))["m"]
        max_pos = 0 if _max is None else _max + 1
        swimlane = serializer.save(board=board, position=max_pos)
        swimlane_data = SwimlaneSerializer(swimlane).data
        board_id = board.id
        transaction.on_commit(lambda: broadcast_board_event(board_id, "swimlane.created", swimlane_data))

    def perform_update(self, serializer):
        _, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        swimlane = serializer.save()
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

    permission_classes = [IsAuthenticated]
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

    permission_classes = [IsAuthenticated]
    serializer_class = CardSerializer
    filterset_class = CardFilter
    ordering_fields = ["position", "due_date", "created_at", "priority"]
    ordering = ["position"]

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
        if role in (BoardMembership.Role.VIEWER, BoardMembership.Role.COLLABORATOR):
            raise PermissionDenied
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
        card_data = CardSerializer(card, context={"request": self.request, "board": board}).data
        transaction.on_commit(lambda: broadcast_board_event(board.id, "card.created", card_data))
        if card.description:
            # Notify any @mentioned board members in the initial description.
            # Captured in local vars to avoid closure mutation after the lambda is registered.
            _card, _actor, _desc = card, self.request.user, card.description
            transaction.on_commit(lambda: notify_new_mentions(_card, _actor, "", _desc))

    def perform_destroy(self, instance):
        _, role = self._board_and_role()
        if role in (BoardMembership.Role.VIEWER, BoardMembership.Role.COLLABORATOR):
            raise PermissionDenied
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
        if role in (BoardMembership.Role.VIEWER, BoardMembership.Role.COLLABORATOR):
            raise PermissionDenied
        # Use the unfiltered manager so archiving an already-archived card is
        # a no-op rather than a 404.
        card = get_object_or_404(Card, pk=pk, board=board)
        if card.archived_at is None:
            board_id = card.board_id
            card_id = card.id
            with transaction.atomic():
                card.archived_at = timezone.now()
                card.save(update_fields=["archived_at"])
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
        if role in (BoardMembership.Role.VIEWER, BoardMembership.Role.COLLABORATOR):
            raise PermissionDenied
        card = get_object_or_404(Card, pk=pk, board=board)
        if card.archived_at is not None:
            board_id = card.board_id

            def card_data_fn():
                return CardSerializer(
                    _card_queryset(Card.objects.filter(pk=card.id)).get(),
                    context={"request": request, "board": card.board},
                ).data

            with transaction.atomic():
                card.archived_at = None
                card.save(update_fields=["archived_at"])
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
        """
        _, role = self._board_and_role()
        if role in (BoardMembership.Role.VIEWER, BoardMembership.Role.COLLABORATOR):
            raise PermissionDenied
        partial = kwargs.pop("partial", False)
        card = self.get_object()

        # Snapshot before update
        old_title = card.title
        old_priority = card.priority
        old_weight = card.weight
        old_assignee_id = card.assignee_id
        old_assignee_name = card.assignee.username if card.assignee else "Unassigned"
        old_description = card.description
        old_label_ids = set(card.labels.values_list("id", flat=True))

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
            # Notify new assignee
            if card.assignee and card.assignee != request.user:
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
            # Lock source cell cards, then reorder to fill gap
            list(Card.objects.filter(
                board=board, column=card.column, swimlane=card.swimlane
            ).exclude(pk=card.pk).order_by("pk").select_for_update())
            source_siblings = Card.objects.filter(
                board=board, column=card.column, swimlane=card.swimlane
            ).exclude(pk=card.pk).order_by("position")
            for i, sibling in enumerate(source_siblings):
                if sibling.position != i:
                    sibling.position = i
                    sibling.save(update_fields=["position"])

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

        card_data = CardSerializer(card, context={"request": request, "board": board}).data
        response_data = {"card": card_data}
        if movement:
            response_data["movement"] = CardMovementSerializer(movement).data

        transaction.on_commit(lambda: broadcast_board_event(board.id, "card.moved", card_data))
        return Response(response_data)

    @action(detail=True, methods=["get"])
    def movements(self, request, board_pk=None, pk=None):
        """Return the full movement history for a card."""
        board = self._board()
        card = get_object_or_404(Card, pk=pk, board=board)
        movements = card.movements.select_related(
            "from_column", "to_column", "from_swimlane", "to_swimlane", "moved_by"
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
            return Response(CardCommentSerializer(card.comments.all(), many=True).data)
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
        card_data = CardSerializer(card, context={"request": request, "board": board}).data
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
        """Delete a comment. Collaborators may only delete their own comments; admins/members may delete any."""
        board, role = self._board_and_role()
        if role == BoardMembership.Role.VIEWER:
            return Response(
                {"detail": "Viewers cannot perform this action."},
                status=status.HTTP_403_FORBIDDEN,
            )
        card = get_object_or_404(Card, pk=pk, board=board)
        comment = get_object_or_404(CardComment, pk=comment_pk, card=card)
        # Collaborators may only delete their own comments; member+ can delete any.
        if role == BoardMembership.Role.COLLABORATOR and comment.author != request.user:
            return Response(
                {"detail": "You can only delete your own comments."},
                status=status.HTTP_403_FORBIDDEN,
            )
        comment.delete()
        card_data = CardSerializer(card, context={"request": request, "board": board}).data
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
                card.attachments.all(), many=True, context={"request": request}
            )
            return Response(serializer.data)

        if role == BoardMembership.Role.VIEWER:
            return Response(
                {"detail": "Viewers cannot perform this action."},
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

        attachment = CardAttachment.objects.create(
            card=card,
            file=file,
            filename=file.name,
            size=file.size,
            uploaded_by=request.user,
        )
        card.refresh_from_db()
        card_data = CardSerializer(card, context={"request": request, "board": board}).data
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
        attachment.file.delete(save=False)
        attachment.delete()
        card_data = CardSerializer(card, context={"request": request, "board": board}).data
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
        card_data = CardSerializer(card, context={"request": request, "board": board}).data
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
            card_data = CardSerializer(card, context={"request": request, "board": board}).data
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
        card_data = CardSerializer(card, context={"request": request, "board": board}).data
        board_id = board.id
        transaction.on_commit(lambda: broadcast_board_event(board_id, "card.updated", card_data))
        return Response(serializer.data)



# ---------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------

class NotificationListView(APIView):
    """GET /api/notifications/ — last 50 notifications for current user"""
    permission_classes = [IsAuthenticated]

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
    permission_classes = [IsAuthenticated]

    def post(self, request):
        if request.data.get("all"):
            Notification.objects.filter(recipient=request.user, read=False).update(read=True)
        else:
            ids = request.data.get("ids", [])
            Notification.objects.filter(recipient=request.user, id__in=ids).update(read=True)
        return Response({"ok": True})


class NotificationUnreadCountView(APIView):
    """GET /api/notifications/unread-count/"""
    permission_classes = [IsAuthenticated]

    def get(self, request):
        count = Notification.objects.filter(recipient=request.user, read=False).count()
        return Response({"count": count})


class VersionView(APIView):
    """GET /api/version/ — returns the running application version."""
    permission_classes = [IsAuthenticated]

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

    permission_classes = [IsAuthenticated]

    def get(self, request):
        templates = BoardTemplate.objects.filter(is_active=True).order_by("sort_order", "name")
        return Response(BoardTemplateSerializer(templates, many=True).data)
