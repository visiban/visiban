"""Cumulative flow reads only the rows that decide a card's placement (#2444).

#2425 bounded the range metrics, but cumulative flow still streamed every
skipped card's whole history to find where it rests, and the ``?date=``
drill-down still loaded the board's whole history. Both now read, per card,
only the rows ``_replay_placements`` can depend on (``_deciding_rows``): the
first row, the last transition and the last archive-type row (plus, for a
drill-down day, the last archive-type row after that day). These tests pin:

* the reduction itself, in pure Python, on thousands of seeded histories
  (``_reduce_history`` against the full replay, at the end and at every day);
* the SQL mirror of the column key against Python's, on every combination of
  uid snapshot, FK and name snapshot, and that the SQL picks exactly the rows
  the Python reduction does;
* the bound (at most three rows per card, four with ``as_of``) and the view's
  use of ``load_cumulative_day``.

The endpoint byte-equality differential lives in
``test_flow_range_narrowing_2425.RangeNarrowingEquivalenceTests``.
"""
import datetime
import random
from unittest import mock

from boards.models import Card, CardMovement, Column
from boards.services import flow_metrics as fm
from boards.tests.test_flow_metrics import ARCHIVED, MOVE, UNARCHIVED, FlowFixture
from boards.tests.test_flow_range_narrowing_2425 import AgedBoardMixin

_UTC = datetime.timezone.utc
NOW = datetime.datetime(2026, 7, 15, 12, 0, tzinfo=_UTC)
SPAN_DAYS = 14


def _reduce_history(live, as_of=None):
    """The rows ``_deciding_rows`` must return for ``live`` (rows up to now, in ``(moved_at, id)`` order).

    Written independently of the SQL: the first row, the last transition
    (before ``as_of``), the last archive-type row before ``as_of``, and with
    ``as_of`` the last archive-type row at or after it.
    """
    if not live:
        return []
    keep = {0}
    last = {}
    for i, mv in enumerate(live):
        before = as_of is None or mv.moved_at < as_of
        if mv.is_transition and before:
            last["T"] = i
        elif mv.movement_type in (ARCHIVED, UNARCHIVED):
            last["A" if before else "Z"] = i
    keep.update(last.values())
    return [live[i] for i in sorted(keep)]


def _at_day_end(placements, day):
    """``cumulative_flow_cards``'s read: the last placement dated on or before ``day``."""
    result = None
    for moment, placement in placements:
        if fm._utc_date(moment) <= day:
            result = placement
    return result


def _stub(created_at, archived_at, column_uid):
    return fm.CardFlow(
        id=1, uid="", title="", swimlane_id=0, assignee_id=None, created_at=created_at,
        archived_at=archived_at, blocked_at=None, column_uid=column_uid,
    )


def _placements(stub, live, done_uids):
    return fm._replay_placements(stub, live, fm._creation_row(live), done_uids, NOW)


# Column keys as Python builds them: plain uids, a name-only key (a deleted
# column), a name-only key spelled like a live uid, and unknown.
_UIDS = ["c-backlog", "c-doing", "c-review", "c-done", "c-shipped"]
_DONE = {"c-done", "c-shipped"}
_KEYS = [*_UIDS, fm._NameKey("Old"), fm._NameKey("c-doing"), None]


def _moment(rnd):
    """A moment in the span, often tied: a few days, a few hours, the odd one after NOW (misdated)."""
    if rnd.random() < 0.05:
        return NOW + datetime.timedelta(hours=rnd.choice([1, 30]))
    day = rnd.choice([0, 1, 2, 2, 3, 5, 5, 8, 13])
    hour = rnd.choice([0, 6, 6, 23])
    return NOW - datetime.timedelta(days=day, hours=hour)


def _random_history(rnd, consistent):
    """One card: ``(stub, live rows)``. ``consistent`` follows the #1532 generator, else #448's."""
    rows = []
    at = rnd.choice(_KEYS) if consistent else None
    for _ in range(rnd.randint(0, 8)):
        kind = rnd.choices([MOVE, ARCHIVED, UNARCHIVED], [6, 1, 1])[0]
        target = rnd.choice(_KEYS)
        source = at if (consistent or rnd.random() < 0.9) else rnd.choice(_KEYS)
        if kind == MOVE and rnd.random() < 0.15:
            # A swimlane-only move (from == to), often not where the card is.
            source = target = rnd.choice(_KEYS)
        rows.append((_moment(rnd), kind, source, target))
        if target is not None:
            at = target
    # Ids in any order relative to moved_at, as imports and queryset updates allow.
    ids = rnd.sample(range(1, 1000), len(rows))
    movements = sorted(
        (fm._Movement(moment, kind, source, target, None, movement_id) for (moment, kind, source, target), movement_id
         in zip(rows, ids)),
        key=lambda mv: (mv.moved_at, mv.id),
    )
    # A creation row first, sometimes.
    if movements and rnd.random() < 0.5:
        first = movements[0]
        movements[0] = first._replace(movement_type=MOVE, from_key=None, to_key=rnd.choice(_UIDS))
    live, _ = fm._live_rows(movements, NOW)
    created_at = rnd.choice([_moment(rnd), NOW - datetime.timedelta(days=20)])
    archived_at = None
    roll = rnd.random()
    if roll < 0.3:
        archived_at = _moment(rnd)  # anywhere, after a later movement or after NOW included
    elif roll < 0.4 and live:
        # Tied with a row: an admin archived_at at the moment of an archive-type row.
        archived_at = rnd.choice(live).moved_at
    stub = _stub(created_at, archived_at, rnd.choice(_UIDS))
    return stub, live


class ReductionTests(FlowFixture):
    """``_reduce_history`` decides the same placements as the whole history (pure Python)."""

    def assert_reduction_holds(self, seed, consistent, histories=3000):
        rnd = random.Random(seed)
        days = [(NOW - datetime.timedelta(days=d)).date() for d in range(SPAN_DAYS, 0, -1)]
        exercised = 0
        for n in range(histories):
            stub, live = _random_history(rnd, consistent)
            full = _placements(stub, live, _DONE)
            reduced = _reduce_history(live)
            self.assertLessEqual(len(reduced), 3)
            self.assertEqual(full[-1][1], _placements(stub, reduced, _DONE)[-1][1], (seed, n))
            for day in days:
                as_of = fm._midnight(day + datetime.timedelta(days=1))
                on_day = _reduce_history(live, as_of)
                self.assertLessEqual(len(on_day), 4)
                # _OFF_DIAGRAM compares by identity, so assertEqual covers it too.
                self.assertEqual(
                    _at_day_end(full, day), _at_day_end(_placements(stub, on_day, _DONE), day), (seed, n, day),
                )
            exercised += len(live) > len(reduced)
        self.assertGreater(exercised, histories // 4, "too few histories had rows to drop")

    def test_consistent_histories_1532(self):
        self.assert_reduction_holds(1532, consistent=True)

    def test_inconsistent_histories_448(self):
        self.assert_reduction_holds(448, consistent=False)

    def test_an_archived_row_after_an_admin_archived_at_suppresses_it_on_an_earlier_day(self):
        """The fourth row: an ``archived`` event after day D means no synthetic archive on or before D."""
        day3 = NOW - datetime.timedelta(days=3)
        live = [
            fm._Movement(NOW - datetime.timedelta(days=10), MOVE, None, "c-doing", None, 1),
            fm._Movement(day3, UNARCHIVED, "c-doing", "c-doing", None, 2),
            fm._Movement(NOW - datetime.timedelta(days=1), ARCHIVED, "c-doing", "c-doing", None, 3),
        ]
        stub = _stub(NOW - datetime.timedelta(days=10), NOW - datetime.timedelta(days=5), "c-doing")
        day = (NOW - datetime.timedelta(days=4)).date()
        as_of = fm._midnight(day + datetime.timedelta(days=1))
        full = _at_day_end(_placements(stub, live, _DONE), day)
        self.assertEqual(full, "c-doing")
        self.assertEqual(_at_day_end(_placements(stub, _reduce_history(live, as_of), _DONE), day), full)
        # Without the row after D the admin archived_at would take the card off the diagram.
        without = [mv for mv in _reduce_history(live, as_of) if mv.id != 3]
        self.assertIs(_at_day_end(_placements(stub, without, _DONE), day), fm._OFF_DIAGRAM)


class SqlKeyTests(FlowFixture):
    """``_sql_column_key`` and ``kind`` agree with Python, and ``_deciding_rows`` picks ``_reduce_history``'s rows."""

    def build_corpus(self, seed=2444, cards=80):
        rnd = random.Random(seed)
        gone = Column.objects.create(board=self.board, name="Gone", position=8)
        blank = Column.objects.create(board=self.board, name="Blank", position=9)
        Column.objects.filter(pk=blank.pk).update(uid="")
        blank.refresh_from_db()
        # A column named like another column's uid.
        Column.objects.create(board=self.board, name=self.doing.uid, position=10)
        live_columns = [self.backlog, self.doing, self.done]
        uids = ["", self.backlog.uid, self.doing.uid, self.done.uid, gone.uid]
        fks = [None, self.backlog, self.doing, self.done, blank, gone]
        names = ["", "Doing", "Gone", "Old", self.doing.uid, self.backlog.uid]

        def side():
            return {"uid": rnd.choice(uids), "fk": rnd.choice(fks), "name": rnd.choice(names)}

        for _ in range(cards):
            card = self.card(rnd.choice(live_columns), created=rnd.randint(0, 12))
            for _ in range(rnd.randint(0, 7)):
                src, dst = side(), side()
                if rnd.random() < 0.15:
                    dst = src
                mv = CardMovement.objects.create(
                    card=card, from_column=src["fk"], from_column_uid=src["uid"], from_column_name=src["name"],
                    to_column=dst["fk"], to_column_uid=dst["uid"], to_column_name=dst["name"],
                    to_swimlane=card.swimlane, moved_by=self.user,
                    movement_type=rnd.choices([MOVE, ARCHIVED, UNARCHIVED], [6, 1, 1])[0],
                )
                moment = self.ago(rnd.choice([1, 2, 2, 3, 5, 8, 0.5, -1]))
                CardMovement.objects.filter(pk=mv.pk).update(moved_at=moment)
            if rnd.random() < 0.3:
                Card.objects.filter(pk=card.pk).update(archived_at=self.ago(rnd.randint(0, 12)))
        gone.delete()

    def full_histories(self):
        histories = {}
        for card_id, mv in fm._movement_rows(Card.objects.filter(board=self.board)):
            histories.setdefault(card_id, []).append(mv)
        return {card_id: fm._live_rows(rows, self.now)[0] for card_id, rows in histories.items()}

    def test_sql_key_mirrors_python_key_on_every_row(self):
        self.build_corpus()
        python = {
            mv.id: mv for rows in self.full_histories().values() for mv in rows
        }
        annotated = fm._movement_kinds(CardMovement.objects.filter(card__board=self.board, moved_at__lte=self.now), None)
        to_sql: dict = {}
        to_python: dict = {}
        transitions = 0
        for movement_id, from_key, to_key, kind in annotated.values_list("id", "from_key", "to_key", "kind"):
            mv = python[movement_id]
            for py_key, sql_key in ((mv.from_key, from_key), (mv.to_key, to_key)):
                self.assertEqual(py_key is None, sql_key is None, movement_id)
                # One SQL key per Python key and back: equality means the same on both sides.
                self.assertEqual(to_sql.setdefault(py_key, sql_key), sql_key, (movement_id, py_key))
                self.assertEqual(to_python.setdefault(sql_key, py_key), py_key, (movement_id, sql_key))
            self.assertEqual(kind == "T", mv.is_transition, movement_id)
            if mv.movement_type in (ARCHIVED, UNARCHIVED):
                self.assertEqual(kind, "A", movement_id)
            transitions += mv.is_transition
        self.assertGreater(transitions, 20)
        # The corpus reached a name key spelled like a uid, and both kinds of key.
        self.assertIn(fm._NameKey(self.doing.uid), to_sql)
        self.assertIn(self.doing.uid, to_sql)

    def test_deciding_rows_are_the_python_reduction(self):
        self.build_corpus()
        histories = self.full_histories()
        cards = Card.objects.filter(board=self.board)
        for as_of in (None, *(fm._midnight(self.ago(d).date()) for d in (0, 1, 2, 3, 5, 9))):
            with self.subTest(as_of=as_of):
                got = {card_id: [mv.id for mv in rows] for card_id, rows in fm._deciding_rows(cards, now=self.now, as_of=as_of)}
                want = {
                    card_id: [mv.id for mv in _reduce_history(rows, as_of)]
                    for card_id, rows in histories.items() if rows
                }
                self.assertEqual(got, want)


class BoundedReadTests(AgedBoardMixin, FlowFixture):
    def test_at_most_three_rows_per_card_and_four_with_as_of(self):
        self.aged_board()
        cards = Card.objects.filter(board=self.board)
        full_rows = CardMovement.objects.filter(card__board=self.board).count()
        rows = dict(fm._deciding_rows(cards, now=self.now))
        self.assertTrue(rows)
        self.assertLessEqual(max(len(history) for history in rows.values()), 3)
        self.assertLess(sum(len(history) for history in rows.values()), full_rows)
        as_of = fm._midnight(self.ago(200).date())
        on_day = dict(fm._deciding_rows(cards, now=self.now, as_of=as_of))
        self.assertLessEqual(max(len(history) for history in on_day.values()), 4)
        for history in (*rows.values(), *on_day.values()):
            self.assertEqual(history, sorted(history, key=lambda mv: (mv.moved_at, mv.id)))
            self.assertTrue(all(mv.moved_at <= self.now for mv in history))

    def test_cumulative_day_matches_the_full_load_on_the_aged_board(self):
        self.aged_board()
        full = fm.load_board_flow(self.board, now=self.now)
        for days_ago in (1, 2, 89, 90, 91, 125, 130, 131, 300, 340, 350, 1149, 1150, 1151):
            day = self.ago(days_ago).date()
            with self.subTest(day=day):
                self.assertEqual(
                    fm.cumulative_flow_cards(fm.load_cumulative_day(self.board, day, now=self.now), day, zone=_UTC),
                    fm.cumulative_flow_cards(full, day, zone=_UTC),
                )


class DayViewLoaderTests(AgedBoardMixin, FlowFixture):
    def test_the_date_drill_down_loads_through_load_cumulative_day_only(self):
        """A view reverting to the whole-history load would still give the same bytes, so pin the call."""
        from django.utils import timezone
        from rest_framework.test import APIClient

        self.now = timezone.now()
        self.aged_board()
        client = APIClient()
        client.force_authenticate(self.user)
        day = (self.now - datetime.timedelta(days=30)).date().isoformat()
        with (
            mock.patch.object(fm, "load_cumulative_day", wraps=fm.load_cumulative_day) as day_loader,
            mock.patch.object(fm, "load_board_flow", wraps=fm.load_board_flow) as full_loader,
        ):
            resp = client.get(f"/api/v1/boards/{self.board.pk}/metrics/cumulative-flow/", {"date": day})
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(day_loader.call_count, 1)
        self.assertEqual(full_loader.call_count, 0)
