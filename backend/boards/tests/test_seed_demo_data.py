"""Tests for the seed_demo_data management command."""

import datetime
from io import StringIO
from unittest import mock

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase, TransactionTestCase, override_settings
from django.utils import timezone

from boards.management.commands.seed_demo_data import (
    DEMO_GROUP_NAME,
    LOAD_TEST_BOARD_NAME,
    SEED_ANCHOR_DATE,
)
from accounts.models import User
from boards.models import (
    Board,
    BoardMembership,
    Card,
    CardAttachment,
    CardChecklist,
    CardComment,
    CardExternalRef,
    CardMovement,
    CardRelation,
    Column,
    CustomFieldDefinition,
    CustomFieldValue,
    Notification,
    SavedFilter,
    SwimlaneCustomFieldDefinition,
    SwimlaneCustomFieldValue,
)
from groups.models import Group, GroupInviteLink, GroupLabel

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
        overdue = board.cards.filter(due_date__lt=SEED_ANCHOR_DATE).count()
        self.assertGreater(overdue, 0, "Expected at least one overdue card")

    def test_at_least_one_card_with_no_due_date(self):
        _seed()
        board = Board.objects.get(name=BOARD_NAME)
        no_date = board.cards.filter(due_date__isnull=True).count()
        self.assertGreater(no_date, 0, "Expected at least one card with no due date")

    def test_at_least_one_future_due_date(self):
        _seed()
        board = Board.objects.get(name=BOARD_NAME)
        future = board.cards.filter(due_date__gt=SEED_ANCHOR_DATE).count()
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

    def test_most_recent_movements_within_30_day_window(self):
        """The most recent movement per non-backlog card must fall within the last 30 days.

        Regression guard: when _add_movement_history used a hardcoded
        SEED_ANCHOR_DATE the movements aged out of the 7d/30d analytics
        windows over time, causing Throughput to show all dashes.
        """
        import datetime
        _seed()
        board = Board.objects.get(name=BOARD_NAME)
        cutoff = timezone.now() - datetime.timedelta(days=30)
        leftmost_col = board.columns.order_by("position").first()
        non_backlog_cards = board.cards.exclude(column=leftmost_col)
        stale_count = 0
        for card in non_backlog_cards:
            latest = CardMovement.objects.filter(card=card).order_by("-moved_at").first()
            if latest and latest.moved_at < cutoff:
                stale_count += 1
        self.assertEqual(
            stale_count,
            0,
            f"{stale_count} non-backlog cards have their latest movement outside the 30d analytics window",
        )


@override_settings(DEBUG=True)
class SeedGroupCustomFieldAndSubResourceTests(TestCase):
    """Fixtures added for #1125 so schemathesis_hooks.py (#1120) has a real
    row to seed group/custom-field/saved-filter/attachment/invite-link path
    parameters from."""

    def test_demo_group_created_and_owns_board(self):
        _seed()
        board = Board.objects.get(name=BOARD_NAME)
        self.assertIsNotNone(board.group)
        self.assertEqual(board.group.name, DEMO_GROUP_NAME)

    def test_demo_group_has_label_and_invite_link(self):
        _seed()
        group = Group.objects.get(name=DEMO_GROUP_NAME)
        self.assertTrue(GroupLabel.objects.filter(group=group).exists())
        self.assertTrue(GroupInviteLink.objects.filter(group=group).exists())

    def test_custom_field_definition_and_value_created(self):
        _seed()
        board = Board.objects.get(name=BOARD_NAME)
        field = CustomFieldDefinition.objects.get(board=board)
        self.assertEqual(field.name, "Story Points")
        self.assertTrue(CustomFieldValue.objects.filter(field_definition=field).exists())

    def test_saved_filter_created(self):
        _seed()
        board = Board.objects.get(name=BOARD_NAME)
        self.assertTrue(SavedFilter.objects.filter(board=board).exists())

    def test_card_attachment_created(self):
        _seed()
        board = Board.objects.get(name=BOARD_NAME)
        attachment = CardAttachment.objects.filter(card__board=board).first()
        self.assertIsNotNone(attachment)
        self.assertTrue(attachment.file.name)
        self.assertGreater(attachment.size, 0)

    def test_new_fixtures_do_not_change_card_export_content(self):
        """The new fixtures are created with fixed literals *after* card/movement/
        archival generation, not from the shared `random` stream, so they must not
        perturb the deterministic card corpus that sample-boards/demo_board.json/.csv
        is diffed against."""
        _seed()
        titles_with_fixtures = list(
            Card.objects.order_by("id").values_list("title", flat=True)
        )
        _seed(wipe=True)
        titles_after_reseed = list(
            Card.objects.order_by("id").values_list("title", flat=True)
        )
        self.assertEqual(titles_with_fixtures, titles_after_reseed)


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

    def test_wipe_does_not_leak_demo_group(self):
        """Board.group is on_delete=SET_NULL, so deleting the board on --wipe
        does not cascade to the demo Group (#1125) — regression guard for the
        leak that would otherwise accumulate one orphaned Group per --wipe."""
        _seed()
        _seed(wipe=True)
        _seed(wipe=True)
        self.assertEqual(Group.objects.filter(name=DEMO_GROUP_NAME).count(), 1)


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


@override_settings(DEBUG=True)
class SeedScaleTests(TestCase):
    """--scale (#1082): the large-fixture variant for the nightly load-test job."""

    def test_scale_1_is_unchanged_default_behavior(self):
        """--scale 1 (the default) must be indistinguishable from no --scale at all —
        same board name, same swimlane count, no suffixed names."""
        _seed(scale=1)
        board = Board.objects.get(name=BOARD_NAME)
        self.assertEqual(board.swimlanes.count(), 10)
        names = list(board.swimlanes.order_by("position").values_list("name", flat=True))
        self.assertNotIn(" (2)", " ".join(names))
        self.assertFalse(Board.objects.filter(name=LOAD_TEST_BOARD_NAME).exists())

    def test_scale_n_creates_separate_load_test_board(self):
        """--scale > 1 must never touch 'Visiban Demo Board' — it seeds a
        distinctly-named board instead, so the weekly demo refresh job and the
        nightly load-test job can never collide or overwrite each other."""
        _seed(scale=3)
        self.assertFalse(Board.objects.filter(name=BOARD_NAME).exists())
        board = Board.objects.get(name=LOAD_TEST_BOARD_NAME)
        self.assertEqual(board.swimlanes.count(), 30)

    def test_scale_n_replicates_swimlanes_with_suffixed_names(self):
        _seed(scale=2)
        board = Board.objects.get(name=LOAD_TEST_BOARD_NAME)
        names = list(board.swimlanes.order_by("position").values_list("name", flat=True))
        self.assertIn("Acme Corp", names)
        self.assertIn("Acme Corp (2)", names)

    def test_scale_n_exceeds_title_corpus_without_truncating(self):
        """At high scale the fixed 152-title corpus is exhausted well before the
        target card count — cards must keep generating (with a cycled/suffixed
        title) rather than silently stopping early (the pre-#1082 `break`)."""
        _seed(scale=20)
        board = Board.objects.get(name=LOAD_TEST_BOARD_NAME)
        # 200 swimlanes x 11-13 cards each is comfortably > 152 unique titles.
        self.assertGreater(board.cards.count(), 2000)

    def test_scale_below_one_is_rejected(self):
        with self.assertRaises(CommandError) as ctx:
            _seed(scale=0)
        self.assertIn("--scale", str(ctx.exception))

    def test_scale_with_export_is_rejected(self):
        """The large fixture is generated fresh for CI, never committed —
        combining --scale > 1 with --export is a usage error, not a silent no-op."""
        with self.assertRaises(CommandError) as ctx:
            _seed(scale=2, export=True)
        self.assertIn("--export", str(ctx.exception))

    def test_scale_n_wipe_only_deletes_load_test_board(self):
        """--wipe with --scale > 1 must be scoped to the load-test board, leaving
        an existing demo board (if any) untouched."""
        _seed(scale=1)
        _seed(scale=3, wipe=True)
        self.assertTrue(Board.objects.filter(name=BOARD_NAME).exists())
        self.assertEqual(Board.objects.filter(name=LOAD_TEST_BOARD_NAME).count(), 1)


@override_settings(DEBUG=True)
class SeedNotificationsTests(TestCase):
    """--with-notifications (#1082): fixture data for the notification-poll endpoints."""

    def test_notifications_off_by_default(self):
        """The weekly demo-board refresh job's existing behavior must not change
        unless --with-notifications is passed explicitly."""
        _seed()
        self.assertEqual(Notification.objects.count(), 0)

    def test_with_notifications_seeds_unread_rows_for_demo2(self):
        _seed(with_notifications=True)
        demo2 = User.objects.get(username="demo2")
        notifications = Notification.objects.filter(recipient=demo2)
        self.assertGreater(notifications.count(), 50, "expected more than the 50-row API cap")
        self.assertTrue(notifications.filter(read=False).exists())
        self.assertFalse(notifications.filter(read=True).exists())

    def test_with_notifications_reference_real_cards_and_board(self):
        _seed(with_notifications=True)
        board = Board.objects.get(name=BOARD_NAME)
        for notif in Notification.objects.filter(recipient__username="demo2")[:5]:
            self.assertEqual(notif.board_id, board.id)
            self.assertIsNotNone(notif.card_id)
            self.assertTrue(notif.verb)

    def test_with_notifications_works_alongside_scale(self):
        _seed(scale=2, with_notifications=True)
        board = Board.objects.get(name=LOAD_TEST_BOARD_NAME)
        demo2 = User.objects.get(username="demo2")
        self.assertTrue(Notification.objects.filter(recipient=demo2, board=board).exists())


@override_settings(
    DEBUG=True,
    DEMO_MODE=True,
    DEMO_LOGIN_USERNAME="visitor",
    DEMO_LOGIN_PASSWORD="test-visitor-pw-1",
    DEMO_ADMIN_PASSWORD="test-admin-pw-1",
    DEMO_MEMBER_PASSWORD="test-member-pw-1",
)
class SeedDemoSiteTests(TestCase):
    """#1034: --demo-site seeds the hosted-demo boards and accounts."""

    #: #1389/#1412: seven boards, each a different workflow and swimlane entity
    #: (Sales Territory (Overlay) deliberately overlaps Sales Territory — #1412
    #: supersedes #1406's "keep the roster at six" decision at the user's
    #: explicit direction).
    BOARD_NAMES = [
        "Software Team", "Property Management", "Construction",
        "Sales Territory", "Sales Territory (Overlay)", "Content Moderation", "Logistics Exceptions",
    ]

    @staticmethod
    def spec_card_count(name):
        from boards.management.commands._demo_site_data import BOARDS

        return next(len(spec["cards"]) for spec in BOARDS if spec["name"] == name)

    def test_overlay_pipeline_cards_move_through_every_stage_they_passed(self):
        """#1416: the overlay board's nine-stage pipeline shows real movement.

        Each card has one movement per stage it passed, in pipeline order, so
        the History tab and the aging tint have something to show in every
        column. A Lost card goes straight from Commit to Lost, never through Won.
        """
        _seed(demo_site=True)
        board = Board.objects.get(name="Sales Territory (Overlay)")
        names = list(board.columns.order_by("position").values_list("name", flat=True))
        self.assertEqual(
            names,
            ["Identify", "Discover", "Qualify", "Shape", "Validate", "Commercial", "Commit", "Won", "Lost"],
        )
        in_flight = names[:7]
        for card in board.cards.select_related("column"):
            trail = [m.to_column_name for m in card.movements.order_by("moved_at", "id")]
            current = card.column.name
            self.assertEqual(trail[-1], current, card.title)
            expected = in_flight[: in_flight.index(current) + 1] if current in in_flight else in_flight + [current]
            self.assertEqual(trail, expected, card.title)
        # Every column holds at least one card, so no stage reads as empty.
        for name in names:
            self.assertTrue(board.cards.filter(column__name=name).exists(), name)

    def test_overlay_coverage_model_two_ads_one_sa_per_two_aes_one_svc_per_ad(self):
        """#1416: the overlay board's coverage shape, read from the seeded rows."""
        _seed(demo_site=True)
        board = Board.objects.get(name="Sales Territory (Overlay)")
        defs = list(SwimlaneCustomFieldDefinition.objects.filter(board=board).order_by("position"))
        order = [d.name for d in defs]
        self.assertEqual(order[:6], ["AD", "AE", "SA", "OAE", "OSA", "SVC"])
        by_name = {d.name: d for d in defs}
        for name in order[:6]:
            self.assertTrue(by_name[name].show_on_row and not by_name[name].is_admin_only, name)
        rows = {}
        for lane in board.swimlanes.all():
            values = {
                v.field_definition.name: v.value
                for v in SwimlaneCustomFieldValue.objects.filter(swimlane=lane).select_related("field_definition")
            }
            rows[lane.name] = values
        self.assertEqual(len({r["AD"] for r in rows.values()}), 2)
        aes_by_sa = {}
        svc_by_ad = {}
        for r in rows.values():
            aes_by_sa.setdefault(r["SA"], set()).add(r["AE"])
            svc_by_ad.setdefault(r["AD"], set()).add(r["SVC"])
        self.assertTrue(all(len(aes) == 2 for aes in aes_by_sa.values()), aes_by_sa)
        self.assertTrue(all(len(svcs) == 1 for svcs in svc_by_ad.values()), svc_by_ad)

    def test_seeds_exactly_seven_boards_with_at_least_fifteen_cards_each(self):
        _seed(demo_site=True)
        seeded = set(Board.objects.exclude(name=BOARD_NAME).values_list("name", flat=True))
        self.assertEqual(seeded, set(self.BOARD_NAMES))
        for name in self.BOARD_NAMES:
            board = Board.objects.get(name=name)
            self.assertEqual(board.cards.count(), self.spec_card_count(name), name)
            self.assertGreaterEqual(board.cards.count(), 15, name)
            from boards.management.commands._demo_site_data import BOARDS

            self.assertEqual(board.columns.count(), len(next(b for b in BOARDS if b["name"] == name)["columns"]), name)
            self.assertTrue(board.columns.filter(is_done=True).exists(), name)
            self.assertGreater(board.labels.count(), 0, name)

    def test_software_board_columns_match_spec(self):
        _seed(demo_site=True)
        board = Board.objects.get(name="Software Team")
        names = list(board.columns.order_by("position").values_list("name", flat=True))
        self.assertEqual(names, ["Backlog", "In Progress", "Review", "Done"])

    def test_cards_have_comments_assignees_labels_and_history(self):
        _seed(demo_site=True)
        for name in self.BOARD_NAMES:
            cards = Card.objects.filter(board__name=name)
            self.assertTrue(cards.filter(comments__isnull=False).exists(), name)
            self.assertTrue(cards.filter(assignee__isnull=False).exists(), name)
            self.assertTrue(cards.filter(labels__isnull=False).exists(), name)
            # Every card has at least its "created" movement.
            self.assertFalse(cards.filter(movements__isnull=True).exists(), name)

    def test_accounts_use_env_passwords_and_admin_flag(self):
        _seed(demo_site=True)
        admin = User.objects.get(username="admin")
        self.assertTrue(admin.is_site_admin)
        # #1179: the admin's password is its own, never the published one.
        self.assertTrue(admin.check_password("test-admin-pw-1"))
        self.assertFalse(admin.check_password("test-visitor-pw-1"))
        visitor = User.objects.get(username="visitor")
        self.assertTrue(visitor.check_password("test-visitor-pw-1"))
        # #1179: the tour's completion PATCH is refused by the demo fence, so the
        # published visitor is seeded with it done — it must never auto-run.
        self.assertTrue(visitor.has_completed_tour)
        self.assertFalse(admin.has_completed_tour)  # unpublished accounts: tour on first login
        for username in ("maya", "jordan"):
            member = User.objects.get(username=username)
            self.assertFalse(member.is_site_admin)
            self.assertTrue(member.check_password("test-member-pw-1"))

    @override_settings(DEMO_LOGIN_USERNAME="showcase")
    def test_visitor_username_follows_setting(self):
        _seed(demo_site=True)
        showcase = User.objects.get(username="showcase")
        self.assertFalse(showcase.is_site_admin)
        self.assertTrue(showcase.check_password("test-visitor-pw-1"))
        self.assertFalse(User.objects.filter(username="visitor").exists())

    def test_published_account_is_not_an_admin_and_reaches_every_board(self):
        """#1179 seed contract: the credential on the login page holds no authority."""
        _seed(demo_site=True)
        visitor = User.objects.get(username="visitor")
        self.assertFalse(visitor.is_site_admin)
        self.assertFalse(visitor.is_staff)
        self.assertFalse(visitor.is_superuser)
        self.assertFalse(
            BoardMembership.objects.filter(user=visitor, role=BoardMembership.Role.ADMIN).exists()
        )
        self.assertFalse(Board.objects.filter(owner=visitor).exists())
        boards = Board.objects.all()
        self.assertEqual(boards.count(), 8)  # the demo board + the seven demo-site boards
        for board in boards:
            membership = BoardMembership.objects.get(board=board, user=visitor)
            self.assertEqual(membership.role, BoardMembership.Role.MEMBER, board.name)
            # No persistent moderator grant: editing seeded cards comes from the
            # DEMO_MODE-gated carve-out in boards.permissions, which self-disarms.
            self.assertFalse(membership.is_moderator, board.name)

    def test_visitor_is_not_attributed_seeded_content(self):
        _seed(demo_site=True)
        visitor = User.objects.get(username="visitor")
        self.assertFalse(CardMovement.objects.filter(moved_by=visitor).exists())
        self.assertFalse(Card.objects.filter(assignee=visitor).exists())
        # #1363 narrows the rule to "receives notifications, may be @mentioned";
        # the visitor still never authors seeded content.
        self.assertFalse(CardComment.objects.filter(author=visitor).exists())
        self.assertFalse(CardChecklist.objects.filter(created_by=visitor).exists())
        self.assertFalse(CardRelation.objects.filter(created_by=visitor).exists())

    def test_locks_down_uploads_and_registration(self):
        from accounts.models import SiteSetting

        _seed(demo_site=True)
        setting = SiteSetting.get()
        self.assertFalse(setting.uploads_enabled)
        self.assertEqual(setting.registration_mode, SiteSetting.RegistrationMode.CLOSED)

    def test_refuses_without_separate_admin_password(self):
        with override_settings(DEMO_ADMIN_PASSWORD=""):
            with self.assertRaises(CommandError):
                _seed(demo_site=True)
        with override_settings(DEMO_ADMIN_PASSWORD="test-visitor-pw-1"):
            with self.assertRaises(CommandError):
                _seed(demo_site=True)
        self.assertFalse(Board.objects.exists())

    def test_refuses_published_username_that_collides_with_admin(self):
        for name in ("admin", "Admin", "maya"):
            with self.subTest(name=name), override_settings(DEMO_LOGIN_USERNAME=name):
                with self.assertRaises(CommandError):
                    _seed(demo_site=True)
        self.assertFalse(Board.objects.exists())

    def test_refuses_without_admin_password(self):
        with override_settings(DEMO_LOGIN_PASSWORD=""):
            with self.assertRaises(CommandError):
                _seed(demo_site=True)
        self.assertFalse(Board.objects.exists())

    def test_refuses_without_member_password(self):
        with override_settings(DEMO_MEMBER_PASSWORD=""):
            with self.assertRaises(CommandError):
                _seed(demo_site=True)
        self.assertFalse(Board.objects.exists())

    def test_wipe_resets_tour_flag_and_password_for_existing_users(self):
        _seed(demo_site=True)
        User.objects.filter(username__in=["admin", "maya"]).update(has_completed_tour=True)
        User.objects.filter(username="visitor").update(has_completed_tour=False)
        _seed(demo_site=True, wipe=True)
        for username in ("admin", "maya"):
            self.assertFalse(User.objects.get(username=username).has_completed_tour, username)
        # The visitor is re-pinned to "done" on every run (#1179).
        self.assertTrue(User.objects.get(username="visitor").has_completed_tour)

    def test_second_run_without_wipe_skips_existing_boards(self):
        _seed(demo_site=True)
        out, _ = _seed(demo_site=True)
        self.assertIn("already exists", out)
        for name in self.BOARD_NAMES:
            self.assertEqual(Board.objects.filter(name=name).count(), 1)
            self.assertEqual(Card.objects.filter(board__name=name).count(), self.spec_card_count(name))

    def test_refuses_without_demo_mode(self):
        with override_settings(DEMO_MODE=False):
            with self.assertRaises(CommandError):
                _seed(demo_site=True)
        self.assertFalse(User.objects.filter(username="admin").exists())

    def test_rejects_export_and_scale(self):
        with self.assertRaises(CommandError):
            _seed(demo_site=True, export=True)
        with self.assertRaises(CommandError):
            _seed(demo_site=True, scale=2)

    def test_demo_site_still_requires_force_when_debug_false(self):
        with override_settings(DEBUG=False):
            with self.assertRaises(CommandError):
                _seed(demo_site=True)

    def test_wipe_rerun_is_idempotent(self):
        _seed(demo_site=True)
        _seed(demo_site=True, wipe=True)
        for name in self.BOARD_NAMES:
            self.assertEqual(Board.objects.filter(name=name).count(), 1)
            self.assertEqual(Card.objects.filter(board__name=name).count(), self.spec_card_count(name))
        self.assertEqual(User.objects.filter(username="admin").count(), 1)

    def test_wipe_removes_boards_retired_by_1389(self):
        """A database seeded before #1389 and reseeded with --wipe alone (no
        --reset-database) must not keep the retired showcase boards."""
        from boards.management.commands._demo_site_data import RETIRED_BOARD_NAMES

        _seed(demo_site=True)
        admin = User.objects.get(username="admin")
        for name in RETIRED_BOARD_NAMES:
            Board.objects.create(name=name, owner=admin)
        _seed(demo_site=True, wipe=True)
        self.assertFalse(Board.objects.filter(name__in=RETIRED_BOARD_NAMES).exists())
        self.assertEqual(
            set(Board.objects.exclude(name=BOARD_NAME).values_list("name", flat=True)), set(self.BOARD_NAMES)
        )

    def test_without_flag_no_demo_site_content(self):
        _seed()
        self.assertFalse(Board.objects.filter(name__in=self.BOARD_NAMES).exists())
        self.assertFalse(User.objects.filter(username="admin").exists())


_DEMO_SITE_SETTINGS = dict(
    DEBUG=True,
    DEMO_MODE=True,
    DEMO_LOGIN_USERNAME="visitor",
    DEMO_LOGIN_PASSWORD="test-visitor-pw-1",
    DEMO_ADMIN_PASSWORD="test-admin-pw-1",
    DEMO_MEMBER_PASSWORD="test-member-pw-1",
)


@override_settings(**_DEMO_SITE_SETTINGS)
class SeedDemoSiteShowcaseTests(TestCase):
    """#1363: the showcase boards show off the product and do not read as all-stale."""

    BOARD_NAMES = SeedDemoSiteTests.BOARD_NAMES

    @classmethod
    def setUpTestData(cls):
        _seed(demo_site=True)
        cls.visitor = User.objects.get(username="visitor")

    def _cards(self, name):
        return Card.objects.filter(board__name=name)

    def test_each_board_has_checklists_partly_done(self):
        for name in self.BOARD_NAMES:
            items = CardChecklist.objects.filter(card__board__name=name)
            self.assertGreaterEqual(items.values("card").distinct().count(), 5, name)
            self.assertTrue(items.filter(is_checked=True).exists(), name)
            self.assertTrue(items.filter(is_checked=False).exists(), name)

    def test_each_board_has_card_custom_fields_with_one_pinned_and_values_on_most_cards(self):
        for name in self.BOARD_NAMES:
            defs = CustomFieldDefinition.objects.filter(board__name=name)
            self.assertTrue(1 <= defs.count() <= 3, name)
            self.assertTrue(defs.filter(show_on_card=True).exists(), name)
            self.assertLessEqual(
                defs.filter(show_on_card=True).count(), CustomFieldDefinition.MAX_PINNED_PER_BOARD, name
            )
            with_values = self._cards(name).filter(custom_field_values__isnull=False).distinct().count()
            self.assertGreater(with_values, self._cards(name).count() // 2, name)
            # Dropdown values must be one of the definition's choices, or the
            # card editor would show a value it cannot offer.
            for value in CustomFieldValue.objects.filter(field_definition__in=defs, field_definition__field_type="dropdown"):
                self.assertIn(value.value, value.field_definition.choices_json, name)

    def test_each_board_has_public_and_admin_only_swimlane_fields_on_every_lane(self):
        for name in self.BOARD_NAMES:
            board = Board.objects.get(name=name)
            defs = SwimlaneCustomFieldDefinition.objects.filter(board=board)
            self.assertTrue(defs.filter(is_admin_only=False).exists(), name)
            self.assertTrue(defs.filter(is_admin_only=True).exists(), name)
            for lane in board.swimlanes.all():
                self.assertEqual(
                    SwimlaneCustomFieldValue.objects.filter(swimlane=lane).count(), defs.count(), lane.name
                )

    def test_each_board_has_relations_including_an_active_blocker(self):
        for name in self.BOARD_NAMES:
            rels = CardRelation.objects.filter(from_card__board__name=name)
            self.assertGreaterEqual(rels.count(), 3, name)
            self.assertFalse(rels.exclude(to_card__board__name=name).exists(), name)
            # An active blocker: the blocking card is not yet done.
            self.assertTrue(
                rels.filter(relation_type=CardRelation.Type.BLOCKS, from_card__column__is_done=False).exists(),
                name,
            )
            # Symmetric relations are stored normalized, as the API stores them.
            for rel in rels.filter(relation_type=CardRelation.Type.RELATES_TO):
                self.assertLess(rel.from_card_id, rel.to_card_id, name)

    def test_software_team_has_fictional_mr_and_pr_refs(self):
        refs = CardExternalRef.objects.filter(card__board__name="Software Team")
        self.assertGreaterEqual(refs.count(), 3)
        self.assertEqual(
            set(refs.values_list("provider", flat=True)),
            {CardExternalRef.Provider.GITLAB, CardExternalRef.Provider.GITHUB},
        )
        for ref in refs:
            ref.full_clean()
            self.assertIn(".example.com/", ref.url)

    def test_visitor_has_a_nonempty_unread_inbox(self):
        inbox = Notification.objects.filter(recipient=self.visitor)
        self.assertGreaterEqual(inbox.count(), 5)
        # Spread across every showcase board, and every row points at a card.
        self.assertEqual(set(inbox.values_list("board__name", flat=True)), set(self.BOARD_NAMES))
        self.assertFalse(inbox.filter(card__isnull=True).exists())

    def test_visitor_sees_every_seeded_notification_through_the_api(self):
        """The list endpoint (and so the navbar inbox) returns unread rows only,
        so a row seeded as read would be invisible. Every seeded row must come
        back, covering all six action types."""
        from rest_framework.test import APIClient

        client = APIClient()
        client.force_authenticate(self.visitor)
        resp = client.get("/api/v1/notifications/")
        self.assertEqual(resp.status_code, 200)
        rows = resp.json()
        rows = rows["results"] if isinstance(rows, dict) else rows
        seeded = Notification.objects.filter(recipient=self.visitor)
        self.assertEqual({r["id"] for r in rows}, set(seeded.values_list("pk", flat=True)))
        self.assertEqual(
            {r["action_type"] for r in rows},
            {"mentioned", "assigned", "card_moved", "comment_added", "stale", "due_soon"},
        )

    def test_no_seeded_notification_credits_the_recipient(self):
        """Product invariant: nobody is notified about their own action."""
        for notification in Notification.objects.all():
            self.assertNotEqual(notification.actor_id, notification.recipient_id, notification.verb)
        people = set(User.objects.filter(username__in=["admin", "maya", "jordan"]).values_list("pk", flat=True))
        for notification in Notification.objects.filter(recipient=self.visitor):
            if notification.action_type in ("stale", "due_soon"):
                # System alerts, as notify_stale_cards / notify_due_soon create them.
                self.assertIsNone(notification.actor_id, notification.verb)
            else:
                self.assertIn(notification.actor_id, people, notification.verb)

    def test_visitor_notifications_agree_with_their_cards(self):
        inbox = Notification.objects.filter(recipient=self.visitor).select_related("card", "actor")
        for n in inbox:
            last = n.card.movements.order_by("-moved_at").first()
            if n.action_type == "mentioned":
                self.assertTrue(
                    n.card.comments.filter(author=n.actor, body__contains="@visitor").exists(), n.verb
                )
            elif n.action_type == "card_moved":
                self.assertEqual(n.actor_id, last.moved_by_id, n.verb)
                self.assertIn(last.to_column_name, n.verb)
            elif n.action_type == "stale":
                self.assertFalse(n.card.column.is_done, n.verb)
                self.assertLess(last.moved_at, timezone.now() - timezone.timedelta(days=7), n.verb)
            elif n.action_type == "due_soon":
                self.assertIsNotNone(n.card.due_date, n.verb)
                self.assertLessEqual(n.card.due_date, timezone.localdate() + timezone.timedelta(days=1), n.verb)
            self.assertLessEqual(n.created_at, timezone.now(), n.verb)

    def test_staleness_mix_per_board_and_never_on_done_cards(self):
        """Fresh, aging and stale all present; stale is the minority (#1363).

        Mirrors the card tint: stale at >= staleness_threshold_days since the
        last move, aging from stale_warning_pct of the threshold.
        """
        now = timezone.now()
        for name in self.BOARD_NAMES:
            board = Board.objects.get(name=name)
            threshold = board.staleness_threshold_days
            warn = threshold * (1 - board.stale_warning_pct / 100)
            buckets = {"fresh": 0, "aging": 0, "stale": 0}
            for card in self._cards(name).select_related("column"):
                last = card.movements.order_by("-moved_at").first().moved_at
                days = (now - last).total_seconds() / 86400
                bucket = "stale" if days >= threshold else "aging" if days >= warn else "fresh"
                buckets[bucket] += 1
                if card.column.is_done:
                    self.assertEqual(bucket, "fresh", f"{name}: {card.title}")
            self.assertGreaterEqual(buckets["fresh"], 8, (name, buckets))
            self.assertGreaterEqual(buckets["aging"], 2, (name, buckets))
            self.assertGreaterEqual(buckets["stale"], 2, (name, buckets))
            self.assertLessEqual(buckets["stale"], 5, (name, buckets))

    def test_staleness_matches_the_api_annotation(self):
        from boards.serializers import _annotate_is_stale

        for name in self.BOARD_NAMES:
            board = Board.objects.get(name=name)
            cutoff = timezone.now() - timezone.timedelta(days=board.staleness_threshold_days)
            stale = _annotate_is_stale(self._cards(name), cutoff).filter(_is_stale_annotated=True)
            self.assertTrue(2 <= stale.count() <= 5, (name, stale.count()))
            self.assertFalse(stale.filter(column__is_done=True).exists(), name)

    def test_due_date_mix_per_board_and_never_overdue_when_done(self):
        today = timezone.localdate()
        for name in self.BOARD_NAMES:
            cards = self._cards(name)
            overdue = cards.filter(due_date__lt=today)
            self.assertTrue(1 <= overdue.count() <= 5, name)
            self.assertTrue(cards.filter(due_date=today).exists(), name)
            self.assertTrue(cards.filter(due_date__gt=today).exists(), name)
            self.assertTrue(cards.filter(due_date__isnull=True).exists(), name)
            self.assertFalse(overdue.filter(column__is_done=True).exists(), name)
            self.assertFalse(cards.filter(column__is_done=True, due_date__isnull=False).exists(), name)

    def test_generic_board_fixtures_are_unchanged_by_demo_site(self):
        """The #1125 schemathesis rows on the generic board are untouched."""
        board = Board.objects.get(name=BOARD_NAME)
        field = CustomFieldDefinition.objects.get(board=board)
        self.assertEqual((field.name, field.field_type, field.show_on_card), ("Story Points", "number", True))
        self.assertEqual(CustomFieldValue.objects.filter(field_definition=field).count(), 1)
        self.assertFalse(CardRelation.objects.filter(from_card__board=board).exists())
        self.assertFalse(CardExternalRef.objects.filter(card__board=board).exists())


@override_settings(**_DEMO_SITE_SETTINGS)
class SeedDemoSiteEntityBoardsTests(TestCase):
    """#1389: the swimlane-as-entity boards, as the visitor sees them."""

    #: The five boards #1389 added, each with exactly three pinned row fields.
    ENTITY_BOARDS = SeedDemoSiteTests.BOARD_NAMES[1:]

    @classmethod
    def setUpTestData(cls):
        _seed(demo_site=True)
        cls.visitor = User.objects.get(username="visitor")

    def _full_as_visitor(self, board):
        from rest_framework.test import APIClient

        client = APIClient()
        client.force_authenticate(self.visitor)
        resp = client.get(f"/api/v1/boards/{board.id}/full/")
        self.assertEqual(resp.status_code, 200, board.name)
        return resp.json()

    def test_each_entity_board_pins_three_public_row_fields_with_values_on_every_lane(self):
        for name in self.ENTITY_BOARDS:
            board = Board.objects.get(name=name)
            pinned = SwimlaneCustomFieldDefinition.objects.filter(board=board, show_on_row=True)
            self.assertGreaterEqual(pinned.count(), 3, name)
            self.assertLessEqual(pinned.count(), SwimlaneCustomFieldDefinition.MAX_PINNED_PER_BOARD, name)
            # The model defaults to admin-only; the visitor is a plain member.
            self.assertFalse(pinned.filter(is_admin_only=True).exists(), name)
            for lane in board.swimlanes.all():
                for definition in pinned:
                    self.assertTrue(
                        SwimlaneCustomFieldValue.objects.filter(swimlane=lane, field_definition=definition)
                        .exclude(value="").exists(),
                        (name, lane.name, definition.name),
                    )

    def test_visitor_reads_the_pinned_row_values_but_not_the_admin_only_ones(self):
        for name in self.ENTITY_BOARDS:
            board = Board.objects.get(name=name)
            data = self._full_as_visitor(board)
            pinned = set(
                SwimlaneCustomFieldDefinition.objects.filter(board=board, show_on_row=True).values_list("id", flat=True)
            )
            hidden = set(
                SwimlaneCustomFieldDefinition.objects.filter(board=board, is_admin_only=True).values_list("id", flat=True)
            )
            self.assertTrue(hidden, name)  # both visibility modes stay on show
            for lane in data["swimlanes"]:
                seen = {v["field_definition"] for v in lane["custom_field_values"]}
                self.assertEqual(seen & pinned, pinned, (name, lane["name"]))
                self.assertFalse(seen & hidden, (name, lane["name"]))

    def test_person_fields_differ_per_row(self):
        """AE, SA and manager values are distinct per swimlane (fictional names)."""
        person_fields = {
            "Property Management": ["Property manager"],
            "Construction": ["Project manager"],
            "Sales Territory": ["AE", "SA", "Region"],
            "Content Moderation": ["Moderator lead"],
        }
        for board_name, fields in person_fields.items():
            for field in fields:
                values = list(
                    SwimlaneCustomFieldValue.objects.filter(
                        swimlane__board__name=board_name, field_definition__name=field
                    ).values_list("value", flat=True)
                )
                lanes = Board.objects.get(name=board_name).swimlanes.count()
                self.assertEqual(len(values), lanes, (board_name, field))
                self.assertEqual(len(set(values)), lanes, (board_name, field))

    def test_property_management_shows_unit_on_the_card_and_issue_type_labels(self):
        board = Board.objects.get(name="Property Management")
        self.assertEqual(
            set(board.labels.values_list("name", flat=True)),
            {"Plumbing", "Electrical", "HVAC", "Pest", "Appliance", "Turnover"},
        )
        unit = CustomFieldDefinition.objects.get(board=board, name="Unit")
        self.assertEqual(unit.field_type, "text")
        self.assertTrue(unit.show_on_card)
        cards = board.cards.all()
        self.assertEqual(CustomFieldValue.objects.filter(field_definition=unit).count(), cards.count())
        self.assertFalse(cards.filter(labels__isnull=True).exists())

    def test_sales_territory_shows_deal_value_and_crm_link_on_cards(self):
        board = Board.objects.get(name="Sales Territory")
        deal = CustomFieldDefinition.objects.get(board=board, name="Deal value")
        crm = CustomFieldDefinition.objects.get(board=board, name="CRM record")
        self.assertEqual((deal.field_type, deal.show_on_card), ("number", True))
        self.assertEqual((crm.field_type, crm.show_on_card), ("url", True))
        self.assertGreaterEqual(CustomFieldValue.objects.filter(field_definition=deal).count(), 5)
        self.assertGreaterEqual(CustomFieldValue.objects.filter(field_definition=crm).count(), 5)

    def test_every_url_value_points_at_a_reserved_domain(self):
        from urllib.parse import urlsplit

        card_urls = CustomFieldValue.objects.filter(field_definition__field_type="url")
        row_urls = SwimlaneCustomFieldValue.objects.filter(field_definition__field_type="url")
        boards_with_urls = set(card_urls.values_list("card__board__name", flat=True))
        self.assertTrue({"Construction", "Sales Territory", "Logistics Exceptions"} <= boards_with_urls)
        for value in list(card_urls.values_list("value", flat=True)) + list(row_urls.values_list("value", flat=True)):
            host = urlsplit(value).hostname or ""
            self.assertTrue(host == "example.com" or host.endswith(".example.com"), value)

    def test_every_seeded_value_is_one_the_api_would_store(self):
        """Values round-trip the API normalizer unchanged (URL, number, date,
        multi-select canonical form), so editing a seeded card in the demo
        never trips over a value the seed wrote but the API refuses."""
        from boards.serializers import _normalize_custom_field_value

        demo_boards = SeedDemoSiteTests.BOARD_NAMES
        rows = list(
            CustomFieldValue.objects.filter(card__board__name__in=demo_boards).select_related("field_definition")
        ) + list(
            SwimlaneCustomFieldValue.objects.filter(swimlane__board__name__in=demo_boards)
            .select_related("field_definition")
        )
        types = set()
        for row in rows:
            types.add(row.field_definition.field_type)
            self.assertEqual(_normalize_custom_field_value(row.field_definition, row.value), row.value, row.value)
        self.assertTrue({"text", "number", "date", "dropdown", "url", "multi_select"} <= types, types)

    def test_display_options_are_valid_and_used(self):
        from boards.custom_field_types import CHOICE_COLOR_KEYS

        demo_boards = SeedDemoSiteTests.BOARD_NAMES
        defs = list(CustomFieldDefinition.objects.filter(board__name__in=demo_boards)) + list(
            SwimlaneCustomFieldDefinition.objects.filter(board__name__in=demo_boards)
        )
        colored = formatted = 0
        for d in defs:
            if d.choice_colors:
                colored += 1
                self.assertIn(d.field_type, ("dropdown", "multi_select"), d.name)
                self.assertLessEqual(set(d.choice_colors), set(d.choices_json), d.name)
                self.assertLessEqual(set(d.choice_colors.values()), set(CHOICE_COLOR_KEYS), d.name)
            if d.number_prefix or d.number_suffix or d.number_decimals is not None:
                formatted += 1
                self.assertEqual(d.field_type, "number", d.name)
                self.assertLessEqual(len(d.number_prefix), 10, d.name)
        self.assertGreater(colored, 0)
        self.assertGreater(formatted, 0)

    def test_date_values_count_from_the_day_of_the_reset(self):
        today = timezone.localdate()
        etas = CustomFieldValue.objects.filter(card__board__name="Logistics Exceptions", field_definition__name="ETA")
        self.assertTrue(etas.exists())
        for eta in etas:
            self.assertGreaterEqual(datetime.date.fromisoformat(eta.value), today, eta.value)


@override_settings(**_DEMO_SITE_SETTINGS)
class DemoSiteResetIsDeterministicTests(TestCase):
    """#1389: an hourly reset reproduces the same boards, fields and values."""

    @staticmethod
    def _snapshot():
        names = SeedDemoSiteTests.BOARD_NAMES
        cards = list(
            Card.objects.filter(board__name__in=names).order_by("board__name", "title").values_list(
                "board__name", "title", "column__name", "swimlane__name", "priority", "due_date", "assignee__username",
            )
        )
        card_values = sorted(
            CustomFieldValue.objects.filter(card__board__name__in=names).values_list(
                "card__board__name", "card__title", "field_definition__name", "value",
            )
        )
        row_values = sorted(
            SwimlaneCustomFieldValue.objects.filter(swimlane__board__name__in=names).values_list(
                "swimlane__board__name", "swimlane__name", "field_definition__name", "value",
                "field_definition__is_admin_only", "field_definition__show_on_row",
            )
        )
        labels = sorted(
            Card.objects.filter(board__name__in=names).values_list("board__name", "title", "labels__name"),
            key=str,
        )
        last_moves = sorted(
            (c.board.name, c.title, (timezone.now() - c.movements.order_by("-moved_at").first().moved_at).days)
            for c in Card.objects.filter(board__name__in=names).select_related("board")
        )
        return cards, card_values, row_values, labels, last_moves

    def test_wipe_and_reseed_reproduces_the_same_content(self):
        _seed(demo_site=True)
        first = self._snapshot()
        _seed(demo_site=True, wipe=True)
        self.assertEqual(first, self._snapshot())


class DemoSiteDataModuleTests(TestCase):
    """#1363: the showcase content stays deterministic and off the ``random`` stream."""

    def test_demo_site_data_never_uses_random(self):
        import ast
        import inspect

        from boards.management.commands import _demo_site_data

        tree = ast.parse(inspect.getsource(_demo_site_data))
        names = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                names.add(node.module or "")
            elif isinstance(node, ast.Name):
                names.add(node.id)
        self.assertNotIn("random", names)

    def test_every_card_has_an_explicit_age_and_due_offset(self):
        from boards.management.commands._demo_site_data import BOARDS

        for spec in BOARDS:
            done = {i for i, (_n, _c, is_done) in enumerate(spec["columns"]) if is_done}
            for card in spec["cards"]:
                title, col_i, last_moved, due = card[0], card[2], card[8], card[9]
                self.assertIsInstance(last_moved, int, title)
                # 3 and 7 straddle the aging / stale boundary depending on
                # the hour of the reset, so they are never authored.
                self.assertNotIn(last_moved, (3, 7), title)
                if col_i in done:
                    self.assertIsNone(due, title)
                    self.assertLessEqual(last_moved, 2, title)


    def test_every_in_flight_column_mixes_fresh_and_long_dwelling_cards(self):
        """#1389: dwell and stale indicators need something to show in every
        column, and a column of only stale cards hides what "fresh" looks like."""
        from boards.management.commands._demo_site_data import BOARDS

        for spec in BOARDS:
            for col_i, (col_name, _color, is_done) in enumerate(spec["columns"]):
                if is_done:
                    continue
                ages = [card[8] for card in spec["cards"] if card[2] == col_i]
                self.assertTrue(any(age <= 2 for age in ages), (spec["name"], col_name, ages))
                self.assertTrue(any(age >= 4 for age in ages), (spec["name"], col_name, ages))

    def test_card_and_row_field_pin_caps_hold_in_the_spec(self):
        """The seeder writes the models directly, past the serializer caps."""
        from boards.management.commands._demo_site_data import BOARDS

        for spec in BOARDS:
            card_pinned = sum(1 for f in spec["card_fields"] if f[3])
            row_pinned = sum(1 for f in spec["swimlane_fields"] if f[3])
            self.assertLessEqual(card_pinned, CustomFieldDefinition.MAX_PINNED_PER_BOARD, spec["name"])
            self.assertLessEqual(row_pinned, SwimlaneCustomFieldDefinition.MAX_PINNED_PER_BOARD, spec["name"])

    def test_no_pricing_tiers_or_seat_caps_in_demo_copy(self):
        """No product pricing in the demo (www rule, #33); walk every string."""
        from boards.management.commands import _demo_site_data

        def strings(obj):
            if isinstance(obj, str):
                yield obj
            elif isinstance(obj, dict):
                for k, v in obj.items():
                    yield from strings(k)
                    yield from strings(v)
            elif isinstance(obj, (list, tuple)):
                for item in obj:
                    yield from strings(item)

        for text in strings(_demo_site_data.BOARDS):
            lowered = text.lower()
            for word in ("pric", "per seat", "seats", "plan tier", "subscription"):
                self.assertNotIn(word, lowered, text)


@override_settings(**_DEMO_SITE_SETTINGS)
class DemoSiteDoesNotPerturbDefaultSeedTests(TestCase):
    def test_generic_board_is_identical_with_and_without_demo_site(self):
        def snapshot():
            return list(
                Card.objects.filter(board__name=BOARD_NAME)
                .order_by("id")
                .values_list("title", "priority", "due_date", "column__name", "swimlane__name")
            )

        _seed()
        plain = snapshot()
        _seed(wipe=True, demo_site=True)
        self.assertEqual(plain, snapshot())


@override_settings(**_DEMO_SITE_SETTINGS)
class SeedResetDatabaseTests(TransactionTestCase):
    """#1180: the hosted demo's reset empties EVERY table, then reseeds.

    TransactionTestCase, not TestCase: flush TRUNCATEs on PostgreSQL, which
    refuses to run inside a transaction that still holds the deferred FK
    checks of rows the test itself inserted.
    """

    def test_reset_signs_everyone_out_and_removes_visitor_leftovers(self):
        from django.contrib.sessions.models import Session
        from django.contrib.sites.models import Site
        from django.utils import timezone as tz

        from boards.models import BoardEvent

        _seed(demo_site=True)
        stranger = User.objects.create_user(username="stranger", password="x-pw-123456")
        leftover = Board.objects.create(name="Made by a visitor", owner=stranger)
        BoardEvent.objects.create(board_id=leftover.pk, event="board_updated", data={})
        Session.objects.create(
            session_key="k" * 32, session_data="e30=", expire_date=tz.now() + tz.timedelta(days=1)
        )
        User.objects.filter(username="visitor").update(password="!")  # a dead login

        with mock.patch.dict("os.environ", {"SITE_DOMAIN": "try.visiban.test"}):
            out, _ = _seed(demo_site=True, wipe=True, force=True, reset_database=True)

        self.assertIn("every session ended", out)
        self.assertFalse(Session.objects.exists())
        self.assertFalse(User.objects.filter(username="stranger").exists())
        self.assertFalse(Board.objects.filter(name="Made by a visitor").exists())
        self.assertFalse(BoardEvent.objects.filter(board_id=leftover.pk).exists())
        # Back to seed state, with the PUBLISHED password re-applied.
        self.assertTrue(User.objects.get(username="visitor").check_password("test-visitor-pw-1"))
        for name in SeedDemoSiteTests.BOARD_NAMES:
            self.assertEqual(Card.objects.filter(board__name=name).count(), SeedDemoSiteTests.spec_card_count(name), name)
        self.assertEqual(Site.objects.get(pk=1).domain, "try.visiban.test")

    def test_reset_database_requires_demo_site(self):
        _seed()
        with self.assertRaises(CommandError):
            _seed(reset_database=True, force=True)
        self.assertTrue(Board.objects.filter(name=BOARD_NAME).exists())

    def test_reset_database_refuses_without_demo_mode(self):
        _seed()
        with override_settings(DEMO_MODE=False), self.assertRaises(CommandError):
            _seed(demo_site=True, reset_database=True, force=True)
        self.assertTrue(Board.objects.filter(name=BOARD_NAME).exists())

    def test_reset_database_requires_force_when_debug_false(self):
        _seed()
        with override_settings(DEBUG=False), self.assertRaises(CommandError):
            _seed(demo_site=True, reset_database=True)
        self.assertTrue(Board.objects.filter(name=BOARD_NAME).exists())

    def test_reset_mid_failure_rolls_back_to_the_pre_reset_state(self):
        # completeness-check (#1180): flush and reseed are one transaction.
        # A failure between them (this test forces one in _seed_demo_site,
        # after the flush already ran) must roll back to the PRE-reset state
        # — the old boards and the old, still-working published login —
        # rather than leaving the database flushed with no usable reseed.
        _seed(demo_site=True)
        self.assertTrue(User.objects.get(username="visitor").check_password("test-visitor-pw-1"))
        board_count_before = Board.objects.count()

        from boards.management.commands import seed_demo_data as seed_module

        with mock.patch.object(
            seed_module.Command, "_seed_demo_site", side_effect=RuntimeError("boom")
        ):
            with self.assertRaisesMessage(RuntimeError, "boom"):
                _seed(demo_site=True, wipe=True, force=True, reset_database=True)

        # Rolled back, not half-flushed: the old visitor account and its old
        # password are still there, and no boards were lost.
        self.assertTrue(User.objects.filter(username="visitor").exists())
        self.assertTrue(User.objects.get(username="visitor").check_password("test-visitor-pw-1"))
        self.assertEqual(Board.objects.count(), board_count_before)

    def test_reset_database_requires_force_even_when_debug_true(self):
        # security-review (#1180): --force is required unconditionally, not
        # only when DEBUG is False — DEBUG-gating it was a latent foot-gun
        # (a destructive flush one flag away from running on any deployment
        # shape that happened to have DEBUG on). The class default here is
        # DEBUG=True, so this omits the DEBUG=False override deliberately.
        _seed()
        with self.assertRaises(CommandError):
            _seed(demo_site=True, reset_database=True)
        self.assertTrue(Board.objects.filter(name=BOARD_NAME).exists())
