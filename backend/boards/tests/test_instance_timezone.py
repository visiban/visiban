"""INSTANCE_TIMEZONE: one "today" for overdue, due soon and auto health (#2312).

All tests freeze the clock at 2026-03-11T03:00Z, which is still the evening of
2026-03-10 in Los Angeles (UTC-7 under DST) and already midday 2026-03-11 in
Tokyo. A card due 2026-03-10 therefore is overdue in UTC and Tokyo but not in
Los Angeles.
"""

import datetime
import subprocess
import sys
from io import StringIO
from unittest.mock import patch

from django.core.management import call_command
from django.test import TestCase, override_settings

from boards.card_signals import overdue_q, signal_today
from boards.models import BoardMembership, Card, Notification, Swimlane
from boards.services.health_compute import lane_counts
from boards.tests.conftest import _make_board, _make_card, _make_column, _make_user

FROZEN = datetime.datetime(2026, 3, 11, 3, 0, tzinfo=datetime.timezone.utc)
DUE = datetime.date(2026, 3, 10)


def _frozen():
    return patch("django.utils.timezone.now", return_value=FROZEN)


class SignalTodayTests(TestCase):
    def test_default_is_utc(self):
        with _frozen():
            self.assertEqual(signal_today(), datetime.date(2026, 3, 11))

    def test_zone_moves_the_day_boundary(self):
        with _frozen():
            with override_settings(INSTANCE_TIMEZONE="America/Los_Angeles"):
                self.assertEqual(signal_today(), datetime.date(2026, 3, 10))
            with override_settings(INSTANCE_TIMEZONE="Asia/Tokyo"):
                self.assertEqual(signal_today(), datetime.date(2026, 3, 11))

    def test_independent_of_django_time_zone(self):
        with _frozen(), override_settings(TIME_ZONE="Asia/Tokyo", INSTANCE_TIMEZONE="America/Los_Angeles"):
            self.assertEqual(signal_today(), datetime.date(2026, 3, 10))


class DateSignalsTests(TestCase):
    def setUp(self):
        owner = _make_user()
        self.board = _make_board(owner)
        self.col = _make_column(self.board)
        self.lane = Swimlane.objects.create(board=self.board, name="Lane", position=0)
        self.assignee = _make_user(notif_due_soon=True)
        BoardMembership.objects.create(
            board=self.board, user=self.assignee, role=BoardMembership.Role.MEMBER
        )
        self.card = _make_card(self.col, self.lane, due_date=DUE, assignee=self.assignee)

    def _overdue(self):
        return Card.objects.filter(overdue_q(signal_today()), pk=self.card.pk).exists()

    def _auto_health_overdue(self):
        return lane_counts(self.board).get(self.lane.pk, {}).get("overdue", 0)

    def _due_soon_notified(self):
        Notification.objects.all().delete()
        call_command("notify_due_soon", stdout=StringIO())
        return Notification.objects.filter(recipient=self.assignee).exists()

    def test_default_utc_matches_prior_behavior(self):
        with _frozen():
            self.assertTrue(self._overdue())
            self.assertEqual(self._auto_health_overdue(), 1)
            # Due yesterday in UTC: outside the due-soon window.
            self.assertFalse(self._due_soon_notified())

    @override_settings(INSTANCE_TIMEZONE="America/Los_Angeles")
    def test_los_angeles_card_still_due_today(self):
        with _frozen():
            self.assertFalse(self._overdue())
            self.assertEqual(self._auto_health_overdue(), 0)
            self.assertTrue(self._due_soon_notified())

    @override_settings(INSTANCE_TIMEZONE="Asia/Tokyo")
    def test_tokyo_card_is_overdue(self):
        with _frozen():
            self.assertTrue(self._overdue())
            self.assertEqual(self._auto_health_overdue(), 1)
            self.assertFalse(self._due_soon_notified())

    @override_settings(INSTANCE_TIMEZONE="America/Los_Angeles")
    def test_overdue_filter_endpoint_uses_instance_zone(self):
        from rest_framework.test import APIClient

        client = APIClient()
        client.force_authenticate(self.board.owner)
        with _frozen():
            resp = client.get(f"/api/v1/boards/{self.board.pk}/cards/", {"overdue": "true"})
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json(), [])


class DueSoonIdempotencyTests(TestCase):
    """The once-per-card rule must use the instance zone's midnight (#2312).

    East of UTC, the previous UTC-midnight anchor sat after the first run's
    notification on the next day, so the second daily run notified again.
    """

    @override_settings(INSTANCE_TIMEZONE="Asia/Tokyo")
    def test_tokyo_daily_runs_notify_once(self):
        owner = _make_user()
        board = _make_board(owner)
        col = _make_column(board)
        lane = Swimlane.objects.create(board=board, name="Lane", position=0)
        assignee = _make_user(notif_due_soon=True)
        BoardMembership.objects.create(board=board, user=assignee, role=BoardMembership.Role.MEMBER)
        # 2026-03-10T16:00Z is 03-11 in Tokyo; with the default 1-day horizon a
        # card due 03-12 is in the window on both runs (Tokyo 03-11 and 03-12).
        _make_card(col, lane, due_date=datetime.date(2026, 3, 12), assignee=assignee)
        for day in (10, 11):
            now = datetime.datetime(2026, 3, day, 16, 0, tzinfo=datetime.timezone.utc)
            with patch("django.utils.timezone.now", return_value=now):
                call_command("notify_due_soon", stdout=StringIO())
        # Notification.created_at is auto_now_add, so it was stamped with the patched clock.
        self.assertEqual(Notification.objects.filter(recipient=assignee).count(), 1)


class DueSoonOpenCardsOnlyTests(TestCase):
    """A card in a done column carries no Due soon status, so no notification (#2313)."""

    def test_done_column_card_is_not_notified_but_open_one_is(self):
        owner = _make_user()
        board = _make_board(owner)
        open_col = _make_column(board)
        done_col = _make_column(board, name="Done", order=1, is_done=True)
        lane = Swimlane.objects.create(board=board, name="Lane", position=0)
        assignee = _make_user(notif_due_soon=True)
        BoardMembership.objects.create(board=board, user=assignee, role=BoardMembership.Role.MEMBER)
        due = datetime.date(2026, 3, 11)
        open_card = _make_card(open_col, lane, due_date=due, assignee=assignee, title="Open one")
        done_card = _make_card(done_col, lane, due_date=due, assignee=assignee, title="Done one")
        with _frozen():
            call_command("notify_due_soon", stdout=StringIO())
        notified = Notification.objects.filter(recipient=assignee)
        self.assertTrue(notified.filter(card=open_card).exists())
        self.assertFalse(notified.filter(card=done_card).exists())


class InvalidZoneSettingTests(TestCase):
    def test_invalid_zone_fails_startup_loudly(self):
        code = "import django.conf; django.conf.settings.INSTANCE_TIMEZONE"
        proc = subprocess.run(
            [sys.executable, "-c", code],
            env={**__import__("os").environ, "DJANGO_SETTINGS_MODULE": "visiban.settings",
                 "INSTANCE_TIMEZONE": "Mars/Olympus_Mons"},
            capture_output=True, text=True, cwd=str(__import__("pathlib").Path(__file__).resolve().parents[2]),
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("INSTANCE_TIMEZONE", proc.stderr)
        self.assertIn("not a valid IANA time zone", proc.stderr)

    def test_valid_zone_loads(self):
        code = "import django.conf; print(django.conf.settings.INSTANCE_TIMEZONE)"
        proc = subprocess.run(
            [sys.executable, "-c", code],
            env={**__import__("os").environ, "DJANGO_SETTINGS_MODULE": "visiban.settings",
                 "INSTANCE_TIMEZONE": "Asia/Tokyo"},
            capture_output=True, text=True, cwd=str(__import__("pathlib").Path(__file__).resolve().parents[2]),
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), "Asia/Tokyo")
