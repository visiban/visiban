"""Delete in-app notifications older than the retention window (#1158).

Nothing expires a notification on its own, and the scheduled scans
(``notify_due_soon``, ``notify_stale_cards``) add rows every day, so this
command is the only thing that bounds the ``notifications`` table. It deletes
read and unread rows alike: a notification about a card that went stale three
months ago is not actionable any more, and keeping unread rows forever would
leave the table unbounded for exactly the users who never open the bell.

Usage::

    python manage.py prune_notifications
    python manage.py prune_notifications --days 180 --dry-run
    # Add to cron: 30 3 * * * docker compose run --rm backend python manage.py prune_notifications

Why there is a minimum window: notification rows double as the de-duplication
record for the scheduled scans. ``notify_due_soon`` looks back up to
``--days`` + 1 days for an earlier DUE_SOON row and ``notify_stale_cards``
looks back to the start of today. Prune those rows and the next scan
re-notifies — and, with email on, re-emails — the same card. The floor keeps
the retention window comfortably wider than any look-back a scan uses.
"""

import datetime

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from boards.models import Notification

# See the module docstring. Two weeks covers notify_due_soon with a --days of up
# to 13, well past the documented default of 1.
MIN_RETENTION_DAYS = 14


class Command(BaseCommand):
    help = "Delete in-app notifications older than the retention window."

    def add_arguments(self, parser):
        parser.add_argument(
            "--days",
            type=int,
            default=None,
            help=(
                "Retention window in days. Defaults to settings.NOTIFICATION_RETENTION_DAYS "
                f"(env NOTIFICATION_RETENTION_DAYS, default 90). Minimum {MIN_RETENTION_DAYS}."
            ),
        )
        parser.add_argument(
            "--batch-size",
            type=int,
            default=5000,
            help="Rows to delete per statement. Default 5000.",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Report what would be deleted without deleting anything.",
        )

    def handle(self, *args, **options):
        days = options["days"]
        if days is None:
            days = getattr(settings, "NOTIFICATION_RETENTION_DAYS", 90)
        if days < MIN_RETENTION_DAYS:
            raise CommandError(
                f"Retention must be at least {MIN_RETENTION_DAYS} days (got {days}). "
                "Notification rows are the de-duplication record for notify_due_soon "
                "and notify_stale_cards; a shorter window makes them re-notify."
            )
        batch_size = options["batch_size"]
        if batch_size < 1:
            raise CommandError("--batch-size must be at least 1.")

        cutoff = timezone.now() - datetime.timedelta(days=days)
        # order_by("id") overrides the model's default -created_at ordering, which
        # would otherwise force a sort over every candidate row per batch.
        stale = Notification.objects.filter(created_at__lt=cutoff).order_by("id")

        if options["dry_run"]:
            count = stale.count()
            self.stdout.write(
                f"Would delete {count} notification(s) created before {cutoff.isoformat()}."
            )
            return

        # Deleted in primary-key batches, paging forward by id rather than
        # re-reading from the start of the table each pass. There is no index on
        # created_at (the only one is recipient/read/-created_at, for the inbox),
        # so each batch is a primary-key range scan; ids and created_at both grow
        # on insert, so the old rows sit at the low end and every batch but the
        # last stops after a short walk. Batching keeps each DELETE short so
        # concurrent notification inserts are not queued behind the cleanup.
        total = 0
        last_id = 0
        while True:
            ids = list(
                stale.filter(pk__gt=last_id).values_list("pk", flat=True)[:batch_size]
            )
            if not ids:
                break
            deleted, _ = Notification.objects.filter(pk__in=ids).delete()
            total += deleted
            last_id = ids[-1]
            if len(ids) < batch_size:
                break

        self.stdout.write(
            self.style.SUCCESS(
                f"Deleted {total} notification(s) created before {cutoff.isoformat()}."
            )
        )
