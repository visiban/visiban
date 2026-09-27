"""Tests for the prune_notifications management command (#1158).

Coverage:
1. Deletes rows past the window, read and unread alike; keeps fresh rows
2. --dry-run reports and deletes nothing
3. --days overrides the default; NOTIFICATION_RETENTION_DAYS sets the default
4. Retention below the 14-day floor is refused (flag and setting both), because
   notification rows are the de-dup record for the scheduled scans
5. Batching pages through every stale row, across several batches
6. --batch-size < 1 is rejected
7. Pruning an old DUE_SOON row does not cause notify_due_soon to re-notify a
   card still inside its look-back (the floor holds the invariant end to end)
"""

import datetime
from io import StringIO

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase, override_settings
from django.utils import timezone

from accounts.models import User
from boards.models import Card, Column, Notification, Swimlane
from boards.tests.conftest import _make_board


class PruneNotificationsTest(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="prune_owner", password="pass")
        self.board = _make_board(self.user)

    def _notif(self, days_old, read=False):
        n = Notification.objects.create(
            recipient=self.user,
            action_type=Notification.ActionType.ASSIGNED,
            verb="assigned you",
            board=self.board,
            read=read,
        )
        # auto_now_add ignores an assigned value, so rewrite the row directly.
        Notification.objects.filter(pk=n.pk).update(
            created_at=timezone.now() - datetime.timedelta(days=days_old)
        )
        return n

    def test_deletes_read_and_unread_past_the_window_and_keeps_fresh(self):
        old_read = self._notif(120, read=True)
        old_unread = self._notif(120, read=False)
        fresh = self._notif(10)

        out = StringIO()
        call_command("prune_notifications", stdout=out)

        self.assertFalse(Notification.objects.filter(pk=old_read.pk).exists())
        self.assertFalse(Notification.objects.filter(pk=old_unread.pk).exists())
        self.assertTrue(Notification.objects.filter(pk=fresh.pk).exists())
        self.assertIn("Deleted 2 notification(s)", out.getvalue())

    def test_dry_run_deletes_nothing(self):
        old = self._notif(120)
        out = StringIO()
        call_command("prune_notifications", "--dry-run", stdout=out)
        self.assertTrue(Notification.objects.filter(pk=old.pk).exists())
        self.assertIn("Would delete 1 notification(s)", out.getvalue())

    def test_days_override(self):
        old = self._notif(30)
        call_command("prune_notifications", stdout=StringIO())  # 90-day default keeps it
        self.assertTrue(Notification.objects.filter(pk=old.pk).exists())
        call_command("prune_notifications", "--days", "20", stdout=StringIO())
        self.assertFalse(Notification.objects.filter(pk=old.pk).exists())

    @override_settings(NOTIFICATION_RETENTION_DAYS=20)
    def test_setting_sets_the_default_window(self):
        old = self._notif(30)
        call_command("prune_notifications", stdout=StringIO())
        self.assertFalse(Notification.objects.filter(pk=old.pk).exists())

    def test_days_below_floor_is_refused(self):
        old = self._notif(120)
        with self.assertRaisesMessage(CommandError, "at least 14 days"):
            call_command("prune_notifications", "--days", "13")
        self.assertTrue(Notification.objects.filter(pk=old.pk).exists())

    @override_settings(NOTIFICATION_RETENTION_DAYS=1)
    def test_setting_below_floor_is_refused(self):
        with self.assertRaisesMessage(CommandError, "at least 14 days"):
            call_command("prune_notifications")

    def test_batch_size_must_be_positive(self):
        with self.assertRaisesMessage(CommandError, "--batch-size"):
            call_command("prune_notifications", "--batch-size", "0")

    def test_pages_through_multiple_batches(self):
        old = [self._notif(120) for _ in range(7)]
        fresh = self._notif(1)
        out = StringIO()
        call_command("prune_notifications", "--batch-size", "3", stdout=out)
        self.assertFalse(Notification.objects.filter(pk__in=[n.pk for n in old]).exists())
        self.assertTrue(Notification.objects.filter(pk=fresh.pk).exists())
        self.assertIn("Deleted 7 notification(s)", out.getvalue())

    def test_exact_multiple_of_batch_size(self):
        # len(ids) == batch_size on the last full batch must still terminate
        # and delete everything — the loop exits on the following empty page.
        for _ in range(6):
            self._notif(120)
        call_command("prune_notifications", "--batch-size", "3", stdout=StringIO())
        self.assertEqual(Notification.objects.count(), 0)


class PruneKeepsDueSoonDedupTest(TestCase):
    """The floor exists so a prune can never erase a record a scan still reads."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="due_prune", password="pass", notif_due_soon=True
        )
        self.board = _make_board(self.user)
        col = Column.objects.create(board=self.board, name="Todo", position=0)
        lane = Swimlane.objects.create(board=self.board, name="Default", position=0)
        self.card = Card.objects.create(
            board=self.board, column=col, swimlane=lane, title="Ship it",
            created_by=self.user, assignee=self.user, position=0,
            due_date=timezone.localdate() + datetime.timedelta(days=1),
        )

    def test_prune_at_the_floor_does_not_cause_a_repeat_due_soon(self):
        call_command("notify_due_soon", stdout=StringIO())
        self.assertEqual(
            Notification.objects.filter(action_type=Notification.ActionType.DUE_SOON).count(), 1
        )
        call_command("prune_notifications", "--days", "14", stdout=StringIO())
        call_command("notify_due_soon", stdout=StringIO())
        self.assertEqual(
            Notification.objects.filter(action_type=Notification.ActionType.DUE_SOON).count(), 1
        )
