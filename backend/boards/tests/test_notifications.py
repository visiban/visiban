import datetime
from unittest.mock import patch

from django.core.management import call_command
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Column, Swimlane, Card, CardMovement, Notification


def make_board(owner):
    board = Board.objects.create(name="Test Board", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col_a = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    col_b = Column.objects.create(board=board, name="Done", position=1)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col_a, col_b, swim


class StaleCardNotificationTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, self.col_a, self.col_b, self.swim = make_board(self.owner)
        self.threshold = self.board.staleness_threshold_days

    def _make_card(self, title="Stale Card", assignee=None):
        return Card.objects.create(
            board=self.board,
            column=self.col_a,
            swimlane=self.swim,
            title=title,
            created_by=self.owner,
            position=0,
            assignee=assignee,
        )

    def _make_stale_movement(self, card, days_ago):
        """Create a movement then backdate moved_at since it's auto_now_add."""
        mv = CardMovement.objects.create(
            card=card,
            from_column=None,
            from_swimlane=None,
            to_column=self.col_a,
            to_swimlane=self.swim,
            moved_by=self.owner,
        )
        stale_time = timezone.now() - datetime.timedelta(days=days_ago)
        CardMovement.objects.filter(pk=mv.pk).update(moved_at=stale_time)
        return mv

    def test_stale_card_creates_notification(self):
        card = self._make_card()
        self._make_stale_movement(card, days_ago=self.threshold + 1)

        call_command("notify_stale_cards", verbosity=0)

        self.assertEqual(
            Notification.objects.filter(card=card, recipient=self.owner).count(), 1
        )

    def test_fresh_card_does_not_create_notification(self):
        card = self._make_card()
        self._make_stale_movement(card, days_ago=1)

        call_command("notify_stale_cards", verbosity=0)

        self.assertEqual(Notification.objects.filter(card=card).count(), 0)

    def test_stale_card_notifies_assignee(self):
        assignee = User.objects.create_user(username="assignee", password="pass")
        BoardMembership.objects.create(board=self.board, user=assignee, role=BoardMembership.Role.MEMBER)
        card = self._make_card(assignee=assignee)
        self._make_stale_movement(card, days_ago=self.threshold + 1)

        call_command("notify_stale_cards", verbosity=0)

        self.assertTrue(
            Notification.objects.filter(card=card, recipient=assignee).exists()
        )

    def test_idempotency_run_twice_creates_one_notification(self):
        card = self._make_card()
        self._make_stale_movement(card, days_ago=self.threshold + 1)

        call_command("notify_stale_cards", verbosity=0)
        call_command("notify_stale_cards", verbosity=0)

        self.assertEqual(
            Notification.objects.filter(card=card, recipient=self.owner).count(), 1
        )

    def test_no_movement_stale_card_creates_notification(self):
        """Card created beyond threshold with no movements should trigger notification."""
        card = self._make_card()
        stale_time = timezone.now() - datetime.timedelta(days=self.threshold + 2)
        Card.objects.filter(pk=card.pk).update(created_at=stale_time)

        call_command("notify_stale_cards", verbosity=0)

        self.assertEqual(
            Notification.objects.filter(card=card, recipient=self.owner).count(), 1
        )


class CardAssignmentNotificationTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.client.force_authenticate(self.owner)
        self.board, self.col_a, _, self.swim = make_board(self.owner)
        self.card = Card.objects.create(
            board=self.board,
            column=self.col_a,
            swimlane=self.swim,
            title="Assignable Card",
            created_by=self.owner,
            position=0,
        )

    @patch("boards.views.broadcast_board_event")
    def test_assigning_card_notifies_assignee(self, _mock_broadcast):
        assignee = User.objects.create_user(username="assignee", password="pass")
        BoardMembership.objects.create(board=self.board, user=assignee, role=BoardMembership.Role.MEMBER)

        self.client.patch(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/",
            {"assignee_id": assignee.pk},
        )

        self.assertTrue(
            Notification.objects.filter(
                recipient=assignee,
                card=self.card,
                verb__contains="assigned",
            ).exists()
        )

    @patch("boards.views.broadcast_board_event")
    def test_self_assignment_does_not_notify(self, _mock_broadcast):
        self.client.patch(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/",
            {"assignee_id": self.owner.pk},
        )

        self.assertEqual(
            Notification.objects.filter(recipient=self.owner, card=self.card).count(), 0
        )

    @patch("boards.views.broadcast_board_event")
    def test_card_move_notifies_assignee(self, _mock_broadcast):
        col_b = Column.objects.create(board=self.board, name="Doing", position=2)
        assignee = User.objects.create_user(username="mover_assignee", password="pass")
        BoardMembership.objects.create(board=self.board, user=assignee, role=BoardMembership.Role.MEMBER)
        self.card.assignee = assignee
        self.card.save()

        self.client.post(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/move/",
            {"column_id": col_b.pk, "swimlane_id": self.swim.pk, "position": 0},
        )

        self.assertTrue(
            Notification.objects.filter(recipient=assignee, card=self.card).exists()
        )

    @patch("boards.views.broadcast_board_event")
    def test_card_move_does_not_notify_mover_when_self_assigned(self, _mock_broadcast):
        col_b = Column.objects.create(board=self.board, name="Doing", position=2)
        self.card.assignee = self.owner
        self.card.save()

        self.client.post(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/move/",
            {"column_id": col_b.pk, "swimlane_id": self.swim.pk, "position": 0},
        )

        self.assertEqual(
            Notification.objects.filter(recipient=self.owner, card=self.card).count(), 0
        )
