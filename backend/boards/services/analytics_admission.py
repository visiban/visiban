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
- ``ANALYTICS_MAX_MOVEMENTS``: how many movement rows one request may read.
  ``flow_metrics._movement_rows`` counts rows as it streams them against the
  active ticket, so a request is refused as soon as it passes the budget,
  before it holds more than that many rows, with no extra COUNT query.

A caller with no active ticket (a direct service caller, enterprise code, a
test) still gets ``settings.ANALYTICS_MAX_MOVEMENTS`` per load, never an
unlimited one.

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
# running plus waiting requests stay well under the database pool's default
# maximum (DATABASE_POOL_MAX_SIZE, 10): a waiting request holds a connection.
MAX_WAITERS = 4
# How long a REST request waits for a slot before it is refused. MCP tools
# never wait.
REST_WAIT_SECONDS = 8.0
RETRY_AFTER_SECONDS = 10

ANALYTICS_BUSY_CODE = "analytics_busy"
ANALYTICS_BUSY_DETAIL = "Analytics is busy on this server right now. Try again in a moment."
ANALYTICS_TOO_LARGE_CODE = "analytics_too_large"
ANALYTICS_TOO_LARGE_DETAIL = (
    "This board has too much history to analyze in one request on this server. "
    "Try a shorter date range, or ask your administrator."
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
    """One admitted request's movement budget, shared by every load it runs."""

    __slots__ = ("budget", "movements")

    def __init__(self, budget):
        self.budget = budget
        self.movements = 0


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


def _user_key(user):
    # Absent input denies (#1075): never admit a request that has no key.
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
            try:
                if _on_wait is not None:
                    _on_wait()
                deadline = time.monotonic() + REST_WAIT_SECONDS
                while _running >= limit:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        _release_key(key)
                        return False
                    _cond.wait(remaining)
            finally:
                _waiting -= 1
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


def _log(user_id, board_id, endpoint, movements, started, outcome):
    logger.info(
        "analytics.replay user_id=%d board_id=%d endpoint=%s movements=%d duration_ms=%d outcome=%s",
        user_id, board_id, endpoint, movements, int((time.monotonic() - started) * 1000), outcome,
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
        _log(key, board_id, endpoint, 0, started, "busy")
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
        _log(key, board_id, endpoint, ticket.movements, started, outcome)


def occupancy():
    """``(running, waiting, in_flight_by_user)``, for tests and diagnostics only."""
    with _cond:
        return _running, _waiting, dict(_in_flight)
