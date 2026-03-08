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


PATCH_BROADCAST = "boards.views.broadcast_board_event"


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
