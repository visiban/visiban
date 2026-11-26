"""``repair_card_positions``: renumber cells that hold duplicate live positions (#2578).

The #2562 / #2563 fixes stop new collisions; this command repairs cells that
hit either defect before the upgrade. Duplicates are seeded with direct ORM
writes, which is the state the old ``create_card`` / ``unarchive_card`` left.
"""
import io
import threading
from unittest import skipUnless

from django.core.management import call_command
from django.db import connection, connections, transaction
from django.test import TestCase, TransactionTestCase
from django.utils import timezone

from boards.management.commands.repair_card_positions import (
    colliding_cells, renumber_plan, repair_cell,
)
from boards.models import Card, Column
from boards.services.errors import ColumnNotFound, VersionConflict
from boards.tests.conftest import _make_board, _make_column, _make_swimlane, _make_user
from boards.tests.lock_wait import assert_blocked_on_lock


class _Base:
    def _setup(self):
        self.user = _make_user("repair-2578")
        self.board = _make_board(self.user, name="Repair")
        self.col = _make_column(self.board, "A", 0)
        self.other_col = _make_column(self.board, "B", 1)
        self.lane = _make_swimlane(self.board, "L", 0)
        self.lane2 = _make_swimlane(self.board, "M", 1)

    def _card(self, title, position, *, col=None, lane=None, archived=False):
        return Card.objects.create(
            board=self.board, column=col or self.col, swimlane=lane or self.lane, title=title,
            created_by=self.user, position=position, archived_at=timezone.now() if archived else None,
        )

    def _run(self, *args):
        out, err = io.StringIO(), io.StringIO()
        call_command("repair_card_positions", *args, stdout=out, stderr=err)
        return out.getvalue(), err.getvalue()

    def _cell(self, col=None, lane=None):
        """Live cards of a cell in visible order, as ``(title, position)``."""
        return list(
            Card.objects.filter(column=col or self.col, swimlane=lane or self.lane, archived_at__isnull=True)
            .order_by("position", "pk").values_list("title", "position")
        )


class RenumberPlanTests(TestCase):
    def test_smallest_change_that_keeps_order(self):
        # (pk, position): 1 and 3 share slot 1; 5 sits after a gap.
        self.assertEqual(renumber_plan([(1, 0), (2, 1), (3, 1), (4, 2), (5, 5)]), {3: 2, 4: 3})

    def test_tie_break_is_pk(self):
        self.assertEqual(renumber_plan([(9, 0), (4, 0)]), {9: 1})

    def test_no_duplicate_means_no_change(self):
        self.assertEqual(renumber_plan([(1, 0), (2, 3), (3, 7)]), {})
        self.assertEqual(renumber_plan([]), {})


class RepairCommandTests(_Base, TestCase):
    def setUp(self):
        self._setup()

    def test_repairs_duplicates_keeping_visible_order(self):
        self._card("a", 0)
        self._card("b", 1)
        self._card("c", 1)  # the #2562 collision: created onto b's slot
        self._card("d", 2)
        self._card("e", 5)
        out, _ = self._run()
        self.assertEqual(self._cell(), [("a", 0), ("b", 1), ("c", 2), ("d", 3), ("e", 5)])
        self.assertIn("Repaired 1 cell(s), 2 card(s) renumbered.", out)
        self.assertEqual(colliding_cells(), [])

    def test_cells_without_a_collision_are_untouched(self):
        self._card("x", 0)
        self._card("y", 1)
        clean = [self._card("p", 0, lane=self.lane2), self._card("q", 4, lane=self.lane2)]
        other = self._card("r", 3, col=self.other_col)
        before = {c.pk: (c.position, c.updated_at, c.version) for c in [*clean, other]}
        self._card("z", 1)  # collision in (A, L) only
        self._run()
        after = {
            c.pk: (c.position, c.updated_at, c.version)
            for c in Card.objects.filter(pk__in=before)
        }
        self.assertEqual(after, before)

    def test_archived_cards_are_not_renumbered_and_do_not_count_as_collisions(self):
        self._card("live", 1)
        archived = self._card("old", 1, archived=True)  # archived on a live slot: allowed
        self.assertEqual(colliding_cells(), [])
        self._card("live2", 1)  # now a live collision
        self._run()
        archived.refresh_from_db()
        self.assertEqual(archived.position, 1)
        self.assertEqual(self._cell(), [("live", 1), ("live2", 2)])

    def test_dry_run_writes_nothing(self):
        a, b = self._card("a", 0), self._card("b", 0)
        out, _ = self._run("--dry-run")
        self.assertIn(f"Would renumber 1 card(s) in board {self.board.pk}, column {self.col.pk}, swimlane {self.lane.pk}", out)
        self.assertIn("Would repair 1 cell(s), 1 card(s) renumbered.", out)
        self.assertEqual(
            list(Card.objects.filter(pk__in=[a.pk, b.pk]).values_list("position", flat=True)), [0, 0],
        )

    def test_board_option_limits_the_repair(self):
        self._card("a", 0)
        self._card("b", 0)
        other_board = _make_board(self.user, name="Other")
        col = _make_column(other_board, "A", 0)
        lane = _make_swimlane(other_board, "L", 0)
        for t in ("c", "d"):
            Card.objects.create(board=other_board, column=col, swimlane=lane, title=t, created_by=self.user, position=0)
        self._run("--board", str(other_board.pk))
        self.assertEqual(colliding_cells(), [(self.board.pk, self.col.pk, self.lane.pk)])

    def test_nothing_to_repair(self):
        self._card("a", 0)
        out, _ = self._run()
        self.assertIn("Repaired 0 cell(s), 0 card(s) renumbered.", out)

    def test_cell_healed_before_the_lock_is_skipped(self):
        """A cell found colliding but healed by the time it is locked writes nothing."""
        self._card("a", 0)
        b = self._card("b", 0)
        Card.objects.filter(pk=b.pk).update(position=1)
        self.assertEqual(repair_cell(self.board.pk, self.col.pk, self.lane.pk), 0)

    def test_board_deleted_meanwhile_is_a_no_op(self):
        self.assertEqual(repair_cell(10**9, self.col.pk, self.lane.pk), 0)

    def test_busy_or_deleted_cell_is_reported_and_skipped(self):
        from unittest import mock

        self._card("a", 0)
        self._card("b", 0)
        for exc in (VersionConflict(None), ColumnNotFound()):
            with mock.patch(
                "boards.management.commands.repair_card_positions._lock_cell_for_placement", side_effect=exc,
            ):
                out, err = self._run()
            self.assertIn("Skipped board", err)
            self.assertIn("Skipped 1 cell(s).", out)
        self.assertEqual(len(colliding_cells()), 1)


@skipUnless(connection.vendor == "postgresql", "row locks need PostgreSQL")
class RepairWaitsOnColumnLockTests(_Base, TransactionTestCase):
    """The repair takes the cell's column row lock, as ``move_card`` does, before it renumbers."""

    def test_repair_waits_for_a_column_lock_holder(self):
        """Hold only the column row (as a column reorder or limit check does):
        the repair must wait on it before writing. The holder must not touch
        the cell's card rows, which the repair locks first (move_card's order)."""
        self._setup()
        self._card("a", 0)
        self._card("b", 0)
        results = {}

        def repair():
            try:
                results["n"] = repair_cell(self.board.pk, self.col.pk, self.lane.pk)
            finally:
                connections.close_all()

        worker = threading.Thread(target=repair)
        with transaction.atomic():
            Column.objects.select_for_update(no_key=True).get(pk=self.col.pk)
            worker.start()
            assert_blocked_on_lock(self, worker, "repair did not wait on the column row lock")
            self.assertEqual(self._cell(), [("a", 0), ("b", 0)], "repair wrote before it held the column")
        worker.join(10)
        self.assertFalse(worker.is_alive())
        self.assertEqual(results["n"], 1)
        self.assertEqual(self._cell(), [("a", 0), ("b", 1)])
