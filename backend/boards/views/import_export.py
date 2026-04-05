"""BoardViewSet mixin for CSV/JSON import and export actions."""

import csv
import datetime
import io
import json

from django.conf import settings as django_settings
from django.db import transaction
from django.http import HttpResponse
from django.shortcuts import get_object_or_404
from django.utils.text import slugify
from rest_framework import status
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.parsers import MultiPartParser
from rest_framework.response import Response
from drf_spectacular.utils import extend_schema, OpenApiTypes

from accounts.models import User
from groups.models import Group, GroupMembership

from ..models import (
    Board, BoardFavorite, BoardMembership as BoardMembershipModel, Card, CardActivity,
    CardChecklist, CardComment, CardMovement, Column, Label, Swimlane,
)
from ..permissions import SITE_ADMIN
from ..serializers import BoardSerializer
from ._helpers import get_board_for_user


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


class BoardImportExportMixin:
    """Mixin providing import and export @action methods for BoardViewSet."""

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
        # The current importer understands schema_version 1 and 2.  Files without the field
        # are treated as version 0 (pre-1.0 exports) and imported on a best-effort basis.
        # v2 adds archived_at per card, movement_type, movement notes, and comment created_at.
        _SUPPORTED_SCHEMA_VERSION = 2
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

        # Validate all timestamp strings before touching the database.  A malformed
        # timestamp inside the atomic block would produce an unhandled 500; catching it
        # here returns a clean 400 and avoids a partial rollback.
        from django.utils.dateparse import parse_datetime as _parse_dt
        for _ci, _card in enumerate(data.get("cards", [])):
            for _field in ("archived_at",):
                _v = _card.get(_field)
                if _v and _parse_dt(str(_v)) is None:
                    return Response(
                        {"detail": f"Card at index {_ci}: invalid timestamp for '{_field}': {_v!r}"},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
            for _ji, _comment in enumerate(_card.get("comments", [])):
                _v = _comment.get("created_at")
                if _v and _parse_dt(str(_v)) is None:
                    return Response(
                        {"detail": f"Card at index {_ci}, comment at index {_ji}: invalid 'created_at': {_v!r}"},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
            for _ji, _mv in enumerate(_card.get("movements", [])):
                _v = _mv.get("moved_at")
                if _v and _parse_dt(str(_v)) is None:
                    return Response(
                        {"detail": f"Card at index {_ci}, movement at index {_ji}: invalid 'moved_at': {_v!r}"},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
            for _ji, _act in enumerate(_card.get("activities", [])):
                _v = _act.get("created_at")
                if _v and _parse_dt(str(_v)) is None:
                    return Response(
                        {"detail": f"Card at index {_ci}, activity at index {_ji}: invalid 'created_at': {_v!r}"},
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
            BoardMembershipModel.objects.create(
                board=board, user=request.user, role=BoardMembershipModel.Role.ADMIN
            )

            # Create columns — bulk_create avoids one INSERT per column.
            col_data = data["columns"]
            col_objs = Column.objects.bulk_create([
                Column(
                    board=board,
                    name=col["name"],
                    position=col.get("position", i),
                    color=col.get("color", "#6B7280"),
                    wip_limit=col.get("wip_limit"),
                    weight_limit=col.get("weight_limit"),
                    allow_card_creation=col.get("allow_card_creation", i == 0),
                    is_done=col.get("is_done", False),
                )
                for i, col in enumerate(col_data)
            ])
            column_map = {col["name"]: obj for col, obj in zip(col_data, col_objs)}

            # Create swimlanes — bulk_create avoids one INSERT per swimlane.
            sw_data = data["swimlanes"]
            sw_objs = Swimlane.objects.bulk_create([
                Swimlane(
                    board=board,
                    name=sw["name"],
                    position=sw.get("position", i),
                    color=sw.get("color", "#3B82F6"),
                    contact_email=sw.get("contact_email", ""),
                    notes=sw.get("notes", ""),
                )
                for i, sw in enumerate(sw_data)
            ])
            swimlane_map = {sw["name"]: obj for sw, obj in zip(sw_data, sw_objs)}

            # Create labels — bulk_create avoids one INSERT per label.
            lbl_data = data.get("labels", [])
            lbl_objs = Label.objects.bulk_create([
                Label(board=board, name=lbl["name"], color=lbl.get("color", "#EAB308"))
                for lbl in lbl_data
            ])
            label_map = {lbl["name"]: obj for lbl, obj in zip(lbl_data, lbl_objs)}

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
            # Case-insensitive user resolution: imported data may contain
            # usernames in a different casing than stored in the DB.
            # Annotate with Lower so the __in filter matches regardless of
            # the stored casing, and key the map by lowered username.
            from django.db.models.functions import Lower
            user_map = {
                u.username.lower(): u
                for u in User.objects.annotate(lower_username=Lower("username"))
                .filter(lower_username__in=[n.lower() for n in all_usernames])
            } if all_usernames else {}

            # ---------- Phase 1: build Card instances (no DB writes yet) ----------
            # We defer all per-card related objects until after bulk_create returns
            # PKs.  Keyed lists accumulate data that needs those PKs.
            valid_priorities = {c[0] for c in Card.Priority.choices}
            valid_event_types = {e[0] for e in CardActivity.EventType.choices}
            valid_movement_types = {t[0] for t in CardMovement.MovementType.choices}

            cards_to_create = []
            # Parallel list: the raw card_data dict for each Card instance so we
            # can correlate after bulk_create assigns PKs.
            cards_raw = []

            for card_data in data.get("cards", []):
                column = column_map.get(card_data["column"])
                swimlane = swimlane_map.get(card_data["swimlane"])
                if not column or not swimlane:
                    continue

                priority = card_data.get("priority", "medium")
                if priority not in valid_priorities:
                    priority = "medium"

                assignee_username = card_data.get("assignee")
                assignee = user_map.get(assignee_username.lower()) if assignee_username else None

                card_obj = Card(
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
                # Restore archived state directly on the instance — bulk_create
                # respects explicitly set field values so no UPDATE pass is needed.
                if card_data.get("archived_at"):
                    card_obj.archived_at = card_data["archived_at"]

                cards_to_create.append(card_obj)
                cards_raw.append(card_data)

            # Single INSERT for all cards.  PostgreSQL returns PKs in insertion
            # order, so cards_to_create[i].pk aligns with cards_raw[i] after this.
            Card.objects.bulk_create(cards_to_create)

            # ---------- Phase 2: build related objects using the assigned PKs ----------
            label_through = Card.labels.through
            label_through_objs = []

            # Auto-generated activities (weight, labels, checklist)
            auto_activities = []

            comments_to_create = []       # (CardComment obj, created_at str or None)
            checklists_to_create = []

            movements_to_create = []      # (CardMovement obj, moved_at str or None)
            imported_activities = []      # (CardActivity obj, created_at str or None)

            for card_obj, card_data in zip(cards_to_create, cards_raw):
                card_pk = card_obj.pk

                # Weight-change activity for non-default weights
                if card_obj.weight and card_obj.weight > 1:
                    auto_activities.append(CardActivity(
                        card_id=card_pk,
                        event_type=CardActivity.EventType.WEIGHT_CHANGE,
                        from_value="1",
                        to_value=str(card_obj.weight),
                        actor=request.user,
                    ))

                # Labels (M2M via through model) + label-change activity
                card_labels = [
                    label_map[name]
                    for name in card_data.get("labels", [])
                    if name in label_map
                ]
                for label in card_labels:
                    label_through_objs.append(
                        label_through(card_id=card_pk, label_id=label.pk)
                    )
                if card_labels:
                    auto_activities.append(CardActivity(
                        card_id=card_pk,
                        event_type=CardActivity.EventType.LABEL_CHANGE,
                        from_value="",
                        to_value=f"+{', '.join(lb.name for lb in card_labels)}",
                        actor=request.user,
                    ))

                # Comments
                for comment_data in card_data.get("comments", []):
                    comments_to_create.append((
                        CardComment(
                            card_id=card_pk,
                            author=request.user,
                            body=comment_data.get("body", ""),
                        ),
                        comment_data.get("created_at"),
                    ))

                # Checklist items + checklist-added activities
                for ci_idx, checklist_data in enumerate(card_data.get("checklist", [])):
                    item = CardChecklist(
                        card_id=card_pk,
                        text=checklist_data.get("text", ""),
                        is_checked=checklist_data.get("is_checked", False),
                        position=ci_idx,
                    )
                    checklists_to_create.append(item)
                    auto_activities.append(CardActivity(
                        card_id=card_pk,
                        event_type=CardActivity.EventType.CHECKLIST_ITEM_ADDED,
                        from_value="",
                        to_value=item.text,
                        actor=request.user,
                    ))

                # Movement history
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
                        user_map.get(moved_by_username.lower()) if moved_by_username else None
                    ) or request.user
                    raw_movement_type = mv_data.get("movement_type", CardMovement.MovementType.MOVE)
                    movement_type = (
                        raw_movement_type
                        if raw_movement_type in valid_movement_types
                        else CardMovement.MovementType.MOVE
                    )
                    movements_to_create.append((
                        CardMovement(
                            card_id=card_pk,
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
                            notes=mv_data.get("notes", ""),
                            movement_type=movement_type,
                        ),
                        mv_data.get("moved_at"),
                    ))

                # Imported activity log entries (field-change history)
                for act_data in card_data.get("activities", []):
                    event_type = act_data.get("event_type", "")
                    if event_type not in valid_event_types:
                        continue
                    actor_username = act_data.get("actor")
                    actor = (
                        user_map.get(actor_username.lower()) if actor_username else None
                    ) or request.user
                    imported_activities.append((
                        CardActivity(
                            card_id=card_pk,
                            event_type=event_type,
                            from_value=act_data.get("from_value", ""),
                            to_value=act_data.get("to_value", ""),
                            actor=actor,
                        ),
                        act_data.get("created_at"),
                    ))

            # ---------- Phase 3: bulk-insert all related objects ----------

            # Labels M2M — ignore_conflicts in case the same label appears twice
            # in a card's label list (defensive; exporter should deduplicate).
            if label_through_objs:
                label_through.objects.bulk_create(label_through_objs, ignore_conflicts=True)

            # Auto-generated activities (no timestamp backfill needed — these are
            # produced by the import itself, not carried over from the export).
            if auto_activities:
                CardActivity.objects.bulk_create(auto_activities)

            # Checklist items
            if checklists_to_create:
                CardChecklist.objects.bulk_create(checklists_to_create)

            # Comments with optional timestamp backfill.
            # bulk_create returns objects with PKs; bulk_update then issues a single
            # UPDATE … SET created_at = CASE WHEN … covering all rows at once.
            if comments_to_create:
                comment_objs = [c for c, _ in comments_to_create]
                CardComment.objects.bulk_create(comment_objs)
                backfill = [
                    (obj, ts) for obj, ts in comments_to_create if ts
                ]
                if backfill:
                    for obj, ts in backfill:
                        obj.created_at = ts
                    CardComment.objects.bulk_update(
                        [obj for obj, _ in backfill], ["created_at"]
                    )

            # Movements with optional moved_at backfill.
            if movements_to_create:
                mv_objs = [m for m, _ in movements_to_create]
                CardMovement.objects.bulk_create(mv_objs)
                backfill = [
                    (obj, ts) for obj, ts in movements_to_create if ts
                ]
                if backfill:
                    for obj, ts in backfill:
                        obj.moved_at = ts
                    CardMovement.objects.bulk_update(
                        [obj for obj, _ in backfill], ["moved_at"]
                    )

            # Imported activities with optional created_at backfill.
            if imported_activities:
                act_objs = [a for a, _ in imported_activities]
                CardActivity.objects.bulk_create(act_objs)
                backfill = [
                    (obj, ts) for obj, ts in imported_activities if ts
                ]
                if backfill:
                    for obj, ts in backfill:
                        obj.created_at = ts
                    CardActivity.objects.bulk_update(
                        [obj for obj, _ in backfill], ["created_at"]
                    )

        # Re-fetch with annotations so BoardSerializer.get_member_count / card_count /
        # is_starred reads from annotation fast-paths instead of 3 fallback queries.
        from django.db.models import Count, Exists, OuterRef, Q
        board = Board.objects.select_related("owner", "group").annotate(
            _member_count=Count("memberships", distinct=True),
            _card_count=Count("cards", filter=Q(cards__archived_at__isnull=True), distinct=True),
            _is_starred=Exists(BoardFavorite.objects.filter(board=OuterRef("pk"), user=request.user)),
        ).get(pk=board.pk)
        return Response(BoardSerializer(board, context={"request": request}).data, status=status.HTTP_201_CREATED)

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
            BoardMembershipModel.objects.create(
                board=board, user=request.user, role=BoardMembershipModel.Role.ADMIN
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

            # Create columns — bulk_create avoids one INSERT per column.
            col_names = list(column_map)
            col_objs = Column.objects.bulk_create([
                Column(board=board, name=name, position=i, color="#6B7280", allow_card_creation=(i == 0))
                for i, name in enumerate(col_names)
            ])
            for name, obj in zip(col_names, col_objs):
                column_map[name] = obj

            # Create swimlanes — bulk_create avoids one INSERT per swimlane.
            sw_names = list(swimlane_map)
            sw_objs = Swimlane.objects.bulk_create([
                Swimlane(board=board, name=name, position=i, color="#3B82F6")
                for i, name in enumerate(sw_names)
            ])
            for name, obj in zip(sw_names, sw_objs):
                swimlane_map[name] = obj

            # Create labels — bulk_create avoids one INSERT per label.
            label_names = list(label_map)
            lbl_objs = Label.objects.bulk_create([
                Label(board=board, name=name, color="#EAB308")
                for name in label_names
            ])
            for name, obj in zip(label_names, lbl_objs):
                label_map[name] = obj

            # Collect valid card objects and their source rows in parallel lists so
            # we can bulk_create all cards in one INSERT, then attach activities and
            # label associations in two further bulk operations.  This mirrors the
            # JSON import path and avoids up to ~1,500 individual INSERTs for a
            # 500-card CSV with weight/label metadata.
            cards_to_create = []
            valid_rows = []
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

                cards_to_create.append(Card(
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
                ))
                valid_rows.append(row)

            created_cards = Card.objects.bulk_create(cards_to_create)

            # Build activity records and label M2M associations in memory, then
            # flush both with a single bulk INSERT each.
            activities = []
            label_through_model = Card.labels.through
            label_through_objs = []

            for card, row in zip(created_cards, valid_rows):
                # Record weight change activity for non-default weights
                if card.weight and card.weight > 1:
                    activities.append(CardActivity(
                        card=card,
                        event_type=CardActivity.EventType.WEIGHT_CHANGE,
                        from_value="1",
                        to_value=str(card.weight),
                        actor=request.user,
                    ))

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
                        label_through_objs.extend(
                            label_through_model(card_id=card.pk, label_id=lbl.pk)
                            for lbl in card_labels
                        )
                        activities.append(CardActivity(
                            card=card,
                            event_type=CardActivity.EventType.LABEL_CHANGE,
                            from_value="",
                            to_value=f"+{', '.join(lb.name for lb in card_labels)}",
                            actor=request.user,
                        ))

            if activities:
                CardActivity.objects.bulk_create(activities)
            if label_through_objs:
                label_through_model.objects.bulk_create(label_through_objs, ignore_conflicts=True)

        # Re-fetch with annotations so BoardSerializer.get_member_count / card_count /
        # is_starred reads from annotation fast-paths instead of 3 fallback queries.
        from django.db.models import Count, Exists, OuterRef, Q
        board = Board.objects.select_related("owner", "group").annotate(
            _member_count=Count("memberships", distinct=True),
            _card_count=Count("cards", filter=Q(cards__archived_at__isnull=True), distinct=True),
            _is_starred=Exists(BoardFavorite.objects.filter(board=OuterRef("pk"), user=request.user)),
        ).get(pk=board.pk)
        return Response(BoardSerializer(board, context={"request": request}).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["get"])
    def export(self, request, pk=None):
        """Export board data as CSV or JSON. Requires member or admin access."""
        board, role = get_board_for_user(pk, request.user)
        if role not in (BoardMembershipModel.Role.MEMBER, BoardMembershipModel.Role.ADMIN, SITE_ADMIN):
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
                "movements__from_swimlane",
                "movements__to_swimlane",
                "movements__moved_by",
                "comments__author",
                "checklist_items",
                "activities__actor",
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
                    "archived_at": card.archived_at.isoformat() if card.archived_at else None,
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
                    "movements": [
                        {
                            "from_column": mv.from_column.name if mv.from_column else None,
                            "to_column": mv.to_column.name if mv.to_column else None,
                            "from_swimlane": mv.from_swimlane.name if mv.from_swimlane else None,
                            "to_swimlane": mv.to_swimlane.name if mv.to_swimlane else None,
                            "moved_by": mv.moved_by.username if mv.moved_by else None,
                            "moved_at": mv.moved_at.isoformat(),
                            "notes": mv.notes,
                            "movement_type": mv.movement_type,
                        }
                        for mv in movements
                    ],
                    "activities": [
                        {
                            "event_type": act.event_type,
                            "from_value": act.from_value,
                            "to_value": act.to_value,
                            "actor": act.actor.username if act.actor else None,
                            "created_at": act.created_at.isoformat(),
                        }
                        for act in sorted(card.activities.all(), key=lambda a: a.created_at)
                    ],
                })

            payload = {
                "schema_version": 2,
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
                            if role in (BoardMembershipModel.Role.ADMIN, SITE_ADMIN)
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
