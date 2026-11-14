"""Movements history paging without a window count, and date range filters (#1961).

The response shape and the inclusive date semantics must not change: counts are
exact on every page, and ``moved_before`` includes the whole end day.
"""
import datetime

from django.db import connection
from django.test import override_settings
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from boards.models import CardMovement
from boards.tests.test_analytics_history import AnalyticsHistorySetup


def _at(day, hour, minute=0, second=0, microsecond=0):
    return datetime.datetime(
        day.year, day.month, day.day, hour, minute, second, microsecond,
        tzinfo=datetime.timezone.utc,
    )


class MovementsHistoryPagingTests(AnalyticsHistorySetup):
    def _movement(self, moved_at):
        mv = CardMovement.objects.create(
            card=self.card, board=self.board,
            from_column=None, to_column=self.col_todo,
            from_swimlane=None, to_swimlane=self.swimlane,
            moved_by=self.admin,
        )
        CardMovement.objects.filter(pk=mv.pk).update(moved_at=moved_at)
        return mv

    def _get(self, **params):
        resp = self._client_for(self.member).get(self._movements_url(), params)
        self.assertEqual(resp.status_code, 200, resp.content)
        return resp.data

    def test_count_is_exact_on_every_page(self):
        base = timezone.now() - datetime.timedelta(days=1)
        for i in range(120):
            self._movement(base - datetime.timedelta(minutes=i))
        # Full pages, a short last page, an exact-boundary offset, and past the end.
        for offset, expected_len in ((0, 50), (50, 50), (100, 20), (120, 0), (500, 0)):
            data = self._get(offset=offset)
            self.assertEqual(data["count"], 120, f"offset={offset}")
            self.assertEqual(len(data["results"]), expected_len, f"offset={offset}")
            self.assertEqual(data["offset"], offset)
            self.assertEqual(data["page_size"], 50)

    def test_count_respects_filters_not_just_board(self):
        base = timezone.now() - datetime.timedelta(days=1)
        for i in range(7):
            self._movement(base - datetime.timedelta(minutes=i))
        data = self._get(to_column_id=self.col_done.pk)
        self.assertEqual(data["count"], 0)
        self.assertEqual(data["results"], [])
        self.assertEqual(self._get(swimlane_id=self.swimlane.pk)["count"], 7)

    def test_empty_board_history(self):
        data = self._get()
        self.assertEqual((data["count"], data["results"]), (0, []))

    def test_page_query_has_no_window_function(self):
        for i in range(3):
            self._movement(timezone.now() - datetime.timedelta(hours=i + 1))
        with CaptureQueriesContext(connection) as ctx:
            self._get()
        self.assertFalse(
            any("OVER (" in q["sql"].upper() for q in ctx.captured_queries),
            [q["sql"] for q in ctx.captured_queries],
        )

    def test_date_filters_are_range_filters_not_casts(self):
        self._movement(timezone.now())
        with CaptureQueriesContext(connection) as ctx:
            self._get(moved_after="2020-01-01", moved_before="2099-01-01")
        movement_sql = [
            q["sql"] for q in ctx.captured_queries if "card_movements" in q["sql"].lower()
        ]
        self.assertTrue(movement_sql)
        for sql in movement_sql:
            self.assertNotIn("django_datetime_cast_date", sql)
            self.assertNotRegex(sql.upper(), r"DATE\(\"?BOARDS_CARDMOVEMENT\"?\.\"?MOVED_AT")

    def test_date_boundaries_are_inclusive_both_ends(self):
        day = datetime.date(2026, 3, 10)
        inside = [
            self._movement(_at(day, 0, 0, 0)),                       # first instant of start day
            self._movement(_at(day, 23, 59, 59, 999999)),            # last instant of day
        ]
        before = self._movement(_at(day - datetime.timedelta(days=1), 23, 59, 59, 999999))
        after = self._movement(_at(day + datetime.timedelta(days=1), 0, 0, 0))

        data = self._get(moved_after=day.isoformat(), moved_before=day.isoformat())
        ids = {r["id"] for r in data["results"]}
        self.assertEqual(ids, {m.pk for m in inside})
        self.assertEqual(data["count"], 2)

        only_after = {r["id"] for r in self._get(moved_after=day.isoformat())["results"]}
        self.assertEqual(only_after, {m.pk for m in inside} | {after.pk})
        only_before = {r["id"] for r in self._get(moved_before=day.isoformat())["results"]}
        self.assertEqual(only_before, {m.pk for m in inside} | {before.pk})

    @override_settings(TIME_ZONE="America/New_York")
    def test_date_boundaries_follow_the_current_time_zone(self):
        # 2026-03-10 02:30 UTC is still 2026-03-09 in New York (EDT, UTC-4).
        mv = self._movement(_at(datetime.date(2026, 3, 10), 2, 30))
        hit = self._get(moved_after="2026-03-09", moved_before="2026-03-09")
        self.assertEqual([r["id"] for r in hit["results"]], [mv.pk])
        miss = self._get(moved_after="2026-03-10", moved_before="2026-03-10")
        self.assertEqual(miss["count"], 0)

    def test_extreme_dates_do_not_error(self):
        self._movement(timezone.now())
        self.assertEqual(self._get(moved_before="9999-12-31")["count"], 1)
        self.assertEqual(self._get(moved_after="0001-01-01")["count"], 1)
