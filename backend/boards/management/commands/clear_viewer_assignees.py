"""
Find and clear card assignees whose role on the board is viewer.

Before the _get_assignable_member_ids() fix, the CardSerializer accepted any
board member as an assignee — including viewers.  This command finds cards
that are still assigned to viewer-role users and either reports them (dry-run)
or clears the assignee field.

Usage:
    # Preview affected cards without making changes:
    python manage.py clear_viewer_assignees --dry-run

    # Clear all stale viewer assignees:
    python manage.py clear_viewer_assignees

    # Restrict to a single board:
    python manage.py clear_viewer_assignees --board 42
"""
from django.core.management.base import BaseCommand

from boards.models import Board, BoardMembership, Card


class Command(BaseCommand):
    help = "Clear card assignees who hold only a viewer role on the board."

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Report affected cards without modifying anything.",
        )
        parser.add_argument(
            "--board",
            type=int,
            metavar="BOARD_ID",
            help="Restrict the scan to a single board.",
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        board_id = options.get("board")

        boards_qs = Board.objects.all()
        if board_id:
            boards_qs = boards_qs.filter(pk=board_id)

        total_cleared = 0

        for board in boards_qs.prefetch_related("memberships"):
            # Collect user IDs that have at least one non-viewer membership on
            # this board.  A user with both a direct viewer membership AND an
            # inherited non-viewer membership is fine — we only want pure viewers.
            non_viewer_ids = set(
                board.memberships.exclude(role=BoardMembership.Role.VIEWER)
                .values_list("user_id", flat=True)
            )
            # Also treat the board owner and site admins as non-viewers.
            non_viewer_ids.add(board.owner_id)

            viewer_only_ids = set(
                board.memberships.filter(role=BoardMembership.Role.VIEWER)
                .values_list("user_id", flat=True)
            ) - non_viewer_ids

            if not viewer_only_ids:
                continue

            affected = Card.objects.filter(
                board=board,
                assignee_id__in=viewer_only_ids,
                archived_at__isnull=True,
            ).select_related("assignee", "column")

            for card in affected:
                self.stdout.write(
                    f"{'[DRY RUN] ' if dry_run else ''}"
                    f"Board {board.pk} ({board.name!r})  "
                    f"Card {card.pk} ({card.title!r})  "
                    f"assignee={card.assignee.username!r} (viewer)"
                )

            if not dry_run and affected.exists():
                count = affected.count()
                affected.update(assignee=None)
                total_cleared += count

        if dry_run:
            self.stdout.write(self.style.WARNING("Dry run — no changes made."))
        else:
            self.stdout.write(
                self.style.SUCCESS(f"Cleared assignee on {total_cleared} card(s).")
            )
