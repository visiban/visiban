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

import datetime
from dataclasses import dataclass, field
from typing import NamedTuple

from django.db.models import Exists, OuterRef, Q
from django.utils import timezone

from ..models import Card, CardBlock, CardMovement, CardRelation, Column

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
}

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
    rank = percentile_rank(p, n)
    if rank >= n:
        return None
    return sorted_values[rank - 1]


def percentiles(values):
    """``{p50, p85, p95}`` for unsorted values, each a number or None."""
    ordered = sorted(values)
    return {f"p{p}": percentile(ordered, p) for p in PERCENTILES}


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


def _days_between(start, end):
    """Elapsed calendar days: seconds ÷ 86,400. Never rounded here; display rounds."""
    return (end - start).total_seconds() / SECONDS_PER_DAY


# ── Per-card history ───────────────────────────────────────────────────────


class _Movement(NamedTuple):
    moved_at: datetime.datetime
    movement_type: str
    from_key: object
    to_key: object

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

    @property
    def is_open(self):
        return self.end is None

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
    reopens: list = field(default_factory=list)
    visits: list = field(default_factory=list)
    placements: list = field(default_factory=list)

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
            current = Visit(key=mv.to_key, start=mv.moved_at)
            visits.append(current)
        elif mv.is_transition:
            if current is not None:
                close(mv.moved_at, mv.from_key)
            current = Visit(key=mv.to_key, start=mv.moved_at)
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
            current = Visit(key=mv.to_key, start=mv.moved_at, measured=mv.to_key is not None)
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
    """The card's column over time, for cumulative flow: ``[(moment, key or off-diagram)]``."""
    if creation is not None:
        placements = [(creation.moved_at, creation.to_key)]
    else:
        # No creation movement: placed from created_at, in the source of its
        # earliest movement, or in its current column if there is none.
        source = live[0].from_key if live else None
        placements = [(flow.created_at, source if source is not None else flow.column_uid)]
    position = placements[0][1]
    archived = False
    last_archive_event = None

    def placed():
        # Finished work is cumulative: archiving a done card must not shrink
        # the done band. Any other archived card leaves the diagram.
        return position if (not archived or position in done_uids) else _OFF_DIAGRAM

    for mv in live:
        if mv is creation:
            continue
        if mv.is_transition:
            position = mv.to_key
        elif mv.movement_type == _ARCHIVED:
            archived, last_archive_event = True, _ARCHIVED
        elif mv.movement_type == _UNARCHIVED:
            archived, last_archive_event = False, _UNARCHIVED
        else:
            continue
        placements.append((mv.moved_at, placed()))
    if flow.archived_at is not None and last_archive_event != _ARCHIVED and flow.archived_at <= now:
        archived = True
        placements.append((flow.archived_at, placed()))
    return placements


def _analyze_card(flow, rows, done_uids, now):
    """Fill ``flow`` from the card's movements, ordered by ``(moved_at, id)``."""
    # A movement dated after this request is misdated: it and everything after
    # it are ignored, and the card has incomplete history.
    live = rows
    misdated = False
    for index, mv in enumerate(rows):
        if mv.moved_at > now:
            live, misdated = rows[:index], True
            break

    first = live[0] if live else None
    creation = (
        first
        if first is not None
        and first.movement_type == _MOVE
        and first.from_key is None
        and first.to_key is not None
        else None
    )
    flow.has_creation = creation is not None
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
        if mv.from_key in done_uids and mv.to_key not in done_uids:
            flow.reopens.append(mv.moved_at)

    if creation is not None and not flow.created_in_done and first_transition is not None:
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


def load_board_flow(board, *, swimlane_id=None, label_id=None, now=None, columns=None, cards_matching=None):
    """Load and analyze a board's history in a fixed number of queries.

    Pass ``columns`` (the board's columns, in position order) when the caller
    already holds them. Hard-deleted cards are out by construction: this reads
    through ``Card``, and their retained movements have ``card`` NULL.

    ``cards_matching`` narrows which cards are loaded, each still with its whole
    history, for a caller that can prove the others cannot change its answer.
    """
    now = now or timezone.now()
    if columns is None:
        columns = list(Column.objects.filter(board=board).order_by("position"))
    done_uids = {c.uid for c in columns if c.is_done}

    selected = _base_cards(board, swimlane_id, label_id)
    if cards_matching is not None:
        selected = selected.filter(cards_matching)
    cards = [
        CardFlow(
            id=row["id"], uid=row["uid"], title=row["title"], swimlane_id=row["swimlane_id"],
            assignee_id=row["assignee_id"], created_at=row["created_at"],
            archived_at=row["archived_at"], blocked_at=row["blocked_at"],
            column_uid=row["column__uid"],
        )
        for row in selected.order_by("id").values(
            "id", "uid", "title", "swimlane_id", "assignee_id", "created_at",
            "archived_at", "blocked_at", "column__uid",
        )
    ]

    rows_by_card: dict[int, list] = {}
    movements = (
        CardMovement.objects.filter(card__in=selected.order_by().values("id"))
        .order_by("card_id", "moved_at", "id")
        .values_list(
            "card_id", "moved_at", "movement_type",
            "from_column_uid", "from_column__uid", "from_column_name",
            "to_column_uid", "to_column__uid", "to_column_name",
        )
    )
    for card_id, moved_at, kind, from_uid, from_fk, from_name, to_uid, to_fk, to_name in movements.iterator(
        chunk_size=2000,
    ):
        rows_by_card.setdefault(card_id, []).append(
            _Movement(
                moved_at, kind,
                _column_key(from_uid, from_fk, from_name),
                _column_key(to_uid, to_fk, to_name),
            )
        )
    for card in cards:
        _analyze_card(card, rows_by_card.get(card.id, []), done_uids, now)
    return BoardFlow(
        board=board, now=now, columns=columns, cards=cards,
        done_uids=done_uids, current_uids={c.uid for c in columns},
        swimlane_id=swimlane_id, label_id=label_id,
    )


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


def load_recent_dwell(board, flow_range, *, columns):
    """Only the cards current dwell or a visit closing in ``flow_range`` can come from.

    An open visit needs a live card outside a done column. A visit closes at a
    movement or at ``archived_at``, so a card with neither in the range has no
    visit closing in it. Finished work older than the range is therefore skipped.
    """
    moved = CardMovement.objects.filter(
        card=OuterRef("pk"), moved_at__gte=flow_range.start, moved_at__lte=flow_range.end,
    )
    relevant = (
        (Q(archived_at__isnull=True) & ~Q(column__is_done=True))
        | Q(archived_at__gte=flow_range.start)
        | Exists(moved)
    )
    return load_board_flow(board, now=flow_range.end, columns=columns, cards_matching=relevant)


def card_directory(flow, uids):
    """Who and what each uid in a response is: the drill-down's cards and owners.

    One query for the assignees; the rest was loaded with the cards. A response
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
        }
        for card in cards
    ]


# ── Durations ──────────────────────────────────────────────────────────────


def _duration_response(metric, samples, excluded):
    values = [s["value_days"] for s in samples]
    return {
        "definition": DEFINITIONS[metric],
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
        samples.append(
            _completion_sample(card, card.lead_start, _days_between(card.lead_start, card.completion_at))
        )
    samples.sort(key=lambda s: s["end"])
    return _duration_response("lead_time", samples, excluded)


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
                samples.append(
                    _completion_sample(card, card.cycle_start, _days_between(card.cycle_start, card.completion_at))
                )
        elif not (card.created_in_done or card.straight_to_done):
            # Left out only for its history. A card that would have no cycle
            # time anyway is not an exclusion.
            excluded += 1
    samples.sort(key=lambda s: s["end"])
    return _duration_response("cycle_time", samples, excluded)


def _column_entries(flow):
    return [c for c in flow.columns if not c.is_done]


def _dwell_response(flow, samples, excluded):
    per_column = {c.uid: [] for c in _column_entries(flow)}
    for sample in samples:
        if sample["column_uid"] in per_column:
            per_column[sample["column_uid"]].append(sample["value_days"])
    response = _duration_response("dwell_time", samples, excluded)
    response["columns"] = [
        {
            "column_uid": c.uid,
            "column_name": c.name,
            "sample_size": len(per_column[c.uid]),
            "percentiles": percentiles(per_column[c.uid]),
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
        samples.append({
            "card_uid": card.uid,
            "column_uid": flow.column_ref(visit.key),
            "value_days": value,
            "start": _iso(visit.start),
            "end": _iso(visit.end),
            "reopened": card.reopened_after(visit.end),
        })
    samples.sort(key=lambda s: s["end"])
    return _dwell_response(flow, samples, excluded)


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


def _dwell_by_column(flow, card):
    """The card's measured visits summed per column key, in order of first entry."""
    totals: dict[object, float] = {}
    for visit in card.visits:
        if visit.key in flow.done_uids or not visit.measured:
            continue
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
        ).values_list("to_card_id", flat=True)
    )
    return by_relation | {card.id for card in cards if card.blocked_at is not None}


def blocked_time(flow, flow_range):
    """Blocked time per column and the most common reasons, inside the range (#1149).

    ADR "Blocked time": reported as its own metric, never subtracted. One query
    over ``CardBlock`` (indexed by board). A block counts for the part of it that
    falls inside the range; an open block runs to now, or to ``archived_at`` while
    its card is archived (a restore clears ``archived_at``, so the block then runs
    to now again). An open block whose card was hard-deleted has no end anyone can
    observe, so it is left out rather than accruing time forever.

    Time is attributed to the column the card was in when it was blocked
    (``CardBlock.column``), falling back to the stored name for a column that was
    deleted and recreated. A block in a column that no longer exists still counts
    toward ``top_reasons``.

    Reasons are grouped case- and whitespace-insensitively, since the same cause
    typed twice ("Waiting on customer" / "waiting on customer ") is one cluster;
    the newest spelling is the one shown. Every end is clipped to now: an imported
    block can carry a future timestamp, and it must not inflate anyone's numbers.

    Rows are summed in Python rather than in SQL because of the reason clustering.
    The row count is the blocks overlapping the range on one board, which stays
    small next to the movement rows the same request already loaded.

    Under a swimlane or label filter only blocks of live cards it selects count:
    a hard-deleted card has no current swimlane or labels to match.
    """
    now = flow.now
    start = flow_range.start
    col_id_to_name = {c.id: c.name for c in flow.columns}
    col_names = set(col_id_to_name.values())
    seconds_per_column = {c.name: 0.0 for c in flow.columns}
    blocks_per_column = {c.name: 0 for c in flow.columns}
    reasons: dict[str, dict] = {}
    rows = (
        CardBlock.objects.filter(board=flow.board, blocked_at__lte=now)
        .filter(Q(unblocked_at__isnull=True) | Q(unblocked_at__gte=start))
        .exclude(card__isnull=True, unblocked_at__isnull=True)
    )
    if flow.swimlane_id is not None or flow.label_id is not None:
        rows = rows.filter(card__in=_base_cards(flow.board, flow.swimlane_id, flow.label_id).order_by().values("id"))
    for row in rows.order_by("-blocked_at", "-id").values(
        "column_id", "column_name", "reason", "blocked_at", "unblocked_at", "card__archived_at",
    ):
        end = min(row["unblocked_at"] or row["card__archived_at"] or now, now)
        begin = max(row["blocked_at"], start)
        if end <= begin:
            continue
        seconds = (end - begin).total_seconds()
        name = col_id_to_name.get(row["column_id"])
        if name is None and row["column_name"] in col_names:
            name = row["column_name"]
        if name is not None:
            seconds_per_column[name] += seconds
            blocks_per_column[name] += 1
        key = " ".join(row["reason"].split()).casefold()
        bucket = reasons.setdefault(key, {"reason": row["reason"].strip(), "count": 0, "seconds": 0.0})
        bucket["count"] += 1
        bucket["seconds"] += seconds
    top = sorted(reasons.values(), key=lambda r: (-r["count"], -r["seconds"], r["reason"]))
    return {
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
    for card in flow.cards:
        if card.archived_at is not None or card.column_uid in flow.done_uids:
            continue
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
            "dwell_by_column": _dwell_by_column(flow, card),
            # Additive to the ADR's sample for the drawer's blocked time and
            # the chart's square mark.
            "is_blocked": card.id in blocked,
            "blocked_days": blocked_seconds.get(card.id, 0.0) / SECONDS_PER_DAY,
        }
        for card in in_progress
    ]
    samples.sort(key=lambda s: (position.get(s["column_uid"], 0), -s["value_days"]))
    return {
        "definition": DEFINITIONS["age"],
        "sample_size": len(samples),
        "excluded_incomplete_history": excluded,
        "cycle_time_percentiles": cycle_time(flow, flow_range)["percentiles"],
        # Additive to the ADR's shape: the chart's x-axis, so an empty column
        # keeps its place and the client needs no second source of order.
        "columns": [{"column_uid": c.uid, "column_name": c.name} for c in _column_entries(flow)],
        "samples": samples,
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
    """Completions per whole UTC day or ISO week. Zero periods count toward the median."""
    periods = _periods(flow_range, period)
    index_of_day = {}
    for index, (first, last) in enumerate(periods):
        for offset in range((last - first).days + 1):
            index_of_day[first + datetime.timedelta(days=offset)] = index
    buckets: list[list] = [[] for _ in periods]
    completed = sorted(
        (card for card in flow.cards if card.completion_at is not None),
        key=lambda card: card.completion_at,
    )
    for card in completed:
        index = index_of_day.get(_utc_date(card.completion_at))
        if index is not None:
            buckets[index].append(card.uid)
    samples = [
        {"start": first.isoformat(), "count": len(uids), "card_uids": uids}
        for (first, _), uids in zip(periods, buckets)
    ]
    counts = sorted(len(uids) for uids in buckets)
    return {
        "definition": DEFINITIONS["throughput"],
        "period": period,
        "total": sum(counts),
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
    """The current not-done column that grew most across the window; earlier position wins a tie."""
    best, best_growth = None, 0
    for column in _column_entries(flow):
        growth = last_counts[column.uid] - first_counts[column.uid]
        if growth > best_growth:
            best, best_growth = column.uid, growth
    return best


def cumulative_flow(flow, flow_range):
    """Cards per column at the end of each whole UTC day, plus the bottleneck.

    Each card contributes one ``+1``/``-1`` pair per placement to a difference
    array, and one pass turns those into daily counts. So the cost grows with
    movements plus days × columns, never with days × cards (no per-day loop).
    """
    days = flow_range.days
    index = {day: i for i, day in enumerate(days)}
    bands = [c.uid for c in flow.columns] + [NULL_BAND_KEY]
    deltas = {band: [0] * (len(days) + 1) for band in bands}

    def to_index(day):
        if day <= flow_range.first_day:
            return 0
        return index.get(day, len(days))

    for card in flow.cards:
        stops = card.placements
        for i, (moment, placement) in enumerate(stops):
            if placement is _OFF_DIAGRAM:
                continue
            start = to_index(_utc_date(moment))
            end = to_index(_utc_date(stops[i + 1][0])) if i + 1 < len(stops) else len(days)
            if start < end:
                band = _band(flow, placement)
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
    return {
        "definition": DEFINITIONS["cumulative_flow"],
        "columns": _cfd_columns(flow),
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


def completed_dwell_by_swimlane(flow, flow_range):
    """Completed dwell grouped for the heatmap's Throughput mode."""
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
