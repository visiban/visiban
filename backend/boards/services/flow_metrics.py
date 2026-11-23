"""The one implementation of the flow metrics (#448, ADR #1532).

Lead time, cycle time, dwell time (completed and current), age, WIP, throughput
and cumulative flow are computed here and nowhere else. The REST endpoints, the
Summary and Analytics views, and the later MCP tools (#1151) all call this
module, so one card gives one number on every surface. The definitions, and the
reasoning behind each rule below, are the "Flow metric definitions" record in
``docs/architecture/decisions.md``; a rule that looks odd here is explained
there. Change the record first, then this file.

Everything here is independent of HTTP. ``load_board_flow`` issues a fixed
number of queries (columns, cards, movements) whatever the board's size, then
each metric is a pure function over that one in-memory snapshot. That is why a
per-card replay in Python is the shape, not grouped SQL: "the column a card was
in at the end of a day", "complete history" and "first entry into a done column"
are all properties of a card's ordered history, not of any single row, so a
``GROUP BY to_column_id`` cannot answer them.

Every function returns plain JSON-ready data (strings, numbers, lists, dicts),
so a transport serializes the result as it stands.
"""

import bisect
import datetime
from dataclasses import dataclass, field
from typing import NamedTuple

from django.db.models import Case, CharField, Exists, F, OuterRef, Q, Value, When, Window
from django.db.models.functions import Concat, RowNumber
from django.utils import timezone

from ..models import (
    Card, CardBlock, CardGateTransition, CardMovement, CardRelation, Column, SubColumn,
    SwimlaneCustomFieldValue,
)

# The sample-size floor (ADR "Percentiles and sample size"). The one place it
# lives, so the API and the UI cannot disagree: the UI draws what comes back.
MIN_PERCENTILE_SAMPLE_SIZE = 5
PERCENTILES = (50, 85, 95)
SECONDS_PER_DAY = 86_400
# Whole ISO weeks and enough completions for P85/P95 on a small team (ADR).
DEFAULT_RANGE_DAYS = 90
# How many reasons the blocked-time summary's "top reasons" list returns (#1149).
TOP_BLOCK_REASONS = 10

# Quoted verbatim from the ADR, and by docs/features/analytics.md.
DEFINITIONS = {
    "lead_time": (
        "the time from when a card was created to its first entry into a done column. "
        "A card created in a done column has no lead time."
    ),
    "cycle_time": (
        "the time from a card's first move out of the column it was created in, to a column "
        "that is not done, until its first entry into a done column. A card created in a done "
        "column, or moved straight from its first column to done, has no cycle time."
    ),
    "dwell_time": (
        "how long a card stayed in one column, from entering it to leaving it, or until now if "
        "it is still there. Moving to another swimlane does not end a stay. Archiving ends it, "
        "and restoring starts a new one."
    ),
    "age": (
        "how long an in-progress card has been in progress: the time since it first moved out "
        "of the column it was created in, or since it last left a done column, whichever is "
        "later."
    ),
    "throughput": "the number of cards whose first entry into a done column falls in a period.",
    "wip": "the number of cards, not archived, currently in each column that is not done.",
    "cumulative_flow": "for each day, the number of cards in each column at the end of that day.",
    "blocked_time": (
        "the time cards spent blocked, reported as its own metric: total, per column and per reason. "
        "It is never subtracted from lead time, cycle time, dwell time or age."
    ),
    "needs_attention": (
        "the cards, not archived and not in a done column, that are blocked, have been in progress "
        "longer than the 85th percentile of cycle time, or have not moved for longer than the "
        "board's stalled threshold."
    ),
}

# A board with a commitment point (#2050) measures cycle time and age from it.
# Quoted verbatim from the ADR's dated #2050 note. Boards without one keep the
# DEFINITIONS above, word for word.
COMMITMENT_DEFINITIONS = {
    "cycle_time": (
        "the time from a card's first entry into the board's commitment column, or a column "
        "after it that is not done, until its first entry into a done column. A card that "
        "reaches a done column first has no cycle time."
    ),
    "age": (
        "how long an in-progress card has been in progress: the time since it first entered the "
        "board's commitment column or a column after it, or since it last left a done column, "
        "whichever is later."
    ),
}


def definition(metric, flow=None):
    """The definition string a response serves for ``metric`` on ``flow``'s board."""
    if flow is not None and flow.committed_uids is not None and metric in COMMITMENT_DEFINITIONS:
        return COMMITMENT_DEFINITIONS[metric]
    return DEFINITIONS[metric]


def committed_column_uids(board, columns):
    """The uids at or past the board's commitment point, or None when it has none (#2050).

    "Past" is by current position: the commitment column and every column after
    it, done columns left out (a done entry is a completion, not a start). A uid
    that no longer names a current, not-done column reads as unset, so deleting
    the commitment column returns the board to the ADR's default rule.
    """
    uid = getattr(board, "commitment_column_uid", None)
    if not uid:
        return None
    anchor = next((c for c in columns if c.uid == uid and not c.is_done), None)
    if anchor is None:
        return None
    return {c.uid for c in columns if not c.is_done and c.position >= anchor.position}

_UTC = datetime.timezone.utc
_MOVE = CardMovement.MovementType.MOVE
_ARCHIVED = CardMovement.MovementType.ARCHIVED
_UNARCHIVED = CardMovement.MovementType.UNARCHIVED
# The key of the deleted-columns band in a cumulative-flow day's ``counts``: a
# JSON object key is a string, so ``column_uid: null`` reads as "null" there.
NULL_BAND_KEY = "null"
# A cumulative-flow placement for a card that has left the diagram.
_OFF_DIAGRAM = object()


class _NameKey(NamedTuple):
    """A column known only by its name snapshot.

    A distinct type rather than a string, so a name can never compare equal to
    a current column's uid: a column deleted and recreated under the same name
    is a different column (ADR "Current column").
    """

    name: str


def _column_key(snapshot_uid, fk_uid, name):
    """The ADR's column key: uid snapshot, then the FK's uid, then the name, else unknown."""
    if snapshot_uid:
        return snapshot_uid
    if fk_uid:
        return fk_uid
    if name:
        return _NameKey(name)
    return None


def _present(field_name):
    """``field_name`` is truthy in Python's sense: neither NULL nor ``''``."""
    return Q(**{f"{field_name}__isnull": False}) & ~Q(**{field_name: ""})


def _sql_column_key(side):
    """``_column_key`` for the ``from``/``to`` ``side`` of a movement row, as a SQL expression (#2444).

    Used only to pick which rows ``_deciding_rows`` reads; every key the
    replay compares is still built in Python from the raw fields. Each branch
    is type-prefixed (``u`` for a uid, snapshot or FK, ``n`` for a name) so a
    column name never equals a uid, as ``_NameKey`` keeps them apart in
    Python. The snapshot uid and the FK's uid share a prefix because Python
    compares them as the same plain string.
    """
    uid, fk_uid, name = f"{side}_column_uid", f"{side}_column__uid", f"{side}_column_name"
    return Case(
        When(_present(uid), then=Concat(Value("u"), F(uid), output_field=CharField())),
        When(_present(fk_uid), then=Concat(Value("u"), F(fk_uid), output_field=CharField())),
        When(_present(name), then=Concat(Value("n"), F(name), output_field=CharField())),
        default=Value(None, output_field=CharField()),
        output_field=CharField(),
    )


# ── Percentiles ────────────────────────────────────────────────────────────


def percentile_rank(p, n):
    """1-based nearest rank: ⌈p × n / 100⌉ in integer arithmetic, so it never rounds up."""
    return (p * n + 99) // 100


def percentile(sorted_values, p):
    """Nearest-rank percentile of an ascending list, or None under the sample-size rule.

    Returned only with at least ``MIN_PERCENTILE_SAMPLE_SIZE`` values and a rank
    below n, so a value is never just the largest one presented as a tail: p50
    needs 5, p85 needs 7, p95 needs 20.
    """
    n = len(sorted_values)
    if n < MIN_PERCENTILE_SAMPLE_SIZE:
        return None
    # p0 gives rank 0, and sorted_values[-1] would return the max: nearest
    # rank's p0 is the smallest value (#2297).
    rank = max(percentile_rank(p, n), 1)
    if rank >= n:
        return None
    return sorted_values[rank - 1]


def percentiles(values):
    """``{p50, p85, p95}`` for unsorted values, each a number or None."""
    ordered = sorted(values)
    return {f"p{p}": percentile(ordered, p) for p in PERCENTILES}


# ── Response size (#2429) ──────────────────────────────────────────────────

# Share of a downsampled list reserved for the largest values. A scatter is read
# for its tail, so the longest cycles and the oldest WIP are always plotted.
DOWNSAMPLE_OUTLIER_SHARE = 4  # one in four kept samples is an outlier


def downsample(samples, limit, value_key="value_days"):
    """At most ``limit`` of ``samples``, in their original order, and whether any were dropped.

    WHY this shape (#2429): a 12k-card board's scatter is 12k dots and megabytes
    of JSON that the chart cannot show apart. Every number the response states
    (``sample_size``, ``percentiles``, counts) is computed by the caller on the
    whole list *before* this runs, so sampling moves only which dots are drawn.
    The ``limit // 4`` largest values (at least one, so a limit below 4 still
    keeps the largest) are always kept, because the tail is what
    a cycle-time or aging chart is read for, and the rest is an even stride over
    the remaining samples in their original order (by time for cycle time, by
    column then age for WIP age), so the shape of the cloud is kept. It is
    deterministic: the same board and query give the same dots. ``limit`` None
    returns the list unchanged.
    """
    if limit is None or len(samples) <= limit:
        return samples, False
    by_value = sorted(range(len(samples)), key=lambda i: (-samples[i][value_key], i))
    kept = set(by_value[: max(1, limit // DOWNSAMPLE_OUTLIER_SHARE)])
    rest = [i for i in range(len(samples)) if i not in kept]
    room = limit - len(kept)
    if room:  # 0 only when limit is 1: the largest alone fills it
        step = len(rest) / room
        kept.update(rest[int(k * step)] for k in range(room))
    return [samples[i] for i in sorted(kept)], True


# ── Time ranges ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class FlowRange:
    """One requested range, in the two forms the ADR gives it.

    ``start``/``end`` is the half-open window samples fall in (a sample belongs
    to the window its completion, or visit close, falls in). ``first_day`` and
    ``last_day`` are the inclusive whole UTC days a bucketed output covers;
    ``first_day > last_day`` means no whole day is available yet.
    """

    start: datetime.datetime
    end: datetime.datetime
    first_day: datetime.date
    last_day: datetime.date

    def contains(self, moment):
        return self.start <= moment < self.end

    @property
    def days(self):
        """Every bucketed day in the range, ascending."""
        count = (self.last_day - self.first_day).days + 1
        return [self.first_day + datetime.timedelta(days=i) for i in range(max(count, 0))]


def _utc_date(moment):
    return moment.astimezone(_UTC).date()


def _midnight(day):
    return datetime.datetime(day.year, day.month, day.day, tzinfo=_UTC)


def rolling_range(days=DEFAULT_RANGE_DAYS, *, now=None):
    """``days=N``: samples in ``[now - N×24h, now)``, buckets in the N whole days before today.

    Today is still running, so it is never a bucket: a partial last day would
    enter #1100's simulation as a slow day and bias every forecast later.
    """
    now = now or timezone.now()
    today = _utc_date(now)
    return FlowRange(
        start=now - datetime.timedelta(days=days),
        end=now,
        first_day=today - datetime.timedelta(days=days),
        last_day=today - datetime.timedelta(days=1),
    )


def date_range(from_date, to_date, *, now=None):
    """UTC dates, inclusive at both ends: ``[from_date 00:00Z, to_date + 1 day 00:00Z)``."""
    now = now or timezone.now()
    yesterday = _utc_date(now) - datetime.timedelta(days=1)
    return FlowRange(
        start=_midnight(from_date),
        end=_midnight(to_date + datetime.timedelta(days=1)),
        first_day=from_date,
        last_day=min(to_date, yesterday),
    )


def _iso(moment):
    """A UTC ISO 8601 timestamp, the form the rest of the API serves."""
    return moment.astimezone(_UTC).isoformat().replace("+00:00", "Z")


def _ordered_by_end(pairs):
    """The samples of ``(end_datetime, sample)`` pairs, oldest end first.

    Sorted by the datetime, never by the served string: ``_iso`` drops zero
    microseconds, so ``…:05Z`` would sort after ``…:05.500000Z`` (#2297).
    """
    pairs.sort(key=lambda pair: pair[0])
    return [sample for _, sample in pairs]


def _days_between(start, end):
    """Elapsed calendar days: seconds ÷ 86,400. Never rounded here; display rounds."""
    return (end - start).total_seconds() / SECONDS_PER_DAY


# ── Per-card history ───────────────────────────────────────────────────────


class _Movement(NamedTuple):
    moved_at: datetime.datetime
    movement_type: str
    from_key: object
    to_key: object
    # The card's gate position on entering ``to_key`` (#1102); None for a
    # stage with no sub-columns and for rows written before 1.3.
    to_gates: int | None = None
    # The row's pk: a visit remembers the movement that started it, so the
    # gate rows that movement wrote are read as its entry position (#2360).
    id: int | None = None
    # The swimlane the row left the card in (#2334): ``to_swimlane_id``, None
    # when that swimlane was deleted or an import named one the board lacks.
    to_lane: int | None = None
    # The raw ``to_column_id`` FK (NULL once the column is deleted), read only
    # for an ``on_card_rows`` caller: the ``/analytics/`` heatmap's frozen
    # rules match columns by this id (#2451). None otherwise.
    to_column_id: int | None = None

    @property
    def is_transition(self):
        return (
            self.movement_type == _MOVE
            and self.from_key is not None
            and self.to_key is not None
            and self.from_key != self.to_key
        )


@dataclass(slots=True)
class Visit:
    """One stay of a card in one column (ADR "Visit")."""

    key: object
    start: datetime.datetime
    end: datetime.datetime | None = None
    # False when continuity broke inside the visit, or it is open in a column
    # that does not match Card.column. Such a visit is reported as excluded.
    measured: bool = True
    # Gated stages (#2360): the gate position the card entered with, and the
    # ``(begin, end)`` spans it spent in the stage's last sub-column, which
    # #1102 counts as wait time. ``wait_spans`` stays None in a stage with no
    # sub-columns, so its visits report no work/wait split at all.
    entry_gates: int | None = None
    wait_spans: list | None = None
    # The movement that started the visit, and whether it was a restore (#2360).
    entry_movement_id: int | None = None
    restored: bool = False

    @property
    def is_open(self):
        return self.end is None

    def wait_days(self, since=None, until=None):
        """Days in the last sub-column, clipped to ``[since, until]``; None when not gated."""
        if self.wait_spans is None:
            return None
        seconds = 0.0
        for begin, end in self.wait_spans:
            begin = max(begin, since) if since is not None else begin
            end = min(end, until) if until is not None else end
            if end > begin:
                seconds += (end - begin).total_seconds()
        return seconds / SECONDS_PER_DAY

    def value_days(self, now):
        """The visit's length, or None if its end comes before its start (never clamped)."""
        end = self.end if self.end is not None else now
        return _days_between(self.start, end) if end >= self.start else None


@dataclass(slots=True)
class CardFlow:
    """What one card's history means under the ADR, computed once per request."""

    id: int
    uid: str
    title: str
    swimlane_id: int
    assignee_id: int | None
    created_at: datetime.datetime
    archived_at: datetime.datetime | None
    blocked_at: datetime.datetime | None
    column_uid: str
    # The manual block's free text, mirrored from the open ``CardBlock`` onto
    # the card row (#1149), so it rides the same query as ``blocked_at`` (#2281).
    blocked_reason: str = ""
    # The current swimlane's name, joined on the card query (#2283), so the
    # drill-down's directory can name it without a query of its own.
    swimlane_name: str = ""
    # The card row's ``column_id`` and ``position``, for the ``/analytics/``
    # heatmap, which reads its cards off this load (#2451).
    column_id: int | None = None
    position: int = 0
    has_creation: bool = False
    created_in_done: bool = False
    # Created, then the first transition reached a done column: the card has
    # no cycle time whatever else is wrong with its history.
    straight_to_done: bool = False
    complete_history: bool = False
    lead_start: datetime.datetime | None = None
    completion_at: datetime.datetime | None = None
    # The first done entry is dated after this request: no period holds it, and
    # it is reported as excluded rather than disappearing silently.
    completion_is_future: bool = False
    cycle_start: datetime.datetime | None = None
    # The card's latest movement of any kind that is not dated after the
    # request, for "needs attention" (#2260). None when it has none.
    last_moved_at: datetime.datetime | None = None
    reopens: list = field(default_factory=list)
    # Done entries from a not-done column after the first completion: each
    # closes the round of work its reopen started (#2297).
    recompletions: list = field(default_factory=list)
    visits: list = field(default_factory=list)
    placements: list = field(default_factory=list)
    # The card's swimlane over time (#2334): ``[(moment, swimlane id or None)]``,
    # one entry per change, oldest first. Empty when the history cannot say
    # (no movements, or the last one disagrees with ``swimlane_id``): then the
    # current swimlane stands for the whole history; see ``lane_at``.
    lanes: list = field(default_factory=list)

    def lane_at(self, moment):
        """The swimlane the card was in at ``moment``, for event-time attribution (#2334).

        Without a timeline, or with no moment (an open visit, or now), the
        current swimlane: nothing better is known, and a card is never left
        without one. None means the history names a swimlane that no longer
        exists on the board, and the caller counts the sample under no
        swimlane rather than moving it to the current one. Before the first
        row (a card with no creation movement) the earliest known one stands.
        """
        if not self.lanes or moment is None:
            return self.swimlane_id
        index = bisect.bisect_right(self.lanes, moment, key=_lane_moment) - 1
        return self.lanes[max(index, 0)][1]

    def lane_before(self, moment):
        """The swimlane the card was in just before ``moment``, for a closed visit (#2334).

        A visit ends at the movement that took the card out of the column, and
        that one row can also change the swimlane (a drag into another column
        in another swimlane). ``lane_at`` reads that row's destination, but the
        stay was spent in the swimlane the card left the column from, so a
        visit's end reads the row before it: a change dated exactly at
        ``moment`` is not yet in effect. The fallbacks are ``lane_at``'s: the
        current swimlane without a timeline or a moment (#1075), and the
        earliest known one before the first row.
        """
        if not self.lanes or moment is None:
            return self.swimlane_id
        index = bisect.bisect_left(self.lanes, moment, key=_lane_moment) - 1
        return self.lanes[max(index, 0)][1]

    def lane_spans(self):
        """``(begin or None, end or None, swimlane id or None)`` covering all time (#2334).

        Open-ended at both ends, so clipping any span against them loses
        nothing: the first swimlane reaches back, the last forward.
        """
        if not self.lanes:
            return [(None, None, self.swimlane_id)]
        ends = [moment for moment, _ in self.lanes[1:]] + [None]
        begins = [None] + ends[:-1]
        return [(begin, end, lane) for begin, end, (_, lane) in zip(begins, ends, self.lanes)]

    def reopened_after(self, moment):
        return any(t >= moment for t in self.reopens)

    @property
    def age_start(self):
        """The later of the cycle start and the latest reopen, or None."""
        candidates = [t for t in (self.cycle_start, self.reopens[-1] if self.reopens else None) if t]
        return max(candidates) if candidates else None

    def is_in_progress(self, done_uids):
        return (
            self.archived_at is None
            and self.column_uid not in done_uids
            and self.complete_history
            and self.age_start is not None
        )

    @property
    def open_visit(self):
        last = self.visits[-1] if self.visits else None
        return last if last is not None and last.is_open else None


def _lane_moment(entry):
    return entry[0]


def _replay_lanes(flow, live):
    """``flow.lanes`` from every live row, not just transitions (#2334).

    A swimlane-only move is not a transition, so the visit loop never sees it.
    When the last row's swimlane is not the card's (moved by a queryset update
    or the admin, which write no movement), the timeline is wrong somewhere and
    the card falls back to its current swimlane throughout, as an inconsistent
    column history falls back on ``complete_history``.
    """
    lanes = []
    for mv in live:
        if not lanes or lanes[-1][1] != mv.to_lane:
            lanes.append((mv.moved_at, mv.to_lane))
    return lanes if lanes and lanes[-1][1] == flow.swimlane_id else []


def _replay_visits(flow, live, creation, now):
    """Walk the ordered history into visits; returns them for ``flow.visits``."""
    visits = []
    current = None

    def close(end, leaves_from):
        nonlocal current
        current.end = end
        # Leaving from another column key means something changed the card
        # without writing a movement while this visit was open.
        current.measured = current.key == leaves_from
        current = None

    for mv in live:
        if mv is creation:
            current = Visit(key=mv.to_key, start=mv.moved_at, entry_gates=mv.to_gates, entry_movement_id=mv.id)
            visits.append(current)
        elif mv.is_transition:
            if current is not None:
                close(mv.moved_at, mv.from_key)
            current = Visit(key=mv.to_key, start=mv.moved_at, entry_gates=mv.to_gates, entry_movement_id=mv.id)
            visits.append(current)
        elif mv.movement_type == _ARCHIVED:
            if current is not None:
                close(mv.moved_at, mv.from_key)
        elif mv.movement_type == _UNARCHIVED:
            if current is not None:
                # A restore with no archive before it: the earlier stay has no
                # observable end, so it cannot be measured.
                current.measured = False
                current.end = mv.moved_at
            current = Visit(
                key=mv.to_key, start=mv.moved_at, measured=mv.to_key is not None, entry_gates=mv.to_gates,
                entry_movement_id=mv.id, restored=True,
            )
            visits.append(current)
        # A swimlane-only move does not end a stay. An unattributable move is
        # not a transition, so it closes nothing; the next transition then
        # leaves from another key and marks the visit unmeasured.

    if current is not None:
        if flow.archived_at is not None:
            # Archived without an ``archived`` event (the Django admin, or an
            # import that sets archived_at): the visit ends at archived_at.
            current.end = flow.archived_at
            if flow.archived_at > now:
                current.measured = False
        elif current.key != flow.column_uid:
            current.measured = False
    return visits


def _replay_placements(flow, live, creation, done_uids, now):
    """The card's column over time, for cumulative flow: ``[(moment, key or off-diagram)]``.

    Stops are in time order, whatever produced them, so the diagram's segments and
    a day's card list read the same position. An imported ``created_at`` or an
    admin's ``archived_at`` can fall anywhere among the movements.
    """
    if creation is not None:
        start, position = creation.moved_at, creation.to_key
    else:
        # No creation movement: placed from created_at, in the source of its
        # earliest movement, or in its current column if there is none. An
        # imported created_at later than that movement cannot place the card
        # after it, or the card would go back to the source.
        source = live[0].from_key if live else None
        start = min(flow.created_at, live[0].moved_at) if live else flow.created_at
        position = source if source is not None else flow.column_uid

    changes = [(start, _MOVE, position)]
    last_archive_event = None
    for mv in live:
        if mv is creation:
            continue
        if mv.is_transition:
            changes.append((mv.moved_at, _MOVE, mv.to_key))
        elif mv.movement_type in (_ARCHIVED, _UNARCHIVED):
            changes.append((mv.moved_at, mv.movement_type, None))
            last_archive_event = mv.movement_type
    if flow.archived_at is not None and last_archive_event != _ARCHIVED and flow.archived_at <= now:
        changes.append((flow.archived_at, _ARCHIVED, None))
    # A stable sort: rows that tie on moved_at keep their movement order.
    changes.sort(key=lambda change: change[0])

    placements = []
    archived = False
    for moment, kind, key in changes:
        if kind == _MOVE:
            position = key
        else:
            archived = kind == _ARCHIVED
        # Finished work is cumulative: archiving a done card must not shrink the
        # done band. Any other archived card leaves the diagram.
        placements.append((moment, position if (not archived or position in done_uids) else _OFF_DIAGRAM))
    return placements


def _live_rows(rows, now):
    """``(live, misdated)``: the rows up to the first one dated after ``now``."""
    for index, mv in enumerate(rows):
        if mv.moved_at > now:
            return rows[:index], True
    return rows, False


def _creation_row(live):
    """The card's creation movement: its first row, when that row places it from nowhere."""
    first = live[0] if live else None
    if first is not None and first.movement_type == _MOVE and first.from_key is None and first.to_key is not None:
        return first
    return None


def _analyze_card(flow, rows, done_uids, now, committed_uids=None):
    """Fill ``flow`` from the card's movements, ordered by ``(moved_at, id)``."""
    # A movement dated after this request is misdated: it and everything after
    # it are ignored, and the card has incomplete history.
    live, misdated = _live_rows(rows, now)

    creation = _creation_row(live)
    flow.has_creation = creation is not None
    flow.last_moved_at = live[-1].moved_at if live else None
    flow.created_in_done = creation is not None and creation.to_key in done_uids
    flow.lead_start = creation.moved_at if creation is not None else flow.created_at
    if flow.created_in_done:
        flow.completion_at = creation.moved_at

    chain_head = creation.to_key if creation is not None else None
    continuous = True
    unattributable = False
    first_transition = None
    last_archive_event = None
    for mv in live:
        if mv is creation:
            continue
        if mv.from_key is None or mv.to_key is None:
            unattributable = True
        if mv.movement_type == _ARCHIVED or mv.movement_type == _UNARCHIVED:
            last_archive_event = mv.movement_type
        if not mv.is_transition:
            continue
        if first_transition is None:
            first_transition = mv
        if chain_head is not None and mv.from_key != chain_head:
            continuous = False
        chain_head = mv.to_key
        if flow.completion_at is None and mv.to_key in done_uids:
            flow.completion_at = mv.moved_at
        elif mv.to_key in done_uids and mv.from_key not in done_uids:
            flow.recompletions.append(mv.moved_at)
        if mv.from_key in done_uids and mv.to_key not in done_uids:
            flow.reopens.append(mv.moved_at)

    if committed_uids is not None:
        _commitment_start(flow, live, creation, done_uids, committed_uids)
    elif creation is not None and not flow.created_in_done and first_transition is not None:
        if first_transition.to_key in done_uids:
            flow.straight_to_done = True
        elif first_transition.from_key == creation.to_key:
            flow.cycle_start = first_transition.moved_at

    if chain_head is not None and chain_head != flow.column_uid:
        continuous = False
    if (last_archive_event == _ARCHIVED) != (flow.archived_at is not None):
        continuous = False
    flow.complete_history = creation is not None and continuous and not unattributable and not misdated

    if flow.completion_at is None and misdated:
        flow.completion_is_future = any(
            mv.to_key in done_uids and (mv.is_transition or mv.from_key is None)
            for mv in rows[len(live):]
        )
    flow.visits = _replay_visits(flow, live, creation, now)
    flow.placements = _replay_placements(flow, live, creation, done_uids, now)
    flow.lanes = _replay_lanes(flow, live)


def _commitment_start(flow, live, creation, done_uids, committed_uids):
    """Cycle start on a board with a commitment point (#2050, ADR dated note).

    The card's first arrival at or past the commitment point: the creation
    movement when the card was created there, else its first transition into
    such a column. A card that reaches a done column first never starts (it is
    marked ``straight_to_done`` so it is not counted as an exclusion), and a
    card created in a done column has no start, as under the default rule.
    """
    if creation is None or flow.created_in_done:
        return
    if creation.to_key in committed_uids:
        flow.cycle_start = creation.moved_at
        return
    for mv in live:
        if mv is creation or not mv.is_transition:
            continue
        if mv.to_key in done_uids:
            flow.straight_to_done = True
            return
        if mv.to_key in committed_uids:
            flow.cycle_start = mv.moved_at
            return


# ── The snapshot every metric reads ────────────────────────────────────────


@dataclass
class BoardFlow:
    """One board's columns and analyzed cards, at one moment, under one filter."""

    board: object
    now: datetime.datetime
    columns: list
    cards: list
    done_uids: set
    current_uids: set
    # The filter the snapshot was loaded under, for metrics with their own rows.
    swimlane_id: int | None = None
    label_id: int | None = None
    # Column uids at or past the board's commitment point, or None when the
    # board has none and the ADR's default cycle start applies (#2050).
    committed_uids: set | None = None
    # ``{column uid: _GateStage}`` for the gated stages (#2360).
    gate_last: dict = field(default_factory=dict)
    # ``{placement key: card count}`` for the cards a range-bounded load left
    # out because their history ended before the range (#2425): each still
    # sits in one cumulative-flow band for the whole window. Only
    # ``load_cumulative_flow`` fills it; ``cumulative_flow`` adds it in.
    settled_placements: dict = field(default_factory=dict)

    def column_ref(self, key):
        """``key`` as a response ``column_uid``: a current column's uid, or None if deleted."""
        return key if isinstance(key, str) and key in self.current_uids else None


def _base_cards(board, swimlane_id, label_id):
    """The cards a filter selects, archived ones included: both filters read current state.

    ADR "Filters": the card's current swimlane and current labels, as the board
    movements endpoint's ``swimlane_id`` does.
    """
    cards = Card.objects.filter(board=board)
    if swimlane_id is not None:
        cards = cards.filter(swimlane_id=swimlane_id)
    if label_id is not None:
        cards = cards.filter(labels=label_id)
    return cards


def load_board_flow(
    board, *, swimlane_id=None, label_id=None, now=None, columns=None, cards_matching=None,
    gate_index_as_full=False, on_card_rows=None,
):
    """Load and analyze a board's history in a fixed number of queries.

    Pass ``columns`` (the board's columns, in position order) when the caller
    already holds them. Hard-deleted cards are out by construction: this reads
    through ``Card``, and their retained movements have ``card`` NULL.

    ``cards_matching`` narrows which cards are loaded, each still with its whole
    history, for a caller that can prove the others cannot change its answer.

    ``gate_index_as_full`` keeps ``gate_last`` what an unnarrowed load would
    give when the narrowed one selects no card: the index is read whenever the
    filter selects any card at all (one EXISTS query, only in that case), so a
    dwell response's ``work_percentiles`` does not turn from ``{p50: null...}``
    into ``null`` just because no card is recent (#2425).

    ``on_card_rows(card, rows)`` is called once per loaded card, after it is
    analyzed, with its whole history in ``(moved_at, id)`` order and each
    row's ``to_column_id`` filled. It lets a caller derive its own per-card
    figures from this one read instead of reading the same movements again
    (#2451). Each card's rows are dropped once it is analyzed, so the load
    holds one card's raw history less at a time as the analysis proceeds.
    """
    now = now or timezone.now()
    if columns is None:
        columns = list(Column.objects.filter(board=board).order_by("position"))
    done_uids = {c.uid for c in columns if c.is_done}
    committed_uids = committed_column_uids(board, columns)

    selected = _base_cards(board, swimlane_id, label_id)
    if cards_matching is not None:
        selected = selected.filter(cards_matching)
    cards = _card_flows(selected)

    rows_by_card: dict[int, list] = {}
    for card_id, movement in _movement_rows(selected, column_ids=on_card_rows is not None):
        rows_by_card.setdefault(card_id, []).append(movement)
    for card in cards:
        rows = rows_by_card.pop(card.id, [])
        _analyze_card(card, rows, done_uids, now, committed_uids)
        if on_card_rows is not None:
            on_card_rows(card, rows)
    del rows_by_card
    # No cards, no gate history to read: a narrowed load that selects nothing
    # stays query-free (NarrowedLoadTests), unless the caller asked for the
    # full load's index (see ``gate_index_as_full``).
    any_card = bool(cards) or (
        gate_index_as_full and cards_matching is not None
        and _base_cards(board, swimlane_id, label_id).exists()
    )
    gate_last = _gate_last_index(board) if any_card else {}
    if gate_last and cards:
        _attach_wait(cards, selected, gate_last, now)
    return BoardFlow(
        board=board, now=now, columns=columns, cards=cards,
        done_uids=done_uids, current_uids={c.uid for c in columns},
        swimlane_id=swimlane_id, label_id=label_id, committed_uids=committed_uids,
        gate_last=gate_last,
    )


def _card_flows(selected):
    """One bare ``CardFlow`` per card of ``selected``, by id: the card row, nothing analyzed yet."""
    return [
        CardFlow(
            id=row["id"], uid=row["uid"], title=row["title"], swimlane_id=row["swimlane_id"],
            assignee_id=row["assignee_id"], created_at=row["created_at"],
            archived_at=row["archived_at"], blocked_at=row["blocked_at"],
            column_uid=row["column__uid"], blocked_reason=row["blocked_reason"],
            swimlane_name=row["swimlane__name"], column_id=row["column_id"], position=row["position"],
        )
        for row in selected.order_by("id").values(
            "id", "uid", "title", "swimlane_id", "assignee_id", "created_at",
            "archived_at", "blocked_at", "column__uid", "blocked_reason", "swimlane__name",
            "column_id", "position",
        )
    ]


_MOVEMENT_FIELDS = (
    "card_id", "moved_at", "movement_type",
    "from_column_uid", "from_column__uid", "from_column_name",
    "to_column_uid", "to_column__uid", "to_column_name", "to_gates_passed", "id",
    # The local FK columns, never ``to_swimlane__*``: no join (#2334).
    "to_swimlane_id",
)


def _movement_from_row(row, interned, column_ids):
    """``(card_id, _Movement)`` from one ``_MOVEMENT_FIELDS`` row (plus ``to_column_id`` with ``column_ids``)."""
    (
        card_id, moved_at, kind, from_uid, from_fk, from_name, to_uid, to_fk, to_name, to_gates, movement_id,
        to_lane,
    ) = row[:12]
    to_column_id = interned.setdefault(row[12], row[12]) if column_ids else None
    return card_id, _Movement(
        moved_at, kind,
        _column_key(from_uid, from_fk, from_name),
        _column_key(to_uid, to_fk, to_name),
        to_gates,
        movement_id,
        to_lane,
        to_column_id,
    )


def _movement_rows(selected, *, column_ids=False):
    """``(card_id, _Movement)`` for every movement of ``selected``, by card then ``(moved_at, id)``.

    Streamed in chunks, so a caller that folds each card's rows as they arrive
    holds one card's history at a time. ``column_ids`` also reads the raw
    ``to_column_id`` (a local column, no join) into ``_Movement.to_column_id``.
    """
    fields = (*_MOVEMENT_FIELDS, "to_column_id") if column_ids else _MOVEMENT_FIELDS
    movements = (
        CardMovement.objects.filter(card__in=selected.order_by().values("id"))
        .order_by("card_id", "moved_at", "id")
        .values_list(*fields)
    )
    # One int object per column id rather than one per row: the ids repeat on
    # every row, and on a year of history that is ~600k ints (#2451).
    interned: dict = {}
    for row in movements.iterator(chunk_size=2000):
        yield _movement_from_row(row, interned, column_ids)


# The ``kind`` ``_deciding_rows`` gives a row: a transition, an archive-type
# row (before ``as_of``, or at or after it), anything else.
_TRANSITION, _ARCHIVE_BEFORE, _ARCHIVE_AFTER, _OTHER = "T", "A", "Z", "O"


def _movement_kinds(movements, as_of):
    """``movements`` annotated with ``from_key``/``to_key`` (``_sql_column_key``) and ``kind`` (#2444).

    ``kind`` is ``T`` for a transition (``_Movement.is_transition``), ``A``
    for an archive-type row, ``O`` otherwise. With ``as_of``, only a row
    dated before it is ``T`` or ``A``; an archive-type row at or after it is
    ``Z``, and a later transition is ``O``.
    """
    before = Q() if as_of is None else Q(moved_at__lt=as_of)
    archive = Q(movement_type__in=[_ARCHIVED, _UNARCHIVED])
    transition = (
        Q(movement_type=_MOVE) & Q(from_key__isnull=False) & Q(to_key__isnull=False) & ~Q(from_key=F("to_key"))
    )
    whens = [When(transition & before, then=Value(_TRANSITION)), When(archive & before, then=Value(_ARCHIVE_BEFORE))]
    if as_of is not None:
        whens.append(When(archive, then=Value(_ARCHIVE_AFTER)))
    return movements.annotate(from_key=_sql_column_key("from"), to_key=_sql_column_key("to")).annotate(
        kind=Case(*whens, default=Value(_OTHER), output_field=CharField()),
    )


def _deciding_rows(cards, *, now, as_of=None):
    """``(card_id, [_Movement])`` per card of ``cards`` with any row: only the rows its placement needs (#2444).

    Each card's list is in ``(moved_at, id)`` order and holds at most three
    rows, four with ``as_of``. WHY that is enough for ``_replay_placements``
    (``_live_rows`` first cuts at ``now``, so the read keeps ``moved_at <=
    now``: on rows in ``moved_at`` order that is the same cut):

    * Its start, and so its first position, reads only the first live row:
      the creation row (``_creation_row`` is the first row or nothing), or
      that row's source and ``moved_at``.
    * Its position after any moment is the ``to_key`` of the last transition
      at or before it (or the start); nothing else moves it.
    * Its archived state after any moment is the last archive-type row at or
      before it, or the synthetic ``archived_at``, which is added only when
      the last archive-type row of the *whole* live history is not
      ``archived``.

    Without ``as_of`` the caller reads the last placement only: the first
    row, the last transition and the last archive-type row (three). With
    ``as_of`` (the drill-down, ``as_of = midnight(D + 1)``) the caller reads
    the last placement before ``as_of``: the first row, the last transition
    before ``as_of``, the last archive-type row before it, and the last
    archive-type row at or after it (up to ``now``), which only decides
    whether the synthetic ``archived_at`` exists (four). A dropped row never
    moves a kept one relative to another, and rows that tie on ``moved_at``
    keep their ``id`` order, which is all the stable sort reads.

    ``kind`` is decided on ``_sql_column_key``, the SQL mirror of
    ``_column_key``, only to choose rows; the kept rows' keys are rebuilt in
    Python by ``_movement_from_row``, so the replay never reads a SQL key.

    One statement, uncorrelated: ``card_id IN (<cards>)`` carries the board
    bound, and the window functions rank inside each card (no ``DISTINCT
    ON``, which SQLite lacks; no per-card subquery, see #2502).
    """
    movements = (
        _movement_kinds(
            CardMovement.objects.filter(card_id__in=cards.order_by().values("id"), moved_at__lte=now), as_of,
        )
        .annotate(
            first_rank=Window(
                RowNumber(), partition_by=[F("card_id")], order_by=[F("moved_at").asc(), F("id").asc()],
            ),
            kind_rank=Window(
                RowNumber(), partition_by=[F("card_id"), F("kind")], order_by=[F("moved_at").desc(), F("id").desc()],
            ),
        )
        .filter(Q(first_rank=1) | Q(kind__in=[_TRANSITION, _ARCHIVE_BEFORE, _ARCHIVE_AFTER], kind_rank=1))
        .order_by("card_id", "moved_at", "id")
        .values_list(*_MOVEMENT_FIELDS)
    )
    interned: dict = {}
    current_id, history = None, []
    for row in movements.iterator(chunk_size=2000):
        card_id, movement = _movement_from_row(row, interned, False)
        if card_id != current_id:
            if current_id is not None:
                yield current_id, history
            current_id, history = card_id, []
        history.append(movement)
    if current_id is not None:
        yield current_id, history


class _GateStage(NamedTuple):
    """A gated stage as it is now: which sub-column is last (#2360)."""

    last: int
    last_uid: str
    uids: frozenset

    def waits(self, index, sub_uid):
        """True when a card at this position sits in the stage's last sub-column.

        A position is judged by its sub-column's identity when it has one that
        still belongs to the stage, so an edit that re-indexes sub-columns (a
        count change, a reorder) does not move recorded time between work and
        wait. Without one (an entry at gate 0 writes no row, and a deleted
        sub-column's uid matches nothing) the index decides, against today's
        stage.
        """
        if sub_uid and sub_uid in self.uids:
            return sub_uid == self.last_uid
        return index >= self.last


class _Gate(NamedTuple):
    at: datetime.datetime
    key: object
    to_index: int
    sub_uid: str
    movement_id: int | None


def _gate_last_index(board):
    """``{column uid: _GateStage}`` for the board's gated stages (#2360).

    The stage's current sub-columns decide which one is "last", so time
    recorded before a stage edit is judged against today's last sub-column
    (documented in docs/features/analytics.md).
    """
    rows = (
        SubColumn.objects.filter(column__board=board)
        .order_by("column_id", "position", "id")
        .values_list("column__uid", "uid")
    )
    by_column: dict = {}
    for column_uid, uid in rows:
        by_column.setdefault(column_uid, []).append(uid)
    return {
        column_uid: _GateStage(len(uids) - 1, uids[-1], frozenset(uids))
        for column_uid, uids in by_column.items()
        if len(uids) > 1
    }


def _attach_wait(cards, selected, gate_last, now):
    """Fill ``Visit.wait_spans`` for visits to gated stages from the gate history.

    One query. The rows the visit's own entering movement wrote are the gates
    the card was placed past as it entered, so they give its entry position.
    Every other row in the visit moves it in place, including rows linked to a
    lane-only move inside the stage, which changes the gate but starts no visit.
    """
    by_card: dict[int, list] = {}
    rows = (
        CardGateTransition.objects.filter(card__in=selected.order_by().values("id"))
        .order_by("card_id", "created_at", "id")
        .values_list(
            "card_id", "created_at", "column_uid", "column__uid", "column_name", "to_index",
            "sub_column_uid", "movement_id",
        )
    )
    for card_id, at, uid, fk, name, to_index, sub_uid, movement_id in rows.iterator(chunk_size=2000):
        by_card.setdefault(card_id, []).append(_Gate(at, _column_key(uid, fk, name), to_index, sub_uid, movement_id))
    for card in cards:
        transitions = by_card.get(card.id, ())
        # Per stage: the position the card held when its last visit there ended.
        left = {}
        for visit in card.visits:
            stage = gate_last.get(visit.key)
            if stage is None:
                continue
            entry = _entry_position(visit, transitions, left.get(visit.key))
            visit.wait_spans, position = _wait_spans(visit, transitions, stage, entry, now)
            left[visit.key] = (position, visit.end if visit.end is not None else now)


def _entry_position(visit, transitions, left):
    """``(index, sub-column uid)`` the card held as the visit started.

    The last row its entering movement wrote, if any; else the movement's
    ``to_gates_passed`` (0 when the row predates gate recording). An archive
    and restore never write ``to_gates_passed``, and the card keeps its
    sub-column while archived, so a restore picks up where the card's last
    visit to the stage left off, plus any row written while it was archived.
    """
    linked = [g for g in transitions if g.movement_id is not None and g.movement_id == visit.entry_movement_id]
    if linked:
        return linked[-1].to_index, linked[-1].sub_uid
    if visit.restored and visit.entry_gates is None and left is not None:
        (index, sub_uid), since = left
        for g in transitions:
            if g.key == visit.key and since <= g.at < visit.start:
                index, sub_uid = g.to_index, g.sub_uid
        return index, sub_uid
    return visit.entry_gates or 0, ""


def _wait_spans(visit, transitions, stage, entry, now):
    """The visit's spans in its stage's last sub-column (#1102 "wait"), and its final position.

    #1102: sub-columns before the last count as work time and the last counts
    as wait time. The card starts at ``entry``, then each later row inside the
    visit sets its position. Blocked time is not subtracted from work, so
    work + wait is the sample's value: #1102 asks for "minus blocked time",
    which waits on an owner decision (docs/features/analytics.md). The ADR's
    "Blocked time" rule (never subtracted) is scoped to lead, cycle, dwell and
    age, which are elapsed time, and leaves a later flow-efficiency ratio
    open; it does not decide this split.
    """
    end = visit.end if visit.end is not None else now
    index, sub_uid = entry
    spans = []
    if end <= visit.start:
        return spans, entry
    since = visit.start
    for g in transitions:
        if g.key != visit.key or g.at < visit.start:
            continue
        if g.movement_id is not None and g.movement_id == visit.entry_movement_id:
            continue
        if g.at >= end:
            break
        if stage.waits(index, sub_uid) and g.at > since:
            spans.append((since, g.at))
        index, sub_uid, since = g.to_index, g.sub_uid, g.at
    if stage.waits(index, sub_uid) and end > since:
        spans.append((since, end))
    return spans, (index, sub_uid)


def _split(value, wait):
    """``(wait_days, work_days)`` for a sample, or ``(None, None)`` with no gated time to split."""
    if wait is None or value is None:
        return None, None
    wait = min(wait, value)
    return wait, value - wait


def load_recent_completions(board, flow_range, *, columns):
    """Only the cards a first completion inside ``flow_range`` can come from.

    The Summary view opens on every visit and must not cost the board's whole
    history. A first completion in the range needs a row into a done column in
    the range, so cards without one are skipped. A card with one is loaded whole,
    because its row may be a second entry, and its cycle time needs its history.
    """
    done = [c for c in columns if c.is_done]
    if not done:
        return load_board_flow(board, now=flow_range.end, columns=columns, cards_matching=Q(pk__in=[]))
    entered_done = CardMovement.objects.filter(
        Q(to_column_uid__in=[c.uid for c in done]) | Q(to_column_uid="", to_column_id__in=[c.id for c in done]),
        card=OuterRef("pk"),
        moved_at__gte=flow_range.start,
        moved_at__lte=flow_range.end,
    )
    return load_board_flow(board, now=flow_range.end, columns=columns, cards_matching=Exists(entered_done))


def load_recent_dwell(
    board, flow_range, *, columns, swimlane_id=None, label_id=None, also_matching=None, on_card_rows=None,
):
    """Only the cards current dwell or a visit closing in ``flow_range`` can come from.

    An open visit needs a live card outside a done column. A visit closes at a
    movement or at ``archived_at``, so a card with neither in the range has no
    visit closing in it. Finished work older than the range is therefore skipped.

    ``also_matching`` loads more cards for a caller that reads its own figures
    through ``on_card_rows`` (#2451). Such a card adds no dwell or wait
    sample: any card outside the set above has no open visit and no visit
    closing in the range (the ``can_affect_range`` argument, which keeps every
    live card for the same reason). It can still make the load non-empty
    where the set above is empty, and a non-empty load reads the board's gate
    index (``load_board_flow``'s ``any_card``), which the heatmap turns into a
    ``wait`` key per gated stage. So when no loaded card is in the set above,
    ``gate_last`` is reset to ``{}``, the answer a load of that set gives.
    """
    moved = CardMovement.objects.filter(
        card=OuterRef("pk"), moved_at__gte=flow_range.start, moved_at__lte=flow_range.end,
    )
    relevant = (
        (Q(archived_at__isnull=True) & ~Q(column__is_done=True))
        | Q(archived_at__gte=flow_range.start)
        | Exists(moved)
    )
    if also_matching is None:
        return load_board_flow(
            board, swimlane_id=swimlane_id, label_id=label_id, now=flow_range.end,
            columns=columns, cards_matching=relevant, on_card_rows=on_card_rows,
        )

    done_ids = {c.id for c in columns if c.is_done}
    in_dwell_set = False

    def note(card, rows):
        # ``relevant`` above, in Python, on the rows the load already holds.
        nonlocal in_dwell_set
        if not in_dwell_set and (
            (card.archived_at is None and card.column_id not in done_ids)
            or (card.archived_at is not None and card.archived_at >= flow_range.start)
            or any(flow_range.start <= row.moved_at <= flow_range.end for row in rows)
        ):
            in_dwell_set = True
        if on_card_rows is not None:
            on_card_rows(card, rows)

    flow = load_board_flow(
        board, swimlane_id=swimlane_id, label_id=label_id, now=flow_range.end,
        columns=columns, cards_matching=relevant | also_matching, on_card_rows=note,
    )
    if not in_dwell_set:
        flow.gate_last = {}
    return flow


def range_boundary(flow_range, now):
    """The earliest moment anything a ``flow_range`` response reports can be dated (#2425).

    The window's ``start``, or the midnight its first bucketed day opens at
    when that is earlier (a rolling range starts mid-day, and throughput and
    cumulative flow bucket whole UTC days), and never later than ``now``, so a
    row dated after the request (counted as an exclusion in every range) is
    always on the near side of it.
    """
    return min(flow_range.start, _midnight(flow_range.first_day), now)


def can_affect_range(board, boundary):
    """The cards of ``board`` whose history can change a range metric's answer, as a ``Q`` (#2425).

    WHY this is safe. Every number a range endpoint returns is dated by one
    of: a movement (a first completion, a cycle start, a reopen, the end of a
    visit, a cumulative-flow placement), the card's ``archived_at`` (the end of
    its last visit, or of its last round of work), its ``created_at`` (the
    placement of a card with no creation movement), or "now" for a card that
    is still on the board (WIP age, needs attention, an open visit or round).
    So a card that is archived, was archived before ``boundary``, was created
    before it, and has no movement at or after it has every such moment
    before the range: it can be no sample, no exclusion, no started or
    completed count, no closed visit and no in-progress window inside it.

    The cards kept are loaded with their whole history, not just the part in
    the range: a completion in the range still needs the cycle start years
    before it, and a reopen in the range still needs to know the first
    completion was older. Live cards are always kept, done or not, so the
    snapshot metrics read the same cards as an unnarrowed load. The one
    thing a skipped card still contributes is its cumulative-flow band, since
    finished work stays in the done band for ever; ``load_cumulative_flow``
    counts that separately.

    WHY the movement term is an uncorrelated, board-bounded ``IN`` and not a
    correlated ``EXISTS (... card_id = cards.id ...)`` (#2502). Inside an
    ``OR``, PostgreSQL cannot turn a correlated ``EXISTS`` into a semi-join,
    so it stays a per-row SubPlan in the filter on ``cards``. With that
    filter on it, the planner stopped driving the movement read from this
    board's cards and instead walked the whole ``card_movements_card_id``
    index, every board's movements, probing ``cards`` for each one (EXPLAIN
    on the nightly fixture: 151,674 movement rows read to return 24,919,
    56 ms, against 20 ms driven from the board's 2,395 cards). The cost then
    followed the whole instance's history, not this board's: the 2026-11-21
    nightly's wip-age p95 rose 364 -> 531 ms with every range metric close
    behind. An uncorrelated ``IN`` is a hashed SubPlan, run at most once
    per statement and only when a row reaches it (a live card never does).
    The term only matters for a card the first three terms skip (archived,
    and created, before ``boundary``), so the subquery reads only those
    cards of this board and their recent movements: the same cards kept,
    by the same rule.
    """
    moved = CardMovement.objects.filter(
        card__board=board, card__archived_at__lt=boundary, card__created_at__lt=boundary,
        moved_at__gte=boundary,
    ).values("card_id")
    return (
        Q(archived_at__isnull=True)
        | Q(archived_at__gte=boundary)
        | Q(created_at__gte=boundary)
        | Q(pk__in=moved)
    )


def load_range_flow(board, flow_range, *, now, swimlane_id=None, label_id=None, columns=None):
    """The snapshot cycle time, throughput, dwell, WIP age, attention and swimlanes read (#2425).

    Only the cards ``can_affect_range`` keeps, so the cost follows the cards
    live now or active since the range opened, not the board's age. Every
    number is the same as on an unnarrowed load (``RangeNarrowingEquivalenceTests``).
    """
    return load_board_flow(
        board, swimlane_id=swimlane_id, label_id=label_id, now=now, columns=columns,
        cards_matching=can_affect_range(board, range_boundary(flow_range, now)), gate_index_as_full=True,
    )


def load_cumulative_flow(board, flow_range, *, now, swimlane_id=None, label_id=None, columns=None):
    """The snapshot ``cumulative_flow`` reads: a range load, plus where each skipped card rests (#2425).

    A card ``can_affect_range`` skips has every placement dated before the
    first bucketed day, so the diagram reads only its last one, for the whole
    window, and none of its band changes fall inside it. Only the (at most
    three) rows that placement depends on are read per card
    (``_deciding_rows``, #2444), so the cost follows the skipped cards, not
    their whole history; ``_replay_placements`` itself decides the
    placement, so the rule is the one the full load applies. Two queries
    more than a range load: the skipped cards and their deciding rows.
    """
    flow = load_range_flow(
        board, flow_range, now=now, swimlane_id=swimlane_id, label_id=label_id, columns=columns,
    )
    settled = _base_cards(board, swimlane_id, label_id).exclude(
        can_affect_range(board, range_boundary(flow_range, now)),
    )
    rows = settled.order_by("id").values_list("id", "created_at", "archived_at", "column__uid")
    cards = {card_id: (created_at, archived_at, column_uid) for card_id, created_at, archived_at, column_uid in rows}
    if not cards:
        return flow
    counts: dict = {}

    def rest(card_id, history):
        # A card restored (or newly moved) between the row query and the
        # movement query streams movements but is not in ``cards``; it is no
        # longer settled, so skip it rather than raise. The residual: that
        # card was also missed by the range load if it changed before that
        # query ran, which would need one snapshot to close; two reads a few
        # ms apart on a live board are accepted, as for the other loaders.
        if (resting := cards.pop(card_id, None)) is None:
            return
        created_at, archived_at, column_uid = resting
        live, _ = _live_rows(history, now)
        # Only created_at, archived_at and column_uid are real: they are all
        # _replay_placements reads (RangeNarrowingEquivalenceTests pins it).
        stub = CardFlow(
            id=card_id, uid="", title="", swimlane_id=0, assignee_id=None, created_at=created_at,
            archived_at=archived_at, blocked_at=None, column_uid=column_uid,
        )
        placement = _replay_placements(stub, live, _creation_row(live), flow.done_uids, now)[-1][1]
        if placement is not _OFF_DIAGRAM:
            counts[placement] = counts.get(placement, 0) + 1

    for card_id, history in _deciding_rows(settled, now=now):
        rest(card_id, history)
    # Skipped cards with no movement at all rest where ``created_at`` placed them.
    for card_id in list(cards):
        rest(card_id, [])
    flow.settled_placements = counts
    return flow


def load_cumulative_day(board, day, *, now, swimlane_id=None, label_id=None, columns=None):
    """The snapshot ``cumulative_flow_cards`` reads for one ``day``'s drill-down (#2444).

    Every card the filter selects is loaded, finished work from any year
    included (it still rests in the done band that day), but only the rows
    its placement at the end of ``day`` depends on (``_deciding_rows`` with
    ``as_of`` the next midnight: at most four per card), not its whole
    history. ``_replay_placements`` decides the placement on those rows, so
    the answer is the one a full load gives (``CumulativeDayEquivalenceTests``).

    The result is partial on purpose: each card's ``placements`` are right
    only up to the end of ``day``, and nothing ``_analyze_card`` fills (visits,
    completions, lanes) is set, nor ``gate_last``. Only
    ``cumulative_flow_cards`` and ``card_directory`` may read it. Three
    queries: the columns (unless passed), the cards and their deciding rows,
    plus ``card_directory``'s assignees.
    """
    if columns is None:
        columns = list(Column.objects.filter(board=board).order_by("position"))
    done_uids = {c.uid for c in columns if c.is_done}
    selected = _base_cards(board, swimlane_id, label_id)
    cards = _card_flows(selected)
    by_id = {card.id: card for card in cards}
    as_of = _midnight(day + datetime.timedelta(days=1))

    def place(card, history):
        live, _ = _live_rows(history, now)
        card.placements = _replay_placements(card, live, _creation_row(live), done_uids, now)

    placed = set()
    for card_id, history in _deciding_rows(selected, now=now, as_of=as_of):
        # A card added between the two reads has rows but no CardFlow; it is
        # not in this day's answer, as for ``load_cumulative_flow``'s race.
        if (card := by_id.get(card_id)) is not None:
            place(card, history)
            placed.add(card_id)
    for card in cards:
        if card.id not in placed:
            place(card, [])
    return BoardFlow(
        board=board, now=now, columns=columns, cards=cards,
        done_uids=done_uids, current_uids={c.uid for c in columns},
        swimlane_id=swimlane_id, label_id=label_id, committed_uids=None, gate_last={},
    )


def card_directory(flow, uids):
    """Who and what each uid in a response is: the drill-down's cards and owners.

    One query for the assignees; the rest, the swimlane's name included, was
    loaded with the cards. ``swimlane`` is the card's current lane, the one the
    swimlane filter reads, so every card has one. A response
    names cards by uid, and archived cards are not on the board payload, so the
    client cannot resolve them from what it already holds. Transitions come from
    the existing card movements endpoint, by the ``id`` returned here.
    """
    from accounts.models import User
    from accounts.serializers import BoardUserSerializer

    wanted = set(uids)
    cards = [card for card in flow.cards if card.uid in wanted]
    assignee_ids = {card.assignee_id for card in cards if card.assignee_id is not None}
    assignees = (
        {user.id: BoardUserSerializer(user).data for user in User.objects.filter(pk__in=assignee_ids)}
        if assignee_ids
        else {}
    )
    return [
        {
            "uid": card.uid,
            "id": card.id,
            "title": card.title,
            "archived": card.archived_at is not None,
            "assignee": assignees.get(card.assignee_id),
            "swimlane": {"id": card.swimlane_id, "name": card.swimlane_name},
        }
        for card in cards
    ]


# ── Durations ──────────────────────────────────────────────────────────────


def _duration_response(metric, samples, excluded, flow=None):
    values = [s["value_days"] for s in samples]
    return {
        "definition": definition(metric, flow),
        "sample_size": len(samples),
        "excluded_incomplete_history": excluded,
        "percentiles": percentiles(values),
        "samples": samples,
    }


def _completion_sample(card, start, value):
    return {
        "card_uid": card.uid,
        "value_days": value,
        "start": _iso(start),
        "end": _iso(card.completion_at),
        "reopened": card.reopened_after(card.completion_at),
    }


def lead_time(flow, flow_range):
    """Lead time of the cards whose first completion falls in the range."""
    samples, excluded = [], 0
    for card in flow.cards:
        if card.completion_is_future:
            excluded += 1
        if card.completion_at is None or card.created_in_done or not flow_range.contains(card.completion_at):
            continue
        if card.completion_at < card.lead_start:
            excluded += 1
            continue
        samples.append((
            card.completion_at,
            _completion_sample(card, card.lead_start, _days_between(card.lead_start, card.completion_at)),
        ))
    return _duration_response("lead_time", _ordered_by_end(samples), excluded)


def cycle_time(flow, flow_range):
    """Cycle time of the cards whose first completion falls in the range."""
    samples, excluded = [], 0
    for card in flow.cards:
        if card.completion_is_future:
            excluded += 1
        if card.completion_at is None or not flow_range.contains(card.completion_at):
            continue
        if card.complete_history:
            if card.cycle_start is not None:
                value = _days_between(card.cycle_start, card.completion_at)
                sample = _completion_sample(card, card.cycle_start, value)
                # Additive (#2360): the cycle's time in gated stages' last
                # sub-columns. 0 for a cycle that crossed no gated stage, so
                # work_days equals value_days there.
                wait = sum(
                    visit.wait_days(card.cycle_start, card.completion_at) or 0.0
                    for visit in card.visits
                    if visit.key not in flow.done_uids
                )
                sample["wait_days"], sample["work_days"] = _split(value, wait)
                samples.append((card.completion_at, sample))
        elif not (card.created_in_done or card.straight_to_done):
            # Left out only for its history. A card that would have no cycle
            # time anyway is not an exclusion.
            excluded += 1
    return _duration_response("cycle_time", _ordered_by_end(samples), excluded, flow)


def _column_entries(flow):
    return [c for c in flow.columns if not c.is_done]


def _dwell_response(flow, samples, excluded):
    per_column = {c.uid: [] for c in _column_entries(flow)}
    waits = {c.uid: [] for c in _column_entries(flow)}
    works = {c.uid: [] for c in _column_entries(flow)}
    for sample in samples:
        if sample["column_uid"] in per_column:
            per_column[sample["column_uid"]].append(sample["value_days"])
            if sample.get("wait_days") is not None:
                waits[sample["column_uid"]].append(sample["wait_days"])
                works[sample["column_uid"]].append(sample["work_days"])
    response = _duration_response("dwell_time", samples, excluded)
    response["columns"] = [
        {
            "column_uid": c.uid,
            "column_name": c.name,
            "sample_size": len(per_column[c.uid]),
            "percentiles": percentiles(per_column[c.uid]),
            # Additive (#2360): null for a stage with no sub-columns.
            "work_percentiles": percentiles(works[c.uid]) if c.uid in flow.gate_last else None,
            "wait_percentiles": percentiles(waits[c.uid]) if c.uid in flow.gate_last else None,
        }
        for c in _column_entries(flow)
    ]
    return response


def _dwell_visits(flow):
    """``(card, visit)`` for every visit to a column that is not done."""
    for card in flow.cards:
        for visit in card.visits:
            if visit.key not in flow.done_uids:
                yield card, visit


def completed_dwell(flow, flow_range):
    """Visits that closed in the range, at their full length, wherever they started."""
    samples, excluded = [], 0
    for card, visit in _dwell_visits(flow):
        if visit.is_open or not flow_range.contains(visit.end):
            continue
        value = visit.value_days(flow.now)
        if not visit.measured or value is None:
            excluded += 1
            continue
        wait, work = _split(value, visit.wait_days())
        samples.append((visit.end, {
            "card_uid": card.uid,
            "column_uid": flow.column_ref(visit.key),
            "value_days": value,
            "start": _iso(visit.start),
            "end": _iso(visit.end),
            "reopened": card.reopened_after(visit.end),
            # Additive (#2360): null outside a gated stage.
            "wait_days": wait,
            "work_days": work,
        }))
    return _dwell_response(flow, _ordered_by_end(samples), excluded)


def column_dwell(flow, flow_range):
    """Completed dwell per current not-done column, without the samples (#2260).

    The Analytics redesign's "Where the time goes" reads only the per-column
    percentiles; the visits themselves stay on ``completed_dwell`` (and MCP).
    """
    dwell = completed_dwell(flow, flow_range)
    return {
        "definition": dwell["definition"],
        "sample_size": dwell["sample_size"],
        "excluded_incomplete_history": dwell["excluded_incomplete_history"],
        "columns": dwell["columns"],
    }


def current_dwell(flow):
    """Open visits, measured now. A snapshot: no range."""
    open_visits, excluded = [], 0
    for card, visit in _dwell_visits(flow):
        if not visit.is_open:
            continue
        if visit.measured:
            open_visits.append((card, visit))
        else:
            excluded += 1
    blocked = blocked_card_ids(flow, [card for card, _ in open_visits])
    samples = [
        {
            "card_uid": card.uid,
            "column_uid": flow.column_ref(visit.key),
            "value_days": visit.value_days(flow.now),
            "start": _iso(visit.start),
            "end": None,
            # Additive to the ADR's sample: #1151's aging_cards names blocked cards.
            "is_blocked": card.id in blocked,
            # Additive (#2360): null outside a gated stage.
            **dict(zip(("wait_days", "work_days"), _split(visit.value_days(flow.now), visit.wait_days()))),
        }
        for card, visit in open_visits
    ]
    return _dwell_response(flow, samples, excluded)


def column_entered_at(flow):
    """``{card_id: start of its open visit}`` for the #459 overlay's ``column_entered_at``.

    Only cards with a measured open visit in a column that is not done; every
    other card (archived, in a done column, unmeasured) is absent, meaning null.
    """
    entered = {}
    for card in flow.cards:
        visit = card.open_visit
        if visit is not None and visit.measured and visit.key not in flow.done_uids and card.archived_at is None:
            entered[card.id] = visit.start
    return entered


def _dwell_by_column(flow, card, since=None):
    """The card's measured visits summed per column key, in order of first entry.

    With ``since`` each visit is clipped to ``[since, now]`` (#2292): the drawer
    passes the card's ``age_start`` so the per-column shares sum to the age and
    time before the age clock started, or in an earlier cycle, is not counted.
    """
    totals: dict[object, float] = {}
    for visit in card.visits:
        if visit.key in flow.done_uids or not visit.measured:
            continue
        if since is not None:
            end = visit.end if visit.end is not None else flow.now
            if end <= since:
                continue
            visit = Visit(key=visit.key, start=max(visit.start, since), end=visit.end, measured=True)
        value = visit.value_days(flow.now)
        if value is not None:
            totals[visit.key] = totals.get(visit.key, 0.0) + value
    return [{"column_uid": flow.column_ref(key), "value_days": value} for key, value in totals.items()]


def blocked_card_ids(flow, cards):
    """Which of ``cards`` are blocked now: manually or by an active relation (#1149, #449).

    The same union as ``CardSerializer.is_blocked``. One query, for the relations.
    """
    if not cards:
        return set()
    by_relation = set(
        CardRelation.objects.filter(
            to_card_id__in=[card.id for card in cards],
            relation_type=CardRelation.Type.BLOCKS,
            from_card__archived_at__isnull=True,
            # Only same-board relation rows count (#2229).
            from_card__board_id=F("to_card__board_id"),
        ).values_list("to_card_id", flat=True)
    )
    return by_relation | {card.id for card in cards if card.blocked_at is not None}


def _block_intervals(flow, flow_range):
    """``(card_id, column_id, reason, seconds)`` for each block's part inside the range (#1149, #2260).

    A thin wrapper over ``_block_spans``, which carries the same rows with their bounds.

    ADR "Blocked time": reported as its own metric, never subtracted. One query
    over ``CardBlock`` (indexed by board). A block counts for the part of it that
    falls inside the range; an open block runs to now, or to ``archived_at`` while
    its card is archived (a restore clears ``archived_at``, so the block then runs
    to now again). An open block whose card was hard-deleted has no end anyone can
    observe, so it is left out rather than accruing time forever.

    Every end is clipped to the end of the range, and never later than now: an
    imported block can carry a future timestamp, and it must not inflate anyone's
    numbers, and a date range that ended in the past must not count time after it
    (#2260). A rolling range ends at now, so it is unaffected by the second clip.

    Rows come newest first, so the first spelling of a reason seen is the newest.
    Under a swimlane or label filter only blocks of live cards it selects count:
    a hard-deleted card has no current swimlane or labels to match. ``flow.cards``
    is never read, so a narrowed load gives the same intervals as a full one.
    """
    for card_id, column_id, reason, begin, end in _block_spans(flow, flow_range):
        yield card_id, column_id, reason, (end - begin).total_seconds()


def _block_spans(flow, flow_range):
    """``(card_id, column_id, reason, begin, end)`` of each block clipped to the range; see ``_block_intervals``."""
    range_end = min(flow.now, flow_range.end)
    start = flow_range.start
    rows = (
        CardBlock.objects.filter(board=flow.board, blocked_at__lt=range_end)
        .filter(Q(unblocked_at__isnull=True) | Q(unblocked_at__gte=start))
        .exclude(card__isnull=True, unblocked_at__isnull=True)
    )
    if flow.swimlane_id is not None or flow.label_id is not None:
        rows = rows.filter(card__in=_base_cards(flow.board, flow.swimlane_id, flow.label_id).order_by().values("id"))
    for row in rows.order_by("-blocked_at", "-id").values(
        "card_id", "column_id", "reason", "blocked_at", "unblocked_at", "card__archived_at",
    ):
        end = min(row["unblocked_at"] or row["card__archived_at"] or flow.now, range_end)
        begin = max(row["blocked_at"], start)
        if end <= begin:
            continue
        yield row["card_id"], row["column_id"], row["reason"], begin, end


def _reason_key(reason):
    """Reasons cluster case- and whitespace-insensitively: one cause typed twice is one reason."""
    return " ".join(reason.split()).casefold()


def blocked_time(flow, flow_range):
    """Blocked time per column name and the most common reasons, for ``/analytics/`` and MCP (#1149).

    Time is attributed to the column the card was in when it was blocked
    (``CardBlock.column``), by identity and never by name: a column deleted and
    recreated under the same name is a different column (ADR "Current column"). A
    block in a column that no longer exists has no per-column line, but it counts
    toward ``total`` and ``top_reasons``.

    Column names are unique on a board (``unique_together``), so keying by name
    merges no two live columns. Each per-column ``days`` is rounded on its own,
    so they need not add up to ``total.days``; ``seconds_per_column`` sums
    exactly (#2297). Reasons rank by block count here; ``blocked_summary``
    (``metrics/blocked``) ranks by time, and MCP serves both.

    Rows are summed in Python rather than in SQL because of the reason clustering.
    The row count is the blocks overlapping the range on one board, which stays
    small next to the movement rows the same request already loaded.
    """
    col_id_to_name = {c.id: c.name for c in flow.columns}
    seconds_per_column = {c.name: 0.0 for c in flow.columns}
    blocks_per_column = {c.name: 0 for c in flow.columns}
    reasons: dict[str, dict] = {}
    total_seconds = 0.0
    total_blocks = 0
    for _card_id, column_id, reason, seconds in _block_intervals(flow, flow_range):
        total_seconds += seconds
        total_blocks += 1
        name = col_id_to_name.get(column_id)
        if name is not None:
            seconds_per_column[name] += seconds
            blocks_per_column[name] += 1
        bucket = reasons.setdefault(_reason_key(reason), {"reason": reason.strip(), "count": 0, "seconds": 0.0})
        bucket["count"] += 1
        bucket["seconds"] += seconds
    top = sorted(reasons.values(), key=lambda r: (-r["count"], -r["seconds"], r["reason"]))
    return {
        # Every block in the range, including those in deleted columns, which no
        # per-column line holds and which top_reasons may have capped away.
        "total": {
            "days": round(total_seconds / SECONDS_PER_DAY, 1),
            "seconds": int(total_seconds),
            "blocks": total_blocks,
        },
        "days_per_column": {k: round(v / SECONDS_PER_DAY, 1) for k, v in seconds_per_column.items()},
        "seconds_per_column": {k: int(v) for k, v in seconds_per_column.items()},
        "blocks_per_column": blocks_per_column,
        "top_reasons": [
            {
                "reason": r["reason"], "count": r["count"],
                "total_days": round(r["seconds"] / SECONDS_PER_DAY, 1), "total_seconds": int(r["seconds"]),
            }
            for r in top[:TOP_BLOCK_REASONS]
        ],
    }


def load_live_wip(board, *, swimlane_id=None, label_id=None, now=None):
    """Only the cards ``blocked_summary`` reads: not archived and not in a done column.

    ``_block_intervals`` never reads ``flow.cards``, and ``blocked_now`` counts
    only these cards, so loading the rest could not change the answer.
    """
    return load_board_flow(
        board, swimlane_id=swimlane_id, label_id=label_id, now=now,
        cards_matching=Q(archived_at__isnull=True) & ~Q(column__is_done=True),
    )


def _live_wip(flow):
    return [card for card in flow.cards if card.archived_at is None and card.column_uid not in flow.done_uids]


def blocked_summary(flow, flow_range):
    """Blocked time for the Analytics redesign: by column uid and by reason, unrounded (#2260).

    The same intervals as ``blocked_time``, keyed by ``column_uid`` rather than
    name, with reasons ranked by time rather than count: the redesign asks "why
    do cards get blocked", and a reason that holds cards longest answers it.
    """
    per_column = {c.id: [0.0, 0] for c in flow.columns}
    reasons: dict[str, dict] = {}
    total_seconds = 0.0
    total_blocks = 0
    for _card_id, column_id, reason, seconds in _block_intervals(flow, flow_range):
        total_seconds += seconds
        total_blocks += 1
        if column_id in per_column:
            per_column[column_id][0] += seconds
            per_column[column_id][1] += 1
        bucket = reasons.setdefault(_reason_key(reason), {"reason": reason.strip(), "seconds": 0.0, "blocks": 0})
        bucket["seconds"] += seconds
        bucket["blocks"] += 1
    ranked = sorted(reasons.values(), key=lambda r: (-r["seconds"], -r["blocks"], r["reason"]))
    return {
        "definition": DEFINITIONS["blocked_time"],
        "total": {"days": total_seconds / SECONDS_PER_DAY, "blocks": total_blocks},
        "blocked_now": len(blocked_card_ids(flow, _live_wip(flow))),
        "columns": [
            {
                "column_uid": c.uid,
                "column_name": c.name,
                "days": per_column[c.id][0] / SECONDS_PER_DAY,
                "blocks": per_column[c.id][1],
            }
            for c in flow.columns
        ],
        "reasons": [
            {"reason": r["reason"], "days": r["seconds"] / SECONDS_PER_DAY, "blocks": r["blocks"]}
            for r in ranked[:TOP_BLOCK_REASONS]
        ],
        "reason_count": len(reasons),
    }


def _blocked_seconds_in_progress(flow, in_progress):
    """Blocked seconds per card, from its age start to now (#1149, ADR "Blocked time").

    Reported beside age, never subtracted from it. One query, indexed by board.
    """
    if not in_progress:
        return {}
    starts = {card.id: card.age_start for card in in_progress}
    oldest = min(starts.values())
    seconds: dict[int, float] = {}
    rows = (
        CardBlock.objects.filter(board=flow.board, card_id__in=starts, blocked_at__lte=flow.now)
        .filter(Q(unblocked_at__isnull=True) | Q(unblocked_at__gte=oldest))
        .values_list("card_id", "blocked_at", "unblocked_at")
    )
    for card_id, blocked_at, unblocked_at in rows:
        begin = max(blocked_at, starts[card_id])
        end = min(unblocked_at or flow.now, flow.now)
        if end > begin:
            seconds[card_id] = seconds.get(card_id, 0.0) + (end - begin).total_seconds()
    return seconds


def age(flow, flow_range):
    """WIP age of cards in progress, with the cycle-time percentiles for the aging zones.

    Age is a snapshot and takes no range. The range only moves
    ``cycle_time_percentiles``: the zones are cycle times completed in the range.
    """
    position = {c.uid: c.position for c in flow.columns}
    in_progress = []
    excluded = 0
    # The live WIP per column (#2287): every card not archived in the column,
    # the count the board's column header holds against its WIP limit. The
    # samples leave out cards that have not started and cards with broken
    # history, so they cannot be that count.
    wip_counts: dict[str, int] = {}
    for card in flow.cards:
        if card.archived_at is not None or card.column_uid in flow.done_uids:
            continue
        wip_counts[card.column_uid] = wip_counts.get(card.column_uid, 0) + 1
        if not card.complete_history:
            excluded += 1
        elif card.age_start is not None:
            in_progress.append(card)
    blocked_seconds = _blocked_seconds_in_progress(flow, in_progress)
    blocked = blocked_card_ids(flow, in_progress)
    samples = [
        {
            "card_uid": card.uid,
            "column_uid": card.column_uid,
            "value_days": _days_between(card.age_start, flow.now),
            "start": _iso(card.age_start),
            "dwell_by_column": _dwell_by_column(flow, card, since=card.age_start),
            # Additive to the ADR's sample for the drawer's blocked time and
            # the chart's square mark.
            "is_blocked": card.id in blocked,
            "blocked_days": blocked_seconds.get(card.id, 0.0) / SECONDS_PER_DAY,
        }
        for card in in_progress
    ]
    samples.sort(key=lambda s: (position.get(s["column_uid"], 0), -s["value_days"]))
    return {
        "definition": definition("age", flow),
        "sample_size": len(samples),
        "excluded_incomplete_history": excluded,
        "cycle_time_percentiles": cycle_time(flow, flow_range)["percentiles"],
        # Additive to the ADR's shape: the chart's x-axis, so an empty column
        # keeps its place and the client needs no second source of order.
        "columns": [
            {"column_uid": c.uid, "column_name": c.name, "wip_count": wip_counts.get(c.uid, 0)}
            for c in _column_entries(flow)
        ],
        "samples": samples,
    }


ATTENTION_REASONS = ("blocked", "past_p85", "stalled")


def _attention_block_reason(card, reasons):
    """The manual block's text for an item marked ``blocked``, or None (#2281).

    Only a manual block carries text: a card blocked only by a relation (#449)
    has none, and neither does one whose ``blocked_at`` is clear (a stale
    reason left on the row is not a block). An empty or whitespace-only reason
    is None, never "", so a client has one "no reason" case to handle.
    """
    if "blocked" not in reasons or card.blocked_at is None:
        return None
    return card.blocked_reason.strip() or None


def needs_attention(flow, flow_range, *, stalled_days):
    """Live cards outside done that are blocked, past the cycle-time p85, or stalled (#2260).

    The base is every card not archived and not in a done column, the old
    stalled-cards table's base, not only cards in progress: a backlog card that
    has sat for weeks is stalled whether or not it has started. ``past_p85``
    needs an age, so it applies only to cards in progress (ADR "Age"), and only
    when p85 exists under the sample-size rule. Both comparisons are strict.
    One pass over the cards, so each card is listed once with all its reasons.
    The range moves only the p85, as on wip-age.
    """
    ct_percentiles = cycle_time(flow, flow_range)["percentiles"]
    p85 = ct_percentiles["p85"]
    candidates = _live_wip(flow)
    blocked = blocked_card_ids(flow, candidates)
    entries = []
    for card in candidates:
        age_days = (
            _days_between(card.age_start, flow.now) if card.is_in_progress(flow.done_uids) else None
        )
        # A card with no live movement row (imported or legacy data) has "not moved" since it was created;
        # without this fallback it could never be stalled (#2291). ``created_at`` is the import time unless
        # the importer set it, and Card has no separate import timestamp.
        unmoved_since = card.last_moved_at if card.last_moved_at is not None else card.created_at
        unmoved_days = _days_between(unmoved_since, flow.now)
        reasons = []
        if card.id in blocked:
            reasons.append("blocked")
        if age_days is not None and p85 is not None and age_days > p85:
            reasons.append("past_p85")
        if unmoved_days is not None and unmoved_days > stalled_days:
            reasons.append("stalled")
        if reasons:
            entries.append((card, age_days, unmoved_days, reasons))
    entries.sort(key=lambda e: (e[1] is None, -(e[1] or 0.0), e[2] is None, -(e[2] or 0.0), e[0].id))
    return {
        "definition": DEFINITIONS["needs_attention"],
        "stalled_threshold_days": stalled_days,
        "cycle_time_percentiles": ct_percentiles,
        "items": [
            {
                "card_uid": card.uid,
                "column_uid": card.column_uid,
                "swimlane_id": card.swimlane_id,
                "age_days": age_days,
                "unmoved_days": unmoved_days,
                "reasons": reasons,
                "block_reason": _attention_block_reason(card, reasons),
            }
            for card, age_days, unmoved_days, reasons in entries
        ],
    }


# ── Counts ─────────────────────────────────────────────────────────────────


def wip(flow):
    """Cards per current not-done column, from ``Card.column``, whatever their history."""
    per_column: dict[str, list] = {c.uid: [] for c in _column_entries(flow)}
    for card in flow.cards:
        if card.archived_at is None and card.column_uid in per_column:
            per_column[card.column_uid].append(card.uid)
    return {
        "definition": DEFINITIONS["wip"],
        "columns": [
            {
                "column_uid": c.uid,
                "column_name": c.name,
                "count": len(per_column[c.uid]),
                "card_uids": per_column[c.uid],
            }
            for c in _column_entries(flow)
        ],
    }


def _periods(flow_range, period):
    """The whole periods in the range: ``[(first_day, last_day)]``, ascending."""
    if period == "day":
        return [(day, day) for day in flow_range.days]
    first = flow_range.first_day
    monday = first + datetime.timedelta(days=(7 - first.weekday()) % 7)
    weeks = []
    while monday + datetime.timedelta(days=6) <= flow_range.last_day:
        weeks.append((monday, monday + datetime.timedelta(days=6)))
        monday += datetime.timedelta(days=7)
    return weeks


def throughput(flow, flow_range, period="week"):
    """Completions per whole UTC day or ISO week. Zero periods count toward the median.

    ``total`` sums the whole periods, so a partial week at either end of the
    range is in neither. ``completed_in_range`` (#2288) counts the first
    completions in ``[start, end)`` instead, the window the cycle-time sample
    uses, so the Analytics Done box and its "in N days" caption agree.
    """
    periods = _periods(flow_range, period)
    index_of_day = {}
    for index, (first, last) in enumerate(periods):
        for offset in range((last - first).days + 1):
            index_of_day[first + datetime.timedelta(days=offset)] = index
    buckets: list[list] = [[] for _ in periods]
    # Starts are counted by cycle start, the same anchor cycle time uses: a
    # reopen is not a start, and a card with no creation movement never starts.
    started = [0] * len(periods)
    for card in flow.cards:
        if card.cycle_start is not None:
            index = index_of_day.get(_utc_date(card.cycle_start))
            if index is not None:
                started[index] += 1
    completed = sorted(
        (card for card in flow.cards if card.completion_at is not None),
        key=lambda card: card.completion_at,
    )
    for card in completed:
        index = index_of_day.get(_utc_date(card.completion_at))
        if index is not None:
            buckets[index].append(card.uid)
    samples = [
        {"start": first.isoformat(), "count": len(uids), "card_uids": uids, "started": begun}
        for (first, _), uids, begun in zip(periods, buckets, started)
    ]
    counts = sorted(len(uids) for uids in buckets)
    return {
        "definition": DEFINITIONS["throughput"],
        "period": period,
        "total": sum(counts),
        "completed_in_range": sum(1 for card in completed if flow_range.contains(card.completion_at)),
        "median": percentile(counts, 50),
        "samples": samples,
    }


def _band(flow, placement):
    """The cumulative-flow band of a placement: a current column's uid, or the deleted band."""
    return placement if isinstance(placement, str) and placement in flow.current_uids else NULL_BAND_KEY


def _cfd_columns(flow):
    return [
        *({"column_uid": c.uid, "column_name": c.name, "is_done": c.is_done} for c in flow.columns),
        {"column_uid": None, "column_name": None, "is_done": False},
    ]


def _bottleneck(flow, first_counts, last_counts):
    """The current not-done column that grew most across the window; earlier position wins a tie.

    The board's first not-done column is the intake: new work arriving there is
    not a queue that is failing to drain, so it never counts (#2290). A board
    with one not-done column therefore has no bottleneck.
    """
    best, best_growth = None, 0
    for column in _column_entries(flow)[1:]:
        growth = last_counts[column.uid] - first_counts[column.uid]
        if growth > best_growth:
            best, best_growth = column.uid, growth
    return best


def cumulative_flow(flow, flow_range):
    """Cards per column at the end of each whole UTC day, plus the bottleneck.

    Each card contributes one ``+1``/``-1`` pair per placement to a difference
    array, and one pass turns those into daily counts. So the cost grows with
    movements plus days × columns, never with days × cards (no per-day loop).

    Each column also carries its flow across the window (#2260): ``entered`` and
    ``left`` count band changes dated after the first day and up to the last, so
    ``end_count - start_count == entered - left`` holds exactly for every band,
    and the bottleneck, which reads the same first and last day, is unchanged.
    Archiving outside done leaves a band; archiving in done does not.

    ``completed`` and ``completed_per_week`` (#2307) are the done band's rate.
    Summing the done columns' ``entered`` counts a card that moves Done A to
    Done B twice, and a reopened card each time it finishes again. They count
    first completions instead (``completion_at``, the throughput definition:
    a card's first entry into a done column), in the same window as
    ``entered``, so the rate sits on the row's scale and matches throughput.
    """
    days = flow_range.days
    index = {day: i for i, day in enumerate(days)}
    bands = [c.uid for c in flow.columns] + [NULL_BAND_KEY]
    deltas = {band: [0] * (len(days) + 1) for band in bands}
    entered = dict.fromkeys(bands, 0)
    left = dict.fromkeys(bands, 0)

    def to_index(day):
        if day <= flow_range.first_day:
            return 0
        return index.get(day, len(days))

    # Cards a range load skipped (#2425): every placement before the first
    # day, so each sits in its last band from the first day to the last.
    for placement, count in flow.settled_placements.items():
        if days:
            deltas[_band(flow, placement)][0] += count
            deltas[_band(flow, placement)][len(days)] -= count

    for card in flow.cards:
        stops = card.placements
        prev_band = None
        for i, (moment, placement) in enumerate(stops):
            band = None if placement is _OFF_DIAGRAM else _band(flow, placement)
            if band != prev_band:
                if days and flow_range.first_day < _utc_date(moment) <= flow_range.last_day:
                    if prev_band is not None:
                        left[prev_band] += 1
                    if band is not None:
                        entered[band] += 1
                prev_band = band
            if band is None:
                continue
            start = to_index(_utc_date(moment))
            end = to_index(_utc_date(stops[i + 1][0])) if i + 1 < len(stops) else len(days)
            if start < end:
                deltas[band][start] += 1
                deltas[band][end] -= 1

    running = dict.fromkeys(bands, 0)
    rows = []
    for i, day in enumerate(days):
        counts = {}
        for band in bands:
            running[band] += deltas[band][i]
            counts[band] = running[band]
        rows.append({"date": day.isoformat(), "counts": counts})
    # The window holds len(days) - 1 whole days of change (it opens at the end of the first).
    span = len(days) - 1
    columns = _cfd_columns(flow)
    for column in columns:
        band = column["column_uid"] if column["column_uid"] is not None else NULL_BAND_KEY
        column.update({
            "start_count": rows[0]["counts"][band] if rows else None,
            "end_count": rows[-1]["counts"][band] if rows else None,
            "entered": entered[band],
            "left": left[band],
            "entered_per_week": entered[band] * 7 / span if span >= 1 else None,
            "left_per_week": left[band] * 7 / span if span >= 1 else None,
        })
    completed = sum(
        1 for card in flow.cards
        if days and card.completion_at is not None
        and flow_range.first_day < _utc_date(card.completion_at) <= flow_range.last_day
    )
    return {
        "definition": DEFINITIONS["cumulative_flow"],
        "columns": columns,
        "completed": completed,
        "completed_per_week": completed * 7 / span if span >= 1 else None,
        "days": rows,
        "bottleneck_column_uid": (
            _bottleneck(flow, rows[0]["counts"], rows[-1]["counts"]) if rows else None
        ),
    }


def cumulative_flow_cards(flow, day):
    """The cards behind one cumulative-flow day: the same placement rule, read at its end."""
    per_band: dict[str, list] = {c.uid: [] for c in flow.columns}
    per_band[NULL_BAND_KEY] = []
    for card in flow.cards:
        at_day_end = None
        for moment, placement in card.placements:
            if _utc_date(moment) <= day:
                at_day_end = placement
        if at_day_end is not None and at_day_end is not _OFF_DIAGRAM:
            per_band[_band(flow, at_day_end)].append(card.uid)
    return {
        "definition": DEFINITIONS["cumulative_flow"],
        "date": day.isoformat(),
        "columns": [
            *({"column_uid": c.uid, "card_uids": per_band[c.uid]} for c in flow.columns),
            {"column_uid": None, "card_uids": per_band[NULL_BAND_KEY]},
        ],
    }


# ── Roll-ups for the Summary and Analytics views ───────────────────────────


def swimlane_completion_rollup(flow):
    """``{swimlane_id: {velocity_7d, velocity_30d, avg_cycle_days}}`` for ``summary``.

    Velocities count cards by first completion, archived or not, so a card that
    bounces or moves Done → Released counts once. ``avg_cycle_days`` stays a
    mean because its documented name says average; 1.x clients read it rounded.
    """
    last_7 = rolling_range(7, now=flow.now)
    last_30 = rolling_range(30, now=flow.now)
    rollup: dict[int, dict] = {}
    cycles: dict[int, list] = {}
    for card in flow.cards:
        if card.completion_at is None:
            continue
        row = rollup.setdefault(card.swimlane_id, {"velocity_7d": 0, "velocity_30d": 0, "avg_cycle_days": None})
        if last_7.contains(card.completion_at):
            row["velocity_7d"] += 1
        if last_30.contains(card.completion_at):
            row["velocity_30d"] += 1
            if card.complete_history and card.cycle_start is not None:
                cycles.setdefault(card.swimlane_id, []).append(_days_between(card.cycle_start, card.completion_at))
    for swimlane_id, values in cycles.items():
        rollup[swimlane_id]["avg_cycle_days"] = round(sum(values) / len(values), 1)
    return rollup


def _dwell_by_swimlane(flow, visits):
    """``{swimlane_id: {column_uid: [days]}}`` for measured visits in current columns."""
    grouped: dict[int, dict[str, list]] = {}
    for card, visit in visits:
        value = visit.value_days(flow.now)
        if value is None or not visit.measured or flow.column_ref(visit.key) is None:
            continue
        grouped.setdefault(card.swimlane_id, {}).setdefault(visit.key, []).append(value)
    return grouped


def _wait_by_swimlane(flow, visits):
    """``{swimlane_id: {column_uid: [wait days]}}`` for measured visits to gated stages (#2360)."""
    grouped: dict[int, dict[str, list]] = {}
    for card, visit in visits:
        value = visit.value_days(flow.now)
        wait = visit.wait_days()
        if value is None or wait is None or not visit.measured or flow.column_ref(visit.key) is None:
            continue
        grouped.setdefault(card.swimlane_id, {}).setdefault(visit.key, []).append(min(wait, value))
    return grouped


def completed_wait_by_swimlane(flow, flow_range):
    """Wait share of the heatmap's In period cells (#2360)."""
    return _wait_by_swimlane(
        flow,
        (
            (card, visit)
            for card, visit in _dwell_visits(flow)
            if not visit.is_open and flow_range.contains(visit.end)
        ),
    )


def current_wait_by_swimlane(flow):
    """Wait share of the heatmap's Age cells (#2360)."""
    return _wait_by_swimlane(flow, ((card, visit) for card, visit in _dwell_visits(flow) if visit.is_open))


def completed_dwell_by_swimlane(flow, flow_range):
    """Completed dwell grouped for the heatmap's In period mode."""
    return _dwell_by_swimlane(
        flow,
        (
            (card, visit)
            for card, visit in _dwell_visits(flow)
            if not visit.is_open and flow_range.contains(visit.end)
        ),
    )


def current_dwell_by_swimlane(flow):
    """Current dwell grouped for the heatmap's Age mode."""
    return _dwell_by_swimlane(flow, ((card, visit) for card, visit in _dwell_visits(flow) if visit.is_open))


# ── Swimlane comparison (#2266, analytics redesign "Swimlanes tab") ─────────

# Spec "Decisions": slower and faster need a 20% difference AND 10 finished
# cards. Constants, not settings, so the API, the docs and the page agree.
SWIMLANE_STATUS_THRESHOLD_PCT = 20
SWIMLANE_STATUS_MIN_FINISHED = 10
# Rolling-median points returned per swimlane (the page draws eight bars).
SWIMLANE_TREND_POINTS = 8


def _compare_to(value, reference):
    """``"slower"``, ``"faster"`` or ``"steady"``: ``value`` against ``reference`` by the 20% rule.

    Strictly more than the threshold either way, so exactly 20% is steady. Done
    in integer-scaled form (``value * 100`` against ``reference * 120``) so the
    boundary is not at the mercy of ``1.2`` having no exact binary form.
    """
    if value * 100 > reference * (100 + SWIMLANE_STATUS_THRESHOLD_PCT):
        return "slower"
    if value * 100 < reference * (100 - SWIMLANE_STATUS_THRESHOLD_PCT):
        return "faster"
    return "steady"


def swimlane_status(median, finished, board_median):
    """A swimlane's status against the board: ``slower``, ``in_line``, ``faster`` or None.

    WHY 20% and 10 cards (spec "Decisions", settled 2026-11-14): a median of a
    handful of cards moves a lot on one card, so a verdict on fewer than 10
    would flag lanes for noise, and a smaller gap than 20% is within the
    ordinary week-to-week wobble of a healthy team. Below either bar the lane
    shows its numbers and no verdict. Both are named constants, never settings.
    """
    if median is None or board_median is None or finished < SWIMLANE_STATUS_MIN_FINISHED:
        return None
    verdict = _compare_to(median, board_median)
    return "in_line" if verdict == "steady" else verdict


def swimlane_trend(points, finished):
    """The first-to-last rolling-median trend of one swimlane, or None.

    Same 20% rule as the status, applied to the first and last rolling medians
    inside the selected period only (the cross-period comparison is Enterprise).
    No 10-card floor of its own: the trend is two numbers the page prints beside
    the word, and each end point already needs the 5-card percentile floor of
    its own window. Those two end windows are separate, so in practice a lane
    needs about 10 finished cards before both are filled; 9 almost always gives
    None, because the first and last windows together cover the period without
    overlapping (they share only the mid-period instant). None when the
    swimlane has fewer than 5 finished cards, or when
    either end point is withheld.
    """
    if finished < MIN_PERCENTILE_SAMPLE_SIZE:
        return None
    first, last = points[0]["median_days"], points[-1]["median_days"]
    if first is None or last is None:
        return None
    return {"direction": _compare_to(last, first), "first_days": first, "last_days": last}


def _rolling_points(samples, flow_range, now):
    """Eight rolling medians over windows half as long as the period.

    Window ``i`` ends at ``start + W + i * W / 7`` for ``W`` = half the period, so
    every window is full width and the last ends at the end of the period, or
    at now when the period ends later: a date range ending today runs to
    tomorrow's midnight, and windows reaching past now would hold no cards
    there and fall under the 5-card floor (#2297). ``samples`` are
    ``(end, value_days)``. A window with under 5 cards withholds its median,
    like every other median.
    """
    end = max(min(flow_range.end, now), flow_range.start)
    half = (end - flow_range.start) / 2
    step = half / (SWIMLANE_TREND_POINTS - 1)
    points = []
    for i in range(SWIMLANE_TREND_POINTS):
        hi = flow_range.start + half + step * i
        values = sorted(v for end, v in samples if hi - half <= end <= hi)
        points.append({"at": _iso(hi), "median_days": percentile(values, 50), "sample_size": len(values)})
    return points


def swimlane_group_values(board, definition):
    """``({swimlane_id: value}, groups)`` for "Group lanes by" one swimlane custom field.

    One query. A lane with no value, or one that is no longer a choice, has no
    group (None). ``groups`` lists the field's valid values in field order.
    """
    if definition.field_type == definition.FieldType.CHECKBOX:
        valid = ["true", "false"]
        groups = [{"key": key, "name": None} for key in valid]
    else:
        valid = []
        for choice in definition.choices_json:
            if isinstance(choice, str) and choice not in valid:
                valid.append(choice)
        groups = [{"key": key, "name": key} for key in valid]
    values = {
        lane_id: value
        for lane_id, value in SwimlaneCustomFieldValue.objects.filter(
            field_definition=definition, swimlane__board=board,
        ).values_list("swimlane_id", "value")
        if value in valid
    }
    return values, groups


def _in_progress_spans(card):
    """``(begin, end_or_None)`` for each round of work: first, and after every reopen.

    The first runs from the cycle start to the first completion. Each reopen
    starts another that runs to the next done entry; an open one ends where the
    caller says (archive or now). A card with no cycle start still gets its
    reopen rounds, as its age does (ADR "Reopened cards").
    """
    spans = []
    if card.cycle_start is not None:
        spans.append((card.cycle_start, card.completion_at))
    later = sorted(card.recompletions)
    for reopen in card.reopens:
        close = next((t for t in later if t > reopen), None)
        spans.append((reopen, close))
    return spans


def _in_progress_windows(flow, flow_range):
    """``{card_id: [(begin, end), ...]}``: when each card was in progress inside the range.

    From the cycle start to the first completion, and from every reopen to the
    next completion (an open round ends at archive, or now), clipped to the
    range. Post-reopen time counts, so blocked share covers the same in-progress
    time that age and ``in_progress`` count (#2297; decisions.md "Blocked
    share"). Cards with neither a measured cycle start nor a reopen have no window.
    """
    end_of_range = min(flow.now, flow_range.end)
    windows = {}
    for card in flow.cards:
        if not card.complete_history:
            continue
        clipped = []
        for begin, end in _in_progress_spans(card):
            begin = max(begin, flow_range.start)
            end = min(end or card.archived_at or flow.now, end_of_range)
            if end > begin:
                clipped.append((begin, end))
        if clipped:
            windows[card.id] = clipped
    return windows


def _union_seconds(spans):
    """Total length of possibly overlapping ``(begin, end)`` spans, counting overlap once."""
    total, current_end = 0.0, None
    for begin, end in sorted(spans):
        if current_end is not None and begin < current_end:
            begin = current_end
        if end > begin:
            total += (end - begin).total_seconds()
            current_end = end if current_end is None else max(current_end, end)
    return total


def _clip(spans, begin, end):
    """``spans`` cut to ``[begin, end)``; a None bound is open."""
    clipped = []
    for low, high in spans:
        low = max(low, begin) if begin is not None else low
        high = min(high, end) if end is not None else high
        if high > low:
            clipped.append((low, high))
    return clipped


def _lane_blocked_and_elapsed(flow, flow_range):
    """``({swimlane_id: blocked_seconds}, {swimlane_id: elapsed_seconds})`` while cards were in progress.

    Both sides use the same per-card window, so a block opened in the backlog
    or after completion adds to neither, and overlapping blocks count once.
    Each second goes to the swimlane the card was in at that second (#2334):
    a card that changed swimlane mid-work splits its time between the two.
    """
    windows = _in_progress_windows(flow, flow_range)
    spans: dict[int, list] = {}
    for card_id, _column_id, _reason, begin, end in _block_spans(flow, flow_range):
        for low, high in windows.get(card_id, ()):
            b, e = max(begin, low), min(end, high)
            if e > b:
                spans.setdefault(card_id, []).append((b, e))
    blocked: dict[int, float] = {}
    elapsed: dict[int, float] = {}
    for card in flow.cards:
        window = windows.get(card.id)
        if window is None:
            continue
        card_spans = spans.get(card.id, ())
        for begin, end, lane in card.lane_spans():
            elapsed[lane] = elapsed.get(lane, 0.0) + _union_seconds(_clip(window, begin, end))
            blocked[lane] = blocked.get(lane, 0.0) + _union_seconds(_clip(card_spans, begin, end))
    return blocked, elapsed


def swimlane_comparison(flow, flow_range, swimlanes, group_definition=None):
    """Per-swimlane cycle time, trend, blocked share and status, for the Swimlanes tab (#2266).

    Every number is one pass over ``flow.cards`` and the one ``CardBlock`` query
    of ``_block_intervals``, bucketed by swimlane: no query per lane. A lane's
    cycle time is ``cycle_time``'s own samples, so its median and p85 follow the
    same definition and sample-size rule (p50 needs 5, p85 needs 7) as the board.

    ``swimlanes`` is the board's swimlane rows in display order; a lane with no
    cards still gets a row, so the page can say "0 finished". The board median
    is for the same filters (label, period) and every swimlane.

    Attribution is at event time (#2334): a finished card counts under the
    swimlane it completed in, ``in_progress`` under the one it is in now. A
    completion in a since-deleted swimlane is in the board numbers and in no row.
    Counts follow the swimlane at their instant and blocked share follows where
    the time was spent, so a card dragged into done from another swimlane is
    finished in the one it was dropped in and blocked in the one it left.

    Blocked share is the lane's blocked seconds over its in-progress seconds,
    both counted only while each card was in progress inside the range: from
    its cycle start to its first completion, and again from each reopen. A card
    with neither a cycle start nor a reopen has no window and no share.
    """
    done_uids = flow.done_uids
    samples = cycle_time(flow, flow_range)["samples"]
    lane_of = {card.uid: card.lane_at(card.completion_at) for card in flow.cards if card.completion_at is not None}
    by_lane: dict[int | None, list] = {}
    for sample in samples:
        end = datetime.datetime.fromisoformat(sample["end"])
        by_lane.setdefault(lane_of[sample["card_uid"]], []).append((end, sample["value_days"]))
    in_progress: dict[int, int] = {}
    for card in flow.cards:
        if card.is_in_progress(done_uids):
            in_progress[card.swimlane_id] = in_progress.get(card.swimlane_id, 0) + 1

    lane_blocked, lane_elapsed = _lane_blocked_and_elapsed(flow, flow_range)

    board_values = sorted(v for rows in by_lane.values() for _, v in rows)
    board_median = percentile(board_values, 50)
    group_values, groups = swimlane_group_values(flow.board, group_definition) if group_definition else ({}, [])

    rows = []
    for lane in swimlanes:
        lane_samples = by_lane.get(lane.id, [])
        values = sorted(v for _, v in lane_samples)
        finished = len(values)
        median = percentile(values, 50)
        points = _rolling_points(lane_samples, flow_range, flow.now)
        total = lane_elapsed.get(lane.id)
        rows.append({
            "id": lane.id,
            "name": lane.name,
            "position": lane.position,
            "group": group_values.get(lane.id),
            "finished": finished,
            "in_progress": in_progress.get(lane.id, 0),
            "median_days": median,
            "p85_days": percentile(values, 85),
            "blocked_share": round(lane_blocked[lane.id] / total, 4) if total else None,
            "rolling_median": points,
            "status": swimlane_status(median, finished, board_median),
            "trend": swimlane_trend(points, finished),
        })
    payload = {
        "definition": definition("cycle_time", flow),
        "board": {
            "finished": len(board_values),
            "median_days": board_median,
            "p85_days": percentile(board_values, 85),
        },
        "status_threshold_pct": SWIMLANE_STATUS_THRESHOLD_PCT,
        "status_min_finished": SWIMLANE_STATUS_MIN_FINISHED,
        "swimlanes": rows,
        "grouping": None,
    }
    if group_definition is not None:
        payload["grouping"] = {
            "field_id": group_definition.id,
            "field_name": group_definition.name,
            "field_type": group_definition.field_type,
            "groups": groups,
        }
    return payload
