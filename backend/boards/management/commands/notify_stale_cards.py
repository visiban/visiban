"""
Scan all boards for stale cards and create in-app notifications.

Idempotent: skips cards that already received a staleness notification today.

Usage:
    python manage.py notify_stale_cards
    # Add to cron: 0 8 * * * docker compose run --rm backend python manage.py notify_stale_cards
"""
import datetime

from django.core.management.base import BaseCommand
from django.utils import timezone

from boards.models import Board, Card, Notification


class Command(BaseCommand):
    help = "Create notifications for cards that exceed the board staleness threshold."

    def handle(self, *args, **options):
        now = timezone.now()
        today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        created_count = 0
        skipped_count = 0

        for board in Board.objects.prefetch_related("memberships__user"):
            cutoff = now - datetime.timedelta(days=board.staleness_threshold_days)

            # Collect admin users for this board
            admin_users = list(
                board.memberships.filter(role="admin").values_list("user_id", flat=True)
            )
            if board.owner_id not in admin_users:
                admin_users.append(board.owner_id)

            for card in Card.objects.filter(board=board).prefetch_related("movements"):
                last_mv = card.movements.first()  # -moved_at ordering
                if last_mv:
                    if last_mv.moved_at >= cutoff:
                        continue  # not stale
                    stale_since = last_mv.moved_at
                else:
                    if (now - card.created_at).days < board.staleness_threshold_days:
                        continue
                    stale_since = card.created_at

                days_stale = (now - stale_since).days
                verb = f"\"{card.title}\" hasn't moved in {days_stale} days (board: {board.name})"

                # Recipients: assignee + board admins
                recipients = set(admin_users)
                if card.assignee_id:
                    recipients.add(card.assignee_id)

                for user_id in recipients:
                    # Idempotency: skip if already notified today for this card
                    already = Notification.objects.filter(
                        recipient_id=user_id,
                        card=card,
                        verb__startswith='"' + card.title[:20],
                        created_at__gte=today_start,
                    ).exists()
                    if already:
                        skipped_count += 1
                        continue
                    Notification.objects.create(
                        recipient_id=user_id,
                        verb=verb,
                        card=card,
                        board=board,
                    )
                    created_count += 1

        self.stdout.write(
            self.style.SUCCESS(
                f"notify_stale_cards: {created_count} notifications created, {skipped_count} skipped (already sent today)."
            )
        )
