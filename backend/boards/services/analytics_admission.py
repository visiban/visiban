"""Admission to analytics computation: a concurrency limit and a size limit (#2428).

Every flow/analytics replay (``flow_metrics.load_*``) is admitted through
``analytics_slot`` at the request boundary (a REST action or an MCP tool),
never inside ``load_board_flow``: the cumulative-flow path loads twice, and a
slot taken per load would wait on itself at ``ANALYTICS_MAX_CONCURRENT=1``.

Two limits, both operator settings:

- ``ANALYTICS_MAX_CONCURRENT``: how many replays run at once in this process.
  The count is kept in-process on purpose, never in the cache: a shared cache
  that cannot be reached would have to either refuse everything or admit
  everything, and the limit exists to bound this process's own work.
- ``ANALYTICS_MAX_MOVEMENTS``: how many movement rows one request may hold
  in memory. A load that keeps the rows it reads (``load_board_flow``) counts
  them as ``held``; a pass that folds each card's rows and drops them (the
  cumulative-flow settled pass) counts them as streamed, against a fixed
  internal ceiling of ``STREAMED_ROWS_MULTIPLE`` times the same setting.
  Held rows are what one request's memory grows with; streamed rows cost
  CPU time, not memory, so they get the wider ceiling, and a runaway still
  stops with the same ``analytics_too_large``. Rows are counted as they
  stream (``Ticket.count_rows``), so a request is refused at the first row
  past its budget, with no extra COUNT query.

A caller with no active ticket (a direct service caller, enterprise code, a
test) gets a fresh per-load counter at ``settings.ANALYTICS_MAX_MOVEMENTS``
from ``row_counter()``, never an unlimited one.

No caller is exempt, site admins included. The per-user cap is keyed on
``user.pk``, so every token of one user shares it. In demo mode every
visitor shares the one ``visitor`` login, so the per-user cap is effectively
the global one there, which is acceptable for a demo.

The refusal bodies and ``Retry-After`` are constant: they never say how many
requests are running or waiting, or what the limits are.
"""

import logging
import threading
import time
from contextlib import contextmanager

from django.conf import settings
from rest_framework import status
from rest_framework.exceptions import APIException

logger = logging.getLogger(__name__)

# Requests one user may have running or waiting at once. Two fits the web
# app's Analytics page, which opens the overview and the heatmap together.
PER_USER_MAX_IN_FLIGHT = 2
# Requests that may wait for a slot at once, process-wide. Kept small so the
# running plus waiting requests stay well under the default connection pool
# size (DATABASE_POOL_MAX_SIZE, 10).
MAX_WAITERS = 4
# How long a REST request waits for a slot before it is refused. MCP tools
# never wait.
REST_WAIT_SECONDS = 8.0
RETRY_AFTER_SECONDS = 10
# The ceiling on streamed rows, as a multiple of ANALYTICS_MAX_MOVEMENTS. A
# streamed row is folded into its card's placement and dropped, so it costs
# CPU time and no lasting memory; the ceiling exists only so a runaway pass
# still ends. Four times the default budget is 600k rows: a streamed row
# costs some tens of microseconds of replay, so a pass at the ceiling stays
# well inside the proxy's 90 s read timeout at the chart's default CPU limit,
# while a board several years old whose recent history fits the budget still
# gets its whole-history pass.
STREAMED_ROWS_MULTIPLE = 4

ANALYTICS_BUSY_CODE = "analytics_busy"
ANALYTICS_BUSY_DETAIL = "Analytics is busy on this server right now. Try again in a moment."
ANALYTICS_TOO_LARGE_CODE = "analytics_too_large"
ANALYTICS_TOO_LARGE_DETAIL = (
    "This board has more history than this server is set up to analyze in one request. "
    "Ask your administrator to raise the server's analytics limit."
)


class AnalyticsBusy(APIException):
    """No analytics slot is free; retry after ``Retry-After`` seconds.

    Body ``{"code": "analytics_busy", "detail": "..."}``, the
    ``session_unavailable`` 503 shape. ``wait`` makes DRF's exception handler
    emit ``Retry-After``. ``body()`` is the MCP tools' error shape.
    """

    status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    default_detail = ANALYTICS_BUSY_DETAIL
    default_code = ANALYTICS_BUSY_CODE
    wait = RETRY_AFTER_SECONDS

    def __init__(self):
        super().__init__(
            detail={"code": ANALYTICS_BUSY_CODE, "detail": ANALYTICS_BUSY_DETAIL}, code=ANALYTICS_BUSY_CODE,
        )

    def body(self):
        return {"code": ANALYTICS_BUSY_CODE, "detail": ANALYTICS_BUSY_DETAIL}


class AnalyticsTooLarge(APIException):
    """The request would read more movement rows than ``ANALYTICS_MAX_MOVEMENTS``.

    Refused, never answered from part of the history: a partial answer would
    look like a real one. An operator raises the limit to analyze the board.
    """

    status_code = status.HTTP_422_UNPROCESSABLE_ENTITY
    default_detail = ANALYTICS_TOO_LARGE_DETAIL
    default_code = ANALYTICS_TOO_LARGE_CODE

    def __init__(self):
        super().__init__(
            detail={"code": ANALYTICS_TOO_LARGE_CODE, "detail": ANALYTICS_TOO_LARGE_DETAIL},
            code=ANALYTICS_TOO_LARGE_CODE,
        )

    def body(self):
        return {"code": ANALYTICS_TOO_LARGE_CODE, "detail": ANALYTICS_TOO_LARGE_DETAIL}


class Ticket:
    """One request's movement budget, shared by every load it runs.

    ``movements`` counts held rows against ``budget``; ``streamed`` counts
    rows a pass folds and drops, against ``budget * STREAMED_ROWS_MULTIPLE``.
    """

    __slots__ = ("budget", "movements", "streamed")

    def __init__(self, budget):
        self.budget = budget
        self.movements = 0
        self.streamed = 0

    def count_rows(self, n, *, held):
        """Count ``n`` rows just read; raise ``AnalyticsTooLarge`` past the limit.

        ``held`` is whether the caller keeps the rows until the load ends
        (memory) or folds and drops them as they pass (CPU only). A loop over
        movement rows calls this once per row (or per chunk) before using it.
        """
        if held:
            self.movements += n
            if self.movements > self.budget:
                raise AnalyticsTooLarge()
        else:
            self.streamed += n
            if self.streamed > self.budget * STREAMED_ROWS_MULTIPLE:
                raise AnalyticsTooLarge()


_cond = threading.Condition()
_running = 0
_waiting = 0
_in_flight: dict[int, int] = {}
_local = threading.local()
# Test seam: called (under the lock, just before the first wait) when a
# request starts waiting for a slot, so a test can prove it is waiting.
_on_wait = None


def active_ticket():
    """The ticket of the request this thread is running, or ``None``."""
    return getattr(_local, "ticket", None)


def movement_budget():
    """The movement budget a load reads against when no ticket is active."""
    return settings.ANALYTICS_MAX_MOVEMENTS


def row_counter():
    """The counter a load counts its rows on: the request's ticket, else a fresh one.

    Absent input never means unlimited (#1075): with no active ticket the
    load gets its own counter at ``ANALYTICS_MAX_MOVEMENTS``.
    """
    ticket = active_ticket()
    return ticket if ticket is not None else Ticket(movement_budget())


def _user_key(user):
    # Absent input denies (#1075): never admit a request that has no key. A
    # programming-error guard: every caller authenticates and authorizes the
    # board first, so no real request reaches this without a user.
    if user is None or not getattr(user, "is_authenticated", False) or getattr(user, "pk", None) is None:
        raise ValueError("analytics_slot needs an authenticated user")
    return user.pk


def _admit(key, wait):
    """Take a slot for ``key``; ``False`` when refused. Caller holds no lock."""
    global _running, _waiting
    limit = settings.ANALYTICS_MAX_CONCURRENT
    with _cond:
        if _in_flight.get(key, 0) >= PER_USER_MAX_IN_FLIGHT:
            return False
        if _running >= limit:
            if not wait or _waiting >= MAX_WAITERS:
                return False
            _in_flight[key] = _in_flight.get(key, 0) + 1
            _waiting += 1
            # Every way out of the wait that does not take the slot (a time
            # out, or an exception from the test seam or from the wait
            # itself) gives the user's in-flight count back.
            admitted = False
            try:
                if _on_wait is not None:
                    _on_wait()
                deadline = time.monotonic() + REST_WAIT_SECONDS
                while _running >= limit:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        return False
                    _cond.wait(remaining)
                admitted = True
            finally:
                _waiting -= 1
                if not admitted:
                    _release_key(key)
        else:
            _in_flight[key] = _in_flight.get(key, 0) + 1
        _running += 1
        return True


def _release_key(key):
    # Called with _cond held.
    count = _in_flight.get(key, 0) - 1
    if count > 0:
        _in_flight[key] = count
    else:
        _in_flight.pop(key, None)


def _release(key):
    global _running
    with _cond:
        _running -= 1
        _release_key(key)
        _cond.notify()


def _log(user_id, board_id, endpoint, movements, streamed, started, outcome):
    logger.info(
        "analytics.replay user_id=%d board_id=%d endpoint=%s movements=%d streamed=%d duration_ms=%d outcome=%s",
        user_id, board_id, endpoint, movements, streamed, int((time.monotonic() - started) * 1000), outcome,
    )


@contextmanager
def analytics_slot(user, *, board_id, endpoint, wait=False):
    """Run one analytics request inside a slot, or raise ``AnalyticsBusy``.

    Call it after the board is authorized and the parameters are validated,
    so a refusal never answers for a board the caller cannot see. ``wait``
    waits up to ``REST_WAIT_SECONDS`` for a slot (REST views); MCP tools pass
    ``wait=False`` and are refused at once. The slot is taken and released
    in the thread that runs the replay.
    """
    key = _user_key(user)
    started = time.monotonic()
    if not _admit(key, wait):
        _log(key, board_id, endpoint, 0, 0, started, "busy")
        raise AnalyticsBusy()
    ticket = Ticket(movement_budget())
    previous = active_ticket()
    _local.ticket = ticket
    outcome = "error"
    try:
        yield ticket
        outcome = "ok"
    except AnalyticsTooLarge:
        outcome = "too_large"
        raise
    finally:
        _local.ticket = previous
        _release(key)
        _log(key, board_id, endpoint, ticket.movements, ticket.streamed, started, outcome)


def occupancy():
    """``(running, waiting, in_flight_by_user)``, for tests and diagnostics only."""
    with _cond:
        return _running, _waiting, dict(_in_flight)
