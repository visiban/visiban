"""Trello JSON export → new Visiban board (#456).

Three stages, deliberately separated so the dry-run preview and the confirmed
import run the exact same mapping logic and can never disagree:

1. ``parse_trello_export(raw)`` — decode and strictly type-check the untrusted
   upload into a normalized ``TrelloExport``. Pure; no ORM access.
2. ``build_plan(export, options, matched_user_ids)`` — resolve the mapping
   (columns, labels, swimlanes, cards, checklists, comments) and the preview
   summary. Pure and deterministic; the only DB-derived input is the member
   match, computed separately by ``match_members``.
3. ``execute_plan(plan, ...)`` — the only function that writes. Everything is
   inserted with ``bulk_create`` inside one atomic block.

Why synchronous: the repo has no task queue yet (the issue lists one as a 1.7
prerequisite). The import is bounded instead by the upload size cap
(``VISIBAN_IMPORT_MAX_SIZE``), the per-import count caps below, and the
``board_import`` throttle. Moving it onto a background worker is a follow-up.

Why ``bulk_create`` and never the card service layer: ``create_card`` sends
@mention notifications and single-row ``CardMovement`` saves fire
``notify_on_card_moved``. Trello descriptions are full of @handles, so going
through those paths would notify real users about an import.
"""

from __future__ import annotations

import datetime
import json
import math
import re
from dataclasses import dataclass, field

from django.db import transaction
from django.db.models import Q
from django.db.models.functions import Lower
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from accounts.models import User
from groups.models import GroupMembership

from ..models import (
    Board, BoardMembership, Card, CardChecklist, CardComment, Column, Label, Swimlane,
)

# ---------------------------------------------------------------------------
# Limits. Documented in docs/features/trello-import.md. Size alone is not a
# sufficient guard: 25 MB of JSON can hold an enormous number of tiny objects,
# and these counts are what actually bound the synchronous request.
# ---------------------------------------------------------------------------
MAX_LISTS = 50
MAX_CARDS = 5000
MAX_LABELS = 200
MAX_CHECKLIST_ITEMS = 20000
MAX_COMMENTS = 20000
MAX_MEMBERS = 1000
MAX_ACTIONS = 50000
MAX_ATTACHMENTS = 20000
MAX_REFS_PER_CARD = 500  # idLabels / idMembers entries on one card
# Upper bound on JSON containers ("{" + "[" bytes, which over-counts braces
# inside strings). Checked on the raw bytes BEFORE json.loads, because the
# per-kind caps below can only run after parsing — and 25 MB of "{}," parses
# into millions of dicts before any per-kind cap is reached. Even within the
# caps, peak parse memory is roughly 10x the upload size (decoded text plus the
# parsed object tree), i.e. about 250 MB at the 25 MB default.
# A realistic 5000-card export stays well under this.
MAX_JSON_CONTAINERS = 1_000_000

# Model field limits — imported strings are truncated to fit rather than
# rejected, because Trello allows longer values than Visiban does.
_MAX_COLUMN_NAME = 255
_MAX_SWIMLANE_NAME = 255
_MAX_LABEL_NAME = 50
_MAX_CARD_TITLE = 500
_MAX_CHECKLIST_TEXT = 500
# Match the API's own write limits (CardCommentSerializer.body 10,000;
# card description 50,000) so imported rows are editable through the API
# without first being rejected as too long.
_MAX_COMMENT_BODY = 10_000
_MAX_CARD_DESCRIPTION = 50_000
_MAX_BOARD_NAME = 255

# Trello's UI JSON export includes at most this many actions. Comments are
# actions, so a board that hits the ceiling may be missing older comments.
TRELLO_ACTION_EXPORT_LIMIT = 1000

DEFAULT_SWIMLANE_NAME = "Unassigned"
DEFAULT_COLUMN_COLOR = "#6B7280"
DEFAULT_LABEL_COLOR = "#6B7280"

# Trello stores label colors as names. Visiban stores ``#RRGGBB``; a color
# name must never reach ``Label.color``. Values approximate Trello's palette.
TRELLO_COLOR_HEX = {
    "green": "#4BCE97", "green_light": "#BAF3DB", "green_dark": "#1F845A",
    "yellow": "#F5CD47", "yellow_light": "#F8E6A0", "yellow_dark": "#946F00",
    "orange": "#FEA362", "orange_light": "#FEDEC8", "orange_dark": "#C25100",
    "red": "#F87168", "red_light": "#FFD5D2", "red_dark": "#C9372C",
    "purple": "#9F8FEF", "purple_light": "#DFD8FD", "purple_dark": "#6E5DC6",
    "blue": "#579DFF", "blue_light": "#CCE0FF", "blue_dark": "#0C66E4",
    "sky": "#6CC3E0", "sky_light": "#C6EDFB", "sky_dark": "#227D9B",
    "lime": "#94C748", "lime_light": "#D3F1A7", "lime_dark": "#5B7F24",
    "pink": "#E774BB", "pink_light": "#FDD0EC", "pink_dark": "#AE4787",
    "black": "#8590A2", "black_light": "#DCDFE4", "black_dark": "#626F86",
}

_HEX_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")
_OBJECT_ID_RE = re.compile(r"^[0-9a-fA-F]{24}$")

MAPPING_KEYS = frozenset({
    "swimlane_label_ids", "default_swimlane_name", "include_archived_lists", "add_matched_members",
})


class TrelloImportError(Exception):
    """A client-side problem with the upload or mapping. The view maps it to 400."""

    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


# ---------------------------------------------------------------------------
# Normalized export
# ---------------------------------------------------------------------------

@dataclass
class TList:
    id: str
    name: str
    closed: bool
    pos: float
    index: int


@dataclass
class TLabel:
    id: str
    name: str
    color: str | None


@dataclass
class TCheckItem:
    name: str
    complete: bool
    pos: float


@dataclass
class TChecklist:
    id: str
    card_id: str
    name: str
    pos: float
    items: list[TCheckItem]


@dataclass
class TAttachment:
    name: str
    url: str


@dataclass
class TCard:
    id: str
    name: str
    desc: str
    list_id: str
    label_ids: list[str]
    member_ids: list[str]
    closed: bool
    pos: float
    due: str | None
    date_last_activity: str | None
    attachments: list[TAttachment]
    has_start: bool
    custom_field_items: int
    has_plugin_data: bool
    index: int


@dataclass
class TMember:
    id: str
    full_name: str
    username: str


@dataclass
class TComment:
    card_id: str
    member_id: str
    author_name: str
    text: str
    date: str | None


@dataclass
class TrelloExport:
    name: str
    desc: str
    lists: list[TList]
    cards: list[TCard]
    labels: list[TLabel]
    checklists: list[TChecklist]
    members: list[TMember]
    comments: list[TComment]
    action_count: int
    custom_field_defs: int
    board_plugin_data: int
    stickers: int


# ---------------------------------------------------------------------------
# Stage 1: parse + strict validation
# ---------------------------------------------------------------------------

def _reject_constant(value):
    # json.loads accepts NaN/Infinity by default; they are not valid JSON and
    # would otherwise flow into numeric comparisons as float('nan').
    raise TrelloImportError(f"Invalid JSON: unsupported constant {value}.")


def _clean(value: str) -> str:
    # PostgreSQL text columns reject NUL; an unstripped \x00 would surface as
    # a 500 at insert time instead of a clean import.
    return value.replace("\x00", "")


def _str(obj: dict, key: str, where: str, *, required: bool = False, default: str = "") -> str:
    value = obj.get(key)
    if value is None:
        if required:
            raise TrelloImportError(f"{where}: missing required field '{key}'.")
        return default
    if not isinstance(value, str):
        raise TrelloImportError(f"{where}: '{key}' must be a string.")
    return _clean(value)


def _bool(obj: dict, key: str, where: str) -> bool:
    value = obj.get(key, False)
    if value is None:
        return False
    if not isinstance(value, bool):
        raise TrelloImportError(f"{where}: '{key}' must be a boolean.")
    return value


def _num(obj: dict, key: str, where: str) -> float:
    value = obj.get(key, 0)
    if value is None:
        return 0.0
    # Trello occasionally serializes positions as strings ("bottom"/"top") in
    # older exports; anything non-numeric sorts as 0 rather than failing.
    if isinstance(value, bool):
        raise TrelloImportError(f"{where}: '{key}' must be a number.")
    if isinstance(value, (int, float)):
        # A 400-digit integer overflows float(); 1e999 parses to inf. Both
        # would otherwise 500 or poison the sort — treat them as position 0.
        try:
            result = float(value)
        except OverflowError:
            return 0.0
        return result if math.isfinite(result) else 0.0
    if isinstance(value, str):
        return 0.0
    raise TrelloImportError(f"{where}: '{key}' must be a number.")


def _list(obj: dict, key: str, where: str, *, required: bool = False) -> list:
    value = obj.get(key)
    if value is None:
        if required:
            raise TrelloImportError(f"{where}: missing required field '{key}'.")
        return []
    if not isinstance(value, list):
        raise TrelloImportError(f"{where}: '{key}' must be a list.")
    return value


def _dict_items(items: list, where: str):
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            raise TrelloImportError(f"{where}[{i}] must be an object.")
        yield i, item


def _str_list(obj: dict, key: str, where: str) -> list[str]:
    values = _list(obj, key, where)
    for v in values:
        if not isinstance(v, str):
            raise TrelloImportError(f"{where}: '{key}' must be a list of strings.")
    return values


def parse_trello_export(raw: bytes) -> TrelloExport:
    """Decode and validate a Trello board JSON export.

    Strict on the type of every field the importer consumes; unknown fields
    are ignored because Trello's export format is undocumented and drifts.
    """
    if raw.count(b"{") + raw.count(b"[") > MAX_JSON_CONTAINERS:
        raise TrelloImportError(
            "The export contains too many objects to import. Split the board in Trello and import the parts."
        )
    try:
        text = raw.decode("utf-8-sig")  # tolerate a BOM
    except UnicodeDecodeError:
        raise TrelloImportError("The uploaded file is not valid UTF-8 JSON.")
    try:
        data = json.loads(text, parse_constant=_reject_constant)
    except TrelloImportError:
        raise
    except RecursionError:
        raise TrelloImportError("The uploaded file is nested too deeply to be a Trello export.")
    except ValueError:
        raise TrelloImportError("The uploaded file is not valid JSON.")
    # The decoded text is as large as the upload; drop it before building the
    # normalized export so peak memory holds only the parsed tree.
    del text

    if not isinstance(data, dict):
        raise TrelloImportError("Invalid Trello export: expected an object at the top level.")
    if "lists" not in data or "cards" not in data:
        raise TrelloImportError(
            "This does not look like a Trello board export: 'lists' and 'cards' are required. "
            "In Trello, use Menu → Print, export, and share → Export as JSON."
        )

    name = _str(data, "name", "Board", default="Imported Trello board").strip() or "Imported Trello board"
    desc = _str(data, "desc", "Board")

    raw_lists = _list(data, "lists", "Board", required=True)
    raw_cards = _list(data, "cards", "Board", required=True)
    raw_labels = _list(data, "labels", "Board")
    raw_checklists = _list(data, "checklists", "Board")
    raw_members = _list(data, "members", "Board")
    raw_actions = _list(data, "actions", "Board")

    if len(raw_lists) > MAX_LISTS:
        raise TrelloImportError(f"The export contains {len(raw_lists)} lists, which exceeds the limit of {MAX_LISTS}.")
    if len(raw_cards) > MAX_CARDS:
        raise TrelloImportError(f"The export contains {len(raw_cards)} cards, which exceeds the limit of {MAX_CARDS}.")
    if len(raw_labels) > MAX_LABELS:
        raise TrelloImportError(f"The export contains {len(raw_labels)} labels, which exceeds the limit of {MAX_LABELS}.")
    if len(raw_members) > MAX_MEMBERS:
        raise TrelloImportError(f"The export contains {len(raw_members)} members, which exceeds the limit of {MAX_MEMBERS}.")
    if len(raw_actions) > MAX_ACTIONS:
        raise TrelloImportError(f"The export contains {len(raw_actions)} actions, which exceeds the limit of {MAX_ACTIONS}.")
    if len(raw_checklists) > MAX_CHECKLIST_ITEMS:
        raise TrelloImportError(
            f"The export contains {len(raw_checklists)} checklists, which exceeds the limit of {MAX_CHECKLIST_ITEMS}."
        )

    lists: list[TList] = []
    for i, item in _dict_items(raw_lists, "lists"):
        where = f"lists[{i}]"
        lists.append(TList(
            id=_str(item, "id", where, required=True),
            name=_str(item, "name", where),
            closed=_bool(item, "closed", where),
            pos=_num(item, "pos", where),
            index=i,
        ))

    labels: list[TLabel] = []
    for i, item in _dict_items(raw_labels, "labels"):
        where = f"labels[{i}]"
        color = item.get("color")
        if color is not None and not isinstance(color, str):
            raise TrelloImportError(f"{where}: 'color' must be a string or null.")
        labels.append(TLabel(
            id=_str(item, "id", where, required=True),
            name=_str(item, "name", where).strip(),
            color=color,
        ))

    cards: list[TCard] = []
    total_attachments = 0
    for i, item in _dict_items(raw_cards, "cards"):
        where = f"cards[{i}]"
        attachments = []
        raw_atts = _list(item, "attachments", where)
        total_attachments += len(raw_atts)
        if total_attachments > MAX_ATTACHMENTS:
            raise TrelloImportError(f"The export contains more than {MAX_ATTACHMENTS} attachments, which exceeds the limit.")
        for key in ("idLabels", "idMembers"):
            refs = item.get(key)
            if isinstance(refs, list) and len(refs) > MAX_REFS_PER_CARD:
                raise TrelloImportError(f"{where}: '{key}' has more than {MAX_REFS_PER_CARD} entries.")
        for j, att in _dict_items(raw_atts, f"{where}.attachments"):
            awhere = f"{where}.attachments[{j}]"
            attachments.append(TAttachment(name=_str(att, "name", awhere), url=_str(att, "url", awhere)))
        due = item.get("due")
        if due is not None and not isinstance(due, str):
            raise TrelloImportError(f"{where}: 'due' must be a string or null.")
        dla = item.get("dateLastActivity")
        if dla is not None and not isinstance(dla, str):
            raise TrelloImportError(f"{where}: 'dateLastActivity' must be a string or null.")
        plugin_data = item.get("pluginData")
        cfi = item.get("customFieldItems")
        cards.append(TCard(
            id=_str(item, "id", where, required=True),
            name=_str(item, "name", where),
            desc=_str(item, "desc", where),
            list_id=_str(item, "idList", where, required=True),
            label_ids=_str_list(item, "idLabels", where),
            member_ids=_str_list(item, "idMembers", where),
            closed=_bool(item, "closed", where),
            pos=_num(item, "pos", where),
            due=due,
            date_last_activity=dla,
            attachments=attachments,
            has_start=bool(item.get("start")),
            custom_field_items=len(cfi) if isinstance(cfi, list) else 0,
            has_plugin_data=bool(plugin_data) if isinstance(plugin_data, list) else False,
            index=i,
        ))

    checklists: list[TChecklist] = []
    total_items = 0
    for i, item in _dict_items(raw_checklists, "checklists"):
        where = f"checklists[{i}]"
        items = []
        raw_items = _list(item, "checkItems", where)
        # Running total, checked before materializing this checklist's items.
        if total_items + len(raw_items) > MAX_CHECKLIST_ITEMS:
            raise TrelloImportError(
                f"The export contains more than {MAX_CHECKLIST_ITEMS} checklist items, which exceeds the limit."
            )
        for j, ci in _dict_items(raw_items, f"{where}.checkItems"):
            cwhere = f"{where}.checkItems[{j}]"
            state = _str(ci, "state", cwhere)
            items.append(TCheckItem(name=_str(ci, "name", cwhere), complete=state == "complete", pos=_num(ci, "pos", cwhere)))
        total_items += len(items)
        checklists.append(TChecklist(
            id=_str(item, "id", where, required=True),
            card_id=_str(item, "idCard", where, required=True),
            name=_str(item, "name", where).strip(),
            pos=_num(item, "pos", where),
            items=items,
        ))
    if total_items > MAX_CHECKLIST_ITEMS:
        raise TrelloImportError(
            f"The export contains {total_items} checklist items, which exceeds the limit of {MAX_CHECKLIST_ITEMS}."
        )

    members: list[TMember] = []
    for i, item in _dict_items(raw_members, "members"):
        where = f"members[{i}]"
        members.append(TMember(
            id=_str(item, "id", where, required=True),
            full_name=_str(item, "fullName", where).strip(),
            username=_str(item, "username", where).strip(),
        ))
    member_names = {m.id: (m.full_name or m.username) for m in members}

    comments: list[TComment] = []
    for i, item in _dict_items(raw_actions, "actions"):
        if item.get("type") != "commentCard":
            continue
        where = f"actions[{i}]"
        action_data = item.get("data")
        if not isinstance(action_data, dict):
            raise TrelloImportError(f"{where}: 'data' must be an object.")
        card_ref = action_data.get("card")
        if not isinstance(card_ref, dict):
            raise TrelloImportError(f"{where}: 'data.card' must be an object.")
        member_id = _str(item, "idMemberCreator", where)
        creator = item.get("memberCreator")
        creator_name = ""
        if isinstance(creator, dict):
            fn = creator.get("fullName")
            creator_name = _clean(fn).strip() if isinstance(fn, str) else ""
        date = item.get("date")
        if date is not None and not isinstance(date, str):
            raise TrelloImportError(f"{where}: 'date' must be a string.")
        comments.append(TComment(
            card_id=_str(card_ref, "id", f"{where}.data.card", required=True),
            member_id=member_id,
            author_name=member_names.get(member_id) or creator_name or "Unknown Trello member",
            text=_str(action_data, "text", f"{where}.data"),
            date=date,
        ))
    if len(comments) > MAX_COMMENTS:
        raise TrelloImportError(f"The export contains {len(comments)} comments, which exceeds the limit of {MAX_COMMENTS}.")

    board_plugin = data.get("pluginData")
    stickers = sum(
        len(c.get("stickers")) for c in raw_cards
        if isinstance(c, dict) and isinstance(c.get("stickers"), list)
    )
    custom_defs = data.get("customFields")

    return TrelloExport(
        name=name[:_MAX_BOARD_NAME],
        desc=desc,
        lists=lists,
        cards=cards,
        labels=labels,
        checklists=checklists,
        members=members,
        comments=comments,
        action_count=len(raw_actions),
        custom_field_defs=len(custom_defs) if isinstance(custom_defs, list) else 0,
        board_plugin_data=len(board_plugin) if isinstance(board_plugin, list) else 0,
        stickers=stickers,
    )


# ---------------------------------------------------------------------------
# Mapping options
# ---------------------------------------------------------------------------

@dataclass
class ImportOptions:
    swimlane_label_ids: list[str] = field(default_factory=list)
    default_swimlane_name: str = DEFAULT_SWIMLANE_NAME
    include_archived_lists: bool = False
    add_matched_members: bool = False


def parse_options(raw: str | None, export: TrelloExport) -> ImportOptions:
    """Parse the ``mapping`` form field. Absent/blank means all defaults."""
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return ImportOptions()
    if not isinstance(raw, str):
        raise TrelloImportError("'mapping' must be a JSON object.")
    try:
        data = json.loads(raw, parse_constant=_reject_constant)
    except TrelloImportError:
        raise
    except (ValueError, RecursionError):
        raise TrelloImportError("'mapping' is not valid JSON.")
    if not isinstance(data, dict):
        raise TrelloImportError("'mapping' must be a JSON object.")
    unknown = sorted(set(data) - MAPPING_KEYS)
    if unknown:
        raise TrelloImportError(f"Unknown mapping option(s): {', '.join(unknown)}.")

    opts = ImportOptions()
    label_ids = data.get("swimlane_label_ids", [])
    if not isinstance(label_ids, list) or not all(isinstance(x, str) for x in label_ids):
        raise TrelloImportError("'swimlane_label_ids' must be a list of label ids.")
    eligible = {lbl.id for lbl in export.labels if lbl.name}
    for lid in label_ids:
        if lid not in eligible:
            raise TrelloImportError(
                f"Label {lid!r} cannot become a swimlane: it is not a named label in this export."
            )
    # De-duplicate while preserving the caller's order.
    opts.swimlane_label_ids = list(dict.fromkeys(label_ids))

    name = data.get("default_swimlane_name", DEFAULT_SWIMLANE_NAME)
    if not isinstance(name, str) or not _clean(name).strip():
        raise TrelloImportError("'default_swimlane_name' must be a non-empty string.")
    opts.default_swimlane_name = _clean(name).strip()[:_MAX_SWIMLANE_NAME]

    for key in ("include_archived_lists", "add_matched_members"):
        value = data.get(key, False)
        if not isinstance(value, bool):
            raise TrelloImportError(f"'{key}' must be a boolean.")
        setattr(opts, key, value)
    return opts


# ---------------------------------------------------------------------------
# Member matching — enumeration-safe
# ---------------------------------------------------------------------------

def visible_users(user, group=None):
    """Users the importer can already see elsewhere in Visiban.

    Matching is restricted to this pool because the uploader controls the
    file: without the restriction, a one-member export with a guessed username
    turns the "matched" count into an existence oracle for any account on the
    instance. Inside the pool the oracle reveals nothing the importer could
    not already see (board co-members, group co-members, the target group).
    """
    if user.is_site_admin or user.can_access_all_content:
        return User.objects.filter(is_active=True)
    my_boards = BoardMembership.objects.filter(user=user).values("board_id")
    my_groups = GroupMembership.objects.filter(user=user).values("group_id")
    q = (
        Q(pk=user.pk)
        | Q(memberships__board_id__in=my_boards)
        | Q(group_memberships__group_id__in=my_groups)
        | Q(group_memberships__group__owner=user)
    )
    if group is not None:
        q |= Q(group_memberships__group=group) | Q(pk=group.owner_id)
    return User.objects.filter(q, is_active=True).distinct()


def match_members(export: TrelloExport, user, group=None) -> dict[str, int]:
    """Map Trello member id → Visiban user id by exact case-insensitive username.

    Only ``username`` is used — never full/display names, which are neither
    unique nor stable. ``unique_username_ci`` makes the lowercase match
    unambiguous.
    """
    wanted = {m.username.lower(): m.id for m in export.members if m.username}
    if not wanted:
        return {}
    rows = (
        visible_users(user, group)
        .annotate(_lu=Lower("username"))
        .filter(_lu__in=list(wanted))
        .values_list("_lu", "pk")
    )
    return {wanted[lu]: pk for lu, pk in rows}


# ---------------------------------------------------------------------------
# Stage 2: plan
# ---------------------------------------------------------------------------

@dataclass
class PlannedCard:
    trello_id: str
    title: str
    description: str
    column_key: str
    swimlane_key: str
    position: int
    label_ids: list[str]
    assignee_id: int | None
    due_date: datetime.date | None
    archived_at: datetime.datetime | None
    created_at: datetime.datetime | None


@dataclass
class ImportPlan:
    board_name: str
    board_description: str
    columns: list[dict]            # {key, name, position}
    labels: list[dict]             # {key(trello id), name, color}
    swimlanes: list[dict]          # {key, name, color, position}
    cards: list[PlannedCard]
    checklist_items: dict[str, list[tuple[str, bool]]]   # trello card id → [(text, checked)]
    comments: list[dict]           # {card_id, author_id|None, body, created_at}
    member_user_ids: list[int]     # to add as board members (opt-in only)
    preview: dict


def _dedupe(name: str, seen: set[str], limit: int) -> str:
    base = name[:limit]
    candidate, n = base, 2
    while candidate.lower() in seen:
        suffix = f" ({n})"
        candidate = base[: limit - len(suffix)] + suffix
        n += 1
    seen.add(candidate.lower())
    return candidate


def _parse_ts(value: str | None) -> datetime.datetime | None:
    if not value:
        return None
    # parse_datetime raises ValueError for well-formed but impossible dates
    # ("2020-02-30"), and normalizing year-1 offsets can overflow. An
    # unreadable timestamp is data to skip, never a 500.
    try:
        dt = parse_datetime(value)
        if dt is None:
            return None
        if timezone.is_naive(dt):
            dt = timezone.make_aware(dt, datetime.timezone.utc)
        dt.astimezone(datetime.timezone.utc)
    except (ValueError, OverflowError):
        return None
    return dt


def _object_id_time(trello_id: str) -> datetime.datetime | None:
    # Trello ids are MongoDB ObjectIds; the first 4 bytes are the creation
    # time in Unix seconds. Used to preserve each card's original created_at.
    if not _OBJECT_ID_RE.match(trello_id):
        return None
    try:
        return datetime.datetime.fromtimestamp(int(trello_id[:8], 16), tz=datetime.timezone.utc)
    except (ValueError, OverflowError, OSError):
        return None


def _md_escape(text: str) -> str:
    # Escape markdown/HTML metacharacters and collapse line breaks so an
    # uploaded name cannot start new blocks, links, images, or raw HTML.
    text = re.sub(r"[\r\n\t]+", " ", text)
    return re.sub(r"([\[\]()\\*_`<>!#~|])", r"\\\1", text)


def _safe_url(url: str) -> bool:
    # Only absolute http(s) URLs with no whitespace/control characters, and
    # none of `<`, `"`, or backtick, any of which could break out of the
    # markdown `<...>` link destination or an HTML attribute if the
    # markdown is ever rendered as raw HTML (defense in depth: card
    # descriptions already go through react-markdown with rehypeSanitize).
    if not url.lower().startswith(("http://", "https://")):
        return False
    if any(ch in url for ch in ("<", '"', "`")):
        return False
    return not any(ch.isspace() or ord(ch) < 32 or ch == "\x7f" for ch in url)


def _label_color(color: str | None) -> str:
    if color and color in TRELLO_COLOR_HEX:
        return TRELLO_COLOR_HEX[color]
    return DEFAULT_LABEL_COLOR


def _warn(warnings: list, code: str, message: str, count: int):
    if count:
        warnings.append({"code": code, "message": message, "count": count})


def build_plan(export: TrelloExport, options: ImportOptions, matched: dict[str, int]) -> ImportPlan:
    """Resolve every mapping decision and the preview summary. Pure."""
    warnings: list[dict] = []

    # --- Columns: Trello lists ordered by pos, re-indexed densely. ---------
    ordered_lists = sorted(export.lists, key=lambda lst: (lst.pos, lst.index))
    list_ids = {lst.id for lst in export.lists}
    closed_list_ids = {lst.id for lst in export.lists if lst.closed}
    card_count_by_list: dict[str, int] = {}
    for c in export.cards:
        card_count_by_list[c.list_id] = card_count_by_list.get(c.list_id, 0) + 1

    columns, column_preview, seen = [], [], set()
    included_list_ids = set()
    for lst in ordered_lists:
        name = lst.name.strip() or "Untitled list"
        entry = {
            "trello_id": lst.id, "name": name, "position": None,
            "card_count": card_count_by_list.get(lst.id, 0), "archived": lst.closed,
        }
        if lst.closed and not options.include_archived_lists:
            column_preview.append(entry)
            continue
        final = _dedupe(name, seen, _MAX_COLUMN_NAME)
        entry["name"] = final
        entry["position"] = len(columns)
        columns.append({"key": lst.id, "name": final, "position": len(columns)})
        column_preview.append(entry)
        included_list_ids.add(lst.id)

    # --- Labels ----------------------------------------------------------
    labels, label_preview, seen = [], [], set()
    label_by_id: dict[str, dict] = {}
    card_count_by_label: dict[str, int] = {}
    for c in export.cards:
        for lid in set(c.label_ids):
            card_count_by_label[lid] = card_count_by_label.get(lid, 0) + 1
    for lbl in export.labels:
        if lbl.id in label_by_id:
            continue  # duplicate id in a malformed export — keep the first
        fallback = (lbl.color or "label").split("_")[0].capitalize()
        final = _dedupe(lbl.name or fallback, seen, _MAX_LABEL_NAME)
        hex_color = _label_color(lbl.color)
        item = {"key": lbl.id, "name": final, "color": hex_color}
        labels.append(item)
        label_by_id[lbl.id] = item
        label_preview.append({
            "trello_id": lbl.id, "name": final, "color": hex_color,
            "original_color": lbl.color[:32] if lbl.color else None, "card_count": card_count_by_label.get(lbl.id, 0),
            "swimlane_eligible": bool(lbl.name),
        })

    # --- Swimlanes: mapped labels first (in selection order), default last.
    swimlanes, seen = [], set()
    sw_key_by_label: dict[str, str] = {}
    for lid in options.swimlane_label_ids:
        lbl = label_by_id[lid]
        name = _dedupe(lbl["name"], seen, _MAX_SWIMLANE_NAME)
        key = f"label:{lid}"
        sw_key_by_label[lid] = key
        swimlanes.append({"key": key, "name": name, "color": lbl["color"], "position": len(swimlanes)})
    if options.default_swimlane_name.lower() in seen:
        raise TrelloImportError(
            f"The default swimlane name {options.default_swimlane_name!r} is the same as a label mapped "
            "to a swimlane. Choose a different name."
        )

    # --- Cards -----------------------------------------------------------
    checklists_by_card: dict[str, list[TChecklist]] = {}
    for cl in export.checklists:
        checklists_by_card.setdefault(cl.card_id, []).append(cl)
    comment_count_by_card: dict[str, int] = {}
    for cm in export.comments:
        comment_count_by_card[cm.card_id] = comment_count_by_card.get(cm.card_id, 0) + 1

    now = timezone.now()
    add_members = options.add_matched_members
    planned: list[PlannedCard] = []
    missing_list = skipped_archived = multi_mapped = bad_due = unknown_labels = 0
    long_descriptions = long_comments = 0
    used_default = False
    cell_counts: dict[tuple[str, str], int] = {}
    seen_card_ids: set[str] = set()
    ordered_cards = sorted(export.cards, key=lambda c: (c.pos, c.index))
    for c in ordered_cards:
        if c.id in seen_card_ids:
            continue
        seen_card_ids.add(c.id)
        if c.list_id not in list_ids:
            missing_list += 1
            continue
        if c.list_id not in included_list_ids:
            skipped_archived += 1
            continue

        known_labels = [lid for lid in dict.fromkeys(c.label_ids) if lid in label_by_id]
        unknown_labels += len(set(c.label_ids)) - len(known_labels)
        mapped = [lid for lid in known_labels if lid in sw_key_by_label]
        if len(mapped) > 1:
            multi_mapped += 1
        if mapped:
            sw_key = sw_key_by_label[mapped[0]]
        else:
            sw_key = "default"
            used_default = True

        due_date = None
        if c.due:
            dt = _parse_ts(c.due)
            if dt is None:
                bad_due += 1
            else:
                due_date = dt.astimezone(datetime.timezone.utc).date()

        archived_at = None
        if c.closed or c.list_id in closed_list_ids:
            archived_at = _parse_ts(c.date_last_activity) or now

        assignee_id = None
        if add_members:
            for mid in c.member_ids:
                if mid in matched:
                    assignee_id = matched[mid]
                    break

        description = c.desc
        links = [a for a in c.attachments if _safe_url(a.url)]
        if links:
            # Only http(s) URLs are written, so a crafted ``javascript:`` link
            # in the export cannot reach the rendered description.
            lines = [f"- [{_md_escape(a.name or a.url)}](<{a.url.replace('>', '%3E')}>)" for a in links]
            block = "**Attachments (imported from Trello)**\n" + "\n".join(lines)
            description = f"{description}\n\n{block}" if description else block
        if len(description) > _MAX_CARD_DESCRIPTION:
            description = description[:_MAX_CARD_DESCRIPTION]
            long_descriptions += 1

        cell = (c.list_id, sw_key)
        position = cell_counts.get(cell, 0)
        cell_counts[cell] = position + 1
        planned.append(PlannedCard(
            trello_id=c.id,
            title=(c.name.strip() or "Untitled card")[:_MAX_CARD_TITLE],
            description=description,
            column_key=c.list_id,
            swimlane_key=sw_key,
            position=position,
            label_ids=known_labels,
            assignee_id=assignee_id,
            due_date=due_date,
            archived_at=archived_at,
            created_at=_object_id_time(c.id),
        ))

    if used_default or not swimlanes:
        swimlanes.append({
            "key": "default", "name": options.default_swimlane_name,
            "color": DEFAULT_COLUMN_COLOR, "position": len(swimlanes),
        })

    planned_ids = {p.trello_id for p in planned}

    # --- Checklists: Visiban has flat items, not named checklists. --------
    checklist_items: dict[str, list[tuple[str, bool]]] = {}
    multi_checklist_cards = 0
    item_total = 0
    for card_id, cls in checklists_by_card.items():
        if card_id not in planned_ids:
            continue
        cls = sorted(cls, key=lambda x: x.pos)
        prefix = len(cls) > 1
        if prefix:
            multi_checklist_cards += 1
        out = []
        for cl in cls:
            for it in sorted(cl.items, key=lambda x: x.pos):
                text = it.name.strip() or "Untitled item"
                if prefix and cl.name:
                    text = f"{cl.name}: {text}"
                out.append((text[:_MAX_CHECKLIST_TEXT], it.complete))
        if out:
            checklist_items[card_id] = out
            item_total += len(out)

    # --- Comments --------------------------------------------------------
    comments = []
    for cm in export.comments:
        if cm.card_id not in planned_ids:
            continue
        author_id = matched.get(cm.member_id) if add_members else None
        if author_id is None:
            # The importer becomes the author; keep the original name visible
            # so the audit trail still says who wrote it in Trello.
            # Comments render as plain text, so the prefix is plain text too.
            name = " ".join(cm.author_name.split())
            body = f"{name} (imported from Trello):\n\n{cm.text}"
        else:
            # Attributed to the matched user (opt-in), but the uploader wrote
            # this file — always mark provenance so an imported comment can
            # never pass as one the user posted in Visiban.
            body = f"(imported from Trello)\n\n{cm.text}"
        if len(body) > _MAX_COMMENT_BODY:
            body = body[:_MAX_COMMENT_BODY]
            long_comments += 1
        comments.append({
            "card_id": cm.card_id,
            "author_id": author_id,
            "body": body,
            "created_at": _parse_ts(cm.date),
        })

    # --- Warnings / unmappable ----------------------------------------------
    closed_lists = [lst for lst in export.lists if lst.closed]
    if not options.include_archived_lists:
        _warn(warnings, "archived_lists_skipped",
              "Archived lists and their cards will be skipped. Turn on “Include archived lists” to import them.",
              len(closed_lists))
    _warn(warnings, "cards_in_archived_lists_skipped", "Cards in archived lists will be skipped.", skipped_archived)
    _warn(warnings, "cards_missing_list", "Cards that reference a list missing from the export will be skipped.", missing_list)
    _warn(warnings, "multiple_swimlane_labels",
          "Cards with more than one swimlane label go to the swimlane of their first such label.", multi_mapped)
    _warn(warnings, "checklists_flattened",
          "Cards with several named checklists get one combined checklist; item text is prefixed with the checklist name.",
          multi_checklist_cards)
    _warn(warnings, "invalid_due_dates", "Due dates that could not be read will be left empty.", bad_due)
    _warn(warnings, "descriptions_truncated",
          f"Card descriptions longer than {_MAX_CARD_DESCRIPTION:,} characters will be shortened.", long_descriptions)
    _warn(warnings, "comments_truncated",
          f"Comments longer than {_MAX_COMMENT_BODY:,} characters will be shortened.", long_comments)
    _warn(warnings, "unknown_labels", "Label references missing from the export will be ignored.", unknown_labels)
    if export.action_count >= TRELLO_ACTION_EXPORT_LIMIT:
        _warn(warnings, "comments_may_be_incomplete",
              f"Trello exports include at most {TRELLO_ACTION_EXPORT_LIMIT} recent actions, so older comments may be missing.",
              export.action_count)
    matched_count = len(matched)
    unmatched_count = len(export.members) - matched_count
    if not add_members:
        _warn(warnings, "matched_members_not_added",
              "Matched members will not be added to the board; assignees are left empty and comments are attributed to you.",
              matched_count)
    _warn(warnings, "unmatched_members",
          "Unmatched members are not assigned; their comments are attributed to you with their Trello name.",
          unmatched_count)

    attachment_total = sum(len(c.attachments) for c in export.cards)
    plugin_cards = sum(1 for c in export.cards if c.has_plugin_data)
    unmappable = [
        {"kind": kind, "count": count}
        for kind, count in (
            ("attachment_files", attachment_total),
            ("custom_fields", export.custom_field_defs + sum(c.custom_field_items for c in export.cards)),
            ("power_up_data", export.board_plugin_data + plugin_cards),
            ("start_dates", sum(1 for c in export.cards if c.has_start)),
            ("stickers", export.stickers),
        )
        if count
    ]

    preview = {
        "source": "trello",
        "board": {"name": export.name, "description": export.desc},
        "counts": {
            "lists": len(export.lists),
            "lists_archived": len(closed_lists),
            "cards": len(export.cards),
            "cards_archived": sum(1 for c in export.cards if c.closed),
            "labels": len(export.labels),
            "checklists": len(export.checklists),
            "checklist_items": sum(len(cl.items) for cl in export.checklists),
            "comments": len(export.comments),
            "attachments": attachment_total,
            "members": len(export.members),
        },
        "result": {
            "columns": len(columns),
            "swimlanes": len(swimlanes),
            "labels": len(labels),
            "cards": len(planned),
            "cards_archived": sum(1 for p in planned if p.archived_at is not None),
            "checklist_items": item_total,
            "comments": len(comments),
        },
        "mapping": {
            "columns": column_preview,
            "labels": label_preview,
            "swimlanes": [{"name": s["name"], "label_id": s["key"][6:] if s["key"].startswith("label:") else None}
                          for s in swimlanes],
            "default_swimlane": options.default_swimlane_name,
        },
        # Counts only for matches — never which Visiban accounts matched.
        # Unmatched names come from the uploader's own file.
        "members": {
            "total": len(export.members),
            "matched": matched_count,
            "unmatched": [
                {"trello_id": m.id, "full_name": m.full_name or m.username}
                for m in export.members if m.id not in matched
            ],
        },
        "options": {
            "swimlane_label_ids": options.swimlane_label_ids,
            "default_swimlane_name": options.default_swimlane_name,
            "include_archived_lists": options.include_archived_lists,
            "add_matched_members": options.add_matched_members,
        },
        "warnings": warnings,
        "unmappable": unmappable,
    }

    return ImportPlan(
        board_name=export.name,
        board_description=export.desc,
        columns=columns,
        labels=labels,
        swimlanes=swimlanes,
        cards=planned,
        checklist_items=checklist_items,
        comments=comments,
        member_user_ids=sorted(set(matched.values())) if add_members else [],
        preview=preview,
    )


# ---------------------------------------------------------------------------
# Stage 3: execute
# ---------------------------------------------------------------------------

_BATCH = 1000
# bulk_update emits one CASE WHEN per row, evaluated linearly per updated row,
# so smaller batches keep each UPDATE's cost and SQL size modest.
_UPDATE_BATCH = 500


def execute_plan(plan: ImportPlan, user, *, group=None, board_name: str | None = None) -> Board:
    """Create the board described by ``plan``. All-or-nothing.

    Uses ``bulk_create`` throughout, which bypasses model signals and the card
    service layer on purpose (see module docstring): an import must not send
    notifications or fire card-mutation hooks.
    """
    if not plan.columns:
        raise TrelloImportError(
            "There are no lists to import. Turn on “Include archived lists” if all lists are archived."
        )
    with transaction.atomic():
        board = Board.objects.create(
            name=(board_name or plan.board_name)[:_MAX_BOARD_NAME],
            description=plan.board_description,
            owner=user,
            group=group,
        )
        memberships = [BoardMembership(board=board, user=user, role=BoardMembership.Role.ADMIN)]
        memberships += [
            BoardMembership(board=board, user_id=uid, role=BoardMembership.Role.MEMBER)
            for uid in plan.member_user_ids if uid != user.pk
        ]
        BoardMembership.objects.bulk_create(memberships)

        col_objs = Column.objects.bulk_create([
            Column(board=board, name=c["name"], position=c["position"],
                   color=DEFAULT_COLUMN_COLOR, allow_card_creation=c["position"] == 0)
            for c in plan.columns
        ])
        column_by_key = {c["key"]: obj for c, obj in zip(plan.columns, col_objs)}

        sw_objs = Swimlane.objects.bulk_create([
            Swimlane(board=board, name=s["name"], position=s["position"],
                     color=s["color"] if _HEX_RE.match(s["color"]) else DEFAULT_COLUMN_COLOR)
            for s in plan.swimlanes
        ])
        swimlane_by_key = {s["key"]: obj for s, obj in zip(plan.swimlanes, sw_objs)}

        lbl_objs = Label.objects.bulk_create([
            Label(board=board, name=lb["name"],
                  color=lb["color"] if _HEX_RE.match(lb["color"]) else DEFAULT_LABEL_COLOR)
            for lb in plan.labels
        ])
        label_by_key = {lb["key"]: obj for lb, obj in zip(plan.labels, lbl_objs)}

        card_objs = []
        for pc in plan.cards:
            obj = Card(
                board=board,
                column=column_by_key[pc.column_key],
                swimlane=swimlane_by_key[pc.swimlane_key],
                title=pc.title,
                description=pc.description,
                assignee_id=pc.assignee_id,
                due_date=pc.due_date,
                position=pc.position,
                created_by=user,
            )
            if pc.archived_at is not None:
                obj.archived_at = pc.archived_at
            card_objs.append(obj)
        Card.objects.bulk_create(card_objs, batch_size=_BATCH)
        card_by_trello = {pc.trello_id: obj for pc, obj in zip(plan.cards, card_objs)}

        # created_at is auto_now_add, so the original Trello creation time can
        # only be written by a follow-up UPDATE.
        backfill = []
        for pc, obj in zip(plan.cards, card_objs):
            if pc.created_at is not None:
                obj.created_at = pc.created_at
                backfill.append(obj)
        if backfill:
            Card.objects.bulk_update(backfill, ["created_at"], batch_size=_UPDATE_BATCH)

        through = Card.labels.through
        through.objects.bulk_create(
            [
                through(card_id=card_by_trello[pc.trello_id].pk, label_id=label_by_key[lid].pk)
                for pc in plan.cards for lid in pc.label_ids
            ],
            batch_size=_BATCH,
            ignore_conflicts=True,
        )

        CardChecklist.objects.bulk_create(
            [
                CardChecklist(card=card_by_trello[cid], text=text, is_checked=checked,
                              position=i, created_by=user)
                for cid, items in plan.checklist_items.items()
                for i, (text, checked) in enumerate(items)
            ],
            batch_size=_BATCH,
        )

        comment_objs = [
            CardComment(card=card_by_trello[cm["card_id"]], author_id=cm["author_id"] or user.pk, body=cm["body"])
            for cm in plan.comments
        ]
        CardComment.objects.bulk_create(comment_objs, batch_size=_BATCH)
        dated = []
        for cm, obj in zip(plan.comments, comment_objs):
            if cm["created_at"] is not None:
                obj.created_at = cm["created_at"]
                dated.append(obj)
        if dated:
            CardComment.objects.bulk_update(dated, ["created_at"], batch_size=_UPDATE_BATCH)

    return board
