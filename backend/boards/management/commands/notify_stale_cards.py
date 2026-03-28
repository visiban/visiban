"""
Scan all boards for stale cards and create in-app notifications.

Idempotent: skips cards that already received a staleness notification today.

Usage:
    python manage.py notify_stale_cards
    # Add to cron: 0 8 * * * docker compose run --rm backend python manage.py notify_stale_cards
"""
import datetime

from django.core.management.base import BaseCommand
from django.db.models import Prefetch
from django.utils import timezone

from accounts.models import User
from boards.models import Board, Card, CardMovement, Notification


class Command(BaseCommand):
    help = "Create notifications for cards that exceed the board staleness threshold."

    def handle(self, *args, **options):
        now = timezone.now()
        today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        created_count = 0
        skipped_count = 0

        for board in Board.objects.prefetch_related("memberships__user"):
            cutoff = now - datetime.timedelta(days=board.staleness_threshold_days)

            # Collect admin user IDs for this board (once per board, not per card)
            admin_users = set(
                board.memberships.filter(role="admin").values_list("user_id", flat=True)
            )
            admin_users.add(board.owner_id)

            # Hoist user opt-in lookup: fetch all opted-in user IDs for this
            # board's potential recipients in one query instead of per-card.
            all_candidate_ids = set(admin_users)
            assignee_ids = set(
                Card.objects.filter(
                    board=board, archived_at__isnull=True, assignee_id__isnull=False
                ).values_list("assignee_id", flat=True).distinct()
            )
            all_candidate_ids |= assignee_ids
            opted_in_ids = set(
                User.objects.filter(pk__in=all_candidate_ids, notif_due_soon=True)
                .values_list("pk", flat=True)
            )

            if not opted_in_ids:
                continue  # no one to notify for this board

            # Prefetch movements ordered by -moved_at so .all()[0] uses the cache
            cards = (
                Card.objects.filter(board=board, archived_at__isnull=True)
                .prefetch_related(
                    Prefetch(
                        "movements",
                        queryset=CardMovement.objects.order_by("-moved_at"),
                    )
                )
            )

            # Batch idempotency check: fetch all (card_id, recipient_id) pairs
            # already notified today in one query instead of per-card-per-user.
            card_ids = list(cards.values_list("pk", flat=True))
            already_notified = set(
                Notification.objects.filter(
                    card_id__in=card_ids,
                    recipient_id__in=opted_in_ids,
                    action_type=Notification.ActionType.STALE,
                    created_at__gte=today_start,
                ).values_list("card_id", "recipient_id")
            )

            notifications_to_create = []

            for card in cards:
                # Use .all()[0] to hit the prefetch cache instead of .first()
                # which issues a separate ORDER BY + LIMIT 1 query per card.
                movements = card.movements.all()
                if movements:
                    last_mv = movements[0]
                    if last_mv.moved_at >= cutoff:
                        continue  # not stale
                    stale_since = last_mv.moved_at
                else:
                    if (now - card.created_at).days < board.staleness_threshold_days:
                        continue
                    stale_since = card.created_at

                days_stale = (now - stale_since).days
                verb = f"\"{card.title}\" hasn't moved in {days_stale} days (board: {board.name})"

                # Recipients: assignee + board admins, filtered to opted-in
                recipients = set(admin_users)
                if card.assignee_id:
                    recipients.add(card.assignee_id)
                recipients &= opted_in_ids

                for user_id in recipients:
                    if (card.pk, user_id) in already_notified:
                        skipped_count += 1
                        continue
                    notifications_to_create.append(
                        Notification(
                            recipient_id=user_id,
                            action_type=Notification.ActionType.STALE,
                            verb=verb,
                            card=card,
                            board=board,
                        )
                    )
                    created_count += 1

            if notifications_to_create:
                Notification.objects.bulk_create(notifications_to_create)

        self.stdout.write(
            self.style.SUCCESS(
                f"notify_stale_cards: {created_count} notifications created, {skipped_count} skipped (already sent today)."
            )
        )
