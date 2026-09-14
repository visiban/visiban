"""
Find cards whose column or swimlane belongs to a different board than the card.

Before the CardSerializer/CardViewSet fix for #1106, PATCH/PUT
`.../cards/{id}/` accepted a `column` or `swimlane` primary key from *any*
board. The card's own `board` field was left unchanged, so the row silently
disappeared from both boards' `/full/` views, bypassed WIP/weight
enforcement, and produced no `CardMovement` audit record.

This command is read-only: it reports affected cards so operators can decide
how to repair each one (there is no way to infer the "correct" destination
column/swimlane automatically). See the "Data integrity check" note under
upgrading to 1.2 in docs/administration/upgrade.md.

Usage:
    # Report every board:
    python manage.py find_cross_board_cards

    # Restrict to a single board:
    python manage.py find_cross_board_cards --board 42
"""
from django.core.management.base import BaseCommand
from django.db.models import F

from boards.models import Card


class Command(BaseCommand):
    help = "List cards whose column or swimlane belongs to a different board than the card (#1106)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--board",
            type=int,
            metavar="BOARD_ID",
            help="Restrict the scan to a single board.",
        )

    def handle(self, *args, **options):
        board_id = options.get("board")

        qs = Card.objects.select_related("board", "column", "column__board", "swimlane", "swimlane__board")
        if board_id:
            qs = qs.filter(board_id=board_id)

        # Exclude() with a cross-table F() comparison finds rows where the
        # denormalized board_id on column/swimlane disagrees with the card's
        # own board_id — exactly the state described in #1106.
        mismatched_column = qs.exclude(column__board_id=F("board_id"))
        mismatched_swimlane = qs.exclude(swimlane__board_id=F("board_id"))

        affected = {card.pk: card for card in mismatched_column}
        affected.update({card.pk: card for card in mismatched_swimlane})

        if not affected:
            self.stdout.write(self.style.SUCCESS("No cross-board cards found."))
            return

        for card in sorted(affected.values(), key=lambda c: c.pk):
            problems = []
            if card.column.board_id != card.board_id:
                problems.append(f"column {card.column_id!r} ({card.column.name!r}) belongs to board {card.column.board_id}")
            if card.swimlane.board_id != card.board_id:
                problems.append(f"swimlane {card.swimlane_id!r} ({card.swimlane.name!r}) belongs to board {card.swimlane.board_id}")
            self.stdout.write(
                f"Card {card.pk} ({card.title!r}) on board {card.board_id} ({card.board.name!r}): "
                + "; ".join(problems)
            )

        self.stdout.write(
            self.style.WARNING(
                f"{len(affected)} card(s) point at a column/swimlane from another board. "
                "This command makes no changes — repair each card manually."
            )
        )
