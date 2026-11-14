"""#1963: card activities/comments/attachments GET take opt-in limit/offset.

The 1.0 response (every row, bare array) is unchanged without params and the
web app reads it that way; the paging params and the X-Total-Count /
X-Truncated headers are additive. MCP's ``card://`` resource caps its
activities and comments and flags the cap.
"""
from unittest import mock

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from boards.models import CardActivity, CardAttachment, CardComment
from boards.tests.conftest import (
    _make_board, _make_card, _make_column, _make_membership, _make_swimlane, _make_user,
)
from mcp_server import tools
from mcp_server.context import reset_current_user, set_current_user


class _Setup(TestCase):
    N = 5

    def setUp(self):
        self.owner = _make_user()
        self.board = _make_board(self.owner)
        self.card = _make_card(_make_column(self.board), _make_swimlane(self.board))
        self.viewer = _make_user()
        _make_membership(self.board, self.viewer, role="viewer")
        CardActivity.objects.bulk_create([
            CardActivity(card=self.card, event_type="title_change", from_value=str(i),
                         to_value=str(i + 1), actor=self.owner)
            for i in range(self.N)
        ])
        CardComment.objects.bulk_create([
            CardComment(card=self.card, author=self.owner, body=f"c{i}") for i in range(self.N)
        ])
        CardAttachment.objects.bulk_create([
            CardAttachment(card=self.card, file=f"attachments/f{i}.txt", filename=f"f{i}.txt",
                           size=1, uploaded_by=self.owner)
            for i in range(self.N)
        ])
        self.client = APIClient()
        self.client.force_authenticate(self.viewer)
        base = f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}"
        self.urls = {
            "activities": f"{base}/activities/",
            "comments": f"{base}/comments/",
            "attachments": f"{base}/attachments/",
        }


class CardHistoryPagingTests(_Setup):
    def test_default_returns_every_row_with_headers(self):
        for name, url in self.urls.items():
            with self.subTest(name):
                r = self.client.get(url)
                self.assertEqual(r.status_code, 200)
                self.assertIsInstance(r.json(), list)
                self.assertEqual(len(r.json()), self.N)
                self.assertEqual(r["X-Total-Count"], str(self.N))
                self.assertEqual(r["X-Truncated"], "false")

    def test_limit_offset_walk_neither_skips_nor_repeats(self):
        for name, url in self.urls.items():
            with self.subTest(name):
                full = [row["id"] for row in self.client.get(url).json()]
                walked = []
                for offset in range(0, self.N, 2):
                    r = self.client.get(url, {"limit": 2, "offset": offset})
                    self.assertEqual(r["X-Total-Count"], str(self.N))
                    self.assertEqual(r["X-Truncated"], "true" if offset + 2 < self.N else "false")
                    walked += [row["id"] for row in r.json()]
                self.assertEqual(walked, full)

    def test_order_matches_documented_direction(self):
        ids = {n: [row["id"] for row in self.client.get(u).json()] for n, u in self.urls.items()}
        self.assertEqual(ids["comments"], sorted(ids["comments"]))  # oldest first (ties by id)
        self.assertEqual(ids["activities"], sorted(ids["activities"], reverse=True))
        self.assertEqual(ids["attachments"], sorted(ids["attachments"], reverse=True))

    def test_limit_is_clamped_to_200(self):
        r = self.client.get(self.urls["activities"], {"limit": 10**30})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.json()), self.N)

    def test_bad_limit_is_coded_400(self):
        for name, url in self.urls.items():
            with self.subTest(name):
                r = self.client.get(url, {"limit": "abc"})
                self.assertEqual(r.status_code, 400)
                self.assertEqual(r.json()["code"], "invalid_query_param")

    def test_non_member_gets_404_before_param_validation(self):
        stranger = APIClient()
        stranger.force_authenticate(_make_user())
        for name, url in self.urls.items():
            with self.subTest(name):
                self.assertEqual(stranger.get(url, {"limit": "abc"}).status_code, 404)

    def test_offset_past_end_reports_total(self):
        r = self.client.get(self.urls["comments"], {"offset": 50})
        self.assertEqual(r.json(), [])
        self.assertEqual(r["X-Total-Count"], str(self.N))
        self.assertEqual(r["X-Truncated"], "false")

    def test_query_counts(self):
        # The default read stays one list query (no COUNT) and does not grow
        # with the row count; a full limited page adds exactly one COUNT.
        def run(url, params=None):
            with CaptureQueriesContext(connection) as ctx:
                self.assertEqual(self.client.get(url, params or {}).status_code, 200)
            sql = [q["sql"] for q in ctx.captured_queries]
            return len(sql), sum(s.upper().startswith("SELECT COUNT(") for s in sql)

        for name, url in self.urls.items():
            with self.subTest(name):
                base, counts = run(url)
                self.assertEqual(counts, 0)
                self.assertEqual(run(url, {"limit": 10}), (base, 0))
                self.assertEqual(run(url, {"limit": 2}), (base + 1, 1))
                CardActivity.objects.create(card=self.card, event_type="title_change", actor=self.owner)
                CardComment.objects.create(card=self.card, author=self.owner, body="more")
                self.assertEqual(run(url)[0], base)

    def test_schema_publishes_params_and_headers(self):
        from drf_spectacular.generators import SchemaGenerator

        schema = SchemaGenerator().get_schema(request=None, public=True)
        for name in ("activities", "comments", "attachments"):
            with self.subTest(name):
                op = schema["paths"][f"/api/v1/boards/{{board_pk}}/cards/{{id}}/{name}/"]["get"]
                self.assertTrue({"limit", "offset"} <= {p["name"] for p in op["parameters"]})
                self.assertIn("X-Total-Count", op["responses"]["200"]["headers"])
                self.assertIn("X-Truncated", op["responses"]["200"]["headers"])
                self.assertEqual(op["responses"]["200"]["content"]["application/json"]["schema"]["type"], "array")


class McpCardDetailCapTests(_Setup):
    def _detail(self):
        token = set_current_user(self.viewer)
        try:
            return tools.card_detail(card_id=self.card.pk)
        finally:
            reset_current_user(token)

    def test_under_cap_is_complete_and_flagged_false(self):
        data = self._detail()
        self.assertEqual(len(data["activities"]), self.N)
        self.assertEqual(len(data["comments"]), self.N)
        self.assertIs(data["activities_truncated"], False)
        self.assertIs(data["comments_truncated"], False)

    def test_over_cap_keeps_newest_and_flags(self):
        with mock.patch.object(tools, "_CARD_DETAIL_HISTORY_MAX", 3):
            data = self._detail()
        self.assertIs(data["activities_truncated"], True)
        self.assertIs(data["comments_truncated"], True)
        act_ids = sorted(CardActivity.objects.filter(card=self.card).values_list("id", flat=True))
        com_ids = sorted(CardComment.objects.filter(card=self.card).values_list("id", flat=True))
        self.assertEqual([a["id"] for a in data["activities"]], act_ids[::-1][:3])
        # Newest three comments, still oldest first.
        self.assertEqual([c["id"] for c in data["comments"]], com_ids[-3:])
