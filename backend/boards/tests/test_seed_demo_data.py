"""Tests for the seed_demo_data management command."""

import datetime
from io import StringIO
from unittest import mock

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase, TransactionTestCase, override_settings
from django.utils import timezone

from boards.management.commands import seed_demo_data as seed_module
from boards.management.commands.seed_demo_data import (
    DEMO_GROUP_NAME,
    LOAD_TEST_BOARD_NAME,
    LOAD_TEST_EXTRA_BOARD_PREFIX,
)
from accounts.models import AdminActionLog, User
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
        overdue = board.cards.filter(due_date__lt=timezone.now().date()).count()
        self.assertGreater(overdue, 0, "Expected at least one overdue card")

    def test_at_least_one_card_with_no_due_date(self):
        _seed()
        board = Board.objects.get(name=BOARD_NAME)
        no_date = board.cards.filter(due_date__isnull=True).count()
        self.assertGreater(no_date, 0, "Expected at least one card with no due date")

    def test_at_least_one_future_due_date(self):
        _seed()
        board = Board.objects.get(name=BOARD_NAME)
        future = board.cards.filter(due_date__gt=timezone.now().date()).count()
        self.assertGreater(future, 0, "Expected at least one card with a future due date")


@override_settings(DEBUG=True)
class SeedDueDateAnchorTests(TestCase):
    """Due dates track today (#1948): the hourly demo reseed must not drift overdue."""

    @staticmethod
    def _seed_on(day, seed=42):
        with mock.patch.object(
            seed_module.Command, "_due_date_anchor", return_value=day
        ):
            _seed(seed=seed, wipe=True)
        board = Board.objects.get(name=BOARD_NAME)
        rows = board.cards.order_by("title", "id").values_list("title", "due_date")
        return [(t, None if d is None else (d - day).days) for t, d in rows]

    def test_due_dates_are_offsets_from_pinned_today(self):
        day = datetime.date(2031, 7, 15)
        _seed_rows = self._seed_on(day)
        offsets = [o for _, o in _seed_rows if o is not None]
        self.assertTrue(offsets)
        self.assertTrue(any(o < 0 for o in offsets))
        self.assertTrue(any(o > 0 for o in offsets))
        board = Board.objects.get(name=BOARD_NAME)
        for due in board.cards.exclude(due_date__isnull=True).values_list("due_date", flat=True):
            self.assertLessEqual(abs((due - day).days), 30)

    def test_same_seed_on_different_days_gives_identical_titles_and_offsets(self):
        first = self._seed_on(datetime.date(2026, 1, 3))
        second = self._seed_on(datetime.date(2029, 11, 20))
        self.assertEqual(first, second)

    def test_movement_anchor_is_utc_date(self):
        """_movement_anchor uses the UTC clock, so movements land around it (#1948).

        Pin 23:59 UTC on a day far from the real one: a host-local
        date.today() would date every movement around the real today instead.
        """
        frozen = datetime.datetime(2030, 3, 9, 23, 59, tzinfo=datetime.timezone.utc)
        with mock.patch.object(seed_module.timezone, "now", return_value=frozen):
            _seed(wipe=True)
        board = Board.objects.get(name=BOARD_NAME)
        moved = list(
            CardMovement.objects.filter(card__board=board).values_list("moved_at", flat=True)
        )
        self.assertTrue(moved)
        self.assertLessEqual(max(moved).date(), datetime.date(2030, 3, 9))
        self.assertGreater(min(moved), frozen - datetime.timedelta(days=400))

    def test_default_anchor_is_utc_today(self):
        # Late evening UTC: a host-local or naive date.today() would differ on
        # a host ahead of UTC, so this proves the anchor is the UTC date.
        frozen = datetime.datetime(2030, 3, 9, 23, 59, tzinfo=datetime.timezone.utc)
        with mock.patch.object(seed_module.timezone, "now", return_value=frozen):
            self.assertEqual(
                seed_module.Command._due_date_anchor(), datetime.date(2030, 3, 9)
            )


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
            # An archived card also has its archive movement (#1889).
            self.assertEqual(
                CardMovement.objects.filter(card=card, movement_type=CardMovement.MovementType.MOVE).count(),
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

        Regression guard: when _add_movement_history used a fixed date
        the movements aged out of the 7d/30d analytics
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
        link = GroupInviteLink.objects.get(group=group)
        # A shareable group link always expires and never grants admin (#1727).
        self.assertIsNotNone(link.expires_at)
        self.assertNotEqual(link.role, GroupInviteLink.Role.ADMIN)

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

    def test_demo2_to_demo5_are_group_members_and_demo1_is_admin(self):
        """#1570: exact roles, by username. A MEMBER row is what lets the fuzz
        user pass get_accessible_group_ids(); without it every group route 404s."""
        from groups.models import GroupMembership, get_accessible_group_ids

        _seed()
        group = Group.objects.get(name=DEMO_GROUP_NAME)
        roles = {
            m.user.username: m.role
            for m in GroupMembership.objects.filter(group=group).select_related("user")
        }
        self.assertEqual(roles["demo1"], GroupMembership.Role.ADMIN)
        for name in ("demo2", "demo3", "demo4", "demo5"):
            self.assertEqual(roles[name], GroupMembership.Role.MEMBER, name)
        demo2 = GroupMembership.objects.get(group=group, user__username="demo2").user
        self.assertIn(group.id, get_accessible_group_ids(demo2))

    def test_demo2_owns_a_fixture_card_with_all_children(self):
        """#1570: authorship-gated DELETEs need rows the fuzz user created."""
        from boards.models import CardComment, CardRelation

        _seed()
        board = Board.objects.get(name=BOARD_NAME)
        card = CardAttachment.objects.get(card__board=board, uploaded_by__username="demo2").card
        self.assertEqual(card.created_by.username, "demo2")
        self.assertTrue(CardComment.objects.filter(card=card, author__username="demo2").exists())
        self.assertTrue(card.checklist_items.exists())
        # The hook hands out the card's first item, and a member may only edit
        # items it created (#1889: seeded items now always have a creator).
        self.assertEqual(card.checklist_items.order_by("id").first().created_by.username, "demo2")
        self.assertTrue(
            CardRelation.objects.filter(from_card=card).exists()
            or CardRelation.objects.filter(to_card=card).exists()
        )

    def test_fuzz_user_can_edit_the_checklist_item_the_hook_picks(self):
        """The ids the schema-fuzz hook resolves reach the success path for demo2 (#1570, #1889)."""
        import importlib

        from rest_framework.test import APIClient

        _seed()
        ids = importlib.import_module("schemathesis_hooks")._load_real_ids()
        board = Board.objects.get(name=BOARD_NAME)
        client = APIClient()
        client.force_authenticate(User.objects.get(username="demo2"))
        resp = client.patch(
            f"/api/v1/boards/{board.pk}/cards/{ids['card_id']}/checklist/{ids['checklist_item_id']}/",
            {"text": "Edited by the fuzz user"}, format="json",
        )
        self.assertEqual(resp.status_code, 200, getattr(resp, "data", None))

    def test_fixture_card_is_created_when_member_authored_none(self):
        """No RNG dependence: creates a new card, never rewrites an existing one's author."""
        from boards.management.commands.seed_demo_data import Command
        from boards.models import Card

        _seed()
        board = Board.objects.get(name=BOARD_NAME)
        member = board.memberships.exclude(user=board.owner).order_by("id").first().user
        CardAttachment.objects.filter(uploaded_by=member).delete()
        Card.objects.filter(board=board, created_by=member).update(created_by=board.owner)
        before = Card.objects.filter(board=board).count()
        authors = dict(Card.objects.filter(board=board).values_list("id", "created_by_id"))

        card = Command()._create_member_fixture_card(board, member)

        self.assertIsNotNone(card)
        card.refresh_from_db()
        self.assertEqual(card.created_by_id, member.id)
        self.assertEqual(Card.objects.filter(board=board).count(), before + 1)
        # No pre-existing card changed author.
        self.assertEqual(
            {k: v for k, v in Card.objects.filter(board=board).values_list("id", "created_by_id") if k in authors},
            authors,
        )
        self.assertTrue(CardAttachment.objects.filter(card=card, uploaded_by=member).exists())

    def test_new_fixtures_do_not_change_card_corpus(self):
        """The new fixtures are created with fixed literals *after* card/movement/
        archival generation, not from the shared `random` stream, so they must not
        perturb the deterministic card corpus (a reseed must reproduce the same titles)."""
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
class SeedExportRetiredTests(TestCase):
    """The sample boards have one writer, generate_seed_data.py (#1459)."""

    def test_export_is_refused_and_names_the_generator(self):
        with self.assertRaises(CommandError) as ctx:
            _seed(export=True)
        self.assertIn("generate_seed_data.py", str(ctx.exception))
        self.assertFalse(Board.objects.filter(name=BOARD_NAME).exists())

    def test_command_no_longer_carries_the_snapshot_writers(self):
        from boards.management.commands.seed_demo_data import Command

        for name in ("_export", "_export_json", "_export_csv"):
            self.assertFalse(hasattr(Command, name), name)


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
        distinctly-named board instead, so the manual demo refresh job and the
        nightly load-test job can never collide or overwrite each other."""
        _seed(scale=3)
        self.assertFalse(Board.objects.filter(name=BOARD_NAME).exists())
        board = Board.objects.get(name=LOAD_TEST_BOARD_NAME)
        self.assertEqual(board.swimlanes.count(), 30)

    def test_scale_n_seeds_deep_movement_history(self):
        """The load-test fixture carries ~10+ movements on moved cards (#1883),
        so a read that loads every movement per card shows up as latency; the
        default demo board is unchanged."""
        from django.db.models import Count

        _seed(scale=2)
        board = Board.objects.get(name=LOAD_TEST_BOARD_NAME)
        counts = list(
            board.cards.annotate(n=Count("movements")).values_list("n", flat=True)
        )
        self.assertGreater(max(counts), 10)
        # Rework moves must not change where a card currently sits.
        for card in board.cards.filter(archived_at__isnull=True):
            last = card.movements.order_by("-moved_at", "-id").first()
            if last.notes == "" and last.to_column_id is not None:
                self.assertEqual(last.to_column_id, card.column_id)

    def test_scale_1_has_no_rework_movements(self):
        _seed(scale=1)
        board = Board.objects.get(name=BOARD_NAME)
        from django.db.models import Count

        self.assertLessEqual(
            max(board.cards.annotate(n=Count("movements")).values_list("n", flat=True)), 8
        )

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

    def test_scale_n_board_has_20_members_default_board_5(self):
        """#1723: the load-test board is padded to 20 members; the default stays at 5."""
        _seed(scale=2)
        self.assertEqual(Board.objects.get(name="Visiban Load Test Board").memberships.count(), 20)
        _seed()
        self.assertEqual(Board.objects.get(name="Visiban Demo Board").memberships.count(), 5)

    def test_scale_below_one_is_rejected(self):
        with self.assertRaises(CommandError) as ctx:
            _seed(scale=0)
        self.assertIn("--scale", str(ctx.exception))

    def test_scale_n_wipe_only_deletes_load_test_board(self):
        """--wipe with --scale > 1 must be scoped to the load-test board, leaving
        an existing demo board (if any) untouched."""
        _seed(scale=1)
        _seed(scale=3, wipe=True)
        self.assertTrue(Board.objects.filter(name=BOARD_NAME).exists())
        self.assertEqual(Board.objects.filter(name=LOAD_TEST_BOARD_NAME).count(), 1)


@override_settings(DEBUG=True)
class SeedExtraBoardsTests(TestCase):
    """--extra-boards (#1810): many-board fixture for the multi-board card_search scenario."""

    def test_default_seeds_no_extra_boards(self):
        _seed(scale=2)
        self.assertFalse(Board.objects.filter(name__startswith=LOAD_TEST_EXTRA_BOARD_PREFIX).exists())

    def test_extra_boards_give_demo3_many_accessible_boards(self):
        from boards.views._helpers import get_accessible_boards_queryset

        out, _ = _seed(scale=2, extra_boards=4)
        self.assertEqual(Board.objects.filter(name__startswith=LOAD_TEST_EXTRA_BOARD_PREFIX).count(), 4)
        demo = {u.username: u for u in User.objects.filter(username__in=["demo1", "demo2", "demo3"])}
        # Load-test board + 4 extras for demo3; demo1 and demo2 are unchanged.
        self.assertEqual(get_accessible_boards_queryset(demo["demo3"]).count(), 5)
        self.assertEqual(get_accessible_boards_queryset(demo["demo2"]).count(), 1)
        self.assertEqual(get_accessible_boards_queryset(demo["demo1"]).count(), 1)
        self.assertIn("5 accessible boards", out)

    def test_extra_boards_have_searchable_cards(self):
        _seed(scale=2, extra_boards=2)
        for board in Board.objects.filter(name__startswith=LOAD_TEST_EXTRA_BOARD_PREFIX):
            self.assertEqual(board.cards.count(), 8)

    def test_extra_boards_do_not_change_main_fixture(self):
        _seed(scale=2)
        before = sorted(Board.objects.get(name=LOAD_TEST_BOARD_NAME).cards.values_list("title", flat=True))
        _seed(scale=2, extra_boards=3, wipe=True)
        after = sorted(Board.objects.get(name=LOAD_TEST_BOARD_NAME).cards.values_list("title", flat=True))
        self.assertEqual(before, after)

    def test_wipe_replaces_extra_boards_rather_than_accumulating(self):
        _seed(scale=2, extra_boards=3)
        _seed(scale=2, extra_boards=2, wipe=True)
        self.assertEqual(Board.objects.filter(name__startswith=LOAD_TEST_EXTRA_BOARD_PREFIX).count(), 2)

    def test_wipe_with_scale_1_leaves_extra_boards_alone(self):
        _seed(scale=2, extra_boards=2)
        _seed(scale=1, wipe=True)
        self.assertEqual(Board.objects.filter(name__startswith=LOAD_TEST_EXTRA_BOARD_PREFIX).count(), 2)

    def test_scale_wipe_deletes_only_load_test_and_prefixed_boards(self):
        """The prefix match must not reach unrelated boards, including look-alikes."""
        from accounts.models import User

        owner = User.objects.create(username="wipe-owner-1810")
        keep = [
            Board.objects.create(name="Unrelated Board", owner=owner),
            # Contains the prefix but does not start with it.
            Board.objects.create(name=f"My {LOAD_TEST_EXTRA_BOARD_PREFIX} 001", owner=owner),
            # Similar start, not the prefix.
            Board.objects.create(name="Visiban Load Test Extra", owner=owner),
        ]
        _seed(scale=2, extra_boards=2)
        _seed(scale=2, extra_boards=1, wipe=True)
        for board in keep:
            self.assertTrue(Board.objects.filter(pk=board.pk).exists(), board.name)
        self.assertEqual(Board.objects.filter(name__startswith=LOAD_TEST_EXTRA_BOARD_PREFIX).count(), 1)

    def test_extra_boards_requires_scale_above_one(self):
        with self.assertRaises(CommandError) as ctx:
            _seed(extra_boards=2)
        self.assertIn("--scale", str(ctx.exception))

    def test_negative_extra_boards_rejected(self):
        with self.assertRaises(CommandError):
            _seed(scale=2, extra_boards=-1)


@override_settings(DEBUG=True)
class SeedNotificationsTests(TestCase):
    """--with-notifications (#1082): fixture data for the notification-poll endpoints."""

    def test_notifications_off_by_default(self):
        """The manual demo-board refresh job's existing behavior must not change
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

    #: #1389/#1412: seven boards (plus the Trello import, #1908), each a different workflow and swimlane entity
    #: (Sales Territory (Overlay) deliberately overlaps Sales Territory — #1412
    #: supersedes #1406's "keep the roster at six" decision at the user's
    #: explicit direction).
    BOARD_NAMES = [
        "Software Team", "Property Management", "Construction",
        "Sales Territory", "Sales Territory (Overlay)", "Content Moderation", "Logistics Exceptions",
    ]

    #: The boards written out in _demo_site_data; the overlay board is the
    #: imported sales_overlay sample instead (#1889) and is held to the
    #: sample's own shape (DemoSiteOverlayBoardTests, test_sample_boards).
    HAND_BUILT = [n for n in BOARD_NAMES if n != "Sales Territory (Overlay)"]

    @staticmethod
    def spec(name):
        """The board's definition: its _demo_site_data spec, or the sample it imports."""
        from boards.management.commands._demo_site_data import BOARDS

        spec = next(spec for spec in BOARDS if spec["name"] == name)
        return _sample(spec["sample"]) if "sample" in spec else spec

    @classmethod
    def spec_card_count(cls, name):
        return len(cls.spec(name)["cards"])

    def test_demo_site_password_sets_are_not_in_the_admin_action_log(self):
        """#1699: documented exception to the admin action log.

        ``--demo-site`` requires DEMO_MODE and the hourly reset empties every
        table including the action log, so a first seed and a re-seed (which
        re-sets the passwords) write no ``user.password_set`` entry. See the "Demo-site
        seed password" row of docs/development/security-invariants.md.
        """
        _seed(demo_site=True)
        _seed(demo_site=True)
        self.assertFalse(
            AdminActionLog.objects.filter(
                action=AdminActionLog.Action.USER_PASSWORD_SET
            ).exists()
        )

    def test_overlay_pipeline_shows_every_stage(self):
        """#1416: the overlay board's nine-stage pipeline has cards in every
        stage. Since #1889 the stages, cards and moves are the sales_overlay
        sample's; a Lost card never passes through Won
        (DemoSiteHistoryReconciliationTests checks every card's path)."""
        _seed(demo_site=True)
        board = Board.objects.get(name="Sales Territory (Overlay)")
        names = list(board.columns.order_by("position").values_list("name", flat=True))
        self.assertEqual(
            names,
            ["Identify", "Discover", "Qualify", "Shape", "Validate", "Commercial", "Commit", "Won", "Lost"],
        )
        for name in names:
            self.assertTrue(board.cards.filter(column__name=name).exists(), name)

    def test_overlay_coverage_model(self):
        """#1416/#1447/#1417: AD, Coverage, AE, SA, OAE, OSA and SVC lead the row; each AE has
        one AD, each overlay AE one overlay SA, each AD one services lead, and
        one account each is Partial and Gap."""
        _seed(demo_site=True)
        board = Board.objects.get(name="Sales Territory (Overlay)")
        defs = list(SwimlaneCustomFieldDefinition.objects.filter(board=board).order_by("position"))
        order = [d.name for d in defs]
        self.assertEqual(order[:7], ["AD", "Coverage", "AE", "SA", "OAE", "OSA", "SVC"])
        by_name = {d.name: d for d in defs}
        for name in order[:7]:
            self.assertTrue(by_name[name].show_on_row and not by_name[name].is_admin_only, name)
        rows = {
            lane.name: dict(
                SwimlaneCustomFieldValue.objects.filter(swimlane=lane).values_list("field_definition__name", "value")
            )
            for lane in board.swimlanes.all()
        }
        ad_of, osa_of, svc_of = {}, {}, {}
        for r in rows.values():
            ad_of.setdefault(r["AE"], set()).add(r["AD"])
            svc_of.setdefault(r["AD"], set()).add(r["SVC"])
            if r["OAE"] != "Unassigned":
                osa_of.setdefault(r["OAE"], set()).add(r["OSA"])
        for mapping in (ad_of, osa_of, svc_of):
            self.assertTrue(all(len(v) == 1 for v in mapping.values()), mapping)
        self.assertEqual(sorted(r["Coverage"] for r in rows.values()).count("Full"), len(rows) - 2)
        self.assertEqual({r["Coverage"] for r in rows.values()}, {"Full", "Partial", "Gap"})

    def test_seeds_seven_showcase_boards_plus_the_trello_import(self):
        _seed(demo_site=True)
        seeded = set(Board.objects.exclude(name=BOARD_NAME).values_list("name", flat=True))
        self.assertEqual(seeded, set(self.BOARD_NAMES) | {"Product Roadmap (Trello import)"})
        for name in self.BOARD_NAMES:
            board = Board.objects.get(name=name)
            self.assertEqual(board.cards.count(), self.spec_card_count(name), name)
            self.assertGreaterEqual(board.cards.count(), 15, name)
            self.assertEqual(board.columns.count(), len(self.spec(name)["columns"]), name)
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

    def test_reseed_revokes_existing_account_credentials(self):
        """#1600: re-seeding an existing demo account revokes its PATs and DRF Token.

        The visitor's password is published, so the re-set must cut off every
        credential issued under the previous one (applied to all four accounts).
        It must not set must_change_password: the visitor signs in with the
        published password.
        """
        from rest_framework.authtoken.models import Token

        from accounts.models import PersonalAccessToken

        names = ["visitor", "admin", "maya", "jordan"]
        existing = []
        for name in names:
            u = User.objects.create_user(username=name, email=f"{name}@example.com", password="old-pw-1234")
            PersonalAccessToken.generate(u, "stale")
            Token.objects.create(user=u)
            existing.append(u)
        bystander = User.objects.create_user(username="bystander", email="b@example.com", password="x-pw-1234")
        PersonalAccessToken.generate(bystander, "keep")
        Token.objects.create(user=bystander)

        _seed(demo_site=True)

        for u in existing:
            u.refresh_from_db()
            self.assertFalse(u.has_usable_password() and u.check_password("old-pw-1234"), u.username)
            self.assertFalse(u.must_change_password, u.username)
            self.assertFalse(PersonalAccessToken.objects.filter(user=u).exists(), u.username)
            self.assertFalse(Token.objects.filter(user=u).exists(), u.username)
        # Only the re-seeded accounts are touched.
        self.assertTrue(PersonalAccessToken.objects.filter(user=bystander).exists())
        self.assertTrue(Token.objects.filter(user=bystander).exists())

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
        self.assertEqual(boards.count(), 9)  # the demo board + the eight demo-site boards
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
            set(Board.objects.exclude(name=BOARD_NAME).values_list("name", flat=True)), set(self.BOARD_NAMES) | {"Product Roadmap (Trello import)"}
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
        # The overlay board is the sales_overlay sample, with every field type
        # (test_sample_boards holds it to that).
        for name in SeedDemoSiteTests.HAND_BUILT:
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
            if name not in SeedDemoSiteTests.HAND_BUILT:
                # The sample leaves an optional row field empty where the
                # account has nothing to record (e.g. no overlay products yet).
                continue
            for lane in board.swimlanes.all():
                self.assertEqual(
                    SwimlaneCustomFieldValue.objects.filter(swimlane=lane).count(), defs.count(), lane.name
                )

    def test_each_board_has_relations_including_an_active_blocker(self):
        # Not the overlay board: the sample format carries no card relations,
        # so the imported board has none (#1448).
        for name in SeedDemoSiteTests.HAND_BUILT:
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
            elif n.action_type == "assigned":
                # #1889: the card's history records the assignment the
                # notification reports, by its actor, at its time; the card has
                # moved on since, so the visitor is never its assignee.
                self.assertTrue(
                    n.card.activities.filter(
                        event_type="assignee_change", to_value="visitor", actor=n.actor, created_at=n.created_at,
                    ).exists(),
                    n.verb,
                )
                self.assertNotEqual(n.card.assignee_id, n.recipient_id, n.verb)
            elif n.action_type == "due_soon":
                self.assertIsNotNone(n.card.due_date, n.verb)
                self.assertLessEqual(n.card.due_date, timezone.localdate() + timezone.timedelta(days=1), n.verb)
            self.assertLessEqual(n.created_at, timezone.now(), n.verb)

    def test_staleness_mix_per_board_and_never_on_done_cards(self):
        """Fresh, aging and stale all present; stale is the minority (#1363).

        Mirrors the card tint: stale at >= staleness_threshold_days since the
        last move, aging once stale_warning_pct percent of the threshold is
        used (threshold * pct / 100, #1841).
        """
        now = timezone.now()
        for name in self.BOARD_NAMES:
            board = Board.objects.get(name=name)
            threshold = board.staleness_threshold_days
            warn = threshold * board.stale_warning_pct / 100
            buckets = {"fresh": 0, "aging": 0, "stale": 0}
            # Archived cards are off the board, so they show no tint (#1889:
            # the overlay board archives some closed deals).
            for card in self._cards(name).filter(archived_at__isnull=True).select_related("column"):
                last = card.movements.filter(movement_type="move").order_by("-moved_at").first().moved_at
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
            live = self._cards(name).filter(archived_at__isnull=True)
            stale = _annotate_is_stale(live, cutoff).filter(_is_stale_annotated=True)
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
        # Exactly the one member-owned relation seeded for the schema-fuzz (#1570);
        # the demo-site showcase relations must not leak onto this board.
        self.assertEqual(CardRelation.objects.filter(from_card__board=board).count(), 1)
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

        for spec in (b for b in BOARDS if "cards" in b):
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

        for spec in (b for b in BOARDS if "cards" in b):
            for col_i, (col_name, _color, is_done) in enumerate(spec["columns"]):
                if is_done:
                    continue
                ages = [card[8] for card in spec["cards"] if card[2] == col_i]
                self.assertTrue(any(age <= 2 for age in ages), (spec["name"], col_name, ages))
                self.assertTrue(any(age >= 4 for age in ages), (spec["name"], col_name, ages))

    def test_card_and_row_field_pin_caps_hold_in_the_spec(self):
        """The seeder writes the models directly, past the serializer caps."""
        from boards.management.commands._demo_site_data import BOARDS

        for spec in (b for b in BOARDS if "cards" in b):
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

        # The imported overlay board's copy too (#1889): it is the sample's.
        samples = [_sample(b["sample"]) for b in _demo_site_data.BOARDS if "sample" in b]
        for text in strings([_demo_site_data.BOARDS, samples]):
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


# ── #1889: the overlay board is the sales_overlay sample; every card's history
#    accounts for its state; the overlay board's URL never moves ────────────

OVERLAY = "Sales Territory (Overlay)"
TRELLO = "Product Roadmap (Trello import)"


def _sample(slug):
    """The shipped sample file the demo imports, parsed."""
    import json

    from boards.services import sample_boards

    _entry, body = sample_boards.get_sample(slug)
    return json.loads(body)


@override_settings(**_DEMO_SITE_SETTINGS)
class DemoSiteHistoryReconciliationTests(TestCase):
    """Every card on every board the hosted demo shows is explained by its history.

    Walks the generic demo board, the six hand-built showcase boards and the
    imported overlay board, and fails on any card holding a value (label,
    assignee, priority, weight, due date, checklist state, comment, archive,
    cell) with no movement or activity in the API's form behind it, or whose
    history is not one coherent chain inside the card's life. See
    ``boards/tests/history_reconciliation.py`` for the rules and
    ``test_history_reconciliation.py`` for the proof they match the API.
    """

    @classmethod
    def setUpTestData(cls):
        _seed(demo_site=True)

    def test_every_demo_card_is_fully_explained_by_its_history(self):
        from boards.tests.history_reconciliation import board_history_problems

        boards = Board.objects.order_by("id")
        self.assertEqual(boards.count(), 9)
        for board in boards:
            with self.subTest(board.name):
                self.assertEqual(board_history_problems(board, imported=board.name in (OVERLAY, TRELLO)), {})

    def test_the_trail_is_not_vacuous(self):
        """Each kind of state the reconciler checks is actually present, so a
        clean result means the history was checked, not that nothing was there."""
        from boards.models import CardActivity

        for name in ("Software Team", OVERLAY, BOARD_NAME):
            kinds = set(CardActivity.objects.filter(card__board__name=name).values_list("event_type", flat=True))
            self.assertLessEqual(
                {"assignee_change", "label_change", "priority_change", "weight_change", "due_date_change",
                 "checklist_item_added", "checklist_item_checked", "comment_added"},
                kinds, name,
            )
        self.assertTrue(CardMovement.objects.filter(card__board__name=BOARD_NAME, movement_type="archived").exists())

    def test_the_visitor_is_never_credited_with_history(self):
        from boards.models import CardActivity

        visitor = User.objects.get(username="visitor")
        self.assertFalse(CardActivity.objects.filter(actor=visitor).exists())
        self.assertFalse(CardMovement.objects.filter(moved_by=visitor).exists())


@override_settings(**_DEMO_SITE_SETTINGS)
class DemoSiteOverlayBoardTests(TestCase):
    """The overlay board is the shipped sales_overlay sample, imported (#1889)."""

    @classmethod
    def setUpTestData(cls):
        _seed(demo_site=True)
        cls.board = Board.objects.get(name=OVERLAY)
        cls.data = _sample("sales_overlay")

    def test_the_hand_built_overlay_spec_is_gone(self):
        from boards.management.commands._demo_site_data import BOARDS

        spec = next(b for b in BOARDS if b["name"] == OVERLAY)
        self.assertEqual(spec, {"name": OVERLAY, "sample": "sales_overlay"})

    def test_the_board_is_the_sample(self):
        self.assertEqual(
            sorted(self.board.cards.values_list("title", flat=True)), sorted(c["title"] for c in self.data["cards"]),
        )
        self.assertEqual(
            list(self.board.columns.order_by("position").values_list("name", flat=True)),
            [c["name"] for c in self.data["columns"]],
        )
        self.assertEqual(
            list(self.board.swimlanes.order_by("position").values_list("name", flat=True)),
            [s["name"] for s in self.data["swimlanes"]],
        )
        self.assertEqual(
            list(CustomFieldDefinition.objects.filter(board=self.board).order_by("position").values_list("name", flat=True)),
            [f["name"] for f in self.data["custom_fields"]],
        )
        self.assertEqual(
            self.board.cards.filter(archived_at__isnull=False).count(),
            sum(1 for c in self.data["cards"] if c.get("archived_at")),
        )
        # Date values move with the rest of the board: the sample's anchor
        # becomes the reset day (see _import_demo_site_sample).
        from boards.services import sample_boards

        anchor = datetime.date.fromisoformat(sample_boards.get_entry("sales_overlay")["date_anchor"])
        shift = timezone.localdate() - anchor
        dates = {f["name"] for f in self.data["swimlane_custom_fields"] if f["field_type"] == "date"}
        for lane in self.data["swimlanes"]:
            stored = dict(
                SwimlaneCustomFieldValue.objects.filter(swimlane__board=self.board, swimlane__name=lane["name"])
                .values_list("field_definition__name", "value")
            )
            expected = {
                k: (datetime.date.fromisoformat(v) + shift).isoformat() if k in dates else v
                for k, v in lane["custom_field_values"].items()
            }
            self.assertEqual(stored, expected, lane["name"])

    def test_imported_cards_are_dated_to_their_creation(self):
        """The importer restores each card's exported created_at (#1906), which
        the sample file sets to the card's creation movement, so nothing in its
        history predates it."""
        cards = self.board.cards.all()
        self.assertEqual(cards.count(), len(self.data["cards"]))
        for card in cards:
            first = card.movements.order_by("moved_at", "id").first()
            self.assertEqual(card.created_at, first.moved_at, card.title)

    def test_history_is_the_files_with_import_provenance(self):
        moves = CardMovement.objects.filter(card__board=self.board)
        self.assertEqual(moves.count(), sum(len(c["movements"]) for c in self.data["cards"]))
        self.assertFalse(moves.filter(imported_from_username__isnull=True).exists())
        self.assertTrue(moves.exclude(notes="").exclude(notes="Card created").exists())  # trail notes

    def test_the_import_starts_the_boards_change_feed(self):
        from boards.models import BoardEvent

        self.assertTrue(BoardEvent.objects.filter(board_id=self.board.pk, event="board.created").exists())

    def test_the_demo_people_and_the_samples_cast_are_members(self):
        members = dict(self.board.memberships.values_list("user__username", "role"))
        self.assertEqual(members["admin"], BoardMembership.Role.ADMIN)
        for name in ("visitor", "maya", "jordan"):
            self.assertEqual(members[name], BoardMembership.Role.MEMBER, name)
        assignees = {c["assignee"] for c in self.data["cards"] if c.get("assignee")}
        self.assertLessEqual(assignees, set(members))
        # Every assignee in the file resolved, so no card lost its owner.
        self.assertEqual(
            self.board.cards.filter(assignee__isnull=False).count(),
            sum(1 for c in self.data["cards"] if c.get("assignee")),
        )

    def test_the_wip_limit_header_and_aging_cues_have_something_to_show(self):
        live = self.board.cards.filter(archived_at__isnull=True)
        over = [
            col.name for col in self.board.columns.all()
            if col.wip_limit and live.filter(column=col).count() > col.wip_limit
        ]
        self.assertEqual(over, ["Commercial"])
        self.assertTrue(self.board.columns.filter(weight_limit__isnull=False).exists())

    def test_no_event_is_in_the_future_whatever_the_hour_of_the_reset(self):
        """The sample's newest event is a day before its anchor, and the
        import puts the anchor at noon on the reset day, so a reset at any
        hour dates nothing after now."""
        from boards.models import CardActivity

        latest = max(
            CardMovement.objects.filter(card__board=self.board).latest("moved_at").moved_at,
            CardActivity.objects.filter(card__board=self.board).latest("created_at").created_at,
            CardComment.objects.filter(card__board=self.board).latest("created_at").created_at,
        )
        today_noon = timezone.now().replace(hour=12, minute=0, second=0, microsecond=0)
        self.assertLess(latest, today_noon - datetime.timedelta(hours=12))


class DemoSiteBoardOrderTests(TestCase):
    def test_the_overlay_board_is_the_fifth_showcase_board(self):
        """Its id after a reset, and so its URL, comes from this position."""
        from boards.management.commands._demo_site_data import BOARDS

        self.assertEqual([b["name"] for b in BOARDS].index(OVERLAY), 4)


@override_settings(**_DEMO_SITE_SETTINGS)
class OverlayBoardUrlTests(TransactionTestCase):
    """#1889: the overlay board's URL, /boards/6, survives every demo reset.

    Recorded on unmodified main (254903166) against PostgreSQL before the
    overlay board became the imported sample: after
    ``seed_demo_data --force --wipe --demo-site --reset-database`` the boards
    are ids 1-8 in this order and the overlay board is /boards/6, on every
    reset. The SPA's board route is /boards/:id with the integer primary key.
    The reset's flush restarts the id sequences (TRUNCATE ... RESTART IDENTITY
    on PostgreSQL, sqlite_sequence on SQLite), so the ids depend only on the
    order the boards are created in; this pins that order.
    """

    EXPECTED = [
        (1, BOARD_NAME), (2, "Software Team"), (3, "Property Management"), (4, "Construction"),
        (5, "Sales Territory"), (6, OVERLAY), (7, "Content Moderation"), (8, "Logistics Exceptions"),
        (9, TRELLO),  # appended last (#1908), so the overlay board stays /boards/6
    ]

    def test_overlay_board_keeps_its_url(self):
        _seed(demo_site=True)  # an existing demo, so the sequences have moved on
        for _ in range(2):
            _seed(demo_site=True, wipe=True, force=True, reset_database=True)
            self.assertEqual(list(Board.objects.order_by("pk").values_list("pk", "name")), self.EXPECTED)
            self.assertEqual(f"/boards/{Board.objects.get(name=OVERLAY).pk}", "/boards/6")


@override_settings(**_DEMO_SITE_SETTINGS)
class DemoSiteTrelloBoardTests(TestCase):
    """#1908: a Trello-imported board, made by the real Trello importer."""

    @classmethod
    def setUpTestData(cls):
        _seed(demo_site=True)
        cls.board = Board.objects.get(name=TRELLO)
        cls.admin = User.objects.get(username="admin")

    def test_the_board_is_last_and_the_overlay_board_did_not_move(self):
        from boards.management.commands._demo_site_data import BOARDS

        self.assertEqual(BOARDS[-1], {"name": TRELLO, "trello": "trello_export.json"})
        self.assertEqual(Board.objects.latest("pk").name, TRELLO)
        # A TestCase never resets the sequences, so the absolute pk (6) is only
        # provable after reset_database (test_overlay_board_keeps_its_url);
        # here assert the relative order the pk contract rests on.
        names = list(Board.objects.order_by("pk").values_list("name", flat=True))
        self.assertEqual(names.index(OVERLAY), 5)

    def test_the_board_is_the_export(self):
        import json
        from pathlib import Path

        data = json.loads((Path(__file__).parent / "fixtures" / "trello_export.json").read_text())
        self.assertEqual(
            list(self.board.columns.order_by("position").values_list("name", flat=True)),
            [lst["name"] for lst in sorted(data["lists"], key=lambda x: x["pos"]) if not lst["closed"]],
        )
        # The seed reads the fixture from the path it builds; the card count
        # (cards in archived lists are skipped by default) is the export's.
        from boards.management.commands import seed_demo_data

        path = Path(seed_demo_data.__file__).resolve().parents[2] / "tests" / "fixtures" / "trello_export.json"
        self.assertEqual(path, Path(__file__).resolve().parent / "fixtures" / "trello_export.json")
        self.assertTrue(path.is_file())
        open_lists = {lst["id"] for lst in data["lists"] if not lst["closed"]}
        self.assertEqual(
            self.board.cards.count(),
            sum(1 for c in data["cards"] if c["idList"] in open_lists),
        )
        self.assertEqual(self.board.cards.count(), 3)

    def test_it_carries_trello_import_provenance(self):
        comments = CardComment.objects.filter(card__board=self.board)
        self.assertTrue(comments.exists())
        for comment in comments:
            self.assertTrue(comment.imported_from_username)
            self.assertTrue(comment.body.startswith("(imported from Trello)\n\n"))
        self.assertEqual({c.author_id for c in comments}, {self.admin.pk})

    def test_the_visitor_and_every_demo_account_are_seated_as_the_other_showcase_boards_do(self):
        hand_built = {m.user_id: m.role for m in BoardMembership.objects.filter(board__name="Software Team")}
        trello = {m.user_id: m.role for m in BoardMembership.objects.filter(board=self.board)}
        self.assertEqual(trello[self.admin.pk], BoardMembership.Role.ADMIN)
        visitor = User.objects.get(username="visitor")
        self.assertEqual(trello[visitor.pk], BoardMembership.Role.MEMBER)
        self.assertEqual(trello, hand_built)

    def test_it_passes_the_history_reconciler(self):
        from boards.tests.history_reconciliation import board_history_problems

        self.assertEqual(board_history_problems(self.board, imported=True), {})

    def test_the_reconciler_is_not_vacuous_for_this_board(self):
        """The import writes no history, so the seed's completion is what the reconciler reads."""
        from boards.models import CardActivity

        self.assertEqual(CardMovement.objects.filter(card__board=self.board, notes="Card created").count(), 3)
        self.assertTrue(CardMovement.objects.filter(card__board=self.board, movement_type="archived").exists())
        kinds = set(CardActivity.objects.filter(card__board=self.board).values_list("event_type", flat=True))
        self.assertIn("comment_added", kinds)
        self.assertTrue(
            CardActivity.objects.filter(card__board=self.board, event_type="comment_added")
            .exclude(imported_from_username__in=[None, ""]).exists()
        )

    def test_the_import_announces_the_board_in_the_change_feed(self):
        from boards.models import BoardEvent

        self.assertTrue(BoardEvent.objects.filter(board_id=self.board.pk, event="board.created").exists())

    def test_wipe_reseed_recreates_it_once(self):
        _seed(demo_site=True, wipe=True)
        self.assertEqual(Board.objects.filter(name=TRELLO).count(), 1)


@override_settings(**_DEMO_SITE_SETTINGS)
class SeedWipeChangeFeedTests(TestCase):
    """#1889 (#1636): --wipe ends each deleted board's change feed."""

    def test_wipe_reseed_leaves_no_board_without_board_deleted(self):
        from boards.models import BoardEvent

        _seed(demo_site=True)
        before = set(Board.objects.values_list("pk", flat=True))
        _seed(demo_site=True, wipe=True)
        existing = set(Board.objects.values_list("pk", flat=True))
        gone = before - existing
        self.assertEqual(len(gone), 9)
        for board_id in gone:
            self.assertEqual(
                BoardEvent.objects.filter(board_id=board_id, event="board.deleted").count(), 1, board_id,
            )
        for board_id in set(BoardEvent.objects.values_list("board_id", flat=True)) - existing:
            self.assertTrue(BoardEvent.objects.filter(board_id=board_id, event="board.deleted").exists(), board_id)


@override_settings(**_DEMO_SITE_SETTINGS)
class DemoSiteFiltersAndDensityTests(TestCase):
    """#1889: the demo shows saved filters and the Dense layout."""

    @classmethod
    def setUpTestData(cls):
        _seed(demo_site=True)

    def test_the_visitor_has_saved_filters_that_match_cards(self):
        from rest_framework.test import APIClient

        visitor = User.objects.get(username="visitor")
        filters = SavedFilter.objects.filter(user=visitor)
        self.assertGreaterEqual(filters.values("board").distinct().count(), 3)
        client = APIClient()
        client.force_authenticate(visitor)
        for f in filters.select_related("board"):
            resp = client.get(f"/api/v1/boards/{f.board_id}/saved-filters/")
            self.assertEqual(resp.status_code, 200, f.name)
            rows = resp.json()
            rows = rows["results"] if isinstance(rows, dict) else rows
            self.assertIn(f.name, [r["name"] for r in rows])
            # Each filter selects something on its board, matched the way the
            # SPA matches it (frontend/src/utils/filterCards.ts).
            state = f.state_json
            cards = f.board.cards.filter(archived_at__isnull=True)
            if state["labelIds"]:
                cards = cards.filter(labels__in=state["labelIds"])
            if state["priorities"]:
                cards = cards.filter(priority__in=state["priorities"])
            today = timezone.localdate()
            if state["dueDate"] == "overdue":
                cards = cards.filter(due_date__lt=today)
            elif state["dueDate"] == "this_week":
                cards = cards.filter(due_date__gte=today, due_date__lt=today + datetime.timedelta(days=7))
            else:
                self.assertIsNone(state["dueDate"], f.name)
            self.assertTrue(cards.exists(), f.name)
        self.assertEqual(
            {f.state_json["dueDate"] for f in filters} - {None}, {"overdue", "this_week"},
        )

    def test_one_board_uses_the_dense_layout(self):
        self.assertEqual(Board.objects.get(name="Software Team").card_density, "dense")
