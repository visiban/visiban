"""One-shot notification commands wait for their async email before exiting (#2077).

``create_notifications`` sends mail on a daemon thread when
``NOTIFICATION_EMAIL_ASYNC`` is on (the default). Most suites pin it off, which
hides the fault: a command that returns straight away ends the process and kills
the thread mid-send. These tests run with it ON and a deliberately slow send, so
a command that does not wait leaves ``sent`` empty at the moment it returns.

TransactionTestCase, not TestCase: the send thread calls ``connections.close_all()``
and must not share the test's wrapped connection.
"""

import datetime
import threading
import time
from io import StringIO
from unittest.mock import patch

from django.core.management import call_command
from django.test import TransactionTestCase, override_settings
from django.utils import timezone

from accounts.models import User
from boards.models import Board, BoardMembership, Card, Column, Swimlane
from boards.notifications_email import EMAIL_THREAD_NAME, drain_email_on_exit


def _slow_send(sent):
    def send(messages, ids):
        time.sleep(0.5)
        sent.extend(messages)
        return len(messages)

    return send


@override_settings(NOTIFICATION_EMAIL_ASYNC=True)
class DueSoonDrainTests(TransactionTestCase):
    def setUp(self):
        owner = User.objects.create_user(username="drain_owner", password="pass")
        assignee = User.objects.create_user(
            username="drain_assignee", password="pass", email="drain@example.test",
            notif_due_soon=True, email_notif_due_soon=True,
        )
        board = Board.objects.create(name="Drain", owner=owner)
        BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
        BoardMembership.objects.create(board=board, user=assignee, role=BoardMembership.Role.MEMBER)
        col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
        swim = Swimlane.objects.create(board=board, name="General", position=0)
        Card.objects.create(
            board=board, column=col, swimlane=swim, title="Due", created_by=owner,
            position=0, assignee=assignee,
            due_date=timezone.localdate() + datetime.timedelta(days=1),
        )

    def test_notify_due_soon_waits_for_the_email(self):
        sent = []
        with patch("boards.notifications_email._send_batch", _slow_send(sent)):
            call_command("notify_due_soon", stdout=StringIO())
            # This is the moment a cron-run process would exit.
            self.assertEqual(len(sent), 1)

    def test_a_slow_relay_is_reported_not_silent(self):
        release = threading.Event()
        thread = threading.Thread(target=release.wait, name=EMAIL_THREAD_NAME, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(release.set)
        err = StringIO()
        with patch("boards.notifications_email.EMAIL_DRAIN_SECONDS", 0.05):
            with drain_email_on_exit(err):
                pass
        self.assertIn("may be lost", err.getvalue())

    def test_drain_runs_when_the_work_raises(self):
        with patch("boards.notifications_email.wait_for_pending_email", return_value=True) as wait:
            with self.assertRaises(RuntimeError):
                with drain_email_on_exit(StringIO()):
                    raise RuntimeError("boom")
        wait.assert_called_once()


@override_settings(NOTIFICATION_EMAIL_ASYNC=True)
class OtherCommandsDrainTests(TransactionTestCase):
    """Commands with no email path today still drain, so adding one cannot regress."""

    def test_notify_stale_cards_drains(self):
        with patch("boards.notifications_email.wait_for_pending_email", return_value=True) as wait:
            call_command("notify_stale_cards", verbosity=0)
        wait.assert_called_once()

    def test_notify_due_soon_drains_on_the_empty_early_return(self):
        with patch("boards.notifications_email.wait_for_pending_email", return_value=True) as wait:
            call_command("notify_due_soon", stdout=StringIO())
        wait.assert_called_once()

    def test_run_scheduler_drains_when_it_stops(self):
        from boards.management.commands import run_scheduler

        class _Stopped:
            def wait(self, _):
                return True

        with patch.dict("os.environ", {"SCHEDULE_NOTIFY_DUE_SOON": "off", "SCHEDULE_NOTIFY_STALE_CARDS": "08:00"}), \
                patch.object(run_scheduler.threading, "Event", _Stopped), \
                patch("boards.notifications_email.wait_for_pending_email", return_value=True) as wait:
            call_command("run_scheduler", stdout=StringIO())
        wait.assert_called_once()
