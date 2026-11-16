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
from django.utils import timezone

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
            resp = client.get(f"/api/boards/{self.board.pk}/cards/", {"overdue": "true"})
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        results = body["results"] if isinstance(body, dict) and "results" in body else body
        self.assertEqual([c["id"] for c in results], [])


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
