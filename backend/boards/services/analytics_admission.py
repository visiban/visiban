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
  cumulative-flow settled pass and the day drill-down, which read only each
  card's deciding rows, #2444) counts them as streamed, against a fixed
  internal ceiling of ``STREAMED_ROWS_MULTIPLE`` times the same setting.
  Held rows are what one request's memory grows with; streamed rows cost
  CPU time, not memory, so they get the wider ceiling, and a runaway still
  stops with the same ``analytics_too_large``. Rows are counted as they
  stream (``Ticket.count_rows``), so a request is refused at the first row
  past its budget, with no extra COUNT query.

A third limit bounds how long one admitted request may run:

- ``ANALYTICS_MAX_SECONDS``: wall-clock seconds from admission. A sync view
  cannot be stopped from outside once it runs, so the request stops itself:
  every query it starts inside the slot checks the deadline first, and on
  PostgreSQL runs under a ``statement_timeout`` of the time left, so one
  long statement cannot outlast it; the row loops check it too
  (``Ticket.count_rows``). Past the deadline the request ends with a 503
  ``analytics_timeout``, and the ``finally`` below gives the slot back. That
  is the guarantee for a client that went away: under ASGI a sync view
  learns of a disconnect only when it writes its response, so a request
  whose client left still runs, but never longer than this bound.

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

import psycopg
from django.conf import settings
from django.db import OperationalError, connection
from rest_framework import status
from rest_framework.exceptions import APIException

logger = logging.getLogger(__name__)

# Requests one user may have running or waiting at once. Two fits the web
# app's Analytics page, which sends the overview and then the heatmap one after the other, so a
# new open can briefly overlap the tail of the previous one.
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
# How many rows ``Ticket.count_rows`` lets pass between two reads of the clock.
DEADLINE_CHECK_ROWS = 1000
# How stale the last statement_timeout may get before a query sets it again.
# A setting made at t0 lets a statement started at t1 run to the deadline
# plus (t1 - t0), so this is the most a statement may outlast the deadline;
# re-setting it only this often keeps a quick request at one extra round trip.
STATEMENT_TIMEOUT_SLACK_SECONDS = 0.5
# The PostgreSQL error a cancelled statement raises (statement_timeout).
_QUERY_CANCELED = "57014"

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


ANALYTICS_TIMEOUT_CODE = "analytics_timeout"
ANALYTICS_TIMEOUT_DETAIL = (
    "This analysis took longer than this server allows for one request. "
    "Try a shorter range, or ask your administrator to raise the server's analytics time limit."
)


class AnalyticsTimedOut(APIException):
    """The request ran past ``ANALYTICS_MAX_SECONDS`` and was stopped.

    Refused, never answered from the part computed so far. No
    ``Retry-After``: the same request on the same board would most likely
    take as long again.
    """

    status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    default_detail = ANALYTICS_TIMEOUT_DETAIL
    default_code = ANALYTICS_TIMEOUT_CODE

    def __init__(self):
        super().__init__(
            detail={"code": ANALYTICS_TIMEOUT_CODE, "detail": ANALYTICS_TIMEOUT_DETAIL}, code=ANALYTICS_TIMEOUT_CODE,
        )

    def body(self):
        return {"code": ANALYTICS_TIMEOUT_CODE, "detail": ANALYTICS_TIMEOUT_DETAIL}


class Ticket:
    """One request's movement budget and deadline, shared by every load it runs.

    ``movements`` counts held rows against ``budget``; ``streamed`` counts
    rows a pass folds and drops, against ``budget * STREAMED_ROWS_MULTIPLE``.
    ``deadline`` is a ``time.monotonic()`` instant; every ticket has one.
    """

    __slots__ = ("budget", "movements", "streamed", "deadline", "_until_check")

    def __init__(self, budget, deadline):
        self.budget = budget
        self.movements = 0
        self.streamed = 0
        self.deadline = deadline
        self._until_check = DEADLINE_CHECK_ROWS

    def remaining(self):
        """Seconds left before ``deadline`` (negative once it has passed)."""
        return self.deadline - time.monotonic()

    def check_deadline(self):
        """Raise ``AnalyticsTimedOut`` once the deadline has passed."""
        if self.remaining() <= 0:
            raise AnalyticsTimedOut()

    def count_rows(self, n, *, held):
        """Count ``n`` rows just read; raise ``AnalyticsTooLarge`` past the limit.

        ``held`` is whether the caller keeps the rows until the load ends
        (memory) or folds and drops them as they pass (CPU only). A loop over
        movement rows calls this once per row (or per chunk) before using it.
        """
        self._until_check -= n
        if self._until_check <= 0:
            self._until_check = DEADLINE_CHECK_ROWS
            self.check_deadline()
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
    load gets its own counter at ``ANALYTICS_MAX_MOVEMENTS``, with a deadline
    ``ANALYTICS_MAX_SECONDS`` from now that its row loops check.
    """
    ticket = active_ticket()
    return ticket if ticket is not None else Ticket(movement_budget(), _deadline())


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


def time_budget():
    """Seconds one admitted request may run (``ANALYTICS_MAX_SECONDS``)."""
    return settings.ANALYTICS_MAX_SECONDS


def _deadline():
    return time.monotonic() + time_budget()


def _is_query_canceled(exc):
    cause = exc.__cause__
    return getattr(cause, "sqlstate", None) == _QUERY_CANCELED


class _DeadlineWrapper:
    """``connection.execute_wrapper`` that keeps each query of a slot inside its deadline.

    Before a query starts: refuse it once the deadline has passed, and on
    PostgreSQL set ``statement_timeout`` to the time left, so the database
    cancels a statement that would outlast the request. The operator's own
    ``statement_timeout`` (read once, before the first change) is never
    loosened: the lower of the two applies. The setting is written on the
    raw connection, outside Django's query log, so it adds nothing to a
    query count, and only when the last setting is more than
    ``STATEMENT_TIMEOUT_SLACK_SECONDS`` old. A server-side cursor's later
    FETCHes run under the value its DECLARE set; the row loop's deadline
    check stops them. The setting is per session, so it needs Django's own
    connections or a session-mode pooler, not a transaction-mode one; ``restore`` puts the value read before the first change
    back when the slot ends, so a pooled connection never keeps it.
    """

    def __init__(self, ticket):
        self.ticket = ticket
        self.db = None
        self.raw = None
        self.session_ms = None
        self.applied_at = None

    def __call__(self, execute, sql, params, many, context):
        self.ticket.check_deadline()
        db = context["connection"]
        if db.vendor == "postgresql":
            self._apply(db, db.connection)
        return execute(sql, params, many, context)

    def _apply(self, db, raw):
        # An aborted transaction refuses every statement until its rollback:
        # leave the query to raise Django's own error.
        if raw.info.transaction_status == psycopg.pq.TransactionStatus.INERROR:
            return
        if self.raw is not None and raw is not self.raw:
            # Django reconnected inside the slot: put the old connection's
            # value back (if it is still open) and start over on the new one.
            self.restore()
            self.raw = None
            self.applied_at = None
        if self.raw is None:
            row = raw.execute("SELECT setting FROM pg_settings WHERE name = 'statement_timeout'").fetchone()
            self.session_ms = int(row[0]) if row else 0
            self.db = db
            self.raw = raw
        now = time.monotonic()
        if self.applied_at is not None and now - self.applied_at <= STATEMENT_TIMEOUT_SLACK_SECONDS:
            return
        # At least 1 ms: 0 would mean "no timeout" to PostgreSQL.
        ms = max(1, int((self.ticket.deadline - now) * 1000))
        if self.session_ms:
            ms = min(ms, self.session_ms)
        self._set(raw, ms)
        self.applied_at = now

    @staticmethod
    def _set(raw, ms):
        raw.execute("SELECT set_config('statement_timeout', %s, false)", (str(ms),))

    def restore(self):
        raw = self.raw
        if raw is None or raw.closed:
            return
        if raw.info.transaction_status == psycopg.pq.TransactionStatus.INERROR:
            # A statement was cancelled inside an atomic block: the rollback
            # undoes the setting too, since SET is transactional in PostgreSQL.
            return
        try:
            self._set(raw, self.session_ms)
        except psycopg.Error:
            # The value could not be put back on a live connection: close it
            # so it is never reused (or returned to the pool) with it.
            logger.warning("analytics.replay could not restore statement_timeout; closing the connection")
            if self.db is not None and self.db.connection is raw:
                self.db.close()
            else:
                raw.close()


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
    in the thread that runs the replay. Once admitted, the request runs at
    most ``ANALYTICS_MAX_SECONDS`` and is otherwise stopped with
    ``AnalyticsTimedOut``.
    """
    key = _user_key(user)
    started = time.monotonic()
    if not _admit(key, wait):
        _log(key, board_id, endpoint, 0, 0, started, "busy")
        raise AnalyticsBusy()
    ticket = Ticket(movement_budget(), _deadline())
    previous = active_ticket()
    _local.ticket = ticket
    wrapper = _DeadlineWrapper(ticket)
    outcome = "error"
    # Every way out (an answer, a refusal, the deadline, any other error)
    # passes the ``finally``, so the slot is always given back.
    try:
        with connection.execute_wrapper(wrapper):
            try:
                yield ticket
            except OperationalError as exc:
                if not _is_query_canceled(exc):
                    raise
                raise AnalyticsTimedOut() from exc
        outcome = "ok"
    except AnalyticsTooLarge:
        outcome = "too_large"
        raise
    except AnalyticsTimedOut:
        outcome = "timeout"
        raise
    finally:
        wrapper.restore()
        _local.ticket = previous
        _release(key)
        _log(key, board_id, endpoint, ticket.movements, ticket.streamed, started, outcome)


def occupancy():
    """``(running, waiting, in_flight_by_user)``, for tests and diagnostics only."""
    with _cond:
        return _running, _waiting, dict(_in_flight)
