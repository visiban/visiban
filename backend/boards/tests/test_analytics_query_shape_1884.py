"""Analytics loads cards narrowly and its query count does not grow with cards (#1884)."""
import datetime
import json
from unittest import mock

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, CardMovement, Column, Swimlane

NOW = datetime.datetime(2026, 11, 1, 12, 0, tzinfo=datetime.timezone.utc)


class AnalyticsQueryShapeTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u1884", password="pw")
        self.board = Board.objects.create(name="B", owner=self.user, staleness_threshold_days=7)
        BoardMembership.objects.create(board=self.board, user=self.user, role="viewer")
        self.todo = Column.objects.create(board=self.board, name="To Do", position=0)
        self.doing = Column.objects.create(board=self.board, name="Doing", position=1)
        self.done = Column.objects.create(board=self.board, name="Done", position=2, is_done=True)
        self.lanes = [Swimlane.objects.create(board=self.board, name=n, position=i) for i, n in enumerate("AB")]
        self.client = APIClient()
        self.client.force_authenticate(user=self.user)
        self.url = f"/api/v1/boards/{self.board.pk}/analytics/?days=30"

    def _move(self, card, col, days_ago):
        move = CardMovement.objects.create(
            card=card, from_column=None, to_column=col,
            from_column_name="", to_column_name=col.name, from_column_uid="", to_column_uid=col.uid,
            from_swimlane_name="", to_swimlane_name=card.swimlane.name,
            from_swimlane_uid="", to_swimlane_uid=card.swimlane.uid, moved_by=self.user,
        )
        CardMovement.objects.filter(pk=move.pk).update(moved_at=NOW - datetime.timedelta(days=days_ago))

    def _card(self, lane, title, path, archived_days_ago=None):
        """``path`` is [(column, days_ago), ...] oldest first; the card ends in the last column."""
        card = Card.objects.create(
            board=self.board, column=path[-1][0], swimlane=lane, title=title,
            description="long " * 200, created_by=self.user, position=0,
        )
        CardMovement.objects.filter(card=card).delete()
        for col, days_ago in path:
            self._move(card, col, days_ago)
        updates = {"created_at": NOW - datetime.timedelta(days=60)}
        if archived_days_ago is not None:
            updates["archived_at"] = NOW - datetime.timedelta(days=archived_days_ago)
        Card.objects.filter(pk=card.pk).update(**updates)
        return card

    def _fixture(self):
        a, b = self.lanes
        self._card(a, "a1", [(self.todo, 20), (self.doing, 12)])
        self._card(a, "a2", [(self.todo, 50), (self.doing, 40), (self.done, 5)])
        self._card(b, "b1", [(self.todo, 3)])
        self._card(b, "b2", [(self.doing, 90)])
        self._card(b, "b3", [(self.todo, 25), (self.doing, 15)], archived_days_ago=2)

    def _get(self):
        with mock.patch.object(timezone, "now", return_value=NOW):
            return self.client.get(self.url)

    def test_response_is_pinned_for_a_fixture_board(self):
        self._fixture()
        r = self._get()
        self.assertEqual(r.status_code, 200)
        body = json.loads(r.content)
        for lane in body["swimlanes"]:
            lane.pop("id")
            for c in lane["stalled_cards"]:
                c.pop("id")
                c.pop("uid")
        self.assertEqual(body["swimlanes"], PINNED_SWIMLANES)
        self.assertEqual(body["board_medians"], PINNED_MEDIANS)

    def _count_queries(self):
        with CaptureQueriesContext(connection) as ctx:
            r = self._get()
        self.assertEqual(r.status_code, 200)
        return ctx

    def test_query_count_does_not_scale_with_cards(self):
        self._fixture()
        small = len(self._count_queries())
        for i in range(10):
            self._card(self.lanes[i % 2], f"extra{i}", [(self.todo, 10), (self.doing, 4)])
        ctx = self._count_queries()
        self.assertEqual(len(ctx), small)

    def test_card_query_does_not_load_description(self):
        self._fixture()
        ctx = self._count_queries()
        card_selects = [q["sql"] for q in ctx.captured_queries if '"cards"."title"' in q["sql"]]
        self.assertTrue(card_selects)
        for sql in card_selects:
            self.assertNotIn('"cards"."description"', sql)

PINNED_SWIMLANES = [{'age_avg_days_per_column': {'Doing': None, 'To Do': None}, 'age_heat_level': {'Doing': None, 'To Do': None}, 'age_is_outlier': {'Doing': False, 'To Do': False}, 'age_is_warning': {'Doing': False, 'To Do': False}, 'age_wait_avg_days_per_column': {}, 'avg_days_per_column': {'Doing': 18.5, 'To Do': 8.0}, 'deal_velocity_days': 26.5, 'is_outlier': {'Doing': True, 'To Do': True}, 'name': 'A', 'stalled_cards': [{'days_since_move': 12, 'days_since_move_exact': 12.0, 'title': 'a1'}], 'throughput_avg_days_per_column': {'Doing': None, 'To Do': None}, 'throughput_card_count_per_column': {'Doing': 0, 'To Do': 0}, 'throughput_heat_level': {'Doing': None, 'To Do': None}, 'throughput_is_outlier': {'Doing': False, 'To Do': False}, 'throughput_is_warning': {'Doing': False, 'To Do': False}, 'throughput_wait_avg_days_per_column': {}}, {'age_avg_days_per_column': {'Doing': 90.0, 'To Do': 3.0}, 'age_heat_level': {'Doing': 'high', 'To Do': 'ok'}, 'age_is_outlier': {'Doing': True, 'To Do': False}, 'age_is_warning': {'Doing': False, 'To Do': False}, 'age_wait_avg_days_per_column': {}, 'avg_days_per_column': {'Doing': 21.5, 'To Do': 6.5}, 'deal_velocity_days': 10.0, 'is_outlier': {'Doing': True, 'To Do': False}, 'name': 'B', 'stalled_cards': [{'days_since_move': 90, 'days_since_move_exact': 90.0, 'title': 'b2'}], 'throughput_avg_days_per_column': {'Doing': None, 'To Do': 23.0}, 'throughput_card_count_per_column': {'Doing': 0, 'To Do': 1}, 'throughput_heat_level': {'Doing': None, 'To Do': 'high'}, 'throughput_is_outlier': {'Doing': False, 'To Do': True}, 'throughput_is_warning': {'Doing': False, 'To Do': False}, 'throughput_wait_avg_days_per_column': {}}]
PINNED_MEDIANS = {'Doing': 19.0, 'To Do': 8.0}
