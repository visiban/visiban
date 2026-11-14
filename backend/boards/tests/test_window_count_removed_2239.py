"""#2239: page queries no longer carry a Window(Count) total.

A window count is evaluated over every matching row before LIMIT/OFFSET, so
each page read the whole history behind it (measured on Postgres in the
#2239 MR). These pin, for the card list, the archived-cards page, the card
timeline and MCP's card page: no page query uses ``OVER (``; a short page
costs no COUNT; a full page costs exactly one bare COUNT; and the reported
totals are unchanged in every case (the response shapes are 1.x contracts).
"""
import datetime

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from boards.models import CardActivity, CardMovement
from boards.tests.conftest import _make_board, _make_card, _make_column, _make_swimlane, _make_user
from boards.views._helpers import fetch_page_and_total
from mcp_server import tools


def _sql(ctx):
    return [q["sql"] for q in ctx.captured_queries]


def _count_queries(ctx):
    return [s for s in _sql(ctx) if s.upper().startswith("SELECT COUNT(")]


class _Setup(TestCase):
    def setUp(self):
        self.user = _make_user()
        self.board = _make_board(self.user)
        self.col = _make_column(self.board)
        self.col2 = _make_column(self.board, name="Done", order=1)
        self.lane = _make_swimlane(self.board)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _get(self, url, params=None):
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(url, params or {})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse([s for s in _sql(ctx) if " OVER (" in s.upper()], "window count is back")
        return r, ctx


class CardListTests(_Setup):
    def setUp(self):
        super().setUp()
        for i in range(5):
            _make_card(self.col, self.lane, title=f"c{i}", position=i)
        self.url = f"/api/v1/boards/{self.board.pk}/cards/"

    def test_short_page_has_exact_total_and_no_count(self):
        r, ctx = self._get(self.url, {"limit": 10, "offset": 1})
        self.assertEqual(len(r.json()), 4)
        self.assertEqual(r["X-Total-Count"], "5")
        self.assertEqual(r["X-Truncated"], "false")
        self.assertEqual(_count_queries(ctx), [])

    def test_full_page_runs_one_bare_count(self):
        r, ctx = self._get(self.url, {"limit": 2, "offset": 1})
        self.assertEqual(len(r.json()), 2)
        self.assertEqual(r["X-Total-Count"], "5")
        self.assertEqual(r["X-Truncated"], "true")
        self.assertEqual(len(_count_queries(ctx)), 1)

    def test_offset_past_end_reports_real_total(self):
        r, _ = self._get(self.url, {"offset": 50})
        self.assertEqual(r.json(), [])
        self.assertEqual(r["X-Total-Count"], "5")


class ArchivedPageTests(_Setup):
    def setUp(self):
        super().setUp()
        now = timezone.now()
        for i in range(3):
            _make_card(self.col, self.lane, title=f"a{i}", position=i,
                       archived_at=now - datetime.timedelta(minutes=i))
        self.url = f"/api/v1/boards/{self.board.pk}/cards/archived/"

    def test_short_page_total_without_count(self):
        r, ctx = self._get(self.url)
        body = r.json()
        self.assertEqual(set(body), {"count", "offset", "page_size", "results"})
        self.assertEqual(body["count"], 3)
        self.assertEqual(len(body["results"]), 3)
        self.assertEqual(_count_queries(ctx), [])

    def test_offset_past_end_counts(self):
        r, ctx = self._get(self.url, {"offset": 10})
        self.assertEqual(r.json()["count"], 3)
        self.assertEqual(len(_count_queries(ctx)), 1)


class TimelineTests(_Setup):
    def setUp(self):
        super().setUp()
        self.card = _make_card(self.col, self.lane)
        now = timezone.now()
        CardMovement.objects.bulk_create([
            CardMovement(card=self.card, from_column=self.col, to_column=self.col2,
                         moved_by=self.user, moved_at=now - datetime.timedelta(minutes=i))
            for i in range(4)
        ])
        CardActivity.objects.bulk_create([
            CardActivity(card=self.card, event_type="title_change", from_value="a",
                         to_value="b", actor=self.user)
            for _ in range(3)
        ])
        self.url = f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/timeline/"

    def test_short_sources_need_no_count(self):
        r, ctx = self._get(self.url)
        self.assertEqual(r.json()["count"], 7)
        self.assertEqual(_count_queries(ctx), [])

    def test_full_sources_count_each_once(self):
        r, ctx = self._get(self.url, {"limit": 2})
        body = r.json()
        self.assertEqual(body["count"], 7)
        self.assertEqual(len(body["results"]), 2)
        self.assertEqual(len(_count_queries(ctx)), 2)

    def test_limit_zero_still_reports_total(self):
        r, _ = self._get(self.url, {"limit": 0})
        self.assertEqual(r.json()["count"], 7)


class McpCardsPageTests(_Setup):
    def test_page_and_total(self):
        for i in range(5):
            _make_card(self.col, self.lane, title=f"m{i}", position=i)
        with CaptureQueriesContext(connection) as ctx:
            rows, total = tools._cards_page(self.board, limit=2, offset=0)
        self.assertFalse([s for s in _sql(ctx) if " OVER (" in s.upper()])
        self.assertEqual((len(rows), total), (2, 5))
        rows, total = tools._cards_page(self.board, limit=10, offset=3)
        self.assertEqual((len(rows), total), (2, 5))
        rows, total = tools._cards_page(self.board, limit=10, offset=9)
        self.assertEqual((rows, total), ([], 5))


class HelperTests(_Setup):
    def test_empty_first_page_is_zero_without_count(self):
        qs = CardActivity.objects.none().order_by("pk")
        self.assertEqual(fetch_page_and_total(qs, 0, 10), ([], 0))

    def test_limit_zero_counts(self):
        _make_card(self.col, self.lane)
        from boards.models import Card
        qs = Card.objects.filter(board=self.board).order_by("pk")
        with CaptureQueriesContext(connection) as ctx:
            rows, total = fetch_page_and_total(qs, 0, 0)
        self.assertEqual((rows, total), ([], 1))
        self.assertEqual(len(ctx.captured_queries), 1)
