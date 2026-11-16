"""``manage.py compute_health_status`` (#2245): the nightly auto health run."""

import datetime
from io import StringIO
from unittest.mock import patch

from django.core.management import CommandError, call_command
from django.test import TestCase
from django.utils import timezone

from boards.models import Board, BoardHealthChange, Swimlane
from boards.tests.conftest import _make_board, _make_card, _make_column, _make_user


class ComputeHealthStatusCommandTests(TestCase):
    def setUp(self):
        owner = _make_user("chs_owner")
        self.auto = _make_board(owner, "Auto", health_auto_enabled=True)
        self.manual = _make_board(owner, "Manual")
        for board in (self.auto, self.manual):
            column = _make_column(board, "Todo")
            lane = Swimlane.objects.create(board=board, name="Acme", position=0)
            _make_card(column, lane, due_date=timezone.localdate() - datetime.timedelta(days=1))

    def test_computes_auto_boards_only(self):
        out = StringIO()
        call_command("compute_health_status", stdout=out)
        self.auto.refresh_from_db()
        self.manual.refresh_from_db()
        self.assertEqual(self.auto.computed_health_status, "at_risk")
        self.assertIsNone(self.manual.computed_health_status)
        self.assertIsNone(self.manual.health_computed_at)
        self.assertIn("Computed health for 1 board(s)", out.getvalue())

    def test_rerun_records_no_second_history_row(self):
        call_command("compute_health_status", stdout=StringIO())
        call_command("compute_health_status", stdout=StringIO())
        self.assertEqual(BoardHealthChange.objects.filter(board=self.auto).count(), 1)

    def test_failing_board_does_not_stop_the_rest_and_exits_nonzero(self):
        second = _make_board(_make_user("chs_two"), "Auto 2", health_auto_enabled=True)
        from boards.services import health_compute

        real = health_compute.compute_board_health

        def flaky(board_id, **kwargs):
            if board_id == self.auto.pk:
                raise RuntimeError("boom")
            return real(board_id, **kwargs)

        with patch("boards.management.commands.compute_health_status.compute_board_health", side_effect=flaky):
            with self.assertRaises(CommandError):
                call_command("compute_health_status", stdout=StringIO())
        second.refresh_from_db()
        self.assertIsNotNone(second.health_computed_at)
        self.assertIsNone(Board.objects.get(pk=self.auto.pk).health_computed_at)
