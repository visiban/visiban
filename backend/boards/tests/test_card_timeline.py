"""Tests for CardViewSet.timeline — unified activity+movement endpoint."""

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, CardActivity, CardMovement, Column, Swimlane,
)


def _make_board(owner):
    board = Board.objects.create(name="B", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col, swim


def _make_card(board, col, swim, user, title="Card"):
    return Card.objects.create(
        board=board, column=col, swimlane=swim,
        title=title, created_by=user, position=0,
    )


def _make_movement(card, user, from_col=None, to_col=None):
    return CardMovement.objects.create(
        card=card,
        from_column=from_col,
        from_column_name=from_col.name if from_col else "",
        to_column=to_col,
        to_column_name=to_col.name if to_col else "",
        moved_by=user,
    )


def _make_activity(card, user, event_type=CardActivity.EventType.PRIORITY_CHANGE):
    return CardActivity.objects.create(
        card=card,
        event_type=event_type,
        from_value="low",
        to_value="high",
        actor=user,
    )


class CardTimelineAccessTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, self.col, self.swim = _make_board(self.owner)
        self.card = _make_card(self.board, self.col, self.swim, self.owner)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        self.url = f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/timeline/"

    def test_authenticated_member_can_get_timeline(self):
        r = self.client.get(self.url)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        data = r.json()
        self.assertIn("count", data)
        self.assertIn("results", data)

    def test_non_member_gets_403(self):
        outsider = User.objects.create_user(username="outsider", password="pass")
        self.client.force_authenticate(outsider)
        r = self.client.get(self.url)
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND])

    def test_unauthenticated_gets_401(self):
        self.client.logout()
        r = self.client.get(self.url)
        self.assertIn(r.status_code, [status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN])


class CardTimelineMergeTests(TestCase):
    """Verify that movements and activities are merged and sorted newest-first."""

    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, self.swim = _make_board(self.user)
        self.card = _make_card(self.board, self.col, self.swim, self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.url = f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/timeline/"

    def test_returns_both_movements_and_activities(self):
        # Create one movement and one activity — both should appear
        _make_movement(self.card, self.user, to_col=self.col)
        _make_activity(self.card, self.user)
        r = self.client.get(self.url)
        data = r.json()
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        kinds = {e["kind"] for e in data["results"]}
        self.assertIn("move", kinds)
        self.assertIn("activity", kinds)

    def test_sorted_newest_first(self):
        # Movements carry auto-set moved_at; activities carry auto-set created_at.
        # We cannot control the exact order of auto-set timestamps in the same
        # second, but we can verify the list is in non-ascending order.
        _make_movement(self.card, self.user, to_col=self.col)
        _make_activity(self.card, self.user)
        _make_activity(self.card, self.user, event_type=CardActivity.EventType.WEIGHT_CHANGE)
        r = self.client.get(self.url)
        data = r.json()
        timestamps = [e["ts"] for e in data["results"]]
        self.assertEqual(timestamps, sorted(timestamps, reverse=True),
                         "Timeline entries must be ordered newest-first")

    def test_each_entry_has_required_fields(self):
        _make_movement(self.card, self.user, to_col=self.col)
        r = self.client.get(self.url)
        entry = r.json()["results"][0]
        for field in ("id", "kind", "ts", "actor", "event_type", "data"):
            self.assertIn(field, entry, f"Missing field: {field}")


class CardTimelineFilterTests(TestCase):
    """Verify the ?event_types= filter parameter."""

    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, self.swim = _make_board(self.user)
        self.card = _make_card(self.board, self.col, self.swim, self.user)
        # Create both a movement and a comment activity
        _make_movement(self.card, self.user, to_col=self.col)
        CardActivity.objects.create(
            card=self.card,
            event_type=CardActivity.EventType.COMMENT_ADDED,
            from_value="", to_value="",
            actor=self.user,
        )
        CardActivity.objects.create(
            card=self.card,
            event_type=CardActivity.EventType.PRIORITY_CHANGE,
            from_value="low", to_value="high",
            actor=self.user,
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.url = f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/timeline/"

    def test_filter_move_returns_only_movements(self):
        r = self.client.get(self.url, {"event_types": "move"})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        results = r.json()["results"]
        self.assertTrue(len(results) > 0)
        for entry in results:
            self.assertEqual(entry["kind"], "move")

    def test_filter_comment_returns_only_comment_activities(self):
        r = self.client.get(self.url, {"event_types": "comment"})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        results = r.json()["results"]
        self.assertTrue(len(results) > 0)
        for entry in results:
            self.assertEqual(entry["event_type"], "comment_added")

    def test_no_filter_returns_all_types(self):
        r = self.client.get(self.url)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        kinds = {e["kind"] for e in r.json()["results"]}
        self.assertIn("move", kinds)
        self.assertIn("activity", kinds)

    def test_invalid_event_types_returns_400(self):
        """An unknown group name is a client error, not a silent empty page (#1054)."""
        r = self.client.get(self.url, {"event_types": "bogus"})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("Invalid event_types", r.json()["detail"])
        self.assertIn("bogus", r.json()["detail"])

    def test_partially_invalid_event_types_returns_400(self):
        """A mix of one valid and one invalid group still rejects the whole request."""
        r = self.client.get(self.url, {"event_types": "move,bogus"})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("bogus", r.json()["detail"])


class CardTimelinePaginationTests(TestCase):
    """Verify limit/offset pagination works correctly."""

    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, self.swim = _make_board(self.user)
        self.card = _make_card(self.board, self.col, self.swim, self.user)
        # Create 5 activity entries
        for _ in range(5):
            _make_activity(self.card, self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.url = f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/timeline/"

    def test_limit_2_offset_0_returns_2_items_and_has_next(self):
        r = self.client.get(self.url, {"limit": 2, "offset": 0})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        data = r.json()
        self.assertEqual(len(data["results"]), 2)
        self.assertIsNotNone(data["next"], "next should not be null when more items exist")

    def test_limit_2_offset_2_returns_next_2_items(self):
        r_first = self.client.get(self.url, {"limit": 2, "offset": 0})
        r_second = self.client.get(self.url, {"limit": 2, "offset": 2})
        first_ids = [e["id"] for e in r_first.json()["results"]]
        second_ids = [e["id"] for e in r_second.json()["results"]]
        # The two pages must not overlap
        self.assertFalse(
            set(first_ids) & set(second_ids),
            "Pages should not share entries",
        )
        self.assertEqual(len(second_ids), 2)

    def test_previous_is_null_on_first_page(self):
        r = self.client.get(self.url, {"limit": 2, "offset": 0})
        self.assertIsNone(r.json()["previous"])

    def test_previous_is_set_on_second_page(self):
        r = self.client.get(self.url, {"limit": 2, "offset": 2})
        self.assertIsNotNone(r.json()["previous"])
