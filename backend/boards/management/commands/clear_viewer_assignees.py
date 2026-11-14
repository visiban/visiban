"""
Find and clear card and checklist item assignees who have board access but are not assignable.

Before the _get_assignable_member_ids() fix, the CardSerializer accepted any
board member as an assignee — including viewers.  This command finds cards
that are still assigned to users with board access who are not assignable (viewers, and
users whose explicit board row overrides a group-inherited role) and either reports them (dry-run)
or clears the assignee field. Since #2200 it treats checklist item assignees
(#445) the same way, so a viewer is never left as the owner of a to-do on a
card they cannot edit.

A live run, per board, in one transaction:

- records a History row for every cleared assignee (``assignee_change`` on the
  card, ``checklist_item_assigned`` on a checklist item; no actor, since no
  user made the change), and
- emits ``card.updated`` for every card it touched (#1744), so connected
  clients stop showing the old assignee without a reload. The cards are
  rendered in one prefetch pass per board and each frame is recorded with
  ``record_board_event``, so the publish waits for the commit.

Usage:
    # Preview affected cards without making changes:
    python manage.py clear_viewer_assignees --dry-run

    # Clear all stale viewer assignees:
    python manage.py clear_viewer_assignees

    # Restrict to a single board:
    python manage.py clear_viewer_assignees --board 42
"""
from django.core.management.base import BaseCommand
from django.db import transaction

from boards import broadcast
from boards.models import Board, Card, CardActivity, CardChecklist
from boards.utils import _get_assignable_member_ids, _get_effective_member_ids

ET = CardActivity.EventType


class Command(BaseCommand):
    help = "Clear card and checklist item assignees who have board access but are not assignable."

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

        total_cards = 0
        total_items = 0

        # No prefetch: the member-set helpers read ``_prefetched_memberships``
        # (set by get_board_for_user), not the ``memberships`` prefetch cache.
        for board in boards_qs.order_by("pk"):
            # Same sets as the card serializer, so the backfill agrees with the
            # role-resolution ladder (explicit board rows override group
            # inheritance). Only users who still hold board access but are not
            # assignable are candidates: a former member's assignee is left in
            # place on purpose (see notifications_email.py), so it is not touched.
            # Archived cards and their checklist items are left alone, as before.
            card_assignees = set(
                Card.objects.filter(
                    board=board, assignee_id__isnull=False, archived_at__isnull=True
                )
                .values_list("assignee_id", flat=True)
                .distinct()
            )
            item_assignees = set(
                CardChecklist.objects.filter(
                    card__board=board, assignee_id__isnull=False, card__archived_at__isnull=True
                )
                .values_list("assignee_id", flat=True)
                .distinct()
            )
            if not card_assignees and not item_assignees:
                continue
            assignable_ids = _get_assignable_member_ids(board)
            access_only_ids = _get_effective_member_ids(board) - assignable_ids
            stale_ids = (card_assignees | item_assignees) & access_only_ids
            if not stale_ids:
                continue

            if dry_run:
                cards, items = self._affected(board, stale_ids)
                self._report(
                    board, cards.order_by("pk"), items.order_by("card_id", "pk"),
                    prefix="[DRY RUN] ",
                )
                continue

            cards, items = self._clear_board(board, stale_ids)
            total_cards += cards
            total_items += items

        if dry_run:
            self.stdout.write(self.style.WARNING("Dry run — no changes made."))
        else:
            self.stdout.write(
                self.style.SUCCESS(
                    f"Cleared assignee on {total_cards} card(s) "
                    f"and {total_items} checklist item(s)."
                )
            )

    def _affected(self, board, stale_ids):
        cards = Card.objects.filter(
            board=board, assignee_id__in=stale_ids, archived_at__isnull=True
        ).select_related("assignee")
        items = CardChecklist.objects.filter(
            card__board=board, assignee_id__in=stale_ids, card__archived_at__isnull=True
        ).select_related("assignee", "card")
        return cards, items

    def _report(self, board, cards, items, *, prefix=""):
        for card in cards:
            self.stdout.write(
                f"{prefix}Board {board.pk} ({board.name!r})  "
                f"Card {card.pk} ({card.title!r})  "
                f"assignee={card.assignee.username!r} (not assignable)"
            )
        for item in items:
            self.stdout.write(
                f"{prefix}Board {board.pk} ({board.name!r})  "
                f"Card {item.card_id} ({item.card.title!r})  "
                f"Checklist item {item.pk} ({item.text!r})  "
                f"assignee={item.assignee.username!r} (not assignable)"
            )

    def _clear_board(self, board, stale_ids):
        """Clear one board's stale assignees, record History, announce the cards.

        The card rows are locked first, in pk order, as every REST write to a
        card or its checklist does (#1587), so the History rows name the
        assignee actually cleared and a concurrent reassignment is either
        seen here or lands after. The rows to clear are read again after the
        lock, limited to the cards that were locked: an assignee changed in
        the meantime is not cleared, and an assignment that landed on a card
        that was not locked is left for the next run.
        ``version`` is not bumped, as before (see ``_move_relevant_state``).
        """
        with transaction.atomic():
            cards_qs, items_qs = self._affected(board, stale_ids)
            card_ids = set(cards_qs.values_list("pk", flat=True)) | set(
                items_qs.values_list("card_id", flat=True)
            )
            list(
                Card.objects.filter(pk__in=card_ids)
                .order_by("pk")
                .select_for_update()
                .values_list("pk", flat=True)
            )
            cards = list(cards_qs.filter(pk__in=card_ids).order_by("pk"))
            items = list(items_qs.filter(card_id__in=card_ids).order_by("card_id", "pk"))
            self._report(board, cards, items)
            CardActivity.objects.bulk_create(
                [
                    CardActivity(
                        card=card, event_type=ET.ASSIGNEE_CHANGE,
                        from_value=card.assignee.username, to_value="Unassigned",
                    )
                    for card in cards
                ]
                + [
                    CardActivity(
                        card_id=item.card_id, event_type=ET.CHECKLIST_ITEM_ASSIGNED,
                        from_value=item.assignee.username, to_value="",
                        item_text=item.text,
                    )
                    for item in items
                ]
            )
            Card.objects.filter(pk__in=[c.pk for c in cards]).update(assignee=None)
            CardChecklist.objects.filter(pk__in=[i.pk for i in items]).update(assignee=None)

            touched = {c.pk for c in cards} | {i.card_id for i in items}
            if touched:
                from boards.views._helpers import render_card_payloads

                for card_data in render_card_payloads(board, touched):
                    broadcast.record_board_event(
                        board.pk, broadcast.EVT_CARD_UPDATED, card_data
                    )
        return len(cards), len(items)
