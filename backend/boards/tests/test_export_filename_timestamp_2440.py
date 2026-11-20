"""Export filenames carry ``slug-YYYYMMDD-HHMM`` in the user's timezone (#2440)."""

import datetime
from unittest import mock

from django.core.cache import cache
from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership

Role = BoardMembership.Role

# 2026-11-20 02:30 UTC is still 2026-11-19 21:30 in New York (UTC-5).
PINNED = datetime.datetime(2026, 11, 20, 2, 30, 45, tzinfo=datetime.timezone.utc)


class ExportFilenameTimestampTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(username="owner", password="x")
        self.board = Board.objects.create(name="My Board", owner=self.user)
        BoardMembership.objects.create(
            board=self.board, user=self.user, role=Role.ADMIN
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def disposition(self, fmt, tz=None):
        if tz is not None:
            self.user.timezone = tz
            self.user.save()
        cache.clear()
        params = {"format": fmt} if fmt == "json" else {}
        with mock.patch(
            "boards.views.import_export.django_timezone.now", return_value=PINNED
        ):
            resp = self.client.get(f"/api/v1/boards/{self.board.id}/export/", params)
        self.assertEqual(resp.status_code, 200)
        return resp["Content-Disposition"]

    def test_user_timezone_local_date_differs_from_utc(self):
        for fmt in ("json", "csv"):
            self.assertEqual(
                self.disposition(fmt, "America/New_York"),
                f'attachment; filename="my-board-20261119-2130.{fmt}"',
            )

    def test_blank_timezone_falls_back_to_utc(self):
        for fmt in ("json", "csv"):
            self.assertEqual(
                self.disposition(fmt, ""),
                f'attachment; filename="my-board-20261120-0230.{fmt}"',
            )

    def test_invalid_timezone_falls_back_to_utc(self):
        for bad in ("Not/AZone", '../etc"x\r\nX: y', "\x00"):
            for fmt in ("json", "csv"):
                self.assertEqual(
                    self.disposition(fmt, bad),
                    f'attachment; filename="my-board-20261120-0230.{fmt}"',
                )

    def test_empty_slug_falls_back_to_board(self):
        self.board.name = "!!!"
        self.board.save()
        for fmt in ("json", "csv"):
            self.assertEqual(
                self.disposition(fmt, "Asia/Tokyo"),
                f'attachment; filename="board-20261120-1130.{fmt}"',
            )

    def test_stamp_reads_the_clock_once_per_export(self):
        # A second now() call could land after midnight and split date from time.
        # Call the helper directly: the patch targets the shared django.utils.timezone
        # module, so other request-path callers would inflate call_count.
        from boards.views.import_export import _export_timestamp

        self.user.timezone = "America/New_York"
        later = [PINNED + datetime.timedelta(days=d) for d in (1, 2)]
        with mock.patch(
            "boards.views.import_export.django_timezone.now",
            side_effect=[PINNED, *later],
        ) as now:
            stamp = _export_timestamp(self.user)
        self.assertEqual(stamp, "20261119-2130")
        self.assertEqual(now.call_count, 1)
