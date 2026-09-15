"""MCP tool implementations.

Tools return plain Python dicts and take plain arguments — no MCP SDK types
appear here. The SDK-facing registration lives in :mod:`mcp_server.server`, so
an SDK API change is a one-file edit there rather than a rewrite of every tool
(#511). Later tool waves (#512 CRUD, #513 resources) add functions here and
register them there, and inherit authentication from the transport middleware
without writing any auth code of their own.

#512's six CRUD tools all reuse :mod:`boards.services.cards` for every write —
the role allow-list, WIP/weight enforcement, the ``CardMovement`` audit trail
and the deferred broadcast all live there, unchanged, exactly as the REST
``CardViewSet`` uses them (see ``boards/views/cards.py``). Nothing here
re-implements a card invariant; this module only translates MCP-shaped
arguments (an email, a label name, a bare ``card_id``) into what the service
functions and ``CardSerializer`` already expect, and translates the typed
errors in :mod:`boards.services.errors` back into a structured dict a caller
can branch on.

Error contract
--------------
Every tool that can fail *domain-wise* (a bad board id, a role that may not
write, a WIP limit, a validation failure) returns ``{"error": {"code": ...,
...}}`` as an ordinary return value — it does not raise. Raising would still
produce a `CallToolResult`, but FastMCP's generic exception handling collapses
it to ``isError=True`` with only ``str(exception)`` as text, discarding every
field (``wip_limit``, ``current_count``, ``current_version``, ...) a calling
agent needs to act on the failure (verified empirically against the pinned
SDK version; see the `-> list[dict] | dict` return annotation in server.py and
its comment for why a *narrower* annotation is actively unsafe here). A tool's
success payload is therefore ALWAYS a list or a plain dict that carries no
top-level ``"error"`` key, and a failure is ALWAYS a dict with exactly that
key — that split is the whole contract, and it is now part of the tools'
public (agent-facing) shape, so do not change it without a major version bump.
"""
from django.db.models import Count, Q
from rest_framework.exceptions import ValidationError as _DRFValidationError

from accounts.models import User
from boards.models import Board, BoardMembership, Card, Column, Label, Swimlane
from boards.permissions import (
    GROUP_ANCESTOR_SELECT_RELATED, SITE_ADMIN, get_board_role, get_board_roles,
)
from boards.serializers import CardSerializer, _card_queryset
from boards.services import cards as card_services
from boards.services.errors import (
    BoardNotFound, CardNotFound, CardServiceError,
)
from boards.utils import _get_assignable_member_ids
from groups.models import get_accessible_group_ids

from .context import get_current_user


def _serialize_board(board, role):
    """Shape one board for the MCP wire format.

    ``id`` is the integer pk, matching how the REST API addresses boards, so a
    future write tool (#512) can reuse the identifier a caller already holds.
    """
    return {
        "id": board.id,
        "uid": board.uid,
        "name": board.name,
        "description": board.description,
        "role": role,
        "column_count": board._column_count,
        "swimlane_count": board._swimlane_count,
        "card_count": board._card_count,
        "created_at": board.created_at.isoformat(),
        "updated_at": board.updated_at.isoformat(),
    }


def list_boards():
    """Return every board the authenticated MCP caller can access.

    The access rule deliberately mirrors ``BoardViewSet.get_queryset()``
    exactly — ownership, direct membership, group-inherited access, and the
    site-admin bypass — rather than the narrower "has a BoardMembership row"
    reading. A board a user can open in the web UI but which the tool omits
    would be silently invisible to an AI agent acting on their behalf, which is
    a correctness bug, not a conservative default.

    ``role`` is therefore the *effective* role from ``get_board_role()``, not a
    raw ``BoardMembership.role`` column: it is ``"admin"`` for an owner with no
    membership row, the inherited role for group-derived access, and
    ``"site_admin"`` for a user with ``can_access_all_content``.
    """
    user = get_current_user()

    if user.can_access_all_content:
        qs = Board.objects.all()
    else:
        qs = Board.objects.filter(
            Q(owner=user) |
            Q(memberships__user=user) |
            Q(group__in=get_accessible_group_ids(user))
        ).distinct()

    # distinct=True on every Count is load-bearing, not defensive. columns,
    # swimlanes and cards are three INDEPENDENT one-to-many children of Board,
    # so the three LEFT OUTER JOINs cross-multiply before aggregation: without
    # it a board with 5 columns, 3 swimlanes and 10 cards reports 150 for all
    # three counts. card_count excludes archived cards to match the count the
    # REST board list reports.
    qs = qs.select_related(GROUP_ANCESTOR_SELECT_RELATED).annotate(
        _column_count=Count("columns", distinct=True),
        _swimlane_count=Count("swimlanes", distinct=True),
        _card_count=Count(
            "cards", filter=Q(cards__archived_at__isnull=True), distinct=True
        ),
    )

    boards = list(qs)

    # One shared bulk resolver, fixed two queries for the whole batch. This used
    # to be a local re-implementation of get_board_role()'s precedence ladder,
    # carrying a "must be kept in step with it" comment — which #1107 replaced
    # with boards.permissions.get_board_roles() so there is only one copy of the
    # rules to keep in step with anything.
    roles = get_board_roles(user, boards)

    results = []
    for board in boards:
        role = roles[board.id]
        if role is None:
            # Reachable for a board whose group is an *ancestor* of one the
            # user belongs to: get_accessible_group_ids() includes ancestors so
            # the sidebar tree can be navigated, but they confer no role. Such a
            # board is not really readable, so omit it rather than report a
            # null role.
            continue
        results.append(_serialize_board(board, role))
    return results


# ---------------------------------------------------------------------------
# Shared board/card resolution (#512)
#
# Every read and write tool below resolves a board (or a card, deriving its
# board) and the caller's role on it before doing anything else. Centralized
# here so the IDOR posture — "board/card does not exist" and "board/card
# exists but the caller has no access" produce the IDENTICAL error — cannot
# drift per tool, matching the pattern boards.services.cards._board_scoped()
# already uses for column/swimlane lookups.
# ---------------------------------------------------------------------------

_ADMIN_ROLES = (BoardMembership.Role.ADMIN, SITE_ADMIN)


def _resolve_board(user, board_id):
    """Resolve *board_id* for the current MCP caller.

    Raises :class:`~boards.services.errors.BoardNotFound` both when the board
    does not exist and when it exists but ``user`` has no role on it — a
    probing client must not be able to tell those apart (IDOR).
    """
    try:
        board = Board.objects.select_related(GROUP_ANCESTOR_SELECT_RELATED).get(pk=board_id)
    except Board.DoesNotExist:
        raise BoardNotFound() from None
    role = get_board_role(user, board)
    if role is None:
        raise BoardNotFound() from None
    return board, role


def _resolve_board_for_card(user, card_id):
    """Resolve a card's board and the caller's role on it, from ``card_id`` alone.

    ``card_id`` is the only identifier ``move_card``/``update_card``/
    ``archive_card`` take — there is no accompanying ``board_id`` a caller
    could (correctly or maliciously) pair it with. The board is therefore
    derived from the card row itself, never trusted from the caller, and the
    same access check every other tool uses is applied to it (hard constraint,
    #512: "resolve and authorize the board first, do not trust a caller-
    supplied pairing").

    Returns ``(board, role, card)`` — the card is already fetched here so
    callers that don't need a row lock (``update_card``, ``archive_card``)
    never issue a second query for it. ``move_card`` still re-fetches under
    ``select_for_update()`` inside the service, as it must.

    A nonexistent card and a card on a board the caller cannot see return the
    identical error (reusing ``CardNotFound``, whose own docstring states this
    same guarantee) so a client cannot use the response to enumerate ids on
    boards it cannot see.
    """
    try:
        card = Card.objects.select_related(
            "board", f"board__{GROUP_ANCESTOR_SELECT_RELATED}",
        ).get(pk=card_id)
    except Card.DoesNotExist:
        raise CardNotFound() from None
    role = get_board_role(user, card.board)
    if role is None:
        raise CardNotFound() from None
    return card.board, role, card


# ---------------------------------------------------------------------------
# Errors (#512)
# ---------------------------------------------------------------------------

class ValidationFailed(Exception):
    """A translated MCP argument failed validation before reaching a service.

    Carries a plain ``{field: [messages]}`` dict — the same shape DRF's
    ``ValidationError`` normalizes to below — so ``_error_payload`` can render
    both through one code path.
    """

    def __init__(self, errors):
        self.errors = errors
        super().__init__(str(errors))


# Card-service error classes whose `.body()` carries no `code` key by design
# (see boards/services/errors.py — the omission is a frozen REST contract for
# some of these). MCP callers get a `code` on every error regardless, since
# there is no HTTP status code for them to branch on instead; this table
# supplies the ones already-coded errors don't need (their own `code` in
# `.body()` wins via `setdefault` below).
_ERROR_CODES = {
    "NotPermitted": "permission_denied",
    "BoardNotFound": "board_not_found",
    "CardNotFound": "card_not_found",
    "ColumnNotFound": "column_not_found",
    "SwimlaneNotFound": "swimlane_not_found",
    "CardCreationNotAllowed": "card_creation_not_allowed",
    "InvalidVersion": "invalid_version",
    "ForceNotPermitted": "force_not_permitted",
}


def _normalize_drf_errors(detail):
    """Recursively turn DRF's ErrorDetail-laden validation detail into plain JSON.

    ``ErrorDetail`` is a ``str`` subclass so it serializes fine on its own, but
    nested dicts/lists of it are not automatically plain — normalizing here
    means the MCP error payload is guaranteed built only of dict/list/str.
    """
    if isinstance(detail, dict):
        return {k: _normalize_drf_errors(v) for k, v in detail.items()}
    if isinstance(detail, list):
        return [_normalize_drf_errors(v) for v in detail]
    return str(detail)


def _error_payload(exc):
    """Render any caught tool-domain exception as the tools' one error shape.

    See the module docstring's "Error contract" section — this is the single
    place that shape is built, so every tool's failures look the same.
    """
    if isinstance(exc, _DRFValidationError):
        return {"error": {"code": "validation_error", "errors": _normalize_drf_errors(exc.detail)}}
    if isinstance(exc, ValidationFailed):
        return {"error": {"code": "validation_error", "errors": exc.errors}}
    body = dict(exc.body())
    body.setdefault("code", _ERROR_CODES.get(type(exc).__name__, type(exc).__name__))
    return {"error": body}


# ---------------------------------------------------------------------------
# Card field translation (#512)
#
# An MCP agent identifies a person by email and a label by name — it has no
# reason to know Visiban's internal primary keys, and giving it one would leak
# an internal identifier space to every connected agent for no benefit. This
# is the one place that translates the agent-facing vocabulary into the
# `assignee_id`/`label_ids` field names and ids `CardSerializer` expects, so
# every write tool gets the same resolution rule and the same errors: an
# unmatched name is a structured validation_error, never a raw
# DoesNotExist/500.
# ---------------------------------------------------------------------------

def _translate_card_fields(board, *, title=None, description=None, priority=None,
                            assignee_email=None, labels=None, due_date=None):
    """Build a CardSerializer-shaped dict from MCP-facing arguments.

    Only keys the caller actually supplied (non-``None``) are included, so
    this doubles as the ``submitted`` mapping ``update_card`` passes to
    ``boards.services.cards.update_card`` for its per-field activity diff.

    ``labels=[]`` (an explicit empty list, as opposed to omitted/``None``)
    clears every label — the same "empty means clear" convention
    ``boards.services.custom_fields`` uses. ``assignee_email=""`` likewise
    unassigns the card. Neither is exercised by ``create_card`` (there is
    nothing to clear on a new card), only by ``update_card``.

    Raises :class:`ValidationFailed` if an email or label name does not
    resolve — never lets a bare ``DoesNotExist``/ambiguous-match escape.
    ``assignee_email`` is never logged (PII); it appears only in the error
    dict handed back to the caller who supplied it, which is not a log
    statement.
    """
    data = {}
    errors = {}

    if title is not None:
        data["title"] = title
    if description is not None:
        data["description"] = description
    if priority is not None:
        data["priority"] = priority
    if due_date is not None:
        data["due_date"] = due_date

    if assignee_email is not None:
        if assignee_email == "":
            data["assignee_id"] = None
        else:
            # Scoped to assignable board members first (excludes viewers, per
            # _get_assignable_member_ids' own rule), THEN matched by email —
            # never a bare User.objects.get(email=...), which would be a
            # cross-tenant IDOR risk: email is not unique on this model
            # (Django's stock AbstractUser field), so an unscoped lookup could
            # resolve to a user with no relationship to this board at all.
            assignable_ids = _get_assignable_member_ids(board)
            matches = list(User.objects.filter(pk__in=assignable_ids, email__iexact=assignee_email))
            if len(matches) == 1:
                data["assignee_id"] = matches[0].pk
            elif len(matches) == 0:
                errors["assignee_email"] = [
                    "No assignable board member was found with this email address."
                ]
            else:
                errors["assignee_email"] = [
                    "Multiple board members share this email address; "
                    "this card cannot be assigned unambiguously by email."
                ]

    if labels is not None:
        if labels:
            label_qs = list(Label.objects.filter(board=board, name__in=labels))
            found_names = {label.name for label in label_qs}
            missing = [name for name in labels if name not in found_names]
            if missing:
                errors["labels"] = [f"Unknown label(s) on this board: {', '.join(missing)}."]
            else:
                data["label_ids"] = [label.pk for label in label_qs]
        else:
            data["label_ids"] = []

    if errors:
        raise ValidationFailed(errors)
    return data


# ---------------------------------------------------------------------------
# Card representation (#512)
#
# One function, reused by list_cards/create_card/update_card/move_card, so the
# agent-facing card shape cannot drift between "a card I just listed" and "a
# card I just wrote" — the same worry CardServiceError's module docstring
# raises about REST response bodies, applied to the MCP side.
# ---------------------------------------------------------------------------

def _serialize_card(card):
    return {
        "id": card.id,
        "title": card.title,
        "description": card.description,
        "priority": card.priority,
        "assignee": card.assignee.email if card.assignee_id else None,
        "labels": sorted(label.name for label in card.labels.all()),
        "column": {"id": card.column_id, "name": card.column.name},
        "swimlane": {"id": card.swimlane_id, "name": card.swimlane.name},
        "due_date": card.due_date.isoformat() if card.due_date else None,
        "position": card.position,
        "created_at": card.created_at.isoformat(),
        "updated_at": card.updated_at.isoformat(),
    }


def _refetch_and_serialize(card):
    """Re-fetch *card* with every relation ``_serialize_card`` needs, then serialize.

    The instance a caller holds right after a service call is not safe to
    serialize directly: ``move_card`` fetches with only
    ``select_related("column", "swimlane")`` (it needs no more to do the move
    itself), and ``update_card``'s caller only has whatever
    ``_resolve_board_for_card`` fetched (no ``assignee``/``labels`` prefetch at
    all). Serializing either directly would cost 2-4 avoidable queries per
    call — exactly the N+1 ``boards.views.cards._refetch_card_data`` exists to
    avoid on the REST side (its own docstring: "the instance the service holds
    ... would otherwise trigger ~7 extra queries"). Reusing ``_card_queryset``
    here is the same fix applied the same way, once, rather than adding a
    parallel prefetch chain that could drift from it.
    """
    return _serialize_card(_card_queryset(Card.objects.filter(pk=card.pk)).get())


def _serialize_movement(movement):
    if movement is None:
        return None
    return {
        "id": movement.id,
        "from_column": movement.from_column_name or None,
        "to_column": movement.to_column_name or None,
        "from_swimlane": movement.from_swimlane_name or None,
        "to_swimlane": movement.to_swimlane_name or None,
        "moved_at": movement.moved_at.isoformat(),
        "moved_by": movement.moved_by.email if movement.moved_by_id else None,
    }


def _serialize_label(label):
    return {"id": label.id, "name": label.name, "color": label.color}


# `actor`/`author` below are emails, matching the existing MCP-wide
# convention `_serialize_card`'s `assignee` and `_serialize_movement`'s
# `moved_by` already established (#512) — an MCP agent has no use for an
# internal user id and no access to the web UI's username, so email is this
# surface's one consistent way to reference a person (also how
# `assignee_email` is ACCEPTED as an argument to create_card/update_card).
# This is a real, already-flagged (security-review, #513) divergence from
# REST: the same relations rendered through
# `CardActivitySerializer`/`CardCommentSerializer` go through
# `BoardUserSerializer`, whose own docstring says it deliberately withholds
# email from board members other than themselves. Extending the established
# MCP convention here — rather than making comments/activities the one
# inconsistent field on this surface — was a deliberate call, not an
# oversight; see the MR description's security findings section for the
# tradeoff and the recommendation to revisit the whole family (`assignee`,
# `moved_by`, `actor`, `author`) together in a follow-up.
def _serialize_activity(activity):
    return {
        "id": activity.id,
        "event_type": activity.event_type,
        "from_value": activity.from_value,
        "to_value": activity.to_value,
        "actor": activity.actor.email if activity.actor_id else None,
        "created_at": activity.created_at.isoformat(),
    }


def _serialize_comment(comment):
    return {
        "id": comment.id,
        "body": comment.body,
        "author": comment.author.email if comment.author_id else None,
        "created_at": comment.created_at.isoformat(),
        "updated_at": comment.updated_at.isoformat(),
    }


def _serialize_checklist_item(item):
    return {
        "id": item.id,
        "text": item.text,
        "is_checked": item.is_checked,
        "position": item.position,
    }


# ---------------------------------------------------------------------------
# Read tools (#512) — all board roles
# ---------------------------------------------------------------------------

def _columns_payload(board):
    """Build the ``list_columns`` shape for an already-resolved *board*.

    Split out of ``list_columns`` so ``board_snapshot`` (#513) can reuse the
    identical query without re-resolving/re-authorizing the board a second
    time — a board snapshot composes this, ``_swimlanes_payload``, and
    ``_cards_payload`` on ONE resolved board rather than calling three public
    tools that would each pay their own ``_resolve_board`` query.
    """
    columns = (
        Column.objects.filter(board=board)
        .annotate(_card_count=Count("cards", filter=Q(cards__archived_at__isnull=True)))
        .order_by("position")
    )
    return [
        {
            "id": c.id,
            "name": c.name,
            "position": c.position,
            "color": c.color,
            "wip_limit": c.wip_limit,
            "card_count": c._card_count,
        }
        for c in columns
    ]


def list_columns(*, board_id):
    """List a board's columns, ordered by position.

    Every board member (including collaborator/viewer) may call this — it is
    a read of board structure, not of any per-role-restricted data.
    """
    user = get_current_user()
    try:
        board, _role = _resolve_board(user, board_id)
    except CardServiceError as exc:
        return _error_payload(exc)
    return _columns_payload(board)


def _swimlanes_payload(board, role):
    """Build the ``list_swimlanes`` shape for an already-resolved *board*/*role*.

    ``contact_email`` is admin/site_admin-only, matching
    ``SwimlaneSerializer``/``SwimlaneAdminSerializer``'s existing split
    (``boards/views/swimlanes.py::get_serializer_class``) — it is customer PII
    stored on the swimlane, and a collaborator/viewer role sees the board
    structure without it, exactly as they do over REST. The key is OMITTED
    for those roles rather than sent empty: an empty string would be
    indistinguishable from "no contact email on file" and would misinform the
    caller rather than simply not tell it something. Split out of
    ``list_swimlanes`` for the same reuse reason as ``_columns_payload``.
    """
    can_see_contact_email = role in _ADMIN_ROLES
    swimlanes = (
        Swimlane.objects.filter(board=board)
        .annotate(_card_count=Count("cards", filter=Q(cards__archived_at__isnull=True)))
        .order_by("position")
    )
    results = []
    for s in swimlanes:
        row = {
            "id": s.id,
            "name": s.name,
            "position": s.position,
            "color": s.color,
            "card_count": s._card_count,
            "is_collapsed": s.is_collapsed,
        }
        if can_see_contact_email:
            row["contact_email"] = s.contact_email
        results.append(row)
    return results


def list_swimlanes(*, board_id):
    """List a board's swimlanes, ordered by position. See ``_swimlanes_payload``."""
    user = get_current_user()
    try:
        board, role = _resolve_board(user, board_id)
    except CardServiceError as exc:
        return _error_payload(exc)
    return _swimlanes_payload(board, role)


# Hard cap on list_cards rows, matching CardViewSet.list()'s existing
# `_LIST_MAX_ROWS` (boards/views/cards.py) — targeted lookups must bound their
# response the same way REST's do, not return an unbounded payload.
_LIST_CARDS_MAX_ROWS = 200


def _cards_payload(board, *, column_id=None, swimlane_id=None, assignee=None,
                    priority=None, label=None, include_archived=False):
    """Build the ``list_cards`` shape for an already-resolved *board*.

    Split out of ``list_cards`` for the same reuse reason as
    ``_columns_payload`` — ``board_snapshot`` calls this with no filters
    (its own contract is "all active cards") without paying a second
    ``_resolve_board`` query.
    """
    qs = (
        Card.objects.filter(board=board)
        .select_related("column", "swimlane", "assignee")
        .prefetch_related("labels")
    )
    if not include_archived:
        qs = qs.filter(archived_at__isnull=True)
    if column_id is not None:
        qs = qs.filter(column_id=column_id)
    if swimlane_id is not None:
        qs = qs.filter(swimlane_id=swimlane_id)
    if assignee is not None:
        qs = qs.filter(assignee__email__iexact=assignee)
    if priority is not None:
        qs = qs.filter(priority=priority)
    if label is not None:
        # .distinct() guards against the label M2M join fan-out duplicating a
        # card that has more than one label matching... it can't match more
        # than one row for an exact `name=` filter (Label is unique per
        # board+name), but stays for defense-in-depth and because it costs
        # nothing extra with an already-selective board+name filter.
        qs = qs.filter(labels__name=label).distinct()
    qs = qs.order_by("column__position", "swimlane__position", "position")[:_LIST_CARDS_MAX_ROWS]
    return [_serialize_card(card) for card in qs]


def list_cards(*, board_id, column_id=None, swimlane_id=None, assignee=None,
                priority=None, label=None, include_archived=False):
    """List a board's cards, optionally filtered, ordered by board position.

    All filters are optional and compose with AND. ``assignee`` matches by
    email (case-insensitive), consistent with how ``create_card``/
    ``update_card`` accept an assignee — never an internal user id.
    """
    user = get_current_user()
    try:
        board, _role = _resolve_board(user, board_id)
    except CardServiceError as exc:
        return _error_payload(exc)
    return _cards_payload(
        board, column_id=column_id, swimlane_id=swimlane_id, assignee=assignee,
        priority=priority, label=label, include_archived=include_archived,
    )


# ---------------------------------------------------------------------------
# Write tools (#512) — admin/member only; enforced by
# boards.services.cards._require_mutation_role, not re-implemented here.
# ---------------------------------------------------------------------------

def create_card(*, board_id, column_id, swimlane_id, title, description=None,
                 priority=None, assignee_email=None, labels=None, due_date=None,
                 position=None):
    """Create a card, appended to the end of its column/swimlane cell.

    ``position`` composes two existing service entry points rather than
    adding placement logic of its own: ``boards.services.cards.create_card``
    always appends (the service decides where, not the caller — see its own
    docstring), so an explicit initial position is honored with a follow-up
    ``move_card`` call. That second call is a pure same-cell reorder (column
    and swimlane both unchanged), which ``move_card``'s own docstring notes is
    exempt from WIP/weight enforcement and writes no extra ``CardMovement``
    row — so this never double-counts against a WIP limit or pollutes the
    audit trail with a redundant movement.
    """
    user = get_current_user()
    try:
        board, role = _resolve_board(user, board_id)
        data = _translate_card_fields(
            board,
            title=title,
            description=description if description is not None else "",
            priority=priority if priority is not None else Card.Priority.MEDIUM,
            assignee_email=assignee_email,
            labels=labels,
            due_date=due_date,
        )
        data["column"] = column_id
        data["swimlane"] = swimlane_id

        serializer = CardSerializer(data=data, context={"board": board})
        serializer.is_valid(raise_exception=True)

        def save(position):
            return serializer.save(board=board, created_by=user, position=position)

        result = card_services.create_card(
            actor=user, board=board, role=role,
            column_id=column_id, swimlane_id=swimlane_id,
            save=save, render=_refetch_and_serialize,
        )
        card = result.card

        if position is not None and position != card.position:
            move_result = card_services.move_card(
                actor=user, board=board, role=role, card_id=card.id,
                target_column_id=column_id, target_swimlane_id=swimlane_id,
                position=position, render=lambda c, _movement: _refetch_and_serialize(c),
            )
            return move_result.payload
        return result.payload
    except (CardServiceError, ValidationFailed, _DRFValidationError) as exc:
        return _error_payload(exc)


def move_card(*, card_id, to_column_id=None, to_swimlane_id=None, position=0):
    """Move a card to a new column, swimlane, and/or position.

    At least one of ``to_column_id``/``to_swimlane_id`` is required; the other
    defaults to the card's current value, matching how a client that only
    wants to reorder within its current column calls the REST move endpoint
    with an unchanged column/swimlane id.

    WIP/weight limits are enforced exactly as they are over REST, with no
    override: this tool never exposes ``force`` or ``version`` (optimistic
    concurrency), so a blocked move always comes back as a structured
    ``wip_limit_exceeded``/``wip_hard_blocked`` error rather than a 500.
    """
    user = get_current_user()
    if to_column_id is None and to_swimlane_id is None:
        return _error_payload(ValidationFailed({
            "to_column_id": ["At least one of to_column_id or to_swimlane_id is required."],
        }))
    try:
        board, role, card = _resolve_board_for_card(user, card_id)
        target_column_id = to_column_id if to_column_id is not None else card.column_id
        target_swimlane_id = to_swimlane_id if to_swimlane_id is not None else card.swimlane_id
        result = card_services.move_card(
            actor=user, board=board, role=role, card_id=card_id,
            target_column_id=target_column_id, target_swimlane_id=target_swimlane_id,
            position=position if position is not None else 0,
            render=lambda c, m: {"card": _refetch_and_serialize(c), "movement": _serialize_movement(m)},
        )
        return result.payload
    except CardServiceError as exc:
        return _error_payload(exc)


def update_card(*, card_id, title=None, description=None, priority=None,
                 assignee_email=None, labels=None, due_date=None):
    """Update one or more fields on a card.

    Cannot change ``column``/``swimlane`` — use ``move_card``, which is the
    only path that enforces WIP/weight limits and writes the movement audit
    trail (see ``boards.services.errors.UseMoveEndpoint``). An omitted
    (``None``) argument is left untouched; only ``labels=[]`` and
    ``assignee_email=""`` are recognized as an explicit "clear" — see
    ``_translate_card_fields``.
    """
    user = get_current_user()
    try:
        board, role, card = _resolve_board_for_card(user, card_id)
        submitted = _translate_card_fields(
            board, title=title, description=description, priority=priority,
            assignee_email=assignee_email, labels=labels, due_date=due_date,
        )
        serializer = CardSerializer(card, data=submitted, partial=True, context={"board": board})
        serializer.is_valid(raise_exception=True)

        def apply():
            serializer.save()

        result = card_services.update_card(
            actor=user, board=board, role=role, card=card,
            submitted=submitted, apply=apply, render=_refetch_and_serialize,
        )
        return result.payload
    except (CardServiceError, ValidationFailed, _DRFValidationError) as exc:
        return _error_payload(exc)


def archive_card(*, card_id):
    """Soft-delete a card. Idempotent: archiving an already-archived card is a no-op."""
    user = get_current_user()
    try:
        board, role, card = _resolve_board_for_card(user, card_id)
        result = card_services.archive_card(
            actor=user, board=board, role=role, card_id=card_id,
            render=lambda c: {
                "card_id": c.id,
                "archived_at": c.archived_at.isoformat() if c.archived_at else None,
            },
        )
        return result.payload
    except CardServiceError as exc:
        return _error_payload(exc)


# ---------------------------------------------------------------------------
# Resources (#513) — board:// and card://
#
# Unlike a tool, a FastMCP *resource* read has no structured-error return
# path at all in the pinned SDK (mcp==1.30.0): FunctionResource.read()
# (mcp/server/fastmcp/resources/types.py) treats ANY non-exception return
# value — including a `{"error": ...}` dict, the tools' own convention above
# — as the resource's successful content and JSON-serializes it verbatim.
# There is no isError/structuredContent channel for resources. The only way
# to signal failure is to raise, which FastMCP.read_resource() (mcp/server/
# fastmcp/server.py) flattens to `ResourceError(str(exc))` — a single string
# message with no separate `code` field, surfaced as one JSON-RPC-level
# error for the `resources/read` call. Both functions below therefore raise
# ValueError on a resolution failure instead of returning `_error_payload()`.
#
# That message is deliberately the SAME generic "not found" wording
# `_resolve_board`/`_resolve_board_for_card` already produce for the
# equivalent tool-facing error (`boards.services.errors.ObjectNotFound`),
# whether the id does not exist or exists on a board the caller cannot see.
# Issue #513's acceptance criteria literally ask for a non-member to get a
# distinguishable "403" rather than the same response as a nonexistent card.
# That is not implemented: architect review (see MR description) confirmed
# this codebase's IDOR convention is deliberately uniform for exactly this
# reason — `ObjectNotFound`'s own docstring says the API "never reveals that
# an id the caller guessed exists on a board they cannot see" — and giving
# the two cases different wording IS the enumeration oracle that convention
# exists to close. It is also unimplementable literally: the SDK gives
# resource reads exactly one failure channel with no structured code to hang
# a 403-vs-404 distinction on in the first place.
# ---------------------------------------------------------------------------

def board_snapshot(*, board_id):
    """Full read-only board snapshot for the ``board://{board_id}`` MCP resource.

    Equivalent in content to ``GET /api/v1/boards/{id}/full/``
    (``BoardFullSerializer``), but deliberately NOT built from that
    serializer. Composed instead from ``_columns_payload``/
    ``_swimlanes_payload``/``_cards_payload`` — the same query logic
    ``list_columns``/``list_swimlanes``/``list_cards`` already use and are
    already query-count-tested — resolving and authorizing the board exactly
    ONCE rather than once per section. ``BoardFullSerializer`` also carries
    several web-session-only fields (``share_token``, ``capabilities``,
    ``is_starred``, ``members``, ``current_user_role``, ...) that have no
    meaning for an AI agent reading board context; a share token in
    particular is a bearer credential and must never appear in agent-facing
    output, so an explicit allow-list (this function's return shape) is used
    rather than trimming a deny-list that could silently leak the next field
    BoardFullSerializer grows.
    """
    user = get_current_user()
    try:
        board, role = _resolve_board(user, board_id)
    except CardServiceError as exc:
        raise ValueError(exc.body()["detail"]) from None

    return {
        "id": board.id,
        "name": board.name,
        "description": board.description,
        "created_at": board.created_at.isoformat(),
        "updated_at": board.updated_at.isoformat(),
        "columns": _columns_payload(board),
        "swimlanes": _swimlanes_payload(board, role),
        "cards": _cards_payload(board),
        "labels": [_serialize_label(label) for label in board.labels.all()],
    }


def card_detail(*, card_id):
    """Card detail + full audit history for the ``card://{card_id}`` MCP resource.

    RBAC is enforced by ``_resolve_board_for_card`` — the same resolver every
    write tool uses — so board membership is required exactly as it is for
    ``move_card``/``update_card``/``archive_card``; see the module-level
    comment above for why its failure is raised rather than returned.

    Movements and checklist items come from ``_card_queryset``'s shared
    prefetch chain (no extra query — the same one ``list_cards`` and the
    REST card endpoints use). Activities and comments are NOT part of that
    chain (it is built for listing many cards on a board at once, and most
    board reads never need a card's full comment/activity history), so they
    are fetched here as two additional queries scoped to this one card —
    matching the exact ``select_related`` shape the REST
    ``activities``/``comments`` actions already use
    (``boards/views/cards.py``) — each covered by an existing
    ``(card, ...)`` index (see ``CardActivity``/``CardComment`` Meta.indexes),
    so this is a fixed five-query read for one card, never an N+1 over many.
    """
    user = get_current_user()
    try:
        _board, _role, card = _resolve_board_for_card(user, card_id)
    except CardServiceError as exc:
        raise ValueError(exc.body()["detail"]) from None

    # Re-fetch with the shared prefetch chain so labels/checklist_items/
    # movements are already loaded rather than queried lazily one at a time.
    card = _card_queryset(Card.objects.filter(pk=card.pk)).get()

    data = _serialize_card(card)
    data["archived_at"] = card.archived_at.isoformat() if card.archived_at else None
    data["movements"] = [_serialize_movement(m) for m in card.movements.all()]
    data["checklist_items"] = [_serialize_checklist_item(i) for i in card.checklist_items.all()]
    data["activities"] = [
        _serialize_activity(a)
        for a in card.activities.select_related("actor").order_by("-created_at")
    ]
    data["comments"] = [
        _serialize_comment(c)
        for c in card.comments.select_related("author").order_by("created_at")
    ]
    return data
