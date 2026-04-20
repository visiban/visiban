"""Tests for the notify_stale_cards management command (#558).

Coverage:
1. No stale cards → no notifications created
2. Card past threshold → notification created (happy path)
3. Board staleness_threshold_days field overrides default threshold
4. Board with no opted-in members → no notifications created
5. Already-notified card today → no duplicate notification (idempotency)
6. Running the command twice → no double-notify
7. stdout output contains expected summary text

The command uses board.staleness_threshold_days as the per-board threshold;
there is no --days CLI argument.  Varying staleness is exercised by setting
board.staleness_threshold_days directly.
"""

import datetime
from io import StringIO
from unittest.mock import patch

from django.core.management import call_command
from django.test import TestCase
from django.utils import timezone

from accounts.models import User
from boards.models import Board, BoardMembership, Card, CardMovement, Column, Notification, Swimlane
from boards.tests.conftest import _make_board


# ---------------------------------------------------------------------------
# Helpers shared across test classes
# ---------------------------------------------------------------------------

def _make_stale_movement(card, owner, column, swimlane, days_ago):
    """Create a CardMovement then backdate moved_at.

    auto_now_add prevents setting moved_at on creation, so we use .update()
    on the queryset after creation — the same pattern used in test_notifications.py.
    """
    mv = CardMovement.objects.create(
        card=card,
        from_column=None,
        from_swimlane=None,
        to_column=column,
        to_swimlane=swimlane,
        moved_by=owner,
    )
    stale_time = timezone.now() - datetime.timedelta(days=days_ago)
    CardMovement.objects.filter(pk=mv.pk).update(moved_at=stale_time)
    return mv


# ---------------------------------------------------------------------------
# Test classes
# ---------------------------------------------------------------------------

class NotifyStaleCardsNoStaleTest(TestCase):
    """No stale cards → no notifications created."""

    def setUp(self):
        self.owner = User.objects.create_user(
            username="owner_nostale", password="pass", notif_due_soon=True
        )
        self.board = _make_board(self.owner)
        self.col = Column.objects.create(board=self.board, name="Backlog", position=0, allow_card_creation=True)
        self.swim = Swimlane.objects.create(board=self.board, name="General", position=0)

    def test_fresh_card_creates_no_notification(self):
        """A card moved less than staleness_threshold_days ago is not stale."""
        card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Fresh Card", created_by=self.owner, position=0,
        )
        # Movement 1 day ago — well within the 7-day default threshold
        _make_stale_movement(card, self.owner, self.col, self.swim, days_ago=1)

        call_command("notify_stale_cards", verbosity=0)

        self.assertEqual(Notification.objects.filter(card=card).count(), 0)

    def test_empty_board_creates_no_notification(self):
        """A board with no cards at all produces no notifications."""
        call_command("notify_stale_cards", verbosity=0)
        self.assertEqual(Notification.objects.count(), 0)


class NotifyStaleCardsHappyPathTest(TestCase):
    """Stale card past threshold → notification created for opted-in members."""

    def setUp(self):
        self.owner = User.objects.create_user(
            username="owner_happy", password="pass", notif_due_soon=True
        )
        self.board = _make_board(self.owner)
        self.col = Column.objects.create(board=self.board, name="Backlog", position=0, allow_card_creation=True)
        self.swim = Swimlane.objects.create(board=self.board, name="General", position=0)
        self.threshold = self.board.staleness_threshold_days

    def test_stale_card_creates_notification_for_owner(self):
        """Owner (admin) with notif_due_soon=True receives a notification for a stale card."""
        card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Old Card", created_by=self.owner, position=0,
        )
        _make_stale_movement(card, self.owner, self.col, self.swim, days_ago=self.threshold + 1)

        call_command("notify_stale_cards", verbosity=0)

        notif = Notification.objects.filter(card=card, recipient=self.owner)
        self.assertEqual(notif.count(), 1)
        self.assertEqual(notif.first().action_type, Notification.ActionType.STALE)

    def test_notification_verb_contains_card_title_and_board_name(self):
        """The notification verb includes the card title and the board name."""
        card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="My Important Task", created_by=self.owner, position=0,
        )
        _make_stale_movement(card, self.owner, self.col, self.swim, days_ago=self.threshold + 2)

        call_command("notify_stale_cards", verbosity=0)

        notif = Notification.objects.get(card=card, recipient=self.owner)
        self.assertIn("My Important Task", notif.verb)
        self.assertIn(self.board.name, notif.verb)

    def test_stale_card_no_movement_uses_created_at(self):
        """A card with no movements falls back to created_at for staleness detection."""
        card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Old Card No Moves", created_by=self.owner, position=0,
        )
        # Backdate created_at past the threshold
        stale_time = timezone.now() - datetime.timedelta(days=self.threshold + 3)
        Card.objects.filter(pk=card.pk).update(created_at=stale_time)

        call_command("notify_stale_cards", verbosity=0)

        self.assertEqual(
            Notification.objects.filter(card=card, recipient=self.owner).count(), 1
        )

    def test_assignee_receives_notification(self):
        """The card assignee (if opted-in) also receives a staleness notification."""
        assignee = User.objects.create_user(
            username="assignee_happy", password="pass", notif_due_soon=True
        )
        BoardMembership.objects.create(board=self.board, user=assignee, role=BoardMembership.Role.MEMBER)
        card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Assigned Stale Card", created_by=self.owner, position=0,
            assignee=assignee,
        )
        _make_stale_movement(card, self.owner, self.col, self.swim, days_ago=self.threshold + 1)

        call_command("notify_stale_cards", verbosity=0)

        self.assertTrue(
            Notification.objects.filter(card=card, recipient=assignee).exists()
        )


class NotifyStaleCardsThresholdTest(TestCase):
    """board.staleness_threshold_days overrides the default threshold per-board."""

    def setUp(self):
        self.owner = User.objects.create_user(
            username="owner_thresh", password="pass", notif_due_soon=True
        )

    def test_custom_threshold_shorter_triggers_earlier(self):
        """A board with staleness_threshold_days=3 fires for a card idle for 4 days."""
        board = _make_board(self.owner, name="Short Threshold Board", staleness_threshold_days=3)
        col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
        swim = Swimlane.objects.create(board=board, name="General", position=0)
        card = Card.objects.create(
            board=board, column=col, swimlane=swim,
            title="4-day idle card", created_by=self.owner, position=0,
        )
        _make_stale_movement(card, self.owner, col, swim, days_ago=4)

        call_command("notify_stale_cards", verbosity=0)

        self.assertEqual(
            Notification.objects.filter(card=card, recipient=self.owner).count(), 1
        )

    def test_custom_threshold_longer_does_not_trigger_prematurely(self):
        """A board with staleness_threshold_days=14 does not fire for a card idle 8 days."""
        board = _make_board(self.owner, name="Long Threshold Board", staleness_threshold_days=14)
        col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
        swim = Swimlane.objects.create(board=board, name="General", position=0)
        card = Card.objects.create(
            board=board, column=col, swimlane=swim,
            title="8-day idle card", created_by=self.owner, position=0,
        )
        _make_stale_movement(card, self.owner, col, swim, days_ago=8)

        call_command("notify_stale_cards", verbosity=0)

        self.assertEqual(Notification.objects.filter(card=card).count(), 0)


class NotifyStaleCardsNoMembersTest(TestCase):
    """Board with no opted-in members → no notifications created."""

    def setUp(self):
        # notif_due_soon=False so no one is opted in
        self.owner = User.objects.create_user(
            username="owner_noopt", password="pass", notif_due_soon=False
        )
        self.board = _make_board(self.owner)
        self.col = Column.objects.create(board=self.board, name="Backlog", position=0, allow_card_creation=True)
        self.swim = Swimlane.objects.create(board=self.board, name="General", position=0)

    def test_no_opted_in_recipients_produces_no_notifications(self):
        """When all members have notif_due_soon=False, no notifications are created."""
        card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Stale but no listeners", created_by=self.owner, position=0,
        )
        _make_stale_movement(
            card, self.owner, self.col, self.swim,
            days_ago=self.board.staleness_threshold_days + 2,
        )

        call_command("notify_stale_cards", verbosity=0)

        self.assertEqual(Notification.objects.count(), 0)


class NotifyStaleCardsIdempotencyTest(TestCase):
    """Already-notified card → no duplicate notification within the same day."""

    def setUp(self):
        self.owner = User.objects.create_user(
            username="owner_idem", password="pass", notif_due_soon=True
        )
        self.board = _make_board(self.owner)
        self.col = Column.objects.create(board=self.board, name="Backlog", position=0, allow_card_creation=True)
        self.swim = Swimlane.objects.create(board=self.board, name="General", position=0)
        self.threshold = self.board.staleness_threshold_days

    def test_second_run_does_not_duplicate_notification(self):
        """Running the command twice for the same stale card creates exactly one notification."""
        card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Stale Idem Card", created_by=self.owner, position=0,
        )
        _make_stale_movement(card, self.owner, self.col, self.swim, days_ago=self.threshold + 1)

        call_command("notify_stale_cards", verbosity=0)
        call_command("notify_stale_cards", verbosity=0)

        self.assertEqual(
            Notification.objects.filter(card=card, recipient=self.owner).count(), 1
        )

    def test_existing_notification_today_prevents_new_one(self):
        """A STALE notification already created today (e.g. by a previous cron run) is not duplicated."""
        card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Already Notified", created_by=self.owner, position=0,
        )
        _make_stale_movement(card, self.owner, self.col, self.swim, days_ago=self.threshold + 1)

        # Simulate a notification already sent today (created_at = now, within today's window)
        Notification.objects.create(
            recipient=self.owner,
            action_type=Notification.ActionType.STALE,
            verb=f'"{card.title}" hasn\'t moved in {self.threshold + 1} days (board: {self.board.name})',
            card=card,
            board=self.board,
        )

        call_command("notify_stale_cards", verbosity=0)

        # Still only 1 notification — the one we pre-created
        self.assertEqual(
            Notification.objects.filter(card=card, recipient=self.owner).count(), 1
        )


class NotifyStaleCardsStdoutTest(TestCase):
    """stdout output contains expected summary text."""

    def setUp(self):
        self.owner = User.objects.create_user(
            username="owner_stdout", password="pass", notif_due_soon=True
        )
        self.board = _make_board(self.owner)
        self.col = Column.objects.create(board=self.board, name="Backlog", position=0, allow_card_creation=True)
        self.swim = Swimlane.objects.create(board=self.board, name="General", position=0)

    def test_stdout_reports_created_count(self):
        """Output reports the number of notifications created."""
        card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Stale Output Card", created_by=self.owner, position=0,
        )
        _make_stale_movement(
            card, self.owner, self.col, self.swim,
            days_ago=self.board.staleness_threshold_days + 1,
        )

        out = StringIO()
        call_command("notify_stale_cards", verbosity=1, stdout=out)

        output = out.getvalue()
        self.assertIn("notify_stale_cards", output)
        self.assertIn("notifications created", output)

    def test_stdout_reports_zero_when_no_stale_cards(self):
        """Output reports 0 notifications created when no cards are stale."""
        out = StringIO()
        call_command("notify_stale_cards", verbosity=1, stdout=out)

        output = out.getvalue()
        self.assertIn("0 notifications created", output)

    def test_stdout_reports_skipped_count_on_second_run(self):
        """Output reports skipped count when idempotency logic suppresses duplicates."""
        card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Skip Output Card", created_by=self.owner, position=0,
        )
        _make_stale_movement(
            card, self.owner, self.col, self.swim,
            days_ago=self.board.staleness_threshold_days + 1,
        )

        call_command("notify_stale_cards", verbosity=0)

        out = StringIO()
        call_command("notify_stale_cards", verbosity=1, stdout=out)

        output = out.getvalue()
        self.assertIn("skipped", output)
