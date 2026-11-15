"""``analytics`` accepts the flow filters ``swimlane_id`` and ``label_id`` (#2280)."""
import datetime

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, CardMovement, Column, Label, Swimlane


class AnalyticsFilterTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u2280", password="pw")
        self.outsider = User.objects.create_user(username="o2280", password="pw")
        self.board = Board.objects.create(name="B", owner=self.user)
        BoardMembership.objects.create(board=self.board, user=self.user, role="viewer")
        self.todo = Column.objects.create(board=self.board, name="To Do", position=0)
        self.doing = Column.objects.create(board=self.board, name="Doing", position=1)
        self.lane_a = Swimlane.objects.create(board=self.board, name="A", position=0)
        self.lane_b = Swimlane.objects.create(board=self.board, name="B", position=1)
        self.label = Label.objects.create(board=self.board, name="L", color="#ff0000")
        self.card_a = self._card(self.lane_a, "a", stalled_days=20)
        self.card_b = self._card(self.lane_b, "b", stalled_days=20)
        self.card_a.labels.add(self.label)
        other = Board.objects.create(name="Other", owner=self.outsider)
        self.other_lane = Swimlane.objects.create(board=other, name="X", position=0)
        self.other_label = Label.objects.create(board=other, name="Y", color="#00ff00")
        self.client = APIClient()
        self.client.force_authenticate(user=self.user)
        self.url = f"/api/v1/boards/{self.board.pk}/analytics/"

    def _card(self, lane, title, stalled_days):
        card = Card.objects.create(
            board=self.board, column=self.doing, swimlane=lane, title=title,
            created_by=self.user, position=0,
        )
        # Creating a card may record its own "created" movement; keep only ours so
        # the last move is exactly ``stalled_days`` ago.
        CardMovement.objects.filter(card=card).delete()
        move = CardMovement.objects.create(
            card=card, from_column=None, to_column=self.doing,
            from_column_name="", to_column_name=self.doing.name,
            from_column_uid="", to_column_uid=self.doing.uid,
            from_swimlane_name="", to_swimlane_name=lane.name,
            from_swimlane_uid="", to_swimlane_uid=lane.uid,
            moved_by=self.user,
        )
        # ``moved_at`` is auto-stamped; backdate it.
        CardMovement.objects.filter(pk=move.pk).update(
            moved_at=timezone.now() - datetime.timedelta(days=stalled_days),
        )
        return card

    def _stalled(self, data):
        return {c["title"] for sw in data["swimlanes"] for c in sw["stalled_cards"]}

    def test_no_params_unchanged(self):
        data = self.client.get(self.url).json()
        self.assertEqual({sw["name"] for sw in data["swimlanes"]}, {"A", "B"})
        self.assertEqual(self._stalled(data), {"a", "b"})
        self.assertEqual(self.client.get(self.url).json(), data)

    def test_swimlane_filter_narrows_every_section(self):
        data = self.client.get(self.url, {"swimlane_id": self.lane_a.id}).json()
        self.assertEqual([sw["name"] for sw in data["swimlanes"]], ["A"])
        self.assertEqual(self._stalled(data), {"a"})
        self.assertIsNotNone(data["swimlanes"][0]["deal_velocity_days"])

    def test_label_filter_narrows_every_section(self):
        data = self.client.get(self.url, {"label_id": self.label.id}).json()
        self.assertEqual(self._stalled(data), {"a"})
        lane_b = next(sw for sw in data["swimlanes"] if sw["name"] == "B")
        self.assertIsNone(lane_b["deal_velocity_days"])
        self.assertEqual(lane_b["stalled_cards"], [])
        self.assertTrue(all(v is None for v in lane_b["avg_days_per_column"].values()))

    def test_both_filters_intersect(self):
        data = self.client.get(self.url, {"swimlane_id": self.lane_b.id, "label_id": self.label.id}).json()
        self.assertEqual(self._stalled(data), set())

    def test_other_board_ids_get_the_same_400_as_nonexistent(self):
        for param, foreign, missing in (
            ("swimlane_id", self.other_lane.id, 999999),
            ("label_id", self.other_label.id, 999999),
        ):
            a = self.client.get(self.url, {param: foreign})
            b = self.client.get(self.url, {param: missing})
            self.assertEqual(a.status_code, 400)
            self.assertEqual(a.json(), b.json())
            self.assertEqual(a.json()["code"], "invalid_query_param")

    def test_malformed_ids_are_400(self):
        for value in ("abc", "0", str(2**70)):
            self.assertEqual(self.client.get(self.url, {"swimlane_id": value}).status_code, 400)

    def test_permission_unchanged(self):
        anon = APIClient()
        self.assertIn(anon.get(self.url, {"swimlane_id": self.lane_a.id}).status_code, (401, 403))
        out = APIClient()
        out.force_authenticate(user=self.outsider)
        self.assertEqual(out.get(self.url, {"swimlane_id": self.lane_a.id}).status_code, 404)

    def test_query_count_does_not_scale_with_cards(self):
        params = {"swimlane_id": self.lane_a.id, "label_id": self.label.id}
        self.client.get(self.url, params)
        with CaptureQueriesContext(connection) as small:
            self.client.get(self.url, params)
        for i in range(10):
            c = self._card(self.lane_a, f"x{i}", stalled_days=5)
            c.labels.add(self.label)
        with CaptureQueriesContext(connection) as large:
            self.client.get(self.url, params)
        self.assertEqual(len(large), len(small))

