"""Tests for CardViewSet: CRUD, update activity tracking, comments, checklist, movements."""
from unittest.mock import patch

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, CardActivity, CardComment,
    CardMovement, Column, Swimlane, Label, Notification,
)


PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"


def _make_board(owner):
    board = Board.objects.create(name="B", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    col2 = Column.objects.create(board=board, name="Done", position=1, allow_card_creation=False)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col, col2, swim


def _make_card(board, col, swim, user, title="Card"):
    return Card.objects.create(
        board=board, column=col, swimlane=swim,
        title=title, created_by=user, position=0,
    )


class CardCreateTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, self.col2, self.swim = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    @patch(PATCH_BROADCAST)
    def test_create_card_success(self, _):
        r = self.client.post(
            f"/api/boards/{self.board.id}/cards/",
            {"title": "New card", "column": self.col.id, "swimlane": self.swim.id},
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertEqual(r.json()["title"], "New card")
        # Creation movement is logged
        card = Card.objects.get(id=r.json()["id"])
        self.assertEqual(card.movements.count(), 1)

    def test_create_card_in_no_creation_column_rejected(self):
        r = self.client.post(
            f"/api/boards/{self.board.id}/cards/",
            {"title": "X", "column": self.col2.id, "swimlane": self.swim.id},
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_viewer_cannot_create_card(self):
        viewer = User.objects.create_user(username="viewer", password="pass")
        BoardMembership.objects.create(board=self.board, user=viewer, role=BoardMembership.Role.VIEWER)
        self.client.force_authenticate(viewer)
        r = self.client.post(
            f"/api/boards/{self.board.id}/cards/",
            {"title": "X", "column": self.col.id, "swimlane": self.swim.id},
        )
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND])


class CardDeleteTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, _, self.swim = _make_board(self.user)
        self.card = _make_card(self.board, self.col, self.swim, self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    @patch(PATCH_BROADCAST)
    def test_delete_card(self, _):
        r = self.client.delete(f"/api/boards/{self.board.id}/cards/{self.card.id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(Card.objects.filter(pk=self.card.id).exists())

    def test_viewer_cannot_delete_card(self):
        viewer = User.objects.create_user(username="viewer", password="pass")
        BoardMembership.objects.create(board=self.board, user=viewer, role=BoardMembership.Role.VIEWER)
        self.client.force_authenticate(viewer)
        r = self.client.delete(f"/api/boards/{self.board.id}/cards/{self.card.id}/")
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND])


class CardUpdateTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.assignee = User.objects.create_user(username="assignee", password="pass")
        self.board, self.col, _, self.swim = _make_board(self.user)
        BoardMembership.objects.create(board=self.board, user=self.assignee, role=BoardMembership.Role.MEMBER)
        self.card = _make_card(self.board, self.col, self.swim, self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    @patch(PATCH_BROADCAST)
    def test_update_title_logs_activity(self, _):
        r = self.client.patch(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/",
            {"title": "New Title"},
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertTrue(
            CardActivity.objects.filter(
                card=self.card, event_type=CardActivity.EventType.TITLE_CHANGE
            ).exists()
        )

    @patch(PATCH_BROADCAST)
    def test_update_priority_logs_activity(self, _):
        r = self.client.patch(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/",
            {"priority": "high"},
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertTrue(
            CardActivity.objects.filter(
                card=self.card, event_type=CardActivity.EventType.PRIORITY_CHANGE
            ).exists()
        )

    @patch(PATCH_BROADCAST)
    def test_update_assignee_creates_notification(self, _):
        r = self.client.patch(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/",
            {"assignee_id": self.assignee.id},
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertTrue(
            Notification.objects.filter(
                recipient=self.assignee, card=self.card
            ).exists()
        )

    @patch(PATCH_BROADCAST)
    def test_update_labels(self, _):
        label = Label.objects.create(board=self.board, name="Bug", color="#F00")
        r = self.client.patch(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/",
            {"label_ids": [label.id]},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIn(label.id, [lbl["id"] for lbl in r.json()["labels"]])

    @patch(PATCH_BROADCAST)
    def test_setting_due_date_logs_activity(self, _):
        r = self.client.patch(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/",
            {"due_date": "2099-06-15"},
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        act = CardActivity.objects.filter(
            card=self.card, event_type=CardActivity.EventType.DUE_DATE_CHANGE
        ).first()
        self.assertIsNotNone(act)
        self.assertEqual(act.from_value, "")  # was null → empty string
        self.assertEqual(act.to_value, "2099-06-15")

    @patch(PATCH_BROADCAST)
    def test_changing_due_date_logs_activity(self, _):
        self.card.due_date = "2099-01-01"
        self.card.save()
        r = self.client.patch(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/",
            {"due_date": "2099-06-15"},
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        act = CardActivity.objects.filter(
            card=self.card, event_type=CardActivity.EventType.DUE_DATE_CHANGE
        ).first()
        self.assertIsNotNone(act)
        self.assertEqual(act.from_value, "2099-01-01")
        self.assertEqual(act.to_value, "2099-06-15")

    @patch(PATCH_BROADCAST)
    def test_clearing_due_date_logs_activity(self, _):
        self.card.due_date = "2099-06-15"
        self.card.save()
        r = self.client.patch(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/",
            {"due_date": None},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        act = CardActivity.objects.filter(
            card=self.card, event_type=CardActivity.EventType.DUE_DATE_CHANGE
        ).first()
        self.assertIsNotNone(act)
        self.assertEqual(act.from_value, "2099-06-15")
        self.assertEqual(act.to_value, "")  # cleared → empty string

    @patch(PATCH_BROADCAST)
    def test_unchanged_due_date_does_not_log_activity(self, _):
        self.card.due_date = "2099-06-15"
        self.card.save()
        self.client.patch(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/",
            {"due_date": "2099-06-15"},
        )
        self.assertEqual(
            CardActivity.objects.filter(
                card=self.card, event_type=CardActivity.EventType.DUE_DATE_CHANGE
            ).count(),
            0,
        )


class CardCommentsTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, _, self.swim = _make_board(self.user)
        self.card = _make_card(self.board, self.col, self.swim, self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    @patch(PATCH_BROADCAST)
    def test_post_comment(self, _):
        r = self.client.post(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/comments/",
            {"body": "Hello world"},
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertEqual(CardComment.objects.filter(card=self.card).count(), 1)

    @patch(PATCH_BROADCAST)
    def test_get_comments(self, _):
        CardComment.objects.create(card=self.card, author=self.user, body="Hi")
        r = self.client.get(f"/api/boards/{self.board.id}/cards/{self.card.id}/comments/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(len(r.json()), 1)

    @patch(PATCH_BROADCAST)
    def test_mention_creates_notification(self, _):
        mentioned = User.objects.create_user(username="alice", password="pass")
        BoardMembership.objects.create(board=self.board, user=mentioned, role=BoardMembership.Role.MEMBER)
        r = self.client.post(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/comments/",
            {"body": "Hey @alice check this"},
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertTrue(
            Notification.objects.filter(recipient=mentioned, card=self.card).exists()
        )

    @patch(PATCH_BROADCAST)
    def test_mention_of_non_member_ignored(self, _):
        non_member = User.objects.create_user(username="bob", password="pass")
        r = self.client.post(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/comments/",
            {"body": "Hey @bob"},
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertFalse(
            Notification.objects.filter(recipient=non_member).exists()
        )


class CardMovementsActivitiesTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, self.col2, self.swim = _make_board(self.user)
        self.card = _make_card(self.board, self.col, self.swim, self.user)
        CardMovement.objects.create(
            card=self.card, to_column=self.col, to_swimlane=self.swim, moved_by=self.user
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_get_movements(self):
        r = self.client.get(f"/api/boards/{self.board.id}/cards/{self.card.id}/movements/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertGreaterEqual(len(r.json()), 1)

    def test_get_activities(self):
        CardActivity.objects.create(
            card=self.card, event_type=CardActivity.EventType.TITLE_CHANGE,
            from_value="Old", to_value="New", actor=self.user,
        )
        r = self.client.get(f"/api/boards/{self.board.id}/cards/{self.card.id}/activities/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(len(r.json()), 1)


class CardChecklistTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, _, self.swim = _make_board(self.user)
        self.card = _make_card(self.board, self.col, self.swim, self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    @patch(PATCH_BROADCAST)
    def test_add_checklist_item(self, _):
        r = self.client.post(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/checklist/",
            {"text": "Step 1"},
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertEqual(r.json()["text"], "Step 1")

    @patch(PATCH_BROADCAST)
    def test_list_checklist_items(self, _):
        self.client.post(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/checklist/",
            {"text": "Step 1"},
        )
        r = self.client.get(f"/api/boards/{self.board.id}/cards/{self.card.id}/checklist/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(len(r.json()), 1)

    @patch(PATCH_BROADCAST)
    def test_check_and_uncheck_item(self, _):
        r_add = self.client.post(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/checklist/",
            {"text": "Step 1"},
        )
        item_id = r_add.json()["id"]
        r = self.client.patch(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/checklist/{item_id}/",
            {"is_checked": True},
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertTrue(r.json()["is_checked"])

    @patch(PATCH_BROADCAST)
    def test_delete_checklist_item(self, _):
        r_add = self.client.post(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/checklist/",
            {"text": "Step 1"},
        )
        item_id = r_add.json()["id"]
        r = self.client.delete(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/checklist/{item_id}/"
        )
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(self.card.checklist_items.count(), 0)

    @patch(PATCH_BROADCAST)
    def test_add_checklist_item_logs_activity(self, _):
        self.client.post(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/checklist/",
            {"text": "Step 1"},
        )
        self.assertTrue(
            CardActivity.objects.filter(
                card=self.card, event_type=CardActivity.EventType.CHECKLIST_ITEM_ADDED
            ).exists()
        )


class CardFilterTests(TestCase):
    """Tests for CardFilter — priority, assignee, unassigned, column, swimlane, due dates, overdue."""

    def setUp(self):
        self.user = User.objects.create_user(username="filter_owner", password="pass")
        self.assignee = User.objects.create_user(username="filter_assignee", password="pass")
        self.board, self.col, self.col2, self.swim = _make_board(self.user)
        self.swim2 = Swimlane.objects.create(board=self.board, name="Lane 2", position=1)
        BoardMembership.objects.create(board=self.board, user=self.assignee, role=BoardMembership.Role.MEMBER)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

        import datetime
        today = datetime.date.today()
        yesterday = today - datetime.timedelta(days=1)
        tomorrow = today + datetime.timedelta(days=1)

        self.card_high = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="High priority", created_by=self.user, priority="high", position=0,
        )
        self.card_low = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Low priority", created_by=self.user, priority="low", position=1,
        )
        self.card_assigned = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Assigned card", created_by=self.user, assignee=self.assignee, position=2,
        )
        self.card_overdue = Card.objects.create(
            board=self.board, column=self.col2, swimlane=self.swim,
            title="Overdue card", created_by=self.user, due_date=yesterday, position=0,
        )
        self.card_future = Card.objects.create(
            board=self.board, column=self.col2, swimlane=self.swim,
            title="Future card", created_by=self.user, due_date=tomorrow, position=1,
        )
        self.card_swim2 = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim2,
            title="Swim2 card", created_by=self.user, position=0,
        )

    def _url(self):
        return f"/api/boards/{self.board.id}/cards/"

    def test_filter_by_priority(self):
        r = self.client.get(self._url(), {"priority": "high"})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        titles = [c["title"] for c in r.json()]
        self.assertIn("High priority", titles)
        self.assertNotIn("Low priority", titles)

    def test_filter_by_assignee(self):
        r = self.client.get(self._url(), {"assignee": self.assignee.id})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        titles = [c["title"] for c in r.json()]
        self.assertIn("Assigned card", titles)
        self.assertNotIn("High priority", titles)

    def test_filter_unassigned(self):
        r = self.client.get(self._url(), {"unassigned": "true"})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        titles = [c["title"] for c in r.json()]
        self.assertNotIn("Assigned card", titles)
        self.assertIn("High priority", titles)

    def test_filter_by_column(self):
        r = self.client.get(self._url(), {"column": self.col2.id})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        titles = [c["title"] for c in r.json()]
        self.assertIn("Overdue card", titles)
        self.assertIn("Future card", titles)
        self.assertNotIn("High priority", titles)

    def test_filter_by_swimlane(self):
        r = self.client.get(self._url(), {"swimlane": self.swim2.id})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        titles = [c["title"] for c in r.json()]
        self.assertIn("Swim2 card", titles)
        self.assertNotIn("High priority", titles)

    def test_filter_due_before(self):
        import datetime
        tomorrow = (datetime.date.today() + datetime.timedelta(days=1)).isoformat()
        r = self.client.get(self._url(), {"due_before": tomorrow})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        titles = [c["title"] for c in r.json()]
        self.assertIn("Overdue card", titles)
        # Future card due_date == tomorrow, which is <= tomorrow so it IS included
        self.assertNotIn("High priority", titles)  # no due date — excluded

    def test_filter_due_after(self):
        import datetime
        today = datetime.date.today().isoformat()
        r = self.client.get(self._url(), {"due_after": today})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        titles = [c["title"] for c in r.json()]
        self.assertIn("Future card", titles)
        self.assertNotIn("Overdue card", titles)
        self.assertNotIn("High priority", titles)  # no due date

    def test_filter_overdue(self):
        r = self.client.get(self._url(), {"overdue": "true"})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        titles = [c["title"] for c in r.json()]
        self.assertIn("Overdue card", titles)
        self.assertNotIn("Future card", titles)
        self.assertNotIn("High priority", titles)  # no due date


class CardListQueryCountTests(TestCase):
    """Assert that the card list endpoint does not produce N+1 queries as card count grows.

    The bound is deliberately generous (≤ 12) to accommodate Django's session
    lookup, board membership check, and the handful of JOINs the ORM emits for
    select_related/prefetch_related — while still catching any regression that
    adds per-card queries.
    """

    def setUp(self):
        self.user = User.objects.create_user(username="qcount", password="pass")
        self.board, self.col, _, self.swim = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

        # Create 10 cards, each with a checklist item to exercise the serializer
        # methods that previously issued per-card queries via .count()/.filter().
        from boards.models import CardChecklist
        for i in range(10):
            card = Card.objects.create(
                board=self.board, column=self.col, swimlane=self.swim,
                title=f"Card {i}", created_by=self.user, position=i,
            )
            CardChecklist.objects.create(card=card, text="todo", is_checked=(i % 2 == 0), position=0)

    def test_card_list_query_count_bounded(self):
        """Card list for 10 cards must complete in ≤ 12 queries regardless of card count.

        The prefetch + select_related on CardViewSet.get_queryset() should reduce
        the query count to a small constant (currently 8).  The ceiling of 12 gives
        headroom for minor schema changes while still catching N+1 regressions.
        """
        from django.test.utils import CaptureQueriesContext
        from django.db import connection

        url = f"/api/boards/{self.board.id}/cards/"
        with CaptureQueriesContext(connection) as ctx:
            resp = self.client.get(url)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        # Pagination wraps results; handle both paginated and plain list responses.
        results = data["results"] if isinstance(data, dict) and "results" in data else data
        self.assertEqual(len(results), 10)
        self.assertLessEqual(
            len(ctx.captured_queries),
            12,
            f"Expected ≤ 12 queries for a 10-card board, got {len(ctx.captured_queries)}",
        )


class CardBoardScopingTests(TestCase):
    """Verify that label_ids and assignee_id are scoped to the current board.

    Without board-scoped querysets, a malicious client could assign labels from
    another board or assign a non-member user — both are cross-board IDOR
    vulnerabilities (#416).
    """

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, self.col, _, self.swim = _make_board(self.owner)
        self.card = _make_card(self.board, self.col, self.swim, self.owner)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

        # Second board with its own label — should be unreachable from board 1
        self.other_owner = User.objects.create_user(username="other", password="pass")
        self.other_board, self.other_col, _, self.other_swim = _make_board(self.other_owner)

    @patch(PATCH_BROADCAST)
    def test_create_card_with_cross_board_label_rejected(self, _):
        foreign_label = Label.objects.create(board=self.other_board, name="Foreign", color="#000")
        r = self.client.post(
            f"/api/boards/{self.board.id}/cards/",
            {"title": "X", "column": self.col.id, "swimlane": self.swim.id, "label_ids": [foreign_label.id]},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    @patch(PATCH_BROADCAST)
    def test_update_card_with_cross_board_label_rejected(self, _):
        foreign_label = Label.objects.create(board=self.other_board, name="Foreign", color="#000")
        r = self.client.patch(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/",
            {"label_ids": [foreign_label.id]},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    @patch(PATCH_BROADCAST)
    def test_update_card_with_same_board_label_accepted(self, _):
        local_label = Label.objects.create(board=self.board, name="Local", color="#0F0")
        r = self.client.patch(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/",
            {"label_ids": [local_label.id]},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    @patch(PATCH_BROADCAST)
    def test_assign_non_member_user_rejected(self, _):
        outsider = User.objects.create_user(username="outsider", password="pass")
        r = self.client.patch(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/",
            {"assignee_id": outsider.id},
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    @patch(PATCH_BROADCAST)
    def test_assign_board_member_accepted(self, _):
        member = User.objects.create_user(username="member", password="pass")
        BoardMembership.objects.create(board=self.board, user=member, role=BoardMembership.Role.MEMBER)
        r = self.client.patch(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/",
            {"assignee_id": member.id},
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    @patch(PATCH_BROADCAST)
    def test_create_card_with_non_member_assignee_rejected(self, _):
        outsider = User.objects.create_user(username="outsider2", password="pass")
        r = self.client.post(
            f"/api/boards/{self.board.id}/cards/",
            {"title": "X", "column": self.col.id, "swimlane": self.swim.id, "assignee_id": outsider.id},
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    @patch(PATCH_BROADCAST)
    def test_unassign_card_accepted(self, _):
        """Setting assignee_id to null should always succeed — it clears the assignee."""
        r = self.client.patch(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/",
            {"assignee_id": None},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
