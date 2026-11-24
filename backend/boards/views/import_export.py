"""BoardViewSet mixin for CSV/JSON import and export actions."""

import collections
import contextlib
import csv
import datetime
import decimal
import functools
import hashlib
import io
import json
import logging
import math
import os
import re
import reprlib
import traceback
import zoneinfo

from django.conf import settings as django_settings
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import DataError, IntegrityError, transaction
from django.db.models import Prefetch
from django.http import HttpResponse
from django.utils import timezone as django_timezone
from django.utils.text import slugify
from rest_framework import serializers as drf_serializers
from rest_framework import status
from rest_framework.decorators import action
from rest_framework.exceptions import ErrorDetail, ParseError
from rest_framework.renderers import JSONRenderer
from rest_framework.response import Response
from rest_framework.settings import api_settings
from rest_framework.throttling import UserRateThrottle
from drf_spectacular.utils import extend_schema, inline_serializer, OpenApiParameter, OpenApiResponse, OpenApiTypes
from visiban.colors import normalize_hex_color
from visiban.parsers import LimitedMultiPartParser


from ..models import (
    Board, BoardExportLog, BoardFavorite, BoardMembership as BoardMembershipModel, Card,
    CardActivity, CardBlock, CardChecklist, CardComment, CardExternalRef, CardGateTransition,
    CardMovement, CardRelation, Column, CustomFieldDefinition, CustomFieldSet, CustomFieldValue, Label, StageTrack,
    SubColumn,
    Swimlane, SwimlaneCustomFieldDefinition, SwimlaneCustomFieldValue, SwimlaneTrackException,
)
from .. import broadcast as _broadcast
from ..column_policy import PolicyError, normalize_policy
from ..custom_field_types import parse_multi_select
from ..services.date_shift import shift_board_dates
from ..permissions import SITE_ADMIN
from ..serializers import (
    BoardExportLogSerializer, BoardSerializer, CSVImportOptionsSerializer,
    CustomFieldDefinitionSerializer, ExternalRefSerializer, ImportDateAnchorSerializer, ImportOptionsSerializer,
    shift_today,
    SwimlaneCustomFieldDefinitionSerializer, _normalize_custom_field_value,
    _run_custom_field_validator_hooks, _swimlane_custom_field_values,
)
from ..services import lane_field_tiers
from ..services import trello_import as _trello
from ..import_errors import ImportErrorCode, fallback_code
from ..import_schemas import (
    BoardImportResponseSerializer, ImportErrorSerializer, TrelloImportConfirmSerializer,
    TrelloImportPreviewSerializer,
)
from ._helpers import annotate_board_counts, get_accessible_boards_queryset, get_board_for_user

# #843: rank of each BoardMembership.Role for the export-threshold comparison.
# Owner and site_admin are not ranked here — they always bypass the threshold
# in ``_can_export_at_min_role`` below.
_EXPORT_ROLE_RANK = {
    BoardMembershipModel.Role.VIEWER: 0,
    BoardMembershipModel.Role.COLLABORATOR: 1,
    BoardMembershipModel.Role.MEMBER: 2,
    BoardMembershipModel.Role.ADMIN: 3,
}


def _export_timestamp(user):
    """Return ``YYYYMMDD-HHMM`` for an export filename (#2440).

    Uses the exporting user's profile timezone so the stamp matches their wall
    clock. ``User.timezone`` is free-form text, so a blank or unknown value
    falls back to UTC instead of failing the download. The date and time come
    from one aware ``now`` so they cannot straddle midnight. No colon: browsers
    and Windows mangle it in filenames.
    """
    try:
        tz = zoneinfo.ZoneInfo(getattr(user, "timezone", "") or "UTC")
    except (zoneinfo.ZoneInfoNotFoundError, ValueError, OSError):
        tz = datetime.timezone.utc
    return django_timezone.now().astimezone(tz).strftime("%Y%m%d-%H%M")


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


def _effective_export_min_role(board):
    """The threshold the export gate applies for ``board`` (#843, #1725).

    A blank value means the default (``viewer``). A stored value outside the
    ``Board.ExportMinRole`` set (``choices`` is not enforced on save) is
    treated as ``admin``, so a typo narrows export access rather than
    widening it. API, import and admin writes are validated; only a direct
    ORM or shell write can store one.
    """
    threshold = board.export_min_role or "viewer"
    if threshold not in _EXPORT_ROLE_RANK:
        return "admin"
    return threshold


def _can_export_at_min_role(board, user, role):
    """True iff the user's role meets ``board.export_min_role`` (#843).

    Owner and site_admin always bypass the threshold — they are always
    considered above any board-level role. An unrecognized stored threshold
    is treated as admin-only (see ``_effective_export_min_role``).
    """
    if role == SITE_ADMIN or board.owner_id == user.id:
        return True
    actor_rank = _EXPORT_ROLE_RANK.get(role)
    threshold_rank = _EXPORT_ROLE_RANK[_effective_export_min_role(board)]
    if actor_rank is None:
        return False
    return actor_rank >= threshold_rank

logger = logging.getLogger(__name__)


class CsvExportRenderer(JSONRenderer):
    """Lets ``?format=csv`` pass DRF's ``URL_FORMAT_OVERRIDE`` negotiation.

    DRF 404s any ``?format=`` value no renderer claims, so ``format=csv`` failed
    even though CSV is the export's default (#1790). The export view builds its
    own CSV ``HttpResponse`` and never reaches a renderer, so this class only
    exists to claim ``csv``. It stays a JSON renderer (``application/json``) so
    DRF-built errors (401/403/404/429) under ``format=csv`` are byte-identical
    to ``format=json`` and match the OpenAPI schema. It is appended after the
    defaults so ``json``, ``api`` and an omitted ``format`` negotiate as before.
    """

    format = "csv"


class BoardImportThrottle(UserRateThrottle):
    """Limit authenticated users to 10 board imports per hour.

    Each import can create a board with up to 500 cards. Without a cap,
    a single authenticated account could fill the database with arbitrary
    content through rapid repeated imports.
    """

    scope = "board_import"


def _query_flag(request, name):
    return str(request.query_params.get(name, "")).lower() in ("true", "1")


_IMPORTED_NAME_PREFIX = "Imported: "
_IMPORTED_NAME_FALLBACK = "Board"
# Longest numeric suffix reserved when truncating; " - 999999999" is 12 chars,
# far beyond any realistic duplicate count.
_IMPORTED_NAME_MAX_SUFFIX = 12
_CONTROL_CHARS_RE = re.compile(r"[\x01-\x1f\x7f]+")
_LONE_SURROGATE_RE = re.compile("[\ud800-\udfff]")


def _cell(row, name):
    """Return a stripped CSV cell, treating a missing cell as empty.

    ``csv.DictReader`` fills the trailing cells of a row shorter than the
    header with ``None`` (not an absent key), so ``row.get(name, "")`` returns
    ``None`` and ``.strip()`` raises (#1496).
    """
    return (row.get(name) or "").strip()


def _imported_board_name(source_name, user, group):
    """Return the default name for a board created by the JSON or CSV importer.

    Both importers call this one helper so their naming cannot drift apart
    again (#1446: JSON used the file's name verbatim, CSV a fixed
    "Imported Board"). The result is ``Imported: <source_name>``; when a board
    with that name already exists in the same scope, the lowest unused
    ``" - N"`` suffix (N >= 1) is appended, so gaps left by deleted or renamed
    boards are filled first.

    The duplicate scope is where the new board lands and would visibly
    collide: the target group's boards, or — for an import with no group —
    every ungrouped board the caller can access (owned or shared with them),
    which is exactly the Dashboard's "My Boards" list. Board has no archived
    or soft-deleted state, so every board in the scope counts.

    There is no unique constraint on ``Board.name``: two concurrent imports
    can pick the same suffix. That is acceptable — a duplicate name is
    cosmetic and the user can rename either board.

    ``source_name`` is the board name from a JSON file or the uploaded CSV
    filename stem; NUL bytes are removed, other control characters (newline,
    tab, ...) become a space, surrounding whitespace is stripped, and an
    empty or non-string value falls back to ``"Board"``. The base is
    truncated so the prefix and any suffix fit ``Board.name``'s max_length.
    """
    # A lone UTF-16 surrogate (valid JSON) cannot be bound to the duplicate
    # lookup below; PostgreSQL answered a 500 (#2085). Replaced, not refused,
    # like the NUL and control characters beside it.
    stem = (
        _CONTROL_CHARS_RE.sub(" ", _LONE_SURROGATE_RE.sub("\ufffd", source_name.replace("\x00", ""))).strip()
        if isinstance(source_name, str) else ""
    )
    stem = stem or _IMPORTED_NAME_FALLBACK
    max_length = Board._meta.get_field("name").max_length
    base = (_IMPORTED_NAME_PREFIX + stem)[:max_length]

    if group is not None:
        scope = Board.objects.filter(group=group)
    else:
        scope = get_accessible_boards_queryset(user).filter(group__isnull=True)
    # Every candidate starts with this shared head, so one query fetches all
    # names that could collide; the exact comparison happens in Python
    # (SQLite's LIKE is case-insensitive, so the query may over-fetch).
    head = base[: max_length - _IMPORTED_NAME_MAX_SUFFIX]
    taken = set(scope.filter(name__startswith=head).values_list("name", flat=True))
    if base not in taken:
        return base
    n = 1
    while True:
        suffix = f" - {n}"
        candidate = base[: max_length - len(suffix)] + suffix
        if candidate not in taken:
            return candidate
        n += 1


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

def _movement_export_entry(mv):
    """One movement in a JSON export. A name falls back to the ``*_name``
    snapshot when the column or swimlane is gone (#1796, #2052): a movement
    outlives its column, and a null name would leave a re-import unable to
    attribute the visit. The key stays null only when there is no snapshot
    either (e.g. a creation movement's absent source), so the schema is
    unchanged; only previously-null names are filled in."""
    def name(fk, snapshot):
        if fk is not None:
            return fk.name
        return snapshot or None

    return {
        "from_column": name(mv.from_column, mv.from_column_name),
        "to_column": name(mv.to_column, mv.to_column_name),
        "from_swimlane": name(mv.from_swimlane, mv.from_swimlane_name),
        "to_swimlane": name(mv.to_swimlane, mv.to_swimlane_name),
        "moved_by": mv.moved_by.username if mv.moved_by else None,
        "moved_at": mv.moved_at.isoformat(),
        "notes": mv.notes,
        "movement_type": mv.movement_type,
        # Additive (#1675); null unless the row was imported.
        "imported_from_username": mv.imported_from_username,
        # Additive (#1102): gate snapshot of the move.
        "from_gates_passed": mv.from_gates_passed,
        "from_gates_open": mv.from_gates_open,
        "to_gates_passed": mv.to_gates_passed,
    }


def _activity_export_entry(act):
    """One activity in a JSON export."""
    return {
        "event_type": act.event_type,
        "from_value": act.from_value,
        "to_value": act.to_value,
        "actor": act.actor.username if act.actor else None,
        "created_at": act.created_at.isoformat(),
        "imported_from_username": act.imported_from_username,
        # Additive (#2199): null except on checklist
        # assignee and due-date entries.
        "item_text": act.item_text,
    }


def _block_export_entry(blk):
    """One manual block (#1149) in a JSON export, live card or deleted (#2413)."""
    return {
        "blocked_at": blk.blocked_at.isoformat(),
        "blocked_by": blk.blocked_by.username if blk.blocked_by else None,
        "reason": blk.reason,
        "unblocked_at": blk.unblocked_at.isoformat() if blk.unblocked_at else None,
        "unblocked_by": blk.unblocked_by.username if blk.unblocked_by else None,
        "resolution": blk.resolution,
        "column": blk.column_name,
        "imported_from_username": blk.imported_from_username,
    }


def _gate_transition_export_entry(gt, movement_index):
    """One gate transition (#1102) in a JSON export, live card or deleted (#2413).

    ``movement_index`` maps a movement pk to its position in the same card's
    (or deleted-card entry's) exported ``movements`` list.
    """
    return {
        "kind": gt.kind,
        "from_index": gt.from_index,
        "to_index": gt.to_index,
        "column": gt.column_name,
        "sub_column": gt.sub_column_name,
        "reason": gt.reason,
        "cause": gt.cause,
        "actor": gt.actor.username if gt.actor else None,
        "created_at": gt.created_at.isoformat(),
        "imported_from_username": gt.imported_from_username,
        # Index into this card's ``movements`` (#1102).
        "movement_index": movement_index.get(gt.movement_id),
    }


def _deleted_card_history_export(board, exported_uids=frozenset()):
    """The board's retained history of hard-deleted cards, for the JSON export (#1796).

    Since #1469 (movements) and #1799 (activities), a hard-deleted card's rows
    stay on its board with ``card`` NULL and the card's uid and title kept as a
    snapshot; its ``CardBlock`` and ``CardGateTransition`` rows do the same
    (#2413). One entry per deleted card, by uid, ordered by its first row:
    ``{"card_uid", "card_title", "movements", "activities", "blocks",
    "gate_transitions"}``, each list shaped exactly like a card's own and
    oldest first. A gate transition's ``movement_index`` points into the same
    entry's ``movements``. ``card_title`` is the newest snapshot among the
    card's rows. Read by the rows' own ``board``, as Board History reads them:
    four queries whatever the size (each served by a ``(board, ...)`` index),
    no per-card query.

    Not in the CSV export: a CSV row is a card, and the CSV importer creates a
    card from every row, so a deleted card there would come back to life
    (whether the CSV should carry it in another form: #2414).

    ``exported_uids`` are the uids of the cards the export already carries as
    live cards. This is read after the cards, so a card deleted while the
    export ran can be in both; its entry is left out here so the file names
    each card once (an import would otherwise restore it twice, live and
    deleted).
    """
    movements = (
        CardMovement.objects.filter(board=board, card__isnull=True)
        .select_related("from_column", "to_column", "from_swimlane", "to_swimlane", "moved_by")
        .order_by("moved_at", "id")
    )
    activities = (
        CardActivity.objects.filter(board=board, card__isnull=True)
        .select_related("actor")
        .order_by("created_at", "id")
    )
    blocks = (
        CardBlock.objects.filter(board=board, card__isnull=True)
        .select_related("blocked_by", "unblocked_by")
        .order_by("blocked_at", "id")
    )
    gate_transitions = (
        CardGateTransition.objects.filter(board=board, card__isnull=True)
        .select_related("actor")
        .order_by("created_at", "id")
    )
    entries = {}
    newest = {}
    first = {}
    # Movement pk -> its index in its entry's ``movements`` (for
    # movement_index), and the deleted card it belongs to.
    movement_index = {}
    movement_card = {}

    def entry_for(row, at):
        entry = entries.get(row.card_uid)
        if entry is None:
            entry = entries[row.card_uid] = {
                "card_uid": row.card_uid, "card_title": row.card_title,
                "movements": [], "activities": [], "blocks": [], "gate_transitions": [],
            }
        if row.card_uid not in newest or at >= newest[row.card_uid]:
            newest[row.card_uid] = at
            entry["card_title"] = row.card_title
        if row.card_uid not in first or at < first[row.card_uid]:
            first[row.card_uid] = at
        return entry

    for mv in movements:
        entry = entry_for(mv, mv.moved_at)
        movement_index[mv.pk] = len(entry["movements"])
        movement_card[mv.pk] = mv.card_uid
        entry["movements"].append(_movement_export_entry(mv))
    for act in activities:
        entry_for(act, act.created_at)["activities"].append(_activity_export_entry(act))
    for blk in blocks:
        entry_for(blk, blk.blocked_at)["blocks"].append(_block_export_entry(blk))
    for gt in gate_transitions:
        entry = entry_for(gt, gt.created_at)
        # Only a movement of the same deleted card resolves to an index: the
        # index points into this entry's list.
        index = movement_index if movement_card.get(gt.movement_id) == gt.card_uid else {}
        entry["gate_transitions"].append(_gate_transition_export_entry(gt, index))
    # By each entry's first row of any kind. Timestamps compare as datetimes;
    # the old isoformat-string sort gave the same order (every value is UTC
    # with the same offset).
    return sorted(
        (e for e in entries.values() if e["card_uid"] not in exported_uids),
        key=lambda e: first[e["card_uid"]],
    )


# Cards per chunk of the board export (#1962). Each chunk is one card query
# plus one query per prefetch; a board of fewer than this many cards exports in
# the same queries as before chunking (see _iter_export_cards). A full first
# page, exactly this many cards, takes the id-list path and adds one query.
_EXPORT_CHUNK_SIZE = 500


def _iter_export_cards(queryset):
    """Yield the export's cards in ``(position, id)`` order, one chunk at a time (#1962).

    The first chunk is a plain ``LIMIT`` page. A board of fewer than
    ``_EXPORT_CHUNK_SIZE`` cards is wholly in a not-full page, so it exports in one card
    query, a single read, as before chunking. A first page that is full
    (``_EXPORT_CHUNK_SIZE`` cards) cannot show the board has no more, so the
    board then reads the whole ordered list of card ids once (integers only, one sort) and emits
    the cards in that list's order, a window of ``_EXPORT_CHUNK_SIZE`` ids at
    a time: first-page cards come from the page already read, the rest are
    fetched by primary key, so the database sorts the board twice in all
    rather than once per chunk (Card has no ``(board, position, id)`` index a
    keyset page could range-scan). Each fetch's ``prefetch_related`` runs for
    that window only, so at most two chunks of cards (the first page and one
    window) are held at a time.

    Why the id list, read before anything is yielded, decides membership and
    order: the export holds no snapshot across its queries, and cards move
    while it runs. Resuming from a ``position`` cursor after the first page
    emitted a first-page card twice when it moved past the cursor, and
    skipped a not-yet-read card that moved below it (an import of the first
    file creates a duplicate card). Every card is emitted once, at its place
    in the id list: a first-page card gone from the list (deleted meanwhile)
    is dropped, one created meanwhile is included, and a card deleted after
    the list was read is skipped when its window is fetched. The
    ``relations`` indexes are built from the cards as they are emitted, so
    they always point at the right entry. A first-page card that moved keeps
    the field values of the first read.

    Not ``QuerySet.iterator()``: that opens a server-side cursor on
    PostgreSQL, which breaks behind transaction-mode PgBouncer (the pooling
    docs/architecture/scaling.md recommends) unless
    ``DISABLE_SERVER_SIDE_CURSORS`` is set. ``id`` breaks position ties
    (positions repeat across columns), which makes the order, and so the
    ``relations`` indexes, reproducible.
    """
    size = _EXPORT_CHUNK_SIZE
    ordered = queryset.order_by("position", "id")
    first_page = list(ordered[:size])
    if len(first_page) < size:
        yield from first_page
        return
    held = {card.pk: card for card in first_page}
    del first_page
    ids = list(ordered.select_related(None).prefetch_related(None).values_list("pk", flat=True))
    for start in range(0, len(ids), size):
        window = ids[start:start + size]
        missing = [pk for pk in window if pk not in held]
        by_pk = {card.pk: card for card in queryset.filter(pk__in=missing)} if missing else {}
        for pk in window:
            card = held.pop(pk, None) or by_pk.get(pk)
            if card is not None:
                yield card


def _relations_export(board, card_index):
    """The board's card relations (#1448) as ``{from, kind, to}``, for the JSON export.

    ``from`` and ``to`` are indexes into the export's ``cards`` list. A live
    card has no other key in the file: it carries no id or uid, and a title
    (even with its swimlane) is not unique. The index is also how the file
    already cross-references (a gate transition's ``movement_index``), and the
    importer creates the cards in file order, so an index names the same card
    on both sides. Stored direction is kept: ``blocks`` reads "from blocks
    to", and ``relates_to`` (symmetric) is stored lower card id first. One
    query; a relation with an end outside the export is left out.
    """
    rows = (
        CardRelation.objects.filter(from_card__board=board)
        .order_by("id")
        .values_list("from_card_id", "relation_type", "to_card_id")
    )
    return [
        {"from": card_index[src], "kind": kind, "to": card_index[dst]}
        for src, kind, dst in rows
        if src in card_index and dst in card_index
    ]


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
    # Not an option skip: colors replaced with the default because they were
    # not hex (#2093). Kept here so every import reports the same shape.
    "colors",
    # Not an option skip either (#2198): card and checklist item assignee names
    # that matched no user in the importer's visible pool (Rule 5), so the card
    # or item imported unassigned. Counts references, not distinct names.
    "assignees",
    # Additive (#2413): block and gate history, live and deleted cards, left
    # out with ``history`` off.
    "blocks", "gate_transitions",
    # Additive (#1448): card relations left out with ``cards`` off.
    "relations",
)


def _limit_error(message):
    """An error detail for a count cap, tagged ``limit_exceeded`` (#1903).

    Helpers return their error as a string that the view wraps in
    ``{"detail": ...}``; an ``ErrorDetail`` is still a string, and its
    ``code`` is what ``BoardImportExportMixin.finalize_response`` copies into
    the body, so a cap does not fall back to ``invalid_import``.
    """
    return ErrorDetail(message, code=ImportErrorCode.LIMIT_EXCEEDED)


_IMPORT_ACTIONS = frozenset({"import_board", "import_trello"})


def _with_import_error_code(response):
    """Add ``code`` beside ``detail`` on an import error body that lacks one (#1903).

    The sites with a specific code set it themselves; this is the backstop
    that makes the contract hold for every error body the two import actions
    return, including the ones DRF builds for a raised exception (a missing
    group's 404, a throttle's 429), whose ``detail`` carries its own code.
    A body without a ``detail`` key (none today) is left alone.
    """
    data = getattr(response, "data", None)
    if response.status_code >= 400 and isinstance(data, dict) and "detail" in data and "code" not in data:
        data["code"] = fallback_code(data["detail"], response.status_code)
    return response


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
        # An unknown key is echoed back; bound it like every other echo (#1507).
        message = _bounded_text(_flatten_serializer_errors(ser.errors), _IMPORT_SERIALIZER_ECHO_MAX)
        return None, f"Invalid 'options': {message}"
    return dict(ser.validated_data), None


def _validate_import_field_sets(raw, field_names, swimlane_names):
    """Validate a JSON import's ``field_sets`` list (#2570).

    Returns ``(entries, error_detail)``. Each set names its members by custom
    field name and its lanes by swimlane name, like stage tracks. A field may
    belong to at most one set, and at most ``SET_CAP`` sets are accepted, the
    same rules the field-set API applies one request at a time.
    """
    if raw is None:
        return [], None
    if not isinstance(raw, list):
        return None, "'field_sets' must be a list."
    if len(raw) > CustomFieldSet.SET_CAP:
        return None, f"'field_sets' has {len(raw)} entries; a board may define at most {CustomFieldSet.SET_CAP}."
    entries, names, members = [], set(), set()
    sizes, scopes = set(CustomFieldSet.Size.values), set(CustomFieldSet.Scope.values)
    for i, fs in enumerate(raw):
        where = f"'field_sets' entry at index {i}"
        if not isinstance(fs, dict):
            return None, f"{where} must be an object."
        name = fs.get("name")
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 100 or "\x00" in name:
            return None, f"{where}: 'name' must be a non-empty string of at most 100 characters."
        name = name.strip()
        if name in names:
            return None, f"{where}: duplicate field set name {_bounded_repr(name)}."
        names.add(name)
        desc = fs.get("description")
        if desc is not None and (
            not isinstance(desc, str) or len(desc) > CustomFieldSet.MAX_DESCRIPTION_LENGTH or "\x00" in desc
        ):
            return None, f"{where}: 'description' must be a string of at most {CustomFieldSet.MAX_DESCRIPTION_LENGTH} characters."
        size = fs.get("default_size", CustomFieldSet.Size.SUMMARY)
        scope = fs.get("scope", CustomFieldSet.Scope.ALL)
        if not isinstance(size, str) or size not in sizes:
            return None, f"{where}: unknown 'default_size' {_bounded_repr(size)}."
        if not isinstance(scope, str) or scope not in scopes:
            return None, f"{where}: unknown 'scope' {_bounded_repr(scope)}."
        fields = fs.get("fields") or []
        lanes = fs.get("swimlanes") or []
        if not isinstance(fields, list) or not isinstance(lanes, list):
            return None, f"{where}: 'fields' and 'swimlanes' must be lists."
        for fname in fields:
            if not isinstance(fname, str) or fname not in field_names:
                return None, f"{where}: 'fields' references a field not in 'custom_fields': {_bounded_repr(fname)}"
            if fname in members:
                return None, f"{where}: field {_bounded_repr(fname)} is already in another set."
            members.add(fname)
        for lname in lanes:
            if not isinstance(lname, str) or lname not in swimlane_names:
                return None, f"{where}: 'swimlanes' references an undefined swimlane: {_bounded_repr(lname)}"
        if scope == CustomFieldSet.Scope.SWIMLANES and not lanes:
            # A lane-scoped set with no lanes would hide on every card; fall
            # back to every card rather than refusing the whole file.
            scope = CustomFieldSet.Scope.ALL
        entries.append({
            "name": name, "description": (desc or "").strip() or None,
            "default_size": size, "scope": scope, "fields": fields,
            "swimlanes": lanes if scope == CustomFieldSet.Scope.SWIMLANES else [],
        })
    return entries, None


def _validate_import_field_definitions(raw, serializer_class, model, pin_attr, list_name):
    """Validate a JSON import's ``custom_fields`` / ``swimlane_custom_fields`` list.

    Returns ``(validated_data_list, error_detail)``. Each entry runs through
    the same serializer the field-definition API uses, so an import cannot
    create a definition the API would refuse (bad choices, a malformed
    ``choice_colors`` map, a NUL byte in a name).

    The serializer is run *without* a ``board`` context on purpose: with one,
    its name-uniqueness and cap checks query the database, and every entry of
    a not-yet-created batch would see zero siblings — so a file with 40 card
    fields or 5 pinned ones would pass one entry at a time. Those per-board
    rules are applied here, over the whole list, instead. ``position`` is
    read-only on the serializer; the list order is the position.
    """
    if raw is None:
        return [], None
    if not isinstance(raw, list):
        return None, f"'{list_name}' must be a list."
    if len(raw) > model.MAX_PER_BOARD:
        return None, f"'{list_name}' has {len(raw)} entries; a board may define at most {model.MAX_PER_BOARD}."
    validated = []
    for i, entry in enumerate(raw):
        if not isinstance(entry, dict):
            return None, f"'{list_name}' entry at index {i} must be an object."
        # The tier rule (#2439) needs a board to count against and raises
        # without one (#1075); this batch has none yet, so it opts out with the
        # explicit marker and _validate_import_lane_tiers checks the whole list.
        ser = serializer_class(data=entry, context={"tiers_checked_by_caller": True})
        if not ser.is_valid():
            # DRF messages can quote the value ('"x" is not a valid choice'),
            # so the message is bounded like every other echo (#1507).
            message = _bounded_text(_flatten_serializer_errors(ser.errors), _IMPORT_SERIALIZER_ECHO_MAX)
            return None, f"'{list_name}' entry at index {i}: {message}"
        validated.append(dict(ser.validated_data))
    dupes = _duplicates_detail(f"{list_name} names", [v["name"] for v in validated])
    if dupes:
        return None, dupes
    pinned = sum(1 for v in validated if v.get(pin_attr))
    if pinned > model.MAX_PINNED_PER_BOARD:
        return None, (
            f"'{list_name}' pins {pinned} fields with '{pin_attr}'; "
            f"at most {model.MAX_PINNED_PER_BOARD} are allowed."
        )
    return validated, None


def _validate_import_parent_settings(data):
    """Return ``(settings_dict, error_detail)`` for a JSON import (#2454).

    The parent-item names and the child-cards flag ride along with an export.
    The names go through the same ``_clean_parent_name`` as the API write, so
    an import cannot smuggle in a bidi override or control character that the
    PATCH would refuse. Absent keys (an export from before #2454) leave the
    column defaults. A new board has no links and no board defaults to it, so
    the flag write cannot bypass ``check_flag_flip``.
    """
    from rest_framework import serializers as drf

    from boards.serializers import _clean_parent_name

    out = {}
    for key in ("parent_name_singular", "parent_name_plural"):
        if key not in data or data[key] is None:
            continue
        raw = data[key]
        if not isinstance(raw, str):
            return None, f"'{key}' must be a string."
        try:
            out[key] = _clean_parent_name(raw)
        except drf.ValidationError as exc:
            return None, f"'{key}': {exc.detail[0]}"
    if data.get("cards_can_have_children") is not None:
        if not isinstance(data["cards_can_have_children"], bool):
            return None, "'cards_can_have_children' must be true or false."
        out["cards_can_have_children"] = data["cards_can_have_children"]
    return out, None


def _validate_import_lane_tiers(swimlane_field_defs, raw_cap):
    """Return ``(lane_details_cap, error_detail)`` for a JSON import (#2439).

    The batch-wide half of ``assert_band_tiers``: at most two Band and at most
    the cap in Details, over the whole list in file order (its position). An
    export from before #2439 carries neither key, so every row imports NULL
    (a legacy board) and the cap is the default.
    """
    from boards.models import Board

    allowed = [value for value, _label in Board.LANE_DETAILS_CAP_CHOICES]
    if raw_cap is None:
        cap = Board._meta.get_field("lane_details_cap").default
    elif not isinstance(raw_cap, int) or isinstance(raw_cap, bool) or raw_cap not in allowed:
        # Strict int: 6.0 == 6 would otherwise pass and reach the column as a float.
        return None, f"'lane_details_cap' must be one of {allowed}."
    else:
        cap = raw_cap
    rows = [
        {"id": i, "position": i, "band_visibility": attrs.get("band_visibility")}
        for i, attrs in enumerate(swimlane_field_defs)
    ]
    if lane_field_tiers.is_legacy(rows):
        return cap, None
    try:
        lane_field_tiers.check_tier_counts(
            lane_field_tiers.resolve_tiers(rows, cap).values(), cap
        )
    except drf_serializers.ValidationError as exc:
        return None, f"'swimlane_custom_fields': {_flatten_serializer_errors(exc.detail)}"
    return cap, None


def _import_field_values(raw, definitions_by_name, hook_name):
    """Normalize one owner's imported ``{field name: value}`` map.

    Returns ``[(definition, stored_value)]``. Lenient, like the importer's
    handling of an unknown priority or an invalid ``external_ref``: an entry
    naming no imported definition, or holding a value the field's type
    refuses, is dropped rather than failing the whole import. Every value
    passes through the API's own normalizer, so what is stored is exactly
    what a PATCH would have stored; an exported value (already canonical)
    round-trips unchanged. The ``boards.hooks`` validator list named by
    *hook_name* runs too, as on the API path, so an extension's value policy
    cannot be sidestepped by importing instead of editing.
    """
    if not isinstance(raw, dict):
        return []
    out = []
    for name, value in raw.items():
        definition = definitions_by_name.get(name) if isinstance(name, str) else None
        if definition is None:
            continue
        try:
            stored = _normalize_custom_field_value(definition, value)
            stored = _run_custom_field_validator_hooks(definition, stored, hook_name=hook_name)
        except drf_serializers.ValidationError:
            continue
        if stored != "":
            out.append((definition, stored))
    return out


_CSV_CARD_FIELD_PREFIX = "Custom: "
_CSV_LANE_FIELD_PREFIX = "Swimlane Custom: "
_CSV_WARNINGS_SHOWN = 20


def _csv_custom_columns(fieldnames):
    """Find the ``Custom: `` / ``Swimlane Custom: `` columns of a CSV header (#1449).

    Returns ``(card_cols, lane_cols, error, warnings)``; each column is a
    ``(header, field name)`` pair in header order. The export writes these
    columns, so the importer reads them back. ``Swimlane Custom: `` is tested
    first only for clarity: neither prefix is a prefix of the other. A header
    with an empty name after the prefix is skipped with a warning. Two
    identical custom headers are an error: ``csv.DictReader`` keys a row by
    header, so the later column would silently overwrite the earlier one.
    """
    card_cols, lane_cols, warnings = [], [], []
    for header in fieldnames:
        # The importer strips every header, so an export of a field with an
        # empty name arrives as the bare ``Custom:`` (prefix minus its space).
        if header in (_CSV_CARD_FIELD_PREFIX.strip(), _CSV_LANE_FIELD_PREFIX.strip()):
            warnings.append(f"Skipped column {header!r}: the field name is empty.")
            continue
        if header.startswith(_CSV_LANE_FIELD_PREFIX):
            prefix, target = _CSV_LANE_FIELD_PREFIX, lane_cols
        elif header.startswith(_CSV_CARD_FIELD_PREFIX):
            prefix, target = _CSV_CARD_FIELD_PREFIX, card_cols
        else:
            continue
        name = header[len(prefix) :].strip()
        if not name:
            warnings.append(
                f"Skipped column {_bounded_text(header)!r}: the field name is empty."
            )
            continue
        target.append((header, name))
    custom_headers = [h for h, _ in card_cols + lane_cols]
    error = _duplicates_detail("custom field CSV headers", custom_headers)
    return card_cols, lane_cols, error, warnings


def _swimlane_values_from_rows(rows, lane_cols):
    """Collapse the repeated row-field cells of a CSV into one value per swimlane.

    The export denormalizes a swimlane field's value onto every card row of
    that lane (#1140), so on import each (lane, field) is seen once per card.
    The first non-empty cell wins; a later, different non-empty cell is a
    conflict (a hand-edited file) and is reported once per (lane, field)
    rather than silently overwriting. Returns ``({lane: {field: value}},
    warnings)``.
    """
    values, warnings, conflicted = {}, [], set()
    for row in rows:
        lane = _cell(row, "Swimlane")
        if not lane:
            continue
        for header, name in lane_cols:
            cell = _cell(row, header)
            if not cell:
                continue
            kept = values.setdefault(lane, {}).setdefault(name, cell)
            if kept != cell and (lane, name) not in conflicted:
                conflicted.add((lane, name))
                warnings.append(
                    f"Swimlane {_bounded_text(lane)!r} field {_bounded_text(name)!r} has "
                    f"conflicting values; kept {_bounded_text(kept)!r}."
                )
    return values, warnings


def _csv_cell_value(definition, cell, hook_name, where, warnings):
    """Normalize one custom-field CSV cell; ``None`` when it is empty or dropped.

    A dropped (NUL-bearing, over-length or refused) value adds a warning naming
    *where*. A NUL byte is dropped because PostgreSQL text columns reject it,
    which would otherwise 500 the whole import (and roll it back).
    Cells are stored exactly as exported (#1449): no un-escaping, since the
    export's formula sanitizing is irreversible.
    """
    if not cell:
        return None
    if "\x00" in cell:
        warnings.append(
            f"{where} field {_bounded_text(definition.name)!r}: value dropped "
            "(contains a NUL byte)."
        )
        return None
    if len(cell) > CustomFieldDefinition.MAX_VALUE_LENGTH:
        warnings.append(
            f"{where} field {_bounded_text(definition.name)!r}: value dropped "
            f"(over {CustomFieldDefinition.MAX_VALUE_LENGTH} characters)."
        )
        return None
    pairs = _import_field_values(
        {definition.name: cell}, {definition.name: definition}, hook_name
    )
    if not pairs:
        warnings.append(
            f"{where} field {_bounded_text(definition.name)!r}: value dropped (not accepted)."
        )
        return None
    return pairs[0][1]


def _cap_warnings(warnings):
    """Bound the warning list: the first few, then one ``...and N more`` entry."""
    if len(warnings) <= _CSV_WARNINGS_SHOWN:
        return list(warnings)
    rest = len(warnings) - _CSV_WARNINGS_SHOWN
    return [*warnings[:_CSV_WARNINGS_SHOWN], f"\u2026and {rest} more"]


def _list_len(value):
    return len(value) if isinstance(value, list) else 0


def _dict_items(value):
    """The object entries of ``value`` when it is a list, else none."""
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _import_color(item, default, skipped):
    """The color a JSON-imported row is stored with (#2093).

    A missing key takes ``default``. A present value must be hex (``#RGB`` is
    expanded); anything else is replaced by ``default`` and counted in
    ``skipped["colors"]`` rather than failing the import, because older
    Visiban exports can hold non-hex colors from before the API checked them
    and the import is the only way to bring such a board back.
    """
    if "color" not in item:
        return default
    normalized = normalize_hex_color(item["color"])
    if normalized is None:
        skipped["colors"] += 1
        return default
    return normalized


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
            # Block and gate history (#2413): only the rows the import writes
            # with ``history`` on (the open block a blocked card gets is card
            # state, written either way, so it is not counted).
            skipped["blocks"] += sum(
                1 for blk in _dict_items(card.get("blocks")) if _restorable_block(blk, keep_open=False)
            )
            skipped["gate_transitions"] += sum(
                1 for gt in _dict_items(card.get("gate_transitions")) if _restorable_gate_transition(gt)
            )
    # Retained history of hard-deleted cards (#1796, #2413) rides ``history``
    # too. The shape is validated before this runs.
    if not options["history"]:
        for entry in data.get("deleted_card_history", []):
            skipped["movements"] += _list_len(entry.get("movements", []))
            skipped["activities"] += sum(
                1 for act in entry.get("activities", [])
                if isinstance(act.get("event_type"), str) and act["event_type"] in valid_event_types
            )
            skipped["blocks"] += sum(
                1 for blk in entry.get("blocks", []) if _restorable_block(blk, keep_open=True)
            )
            skipped["gate_transitions"] += sum(
                1 for gt in entry.get("gate_transitions", []) if _restorable_gate_transition(gt)
            )
    # Relations (#1448) hang off cards: with ``cards`` off none is written.
    if not cards_on:
        skipped["relations"] = len(_relation_pairs(_dict_items(data.get("relations")), len(cards)))
    return skipped


def _restorable_block(entry, *, keep_open):
    """Whether the importer writes a row for this ``blocks`` entry (#1149, #2413).

    It needs a usable ``blocked_at`` and must not end before it starts. An
    open entry (no ``unblocked_at``) is written only for a deleted card
    (``keep_open``): a live card's own ``blocked_at`` decides its open block.
    """
    blocked_at = _aware_timestamp(entry.get("blocked_at"))
    if blocked_at is None:
        return False
    unblocked_at = _aware_timestamp(entry.get("unblocked_at"))
    if unblocked_at is None:
        return keep_open
    return unblocked_at >= blocked_at


_GATE_KINDS = frozenset(CardGateTransition.Kind.values)


def _restorable_gate_transition(entry):
    """Whether the importer writes a row for this ``gate_transitions`` entry (#1102)."""
    kind = entry.get("kind")
    return isinstance(kind, str) and kind in _GATE_KINDS


_RELATION_KINDS = frozenset(CardRelation.Type.values)
# Entries in the top-level ``relations`` list (#1448). Each writes at most one
# row and counts toward _IMPORT_MAX_ROWS; this bounds the list itself.
_IMPORT_MAX_RELATIONS = 10_000


def _relation_index(value, card_count):
    """``value`` as an index into the file's ``cards``, or None (bool is not an int here)."""
    if isinstance(value, int) and not isinstance(value, bool) and 0 <= value < card_count:
        return value
    return None


def _relation_pairs(entries, card_count):
    """The relations (#1448) an import writes, as ``(from_index, kind, to_index)``.

    Lenient, like ``external_ref`` and custom field values: an entry that is
    not an object, has an unknown ``kind``, names an index outside ``cards``
    (or not an integer), or relates a card to itself is dropped, not fatal.
    So are the entries the relation API would refuse: a duplicate, the
    reverse of a symmetric ``relates_to`` already listed, and the second half
    of a direct ``blocks`` two-cycle (the first one listed is kept). A
    symmetric pair is put lower index first; the importer creates the cards
    in file order, so that is also lower card id first, the model's canonical
    order. Longer cycles are not looked for, as in the API.
    """
    pairs = []
    seen = set()
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        kind = entry.get("kind")
        if not isinstance(kind, str) or kind not in _RELATION_KINDS:
            continue
        src = _relation_index(entry.get("from"), card_count)
        dst = _relation_index(entry.get("to"), card_count)
        if src is None or dst is None or src == dst:
            continue
        if kind in CardRelation.SYMMETRIC_TYPES and src > dst:
            src, dst = dst, src
        if (src, kind, dst) in seen or (dst, kind, src) in seen:
            continue
        seen.add((src, kind, dst))
        pairs.append((src, kind, dst))
    return pairs


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


def _is_canonical_number(value):
    """True for a string the number normalizer would store: a finite Decimal."""
    if not isinstance(value, str) or value != value.strip():
        return False
    try:
        return decimal.Decimal(value).is_finite()
    except (decimal.InvalidOperation, ValueError):
        return False


def _csv_custom_field_cell(definition, value):
    """One CSV cell for a custom field value, formula-sanitized.

    A ``multi_select`` value is stored as a JSON array string (#1391); a
    spreadsheet reader wants the entries, not JSON, so they are joined with
    ``"; "`` — the separator the Movement History column already uses. Each
    entry is sanitized and so is the joined cell, so no entry can smuggle a
    formula prefix to the start of the cell. Every other type is the stored
    string, sanitized as before. The JSON export keeps the stored string
    unchanged: that format is read by tools, and its values are strings.

    ``number`` and ``checkbox`` values are written as stored when they have
    their canonical shape (#1449). A stored number like ``-5`` begins with a
    formula character, and stripping it exported ``5`` — a different number.
    The normalizer only stores a finite ``Decimal`` string (never one starting
    with ``=``, ``@``, a tab or a CR) and a checkbox only ``true``/``false``, so
    neither can carry a formula; a value that is not of that shape (written
    around the normalizer) still falls through to the sanitizer.
    """
    T = CustomFieldDefinition.FieldType
    if definition.field_type == T.NUMBER and _is_canonical_number(value):
        return value
    if definition.field_type == T.CHECKBOX and value in ("true", "false"):
        return value
    if definition.field_type == T.MULTI_SELECT:
        value = "; ".join(
            _sanitize_csv_field(entry) for entry in parse_multi_select(value)
        )
    return _sanitize_csv_field(value)


def _is_truthy_non_string(value):
    """True for a value the importer would mishandle: truthy and not a ``str``.

    Falsy values (null, ``""``, 0, ``False``, ``[]``, ``{}``) were always coerced
    away by ``x or ""`` or ignored by a truthiness check, so they stay accepted
    for backward compatibility (#1451).
    """
    return bool(value) and not isinstance(value, str)


# ---------------------------------------------------------------------------
# JSON import value validation (#1507)
#
# Why two layers: the per-field checks below give each malformed value a 400
# that names where it is, which is what a user fixing a hand-edited file
# needs. They cannot be proven exhaustive, so ``_import_json`` also wraps its
# write block in a narrow catch for database- and value-shaped errors
# (``_IMPORT_WRITE_ERRORS``) that turns a missed case into a generic 400
# instead of a 500. That catch deliberately leaves TypeError / KeyError /
# AttributeError alone: once these checks have run, those mean a bug in the
# importer, and a quiet 400 would hide it.
#
# Limits are read from the model fields so a migration that widens a column
# widens the import with it. Integers are bounded to PostgreSQL ``integer``
# (production's backend) on every backend so SQLite tests see the same 400.
# ---------------------------------------------------------------------------
_IMPORT_INT_MAX = 2**31 - 1
_IMPORT_INT_MIN = -(2**31)
# Child-collection caps. Real exports sit far below these (the shipped sample
# boards top out at 8 labels and, per card, 3 comments, 10 movements, 21
# activities, 5 checklist items and 2 label refs); they exist so one 10 MB
# file cannot force millions of rows into a single transaction. Labels have
# no model-level cap, so this one is set far above any usable board: a
# board's own export must not be refused in practice.
_IMPORT_MAX_LABELS = 1000
_IMPORT_MAX_LABEL_REFS_PER_CARD = _IMPORT_MAX_LABELS
_IMPORT_MAX_CHILDREN_PER_CARD = {
    "comments": 1000,
    "checklist": 500,
    "movements": 2000,
    "activities": 5000,
    # Manual block history (#1149).
    "blocks": 1000,
    # Gate history (#1102): one row per gate crossed.
    "gate_transitions": 2000,
}
# Bound on every row one import writes, so 500 cards each just under their
# per-card caps are still refused. _board_rows + _card_rows count each row
# the import can insert, the importer-generated ones included, as an upper
# bound for every option combination; no import writes more than this.
_IMPORT_MAX_ROWS = 50_000
# Entries in ``deleted_card_history`` (#1796). Rows are bounded by the caps
# above; this bounds an entry that carries none (an empty entry writes nothing).
_IMPORT_MAX_DELETED_CARDS = 10_000
# A card uid as ``Card.uid`` writes it (16 lowercase hex characters).
_CARD_UID_RE = re.compile(r"[0-9a-f]{16}")
# Distinct usernames (assignee, moved_by, actor) a file may reference. Only
# assignees are resolved to accounts (one query); history names are kept as
# text (#1675) but still count, so the documented cap is unchanged.
_IMPORT_MAX_USERNAMES = 1000
# Rows per UPDATE in the timestamp backfills: one unbatched bulk_update builds
# a single CASE with an arm per row, which PostgreSQL evaluates in O(n^2).
_IMPORT_BACKFILL_BATCH = 500
# How much of an attacker-supplied value an error message may echo back.
_IMPORT_ECHO_MAX = 60
_IMPORT_DUPES_SHOWN = 5
# A serializer message embeds the value inside fixed text, so it gets more room.
_IMPORT_SERIALIZER_ECHO_MAX = 200

_import_reprlib = reprlib.Repr()
_import_reprlib.maxstring = _IMPORT_ECHO_MAX
_import_reprlib.maxother = _IMPORT_ECHO_MAX
_import_reprlib.maxlist = _import_reprlib.maxdict = 3
_import_reprlib.maxlevel = 2


def _bounded_repr(value):
    """``repr`` of an uploaded value, cut to a bounded slice for an error message.

    ``reprlib`` stops walking a large list or string early, so building the
    message costs no more than its output — plain ``repr`` of a 10 MB string
    would echo all of it.
    """
    text = _import_reprlib.repr(value)
    return _encodable(text if len(text) <= _IMPORT_ECHO_MAX else text[: _IMPORT_ECHO_MAX - 3] + "...")


def _encodable(text):
    """*text* with anything UTF-8 cannot encode (a lone surrogate) escaped.

    JSON allows ``"\\ud800"``; echoed raw, it makes the response renderer
    fail to encode and the 400 becomes a 500.
    """
    return text.encode("utf-8", "backslashreplace").decode("utf-8")


def _field_max_length(model, field_name):
    return model._meta.get_field(field_name).max_length


def _coerce_text(obj, key):
    """Store a scalar number or bool at ``obj[key]`` as its text, in place.

    Before #1507 the database layer coerced these with ``str()`` (True ->
    "True", 5 -> "5"), so a file that relied on it keeps importing, and the
    coerced string is what the write block stores. NaN and infinity are not
    coerced: they are not valid JSON (Python's parser accepts them as an
    extension) and no exporter writes them, so they fall through to the
    "must be a string" 400. Null, lists and objects are left for the same 400.
    """
    value = obj[key]
    if isinstance(value, (bool, int)) or (isinstance(value, float) and math.isfinite(value)):
        obj[key] = str(value)


def _text_error(value, max_length=None):
    """Why *value* cannot be stored in a NOT NULL text column, or None.

    Callers skip an absent key (the importer's default applies), so this only
    sees values the file actually set; an explicit null is refused because
    every such column is NOT NULL. NUL bytes are refused because PostgreSQL
    text cannot hold them.
    """
    if not isinstance(value, str):
        return "must be a string"
    if "\x00" in value:
        return "must not contain NUL characters"
    if max_length is not None and len(value) > max_length:
        return f"must be at most {max_length} characters"
    return None


def _optional_name_error(value, max_length):
    # Falsy non-strings were always coerced to "" by ``or ""`` (#1451) and
    # stay accepted; anything else is stored verbatim in a *_name column.
    return None if not value else _text_error(value, max_length)


def _bool_error(value):
    return None if isinstance(value, bool) else "must be true or false"


def _int_error(value, *, nullable=False):
    """Why *value* is not a storable non-negative integer, or None."""
    if value is None and nullable:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return "must be a non-negative integer"
    if value > _IMPORT_INT_MAX:
        return f"must be at most {_IMPORT_INT_MAX}"
    return None


def _gate_index_error(value):
    """A gate transition ``from_index``/``to_index`` (#1102): 0..MAX_PER_COLUMN.

    The model columns are smallint, so ``_int_error``'s 2^31-1 cap would let a
    value through that Postgres rejects at bulk insert (a 500, not a 400).
    """
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return "must be a non-negative integer"
    if value > SubColumn.MAX_PER_COLUMN:
        return f"must be at most {SubColumn.MAX_PER_COLUMN}"
    return None


def _nullable_gate_index_error(value):
    """``_gate_index_error`` that also accepts null (movement gate snapshots)."""
    return None if value is None else _gate_index_error(value)


def _swimlane_limit_error(value):
    """A swimlane ``wip_limit``/``weight_limit`` (#1150): null or at least 1."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        return "must be null or a positive integer"
    if value > _IMPORT_INT_MAX:
        return f"must be at most {_IMPORT_INT_MAX}"
    return None


def _limit_enforcement_error(value):
    """A swimlane ``limit_enforcement`` (#1150): null, "block" or "hard"."""
    if value is None or (isinstance(value, str) and value in Swimlane.LimitEnforcement.values):
        return None
    return 'must be null, "block" or "hard"'


def _health_status_error(value):
    """A swimlane ``health_status`` (#2243): null or a HealthStatus value."""
    from groups.health import HealthStatus

    if value is None or (isinstance(value, str) and value in HealthStatus.values):
        return None
    return 'must be null, "on_track", "at_risk" or "off_track"'


def _limit_columns_error(value):
    """A swimlane ``limit_columns`` (#1150): null, or a non-empty list of
    column names; each name is checked against the file's columns later."""
    if value is None:
        return None
    if not isinstance(value, list) or not value or not all(isinstance(v, str) for v in value):
        return "must be null or a non-empty list of column names"
    return None


def _policy_error(value):
    """A column ``policy`` (#1101): null or the v1 shape, same rules as the API."""
    try:
        normalize_policy(value)
    except PolicyError as exc:
        return f"is invalid: {exc}"
    return None


def _bounded_text(value, limit=_IMPORT_ECHO_MAX):
    """A value for an error message: strings unquoted, both bounded."""
    if isinstance(value, str):
        return _encodable(value if len(value) <= limit else value[: limit - 3] + "...")
    return _bounded_repr(value)


def _duplicates_detail(kind, values):
    """``Duplicate <kind>: a, b`` with a bounded, truncated list, or None.

    One Counter pass rather than ``list.count`` per entry, which was O(n^2)
    on a list of thousands of labels.
    """
    dupes = sorted(v for v, n in collections.Counter(values).items() if n > 1)
    if not dupes:
        return None
    shown = ", ".join(_bounded_text(v) for v in dupes[:_IMPORT_DUPES_SHOWN])
    if len(dupes) > _IMPORT_DUPES_SHOWN:
        shown += f" (and {len(dupes) - _IMPORT_DUPES_SHOWN} more)"
    return f"Duplicate {kind}: {shown}"


def _check_keys(obj, specs, where):
    """Run ``(key, checker)`` pairs over the keys present in *obj*.

    String- and bool-valued keys are reported as ``'key' <problem>`` like the
    #1451 messages; integer keys keep the older unquoted ``key must be a
    non-negative integer`` form existing clients and tests match on.
    """
    for key, check in specs:
        if key in obj:
            if getattr(check, "func", None) in _TEXT_CHECKS:
                _coerce_text(obj, key)
            problem = check(obj[key])
            if problem:
                shown = key if check in _UNQUOTED_CHECKS else f"'{key}'"
                return f"{where}: {shown} {problem}"
    return None


_nullable_int_error = functools.partial(_int_error, nullable=True)
# Checkers whose keys get _coerce_text first. _optional_name_error is not one:
# movement column/swimlane names must already be strings (#1451).
_TEXT_CHECKS = (_text_error,)
_UNQUOTED_CHECKS = (_int_error, _nullable_int_error)


def _text(max_length=None):
    return functools.partial(_text_error, max_length=max_length)


# The activity types whose ``item_text`` names a checklist item (#2199) or a
# custom field (#1921); the same set the timeline sends
# (``CardActivity.ITEM_TEXT_EVENT_TYPES``). Other types import NULL.
_ITEM_TEXT_EVENT_TYPES = CardActivity.ITEM_TEXT_EVENT_TYPES


def _nullable_item_text(value):
    """``CardActivity.item_text`` (#2199): null, or text that fits the column.

    Not a ``_TEXT_CHECKS`` checker, so a number is refused rather than coerced:
    the key is new in 1.3 and no exporter ever wrote anything but a string.
    """
    if value is None:
        return None
    return _text_error(value, CardActivity._meta.get_field("item_text").max_length)


def _name_list_error(value):
    """A list of names (#1921 stage tracks, lane exceptions); null or absent is none."""
    if value is None:
        return None
    if not isinstance(value, list) or not all(isinstance(v, str) and v.strip() for v in value):
        return "must be a list of non-empty names"
    if len(set(value)) != len(value):
        return "must not repeat a name"
    if len(value) > CustomFieldDefinition.MAX_PER_BOARD:
        return f"has more than {CustomFieldDefinition.MAX_PER_BOARD} entries"
    return None


def _sub_columns_error(value):
    """A stage's sub-column names (#1102): none, or 2 to the cap, like the stage action."""
    if problem := _name_list_error(value):
        return problem
    if value and not 2 <= len(value) <= SubColumn.MAX_PER_COLUMN:
        return f"must list between 2 and {SubColumn.MAX_PER_COLUMN} sub-columns, or none"
    max_len = _field_max_length(SubColumn, "name")
    if value and any(len(v) > max_len or "\x00" in v for v in value):
        return f"names must be at most {max_len} characters, without NUL"
    return None


def _validate_json_import_values(data):
    """Value-level checks for a JSON import, run before the transaction (#1507).

    Assumes the shape checks in ``_import_json`` already passed (every list is
    a list of objects, names are strings). Returns an error detail or None.
    """
    if "description" in data:
        _coerce_text(data, "description")
        if problem := _text_error(data["description"]):
            return f"Board 'description' {problem}"

    labels = data.get("labels", [])
    if len(labels) > _IMPORT_MAX_LABELS:
        return _limit_error(f"Import contains {len(labels)} labels, which exceeds the limit of {_IMPORT_MAX_LABELS}.")

    column_specs = (
        ("name", _text(_field_max_length(Column, "name"))),
        ("position", _int_error),
        ("color", _text(_field_max_length(Column, "color"))),
        ("wip_limit", _nullable_int_error),
        ("weight_limit", _nullable_int_error),
        ("allow_card_creation", _bool_error),
        ("is_done", _bool_error),
        # Explicit column policy (#1101), validated like a REST write.
        ("policy", _policy_error),
        # Gated stage (#1102) and its tracks (#1921), by name. Additive: a
        # file from before 1.3 has neither key.
        ("sub_columns", _sub_columns_error),
        ("tracks", _name_list_error),
    )
    swimlane_specs = (
        ("name", _text(_field_max_length(Swimlane, "name"))),
        ("position", _int_error),
        ("color", _text(_field_max_length(Swimlane, "color"))),
        ("contact_email", _text(_field_max_length(Swimlane, "contact_email"))),
        ("notes", _text()),
        # Row limits (#1150): restored as exported, never enforced on import.
        ("wip_limit", _swimlane_limit_error),
        ("weight_limit", _swimlane_limit_error),
        ("limit_enforcement", _limit_enforcement_error),
        ("limit_columns", _limit_columns_error),
        # Lane health status (#2243): the manual pin, restored as exported.
        ("health_status", _health_status_error),
        # Dimensions marked not applicable for this lane (#1921), by name.
        ("not_applicable_tracks", _name_list_error),
    )
    label_specs = (
        ("name", _text(_field_max_length(Label, "name"))),
        ("color", _text(_field_max_length(Label, "color"))),
    )
    for list_name, label, specs in (
        ("columns", "Column", column_specs),
        ("swimlanes", "Swimlane", swimlane_specs),
        ("labels", "Label", label_specs),
    ):
        items = data.get(list_name, [])
        for i, item in enumerate(items):
            if error := _check_keys(item, specs, f"{label} at index {i}"):
                return error
        # Names carry a (board, name) unique constraint.
        if detail := _duplicates_detail(f"{label.lower()} names", [item["name"] for item in items]):
            return detail

    # Column carries unique_together (board, position); a missing position
    # defaults to the entry's index, so an explicit value can also collide
    # with another entry's default. Swimlane position has no such constraint.
    positions = [col.get("position", i) for i, col in enumerate(data["columns"])]
    if detail := _duplicates_detail("column positions", positions):
        return detail

    # A swimlane's counted columns name columns of this file (#1150), the way
    # a card's column does.
    column_names = {col["name"] for col in data["columns"]}
    for i, lane in enumerate(data.get("swimlanes", [])):
        for name in lane.get("limit_columns") or ():
            if name not in column_names:
                return (
                    f"Swimlane at index {i}: 'limit_columns' references undefined "
                    f"column: {_bounded_repr(name)}"
                )

    card_specs = (
        ("title", _text(_field_max_length(Card, "title"))),
        ("description", _text()),
        ("weight", _int_error),
        ("position", _int_error),
        ("blocked_reason", _text(_field_max_length(Card, "blocked_reason"))),
        # Sub-column index in its stage (#1102); range-checked below.
        ("gates_passed", _int_error),
    )
    # How many sub-columns each column of this file has (#1102).
    sub_counts = {col["name"]: len(col.get("sub_columns") or ()) for col in data["columns"]}
    movement_name = functools.partial(
        _optional_name_error, max_length=_field_max_length(CardMovement, "from_column_name"),
    )
    # A history row's kept source name (#1675) must fit its column.
    imported_name = functools.partial(
        _optional_name_error, max_length=_field_max_length(CardMovement, "imported_from_username"),
    )
    child_specs = {
        "comments": ("comment", (
            ("body", _text()),
            # A comment's kept source name (#1702), same column length.
            ("imported_from_username", imported_name),
        )),
        "checklist": ("checklist item", (
            ("text", _text(_field_max_length(CardChecklist, "text"))),
            ("is_checked", _bool_error),
            # #445: the assignee's username, resolved like card ``assignee``.
            ("assignee", lambda v: None if v is None or isinstance(v, str) else "must be a string"),
        )),
        "movements": ("movement", (
            ("from_column", movement_name), ("to_column", movement_name),
            ("from_swimlane", movement_name), ("to_swimlane", movement_name),
            ("notes", _text(_field_max_length(CardMovement, "notes"))),
            ("imported_from_username", imported_name),
            # Gate snapshot of the move (#1102); smallint columns, null for
            # moves that predate gated stages.
            ("from_gates_passed", _nullable_gate_index_error),
            ("from_gates_open", _nullable_gate_index_error),
            ("to_gates_passed", _nullable_gate_index_error),
        )),
        "activities": ("activity", (
            ("from_value", _text()), ("to_value", _text()),
            ("imported_from_username", imported_name),
            # #2199: null (or absent, as in files from before 1.3) is no item name.
            ("item_text", _nullable_item_text),
        )),
        # Manual block history (#1149).
        "blocks": ("block", (
            ("reason", _text(_field_max_length(CardBlock, "reason"))),
            ("resolution", _text(_field_max_length(CardBlock, "resolution"))),
            ("column", movement_name),
            ("imported_from_username", imported_name),
        )),
        # Gate history (#1102). ``kind`` and ``cause`` are matched against
        # their enums when the row is built, like ``movement_type``.
        "gate_transitions": ("gate transition", (
            ("from_index", _gate_index_error), ("to_index", _gate_index_error),
            ("reason", _text(_field_max_length(CardGateTransition, "reason"))),
            ("column", movement_name),
            ("sub_column", functools.partial(
                _optional_name_error, max_length=_field_max_length(CardGateTransition, "sub_column_name"),
            )),
            ("imported_from_username", imported_name),
            # Position of the linked movement in this card's ``movements``
            # list (#1102); null when unlinked.
            ("movement_index", _nullable_int_error),
        )),
    }
    username_len = _field_max_length(get_user_model(), "username")
    usernames = set()
    total_rows = _board_rows(data)
    for ci, card in enumerate(data.get("cards", [])):
        where = f"Card at index {ci}"
        if error := _check_keys(card, card_specs, where):
            return error
        col_ref = card.get("column")
        gates = card.get("gates_passed")
        # Both ``0`` defaults are floored by the ``max(..., 1)``, so 0 and 1 are the same value.
        if gates and gates >= max(
            sub_counts.get(col_ref, 0)  # pragma: no mutate -- floored to 1 by the max() below
            if isinstance(col_ref, str)
            else 0,  # pragma: no mutate -- floored to 1 by the max() below
            1,
        ):
            return f"{where}: 'gates_passed' must be less than the number of sub-columns of its column"
        if len(card.get("labels", [])) > _IMPORT_MAX_LABEL_REFS_PER_CARD:
            return _limit_error(f"{where}: 'labels' has more than {_IMPORT_MAX_LABEL_REFS_PER_CARD} entries")
        for child, (child_label, specs) in child_specs.items():
            items = card.get(child, [])
            cap = _IMPORT_MAX_CHILDREN_PER_CARD[child]
            if len(items) > cap:
                return _limit_error(f"{where}: '{child}' has {len(items)} entries; the limit is {cap}")
            for ji, entry in enumerate(items):
                if error := _check_keys(entry, specs, f"{where}, {child_label} at index {ji}"):
                    return error
        if error := _block_reason_error(card, where):
            return error
        total_rows += _card_rows(card)
        if total_rows > _IMPORT_MAX_ROWS:
            return _limit_error(f"Import would write more than {_IMPORT_MAX_ROWS} rows in total.")
        # Usernames feed one ``IN`` query; bound how many and how long.
        for key, value in _card_usernames(card):
            if len(value) > username_len:
                return f"{where}: '{key}' must be at most {username_len} characters"
            usernames.add(value)
        if len(usernames) > _IMPORT_MAX_USERNAMES:
            return _limit_error(f"Import references more than {_IMPORT_MAX_USERNAMES} distinct usernames.")

    # Retained history of hard-deleted cards (#1796): a card's movements and
    # activities without the card. Shape and values are checked here, in one
    # place, with the same specs, caps and timestamp rule as a card's own, and
    # its rows and names count against the same import-wide limits.
    from django.utils.dateparse import parse_datetime

    deleted = data.get("deleted_card_history", [])
    if not isinstance(deleted, list):
        return "'deleted_card_history' must be a list"
    if len(deleted) > _IMPORT_MAX_DELETED_CARDS:
        return _limit_error(
            f"'deleted_card_history' has {len(deleted)} entries; the limit is "
            f"{_IMPORT_MAX_DELETED_CARDS}"
        )
    title_check = (("card_title", _text(_field_max_length(CardMovement, "card_title"))),)
    for di, entry in enumerate(deleted):
        where = f"Deleted card history at index {di}"
        if not isinstance(entry, dict):
            return f"{where} must be an object"
        uid = entry.get("card_uid", "")
        if not isinstance(uid, str) or (uid and not _CARD_UID_RE.fullmatch(uid)):
            return f"{where}: 'card_uid' must be a card uid (16 lowercase hex characters)"
        if error := _check_keys(entry, title_check, where):
            return error
        for child, ts_keys, str_keys in (
            ("movements", ("moved_at",), (
                "from_column", "to_column", "from_swimlane", "to_swimlane", "moved_by",
                "imported_from_username",
            )),
            ("activities", ("created_at",), ("actor", "imported_from_username")),
            # A deleted card's retained blocks and gate history (#2413).
            ("blocks", ("blocked_at", "unblocked_at"), ("blocked_by", "unblocked_by", "imported_from_username")),
            ("gate_transitions", ("created_at",), ("actor", "imported_from_username")),
        ):
            items = entry.get(child, [])
            if not isinstance(items, list):
                return f"{where}: '{child}' must be a list"
            cap = _IMPORT_MAX_CHILDREN_PER_CARD[child]
            if len(items) > cap:
                return _limit_error(f"{where}: '{child}' has {len(items)} entries; the limit is {cap}")
            child_label, specs = child_specs[child]
            for ji, item in enumerate(items):
                item_where = f"{where}, {child_label} at index {ji}"
                if not isinstance(item, dict):
                    return f"{item_where} must be an object"
                for key in str_keys:
                    if _is_truthy_non_string(item.get(key)):
                        return f"{item_where}: '{key}' must be a string"
                for ts_key in ts_keys:
                    if _timestamp_error(item.get(ts_key), parse_datetime):
                        return f"{item_where}: invalid timestamp for '{ts_key}': {_bounded_repr(item.get(ts_key))}"
                if error := _check_keys(item, specs, item_where):
                    return error
        # A block needs a reason, as on a live card (#1149).
        if error := _block_reason_error({"blocks": entry.get("blocks", [])}, where):
            return error
        total_rows += sum(
            len(entry.get(child, [])) for child in ("movements", "activities", "blocks", "gate_transitions")
        )
        if total_rows > _IMPORT_MAX_ROWS:
            return _limit_error(f"Import would write more than {_IMPORT_MAX_ROWS} rows in total.")
        # Only the lists an entry may carry: _card_usernames would also walk
        # ``checklist``, which this section never validates.
        names = (
            (key, item.get(key))
            for child, key in (
                ("movements", "moved_by"), ("activities", "actor"),
                ("blocks", "blocked_by"), ("blocks", "unblocked_by"), ("gate_transitions", "actor"),
            )
            for item in entry.get(child, [])
        )
        for key, value in names:
            if not (isinstance(value, str) and value):
                continue
            if len(value) > username_len:
                return f"{where}: '{key}' must be at most {username_len} characters"
            usernames.add(value)
        if len(usernames) > _IMPORT_MAX_USERNAMES:
            return _limit_error(f"Import references more than {_IMPORT_MAX_USERNAMES} distinct usernames.")

    # Card relations (#1448). The list itself must be a list and is bounded;
    # its entries are lenient (_relation_pairs drops a bad one), so nothing
    # inside an entry is a 400. Every entry counts toward the row limit.
    relations = data.get("relations", [])
    if not isinstance(relations, list):
        return "'relations' must be a list"
    if len(relations) > _IMPORT_MAX_RELATIONS:
        return _limit_error(
            f"'relations' has {len(relations)} entries; the limit is {_IMPORT_MAX_RELATIONS}"
        )
    total_rows += len(relations)
    if total_rows > _IMPORT_MAX_ROWS:
        return _limit_error(f"Import would write more than {_IMPORT_MAX_ROWS} rows in total.")
    return None


def _blank(value):
    return not isinstance(value, str) or not value.strip()


def _block_reason_error(card, where):
    """The reason rule of ``BlockCardSerializer``, applied to an import (#1149).

    A block needs a reason (the API refuses a blank one), so a file that
    carries a blocked card without ``blocked_reason``, or a block entry
    without ``reason``, is refused with a 400 rather than imported as a
    reasonless block or silently unblocked. Lengths and types are checked
    by the specs above; this adds only "required and not just whitespace".
    Entries the importer drops anyway (no usable ``blocked_at``) are not
    judged.
    """
    if card.get("blocked_at") and _blank(card.get("blocked_reason")):
        return f"{where}: 'blocked_reason' is required when 'blocked_at' is set"
    for ji, entry in enumerate(card.get("blocks", [])):
        if entry.get("blocked_at") and _blank(entry.get("reason")):
            return f"{where}, block at index {ji}: 'reason' is required"
    return None


def _value_rows(values, max_fields):
    # A custom-field value map writes at most one row per defined field.
    return min(len(values), max_fields) if isinstance(values, dict) else 0


def _board_rows(data):
    """Upper bound on the rows an import writes outside its cards.

    The board, the importer's membership and the persisted ``board.created``
    event; every column, swimlane and label; the custom field definitions;
    and the swimlane custom field values.
    """
    return (
        3
        + len(data.get("columns", []))
        + len(data.get("swimlanes", []))
        + len(data.get("labels", []))
        + _list_len(data.get("custom_fields"))
        + _list_len(data.get("swimlane_custom_fields"))
        + sum(
            _value_rows(sw.get("custom_field_values"), SwimlaneCustomFieldDefinition.MAX_PER_BOARD)
            for sw in data.get("swimlanes", [])
        )
        # Sub-columns and stage tracks (#1102, #1921), and lane exceptions.
        + sum(
            _list_len(col.get("sub_columns")) + _list_len(col.get("tracks"))
            for col in data.get("columns", [])
        )
        + sum(_list_len(sw.get("not_applicable_tracks")) for sw in data.get("swimlanes", []))
    )


def _card_rows(card):
    """Upper bound on the rows the importer writes for one card.

    The card; its comments, checklist items, movements, activities and
    blocks (plus one open block for a card that is blocked now);
    its MR/PR link and custom field values; plus what the importer
    generates itself: an "item added" activity per checklist item, a label
    link per label reference, and one label-change and one weight-change
    activity. Counted regardless of import options.
    """
    return (
        1
        + (1 if isinstance(card.get("external_ref"), dict) else 0)
        + _value_rows(card.get("custom_field_values"), CustomFieldDefinition.MAX_PER_BOARD)
        + len(card.get("comments", []))
        + 2 * len(card.get("checklist", []))
        + len(card.get("movements", []))
        + len(card.get("activities", []))
        + len(card.get("labels", []))
        # Block history (#1149), plus the open block the importer writes for
        # a card that is blocked now.
        + len(card.get("blocks", []))
        + (1 if card.get("blocked_at") else 0)
        # Gate history (#1102).
        + len(card.get("gate_transitions", []))
        + 2
    )


def _card_usernames(card):
    """``(key, username)`` for every truthy username string a card references."""
    if isinstance(card.get("assignee"), str) and card["assignee"]:
        yield "assignee", card["assignee"]
    for child, key in (
        # #445: checklist assignees are resolved to accounts, like card assignee.
        ("checklist", "assignee"),
        ("movements", "moved_by"), ("activities", "actor"),
        ("blocks", "blocked_by"), ("blocks", "unblocked_by"),
        ("gate_transitions", "actor"),
    ):
        for entry in card.get(child, []):
            value = entry.get(key)
            if isinstance(value, str) and value:
                yield key, value


# Characters that would split a CSV Movement History record or segment.
_CSV_HISTORY_SEPARATORS_RE = re.compile(r"[|;\r\n]+")
_IMPORTED_FROM_MAX_LENGTH = CardMovement._meta.get_field("imported_from_username").max_length


def _imported_from_username(entry, key):
    """The source username an imported history row keeps as text (#1675).

    Every imported movement, activity and comment (#1702) is attributed to
    the importer, so the file's ``moved_by`` / ``actor`` / ``author`` is kept
    only as this label. A file
    that Visiban exported from an imported board carries the row's original
    name in ``imported_from_username``; that wins over ``key`` (which names
    whoever imported it last), so an export/import round trip keeps the first
    source's name. Never None: ``""`` still marks the row as imported when
    the file names nobody. NUL characters are dropped (PostgreSQL text cannot
    hold them) and the value is cut to the column length.
    """
    for candidate in (entry.get("imported_from_username"), entry.get(key)):
        if isinstance(candidate, str):
            return candidate.replace("\x00", "")[:_IMPORTED_FROM_MAX_LENGTH]
    return ""


# What the write block's guard converts to a 400. Database- and value-shaped
# only; see the comment above the JSON import helpers for why TypeError,
# KeyError and AttributeError are not here. ValueError is a trade-off: it is
# how psycopg reports a NUL byte, but it means a genuine importer ValueError
# also surfaces as a 400 with a warning log rather than a 5xx.
_IMPORT_WRITE_ERRORS = (DataError, IntegrityError, DjangoValidationError, ValueError, OverflowError)


def _fill_activity_snapshots(activities, cards_by_pk=None):
    """Set ``board`` and the card snapshot on activity rows before ``bulk_create``.

    The manager's ``bulk_create`` fills them too (``fill_activity_snapshots``,
    #1799), but only on rows that lack them; setting them here from
    ``cards_by_pk`` costs no query for rows built with ``card_id=``. ``cards_by_pk`` maps ``card_id`` to the
    card for rows built with ``card_id=``; rows built with ``card=`` read the
    cached instance.
    """
    for act in activities:
        if act.card_id is None:
            # A deleted card's retained row (#1796) carries its own snapshot.
            continue
        card = cards_by_pk[act.card_id] if cards_by_pk is not None else act.card
        act.board_id = card.board_id
        act.card_uid = card.uid
        act.card_title = card.title


@contextlib.contextmanager
def _json_import_write_guard():
    """Turn a value the per-field checks missed into a 400, not a 500 (#1507).

    Must be entered *outside* ``transaction.atomic()`` so the atomic block has
    already rolled back when this sees the exception. Neither the response
    nor the log carries ``str(exc)``: database messages can quote the
    uploaded value. The log names the importer line that failed, so the
    missing per-field check can be found and added.
    """
    try:
        yield
    except _IMPORT_WRITE_ERRORS as exc:
        frames = [f for f in traceback.extract_tb(exc.__traceback__) if f.filename == __file__]
        where = f"line {frames[-1].lineno}" if frames else "unknown line"
        logger.warning(
            "Board JSON import rejected — %s while writing (%s); a per-field check is missing.",
            type(exc).__name__, where,
        )
        raise ParseError(
            "The import file contains a value that cannot be stored.", code=ImportErrorCode.INVALID_IMPORT,
        ) from None


def _timestamp_error(value, parser):
    """True when a truthy timestamp is not a string the parser accepts.

    A number such as ``20200101`` used to pass ``parser(str(value))`` and then
    reach a Date/DateTimeField as an int (#1507), so the type is checked first.
    Django's parsers raise ValueError for well-formed but impossible values
    ("2024-02-30", "T25:00:00") rather than returning None (#1461).
    """
    if not value:
        return False
    if not isinstance(value, str):
        return True
    try:
        parsed = parser(value)
        if parsed is None:
            return True
        # An aware value whose UTC instant falls outside years 1-9999
        # ("9999-12-31T23:59:59-12:00") is stored by PostgreSQL but cannot
        # be read back into a Python datetime, so every later export of the
        # board would fail (#1507).
        if isinstance(parsed, datetime.datetime):
            if django_timezone.is_naive(parsed):
                parsed = django_timezone.make_aware(parsed)
            parsed.astimezone(datetime.timezone.utc)
    except (ValueError, OverflowError):
        return True
    return False


def _aware_timestamp(value):
    """An aware datetime for a timestamp string, or None when it is absent or unusable.

    Uses the parser the validation pass uses (``_timestamp_error``), so a value
    that passed validation parses here too; anything else is None.
    """
    from django.utils.dateparse import parse_datetime

    if not value or not isinstance(value, str):
        return None
    try:
        parsed = parse_datetime(value)
        if parsed is None:
            return None
        if django_timezone.is_naive(parsed):
            parsed = django_timezone.make_aware(parsed)
        parsed.astimezone(datetime.timezone.utc)
    except (ValueError, OverflowError):
        return None
    return parsed


def _imported_card_created_at(card_data, history_on, now):
    """The exported ``created_at`` to give an imported card, or None for "now" (#1906).

    A card is dated by its file only when that date is one the card could have
    had: not in the future, and not after the first entry of the history the
    import keeps for it (movement, activity or comment). Otherwise the card
    keeps the import time, as before, rather than carrying a date that
    contradicts its own history. Files without the field import as they
    always did.
    """
    created = _aware_timestamp(card_data.get("created_at"))
    if created is None or created > now:
        return None
    if history_on:
        for child, key in (("movements", "moved_at"), ("activities", "created_at"), ("comments", "created_at")):
            entries = card_data.get(child)
            for entry in entries if isinstance(entries, list) else []:
                at = _aware_timestamp(entry.get(key)) if isinstance(entry, dict) else None
                if at is not None and at < created:
                    return None
    return created


def _imported_card_blocks(card_obj, card_data, column_map, importer, history_on):
    """The ``CardBlock`` rows a JSON import writes for one card (#1149).

    With the history option, every *closed* block in the file's ``blocks``
    list is restored, attributed to the importer with the file's
    ``blocked_by`` kept as ``imported_from_username`` (#1675). Open entries
    in the list are never restored as such: the card's own ``blocked_at`` /
    ``blocked_reason`` decide whether it is blocked now, and exactly one open
    row is written for a blocked card, whatever the option, so
    ``Card.blocked_at`` and the open row cannot disagree (the
    one-open-block constraint would refuse a second one anyway).

    Entries without a usable ``blocked_at``, or that end before they start,
    are dropped, the same leniency the importer applies to an unknown
    movement type.
    """
    identity = {
        "card_id": card_obj.pk, "board_id": card_obj.board_id,
        "card_uid": card_obj.uid, "card_title": card_obj.title,
    }

    def _row(entry, **values):
        return _imported_block_row(
            entry, identity=identity, column_map=column_map,
            default_column=card_obj.column, importer=importer, **values,
        )

    rows = []
    entries = card_data.get("blocks", []) if history_on else []
    open_entry = None  # pragma: no mutate -- None and "" are both falsy for every use below
    for entry in entries:
        blocked_at = _aware_timestamp(entry.get("blocked_at"))
        if blocked_at is None:
            continue
        unblocked_at = _aware_timestamp(entry.get("unblocked_at"))
        if unblocked_at is None:
            open_entry = entry
            continue
        if unblocked_at < blocked_at:
            continue
        rows.append(_row(
            entry, blocked_at=blocked_at, unblocked_at=unblocked_at,
            reason=entry["reason"].strip(), resolution=(entry.get("resolution") or "").strip(),
            imported_name=_imported_from_username(entry, "blocked_by"),
        ))
    if card_obj.blocked_at is not None:
        rows.append(_row(
            open_entry, blocked_at=card_obj.blocked_at, unblocked_at=None,
            reason=card_obj.blocked_reason, resolution="",
            imported_name=(
                _imported_from_username(open_entry, "blocked_by") if open_entry else ""
            ),
        ))
    return rows


def _imported_block_row(entry, *, identity, column_map, default_column, importer,
                        blocked_at, unblocked_at, reason, resolution, imported_name):
    """One imported ``CardBlock``, on a live card or a deleted one (#1149, #2413).

    ``identity`` is ``card_id``, ``board_id``, ``card_uid`` and ``card_title``
    (bulk_create skips save(), so the snapshots are set here); ``card_id`` is
    None for a deleted card's row. Attributed to the importer (Rule 5) with
    the file's name in ``imported_from_username``. The file's column name
    when it gives one (None if that column is not on the imported board; the
    name is still kept), else ``default_column``.
    """
    column_name = (entry.get("column") or "") if entry else ""
    column = column_map.get(column_name) if column_name else default_column
    return CardBlock(
        **identity,
        blocked_at=blocked_at,
        blocked_by=importer,
        reason=reason,
        unblocked_at=unblocked_at,
        unblocked_by=importer if unblocked_at else None,
        resolution=resolution,
        column=column,
        column_name=column.name if column else column_name,
        column_uid=column.uid if column else "",
        imported_from_username=imported_name,
    )


def _imported_deleted_card_blocks(entry, identity, column_map, importer):
    """The ``CardBlock`` rows a JSON import writes for one deleted card (#2413).

    Every entry ``_restorable_block`` accepts, open ones included: a deleted
    card has no ``blocked_at`` of its own to decide its open block, and the
    source board held the row open too (``flow_metrics`` already leaves an
    open block without a card out of blocked time, and the one-open-block
    constraint is per card, so it does not apply to card-less rows).
    """
    return [
        _imported_block_row(
            blk, identity=identity, column_map=column_map, default_column=None, importer=importer,
            blocked_at=_aware_timestamp(blk.get("blocked_at")),
            unblocked_at=_aware_timestamp(blk.get("unblocked_at")),
            reason=blk["reason"].strip(), resolution=(blk.get("resolution") or "").strip(),
            imported_name=_imported_from_username(blk, "blocked_by"),
        )
        for blk in entry.get("blocks", [])
        if _restorable_block(blk, keep_open=True)
    ]


def _imported_relations(data, cards, importer):
    """The ``CardRelation`` rows a JSON import writes (#1448), from the file's ``relations``.

    ``cards`` are the created cards in file order, so ``cards[i]`` is the
    card at index ``i`` of the file's ``cards`` list. Same-board by
    construction: every card is on the new board.
    """
    return [
        CardRelation(from_card=cards[src], to_card=cards[dst], relation_type=kind, created_by=importer)
        for src, kind, dst in _relation_pairs(data.get("relations", []), len(cards))
    ]


def _import_envelope(board_data, summary):
    """The 201 body every board import returns (#1903).

    The JSON/CSV import used to return the board's fields at the top level
    plus ``import_summary``; the Trello import returned ``{board, summary}``.
    Both now carry all four keys so one client can read either, and neither
    lost a key (1.x is additive only): the board's fields at the top level
    and under ``board``, the summary under both ``summary`` and
    ``import_summary``. The summary's own shape is still per source.
    """
    return {**board_data, "import_summary": summary, "board": board_data, "summary": summary}


def _resolve_import_users(usernames, importer, group=None):
    """Map imported usernames to users the importer can see, keyed by lowered username.

    Shared by the JSON and CSV importers so both apply one assignee rule:
    match case-insensitively (imported data may differ in casing from the
    stored username), but only against the pool the Trello importer uses
    (``trello_import.visible_users``): the importer, co-members of their
    boards and groups, and the target group. The uploader controls the file,
    so names are matched only against that pool. A name with no match is simply absent from the map, so the card
    imports unassigned instead of failing the whole import. Board membership
    of the *new* board is deliberately not the filter: the board is brand new
    and only the importer is a member of it, so that filter would drop every
    assignee.  One query for the whole import avoids a lookup per card (#420).
    """
    names = {n.lower() for n in usernames if n}
    if not names:
        return {}
    from django.db.models.functions import Lower
    return {
        u.username.lower(): u
        for u in _trello.visible_users(importer, group)
        .annotate(lower_username=Lower("username"))
        .filter(lower_username__in=names)
    }


class BoardImportExportMixin:
    """Mixin providing import and export @action methods for BoardViewSet."""

    def finalize_response(self, request, response, *args, **kwargs):
        # Runs after handle_exception, so it also sees the bodies DRF builds
        # for raised exceptions. Scoped to the two import actions: the error
        # ``code`` is their contract (#1903), not every board endpoint's.
        if getattr(self, "action", None) in _IMPORT_ACTIONS:
            _with_import_error_code(response)
        return super().finalize_response(request, response, *args, **kwargs)

    @extend_schema(
        summary="Import a board from a Visiban JSON or CSV export",
        request={"multipart/form-data": {"type": "object", "properties": {
            "file": {"type": "string", "format": "binary",
                     "description": "A .json or .csv Visiban export. The format is chosen from the "
                                    "file extension, falling back to the upload's content type."},
            "name": {"type": "string", "description": (
                "Board name, used exactly as given. When omitted, the board is named "
                "'Imported: <name>' — the name in a JSON file, or the CSV filename without "
                "its extension — with ' - 1', ' - 2', ... appended if that name is taken."
            )},
            "group_id": {"type": "integer", "description": "Place the imported board into this group."},
            "options": {"type": "string", "description": (
                "JSON object choosing what to import. Keys (all optional booleans, default true): "
                "labels, cards, comments, checklist, history. comments, checklist and history "
                "require cards. Date shift (JSON only, all optional): a file with a top-level "
                "date_anchor (the shipped samples) is shifted by default, with no option needed; "
                "shift_dates_from (YYYY-MM-DD) names the source day instead and always wins; "
                "shift_dates (boolean, default true) set to false imports the dates as written; "
                "shift_dates_to (YYYY-MM-DD, default today in UTC) is the day the board is dated "
                "around. Every date moves by the days from the source day to that day, so the "
                "shift can be backward. A CSV import accepts only labels and cards."
            )},
        }, "required": ["file"]}},
        responses={
            201: OpenApiResponse(
                BoardImportResponseSerializer,
                description=(
                    "The new board: its fields at the top level and under `board`, plus the "
                    "import summary under both `import_summary` and `summary` (#1903)."
                ),
            ),
            **{code: ImportErrorSerializer for code in (400, 401, 403, 404, 429)},
        },
    )
    @action(detail=False, methods=["post"], url_path="import", parser_classes=[LimitedMultiPartParser],
            throttle_classes=[BoardImportThrottle])
    def import_board(self, request):
        """Import a board from a Visiban JSON or CSV export file."""
        file = request.FILES.get("file")
        if not file:
            return Response({"detail": "No file provided.", "code": ImportErrorCode.NO_FILE}, status=status.HTTP_400_BAD_REQUEST)

        max_size = getattr(django_settings, "MAX_UPLOAD_SIZE", 10 * 1024 * 1024)
        if file.size > max_size:
            return Response(
                {"detail": f"File too large. Maximum size is {max_size // (1024 * 1024)} MB.", "code": ImportErrorCode.FILE_TOO_LARGE},
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
                {"detail": "Unsupported file format. Upload a .json or .csv file.", "code": ImportErrorCode.UNSUPPORTED_FORMAT},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # Validated before the file is read so a bad ``options`` field fails
        # fast and never reaches the transaction (#119).
        options, error = _parse_import_options(request.data.get("options"), options_serializer)
        if error:
            return Response({"detail": error, "code": ImportErrorCode.INVALID_OPTIONS}, status=status.HTTP_400_BAD_REQUEST)
        return importer(request, file, options)

    def _resolve_import_group(self, request):
        """Return the Group instance if group_id is provided, else None."""
        group_id = request.data.get("group_id")
        if not group_id:
            return None
        from groups.views import resolve_group_for_board_placement

        return resolve_group_for_board_placement(request.user, group_id)

    @staticmethod
    def _lock_import_group(group, user):
        """Take the target group ``FOR KEY SHARE`` before the board insert; 404 if it is gone.

        Call inside the import's ``transaction.atomic()``, before
        ``Board.objects.create``. The same group -> board order as every other
        board placement (``groups.services.lock_group_for_board_placement``,
        #1638): an import into a group deleted after ``_resolve_import_group``
        answers 404, the answer for an unknown group, instead of failing the
        new board's deferred group foreign key at COMMIT (#1719). A delete
        that arrives during the import waits for it and then detaches the
        board. ``user`` is then judged against the group-admin rule again on a
        re-read of the group (the rule ``_resolve_import_group`` applied).
        """
        if group is None:
            return
        from django.http import Http404
        from groups.services import lock_group_for_board_placement

        if not lock_group_for_board_placement(group.pk):
            raise Http404
        # Resolved before this transaction; judge the caller against the
        # group re-read inside it, so a change committed since is seen (a
        # fresh read, not a wait: see security-invariants Rule 6).
        from groups.views import require_group_admin_reread

        require_group_admin_reread(user, group)

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
        # JSONDecodeError is a ValueError, and so is the "too many digits"
        # refusal of a huge integer literal; deep nesting raises
        # RecursionError (#1507). Only the type is logged: the message can
        # quote the file.
        except (UnicodeDecodeError, ValueError, RecursionError) as exc:
            logger.warning("Board JSON import rejected — malformed payload: %s", type(exc).__name__)
            return Response({"detail": "The uploaded file is not valid JSON.", "code": ImportErrorCode.INVALID_FILE}, status=status.HTTP_400_BAD_REQUEST)

        if not isinstance(data, dict):
            return Response({"detail": "Invalid JSON: expected an object at the top level.", "code": ImportErrorCode.INVALID_FILE}, status=status.HTTP_400_BAD_REQUEST)

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

        # Sample-board flow (#1452): move the file's dates to the import day
        # before validation, so shifted values face the same checks as any other.
        shift_from = options.get("shift_dates_from")
        # #1949: a file that carries its own ``date_anchor`` (the shipped
        # samples, however they arrive: the gallery, "choose a file", a curl
        # download, an API client) is shifted from it by default. Read here in
        # the importer rather than in the import modal so every caller gets
        # the same board from the same file; an explicit ``shift_dates_from``
        # always wins and ``shift_dates: false`` opts out. A file without the
        # key is imported exactly as before, and so is one whose value is not
        # a string (null, a number, a list): an anchor is only ever written as
        # a ``YYYY-MM-DD`` string, and the import dialog (which offers the
        # opt-out) only recognizes a string, so the two agree on what counts.
        # A string anchor is always validated strictly.
        if shift_from is None and options.get("shift_dates", True) and isinstance(data.get("date_anchor"), str):
            anchor = ImportDateAnchorSerializer(data={"date_anchor": data["date_anchor"]})
            if not anchor.is_valid():
                return Response(
                    {"detail": (
                        f"The file's 'date_anchor' is invalid: {anchor.errors['date_anchor'][0]} "
                        "Send the import option shift_dates as false to import its dates as written."
                    )},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            shift_from = anchor.validated_data["date_anchor"].isoformat()
            # Reported like a sent option, so the response and the persisted
            # ``board.created`` event say which anchor the dates moved from.
            options = {**options, "shift_dates_from": shift_from}
        if shift_from:
            # ``shift_dates_to`` (#1949) picks the day the board is dated
            # around; the default is today on the shift clock (UTC).
            shift_to = options.get("shift_dates_to")
            target = datetime.date.fromisoformat(shift_to) if shift_to else shift_today()
            shift_board_dates(data, (target - datetime.date.fromisoformat(shift_from)).days)
        elif "shift_dates_to" in options:
            # Nothing shifts (opted out, or no source date): a target was not
            # applied, so options_applied must not claim one.
            options = {k: v for k, v in options.items() if k != "shift_dates_to"}

        # Schema version guard — warn on missing (pre-versioning files) or future versions.
        # The current importer understands schema_version 1 and 2.  Files without the field
        # are treated as version 0 (pre-1.0 exports) and imported on a best-effort basis.
        # v2 adds archived_at per card, movement_type, movement notes, and comment created_at.
        _SUPPORTED_SCHEMA_VERSION = 2
        schema_version = data.get("schema_version", 0)
        if isinstance(schema_version, bool) or not isinstance(schema_version, int):
            return Response({"detail": "'schema_version' must be an integer."}, status=status.HTTP_400_BAD_REQUEST)
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
                {"detail": f"Import contains {card_count} cards, which exceeds the limit of {_IMPORT_MAX_CARDS}.", "code": ImportErrorCode.LIMIT_EXCEEDED},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if column_count > _IMPORT_MAX_COLUMNS:
            return Response(
                {"detail": f"Import contains {column_count} columns, which exceeds the limit of {_IMPORT_MAX_COLUMNS}.", "code": ImportErrorCode.LIMIT_EXCEEDED},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if swimlane_count > _IMPORT_MAX_SWIMLANES:
            return Response(
                {"detail": f"Import contains {swimlane_count} swimlanes, which exceeds the limit of {_IMPORT_MAX_SWIMLANES}.", "code": ImportErrorCode.LIMIT_EXCEEDED},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Validate required fields
        if "name" not in data:
            return Response({"detail": "Missing required field: name"}, status=status.HTTP_400_BAD_REQUEST)
        if not data.get("columns"):
            return Response({"detail": "Missing required field: columns"}, status=status.HTTP_400_BAD_REQUEST)
        if not data.get("swimlanes"):
            return Response({"detail": "Missing required field: swimlanes"}, status=status.HTTP_400_BAD_REQUEST)

        # Per-item shape checks (#1451). The loops below call ``.get()`` on every
        # entry, so a non-object entry (``"movements": ["x"]``) would raise
        # AttributeError and surface as a 500. Reject it here with a 400 that
        # names the index, the same way #921 / #1185 handle the top-level lists.
        for _list_name, _label in (("columns", "Column"), ("swimlanes", "Swimlane"), ("labels", "Label")):
            for _i, _item in enumerate(data.get(_list_name, [])):
                if not isinstance(_item, dict):
                    return Response(
                        {"detail": f"{_label} at index {_i} must be an object"},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                # A missing name used to reach ``item["name"]`` inside the
                # transaction and raise KeyError (500). An empty string has
                # always imported, so it stays accepted.
                if not isinstance(_item.get("name"), str):
                    return Response(
                        {"detail": f"{_label} at index {_i}: name must be a string"},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
        for _ci, _card in enumerate(data.get("cards", [])):
            if not isinstance(_card, dict):
                return Response(
                    {"detail": f"Card at index {_ci} must be an object"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            for _child, _child_label in (
                ("comments", "comment"), ("movements", "movement"),
                ("activities", "activity"), ("checklist", "checklist item"),
                ("blocks", "block"), ("gate_transitions", "gate transition"),
            ):
                _items = _card.get(_child, [])
                if not isinstance(_items, list):
                    return Response(
                        {"detail": f"Card at index {_ci}: '{_child}' must be a list"},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                for _ji, _entry in enumerate(_items):
                    if not isinstance(_entry, dict):
                        return Response(
                            {"detail": f"Card at index {_ci}, {_child_label} at index {_ji} must be an object"},
                            status=status.HTTP_400_BAD_REQUEST,
                        )
                    # Names/usernames feed dict lookups and ``.lower()``: only
                    # str (or null/absent) is safe.
                    _str_keys = {
                        "movements": (
                            "from_column", "to_column", "from_swimlane", "to_swimlane", "moved_by",
                            "imported_from_username",
                        ),
                        "activities": ("actor", "imported_from_username"),
                        "blocks": ("blocked_by", "unblocked_by", "imported_from_username"),
                        # Only the new key: a comment's ``author`` was never
                        # read, and a non-string one is still ignored (#1702).
                        "comments": ("imported_from_username",),
                        "checklist": ("assignee",),
                        "gate_transitions": ("actor", "imported_from_username"),
                    }.get(_child, ())
                    for _k in _str_keys:
                        if _is_truthy_non_string(_entry.get(_k)):
                            return Response(
                                {"detail": f"Card at index {_ci}, {_child_label} at index {_ji}: '{_k}' must be a string"},
                                status=status.HTTP_400_BAD_REQUEST,
                            )
            if _is_truthy_non_string(_card.get("title")):
                return Response(
                    {"detail": f"Card at index {_ci}: 'title' must be a string"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if _is_truthy_non_string(_card.get("assignee")):
                return Response(
                    {"detail": f"Card at index {_ci}: 'assignee' must be a string"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            # Label references are looked up in a dict; a list/dict entry is
            # unhashable and would raise TypeError there. Other hashable
            # entries (0, False, null) never matched a label and imported fine.
            _refs = _card.get("labels", [])
            if not isinstance(_refs, list) or any(isinstance(_r, (list, dict)) for _r in _refs):
                return Response(
                    {"detail": f"Card at index {_ci}: 'labels' must be a list of names"},
                    status=status.HTTP_400_BAD_REQUEST,
                )

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
            # Echoed values go through _bounded_repr (#1507): a 10 MB string
            # must not come back in the 400.
            for _key in ("archived_at", "blocked_at"):
                _v = _card.get(_key)
                if _timestamp_error(_v, _parse_dt):
                    return Response(
                        {"detail": f"Card at index {_ci}: invalid timestamp for '{_key}': {_bounded_repr(_v)}"},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
            _due = _card.get("due_date")
            if _timestamp_error(_due, _parse_date):
                return Response(
                    {"detail": f"Card at index {_ci}: invalid due_date: {_bounded_repr(_due)}"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            # #445: a checklist item's due date, same rule as the card's.
            for _ji, _entry in enumerate(_card.get("checklist", [])):
                _v = _entry.get("due_date")
                if _timestamp_error(_v, _parse_date):
                    return Response(
                        {"detail": (
                            f"Card at index {_ci}, checklist item at index {_ji}: "
                            f"invalid due_date: {_bounded_repr(_v)}"
                        )},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
            for _child, _child_label, _key in (
                ("comments", "comment", "created_at"),
                ("movements", "movement", "moved_at"),
                ("activities", "activity", "created_at"),
                ("blocks", "block", "blocked_at"),
                ("blocks", "block", "unblocked_at"),
                ("gate_transitions", "gate transition", "created_at"),
            ):
                for _ji, _entry in enumerate(_card.get(_child, [])):
                    _v = _entry.get(_key)
                    if _timestamp_error(_v, _parse_dt):
                        return Response(
                            {"detail": (
                                f"Card at index {_ci}, {_child_label} at index {_ji}: "
                                f"invalid '{_key}': {_bounded_repr(_v)}"
                            )},
                            status=status.HTTP_400_BAD_REQUEST,
                        )

        # Types, ranges, lengths, NULs, duplicate names/positions and
        # child-collection caps (#1507) — see the comment above the helpers.
        _err = _validate_json_import_values(data)
        if _err:
            return Response({"detail": _err}, status=status.HTTP_400_BAD_REQUEST)

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
                    {"detail": f"Card at index {_ci} references undefined column: {_bounded_repr(_col_ref)}"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            _sw_ref = _card.get("swimlane")
            if not isinstance(_sw_ref, str) or _sw_ref not in _valid_sw_names:
                return Response(
                    {"detail": f"Card at index {_ci} references undefined swimlane: {_bounded_repr(_sw_ref)}"},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        # Custom field schemas (#371 card fields, #1140 row fields). Board
        # structure like columns and swimlanes, so always imported rather than
        # behind an option; validated here, before the transaction, like every
        # other 400 above.
        card_field_defs, _err = _validate_import_field_definitions(
            data.get("custom_fields"), CustomFieldDefinitionSerializer,
            CustomFieldDefinition, "show_on_card", "custom_fields",
        )
        if _err:
            return Response({"detail": _err}, status=status.HTTP_400_BAD_REQUEST)
        swimlane_field_defs, _err = _validate_import_field_definitions(
            data.get("swimlane_custom_fields"), SwimlaneCustomFieldDefinitionSerializer,
            SwimlaneCustomFieldDefinition, "show_on_row", "swimlane_custom_fields",
        )
        if _err:
            return Response({"detail": _err}, status=status.HTTP_400_BAD_REQUEST)
        lane_details_cap, _err = _validate_import_lane_tiers(
            swimlane_field_defs, data.get("lane_details_cap")
        )
        if _err:
            return Response({"detail": _err}, status=status.HTTP_400_BAD_REQUEST)
        parent_settings, _err = _validate_import_parent_settings(data)
        if _err:
            return Response({"detail": _err}, status=status.HTTP_400_BAD_REQUEST)
        # Stage tracks and lane exceptions (#1921) name dimension fields of
        # this file's ``custom_fields``, the way a card's column names a column.
        _dimension_names = {d["name"] for d in card_field_defs if d.get("is_dimension")}
        for _list_name, _label, _key in (
            ("columns", "Column", "tracks"), ("swimlanes", "Swimlane", "not_applicable_tracks"),
        ):
            for _i, _item in enumerate(data[_list_name]):
                for _name in _item.get(_key) or ():
                    if _name not in _dimension_names:
                        return Response(
                            {"detail": (
                                f"{_label} at index {_i}: '{_key}' references a field that is not "
                                f"a dimension in 'custom_fields': {_bounded_repr(_name)}"
                            )},
                            status=status.HTTP_400_BAD_REQUEST,
                        )

        field_sets, _err = _validate_import_field_sets(
            data.get("field_sets"), {d["name"] for d in card_field_defs},
            {sw["name"] for sw in data["swimlanes"] if isinstance(sw, dict)},
        )
        if _err:
            return Response({"detail": _err}, status=status.HTTP_400_BAD_REQUEST)

        explicit_name = request.data.get("name")
        if explicit_name and (problem := _text_error(explicit_name, _field_max_length(Board, "name"))):
            return Response({"detail": f"'name' {problem}", "code": ImportErrorCode.INVALID_NAME}, status=status.HTTP_400_BAD_REQUEST)

        group = self._resolve_import_group(request)
        # An explicit ``name`` is used exactly as given; only the default is
        # prefixed and de-duplicated (#1446).
        board_name = explicit_name or _imported_board_name(data["name"], request.user, group)
        skipped = _json_skip_counts(data, options)

        with _json_import_write_guard(), transaction.atomic():
            self._lock_import_group(group, request.user)
            board = Board.objects.create(
                name=board_name,
                description=data.get("description", ""),
                owner=request.user,
                group=group,
                lane_details_cap=lane_details_cap,
                **parent_settings,
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
                    color=_import_color(col, "#6B7280", skipped),
                    wip_limit=col.get("wip_limit"),
                    weight_limit=col.get("weight_limit"),
                    allow_card_creation=col.get("allow_card_creation", i == 0),
                    is_done=col.get("is_done", False),
                    # Already validated by _policy_error; normalized here so
                    # an import stores what a REST write would (#1101).
                    policy=normalize_policy(col.get("policy")),
                )
                for i, col in enumerate(col_data)
            ])
            column_map = {col["name"]: obj for col, obj in zip(col_data, col_objs)}
            # Gated stages (#1102): validated above to be none or 2..cap
            # unique names per column. Imported, like every structure row,
            # without the limit checks a REST write applies.
            sub_column_map = {
                (sc.column.name, sc.name): sc
                for sc in SubColumn.objects.bulk_create([
                    SubColumn(column=column_map[col["name"]], position=p, name=name)
                    for col in col_data
                    for p, name in enumerate(col.get("sub_columns") or ())
                ])
            }

            # Create swimlanes — bulk_create avoids one INSERT per swimlane.
            sw_data = data["swimlanes"]
            sw_objs = Swimlane.objects.bulk_create([
                Swimlane(
                    board=board,
                    name=sw["name"],
                    position=sw.get("position", i),
                    color=_import_color(sw, "#3B82F6", skipped),
                    contact_email=sw.get("contact_email", ""),
                    notes=sw.get("notes", ""),
                    # Row limits (#1150), restored as exported: an import
                    # never checks them, like the column limits above. The
                    # counted columns are exported by name and re-keyed to
                    # this board's new column ids.
                    wip_limit=sw.get("wip_limit"),
                    weight_limit=sw.get("weight_limit"),
                    limit_enforcement=sw.get("limit_enforcement"),
                    # Lane health status (#2243); a file from before 1.3
                    # has no key and imports as "no status".
                    health_status=sw.get("health_status"),
                    limit_column_ids=(
                        sorted({column_map[name].pk for name in sw["limit_columns"]})
                        if sw.get("limit_columns") else None
                    ),
                )
                for i, sw in enumerate(sw_data)
            ])
            swimlane_map = {sw["name"]: obj for sw, obj in zip(sw_data, sw_objs)}

            # Create labels — bulk_create avoids one INSERT per label. With the
            # ``labels`` option off, label_map stays empty, which also drops
            # every card label link and its LABEL_CHANGE activity below (#119).
            lbl_data = data.get("labels", []) if options["labels"] else []
            lbl_objs = Label.objects.bulk_create([
                Label(board=board, name=lbl["name"], color=_import_color(lbl, "#EAB308", skipped))
                for lbl in lbl_data
            ])
            label_map = {lbl["name"]: obj for lbl, obj in zip(lbl_data, lbl_objs)}

            # Custom field definitions, then the per-swimlane values. Values
            # are bulk-created, which skips the ``custom_field_value_changed``
            # signal — the same as every other row an import writes, none of
            # which is a user edit.
            card_field_map = {
                obj.name: obj
                for obj in CustomFieldDefinition.objects.bulk_create([
                    CustomFieldDefinition(board=board, position=i, **attrs)
                    for i, attrs in enumerate(card_field_defs)
                ])
            }
            swimlane_field_map = {
                obj.name: obj
                for obj in SwimlaneCustomFieldDefinition.objects.bulk_create([
                    SwimlaneCustomFieldDefinition(board=board, position=i, **attrs)
                    for i, attrs in enumerate(swimlane_field_defs)
                ])
            }
            # Stage tracks and lane exceptions (#1921), by dimension name;
            # every name was checked against these definitions above.
            StageTrack.objects.bulk_create([
                StageTrack(column=column_map[col["name"]], field_definition=card_field_map[name], position=p)
                for col in col_data
                for p, name in enumerate(col.get("tracks") or ())
            ])
            SwimlaneTrackException.objects.bulk_create([
                SwimlaneTrackException(
                    swimlane=swimlane_map[sw["name"]], field_definition=card_field_map[name],
                    created_by=request.user,
                )
                for sw in sw_data
                for name in sw.get("not_applicable_tracks") or ()
            ])
            # Field sets (#2570), by field and swimlane name; every name was
            # checked against this file above.
            for i, fs in enumerate(field_sets):
                field_set = CustomFieldSet.objects.create(
                    board=board, position=i, name=fs["name"], description=fs["description"],
                    default_size=fs["default_size"], scope=fs["scope"],
                )
                if fs["scope"] == CustomFieldSet.Scope.SWIMLANES:
                    field_set.swimlanes.set([swimlane_map[n] for n in fs["swimlanes"] if n in swimlane_map])
                CustomFieldDefinition.objects.filter(
                    pk__in=[card_field_map[n].pk for n in fs["fields"]],
                ).update(field_set=field_set)
            if swimlane_field_map:
                SwimlaneCustomFieldValue.objects.bulk_create([
                    SwimlaneCustomFieldValue(
                        swimlane=swimlane_map[sw["name"]], field_definition=definition, value=value,
                    )
                    for sw in sw_data
                    for definition, value in _import_field_values(
                        sw.get("custom_field_values"), swimlane_field_map,
                        "SWIMLANE_CUSTOM_FIELD_VALIDATORS",
                    )
                ])

            # Bulk-load all assignee usernames so the card loop does not issue
            # a per-card query (#420). History rows (movement ``moved_by``,
            # activity ``actor``) are not resolved to accounts: they are
            # attributed to the importer and keep the file's name as text
            # (#1675), see _imported_from_username.
            all_usernames = {
                card_data["assignee"]
                for card_data in data.get("cards", [])
                if card_data.get("assignee")
            }
            # #445: checklist assignees go through the same resolver (Rule 5):
            # the importer's visible pool only; an unmatched name imports the
            # item unassigned.
            if options["checklist"]:
                all_usernames |= {
                    ci["assignee"]
                    for card_data in data.get("cards", [])
                    for ci in card_data.get("checklist", [])
                    if ci.get("assignee")
                }
            user_map = _resolve_import_users(all_usernames, request.user, group)

            # ---------- Phase 1: build Card instances (no DB writes yet) ----------
            # We defer all per-card related objects until after bulk_create returns
            # PKs.  Keyed lists accumulate data that needs those PKs.
            valid_priorities = {c[0] for c in Card.Priority.choices}
            valid_event_types = {e[0] for e in CardActivity.EventType.choices}
            valid_movement_types = {t[0] for t in CardMovement.MovementType.choices}
            valid_gate_causes = {c[0] for c in CardGateTransition.Cause.choices}

            cards_to_create = []
            # Parallel list: the raw card_data dict for each Card instance so we
            # can correlate after bulk_create assigns PKs.
            cards_raw = []
            card_created_at = []          # exported created_at to restore, or None (#1906)
            import_now = django_timezone.now()

            # ``cards`` off imports structure (and labels) only; everything
            # below hangs off a card, so it is skipped with it (#119).
            for card_data in (data.get("cards", []) if options["cards"] else []):
                # Validated above: every card's column/swimlane names a
                # definition in this payload, and the maps are keyed by exactly
                # those names, so both lookups hit.
                column = column_map[card_data["column"]]
                swimlane = swimlane_map[card_data["swimlane"]]

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
                if assignee_username and assignee is None:
                    skipped["assignees"] += 1

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
                    # Range-checked against the column's sub-columns (#1102).
                    gates_passed=card_data.get("gates_passed", 0),
                    created_by=request.user,
                )
                # Restore archived state directly on the instance — bulk_create
                # respects explicitly set field values so no UPDATE pass is needed.
                if card_data.get("archived_at"):
                    card_obj.archived_at = card_data["archived_at"]
                # Manual blocked state (#1149) is card state, like archived_at,
                # so it is restored whatever the history option says; the
                # matching open CardBlock row is written in phase 2.
                blocked_at = _aware_timestamp(card_data.get("blocked_at"))
                if blocked_at is not None:
                    card_obj.blocked_at = blocked_at
                    card_obj.blocked_reason = card_data["blocked_reason"].strip()

                cards_to_create.append(card_obj)
                cards_raw.append(card_data)
                card_created_at.append(
                    _imported_card_created_at(card_data, options["history"], import_now)
                )

            # Single INSERT for all cards.  PostgreSQL returns PKs in insertion
            # order, so cards_to_create[i].pk aligns with cards_raw[i] after this.
            Card.objects.bulk_create(cards_to_create)

            # created_at is auto_now_add, which overwrites any value set before
            # the INSERT, so the file's date is written in a second pass
            # (#1906) — the same way history timestamps are below.
            dated_cards = []
            for card_obj, ts in zip(cards_to_create, card_created_at):
                if ts:
                    card_obj.created_at = ts
                    dated_cards.append(card_obj)
            if dated_cards:
                Card.objects.bulk_update(dated_cards, ["created_at"], batch_size=_IMPORT_BACKFILL_BATCH)

            # ---------- Phase 2: build related objects using the assigned PKs ----------
            label_through = Card.labels.through
            label_through_objs = []

            # Auto-generated activities (weight, labels, checklist)
            auto_activities = []

            comments_to_create = []       # (CardComment obj, created_at str or None)
            checklists_to_create = []

            movements_to_create = []      # (CardMovement obj, moved_at str or None)
            blocks_to_create = []         # CardBlock objs (#1149)
            gate_transitions_to_create = []  # CardGateTransition objs (#1102)
            imported_activities = []      # (CardActivity obj, created_at str or None)
            external_refs_to_create = []
            field_values_to_create = []

            def _imported_gate_transition(gt_data, movement_objs, **identity):
                """One imported gate transition (#1102), live card or deleted (#2413), or None.

                ``identity`` is as for ``_imported_movement``. An unknown
                ``kind`` is dropped and an unknown ``cause`` becomes
                ``import``. ``movement_objs`` are the same card's (or deleted
                entry's) imported movements, in file order, for
                ``movement_index``.
                """
                if not _restorable_gate_transition(gt_data):
                    return None
                cause = gt_data.get("cause")
                if not isinstance(cause, str) or cause not in valid_gate_causes:
                    cause = CardGateTransition.Cause.IMPORT
                gt_col_name = gt_data.get("column") or ""
                gt_col = column_map.get(gt_col_name)
                sub_name = gt_data.get("sub_column") or ""
                sub_obj = sub_column_map.get((gt_col_name, sub_name)) if gt_col else None
                # Re-link to the movement by its index in this card's
                # exported list; an absent or out-of-range index leaves
                # the link null (the file has no other safe key).
                mv_index = gt_data.get("movement_index")
                linked_mv = (
                    movement_objs[mv_index]
                    if isinstance(mv_index, int) and not isinstance(mv_index, bool)
                    and 0 <= mv_index < len(movement_objs)
                    else None
                )
                return CardGateTransition(
                    **identity,
                    movement=linked_mv,
                    # bulk_create skips CardGateTransition.save().
                    column=gt_col,
                    column_name=gt_col.name if gt_col else gt_col_name,
                    column_uid=gt_col.uid if gt_col else "",
                    sub_column_name=sub_name,
                    sub_column_uid=sub_obj.uid if sub_obj else "",
                    kind=gt_data["kind"],
                    from_index=gt_data.get("from_index", 0),
                    to_index=gt_data.get("to_index", 0),
                    reason=gt_data.get("reason", ""),
                    cause=cause,
                    actor=request.user,
                    imported_from_username=_imported_from_username(gt_data, "actor"),
                    created_at=_aware_timestamp(gt_data.get("created_at")) or import_now,
                )

            def _imported_movement(mv_data, **identity):
                """One imported movement row, on a live card or a deleted one (#1796).

                ``identity`` is ``card_id``, ``board_id``, ``card_uid`` and
                ``card_title``; ``card_id`` is None for a deleted card's row.
                """
                from_col_name = mv_data.get("from_column") or ""
                to_col_name = mv_data.get("to_column") or ""
                from_sw_name = mv_data.get("from_swimlane") or ""
                to_sw_name = mv_data.get("to_swimlane") or ""
                from_col = column_map.get(from_col_name)
                to_col = column_map.get(to_col_name)
                from_sw = swimlane_map.get(from_sw_name)
                to_sw = swimlane_map.get(to_sw_name)
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
                return CardMovement(
                    # bulk_create skips CardMovement.save(), which
                    # fills board and the card snapshot on every other
                    # path (#1469): ``identity`` carries them.
                    **identity,
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
                    # Imported history is the importer's record of
                    # what the file says happened (#1675).
                    moved_by=request.user,
                    imported_from_username=_imported_from_username(mv_data, "moved_by"),
                    notes=mv_data.get("notes", ""),
                    movement_type=movement_type,
                    from_gates_passed=mv_data.get("from_gates_passed"),
                    from_gates_open=mv_data.get("from_gates_open"),
                    to_gates_passed=mv_data.get("to_gates_passed"),
                )

            def _imported_activity(act_data, event_type, **identity):
                """One imported activity row; ``identity`` as for movements (#1796)."""
                return CardActivity(
                    **identity,
                    event_type=event_type,
                    from_value=act_data.get("from_value", ""),
                    to_value=act_data.get("to_value", ""),
                    actor=request.user,
                    imported_from_username=_imported_from_username(act_data, "actor"),
                    # Kept only where History shows it (#2199), so a
                    # file cannot park text on other rows.
                    item_text=(
                        act_data.get("item_text") if event_type in _ITEM_TEXT_EVENT_TYPES else None
                    ),
                )

            for card_obj, card_data in zip(cards_to_create, cards_raw):
                card_pk = card_obj.pk

                for definition, value in _import_field_values(
                    card_data.get("custom_field_values"), card_field_map,
                    "CUSTOM_FIELD_VALIDATORS",
                ):
                    field_values_to_create.append(CustomFieldValue(
                        card_id=card_pk, field_definition=definition, value=value,
                    ))

                # The file's own history for this card. When it already
                # records a label, weight or checklist change, that entry —
                # with its real actor and timestamp — is the history, and the
                # synthetic one below (actor = importer, time = now) would
                # double it on every export→import round trip. Skipped per
                # event type, not per item: a file that carries any checklist
                # history is trusted to carry all of it.
                history_types = set()
                if options["history"]:
                    for act in card_data.get("activities", []):
                        event_type = act.get("event_type") if isinstance(act, dict) else None
                        if isinstance(event_type, str) and event_type in valid_event_types:
                            history_types.add(event_type)

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
                if (
                    options["history"] and card_obj.weight and card_obj.weight > 1
                    and CardActivity.EventType.WEIGHT_CHANGE not in history_types
                ):
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
                if card_labels and CardActivity.EventType.LABEL_CHANGE not in history_types:
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
                            # The file's author is kept as text, never matched
                            # to an account, as for history rows (#1675, #1702).
                            imported_from_username=_imported_from_username(comment_data, "author"),
                        ),
                        comment_data.get("created_at"),
                    ))

                # Checklist items + checklist-added activities
                checklist_source = card_data.get("checklist", []) if options["checklist"] else []
                for ci_idx, checklist_data in enumerate(checklist_source):
                    item_assignee = (
                        user_map.get(checklist_data["assignee"].lower())
                        if checklist_data.get("assignee") else None
                    )
                    if checklist_data.get("assignee") and item_assignee is None:
                        skipped["assignees"] += 1  # #2198
                    item = CardChecklist(
                        card_id=card_pk,
                        text=checklist_data.get("text", ""),
                        is_checked=checklist_data.get("is_checked", False),
                        position=ci_idx,
                        assignee=item_assignee,
                        due_date=checklist_data.get("due_date") or None,
                        # The importer is the actor; a NULL creator would make
                        # every imported item moderator-only (#1943).
                        created_by=request.user,
                    )
                    checklists_to_create.append(item)
                    if CardActivity.EventType.CHECKLIST_ITEM_ADDED not in history_types:
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
                card_movement_objs = []  # for gate_transitions' movement_index
                for mv_data in (card_data.get("movements", []) if history_on else []):
                    mv_obj = _imported_movement(
                        mv_data, card_id=card_pk, board_id=card_obj.board_id,
                        card_uid=card_obj.uid, card_title=card_obj.title,
                    )
                    card_movement_objs.append(mv_obj)
                    movements_to_create.append((mv_obj, mv_data.get("moved_at")))

                blocks_to_create.extend(
                    _imported_card_blocks(card_obj, card_data, column_map, request.user, history_on)
                )

                # Gate history (#1102), behind ``history`` like movements and
                # blocks, and attributed the same way (Rule 5): the importer is
                # the actor and the file's ``actor`` is kept only as text.
                for gt_data in (card_data.get("gate_transitions", []) if history_on else []):
                    gt_obj = _imported_gate_transition(
                        gt_data, card_movement_objs, card_id=card_pk, board_id=card_obj.board_id,
                        card_uid=card_obj.uid, card_title=card_obj.title,
                    )
                    if gt_obj is not None:
                        gate_transitions_to_create.append(gt_obj)

                # Imported activity log entries (field-change history)
                for act_data in (card_data.get("activities", []) if history_on else []):
                    event_type = act_data.get("event_type", "")
                    # isinstance guard must short-circuit before the membership
                    # test: an unhashable event_type (list/dict) crashes `in
                    # valid_event_types` with an unhandled TypeError instead of
                    # being skipped like any other unknown event type (#1185).
                    if not isinstance(event_type, str) or event_type not in valid_event_types:
                        continue
                    imported_activities.append((
                        _imported_activity(act_data, event_type, card_id=card_pk),
                        act_data.get("created_at"),
                    ))

            # Retained history of hard-deleted cards (#1796), behind ``history``
            # like every card's own history and attributed the same way (Rule
            # 5): the importer is the actor, the file's name is kept as text.
            # The rows get no card (there is none to give them), the new board,
            # and the file's uid and title snapshot, so they land in this
            # board's History exactly as they sat in the source board's.
            for entry in (data.get("deleted_card_history", []) if options["history"] else []):
                identity = {
                    "card_id": None, "board_id": board.pk,
                    "card_uid": entry.get("card_uid", ""), "card_title": entry.get("card_title", ""),
                }
                entry_movement_objs = []  # for gate_transitions' movement_index
                for mv_data in entry.get("movements", []):
                    mv_obj = _imported_movement(mv_data, **identity)
                    entry_movement_objs.append(mv_obj)
                    movements_to_create.append((mv_obj, mv_data.get("moved_at")))
                # Retained blocks and gate history (#2413), attributed the same way.
                blocks_to_create.extend(
                    _imported_deleted_card_blocks(entry, identity, column_map, request.user)
                )
                for gt_data in entry.get("gate_transitions", []):
                    gt_obj = _imported_gate_transition(gt_data, entry_movement_objs, **identity)
                    if gt_obj is not None:
                        gate_transitions_to_create.append(gt_obj)
                for act_data in entry.get("activities", []):
                    event_type = act_data.get("event_type", "")
                    if not isinstance(event_type, str) or event_type not in valid_event_types:
                        continue
                    imported_activities.append(
                        (_imported_activity(act_data, event_type, **identity), act_data.get("created_at"))
                    )

            # ---------- Phase 3: bulk-insert all related objects ----------

            # Labels M2M — ignore_conflicts in case the same label appears twice
            # in a card's label list (defensive; exporter should deduplicate).
            if label_through_objs:
                label_through.objects.bulk_create(label_through_objs, ignore_conflicts=True)

            # Auto-generated activities (no timestamp backfill needed — these are
            # produced by the import itself, not carried over from the export).
            cards_by_pk = {c.pk: c for c in cards_to_create}
            if auto_activities:
                _fill_activity_snapshots(auto_activities, cards_by_pk)
                CardActivity.objects.bulk_create(auto_activities)

            # Checklist items
            if checklists_to_create:
                CardChecklist.objects.bulk_create(checklists_to_create)

            if external_refs_to_create:
                CardExternalRef.objects.bulk_create(external_refs_to_create)

            if field_values_to_create:
                CustomFieldValue.objects.bulk_create(field_values_to_create)

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
                        [obj for obj, _ in backfill], ["created_at"], batch_size=_IMPORT_BACKFILL_BATCH,
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
                        [obj for obj, _ in backfill], ["moved_at"], batch_size=_IMPORT_BACKFILL_BATCH,
                    )

            # Card relations (#1448), after the cards exist. Deduplicated in
            # _relation_pairs, so unique_together cannot fire.
            if options["cards"]:
                relations_to_create = _imported_relations(data, cards_to_create, request.user)
                if relations_to_create:
                    CardRelation.objects.bulk_create(relations_to_create)

            # Manual blocks (#1149). Timestamps are set on the instances, and
            # blocked_at is a plain default rather than auto_now_add, so no
            # backfill pass is needed.
            if blocks_to_create:
                CardBlock.objects.bulk_create(blocks_to_create)
            # Gate history (#1102); created_at is a plain default, as above.
            if gate_transitions_to_create:
                CardGateTransition.objects.bulk_create(gate_transitions_to_create)

            # Imported activities with optional created_at backfill.
            if imported_activities:
                act_objs = [a for a, _ in imported_activities]
                _fill_activity_snapshots(act_objs, cards_by_pk)
                CardActivity.objects.bulk_create(act_objs)
                backfill = [
                    (obj, ts) for obj, ts in imported_activities if ts
                ]
                if backfill:
                    for obj, ts in backfill:
                        obj.created_at = ts
                    CardActivity.objects.bulk_update(
                        [obj for obj, _ in backfill], ["created_at"], batch_size=_IMPORT_BACKFILL_BATCH,
                    )

            # Re-fetch with annotations so BoardSerializer.get_member_count / card_count /
            # is_starred reads from annotation fast-paths instead of 3 fallback queries.
            # Register the broadcast inside the atomic block so a rollback does
            # not fire a phantom board.created event for a board that never
            # committed (#815).
            from django.db.models import Exists, OuterRef
            board = annotate_board_counts(Board.objects.select_related("owner", "group")).annotate(
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
            def _broadcast_created(
                bid=board_id, bd=event_payload, gid=group_id, eid=event_id, aid=request.user.id,
            ):
                _broadcast.broadcast_board_event(
                    bid, _broadcast.EVT_BOARD_CREATED, bd, event_id=eid, actor_id=aid,
                )
                # Group-scoped broadcast powers the boards-list live view (#753).
                if gid is not None:
                    from groups.broadcast import broadcast_group_event
                    broadcast_group_event(gid, _broadcast.EVT_BOARD_CREATED, bd, actor_id=aid)
            transaction.on_commit(_broadcast_created)
        import_summary = {"options_applied": options, "skipped": skipped}
        return Response(_import_envelope(board_data, import_summary), status=status.HTTP_201_CREATED)

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
        responses={200: OpenApiResponse(TrelloImportPreviewSerializer, description="Returned for ?dry_run=true."),
                   201: OpenApiResponse(TrelloImportConfirmSerializer, description="Returned for ?confirm=true."),
                   **{code: ImportErrorSerializer for code in (400, 401, 403, 404, 413, 429)}},
    )
    @action(detail=False, methods=["post"], url_path="import/trello", parser_classes=[LimitedMultiPartParser],
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
                {"detail": "Specify exactly one of ?dry_run=true or ?confirm=true.", "code": ImportErrorCode.INVALID_MODE},
                status=status.HTTP_400_BAD_REQUEST,
            )

        file = request.FILES.get("file")
        if not file:
            return Response({"detail": "No file provided.", "code": ImportErrorCode.NO_FILE}, status=status.HTTP_400_BAD_REQUEST)

        max_size = django_settings.VISIBAN_IMPORT_MAX_SIZE
        too_large = Response(
            {"detail": f"File too large. The maximum size for a Trello import is {max_size // (1024 * 1024)} MB.", "code": ImportErrorCode.FILE_TOO_LARGE},
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
                {"detail": "The uploaded file does not match the file that was previewed. Preview it again.", "code": ImportErrorCode.FILE_MISMATCH},
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
            return Response({"detail": exc.detail, "code": exc.code}, status=status.HTTP_400_BAD_REQUEST)

        preview = {**plan.preview, "file_sha256": file_sha256}
        if dry_run:
            return Response(preview, status=status.HTTP_200_OK)

        raw_name = request.data.get("name")
        if raw_name is not None and not isinstance(raw_name, str):
            return Response({"detail": "'name' must be a string.", "code": ImportErrorCode.INVALID_NAME}, status=status.HTTP_400_BAD_REQUEST)
        board_name = (raw_name or "").replace("\x00", "").strip() or None
        try:
            with transaction.atomic():
                self._lock_import_group(group, request.user)
                board = _trello.execute_plan(plan, request.user, group=group, board_name=board_name)
                board_data = self._broadcast_imported_board(request, board)
        except _trello.TrelloImportError as exc:
            return Response({"detail": exc.detail, "code": exc.code}, status=status.HTTP_400_BAD_REQUEST)

        summary = {k: preview[k] for k in ("counts", "result", "warnings", "unmappable")}
        return Response(_import_envelope(board_data, summary), status=status.HTTP_201_CREATED)

    def _broadcast_imported_board(self, request, board):
        """Serialize the new board and schedule its ``board.created`` broadcast.

        Must run inside the import's atomic block: the event row is persisted
        in the same transaction (#1114) and the broadcast is deferred with
        ``on_commit`` so a rollback cannot announce a board that never
        existed (#815).
        """
        from django.db.models import Exists, OuterRef
        # Correlated-subquery counts (annotate_board_counts), not Count() over
        # two joined relations: joining members and cards multiplies them
        # inside the import transaction (#1723, #1765).
        board = annotate_board_counts(Board.objects.select_related("owner", "group")).annotate(
            _is_starred=Exists(BoardFavorite.objects.filter(board=OuterRef("pk"), user=request.user)),
        ).get(pk=board.pk)
        board_data = BoardSerializer(board, context={"request": request}).data
        board_id, group_id = board.pk, board.group_id
        event_id = _broadcast.persist_board_event(
            board_id, _broadcast.EVT_BOARD_CREATED, board_data, actor_id=request.user.id,
        )

        def _broadcast_created(
            bid=board_id, bd=board_data, gid=group_id, eid=event_id, aid=request.user.id,
        ):
            _broadcast.broadcast_board_event(
                bid, _broadcast.EVT_BOARD_CREATED, bd, event_id=eid, actor_id=aid,
            )
            if gid is not None:
                from groups.broadcast import broadcast_group_event
                broadcast_group_event(gid, _broadcast.EVT_BOARD_CREATED, bd, actor_id=aid)
        transaction.on_commit(_broadcast_created)
        return board_data

    def _import_csv(self, request, file, options):
        """Create a new board from a CSV file with one card per row.

        Required headers: Title, Column, Swimlane.
        Optional headers: Description, Priority, Weight, Labels (comma-separated),
                          Assignee (username), Due Date (YYYY-MM-DD).
                          An Assignee that matches no user on this instance, or a
                          blank cell, imports the card unassigned.

        Columns, swimlanes, and labels are auto-created from the values seen in
        the file. Their order matches their first appearance in the CSV so that
        column/swimlane ordering reflects the original export. All objects are
        created inside a single atomic transaction.

        ``Custom: <name>`` and ``Swimlane Custom: <name>`` columns (written by
        the CSV export) restore card and swimlane custom field values (#1449).
        A CSV carries no field type, so each becomes a ``text`` definition and
        each cell is stored exactly as written; JSON is the lossless format for
        field types and choices.
        """
        try:
            raw = file.read().decode("utf-8")
            reader = csv.DictReader(io.StringIO(raw))
            rows = list(reader)
        except (UnicodeDecodeError, csv.Error) as exc:
            return Response({"detail": f"Invalid CSV: {exc}", "code": ImportErrorCode.INVALID_FILE}, status=status.HTTP_400_BAD_REQUEST)

        if not rows:
            return Response({"detail": "CSV file is empty.", "code": ImportErrorCode.INVALID_FILE}, status=status.HTTP_400_BAD_REQUEST)

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
        # ``rows`` is non-empty, so DictReader has read a header line and
        # ``fieldnames`` is a list.
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
                {"detail": f"Import contains {len(rows)} rows, which exceeds the card limit of {_IMPORT_MAX_CARDS}.",
                 "code": ImportErrorCode.LIMIT_EXCEEDED},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Validate required headers
        required_headers = {"Title", "Column", "Swimlane"}
        # An input with no header line yields no rows and was rejected as empty
        # above, so ``reader.fieldnames`` is set here.
        headers = set(reader.fieldnames)
        missing = required_headers - headers
        if missing:
            return Response(
                {"detail": f"CSV is missing required headers: {', '.join(sorted(missing))}"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Custom field columns (#1449). Validated before the transaction, like
        # the JSON path's definitions, with the same per-board rules: every
        # derived definition is a ``text`` field, since a CSV has no type.
        card_cols, lane_cols, _err, csv_warnings = _csv_custom_columns(
            reader.fieldnames
        )
        if _err:
            return Response({"detail": _err}, status=status.HTTP_400_BAD_REQUEST)
        card_field_defs, _err = _validate_import_field_definitions(
            [{"name": n, "field_type": "text"} for _, n in card_cols],
            CustomFieldDefinitionSerializer,
            CustomFieldDefinition,
            "show_on_card",  # pragma: no mutate -- CSV-derived definitions never set show_on_card, so the pinned count is 0 whatever the attribute is called
            "Custom columns",
        )
        if _err:
            return Response({"detail": _err}, status=status.HTTP_400_BAD_REQUEST)
        lane_field_defs, _err = _validate_import_field_definitions(
            [{"name": n, "field_type": "text"} for _, n in lane_cols],
            SwimlaneCustomFieldDefinitionSerializer,
            SwimlaneCustomFieldDefinition,
            "show_on_row",  # pragma: no mutate -- CSV-derived definitions never set show_on_row, so the pinned count is 0 whatever the attribute is called
            "Swimlane Custom columns",
        )
        if _err:
            return Response({"detail": _err}, status=status.HTTP_400_BAD_REQUEST)
        lane_values, lane_warnings = _swimlane_values_from_rows(rows, lane_cols)
        csv_warnings.extend(lane_warnings)

        # Validate each row has required fields and a parseable Due Date when present.
        # The date check mirrors the JSON path's pre-transaction due_date guard: a
        # malformed value would reach DateField inside bulk_create and produce an
        # unhandled DB type error instead of a clean 400.
        from django.utils.dateparse import parse_date as _parse_date_csv
        for i, row in enumerate(rows):
            for field in ("Title", "Column", "Swimlane"):
                if not _cell(row, field):
                    return Response(
                        {"detail": f"Row {i + 2} is missing required field: {field}"},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
            # Cell values must fit the model columns before any write (#1512):
            # PostgreSQL rejects NUL bytes and over-length / out-of-range values
            # with a DataError, which would surface as a 500. Only cells the
            # chosen options actually write are checked, so a file the importer
            # used to accept (an ignored column, a skipped card or label) still
            # imports. Column and Swimlane names are always written; the rest
            # follow ``cards`` / ``labels``. The echoed value is truncated.
            # ``Custom:`` cells keep their own NUL handling (#1449).
            _checked = [
                ("Column", _field_max_length(Column, "name")),
                ("Swimlane", _field_max_length(Swimlane, "name")),
            ]
            if options["cards"]:
                _checked += [
                    ("Title", _field_max_length(Card, "title")),
                    ("Description", None),
                    ("Assignee", None),
                ]
            for _field, _max in _checked:
                _text = _cell(row, _field)
                if "\x00" in _text:
                    return Response(
                        {"detail": f"Row {i + 2}: {_field} contains a NUL byte."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                if _max is not None and len(_text) > _max:
                    return Response(
                        {"detail": f"Row {i + 2}: {_field} exceeds {_max} characters: {_bounded_text(_text)!r}"},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
            if options["labels"]:
                _label_text = _cell(row, "Labels")
                if "\x00" in _label_text:
                    return Response(
                        {"detail": f"Row {i + 2}: Labels contains a NUL byte."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                _label_max = _field_max_length(Label, "name")
                for _lbl in _label_text.split(","):
                    _lbl = _lbl.strip()
                    if len(_lbl) > _label_max:
                        return Response(
                            {"detail": f"Row {i + 2}: Labels entry exceeds {_label_max} characters: {_bounded_text(_lbl)!r}"},
                            status=status.HTTP_400_BAD_REQUEST,
                        )
            # A non-numeric Weight is never stored (it falls back to 1), so only
            # a parseable integer can overflow the column.
            _weight = _cell(row, "Weight") if options["cards"] else ""
            if _weight:
                try:
                    _weight_int = int(_weight)
                except (ValueError, TypeError):
                    _weight_int = 1
                if not _IMPORT_INT_MIN <= _weight_int <= _IMPORT_INT_MAX:
                    return Response(
                        {"detail": f"Row {i + 2}: Weight out of range: {_bounded_text(_weight)!r}"},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
            _due = _cell(row, "Due Date")
            try:
                _due_ok = not _due or _parse_date_csv(_due) is not None
            except ValueError:  # well-formed but impossible, e.g. 2020-02-30
                _due_ok = False
            if not _due_ok:
                return Response(
                    {"detail": f"Row {i + 2}: invalid Due Date: {_bounded_text(_due)!r}"},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        # Count unique columns and swimlanes from the CSV rows so we can enforce
        # the same per-import ceilings as the JSON import path.
        _IMPORT_MAX_COLUMNS = 50
        _IMPORT_MAX_SWIMLANES = 100
        unique_columns = {_cell(row, "Column") for row in rows if _cell(row, "Column")}
        unique_swimlanes = {_cell(row, "Swimlane") for row in rows if _cell(row, "Swimlane")}
        if len(unique_columns) > _IMPORT_MAX_COLUMNS:
            return Response(
                {"detail": f"Import contains {len(unique_columns)} columns, which exceeds the limit of {_IMPORT_MAX_COLUMNS}.", "code": ImportErrorCode.LIMIT_EXCEEDED},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if len(unique_swimlanes) > _IMPORT_MAX_SWIMLANES:
            return Response(
                {"detail": f"Import contains {len(unique_swimlanes)} swimlanes, which exceeds the limit of {_IMPORT_MAX_SWIMLANES}.", "code": ImportErrorCode.LIMIT_EXCEEDED},
                status=status.HTTP_400_BAD_REQUEST,
            )

        explicit_name = request.data.get("name")
        if explicit_name and (problem := _text_error(explicit_name, _field_max_length(Board, "name"))):
            return Response({"detail": f"'name' {problem}", "code": ImportErrorCode.INVALID_NAME}, status=status.HTTP_400_BAD_REQUEST)

        group = self._resolve_import_group(request)
        # A CSV carries no board name, so the default is derived from the
        # uploaded filename without its extension (#1446). An explicit
        # ``name`` is used exactly as given.
        board_name = explicit_name or _imported_board_name(
            os.path.splitext(file.name or "")[0], request.user, group
        )

        # What the chosen options leave out (#119). A CSV row has no comments,
        # checklist, or history.
        skipped = dict.fromkeys(_IMPORT_SKIP_KEYS, 0)
        if not options["cards"]:
            skipped["cards"] = len(rows)
        if not options["cards"] or not options["labels"]:
            skipped["label_refs"] = sum(
                len({n.strip() for n in _cell(row, "Labels").split(",") if n.strip()})
                for row in rows
            )

        with transaction.atomic():
            self._lock_import_group(group, request.user)
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
                col_name = _cell(row, "Column")
                if col_name and col_name not in column_map:
                    column_map[col_name] = None  # pragma: no mutate -- placeholder overwritten with the created Column before any read

                sw_name = _cell(row, "Swimlane")
                if sw_name and sw_name not in swimlane_map:
                    swimlane_map[sw_name] = None  # pragma: no mutate -- placeholder overwritten with the created Swimlane before any read

                labels_str = _cell(row, "Labels") if options["labels"] else ""
                if labels_str:
                    for label_name in labels_str.split(","):
                        label_name = label_name.strip()
                        if label_name and label_name not in label_map:
                            label_map[label_name] = None  # pragma: no mutate -- placeholder overwritten with the created Label before any read

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

            # Custom field definitions and swimlane values (#1449). Row values
            # are structure, so they import whatever ``options["cards"]`` says
            # (as on the JSON path); card values follow it, further below.
            card_field_map = {
                obj.name: obj
                for obj in CustomFieldDefinition.objects.bulk_create(
                    [
                        CustomFieldDefinition(board=board, position=i, **attrs)
                        for i, attrs in enumerate(card_field_defs)
                    ]
                )
            }
            lane_field_map = {
                obj.name: obj
                for obj in SwimlaneCustomFieldDefinition.objects.bulk_create(
                    [
                        # CSV carries no tier columns, so band_visibility
                        # stays NULL: a legacy board (#2439).
                        SwimlaneCustomFieldDefinition(board=board, position=i, **attrs)
                        for i, attrs in enumerate(lane_field_defs)
                    ]
                )
            }
            lane_value_objs = []
            for lane_name, by_field in lane_values.items():
                for field_name, cell in by_field.items():
                    stored = _csv_cell_value(
                        lane_field_map[field_name],
                        cell,
                        "SWIMLANE_CUSTOM_FIELD_VALIDATORS",
                        f"Swimlane {_bounded_text(lane_name)!r}",
                        csv_warnings,
                    )
                    if stored is not None:
                        lane_value_objs.append(
                            SwimlaneCustomFieldValue(
                                swimlane=swimlane_map[lane_name],
                                field_definition=lane_field_map[field_name],
                                value=stored,
                            )
                        )
            if lane_value_objs:
                SwimlaneCustomFieldValue.objects.bulk_create(lane_value_objs)

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
            # The export writes the assignee's username; resolve with the same
            # rule as the JSON importer so a CSV round trip keeps assignees (#1442).
            csv_user_map = _resolve_import_users(
                (_cell(row, "Assignee") for row in rows),
                request.user, group,
            ) if options["cards"] else {}
            # ``cards`` off imports structure (and labels) only (#119).
            for row in (rows if options["cards"] else []):
                # Every row's Column/Swimlane is non-empty (validated above) and
                # every such name was created into these maps, so both lookups hit.
                column = column_map[_cell(row, "Column")]
                swimlane = swimlane_map[_cell(row, "Swimlane")]

                priority = _cell(row, "Priority").lower() or "medium"
                if priority not in [c[0] for c in Card.Priority.choices]:
                    priority = "medium"

                due_date = _cell(row, "Due Date") or None
                assignee_name = _cell(row, "Assignee")
                assignee = csv_user_map.get(assignee_name.lower()) if assignee_name else None
                if assignee_name and assignee is None:
                    skipped["assignees"] += 1  # #2198

                weight_str = _cell(row, "Weight") or "1"
                try:
                    weight = int(weight_str)
                except (ValueError, TypeError):
                    weight = 1

                cards_to_create.append(Card(
                    board=board,
                    column=column,
                    swimlane=swimlane,
                    title=_cell(row, "Title"),
                    description=_cell(row, "Description"),
                    priority=priority,
                    assignee=assignee,
                    due_date=due_date,
                    weight=weight,
                    position=0,
                    created_by=request.user,
                ))
                valid_rows.append(row)

            created_cards = Card.objects.bulk_create(cards_to_create)

            # Card custom field values, stored as written (#1449). Bulk-created,
            # so the value-changed signal does not fire — an import is not an edit.
            card_value_objs = []
            for card, row in zip(created_cards, valid_rows):
                for header, field_name in card_cols:
                    stored = _csv_cell_value(
                        card_field_map[field_name],
                        _cell(row, header),
                        "CUSTOM_FIELD_VALIDATORS",
                        f"Card {_bounded_text(card.title)!r}",
                        csv_warnings,
                    )
                    if stored is not None:
                        card_value_objs.append(
                            CustomFieldValue(
                                card_id=card.pk,
                                field_definition=card_field_map[field_name],
                                value=stored,
                            )
                        )
            if card_value_objs:
                CustomFieldValue.objects.bulk_create(card_value_objs)

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
                labels_str = _cell(row, "Labels")
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
                _fill_activity_snapshots(activities)
                CardActivity.objects.bulk_create(activities)
            if label_through_objs:
                label_through_model.objects.bulk_create(label_through_objs, ignore_conflicts=True)

            # Re-fetch with annotations so BoardSerializer.get_member_count / card_count /
            # is_starred reads from annotation fast-paths instead of 3 fallback queries.
            # Register the broadcast inside the atomic block so a rollback does
            # not fire a phantom board.created event for a board that never
            # committed (#815).
            from django.db.models import Exists, OuterRef
            board = annotate_board_counts(Board.objects.select_related("owner", "group")).annotate(
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
            def _broadcast_created(
                bid=board_id, bd=event_payload, gid=group_id, eid=event_id, aid=request.user.id,
            ):
                _broadcast.broadcast_board_event(
                    bid, _broadcast.EVT_BOARD_CREATED, bd, event_id=eid, actor_id=aid,
                )
                # Group-scoped broadcast powers the boards-list live view (#753).
                if gid is not None:
                    from groups.broadcast import broadcast_group_event
                    broadcast_group_event(gid, _broadcast.EVT_BOARD_CREATED, bd, actor_id=aid)
            transaction.on_commit(_broadcast_created)
        import_summary = {
            "options_applied": options,
            "skipped": skipped,
            "warnings": _cap_warnings(csv_warnings),
        }
        return Response(_import_envelope(board_data, import_summary), status=status.HTTP_201_CREATED)

    # Schema only (#1783). The action is a file download
    # (Content-Disposition: attachment): CSV by default (also ?format=csv),
    # the JSON export with ?format=json. Without this the schema showed the viewset's Board serializer as a JSON body.
    # The JSON variant is described by its top-level keys; the nested entries
    # are documented in docs/api/boards.md and keyed by name, not id.
    @extend_schema(
        parameters=[
            OpenApiParameter(
                name="format", type=OpenApiTypes.STR, location=OpenApiParameter.QUERY,
                required=False, enum=["csv", "json"],
                description="`json` for the JSON export; `csv` or omitted for CSV (the default).",
            ),
        ],
        responses={
            (200, "text/csv"): OpenApiResponse(
                response=OpenApiTypes.STR,
                description="CSV export, one row per card (the default).",
            ),
            (200, "application/json"): OpenApiResponse(
                response=inline_serializer(
                    name="BoardExport",
                    fields={
                        "schema_version": drf_serializers.IntegerField(),
                        "name": drf_serializers.CharField(),
                        "description": drf_serializers.CharField(),
                        "lane_details_cap": drf_serializers.IntegerField(),
                        "parent_name_singular": drf_serializers.CharField(),
                        "parent_name_plural": drf_serializers.CharField(),
                        "cards_can_have_children": drf_serializers.BooleanField(),
                        "columns": drf_serializers.ListField(child=drf_serializers.DictField()),
                        "swimlanes": drf_serializers.ListField(child=drf_serializers.DictField()),
                        "labels": drf_serializers.ListField(child=drf_serializers.DictField()),
                        "custom_fields": drf_serializers.ListField(child=drf_serializers.DictField()),
                        "swimlane_custom_fields": drf_serializers.ListField(child=drf_serializers.DictField()),
                        "cards": drf_serializers.ListField(child=drf_serializers.DictField()),
                        # Retained history of hard-deleted cards (#1796).
                        "deleted_card_history": drf_serializers.ListField(child=drf_serializers.DictField()),
                        # Card relations (#1448): {from, kind, to}, indexes into "cards".
                        "relations": drf_serializers.ListField(child=drf_serializers.DictField()),
                    },
                ),
                description="JSON export (`?format=json`).",  # pragma: no mutate -- drf-spectacular emits one description per status code, from the first media type, so the document is unchanged
            ),
        },
    )
    @action(
        detail=True, methods=["get"], throttle_classes=[BoardExportThrottle],
        renderer_classes=[*api_settings.DEFAULT_RENDERER_CLASSES, CsvExportRenderer],
    )
    def export(self, request, pk=None):
        """Export board data as CSV or JSON.

        Requires board membership (any role). A caller below the board's
        ``export_min_role`` gets 403 ``export_restricted``; owners and site
        admins bypass the threshold.
        """
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
                {"detail": "Board export requires board membership."},  # pragma: no mutate -- fail-closed guard, unreachable via the API; killing it needs a patched-role or DB-level test
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
                    "min_role": _effective_export_min_role(board),
                },
                status=status.HTTP_403_FORBIDDEN,
            )
        export_format = request.query_params.get(
            "format",
            "csv",  # pragma: no mutate -- any format other than json takes the CSV branch
        )
        safe_name = slugify(board.name) or "board"
        stamp = _export_timestamp(request.user)

        # Not materialized (#1962): both branches read it through
        # _iter_export_cards, in chunks, so the model instances and
        # their prefetched history are bounded per chunk however large the
        # board. The output text is still assembled in memory.
        cards = (
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
                "checklist_items__assignee",
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
        )
        # Row count for the audit log (#842), counted by each branch as it
        # walks the cards (no extra COUNT query).
        row_count = 0

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
                # Sub-columns and stage tracks (#1102, #1921) ride the column
                # prefetch so the per-column block below issues no query.
                Prefetch(
                    "columns",
                    queryset=Column.objects.prefetch_related(
                        "sub_columns", "stage_tracks__field_definition",
                    ),
                ),
                # The swimlane prefetch carries its row field values (#1140) so
                # the per-swimlane block below reads from cache rather than
                # issuing two queries per row.
                Prefetch(
                    "swimlanes",
                    queryset=Swimlane.objects.prefetch_related(
                        _swimlane_custom_field_prefetch(), "track_exceptions__field_definition",
                    ),
                ),
            )
            columns = board.columns.all()
            swimlanes = board.swimlanes.all()
            # From the prefetch cache: no query.
            column_names_by_id = {col.pk: col.name for col in columns}
            labels = board.labels.all()
            # Manual block history (#1149): JSON only, so the CSV branch does
            # not pay for queries it never reads. On the queryset, so it runs
            # per chunk like the other prefetches.
            cards = cards.prefetch_related(
                "blocks__blocked_by", "blocks__unblocked_by",
                # Gate history (#1102), JSON only like blocks.
                "gate_transitions__actor",
            )

            cards_data = []
            # Card pk -> its index in ``cards_data``: how ``relations`` (#1448)
            # name a card.
            card_index = {}
            # Uids of the cards emitted, so deleted_card_history below does
            # not also carry one deleted while the export ran.
            exported_uids = set()
            for card in _iter_export_cards(cards):
                card_index[card.pk] = len(cards_data)
                exported_uids.add(card.uid)
                # Use .all() + sorted() to read from the prefetch cache instead of
                # issuing an ORDER BY query per card for movements, comments, and checklist.
                movements = sorted(card.movements.all(), key=lambda m: (m.moved_at, m.id))
                movement_index = {mv.pk: i for i, mv in enumerate(movements)}
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
                    # #371. Additive, so schema_version stays at 2. Restored on
                    # JSON import against the "custom_fields" definitions below
                    # (#1447), and by CSV import from its `Custom: ` columns (#1449).
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
                            # Additive (#1702); null unless the comment was imported.
                            "imported_from_username": c.imported_from_username,
                        }
                        for c in sorted(card.comments.all(), key=lambda c: c.created_at)
                    ],
                    "checklist": [
                        {
                            "text": item.text,
                            "is_checked": item.is_checked,
                            # Additive (#445); null when unset.
                            "assignee": item.assignee.username if item.assignee else None,
                            "due_date": item.due_date.isoformat() if item.due_date else None,
                        }
                        for item in sorted(card.checklist_items.all(), key=lambda i: i.position)
                    ],
                    "movements": [
                        _movement_export_entry(mv)
                        for mv in movements
                    ],
                    "activities": [
                        _activity_export_entry(act)
                        for act in sorted(card.activities.all(), key=lambda a: a.created_at)
                    ],
                    # Manual blocked state (#1149). Additive, like
                    # custom_field_values: schema_version stays 2, and an
                    # importer that predates these keys ignores them. The
                    # current state rides on the card; `blocks` is the full
                    # history, oldest first, restored with the history option.
                    "blocked_at": card.blocked_at.isoformat() if card.blocked_at else None,
                    "blocked_reason": card.blocked_reason,
                    "blocks": [
                        _block_export_entry(blk)
                        for blk in sorted(card.blocks.all(), key=lambda b: (b.blocked_at, b.pk))
                    ],
                    # Gated stages (#1102). Additive: the card's sub-column
                    # index and its gate history, oldest first, restored with
                    # the history option.
                    "gates_passed": card.gates_passed,
                    "gate_transitions": [
                        _gate_transition_export_entry(gt, movement_index)
                        for gt in sorted(card.gate_transitions.all(), key=lambda g: (g.created_at, g.pk))
                    ],
                })

            payload = {
                "schema_version": 2,
                "name": board.name,
                "description": board.description,
                # #2439. Additive key; an import of an export without it uses the default.
                "lane_details_cap": board.lane_details_cap,
                # #2454. Additive keys; an import of an export without them keeps the defaults.
                "parent_name_singular": board.parent_name_singular,
                "parent_name_plural": board.parent_name_plural,
                "cards_can_have_children": board.cards_can_have_children,
                "columns": [
                    {
                        "name": col.name,
                        "position": col.position,
                        "color": col.color,
                        "wip_limit": col.wip_limit,
                        "weight_limit": col.weight_limit,
                        "allow_card_creation": col.allow_card_creation,
                        "is_done": col.is_done,
                        "policy": col.policy,
                        # Gated stage (#1102) and its tracks (#1921), by name.
                        # Additive keys; an older importer ignores them.
                        "sub_columns": [sc.name for sc in col.sub_columns.all()],
                        "tracks": [st.field_definition.name for st in col.stage_tracks.all()],
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
                        # Row limits (#1150). Additive keys in schema_version
                        # 2, like custom_field_values: an older importer
                        # ignores them. Counted columns by name, since a file
                        # keys columns by name and an import mints new ids.
                        "wip_limit": sw.wip_limit,
                        "weight_limit": sw.weight_limit,
                        "limit_enforcement": sw.limit_enforcement,
                        "limit_columns": (
                            [column_names_by_id[pk] for pk in sw.limit_column_ids if pk in column_names_by_id]
                            or None
                        ) if sw.limit_column_ids is not None else None,
                        # Lane health status (#2243), the manual pin; an
                        # additive key, last so existing key order holds.
                        "health_status": sw.health_status,
                        # Dimensions not applicable in this lane (#1921), by name.
                        "not_applicable_tracks": sorted(
                            exc.field_definition.name for exc in sw.track_exceptions.all()
                        ),
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
                        # Threshold marking (#1122): additive display-only
                        # config; the values in "cards" are unchanged. An
                        # older server ignores these keys on import.
                        "threshold_direction": cf.threshold_direction,
                        "threshold_warn": cf.threshold_warn,
                        "threshold_alert": cf.threshold_alert,
                        "threshold_warn_days": cf.threshold_warn_days,
                        "threshold_alert_days": cf.threshold_alert_days,
                        # Dimension fields (#1921): additive; restored on import.
                        "is_dimension": cf.is_dimension,
                        "choice_resolutions": cf.choice_resolutions,
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
                        # #2439; null on a board whose tiers were never set.
                        "band_visibility": sf.band_visibility,
                    }
                    for sf in swimlane_field_definitions
                ],
                # Field sets (#2570), re-keyed by name like stage tracks:
                # members by custom field name, lanes by swimlane name.
                # Additive; schema_version stays 2.
                "field_sets": [
                    {
                        "name": fs.name,
                        "description": fs.description,
                        "position": fs.position,
                        "default_size": fs.default_size,
                        "scope": fs.scope,
                        "fields": [
                            f.name for f in sorted(fs.fields.all(), key=lambda f: (f.position, f.id))
                        ],
                        "swimlanes": sorted(sw.name for sw in fs.swimlanes.all()),
                    }
                    for fs in board.custom_field_sets.prefetch_related("fields", "swimlanes").order_by("position", "id")
                ],
                "cards": cards_data,
                # Retained history of hard-deleted cards (#1796), after "cards"
                # so every existing key keeps its place. Additive: schema_version
                # stays 2, and an importer that predates the key ignores it.
                "deleted_card_history": _deleted_card_history_export(board, exported_uids),
                # Card relations (#1448), last so every existing key keeps its
                # place. Additive: schema_version stays 2.
                "relations": _relations_export(board, card_index),
            }
            row_count = len(cards_data)

            content = json.dumps(payload, indent=2, ensure_ascii=False)
            response = HttpResponse(content, content_type="application/json")
            response["Content-Disposition"] = f'attachment; filename="{safe_name}-{stamp}.json"'
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
        for card in _iter_export_cards(cards):
            row_count += 1
            movements = sorted(card.movements.all(), key=lambda m: (m.moved_at, m.id))
            # Sorted in Python, not .order_by(): labels are prefetched, and Label has no
            # Meta.ordering, so the DB returns them in arbitrary order. A stable
            # order keeps exports diffable and the CSV shape tests deterministic.
            label_names = ", ".join(s(n) for n in sorted(lb.name for lb in card.labels.all()))
            last_moved = movements[-1].moved_at.isoformat() if movements else ""
            history_parts = []
            for mv in movements:
                # Snapshot fallback (#2052): a deleted column leaves the FK null.
                from_col = s(mv.from_column.name if mv.from_column else mv.from_column_name)
                to_col = s(mv.to_column.name if mv.to_column else mv.to_column_name)
                moved_by = s(mv.moved_by.username) if mv.moved_by else ""
                # An imported row (#1675) names its importer, then the source
                # file's username, inside the same segment. The source name is
                # free text from an import file, so the record and segment
                # separators (and line breaks) are replaced in it: the record
                # must keep its four pipe-delimited parts.
                if mv.imported_from_username is not None:
                    # Sanitize before the emptiness check: a name made only of
                    # formula prefix characters ("==") sanitizes to "".
                    source = s(" ".join(_CSV_HISTORY_SEPARATORS_RE.sub(" ", mv.imported_from_username).split()))
                    moved_by += f" (imported, originally {source})" if source else " (imported)"
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
        response["Content-Disposition"] = f'attachment; filename="{safe_name}-{stamp}.csv"'
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
            data = BoardExportLogSerializer(
                page,
                many=True,
                context={"request": request},  # pragma: no mutate -- no field of BoardExportLogSerializer or its nested actor serializer reads the request
            ).data
            return self.get_paginated_response(data)
        data = BoardExportLogSerializer(
            qs,
            many=True,
            context={"request": request},  # pragma: no mutate -- no field of BoardExportLogSerializer or its nested actor serializer reads the request
        ).data
        return Response(data)
