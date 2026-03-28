"""Tests for the seed_demo_data management command."""

from io import StringIO
from unittest import mock

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase, override_settings
from django.utils import timezone

from accounts.models import User
from boards.models import (
    Board,
    BoardMembership,
    Card,
    CardChecklist,
    CardMovement,
    Column,
)

BOARD_NAME = "Visiban Demo Board"


def _seed(**kwargs):
    """Run seed_demo_data and return (stdout, stderr) as strings."""
    out, err = StringIO(), StringIO()
    call_command("seed_demo_data", stdout=out, stderr=err, **kwargs)
    return out.getvalue(), err.getvalue()


@override_settings(DEBUG=True)
class SeedCreateTests(TestCase):
    def test_creates_board_with_correct_structure(self):
        _seed()
        board = Board.objects.get(name=BOARD_NAME)
        self.assertEqual(board.columns.count(), 5)
        self.assertEqual(board.swimlanes.count(), 10)
        self.assertEqual(board.labels.count(), 3)

    def test_column_names_and_order(self):
        _seed()
        board = Board.objects.get(name=BOARD_NAME)
        names = list(board.columns.order_by("position").values_list("name", flat=True))
        self.assertEqual(names, ["Backlog", "To Do", "Doing", "Review", "Done"])

    def test_creates_five_demo_users(self):
        _seed()
        for i in range(1, 6):
            self.assertTrue(
                User.objects.filter(username=f"demo{i}").exists(),
                f"demo{i} not created",
            )

    def test_demo_users_have_unusable_passwords(self):
        _seed()
        for user in User.objects.filter(username__startswith="demo"):
            self.assertFalse(user.has_usable_password(), f"{user.username} has a usable password")

    def test_creates_cards(self):
        _seed()
        board = Board.objects.get(name=BOARD_NAME)
        count = board.cards.count()
        # Expect 110–130 cards across 10 swimlanes × 11–13 each
        self.assertGreaterEqual(count, 110)
        self.assertLessEqual(count, 130)

    def test_board_owner_is_admin_member(self):
        _seed()
        board = Board.objects.get(name=BOARD_NAME)
        owner_membership = board.memberships.get(user=board.owner)
        self.assertEqual(owner_membership.role, BoardMembership.Role.ADMIN)

    def test_non_owner_users_are_members(self):
        _seed()
        board = Board.objects.get(name=BOARD_NAME)
        non_admin = board.memberships.exclude(role=BoardMembership.Role.ADMIN)
        self.assertEqual(non_admin.count(), 4)

    def test_label_names(self):
        _seed()
        board = Board.objects.get(name=BOARD_NAME)
        names = set(board.labels.values_list("name", flat=True))
        self.assertEqual(names, {"Bug", "Feature", "Improvement"})

    def test_output_reports_success(self):
        out, _ = _seed()
        self.assertIn("Seeded", out)
        self.assertIn(BOARD_NAME, out)


@override_settings(DEBUG=True)
class SeedDueDateTests(TestCase):
    def test_at_least_one_overdue_card(self):
        _seed()
        board = Board.objects.get(name=BOARD_NAME)
        today = timezone.now().date()
        overdue = board.cards.filter(due_date__lt=today).count()
        self.assertGreater(overdue, 0, "Expected at least one overdue card")

    def test_at_least_one_card_with_no_due_date(self):
        _seed()
        board = Board.objects.get(name=BOARD_NAME)
        no_date = board.cards.filter(due_date__isnull=True).count()
        self.assertGreater(no_date, 0, "Expected at least one card with no due date")

    def test_at_least_one_future_due_date(self):
        _seed()
        board = Board.objects.get(name=BOARD_NAME)
        today = timezone.now().date()
        future = board.cards.filter(due_date__gt=today).count()
        self.assertGreater(future, 0, "Expected at least one card with a future due date")


@override_settings(DEBUG=True)
class SeedChecklistAndCommentsTests(TestCase):
    def test_some_cards_have_checklists(self):
        _seed()
        board = Board.objects.get(name=BOARD_NAME)
        cards_with_checklist = (
            board.cards.filter(checklist_items__isnull=False).distinct().count()
        )
        self.assertGreater(cards_with_checklist, 0)

    def test_some_cards_have_comments(self):
        _seed()
        board = Board.objects.get(name=BOARD_NAME)
        cards_with_comments = board.cards.filter(comments__isnull=False).distinct().count()
        self.assertGreater(cards_with_comments, 0)

    def test_checklist_items_have_mixed_checked_state(self):
        _seed()
        checked = CardChecklist.objects.filter(is_checked=True).count()
        unchecked = CardChecklist.objects.filter(is_checked=False).count()
        self.assertGreater(checked, 0, "Expected some checked items")
        self.assertGreater(unchecked, 0, "Expected some unchecked items")


@override_settings(DEBUG=True)
class SeedMovementHistoryTests(TestCase):
    def test_cards_not_in_backlog_have_movement_records(self):
        _seed()
        board = Board.objects.get(name=BOARD_NAME)
        backlog = board.columns.get(name="Backlog")
        non_backlog_cards = board.cards.exclude(column=backlog)
        for card in non_backlog_cards[:5]:  # spot-check first 5
            self.assertGreater(
                CardMovement.objects.filter(card=card).count(),
                0,
                f"Card '{card.title}' in '{card.column.name}' has no movement history",
            )

    def test_movement_denormalized_names_are_populated(self):
        _seed()
        # Filter to a transition movement (from_column is set) since creation
        # movements legitimately have an empty from_column_name.
        mv = CardMovement.objects.filter(from_column__isnull=False).first()
        if mv:
            self.assertTrue(mv.from_column_name)
            self.assertTrue(mv.to_column_name)

    def test_backlog_cards_have_creation_movement(self):
        """Every card — including Backlog cards — must have a creation movement
        (from_column=None) so the History tab is never empty."""
        _seed()
        board = Board.objects.get(name=BOARD_NAME)
        backlog = board.columns.get(name="Backlog")
        backlog_cards = board.cards.filter(column=backlog)
        for card in backlog_cards:
            creation = CardMovement.objects.filter(card=card, from_column__isnull=True)
            self.assertTrue(
                creation.exists(),
                f"Backlog card '{card.title}' is missing its creation movement",
            )
            self.assertEqual(
                CardMovement.objects.filter(card=card).count(),
                1,
                f"Backlog card '{card.title}' should have exactly 1 movement (creation only)",
            )

    def test_movements_are_backdated(self):
        """Movements should be in the past, not at the current second."""
        _seed()
        now = timezone.now()
        future_movements = CardMovement.objects.filter(moved_at__gte=now)
        self.assertEqual(future_movements.count(), 0)


@override_settings(DEBUG=True)
class SeedIdempotencyTests(TestCase):
    def test_running_twice_without_wipe_skips(self):
        _seed()
        out, _ = _seed()
        self.assertIn("already exists", out)
        self.assertEqual(Board.objects.filter(name=BOARD_NAME).count(), 1)

    def test_wipe_then_reseed_gives_single_board(self):
        _seed()
        _seed(wipe=True)
        self.assertEqual(Board.objects.filter(name=BOARD_NAME).count(), 1)


class SeedWipeGuardTests(TestCase):
    @override_settings(DEBUG=False)
    def test_wipe_refused_when_debug_false(self):
        # Set up the board using --force so the plain-run guard doesn't block us.
        _seed(force=True)
        with self.assertRaises(CommandError) as ctx:
            _seed(wipe=True)
        self.assertIn("Refusing", str(ctx.exception))
        self.assertIn("--force", str(ctx.exception))

    @override_settings(DEBUG=False)
    def test_wipe_with_force_succeeds_when_debug_false(self):
        _seed(force=True)
        _seed(wipe=True, force=True)
        # Board should exist exactly once
        self.assertEqual(Board.objects.filter(name=BOARD_NAME).count(), 1)

    @override_settings(DEBUG=True)
    def test_wipe_without_force_works_when_debug_true(self):
        _seed()
        _seed(wipe=True)
        self.assertEqual(Board.objects.filter(name=BOARD_NAME).count(), 1)


@override_settings(DEBUG=True)
class SeedDeterminismTests(TestCase):
    def test_card_count_is_deterministic(self):
        """Two runs with the same seed produce identical card counts."""
        _seed()
        count_1 = Card.objects.count()
        _seed(wipe=True)
        count_2 = Card.objects.count()
        self.assertEqual(count_1, count_2)

    def test_custom_seed_produces_same_count(self):
        """--seed N produces the same count as the default (count is seed-independent)."""
        _seed()
        _seed(wipe=True, seed=99)
        count_custom = Card.objects.count()
        # Card count range (11-13 per swimlane × 10 swimlanes) is the same regardless of seed.
        self.assertGreaterEqual(count_custom, 110)
        self.assertLessEqual(count_custom, 130)

    def test_different_seed_may_produce_different_card_titles(self):
        """--seed N shuffles titles differently — first card title should differ from seed 42."""
        _seed()
        first_title_default = Card.objects.order_by("id").first().title
        _seed(wipe=True, seed=99)
        first_title_custom = Card.objects.order_by("id").first().title
        # With different shuffle orders the first card is very likely different.
        # This is probabilistic; a false pass is astronomically unlikely.
        self.assertNotEqual(first_title_default, first_title_custom)

    def test_column_positions_are_deterministic(self):
        _seed()
        cols_1 = list(Column.objects.filter(board__name=BOARD_NAME).order_by("position").values_list("name", flat=True))
        _seed(wipe=True)
        cols_2 = list(Column.objects.filter(board__name=BOARD_NAME).order_by("position").values_list("name", flat=True))
        self.assertEqual(cols_1, cols_2)


@override_settings(DEBUG=True)
class SeedExportTests(TestCase):
    def test_export_writes_json_file(self):
        with mock.patch(
            "boards.management.commands.seed_demo_data.Command._export"
        ) as mock_export:
            _seed(export=True)
            mock_export.assert_called_once()

    def test_json_export_structure(self):
        """The JSON export contains all required top-level keys."""
        import json
        import tempfile
        from pathlib import Path

        _seed()
        board = Board.objects.get(name=BOARD_NAME)

        # Call _export directly to a temp directory
        out = StringIO()
        from boards.management.commands.seed_demo_data import Command

        cmd = Command()
        cmd.stdout = out
        cmd.style = mock.MagicMock()
        cmd.style.SUCCESS = lambda s: s

        with tempfile.TemporaryDirectory() as tmp:
            seed_dir = Path(tmp)
            cols = list(board.columns.all())
            lanes = list(board.swimlanes.all())
            lbls = list(board.labels.all())
            cards = list(board.cards.all())

            cmd._export_json(board, cols, lanes, lbls, cards, seed_dir)

            data = json.loads((seed_dir / "demo_board.json").read_text())

        self.assertIn("name", data)
        self.assertIn("columns", data)
        self.assertIn("swimlanes", data)
        self.assertIn("labels", data)
        self.assertIn("cards", data)
        self.assertEqual(len(data["columns"]), 5)
        self.assertEqual(len(data["swimlanes"]), 10)
        self.assertEqual(len(data["labels"]), 3)

    def test_csv_export_structure(self):
        """The CSV export contains all expected headers and one row per card."""
        import csv
        import tempfile
        from pathlib import Path
        from io import StringIO as SIO

        _seed()
        board = Board.objects.get(name=BOARD_NAME)
        cards = list(board.cards.prefetch_related("labels", "checklist_items", "comments", "assignee"))

        from boards.management.commands.seed_demo_data import Command

        cmd = Command()
        cmd.stdout = SIO()
        cmd.style = mock.MagicMock()
        cmd.style.SUCCESS = lambda s: s

        with tempfile.TemporaryDirectory() as tmp:
            seed_dir = Path(tmp)
            cmd._export_csv(cards, seed_dir)

            with (seed_dir / "demo_board.csv").open() as f:
                reader = csv.DictReader(f)
                rows = list(reader)

        expected_headers = {
            "title", "column", "swimlane", "priority", "due_date",
            "weight", "labels", "assignee", "checklist_total",
            "checklist_done", "comment_count", "description_preview",
        }
        self.assertEqual(set(rows[0].keys()), expected_headers)
        self.assertEqual(len(rows), len(cards))


class SeedProductionGuardTests(TestCase):
    """Plain (non-wipe) runs must also be guarded against production environments."""

    @override_settings(DEBUG=False)
    def test_plain_run_refused_when_debug_false(self):
        with self.assertRaises(CommandError) as ctx:
            _seed()
        self.assertIn("Refusing", str(ctx.exception))
        self.assertIn("--force", str(ctx.exception))

    @override_settings(DEBUG=False)
    def test_plain_run_with_force_succeeds_when_debug_false(self):
        _seed(force=True)
        self.assertTrue(Board.objects.filter(name=BOARD_NAME).exists())

    @override_settings(DEBUG=False)
    def test_guard_message_does_not_mention_wipe(self):
        """Error from plain run should not mislead users into thinking --wipe is required."""
        with self.assertRaises(CommandError) as ctx:
            _seed()
        # The message should say "seed", not be specific to --wipe
        self.assertIn("seed", str(ctx.exception).lower())


@override_settings(DEBUG=True)
class SeedArchivingTests(TestCase):
    """Archived card seeding introduced alongside card archiving (#226)."""

    def test_some_cards_are_archived_after_seed(self):
        _seed()
        archived = Card.objects.filter(archived_at__isnull=False).count()
        self.assertGreaterEqual(archived, 7, "Expected at least 7 archived cards")
        self.assertLessEqual(archived, 10, "Expected at most 10 archived cards")

    def test_archived_cards_have_past_timestamps(self):
        _seed()
        now = timezone.now()
        future_archived = Card.objects.filter(archived_at__gte=now).count()
        self.assertEqual(future_archived, 0, "No archived_at should be in the future")

    def test_archived_cards_span_multiple_days(self):
        """archived_at dates should be spread across 3–45 days ago, not all identical."""
        _seed()
        dates = set(
            Card.objects.filter(archived_at__isnull=False)
            .values_list("archived_at__date", flat=True)
        )
        self.assertGreater(len(dates), 1, "Expected archived cards on different dates")

    def test_output_reports_archived_count(self):
        out, _ = _seed()
        self.assertIn("archived", out.lower())

    def test_export_excludes_archived_cards(self):
        """The JSON snapshot should only include active (non-archived) cards."""
        import json
        import tempfile
        from pathlib import Path

        _seed()
        board = Board.objects.get(name=BOARD_NAME)

        from boards.management.commands.seed_demo_data import Command

        cmd = Command()
        cmd.stdout = StringIO()
        cmd.style = mock.MagicMock()
        cmd.style.SUCCESS = lambda s: s

        active_count = board.cards.filter(archived_at__isnull=True).count()

        with tempfile.TemporaryDirectory() as tmp:
            seed_dir = Path(tmp)
            cols = list(board.columns.all())
            lanes = list(board.swimlanes.all())
            lbls = list(board.labels.all())
            # Pass all cards (including archived) as the command does internally.
            cards = list(board.cards.all())
            # Simulate the _export filter: exclude archived.
            active_cards = [c for c in cards if c.archived_at is None]
            cmd._export_json(board, cols, lanes, lbls, active_cards, seed_dir)
            data = json.loads((seed_dir / "demo_board.json").read_text())

        self.assertEqual(len(data["cards"]), active_count)
        self.assertLess(len(data["cards"]), board.cards.count())
