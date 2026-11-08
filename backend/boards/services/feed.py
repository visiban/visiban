"""The change feed's per-reader redaction, in one place (#1114, #863).

A board change-feed row is stored once, as the broadcast payload, and filtered
on every read for the reader's role and identity. The filter has two layers and
both are required:

1. :func:`feed_queryset` excludes whole rows the reader may not see at all:
   per-user rows (``PER_USER_EVENTS``) belonging to someone else, and
   admin-only rows (``ADMIN_ONLY_EVENTS``) for a reader below admin.
2. :func:`serialize_feed_rows` renders the remaining rows through
   ``BoardEventSerializer``, which strips the per-reader fields
   (``is_moderator``, ``is_site_admin``, ``invite``, the actor's
   ``is_starred``, admin-only board fields, admin-only swimlane values).

Every reader of the feed goes through both: the REST feed
(``BoardViewSet.events``), the webhook dispatcher, and any enterprise reader
registered on ``boards.hooks.BOARD_EVENT_HOOKS``. Reading ``BoardEvent.data``
directly skips layer 2 and returns fields the socket never sends
(security-invariants Rules 8 and 10).

A reader that moves a cursor also bounds its read by :func:`feed_horizon`
(#2053). PostgreSQL draws an id when a row is inserted, not when it commits, so
without that bound a cursor can step past a lower id that commits a moment
later and never return to it. See :func:`feed_horizon`.
"""

import logging
import time
from typing import NamedTuple

from django.db import connection, transaction
from django.db.models import Max, Q, Subquery
from django.db.models.expressions import RawSQL
from django.db.models.functions import Coalesce, Greatest

from ..models import BoardEvent, BoardEventPruneMark, BoardEventPruneTypeMark
from ..permissions import ADMIN_ONLY_EVENTS, PER_USER_EVENTS, admin_only_event_visible

logger = logging.getLogger(__name__)


def _hidden_from(role, reader_id):
    """A ``Q`` over ``event`` and ``actor_id``: the rows this reader may not see at all.

    The one statement of the rule. :func:`feed_queryset` applies it to
    ``BoardEvent`` rows and :func:`prune_marks` to ``BoardEventPruneTypeMark``
    rows, which carry the same two columns on purpose, so a per-type mark only
    ever expires a reader's cursor for a pruned event the feed would have shown
    it (#2079). The type-blind record (``BoardEventPruneMark``) has no type to
    filter on and still counts. A new exclusion added here covers both. The
    feed's cursor handling reads only through those two functions as well: the
    check that a cursor is one of the board's rows, and the resume point a
    ``410`` hands back (:func:`reader_resume_cursor`), so every answer the feed
    gives about a cursor is decided by rows and marks this reader could see.

    Per-user rows are returned only to the user they belong to (#1677),
    matching the socket, which forwards them only to that user's own sessions.
    A row with no actor matches no reader; per-user events must be persisted
    with actor_id = the owning user. Admin-only rows (share_link.updated,
    #1967) reach admin / site_admin readers only, matching the socket.
    """
    if reader_id is None:
        hidden = Q(event__in=PER_USER_EVENTS)
    else:
        hidden = Q(event__in=PER_USER_EVENTS) & ~Q(actor_id=reader_id)
    if not admin_only_event_visible(role):
        hidden |= Q(event__in=ADMIN_ONLY_EVENTS)
    return hidden


def feed_queryset(board_id, *, role, reader_id):
    """Rows of *board_id*'s feed that a reader with *role* and *reader_id* may see.

    Ordered by nothing: callers add ``order_by("id")`` and their cursor filter.
    ``reader_id=None`` (an anonymous or external reader such as a webhook)
    matches no per-user row, and an unknown ``role`` sees no admin-only row.
    """
    # Filtered in the query, not after it, so a page stays `limit` rows long.
    return BoardEvent.objects.filter(board_id=board_id).exclude(_hidden_from(role, reader_id))


def serialize_feed_rows(board_id, rows, *, role, reader_id):
    """Render *rows* as the feed's public row shape for this reader.

    One bulk user fetch for the page's actors (#1663) and, only when the page
    holds swimlane rows, one query for the board's shareable swimlane field
    ids (#1677). Returns a list of dicts
    ``{id, event, data, actor_id, actor, created_at}``.
    """
    from ..serializers import BoardEventSerializer

    rows = list(rows)
    return BoardEventSerializer(
        rows,
        many=True,
        context={
            "role": role,
            "reader_id": reader_id,
            "actors": BoardEventSerializer.actor_map(rows),
            "shareable_swimlane_field_ids": (
                BoardEventSerializer.shareable_swimlane_field_ids(board_id, rows)
            ),
        },
    ).data


class PruneMarks(NamedTuple):
    """What retention pruning removed from one board's feed, as one reader sees it."""

    #: Highest id this reader must treat as missed: per-type marks it could have
    #: seen, and the type-blind record. A cursor below it is expired. ``None``
    #: when no recording pruner has touched the board.
    visible: int | None


def prune_marks(board_id, *, role, reader_id, events=None, count_unrecorded_floor=True):
    """Read *board_id*'s prune record for one reader (#2058, #2079).

    Per event type, a reader's cursor is expired only if a pruned event **it
    could have seen** is after it, so the per-type record is read through the
    feed's own rule (:func:`_hidden_from`). The type-blind record still counts on
    top of that. ``events``, when given, narrows further to the event
    types the reader takes (a webhook's subscription), and
    ``count_unrecorded_floor=False`` leaves out the floor that stands for a
    pre-#2058 pruner, which a webhook cannot be older than. Settled, and why:

    * **A user's own per-user event counts for that user.** The feed would have
      shown it to them, so their cursor expires; nobody else's does.
    * **Visibility is the reader's role now, not when the event was written.**
      Every feed row is filtered that way, so the check agrees with the page: a
      reader who has since become admin is expired by a pruned admin-only event
      (the feed now shows those rows, and this one is missing), and one who has
      since lost admin is not (the feed would no longer show it).
    * **A mark with no type detail counts for everyone.**
      ``BoardEventPruneMark.max_pruned_id`` does not say what was pruned, so it
      is treated as visible to every reader, which errs toward a re-sync, never
      toward a skip. See that model.

    Read it *after* the rows a caller is about to hand out. The prune deletes
    rows and raises the marks atomically, so a page read first and the marks
    read second can never show a row missing that the marks do not cover; the
    other order can.

    No authorization of its own: callers pass a board id they have already
    authorized (the feed view) or one the server set (a webhook's board).
    """
    blind = _type_blind_marks(board_id)
    if blind is None:
        # Every recording prune writes that row too, so no row means no type
        # marks: a never-pruned board costs one primary-key read.
        return PruneMarks(None)
    max_pruned_id, unrecorded_floor = blind
    visible = ~_hidden_from(role, reader_id)
    if events is not None:
        visible &= Q(event__in=events)
    typed = (
        BoardEventPruneTypeMark.objects.filter(board_id=board_id)
        .filter(visible)
        .aggregate(m=Max("max_pruned_id"))["m"]
    )
    return PruneMarks(
        visible=max(
            max_pruned_id,
            unrecorded_floor if count_unrecorded_floor else 0,
            typed or 0,
        ),
    )


def cursor_row_visible(board_id, after, *, role, reader_id):
    """Whether *after* is the id of a row of *board_id*'s feed this reader may see.

    The feed's check that a cursor names one of the board's rows (the fallback
    in ``_events_cursor_expired``), read through :func:`feed_queryset`, so a
    row the reader is not shown counts the same as an id that is not on the
    board. One indexed primary-key read.
    """
    return feed_queryset(board_id, role=role, reader_id=reader_id).filter(pk=after).exists()


def reader_resume_cursor(board_id, marks, *, role, reader_id, ceiling=None):
    """The ``next_cursor`` the feed's ``410`` hands this reader (#2058, #2126).

    ``max(newest row this reader may see, marks.visible)``, where *marks* is
    the :func:`prune_marks` result the caller just read for the same reader.
    ``ceiling``, when given, bounds the newest row: the feed passes its
    :func:`feed_horizon` (#2053), so the point is never past a lower id that is
    still uncommitted, which the reader's re-sync might not yet include.

    Why reader-scoped rather than :func:`resume_cursor`'s board-wide point:
    every position the feed hands a reader is then one this reader could
    already observe, a row the feed shows it or the visible mark its own ``410``
    boundary sits at. That is what lets :func:`cursor_row_visible` require a
    row the reader may see without ever answering ``410`` to a cursor the feed
    gave out. Resuming here is not expired: at the visible mark nothing it
    could have read was pruned after it, and above the mark its row is one the
    reader may see. A ``410`` only fires with something to resume past (a
    visible row after the cursor, or a visible mark above it), so the point is
    always above the cursor that was refused, never ``0``.

    The trade-off is that the point is only stable for the reader's role now.
    After a promotion, a pruned admin-only event after it expires it, which is
    the feed's role-now rule for every cursor (see :func:`prune_marks`), and
    errs toward a re-sync, never toward a skip.

    Read *marks* after the page, as the view does, for the reason
    :func:`prune_marks` gives. The newest row is read here, after the marks:
    an event written in between is replayed after the re-sync rather than
    lost, at-least-once, never a gap.
    """
    rows = feed_queryset(board_id, role=role, reader_id=reader_id)
    if ceiling is not None:
        rows = rows.filter(pk__lte=ceiling)
    newest = rows.aggregate(newest=Max("id"))["newest"]
    return max(newest or 0, marks.visible or 0)


def _reader_position_querysets(board_id, at_or_below, *, role, reader_id):
    """The three single-column querysets behind :func:`reader_position`, newest first.

    *board_id* and *at_or_below* may be plain values or ``OuterRef`` s, so the
    same three filters serve the one-row read and the list annotation.
    """
    rows = (
        feed_queryset(board_id, role=role, reader_id=reader_id)
        .filter(pk__lte=at_or_below)
        .order_by("-id")
        .values_list("id", flat=True)
    )
    typed = (
        BoardEventPruneTypeMark.objects.filter(board_id=board_id, max_pruned_id__lte=at_or_below)
        .exclude(_hidden_from(role, reader_id))
        .order_by("-max_pruned_id")
        .values_list("max_pruned_id", flat=True)
    )
    blind = BoardEventPruneMark.objects.filter(board_id=board_id, max_pruned_id__lte=at_or_below).values_list(
        "max_pruned_id", flat=True
    )
    return rows, typed, blind


def reader_position(board_id, at_or_below, *, role, reader_id):
    """The highest position at or below *at_or_below* on this reader's feed, or 0 (#2135).

    ``max(newest row this reader may see, its visible per-type prune mark,
    the type-blind max_pruned_id)``, each taken only where it is at or below
    *at_or_below*. The same rows and marks as :func:`reader_resume_cursor`,
    bounded above, and without the unrecorded floor, which names no row. A
    caller that keeps a board-wide position (a webhook's stored cursor) uses
    it to report that position on the reader's own feed: the answer is never
    above the stored value and is built only from rows and marks the reader
    could see. Where every row up to the stored value was pruned and a mark of
    the same type sits above it, the answer can be lower than the last row the
    reader saw, never higher. Three indexed reads; for many rows at once see
    :func:`reader_position_subquery`.
    """
    return max(
        (next(iter(qs[:1]), None) or 0)
        for qs in _reader_position_querysets(board_id, at_or_below, role=role, reader_id=reader_id)
    )


def reader_position_subquery(board_ref, at_or_below_ref, *, role, reader_id):
    """:func:`reader_position` as one expression, for an ``annotate`` over many rows.

    *board_ref* and *at_or_below_ref* are ``OuterRef`` s to the outer row's
    board id and stored position. Each part is coalesced to 0 first, because
    ``Greatest`` is NULL on SQLite when any argument is.
    """
    return Greatest(
        *(
            Coalesce(Subquery(qs[:1]), 0)
            for qs in _reader_position_querysets(board_ref, at_or_below_ref, role=role, reader_id=reader_id)
        )
    )


def pruned_through(board_id):
    """The highest event id retention pruning removed from *board_id*'s feed, or ``None``.

    Board-wide, of any event type: the position past everything pruned, which is
    what :func:`resume_cursor` needs. Whether a given reader's
    cursor is expired is :func:`prune_marks`. ``None`` means nothing has been
    pruned from the board since the mark table existed, not that nothing was
    ever pruned: see ``BoardEventPruneMark``.
    """
    blind = _type_blind_marks(board_id)
    if blind is None:
        return None
    typed = BoardEventPruneTypeMark.objects.filter(board_id=board_id).aggregate(m=Max("max_pruned_id"))["m"]
    return max(*blind, typed or 0)


def _type_blind_marks(board_id):
    """``(max_pruned_id, unrecorded_floor)`` of the board's row, or ``None``. One primary-key read."""
    return (
        BoardEventPruneMark.objects.filter(board_id=board_id)
        .values_list("max_pruned_id", "unrecorded_floor")
        .first()
    )


def newest_event_id(board_id):
    """The newest surviving event id on *board_id*'s feed, or 0. One indexed ``MAX``.

    Not a safe point to move a cursor to: a lower id may still be uncommitted.
    A reader that advances a cursor uses :func:`feed_horizon`.
    """
    return BoardEvent.objects.filter(board_id=board_id).aggregate(newest=Max("id"))["newest"] or 0


# -- commit-safe horizon (#2053) ----------------------------------------------
#
# The problem: ``board_events.id`` comes from a sequence, which PostgreSQL
# advances at INSERT. Transaction A can draw id 10, transaction B draw 11 and
# commit first, and a reader polling in between sees 11 without 10. If it moves
# its cursor to 11, it never reads 10.
#
# The fix has two parts that share one advisory lock key per board:
#
# * Every writer takes the key in SHARED mode, in the same statement that draws
#   the row's id and before the id is drawn (:func:`event_id_after_writer_lock`),
#   and keeps it until its transaction ends. Shared holders never wait for each
#   other, so writers are not serialized and cannot deadlock on it, including a
#   transaction that writes events on two boards in either order.
# * A reader reads the newest visible id first, and then checks, without
#   waiting, that no writer holds the key (:func:`feed_horizon`). If none does,
#   every writer that drew an id at or below that newest id has ended, so every
#   row up to it that will ever exist is committed and visible. The reader
#   hands out nothing above that point.
#
# Why not make writers take an exclusive per-board lock, so ids follow commit
# order? A transaction that writes events on two boards (a container delete
# that lowers ``blocker_count`` on a card of another board, see
# ``services.cards._blocked_peer_ids``) would take two such locks, and two of
# them in opposite orders deadlock. The lock would also be held from the event insert
# to commit while the writer still takes card and column row locks, which is
# another deadlock path. It would also serialize every write on a board. The
# shared/probe split costs a writer nothing unless a reader is probing at the
# same instant. The probe never waits, and a writer that asks for its shared
# lock during a probe waits only for that one statement.

#: Advisory lock namespace (the first int4 of the two-key form). The two-key
#: form never shares a key with the one-bigint form ``migrate_with_lock`` uses.
FEED_LOCK_NAMESPACE = 11142053

#: How many times :func:`feed_horizon` probes before it reports a writer in
#: flight, and how long it sleeps between probes. Writes normally commit in
#: milliseconds, so a short retry clears most probes. This only delays a reader
#: on a board that is being written to at that moment.
HORIZON_PROBES = 3
HORIZON_PROBE_INTERVAL_SECONDS = 0.02


def feed_lock_key(board_id):
    """``(namespace, objid)`` for *board_id*'s feed lock, both int4.

    ``board_id`` is a bigint and the key is two int4s, so the id is folded into
    32 bits. Two boards 2**32 ids apart share a key. That is harmless: the
    probe is then stricter than it needs to be, never looser.
    """
    return FEED_LOCK_NAMESPACE, ((int(board_id) + 2**31) % 2**32) - 2**31


def event_id_after_writer_lock(board_id):
    """An id expression for a new ``BoardEvent`` row that is drawn under the writer lock.

    PostgreSQL only. ``persist_board_event`` passes this as the row's ``id``, so
    the INSERT takes *board_id*'s feed lock in SHARED mode and only then draws
    ``nextval``, in one statement, with no extra round trip. The lock is
    transaction-scoped, so it is held until the writer's transaction commits or
    rolls back, and released at the end of the statement when there is no
    transaction. ``OFFSET 0`` keeps the planner from flattening the subquery,
    so the lock is taken when the row it yields is produced, before the
    ``nextval`` computed from that row. ``test_event_id_is_drawn_after_the_writer_lock``
    pins the order.
    """
    namespace, objid = feed_lock_key(board_id)
    return RawSQL(
        "(SELECT nextval(pg_get_serial_sequence(%s, %s)) "
        "FROM (SELECT pg_advisory_xact_lock_shared(%s, %s) OFFSET 0) AS feed_writer_lock)",
        (BoardEvent._meta.db_table, BoardEvent._meta.pk.column, namespace, objid),
    )


class _EndProbe(Exception):
    """Raised to roll back the savepoint that holds a probe's lock."""


def _probe(board_id):
    """``(newest visible id, no writer in flight)`` for *board_id*, in one statement.

    The statement's snapshot is taken when it starts, before the lock function
    runs, so the newest id is always read *before* the probe, whatever order
    PostgreSQL evaluates the two columns in. The probe is a non-blocking
    exclusive try-lock, so it never waits for a writer. A writer that asks for
    its shared lock while the probe holds the key waits for that one
    statement only. The probe succeeds only when no writer holds the key.

    The try-lock is transaction-scoped and must not outlive the probe. If it
    did, every writer on the board would wait behind it. Outside a transaction
    the statement is its own transaction, so the lock ends with it. Inside one
    (a caller's ``atomic`` block, or a test case), the statement runs in a
    savepoint that is rolled back, which releases the lock and leaves the
    caller's transaction as it was.
    """
    namespace, objid = feed_lock_key(board_id)
    sql = (
        f"SELECT (SELECT MAX({connection.ops.quote_name(BoardEvent._meta.pk.column)}) "
        f"FROM {connection.ops.quote_name(BoardEvent._meta.db_table)} WHERE board_id = %s), "
        "pg_try_advisory_xact_lock(%s, %s)"
    )
    params = (board_id, namespace, objid)
    if not connection.in_atomic_block:
        with connection.cursor() as cursor:
            cursor.execute(sql, params)
            newest, clear = cursor.fetchone()
        return newest or 0, clear
    result = None
    try:
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(sql, params)
            result = cursor.fetchone()
            raise _EndProbe
    except _EndProbe:
        pass
    newest, clear = result
    return newest or 0, clear


def feed_horizon(board_id, *, probes=HORIZON_PROBES):
    """The highest id of *board_id*'s feed a cursor may move to now, or ``None`` (#2053).

    Every row of the board with an id at or below the returned value that will
    ever exist is already committed. A reader that hands out only rows up to it,
    and moves a cursor no further, cannot skip a row that commits later. That
    includes a row whose id is lower than one already visible. Rows above it
    are returned by a later read.

    ``None`` means a write to this board was still in flight at every probe, so
    no point past what the caller already holds is safe. The caller hands out
    nothing new this time. A reader on a board with a long transaction in
    flight (a large import) gets ``None`` until that transaction ends. That is a
    delay, never a skip.

    ``probes`` is how many times to probe, ``HORIZON_PROBES`` apart by
    ``HORIZON_PROBE_INTERVAL_SECONDS``. The REST feed keeps the default, so a
    write that commits within a few tens of milliseconds still reaches the
    poll. The webhook dispatcher passes 1 and never sleeps: its next run is the
    retry, and a sleep there would add up across every subscription in the run.

    Two readers probing the same board in the same instant also fail each
    other's probe, because the probe is an exclusive try-lock. It is held only
    for the one statement, so this is rare and is cleared by the next probe or
    poll. A read-only probe of ``pg_locks`` would avoid it, but reading
    ``pg_locks`` takes every lock-manager partition lock, which on each poll
    would contend with lock acquisition across the whole instance.

    **Requires READ COMMITTED** (Django's and PostgreSQL's default): the
    caller's next query must take a fresh snapshot, so it sees the rows the
    probe has just shown to be committed. Under REPEATABLE READ the snapshot
    predates the probe, and the bound proves nothing.

    SQLite (development and the default test settings) holds a single
    database-wide write lock from a transaction's first write to its commit,
    so ids there are already drawn in commit order and the newest id is the
    horizon. One query either way, plus a short sleep and a re-probe only while
    a write is in flight on PostgreSQL.
    """
    if connection.vendor != "postgresql":
        return newest_event_id(board_id)
    for attempt in range(max(1, probes)):
        if attempt:
            time.sleep(HORIZON_PROBE_INTERVAL_SECONDS)
        newest, clear = _probe(board_id)
        if clear:
            return newest
    # DEBUG: a write in flight is normal and usually clears by the next poll.
    # A board that logs this on every poll has a transaction left open; the
    # events docs give the query that finds it. Board id only.
    logger.debug("board feed held back by an open write: board_id=%s probes=%s", board_id, probes)
    return None


def resume_cursor(board_id):
    """The newest position on *board_id*'s feed: ``max(newest event id, prune mark)`` (#2058).

    Where a webhook that is told to skip ahead (it is created at it or
    re-enabled from it with ``resume_from: latest``) should stand so that it is
    not immediately expired again. The feed's ``410`` hands a reader
    :func:`reader_resume_cursor` instead, which is computed from the rows and
    marks that reader may see (#2126). The newest surviving id alone is not enough: when every
    event after a cursor was pruned and nothing newer exists, it sits *below*
    the mark (or there is none), and a cursor there would still be expired.
    A cursor at the mark is never expired (nothing after it was pruned), and
    neither is one at the newest row (its row exists).

    Board-wide on purpose (#2079): it is never below any reader's visible mark,
    whatever the webhook's types become later. It is a stored position only:
    the API reports a webhook's cursor through :func:`reader_position` (#2135).
    """
    return max(newest_event_id(board_id), pruned_through(board_id) or 0)
