"""Renumber the cells that hold two live cards on one position (#2578).

Before the #2562 / #2563 fixes, ``create_card`` (after a same-cell reorder)
and ``unarchive_card`` (after the source-cell compaction gave the slot away)
could put a card on a position a live card already held. The fixes stop new
collisions; this command repairs the ones a board already has. Nothing else
creates them, so it is a one-off: run it once after upgrading to 1.3.

What it changes, and what it leaves alone:

- Only cells (a column and swimlane pair) holding at least two live cards on
  one position are touched. Every other cell is left exactly as it is.
- In a touched cell, the live cards keep their visible order: by position,
  then by id (creation order) for cards that shared a position. Each card
  keeps its position unless that would put it on or before the card ahead of
  it, in which case it moves to one past that card. So a cell ``0, 1, 1, 2, 5``
  becomes ``0, 1, 2, 3, 5``: the smallest change that leaves no duplicate.
- Archived cards are not renumbered. They keep their slot; ``unarchive_card``
  already sends a card to the end of its cell when a live card holds its slot.
- Card ``version`` is not bumped, as for the sibling cards a move renumbers.

Locking: each cell is repaired in its own transaction, under the locks a
placement takes: the board row ``FOR SHARE``, then the cell's card rows, then
its column row (``_lock_cell_for_placement``, the order ``move_card`` uses). A
move, create or unarchive in that cell waits for the repair, and the cell is
re-read under the lock, so a cell a concurrent write already healed is
skipped. A cell that stays busy (a ``VersionConflict``) or whose column was
deleted meanwhile is reported and skipped; running the command again retries
it.

No board events are sent. The visible order does not change (cards that
shared a position had no defined order between them), so an open board
looks the same; it reads the new positions on its next load, and any move
it makes meanwhile is placed by the server under the same lock. Run it at a
quiet time if you want open boards to reload first.

Usage:
    python manage.py repair_card_positions --dry-run
    python manage.py repair_card_positions
    python manage.py repair_card_positions --board 42
"""
from django.core.management.base import BaseCommand
from django.db import transaction
from django.db.models import Count

from boards.services.errors import ColumnNotFound, VersionConflict
from boards.models import Board, Card, Column, Swimlane
from boards.services.cards import _lock_cell_for_placement, lock_board_for_card_write


def colliding_cells(board_id=None):
    """``(board_id, column_id, swimlane_id)`` of every cell with a duplicate live position."""
    live = Card.objects.filter(archived_at__isnull=True)
    if board_id is not None:
        live = live.filter(board_id=board_id)
    rows = (
        live.values("board_id", "column_id", "swimlane_id", "position")
        .annotate(n=Count("id"))
        .filter(n__gt=1)
        .order_by("board_id", "column_id", "swimlane_id")
        .values_list("board_id", "column_id", "swimlane_id")
    )
    return list(dict.fromkeys(rows))


def renumber_plan(cards):
    """``{pk: new_position}`` for the cards ``(pk, position)`` that must move, keeping order.

    Sorted by position then pk, each card takes ``max(position, previous + 1)``.
    Empty when the cell already has no duplicate.
    """
    plan = {}
    previous = None
    for pk, position in sorted(cards, key=lambda c: (c[1], c[0])):
        new = position if previous is None else max(position, previous + 1)
        if new != position:
            plan[pk] = new
        previous = new
    return plan


def _live_cell(board_id, column_id, swimlane_id):
    return Card.objects.filter(
        board_id=board_id, column_id=column_id, swimlane_id=swimlane_id, archived_at__isnull=True,
    )


def repair_cell(board_id, column_id, swimlane_id):
    """Renumber one cell under the placement locks; return how many cards moved.

    Returns 0 when the cell no longer holds a duplicate once locked. Raises
    ``ColumnNotFound`` / ``VersionConflict`` (from the lock helper) for the
    caller to report; nothing is written then.
    """
    with transaction.atomic():
        if not lock_board_for_card_write(board_id):
            return 0
        board = Board(pk=board_id)
        _lock_cell_for_placement(
            board=board, column=Column(pk=column_id), swimlane=Swimlane(pk=swimlane_id),
        )
        plan = renumber_plan(_live_cell(board_id, column_id, swimlane_id).values_list("pk", "position"))
        if not plan:
            return 0
        rows = [Card(pk=pk, position=position) for pk, position in plan.items()]
        Card.objects.bulk_update(rows, ["position"])
        return len(rows)


class Command(BaseCommand):
    help = "Renumber cells that hold two live cards on one position, keeping their order (#2578)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run", action="store_true",
            help="Report the cells that would be repaired without writing anything.",
        )
        parser.add_argument(
            "--board", type=int, metavar="BOARD_ID", help="Restrict the repair to one board.",
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        cells = colliding_cells(options.get("board"))
        repaired = moved = skipped = 0
        for board_id, column_id, swimlane_id in cells:
            where = f"board {board_id}, column {column_id}, swimlane {swimlane_id}"
            if dry_run:
                count = len(renumber_plan(_live_cell(board_id, column_id, swimlane_id).values_list("pk", "position")))
                if count:
                    repaired += 1
                    moved += count
                    self.stdout.write(f"Would renumber {count} card(s) in {where}")
                continue
            try:
                count = repair_cell(board_id, column_id, swimlane_id)
            except (ColumnNotFound, VersionConflict) as exc:
                skipped += 1
                self.stderr.write(f"Skipped {where}: {type(exc).__name__}. Run the command again to retry it.")
                continue
            if count:
                repaired += 1
                moved += count
                self.stdout.write(f"Renumbered {count} card(s) in {where}")
        verb = "Would repair" if dry_run else "Repaired"
        summary = f"{verb} {repaired} cell(s), {moved} card(s) renumbered."
        if skipped:
            summary += f" Skipped {skipped} cell(s)."
        self.stdout.write(self.style.SUCCESS(summary))
