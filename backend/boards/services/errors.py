"""Typed domain errors raised by :mod:`boards.services`.

Every error carries the **exact** response body and status code the card
endpoints returned before the service extraction (#1107), so that a view
adapter is a single generic clause::

    except CardServiceError as exc:
        return Response(exc.body(), status=exc.status)

Why the bodies live here rather than in the views
-------------------------------------------------
Because they are a frozen 1.x contract, and one home for them is the only way
to keep them frozen. The card endpoints return **five mutually incompatible**
409/403/400 shapes: ``wip_limit_exceeded`` and ``weight_limit_exceeded`` have no
``detail`` key at all; ``wip_hard_blocked`` has both ``detail`` and ``code``
(the ``swimlane_*`` limit bodies, #1150, reuse these two shapes plus a
``swimlane_name`` key);
the force-override denials have only ``detail``; and the move assignee gate is
the only 403 in the card API carrying a ``code``.
``frontend/src/components/Board/MoveBlockedToast.tsx`` reads ``code``,
``column_name``, ``wip_limit``, ``current_count`` and ``card_weight`` off these
bodies, so converging the shapes needs a major version bump. Until then
``boards/tests/test_card_error_bodies.py`` pins all of them by exact dict
equality.

The consequence is that this module — and only this module — knows about HTTP
status codes and one ``/api/v1/`` path. :mod:`boards.services.cards`, which
holds the actual domain logic, never constructs a response body. Keep it that
way: a new invariant adds a class here, not a dict in the view.

Not an extension point
----------------------
Unlike :mod:`boards.hooks`, this module carries **no** stability guarantee.
Enterprise code must not catch these classes or depend on their shape yet; the
hierarchy is expected to change when the error bodies are converged.
"""

# DRF's own default for ``PermissionDenied``, reproduced here so a non-HTTP
# caller gets the same text without importing rest_framework.
DEFAULT_PERMISSION_DENIED = "You do not have permission to perform this action."


class CardServiceError(Exception):
    """Base class for every card-mutation domain error.

    Subclasses set :attr:`status` and implement :meth:`body`. The two together
    are the whole adapter contract.
    """

    status: int = 400

    def body(self) -> dict:  # pragma: no cover - abstract
        raise NotImplementedError


# ---------------------------------------------------------------------------
# Authorization
# ---------------------------------------------------------------------------

class NotPermitted(CardServiceError):
    """Role allow-list or ownership gate refused the actor.

    ``detail`` defaults to DRF's stock 403 text, which is what the role
    allow-list returns on every card action. The ownership gates pass a
    per-action message ("You can only archive cards you created.", etc.).
    """

    status = 403

    def __init__(self, detail: str = DEFAULT_PERMISSION_DENIED):
        self.detail = detail
        super().__init__(detail)

    def body(self) -> dict:
        return {"detail": self.detail}


class MoveNotPermitted(CardServiceError):
    """Move refused because the card is assigned to somebody else.

    The only 403 in the card API that carries a ``code`` key. Kept as its own
    class rather than a ``NotPermitted`` flag precisely so the extra key cannot
    be lost in a refactor.
    """

    status = 403
    detail = (
        "Moving a card assigned to another member requires "
        "Moderator or Admin access — ask a board admin."
    )

    def body(self) -> dict:
        return {"code": "permission_denied", "detail": self.detail}


class ForceNotPermitted(CardServiceError):
    """``?force=true`` was supplied by someone who is not a board admin.

    ``limit`` selects the wording: the WIP and weight overrides return
    different sentences and both are asserted in the suite.
    """

    status = 403
    _DETAIL = {
        "wip": "Only board admins can override a WIP limit.",
        "weight": "Only board admins can override a weight limit.",
    }

    def __init__(self, limit: str):
        if limit not in self._DETAIL:
            raise ValueError(f"unknown limit kind: {limit!r}")
        self.limit = limit
        super().__init__(limit)

    def body(self) -> dict:
        return {"detail": self._DETAIL[self.limit]}


# ---------------------------------------------------------------------------
# Lookup failures
#
# These reproduce Django's ``get_object_or_404`` message, which DRF renders as
# ``{"detail": "No Card matches the given query."}``. The string is built from
# the model's own ``object_name`` rather than hard-coded so it cannot drift from
# Django's wording silently; the exact bodies are pinned in
# ``test_card_error_bodies.py``.
# ---------------------------------------------------------------------------

class ObjectNotFound(CardServiceError):
    """A row does not exist, or exists but belongs to a different board.

    Both cases deliberately return the same 404 so the API never reveals that
    an id the caller guessed exists on a board they cannot see (IDOR).
    """

    status = 404
    model_name: str = "object"

    def body(self) -> dict:
        return {"detail": f"No {self.model_name} matches the given query."}


class CardNotFound(ObjectNotFound):
    model_name = "Card"


class ColumnNotFound(ObjectNotFound):
    model_name = "Column"


class SwimlaneNotFound(ObjectNotFound):
    model_name = "Swimlane"


class BoardNotFound(ObjectNotFound):
    """A board id does not exist, or exists but the caller has no role on it.

    Added for the MCP CRUD tools (#512), which resolve a board directly (no
    DRF ``get_object_or_404``/``PermissionDenied`` available to them) and need
    a typed error carrying the same IDOR-safe "identical response either way"
    guarantee ``ObjectNotFound`` already documents for its siblings above.
    """

    model_name = "Board"


# ---------------------------------------------------------------------------
# Concurrency
# ---------------------------------------------------------------------------

class InvalidVersion(CardServiceError):
    """The supplied ``version`` is not an integer.

    A coercion failure rather than a domain conflict, but it lives here — and
    the coercion lives in the service — because *when* it is raised is part of
    the frozen contract: the move endpoint reports it only after the role
    allow-list, the card lookup and the assignment gate have passed. Parsing it
    in the adapter instead would surface a 400 to a caller who should have seen
    a 403 or a 404.
    """

    status = 400

    def body(self) -> dict:
        return {"detail": "version must be an integer."}


class InvalidPosition(CardServiceError):
    """The supplied move ``position`` is not an integer.

    Raised at the same point in the move sequence as :class:`InvalidVersion`,
    for the same reason. An out-of-range integer is not an error: the service
    clamps it into the target cell (#1570).
    """

    status = 400

    def body(self) -> dict:
        return {"detail": "position must be an integer."}


class VersionConflict(CardServiceError):
    """The caller's ``version`` no longer matches the stored row.

    ``current_version`` is returned so a client can resynchronize without an
    extra fetch.
    """

    status = 409
    detail = "This card was modified by another user. Please refresh and try again."

    def __init__(self, current_version: int | None, detail: str | None = None):
        # ``detail`` overrides the class default for a conflict that is not
        # about an existing card's version: create_card_at_position losing its
        # cell-lock race (#1992), where no card exists and current_version is
        # None. The code, and so the contract clients branch on, is the same.
        self.current_version = current_version
        if detail is not None:
            self.detail = detail
        super().__init__(self.detail)

    def body(self) -> dict:
        return {
            "code": "version_conflict",
            "detail": self.detail,
            "current_version": self.current_version,
        }


class ContainerChanged(CardServiceError):
    """A column, swimlane or board delete kept gaining cards while it locked
    them (#1602).

    ``lock_cards_for_cascade`` retries when a card enters the container
    between its card lock and its column lock; this is raised only when every
    bounded attempt lost that race, so the caller gets a clean conflict to
    retry rather than a 500 at COMMIT. Nothing has been deleted.
    """

    status = 409
    detail = "Cards were added while this was being deleted. Please try again."

    def __init__(self):
        super().__init__(self.detail)

    def body(self) -> dict:
        return {"code": "container_changed", "detail": self.detail}


# ---------------------------------------------------------------------------
# Limit enforcement
# ---------------------------------------------------------------------------

class WipLimitExceeded(CardServiceError):
    """Soft WIP limit reached. A board admin may retry with ``?force=true``.

    Note the body has **no** ``detail`` key — the frontend renders its own
    sentence from ``column_name`` / ``current_count`` / ``wip_limit``. Adding a
    ``detail`` here would be a response-shape change.
    """

    status = 409

    def __init__(self, *, column_name: str, current_count: int, wip_limit: int):
        self.column_name = column_name
        self.current_count = current_count
        self.wip_limit = wip_limit
        super().__init__(column_name)

    def body(self) -> dict:
        return {
            "code": "wip_limit_exceeded",
            "column_name": self.column_name,
            "current_count": self.current_count,
            "wip_limit": self.wip_limit,
        }


class WipHardBlocked(CardServiceError):
    """Hard WIP limit reached — no override exists for any role.

    Distinct from :class:`WipLimitExceeded` because hard mode is independent of
    soft mode and must be evaluated *before* ``?force`` is even read, so the
    admin override path is unreachable. Its body carries both ``detail`` and
    ``code``, with ``detail`` first.

    Since #1428 it is also raised by card create and restore, not just move.
    ``detail`` still says "move blocked" there: the body is the frozen move
    contract reused verbatim, and clients branch on ``code``, never ``detail``.
    """

    status = 409
    detail = "WIP limit enforced — move blocked."

    def __init__(self, *, column_name: str, current_count: int, wip_limit: int):
        self.column_name = column_name
        self.current_count = current_count
        self.wip_limit = wip_limit
        super().__init__(self.detail)

    def body(self) -> dict:
        return {
            "detail": self.detail,
            "code": "wip_hard_blocked",
            "column_name": self.column_name,
            "current_count": self.current_count,
            "wip_limit": self.wip_limit,
        }


class WeightLimitExceeded(CardServiceError):
    """Column weight limit would be exceeded by this card's weight.

    Carries ``card_weight``, which its WIP sibling does not, and names its
    counters ``current_weight``/``weight_limit``. Also has no ``detail`` key.
    """

    status = 409

    def __init__(self, *, column_name: str, current_weight: int, weight_limit: int, card_weight: int):
        self.column_name = column_name
        self.current_weight = current_weight
        self.weight_limit = weight_limit
        self.card_weight = card_weight
        super().__init__(column_name)

    def body(self) -> dict:
        return {
            "code": "weight_limit_exceeded",
            "column_name": self.column_name,
            "current_weight": self.current_weight,
            "weight_limit": self.weight_limit,
            "card_weight": self.card_weight,
        }


# Swimlane (row) limits (#1150). Each body is its column sibling's body with
# a ``swimlane_`` code and one added key, ``swimlane_name``: the soft bodies
# have no ``detail``, the hard one has ``detail`` first. No third shape.
# ``column_name`` stays, naming the column of the target cell, because every
# limit 409 in the published schema carries it (required on create, restore
# and update) and the API compatibility gate forbids a response field going
# optional; the counts are the swimlane's. They are separate classes, not
# subclasses of the column errors, so a caller that catches
# ``WipLimitExceeded`` cannot be handed a row error by accident.
#
# One body names one constraint. When a placement trips several (a column and
# a row, or WIP and weight), ``enforce_column_limits`` raises the strictest
# (hard before block) and, among equally strict ones, the column before the
# row, WIP before weight. That keeps a board's existing column bodies
# byte-for-byte unchanged however its rows are configured, unless a row is
# strictly stricter. Naming both would need a second set of counters neither
# sibling has, which is the third shape. The board UI names the other tripped
# limit from its own state.

class SwimlaneWipLimitExceeded(CardServiceError):
    """Soft swimlane WIP limit reached. A board admin may retry with ``?force=true``."""

    status = 409

    def __init__(self, *, swimlane_name: str, column_name: str, current_count: int, wip_limit: int):
        self.swimlane_name = swimlane_name
        self.column_name = column_name
        self.current_count = current_count
        self.wip_limit = wip_limit
        super().__init__(swimlane_name)

    def body(self) -> dict:
        return {
            "code": "swimlane_wip_limit_exceeded",
            "column_name": self.column_name,
            "swimlane_name": self.swimlane_name,
            "current_count": self.current_count,
            "wip_limit": self.wip_limit,
        }


class SwimlaneWipHardBlocked(CardServiceError):
    """Hard swimlane WIP limit reached: no override exists for any role."""

    status = 409
    detail = "Swimlane WIP limit enforced — move blocked."

    def __init__(self, *, swimlane_name: str, column_name: str, current_count: int, wip_limit: int):
        self.swimlane_name = swimlane_name
        self.column_name = column_name
        self.current_count = current_count
        self.wip_limit = wip_limit
        super().__init__(self.detail)

    def body(self) -> dict:
        return {
            "detail": self.detail,
            "code": "swimlane_wip_hard_blocked",
            "column_name": self.column_name,
            "swimlane_name": self.swimlane_name,
            "current_count": self.current_count,
            "wip_limit": self.wip_limit,
        }


class SwimlaneWeightLimitExceeded(CardServiceError):
    """Swimlane weight limit would be exceeded. Weight has no hard mode."""

    status = 409

    def __init__(
        self, *, swimlane_name: str, column_name: str, current_weight: int, weight_limit: int,
        card_weight: int,
    ):
        self.swimlane_name = swimlane_name
        self.column_name = column_name
        self.current_weight = current_weight
        self.weight_limit = weight_limit
        self.card_weight = card_weight
        super().__init__(swimlane_name)

    def body(self) -> dict:
        return {
            "code": "swimlane_weight_limit_exceeded",
            "column_name": self.column_name,
            "swimlane_name": self.swimlane_name,
            "current_weight": self.current_weight,
            "weight_limit": self.weight_limit,
            "card_weight": self.card_weight,
        }


# Every limit refusal, column or row: what a caller that maps a refusal to its
# own message (the Django admin form) catches.
LIMIT_ERRORS = (
    WipLimitExceeded, WipHardBlocked, WeightLimitExceeded,
    SwimlaneWipLimitExceeded, SwimlaneWipHardBlocked, SwimlaneWeightLimitExceeded,
)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

class CardCreationNotAllowed(CardServiceError):
    """The target column has ``allow_card_creation`` off.

    The body is keyed by field name rather than ``detail`` because it came from
    a DRF ``ValidationError({"column": ...})`` and clients bind it to the field.
    """

    status = 400

    def body(self) -> dict:
        return {"column": "Card creation is not allowed in this column."}


class UseMoveEndpoint(CardServiceError):
    """A plain update tried to change ``column``, ``swimlane``, or ``position``
    (#1106, #1275).

    Any of the three would bypass WIP/weight enforcement and the
    ``CardMovement`` audit trail, which only the move transition evaluates.
    This lives in the service rather than the adapter on purpose: a future
    non-HTTP caller passing a ``column``/``swimlane``/``position`` field to
    :func:`boards.services.cards.update_card` would otherwise reintroduce
    exactly the bug #1106 fixed.
    """

    status = 400

    def __init__(self, field_name: str, *, board_pk: int, card_pk: int):
        self.field_name = field_name
        self.board_pk = board_pk
        self.card_pk = card_pk
        super().__init__(field_name)

    def body(self) -> dict:
        return {
            "code": "use_move_endpoint",
            "detail": (
                f"Changing a card's {self.field_name} via PATCH/PUT is not allowed — "
                "it bypasses WIP/weight limits and the movement audit trail. "
                f"Use POST /api/v1/boards/{self.board_pk}/cards/{self.card_pk}/move/ instead."
            ),
        }
