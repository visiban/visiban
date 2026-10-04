"""BoardViewSet mixin for CSV/JSON import and export actions."""

import csv
import datetime
import hashlib
import io
import json
import logging

from django.conf import settings as django_settings
from django.db import transaction
from django.db.models import Prefetch
from django.http import HttpResponse
from rest_framework.generics import get_object_or_404
from django.utils.text import slugify
from rest_framework import status
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.parsers import MultiPartParser
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle
from drf_spectacular.utils import extend_schema, OpenApiParameter, OpenApiResponse, OpenApiTypes

from accounts.models import User
from groups.models import Group, GroupMembership

from ..models import (
    Board, BoardExportLog, BoardFavorite, BoardMembership as BoardMembershipModel, Card,
    CardActivity, CardChecklist, CardComment, CardExternalRef, CardMovement, Column,
    CustomFieldDefinition, Label, Swimlane,
)
from .. import broadcast as _broadcast
from ..custom_field_types import parse_multi_select
from ..permissions import SITE_ADMIN
from ..serializers import (
    BoardExportLogSerializer, BoardSerializer, CSVImportOptionsSerializer, ExternalRefSerializer,
    ImportOptionsSerializer, _swimlane_custom_field_values,
)
from ..services import trello_import as _trello
from ._helpers import get_board_for_user

# #843: rank of each BoardMembership.Role for the export-threshold comparison.
# Owner and site_admin are not ranked here — they always bypass the threshold
# in ``_can_export_at_min_role`` below.
_EXPORT_ROLE_RANK = {
    BoardMembershipModel.Role.VIEWER: 0,
    BoardMembershipModel.Role.COLLABORATOR: 1,
    BoardMembershipModel.Role.MEMBER: 2,
    BoardMembershipModel.Role.ADMIN: 3,
}


def _role_at_export(board, user, role):
    """Return the audit-log string for the actor's role at export time (#842).

    Owner is captured distinctly from promoted admin so Jordan's retro use
    case can tell the two apart. Site admins with no board membership are
    recorded verbatim as ``site_admin``.
    """
    if role == SITE_ADMIN:
        return "site_admin"
    if board.owner_id == user.id:
        return "owner"
    return role


def _can_export_at_min_role(board, user, role):
    """True iff the user's role meets ``board.export_min_role`` (#843).

    Owner and site_admin always bypass the threshold — they are always
    considered above any board-level role. The threshold is stored as a
    plain string so unknown/future values fall back to the most permissive
    default (``viewer``) rather than locking out existing users on a typo.
    """
    if role == SITE_ADMIN or board.owner_id == user.id:
        return True
    threshold = board.export_min_role or "viewer"
    actor_rank = _EXPORT_ROLE_RANK.get(role)
    threshold_rank = _EXPORT_ROLE_RANK.get(threshold, 0)
    if actor_rank is None:
        return False
    return actor_rank >= threshold_rank

logger = logging.getLogger(__name__)


class BoardImportThrottle(UserRateThrottle):
    """Limit authenticated users to 10 board imports per hour.

    Each import can create a board with up to 500 cards. Without a cap,
    a single authenticated account could fill the database with arbitrary
    content through rapid repeated imports.
    """

    scope = "board_import"


def _query_flag(request, name):
    return str(request.query_params.get(name, "")).lower() in ("true", "1")


class TrelloImportThrottle(UserRateThrottle):
    """Throttle for ``import/trello/`` that picks its scope from the mode (#456).

    A confirmed import shares the ``board_import`` budget (10/hour) with the
    native importer because both create a board. Dry-run previews use the
    looser ``board_import_preview`` scope: the wizard re-previews whenever the
    user changes a mapping option, and charging those against the import
    budget would lock users out before they ever imported anything.
    """

    scope = "board_import_preview"

    def allow_request(self, request, view):
        self.scope = "board_import" if _query_flag(request, "confirm") else "board_import_preview"
        self.rate = self.get_rate()
        self.num_requests, self.duration = self.parse_rate(self.rate)
        return super().allow_request(request, view)


class BoardExportThrottle(UserRateThrottle):
    """Limit authenticated users to 20 board exports per hour.

    A single export for a large board can return tens of MB and involves
    multiple prefetch queries. Without a cap, a board member could hammer
    the endpoint programmatically and create disproportionate DB load.
    """

    scope = "board_export"

def _external_ref_export(card):
    """The card's MR/PR link (#352) as ``{provider, ref, url}``, or None.

    Reads the select_related() cache; a card with no row raises
    RelatedObjectDoesNotExist (an ObjectDoesNotExist), mapped to None here.
    """
    try:
        ref = card.external_ref
    except CardExternalRef.DoesNotExist:
        return None
    return {"provider": ref.provider, "ref": ref.ref, "url": ref.url}


_IMPORT_SKIP_KEYS = (
    "cards", "comments", "checklist_items", "label_refs", "movements", "activities",
)


def _flatten_serializer_errors(errors):
    """First message of a DRF error structure, for a flat ``{"detail": ...}``."""
    if isinstance(errors, dict):
        for key, value in errors.items():
            message = _flatten_serializer_errors(value)
            if key in ("non_field_errors", "detail"):
                return message
            return f"'{key}': {message}"
    if isinstance(errors, list) and errors:
        return _flatten_serializer_errors(errors[0])
    return str(errors)


def _parse_import_options(raw, serializer_class):
    """Parse the ``options`` multipart field of ``POST /boards/import/`` (#119).

    The endpoint is multipart-only (it carries the file), so ``options``
    arrives as a JSON-encoded string, the same convention as the Trello
    importer's ``mapping`` field. Returns ``(options, error_detail)``: an
    absent or blank field yields every flag ``True`` — the pre-#119
    behavior — and any malformed value is a 400 rather than a silent default.
    """
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return {key: True for key in ImportOptionsSerializer.OPTION_KEYS}, None
    if not isinstance(raw, str):
        return None, "'options' must be a JSON object."
    try:
        data = json.loads(raw)
    except (ValueError, RecursionError):
        return None, "'options' is not valid JSON."
    if not isinstance(data, dict):
        return None, "'options' must be a JSON object."
    ser = serializer_class(data=data)
    if not ser.is_valid():
        return None, f"Invalid 'options': {_flatten_serializer_errors(ser.errors)}"
    return dict(ser.validated_data), None


def _list_len(value):
    return len(value) if isinstance(value, list) else 0


def _json_skip_counts(data, options):
    """What the chosen ``options`` leave out of a JSON import (#119).

    Counts only items the importer would otherwise have created, so a
    reference the importer drops anyway (a label name with no definition, an
    activity with an unknown event type) is not reported as skipped.
    """
    skipped = dict.fromkeys(_IMPORT_SKIP_KEYS, 0)
    cards = data.get("cards", [])
    cards_on = options["cards"]
    label_names = {
        lbl.get("name") for lbl in data.get("labels", [])
        if isinstance(lbl, dict) and isinstance(lbl.get("name"), str)
    }
    valid_event_types = {e[0] for e in CardActivity.EventType.choices}
    if not cards_on:
        skipped["cards"] = len(cards)
    for card in cards:
        if not cards_on or not options["labels"]:
            refs = card.get("labels", [])
            if isinstance(refs, list):
                skipped["label_refs"] += len(
                    {n for n in refs if isinstance(n, str) and n in label_names}
                )
        if not options["comments"]:
            skipped["comments"] += _list_len(card.get("comments", []))
        if not options["checklist"]:
            skipped["checklist_items"] += _list_len(card.get("checklist", []))
        if not options["history"]:
            skipped["movements"] += _list_len(card.get("movements", []))
            activities = card.get("activities", [])
            if isinstance(activities, list):
                skipped["activities"] += sum(
                    1 for act in activities
                    if isinstance(act, dict) and isinstance(act.get("event_type"), str)
                    and act["event_type"] in valid_event_types
                )
    return skipped


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


def _csv_custom_field_cell(definition, value):
    """One CSV cell for a custom field value, formula-sanitized.

    A ``multi_select`` value is stored as a JSON array string (#1391); a
    spreadsheet reader wants the entries, not JSON, so they are joined with
    ``"; "`` — the separator the Movement History column already uses. Each
    entry is sanitized and so is the joined cell, so no entry can smuggle a
    formula prefix to the start of the cell. Every other type is the stored
    string, sanitized as before. The JSON export keeps the stored string
    unchanged: that format is read by tools, and its values are strings.
    """
    if definition.field_type == CustomFieldDefinition.FieldType.MULTI_SELECT:
        value = "; ".join(
            _sanitize_csv_field(entry) for entry in parse_multi_select(value)
        )
    return _sanitize_csv_field(value)


class BoardImportExportMixin:
    """Mixin providing import and export @action methods for BoardViewSet."""

    @extend_schema(
        summary="Import a board from a Visiban JSON or CSV export",
        request={"multipart/form-data": {"type": "object", "properties": {
            "file": {"type": "string", "format": "binary",
                     "description": "A .json or .csv Visiban export. The format is chosen from the "
                                    "file extension, falling back to the upload's content type."},
            "name": {"type": "string", "description": "Board name; defaults to the name in the file."},
            "group_id": {"type": "integer", "description": "Place the imported board into this group."},
            "options": {"type": "string", "description": (
                "JSON object choosing what to import. Keys (all optional booleans, default true): "
                "labels, cards, comments, checklist, history. comments, checklist and history "
                "require cards. A CSV import accepts only labels and cards."
            )},
        }, "required": ["file"]}},
        responses={
            201: OpenApiResponse(OpenApiTypes.OBJECT, description=(
                "The new board (same shape as GET /boards/{id}/) plus an import_summary object."
            )),
            400: OpenApiTypes.OBJECT, 401: OpenApiTypes.OBJECT, 403: OpenApiTypes.OBJECT,
            404: OpenApiTypes.OBJECT, 429: OpenApiTypes.OBJECT,
        },
    )
    @action(detail=False, methods=["post"], url_path="import", parser_classes=[MultiPartParser],
            throttle_classes=[BoardImportThrottle])
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
            importer, options_serializer = self._import_json, ImportOptionsSerializer
        elif filename.endswith(".csv") or "csv" in content_type:
            importer, options_serializer = self._import_csv, CSVImportOptionsSerializer
        else:
            return Response(
                {"detail": "Unsupported file format. Upload a .json or .csv file."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # Validated before the file is read so a bad ``options`` field fails
        # fast and never reaches the transaction (#119).
        options, error = _parse_import_options(request.data.get("options"), options_serializer)
        if error:
            return Response({"detail": error}, status=status.HTTP_400_BAD_REQUEST)
        return importer(request, file, options)

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

    def _import_json(self, request, file, options):
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
            logger.warning("Board JSON import rejected — malformed payload: %s", exc)
            return Response({"detail": "The uploaded file is not valid JSON."}, status=status.HTTP_400_BAD_REQUEST)

        if not isinstance(data, dict):
            return Response({"detail": "Invalid JSON: expected an object at the top level."}, status=status.HTTP_400_BAD_REQUEST)

        # Reject malformed payloads where collection keys are present but not lists.
        # Without this guard a string or integer value triggers TypeError/AttributeError
        # downstream (e.g. iterating a string yields per-character "card" dicts that
        # then fail .get() with AttributeError) and may surface a stack trace to the
        # client in non-production error formatting (#921).
        for _key in ("cards", "columns", "swimlanes", "labels"):
            if _key in data and not isinstance(data[_key], list):
                return Response(
                    {"detail": f"Invalid JSON: '{_key}' must be a list."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

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
        from django.utils.dateparse import parse_datetime as _parse_dt, parse_date as _parse_date
        for _ci, _card in enumerate(data.get("cards", [])):
            for _field in ("archived_at",):
                _v = _card.get(_field)
                if _v and _parse_dt(str(_v)) is None:
                    return Response(
                        {"detail": f"Card at index {_ci}: invalid timestamp for '{_field}': {_v!r}"},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
            _due = _card.get("due_date")
            if _due and _parse_date(str(_due)) is None:
                return Response(
                    {"detail": f"Card at index {_ci}: invalid due_date: {_due!r}"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            _weight = _card.get("weight")
            if _weight is not None and (isinstance(_weight, bool) or not isinstance(_weight, int) or _weight < 0):
                return Response(
                    {"detail": f"Card at index {_ci}: weight must be a non-negative integer"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            _pos = _card.get("position")
            if _pos is not None and (isinstance(_pos, bool) or not isinstance(_pos, int) or _pos < 0):
                return Response(
                    {"detail": f"Card at index {_ci}: position must be a non-negative integer"},
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

        # Column numeric fields: wip_limit and weight_limit must be non-negative
        # integers when present; a non-integer would cause a DB type error inside
        # bulk_create with no clean 400 path.
        for _ci, _col in enumerate(data.get("columns", [])):
            for _fname, _fval in (("wip_limit", _col.get("wip_limit")), ("weight_limit", _col.get("weight_limit"))):
                if _fval is not None and (isinstance(_fval, bool) or not isinstance(_fval, int) or _fval < 0):
                    return Response(
                        {"detail": f"Column at index {_ci}: {_fname} must be a non-negative integer"},
                        status=status.HTTP_400_BAD_REQUEST,
                    )

        # Duplicate names in columns, swimlanes, and labels each carry a
        # (board, name) unique constraint; a duplicate would raise an IntegrityError
        # inside bulk_create with no clean 400 path.
        for _list_name, _items in (
            ("column", data.get("columns", [])),
            ("swimlane", data.get("swimlanes", [])),
            ("label", data.get("labels", [])),
        ):
            _names = [_i.get("name", "") for _i in _items]
            if len(_names) != len(set(_names)):
                _dupes = sorted({n for n in _names if _names.count(n) > 1})
                return Response(
                    {"detail": f"Duplicate {_list_name} names: {', '.join(_dupes)}"},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        # Cards reference columns and swimlanes by name.  A mismatch between a
        # card's column/swimlane and the top-level definitions is a structural error
        # in the file; silent skipping would produce a 201 with fewer cards than
        # the payload declared.
        _valid_col_names = {_c.get("name", "") for _c in data.get("columns", [])}
        _valid_sw_names = {_s.get("name", "") for _s in data.get("swimlanes", [])}
        for _ci, _card in enumerate(data.get("cards", [])):
            # isinstance guard must short-circuit before the set membership
            # test: an unhashable "column"/"swimlane" (list/dict) crashes
            # `in _valid_col_names` with an unhandled TypeError instead of
            # this clean 400 (#1185).
            _col_ref = _card.get("column")
            if not isinstance(_col_ref, str) or _col_ref not in _valid_col_names:
                return Response(
                    {"detail": f"Card at index {_ci} references undefined column: {_col_ref!r}"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            _sw_ref = _card.get("swimlane")
            if not isinstance(_sw_ref, str) or _sw_ref not in _valid_sw_names:
                return Response(
                    {"detail": f"Card at index {_ci} references undefined swimlane: {_sw_ref!r}"},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        board_name = request.data.get("name") or data["name"]
        group = self._resolve_import_group(request)
        skipped = _json_skip_counts(data, options)

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

            # Create labels — bulk_create avoids one INSERT per label. With the
            # ``labels`` option off, label_map stays empty, which also drops
            # every card label link and its LABEL_CHANGE activity below (#119).
            lbl_data = data.get("labels", []) if options["labels"] else []
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

            # ``cards`` off imports structure (and labels) only; everything
            # below hangs off a card, so it is skipped with it (#119).
            for card_data in (data.get("cards", []) if options["cards"] else []):
                column = column_map.get(card_data["column"])
                swimlane = swimlane_map.get(card_data["swimlane"])
                if not column or not swimlane:
                    continue

                priority = card_data.get("priority", "medium")
                # isinstance guard must short-circuit before the membership
                # test: an unhashable priority (list/dict) crashes `in
                # valid_priorities` with an unhandled TypeError instead of
                # falling back to the default like any other invalid value
                # (#1185).
                if not isinstance(priority, str) or priority not in valid_priorities:
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
            external_refs_to_create = []

            for card_obj, card_data in zip(cards_to_create, cards_raw):
                card_pk = card_obj.pk

                # MR/PR link (#352). Run through the same serializer the API
                # uses so an import file can never smuggle in a URL the API
                # would reject (e.g. a javascript: scheme rendered as a link on
                # the card face). An invalid or malformed entry is dropped
                # rather than failing the import — the same leniency the
                # importer applies to an unknown priority or event type.
                raw_ref = card_data.get("external_ref")
                if isinstance(raw_ref, dict):
                    ref_ser = ExternalRefSerializer(data=raw_ref)
                    if ref_ser.is_valid():
                        external_refs_to_create.append(
                            CardExternalRef(card_id=card_pk, **ref_ser.validated_data)
                        )

                # Weight-change activity for non-default weights. It is card
                # history the importer generates, so ``history`` gates it (#119).
                if options["history"] and card_obj.weight and card_obj.weight > 1:
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
                for comment_data in (card_data.get("comments", []) if options["comments"] else []):
                    comments_to_create.append((
                        CardComment(
                            card_id=card_pk,
                            author=request.user,
                            body=comment_data.get("body", ""),
                        ),
                        comment_data.get("created_at"),
                    ))

                # Checklist items + checklist-added activities
                checklist_source = card_data.get("checklist", []) if options["checklist"] else []
                for ci_idx, checklist_data in enumerate(checklist_source):
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

                # Movement history and imported activities are one option,
                # ``history`` (#119).
                history_on = options["history"]

                # Movement history
                for mv_data in (card_data.get("movements", []) if history_on else []):
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
                    # isinstance guard must short-circuit before the membership
                    # test: an unhashable movement_type (list/dict) crashes `in
                    # valid_movement_types` with an unhandled TypeError instead
                    # of falling back to the default like any other invalid
                    # value (#1185).
                    movement_type = (
                        raw_movement_type
                        if isinstance(raw_movement_type, str) and raw_movement_type in valid_movement_types
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
                for act_data in (card_data.get("activities", []) if history_on else []):
                    event_type = act_data.get("event_type", "")
                    # isinstance guard must short-circuit before the membership
                    # test: an unhashable event_type (list/dict) crashes `in
                    # valid_event_types` with an unhandled TypeError instead of
                    # being skipped like any other unknown event type (#1185).
                    if not isinstance(event_type, str) or event_type not in valid_event_types:
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

            if external_refs_to_create:
                CardExternalRef.objects.bulk_create(external_refs_to_create)

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
            # Register the broadcast inside the atomic block so a rollback does
            # not fire a phantom board.created event for a board that never
            # committed (#815).
            from django.db.models import Count, Exists, OuterRef, Q
            board = Board.objects.select_related("owner", "group").annotate(
                _member_count=Count("memberships", distinct=True),
                _card_count=Count("cards", filter=Q(cards__archived_at__isnull=True), distinct=True),
                _archived_card_count=Count("cards", filter=Q(cards__archived_at__isnull=False), distinct=True),
                _is_starred=Exists(BoardFavorite.objects.filter(board=OuterRef("pk"), user=request.user)),
            ).get(pk=board.pk)
            board_data = BoardSerializer(board, context={"request": request}).data
            board_id = board.pk
            group_id = board.group_id
            # ``import_options`` is additive on the event payload (#119) so a
            # feed consumer can tell a partial import from a full one.
            event_payload = {**board_data, "import_options": options}
            event_id = _broadcast.persist_board_event(
                board_id, _broadcast.EVT_BOARD_CREATED, event_payload, actor_id=request.user.id,
            )
            def _broadcast_created(bid=board_id, bd=event_payload, gid=group_id, eid=event_id):
                _broadcast.broadcast_board_event(bid, _broadcast.EVT_BOARD_CREATED, bd, event_id=eid)
                # Group-scoped broadcast powers the boards-list live view (#753).
                if gid is not None:
                    from groups.broadcast import broadcast_group_event
                    broadcast_group_event(gid, _broadcast.EVT_BOARD_CREATED, bd)
            transaction.on_commit(_broadcast_created)
        # The board body stays at the top level (unwrapped) so existing
        # clients keep working; ``import_summary`` is additive (#119).
        return Response(
            {**board_data, "import_summary": {"options_applied": options, "skipped": skipped}},
            status=status.HTTP_201_CREATED,
        )

    @extend_schema(
        summary="Import a Trello board export (preview or confirm)",
        parameters=[
            OpenApiParameter("dry_run", bool, description="Return a preview of the mapping; creates nothing."),
            OpenApiParameter("confirm", bool, description="Create the board. Exactly one of dry_run/confirm is required."),
        ],
        request={"multipart/form-data": {"type": "object", "properties": {
            "file": {"type": "string", "format": "binary"},
            "name": {"type": "string", "description": "Board name; defaults to the Trello board name."},
            "group_id": {"type": "integer"},
            "mapping": {"type": "string", "description": "JSON object of mapping options."},
            "file_sha256": {"type": "string", "description": "Optional guard: must match the previewed file."},
        }, "required": ["file"]}},
        responses={200: OpenApiTypes.OBJECT, 201: OpenApiTypes.OBJECT, 400: OpenApiTypes.OBJECT,
                   401: OpenApiTypes.OBJECT, 403: OpenApiTypes.OBJECT, 404: OpenApiTypes.OBJECT,
                   413: OpenApiTypes.OBJECT, 429: OpenApiTypes.OBJECT},
    )
    @action(detail=False, methods=["post"], url_path="import/trello", parser_classes=[MultiPartParser],
            throttle_classes=[TrelloImportThrottle])
    def import_trello(self, request):
        """Import a Trello JSON export into a new board (#456).

        Stateless two-step flow: ``?dry_run=true`` returns the preview, and
        ``?confirm=true`` re-uploads the same file plus the chosen ``mapping``
        and creates the board. Both modes run the same parse/plan code, so the
        preview is exactly what confirm will do. Synchronous by design until a
        task queue exists; the size cap, count caps, and throttle bound it.
        """
        dry_run = _query_flag(request, "dry_run")
        confirm = _query_flag(request, "confirm")
        if dry_run == confirm:
            return Response(
                {"detail": "Specify exactly one of ?dry_run=true or ?confirm=true."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        file = request.FILES.get("file")
        if not file:
            return Response({"detail": "No file provided."}, status=status.HTTP_400_BAD_REQUEST)

        max_size = django_settings.VISIBAN_IMPORT_MAX_SIZE
        too_large = Response(
            {"detail": f"File too large. The maximum size for a Trello import is {max_size // (1024 * 1024)} MB."},
            status=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
        )
        if file.size is not None and file.size > max_size:
            return too_large
        # Bounded read — never trust the reported size alone.
        raw = file.read(max_size + 1)
        if len(raw) > max_size:
            return too_large

        # Group authorization runs in BOTH modes so a preview cannot be used
        # to probe a group the caller could not import into.
        group = self._resolve_import_group(request)

        file_sha256 = hashlib.sha256(raw).hexdigest()
        expected_sha = request.data.get("file_sha256")
        if confirm and expected_sha and (not isinstance(expected_sha, str) or expected_sha != file_sha256):
            return Response(
                {"detail": "The uploaded file does not match the file that was previewed. Preview it again."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            export = _trello.parse_trello_export(raw)
            # Release the upload bytes before planning; the parsed export is
            # all that is needed from here and this request can be large.
            del raw
            options = _trello.parse_options(request.data.get("mapping"), export)
            matched = _trello.match_members(export, request.user, group)
            plan = _trello.build_plan(export, options, matched)
        except _trello.TrelloImportError as exc:
            return Response({"detail": exc.detail}, status=status.HTTP_400_BAD_REQUEST)

        preview = {**plan.preview, "file_sha256": file_sha256}
        if dry_run:
            return Response(preview, status=status.HTTP_200_OK)

        raw_name = request.data.get("name")
        if raw_name is not None and not isinstance(raw_name, str):
            return Response({"detail": "'name' must be a string."}, status=status.HTTP_400_BAD_REQUEST)
        board_name = (raw_name or "").replace("\x00", "").strip() or None
        try:
            with transaction.atomic():
                board = _trello.execute_plan(plan, request.user, group=group, board_name=board_name)
                board_data = self._broadcast_imported_board(request, board)
        except _trello.TrelloImportError as exc:
            return Response({"detail": exc.detail}, status=status.HTTP_400_BAD_REQUEST)

        summary = {k: preview[k] for k in ("counts", "result", "warnings", "unmappable")}
        return Response({"board": board_data, "summary": summary}, status=status.HTTP_201_CREATED)

    def _broadcast_imported_board(self, request, board):
        """Serialize the new board and schedule its ``board.created`` broadcast.

        Must run inside the import's atomic block: the event row is persisted
        in the same transaction (#1114) and the broadcast is deferred with
        ``on_commit`` so a rollback cannot announce a board that never
        existed (#815).
        """
        from django.db.models import Count, Exists, IntegerField, OuterRef, Subquery
        # Correlated subquery counts rather than Count() over two joined
        # relations: an import can create thousands of cards and (with the
        # member opt-in) many memberships, and joining both onto the board row
        # multiplies them (members × cards) inside the import transaction.
        def _count(qs):
            return Subquery(
                qs.filter(board=OuterRef("pk")).order_by().values("board").annotate(c=Count("pk")).values("c"),
                output_field=IntegerField(),
            )
        board = Board.objects.select_related("owner", "group").annotate(
            _member_count=_count(BoardMembershipModel.objects.all()),
            _card_count=_count(Card.objects.filter(archived_at__isnull=True)),
            _archived_card_count=_count(Card.objects.filter(archived_at__isnull=False)),
            _is_starred=Exists(BoardFavorite.objects.filter(board=OuterRef("pk"), user=request.user)),
        ).get(pk=board.pk)
        board_data = BoardSerializer(board, context={"request": request}).data
        board_id, group_id = board.pk, board.group_id
        event_id = _broadcast.persist_board_event(
            board_id, _broadcast.EVT_BOARD_CREATED, board_data, actor_id=request.user.id,
        )

        def _broadcast_created(bid=board_id, bd=board_data, gid=group_id, eid=event_id):
            _broadcast.broadcast_board_event(bid, _broadcast.EVT_BOARD_CREATED, bd, event_id=eid)
            if gid is not None:
                from groups.broadcast import broadcast_group_event
                broadcast_group_event(gid, _broadcast.EVT_BOARD_CREATED, bd)
        transaction.on_commit(_broadcast_created)
        return board_data

    def _import_csv(self, request, file, options):
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

        # Validate each row has required fields and a parseable Due Date when present.
        # The date check mirrors the JSON path's pre-transaction due_date guard: a
        # malformed value would reach DateField inside bulk_create and produce an
        # unhandled DB type error instead of a clean 400.
        from django.utils.dateparse import parse_date as _parse_date_csv
        for i, row in enumerate(rows):
            for field in ("Title", "Column", "Swimlane"):
                if not row.get(field, "").strip():
                    return Response(
                        {"detail": f"Row {i + 2} is missing required field: {field}"},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
            _due = row.get("Due Date", "").strip()
            if _due and _parse_date_csv(_due) is None:
                return Response(
                    {"detail": f"Row {i + 2}: invalid Due Date: {_due!r}"},
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

        # What the chosen options leave out (#119). A CSV row has no comments,
        # checklist, or history.
        skipped = dict.fromkeys(_IMPORT_SKIP_KEYS, 0)
        if not options["cards"]:
            skipped["cards"] = len(rows)
        if not options["cards"] or not options["labels"]:
            skipped["label_refs"] = sum(
                len({n.strip() for n in (row.get("Labels") or "").split(",") if n.strip()})
                for row in rows
            )

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

                labels_str = row.get("Labels", "").strip() if options["labels"] else ""
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
            # ``cards`` off imports structure (and labels) only (#119).
            for row in (rows if options["cards"] else []):
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

                # Assign labels — label_map is empty with ``labels`` off (#119).
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
            # Register the broadcast inside the atomic block so a rollback does
            # not fire a phantom board.created event for a board that never
            # committed (#815).
            from django.db.models import Count, Exists, OuterRef, Q
            board = Board.objects.select_related("owner", "group").annotate(
                _member_count=Count("memberships", distinct=True),
                _card_count=Count("cards", filter=Q(cards__archived_at__isnull=True), distinct=True),
                _archived_card_count=Count("cards", filter=Q(cards__archived_at__isnull=False), distinct=True),
                _is_starred=Exists(BoardFavorite.objects.filter(board=OuterRef("pk"), user=request.user)),
            ).get(pk=board.pk)
            board_data = BoardSerializer(board, context={"request": request}).data
            board_id = board.pk
            group_id = board.group_id
            # ``import_options`` is additive on the event payload (#119) so a
            # feed consumer can tell a partial import from a full one.
            event_payload = {**board_data, "import_options": options}
            event_id = _broadcast.persist_board_event(
                board_id, _broadcast.EVT_BOARD_CREATED, event_payload, actor_id=request.user.id,
            )
            def _broadcast_created(bid=board_id, bd=event_payload, gid=group_id, eid=event_id):
                _broadcast.broadcast_board_event(bid, _broadcast.EVT_BOARD_CREATED, bd, event_id=eid)
                # Group-scoped broadcast powers the boards-list live view (#753).
                if gid is not None:
                    from groups.broadcast import broadcast_group_event
                    broadcast_group_event(gid, _broadcast.EVT_BOARD_CREATED, bd)
            transaction.on_commit(_broadcast_created)
        # The board body stays at the top level (unwrapped) so existing
        # clients keep working; ``import_summary`` is additive (#119).
        return Response(
            {**board_data, "import_summary": {"options_applied": options, "skipped": skipped}},
            status=status.HTTP_201_CREATED,
        )

    @action(detail=True, methods=["get"], throttle_classes=[BoardExportThrottle])
    def export(self, request, pk=None):
        """Export board data as CSV or JSON. Requires member or admin access."""
        board, role = get_board_for_user(pk, request.user)
        # Viewers and collaborators can read every card/movement via the
        # paginated API, so denying them a bulk export of the same data is
        # inconsistent (#384). This policy was re-affirmed by the VoC panel
        # on 2026-04-21 (#800): PM and senior-engineer workflows rely on
        # self-serve export for stakeholder reports and incident retros.
        #
        # Bulk export is still a data-exfil vector, so the default ships
        # paired with two follow-up controls:
        #   * #806 — audit log for every export (user, role, format, rows)
        #   * #807 — per-board `export_min_role` setting (viewer default /
        #            admin opt-in) for regulated or sensitive boards
        if role not in (
            BoardMembershipModel.Role.VIEWER,
            BoardMembershipModel.Role.COLLABORATOR,
            BoardMembershipModel.Role.MEMBER,
            BoardMembershipModel.Role.ADMIN,
            SITE_ADMIN,
        ):
            return Response(
                {"detail": "Board export requires board membership."},
                status=status.HTTP_403_FORBIDDEN,
            )
        # #843: enforce the per-board export threshold on top of the base
        # membership gate. Owners and site admins bypass. The error body
        # includes a parseable ``code`` and ``min_role`` so the frontend can
        # render "Export is restricted to {label} and above" — the hidden-
        # button UX is the primary path, this covers direct-URL hits and
        # races between role changes and the broadcast.
        if not _can_export_at_min_role(board, request.user, role):
            return Response(
                {
                    "detail": "Export is restricted on this board.",
                    "code": "export_restricted",
                    "min_role": board.export_min_role or "viewer",
                },
                status=status.HTTP_403_FORBIDDEN,
            )
        export_format = request.query_params.get("format", "csv")
        today = datetime.date.today().isoformat()
        safe_name = slugify(board.name) or "board"

        cards = list(
            Card.objects.filter(board=board)
            .select_related("column", "swimlane", "assignee", "created_by", "external_ref")
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
                # Custom field values (#371) — one query for the whole export,
                # with the definition joined so neither branch below resolves a
                # per-card FK.
                "custom_field_values__field_definition",
                # Row field values (#1140). The CSV branch denormalizes these
                # onto every card row, so without this prefetch it would issue
                # two queries per *card* to walk card.swimlane.custom_field_values
                # — the export's worst N+1, on its largest loop.
                "swimlane__custom_field_values__field_definition",
            )
            .order_by("position")
        )
        # Row count for the audit log (#842). ``cards`` is materialized once
        # here so both the JSON and CSV branches share the count without
        # double-iterating the queryset.
        row_count = len(cards)

        # Custom field definitions for this board, in display order (#371).
        # Materialized once: the CSV branch needs one column per definition and
        # the JSON branch exports the schema alongside the values, and both
        # must agree on the order.
        custom_field_definitions = list(
            board.custom_field_definitions.order_by("position", "id")
        )

        # Swimlane (row) field definitions (#1140), same contract as above.
        # Role-gated: an is_admin_only definition and its values are withheld
        # from a non-admin exporter, the same rule the JSON branch already
        # applies to swimlane contact_email/notes below. Filtering the
        # *definitions* rather than the values keeps the export clean — a
        # withheld field produces no column of blanks and no orphaned schema
        # entry — rather than blanking cells under a header.
        #
        # Deliberately NOT a claim that the field's existence is secret: a
        # definition's name and its is_admin_only flag reach every board role
        # through /full/ and through GET swimlane-custom-fields/, because a
        # reader needs the schema to render the values they *can* see. Only
        # the values are gated. If the schema is ever reclassified as
        # sensitive, this filter is not the place that would change — the
        # serializer and the viewset queryset are.
        _export_is_admin = role in (BoardMembershipModel.Role.ADMIN, SITE_ADMIN)
        swimlane_field_definitions = [
            definition
            for definition in board.swimlane_custom_field_definitions.order_by(
                "position", "id"
            )
            if _export_is_admin or not definition.is_admin_only
        ]

        # Hoisted out of the helper below: the CSV branch calls it once per
        # *card*, and rebuilding a set of at most 15 ids 500 times is work for
        # nothing.
        _visible_swimlane_field_ids = {
            definition.pk for definition in swimlane_field_definitions
        }

        def _swimlane_values_by_name(swimlane):
            """Return ``{field name: value}`` for one swimlane.

            Keyed by name for the same reason as the card helper below, and
            filtered to the definitions the exporter may see.
            """
            visible = _visible_swimlane_field_ids
            # _swimlane_custom_field_values() reads the to_attr list the
            # Prefetch below parks the rows on (#1223); .all() would miss it
            # and issue one query per swimlane once that Prefetch is applied.
            return {
                row.field_definition.name: row.value
                for row in _swimlane_custom_field_values(swimlane)
                if row.field_definition_id in visible
            }

        def _custom_values_by_name(card):
            """Return ``{field name: value}`` for one card.

            Keyed by name rather than id because an export is read by people and
            by other tools, neither of which has this instance's PKs. Names are
            unique per board (``unique_together``), so the mapping is lossless.
            """
            return {
                row.field_definition.name: row.value
                for row in card.custom_field_values.all()
            }

        if export_format == "json":
            # Prefetch columns and swimlanes onto the export-bound board in a
            # single trip so ``.all()`` reads from the prefetch cache instead
            # of issuing one ORDER BY query each (#994).  ``Meta.ordering``
            # on both models guarantees position order without an explicit
            # ``.order_by()`` (which would defeat the prefetch).  Done at the
            # call site because export calls ``get_board_for_user(pk, user)``
            # without ``with_archived_card_count=True``, so it does not get
            # that helper's /full/-scoped ``columns`` prefetch (#1351) and
            # still needs its own; other non-export consumers (cards list)
            # do not pay for prefetches they never read.
            from django.db.models import prefetch_related_objects
            from ..serializers import _swimlane_custom_field_prefetch
            prefetch_related_objects(
                [board],
                "columns",
                # The swimlane prefetch carries its row field values (#1140) so
                # the per-swimlane block below reads from cache rather than
                # issuing two queries per row.
                Prefetch(
                    "swimlanes",
                    queryset=Swimlane.objects.prefetch_related(
                        _swimlane_custom_field_prefetch()
                    ),
                ),
            )
            columns = board.columns.all()
            swimlanes = board.swimlanes.all()
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
                    # #371. Additive, so schema_version stays at 2: the importer
                    # ignores unrecognized keys, and re-importing custom field
                    # data is a tracked follow-up rather than part of this phase.
                    "custom_field_values": _custom_values_by_name(card),
                    # #352. Additive like custom_field_values above; unlike
                    # them it *is* restored on import (validated through
                    # ExternalRefSerializer). null when the card has no link.
                    "external_ref": _external_ref_export(card),
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
                        # Row field values (#1140), keyed by name and already
                        # filtered to what this exporter's role may see.
                        "custom_field_values": _swimlane_values_by_name(sw),
                    }
                    for sw in swimlanes
                ],
                "labels": [
                    {"name": lb.name, "color": lb.color}
                    for lb in labels
                ],
                # The custom field schema (#371), so a consumer can type the
                # values above rather than guessing from their text form.
                "custom_fields": [
                    {
                        "name": cf.name,
                        "field_type": cf.field_type,
                        "choices": cf.choices_json,
                        "position": cf.position,
                        "show_on_card": cf.show_on_card,
                        "is_required": cf.is_required,
                        "help_text": cf.help_text,
                        # Display-only number formatting (#1391). Additive
                        # keys; the values in "cards" stay the raw number
                        # string, so a consumer applies these or ignores them.
                        "number_prefix": cf.number_prefix,
                        "number_suffix": cf.number_suffix,
                        "number_decimals": cf.number_decimals,
                        # Per-choice display colors (#1391): additive
                        # {choice: palette_key} map; "choices" stays the
                        # plain string list and values are unchanged.
                        "choice_colors": cf.choice_colors,
                    }
                    for cf in custom_field_definitions
                ],
                # The swimlane (row) field schema (#1140), so a consumer can
                # type the per-swimlane values above. Additive alongside
                # "custom_fields" rather than merged into it: the two are
                # separate per-board sets attached to different objects, and
                # merging them would make a round-trip ambiguous about which
                # set a definition belongs to. schema_version is unchanged —
                # this is a new key, and no existing key moved or changed
                # meaning.
                "swimlane_custom_fields": [
                    {
                        "name": sf.name,
                        "field_type": sf.field_type,
                        "choices": sf.choices_json,
                        "position": sf.position,
                        "show_on_row": sf.show_on_row,
                        "is_admin_only": sf.is_admin_only,
                        "is_required": sf.is_required,
                        "help_text": sf.help_text,
                        # Display-only number formatting (#1391); see above.
                        "number_prefix": sf.number_prefix,
                        "number_suffix": sf.number_suffix,
                        "number_decimals": sf.number_decimals,
                        # Per-choice display colors (#1391); see above.
                        "choice_colors": sf.choice_colors,
                    }
                    for sf in swimlane_field_definitions
                ],
                "cards": cards_data,
            }

            content = json.dumps(payload, indent=2, ensure_ascii=False)
            response = HttpResponse(content, content_type="application/json")
            response["Content-Disposition"] = f'attachment; filename="{safe_name}-{today}.json"'
            response["Cache-Control"] = "no-store"
            # #842: audit-log the successful export after the response body is
            # assembled. Not wrapped in a transaction — a failure during the
            # network send should still leave the audit row in place because
            # the data was read from the DB. Failed/denied exports are
            # deliberately not logged; the permission gate returns earlier.
            BoardExportLog.objects.create(
                board=board,
                actor=request.user,
                role_at_export=_role_at_export(board, request.user, role),
                export_format="json",
                row_count=row_count,
            )
            return response

        # Default: CSV export
        buf = io.StringIO()
        writer = csv.writer(buf)
        # Custom field columns are appended after the fixed set (#371), so every
        # existing column keeps its position and a consumer reading by index
        # still works. The `Custom: ` prefix keeps a field named "Title" or
        # "Weight" from producing a duplicate header that the importer's
        # header map would then mis-bind.
        custom_field_headers = [f"Custom: {cf.name}" for cf in custom_field_definitions]
        # Row field columns (#1140) come after the card field columns, so both
        # the fixed set and the existing `Custom: ` block keep their indices.
        # A distinct `Swimlane Custom: ` prefix is required, not cosmetic: the
        # `Custom: ` namespace is already card fields', and a board may legally
        # define a card field and a row field with the same name — they are
        # separate per-board sets with separate uniqueness. Sharing the prefix
        # would produce two identical headers and an importer header map that
        # silently binds one onto the other.
        # Sanitized like every value cell. Today the literal prefix already
        # guarantees the cell cannot start with a formula character, so this is
        # a no-op — which is exactly why it is worth writing explicitly: the
        # safety currently rests on the prefix string, and a future export
        # variant that shortens or drops that prefix would silently reintroduce
        # formula injection through a user-controlled field name.
        swimlane_field_headers = [
            _sanitize_csv_field(f"Swimlane Custom: {sf.name}")
            for sf in swimlane_field_definitions
        ]
        writer.writerow([
            "Card ID", "Title", "Description", "Column", "Swimlane",
            "Priority", "Assignee", "Labels", "Due Date", "Weight",
            "Created At", "Created By", "Last Moved At", "Movement Count",
            "Movement History",
            *custom_field_headers,
            *swimlane_field_headers,
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
            # Sanitized like every other user-controlled string in this export:
            # a value beginning with = + - @ is a formula to a spreadsheet.
            card_custom = _custom_values_by_name(card)
            custom_cells = [
                _csv_custom_field_cell(cf, card_custom.get(cf.name, ""))
                for cf in custom_field_definitions
            ]
            # Row field values denormalize onto every card row (#1140): the CSV
            # is one row per card, so a row field's value repeats for each card
            # in that swimlane. That is what makes the column usable in a pivot
            # without a second file to join against.
            swimlane_custom = _swimlane_values_by_name(card.swimlane)
            swimlane_cells = [
                _csv_custom_field_cell(sf, swimlane_custom.get(sf.name, ""))
                for sf in swimlane_field_definitions
            ]

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
                *custom_cells,
                *swimlane_cells,
            ])

        response = HttpResponse(buf.getvalue(), content_type="text/csv")
        response["Content-Disposition"] = f'attachment; filename="{safe_name}-{today}.csv"'
        response["Cache-Control"] = "no-store"
        # #842: audit-log the successful export (see note in JSON branch).
        BoardExportLog.objects.create(
            board=board,
            actor=request.user,
            role_at_export=_role_at_export(board, request.user, role),
            export_format="csv",
            row_count=row_count,
        )
        return response

    @extend_schema(
        summary="Board export history",
        description="Admin only. Recent export audit log entries for this board, newest first.",
        # Without this, drf-spectacular falls back to the viewset's default
        # `serializer_class` (BoardSerializer) for the response, which does not
        # match what this action actually returns and fails schema-conformance
        # checks (#1166). `many=True` plus the view's configured paginator is
        # what tells drf-spectacular to wrap it in the {count, offset, page_size,
        # results} envelope `get_paginated_response()` produces.
        responses=BoardExportLogSerializer(many=True),
    )
    @action(detail=True, methods=["get"], url_path="export-history")
    def export_history(self, request, pk=None):
        """Return recent ``BoardExportLog`` rows for this board (#842).

        Admin+ only — viewers and collaborators do not see audit data. Paginated
        using the viewset's configured paginator so boards with heavy export
        traffic don't blow the response size.
        """
        board, role = get_board_for_user(pk, request.user)
        if role not in (BoardMembershipModel.Role.ADMIN, SITE_ADMIN):
            return Response(
                {"detail": "Export history is restricted to board admins."},
                status=status.HTTP_403_FORBIDDEN,
            )
        qs = (
            BoardExportLog.objects.filter(board=board)
            .select_related("actor")
            .order_by("-created_at")
        )
        page = self.paginate_queryset(qs)
        if page is not None:
            data = BoardExportLogSerializer(page, many=True, context={"request": request}).data
            return self.get_paginated_response(data)
        data = BoardExportLogSerializer(qs, many=True, context={"request": request}).data
        return Response(data)
