"""Tests for the seed_template_boards management command."""

import json
import tempfile
from io import StringIO
from pathlib import Path
from unittest import mock

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase, override_settings

from accounts.models import User
from boards.models import (
    Board,
    BoardMembership,
    Card,
    CardChecklist,
    CardComment,
    CardMovement,
    Column,
    Label,
    Swimlane,
)
from boards.management.commands.seed_template_boards import TEMPLATE_DATA, VALID_SLUGS


def _seed(template="sales_pipeline", **kwargs):
    """Run seed_template_boards and return stdout as a string."""
    out, err = StringIO(), StringIO()
    call_command("seed_template_boards", template=template, stdout=out, stderr=err, **kwargs)
    return out.getvalue(), err.getvalue()


# ---------------------------------------------------------------------------
# Board structure
# ---------------------------------------------------------------------------

@override_settings(DEBUG=True)
class SeedStructureTests(TestCase):
    """Spot-check sales_pipeline board structure after seeding."""

    def setUp(self):
        _seed("sales_pipeline")
        self.board = Board.objects.get(name="Template: Sales Pipeline")

    def test_correct_column_count(self):
        self.assertEqual(self.board.columns.count(), 6)

    def test_column_names_and_order(self):
        names = list(
            self.board.columns.order_by("position").values_list("name", flat=True)
        )
        self.assertEqual(
            names,
            ["Lead", "Qualified", "Proposal Sent", "Negotiation", "Closed Won", "Closed Lost"],
        )

    def test_swimlane_count(self):
        self.assertEqual(self.board.swimlanes.count(), 5)

    def test_label_names(self):
        names = set(self.board.labels.values_list("name", flat=True))
        self.assertEqual(names, {"Enterprise", "SMB", "Strategic", "Renewal"})

    def test_cards_created(self):
        # sales_pipeline has 20 cards across 5 swimlanes
        self.assertGreaterEqual(self.board.cards.count(), 15)

    def test_board_owner_is_admin_member(self):
        membership = self.board.memberships.get(user=self.board.owner)
        self.assertEqual(membership.role, BoardMembership.Role.ADMIN)

    def test_four_non_admin_members(self):
        non_admin = self.board.memberships.exclude(role=BoardMembership.Role.ADMIN)
        self.assertEqual(non_admin.count(), 4)

    def test_output_reports_success(self):
        out, _ = _seed("sales_pipeline", wipe=True)
        self.assertIn("Seeded", out)
        self.assertIn("Template: Sales Pipeline", out)


# ---------------------------------------------------------------------------
# Demo users
# ---------------------------------------------------------------------------

@override_settings(DEBUG=True)
class SeedDemoUserTests(TestCase):
    def test_creates_five_demo_users(self):
        _seed("sales_pipeline")
        for i in range(1, 6):
            self.assertTrue(
                User.objects.filter(username=f"demo{i}").exists(),
                f"demo{i} not found",
            )

    def test_demo_users_have_unusable_passwords(self):
        _seed("sales_pipeline")
        for user in User.objects.filter(username__startswith="demo"):
            self.assertFalse(
                user.has_usable_password(),
                f"{user.username} has a usable password",
            )

    def test_second_template_reuses_existing_demo_users(self):
        _seed("sales_pipeline")
        user_count_before = User.objects.filter(username__startswith="demo").count()
        _seed("customer_support")
        user_count_after = User.objects.filter(username__startswith="demo").count()
        self.assertEqual(user_count_before, user_count_after)


# ---------------------------------------------------------------------------
# Card placement
# ---------------------------------------------------------------------------

@override_settings(DEBUG=True)
class SeedCardPlacementTests(TestCase):
    def setUp(self):
        _seed("sales_pipeline")
        self.board = Board.objects.get(name="Template: Sales Pipeline")

    def test_cards_land_in_specified_columns(self):
        """Cards are placed in the column matching their col_idx, not always column 0."""
        col_name_set = set(
            self.board.cards.values_list("column__name", flat=True)
        )
        # With 20 cards across 6 columns we should see at least 4 distinct columns.
        self.assertGreaterEqual(len(col_name_set), 4)

    def test_cards_not_all_in_leftmost_column(self):
        leftmost_col = self.board.columns.order_by("position").first()
        all_in_first = not self.board.cards.exclude(column=leftmost_col).exists()
        self.assertFalse(all_in_first, "All cards landed in the leftmost column")


# ---------------------------------------------------------------------------
# CardMovement history
# ---------------------------------------------------------------------------

@override_settings(DEBUG=True)
class SeedMovementHistoryTests(TestCase):
    def setUp(self):
        _seed("sales_pipeline")
        self.board = Board.objects.get(name="Template: Sales Pipeline")

    def test_every_card_has_at_least_one_movement(self):
        """Every card must have a creation movement so the History tab is never empty."""
        for card in self.board.cards.all():
            count = CardMovement.objects.filter(card=card).count()
            self.assertGreater(count, 0, f"'{card.title}' has no movement records")

    def test_col0_cards_have_exactly_one_movement(self):
        """Cards in column 0 should have only the creation movement."""
        leftmost = self.board.columns.order_by("position").first()
        for card in self.board.cards.filter(column=leftmost):
            count = CardMovement.objects.filter(card=card).count()
            self.assertEqual(count, 1, f"'{card.title}' in col 0 has {count} movements")

    def test_non_col0_cards_have_stage_movements(self):
        """Cards beyond column 0 must have one movement per stage transition."""
        leftmost = self.board.columns.order_by("position").first()
        non_col0_cards = self.board.cards.exclude(column=leftmost)
        for card in non_col0_cards[:5]:  # spot-check first 5
            # col_idx N → N creation + N stage movements = N+1 total
            col_pos = card.column.position
            expected = col_pos + 1  # creation + transitions
            actual = CardMovement.objects.filter(card=card).count()
            self.assertEqual(
                actual, expected,
                f"'{card.title}' (col_pos={col_pos}) has {actual} movements, expected {expected}",
            )

    def test_creation_movement_has_null_from_column(self):
        card = self.board.cards.first()
        creation = CardMovement.objects.filter(card=card, from_column__isnull=True)
        self.assertTrue(creation.exists(), "No creation movement (from_column=None) found")

    def test_stage_movements_have_denormalized_names(self):
        mv = CardMovement.objects.filter(
            card__board=self.board,
            from_column__isnull=False,
        ).first()
        if mv:
            self.assertTrue(mv.from_column_name, "from_column_name is empty")
            self.assertTrue(mv.to_column_name, "to_column_name is empty")

    def test_all_movements_are_backdated(self):
        from django.utils import timezone
        future = CardMovement.objects.filter(
            card__board=self.board,
            moved_at__gte=timezone.now(),
        )
        self.assertEqual(future.count(), 0, "Some movements have future timestamps")


# ---------------------------------------------------------------------------
# Due dates
# ---------------------------------------------------------------------------

@override_settings(DEBUG=True)
class SeedDueDateTests(TestCase):
    def setUp(self):
        _seed("sales_pipeline")
        self.board = Board.objects.get(name="Template: Sales Pipeline")

    def test_at_least_one_overdue_card(self):
        from django.utils import timezone
        today = timezone.now().date()
        overdue = self.board.cards.filter(due_date__lt=today).count()
        self.assertGreater(overdue, 0, "Expected at least one overdue card")

    def test_at_least_one_card_without_due_date(self):
        no_date = self.board.cards.filter(due_date__isnull=True).count()
        self.assertGreater(no_date, 0, "Expected at least one card with no due date")

    def test_at_least_one_future_due_date(self):
        from django.utils import timezone
        today = timezone.now().date()
        future = self.board.cards.filter(due_date__gt=today).count()
        self.assertGreater(future, 0, "Expected at least one card with a future due date")


# ---------------------------------------------------------------------------
# Checklists and comments
# ---------------------------------------------------------------------------

@override_settings(DEBUG=True)
class SeedChecklistCommentTests(TestCase):
    def setUp(self):
        _seed("sales_pipeline")
        self.board = Board.objects.get(name="Template: Sales Pipeline")

    def test_some_cards_have_checklists(self):
        cards_with_checklist = (
            self.board.cards.filter(checklist_items__isnull=False).distinct().count()
        )
        self.assertGreater(cards_with_checklist, 0)

    def test_checklist_has_mixed_checked_state(self):
        board_card_ids = self.board.cards.values_list("id", flat=True)
        checked = CardChecklist.objects.filter(card_id__in=board_card_ids, is_checked=True).count()
        unchecked = CardChecklist.objects.filter(card_id__in=board_card_ids, is_checked=False).count()
        self.assertGreater(checked, 0, "Expected some checked items")
        self.assertGreater(unchecked, 0, "Expected some unchecked items")

    def test_some_cards_have_comments(self):
        cards_with_comments = (
            self.board.cards.filter(comments__isnull=False).distinct().count()
        )
        self.assertGreater(cards_with_comments, 0)


# ---------------------------------------------------------------------------
# Idempotency
# ---------------------------------------------------------------------------

@override_settings(DEBUG=True)
class SeedIdempotencyTests(TestCase):
    def test_running_twice_without_wipe_skips(self):
        _seed("sales_pipeline")
        out, _ = _seed("sales_pipeline")
        self.assertIn("already exists", out)
        self.assertEqual(Board.objects.filter(name="Template: Sales Pipeline").count(), 1)

    def test_wipe_then_reseed_produces_single_board(self):
        _seed("sales_pipeline")
        _seed("sales_pipeline", wipe=True)
        self.assertEqual(Board.objects.filter(name="Template: Sales Pipeline").count(), 1)

    def test_wipe_deletes_cards_before_reseed(self):
        _seed("sales_pipeline")
        count_before = Card.objects.filter(board__name="Template: Sales Pipeline").count()
        _seed("sales_pipeline", wipe=True)
        count_after = Card.objects.filter(board__name="Template: Sales Pipeline").count()
        # Card count should be stable (same template data)
        self.assertEqual(count_before, count_after)


# ---------------------------------------------------------------------------
# --template all
# ---------------------------------------------------------------------------

@override_settings(DEBUG=True)
class SeedAllTemplatesTests(TestCase):
    def test_seeds_all_six_templates(self):
        _seed("all")
        for slug in VALID_SLUGS:
            board_name = TEMPLATE_DATA[slug]["board_name"]
            self.assertTrue(
                Board.objects.filter(name=board_name).exists(),
                f"Board for '{slug}' not created",
            )

    def test_all_boards_have_cards(self):
        _seed("all")
        for slug in VALID_SLUGS:
            board_name = TEMPLATE_DATA[slug]["board_name"]
            board = Board.objects.get(name=board_name)
            self.assertGreater(
                board.cards.count(), 0,
                f"Board '{board_name}' has no cards",
            )

    def test_all_boards_have_movement_history(self):
        _seed("all")
        for slug in VALID_SLUGS:
            board_name = TEMPLATE_DATA[slug]["board_name"]
            board = Board.objects.get(name=board_name)
            movements = CardMovement.objects.filter(card__board=board).count()
            self.assertGreater(
                movements, 0,
                f"Board '{board_name}' has no CardMovement records",
            )


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------

class SeedErrorTests(TestCase):
    @override_settings(DEBUG=False)
    def test_refuses_when_debug_false(self):
        with self.assertRaises(CommandError) as ctx:
            _seed("sales_pipeline")
        self.assertIn("Refusing", str(ctx.exception))
        self.assertIn("--force", str(ctx.exception))

    @override_settings(DEBUG=False)
    def test_force_flag_overrides_debug_guard(self):
        _seed("sales_pipeline", force=True)
        self.assertTrue(Board.objects.filter(name="Template: Sales Pipeline").exists())

    @override_settings(DEBUG=True)
    def test_unknown_template_raises_command_error(self):
        with self.assertRaises(CommandError) as ctx:
            _seed("nonexistent_template")
        self.assertIn("Unknown template", str(ctx.exception))

    @override_settings(DEBUG=True)
    def test_error_message_lists_valid_slugs(self):
        with self.assertRaises(CommandError) as ctx:
            _seed("nonexistent_template")
        error_msg = str(ctx.exception)
        for slug in VALID_SLUGS:
            self.assertIn(slug, error_msg)


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

@override_settings(DEBUG=True)
class SeedExportTests(TestCase):
    def test_export_flag_calls_export_method(self):
        with mock.patch(
            "boards.management.commands.seed_template_boards.Command._export"
        ) as mock_export:
            _seed("sales_pipeline", export=True)
        mock_export.assert_called_once()

    def test_json_export_structure(self):
        _seed("sales_pipeline")
        board = Board.objects.get(name="Template: Sales Pipeline")

        from boards.management.commands.seed_template_boards import Command

        cmd = Command()
        cmd.stdout = StringIO()
        cmd.style = mock.MagicMock()
        cmd.style.SUCCESS = lambda s: s

        template_data = TEMPLATE_DATA["sales_pipeline"]
        cols = list(board.columns.order_by("position"))
        card_qs = (
            board.cards
            .select_related("column", "swimlane", "assignee")
            .prefetch_related("labels", "checklist_items", "comments__author")
        )

        with tempfile.TemporaryDirectory() as tmp:
            seed_dir = Path(tmp)
            cmd._export_json(
                board,
                cols,
                template_data["swimlanes"],
                template_data["labels"],
                card_qs,
                seed_dir,
            )
            data = json.loads((seed_dir / "seed.json").read_text())

        for key in ("name", "columns", "swimlanes", "labels", "cards"):
            self.assertIn(key, data)
        self.assertEqual(len(data["columns"]), 6)
        self.assertEqual(len(data["swimlanes"]), 5)
        self.assertEqual(len(data["labels"]), 4)

    def test_csv_export_headers(self):
        import csv as csv_module

        _seed("sales_pipeline")
        board = Board.objects.get(name="Template: Sales Pipeline")
        card_qs = (
            board.cards
            .select_related("column", "swimlane", "assignee")
            .prefetch_related("labels", "checklist_items", "comments__author")
        )

        from boards.management.commands.seed_template_boards import Command

        cmd = Command()
        cmd.stdout = StringIO()
        cmd.style = mock.MagicMock()
        cmd.style.SUCCESS = lambda s: s

        with tempfile.TemporaryDirectory() as tmp:
            seed_dir = Path(tmp)
            cmd._export_csv(card_qs, seed_dir)
            with (seed_dir / "seed.csv").open() as f:
                reader = csv_module.DictReader(f)
                rows = list(reader)

        expected_headers = {
            "title", "column", "swimlane", "priority", "due_date",
            "weight", "labels", "assignee", "checklist_total",
            "checklist_done", "comment_count", "description_preview",
        }
        self.assertEqual(set(rows[0].keys()), expected_headers)
        self.assertEqual(len(rows), board.cards.count())
