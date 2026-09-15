"""Delete board change-feed events older than the retention window (#1114).

The feed is append-only and nothing expires on its own, so this command is the
only thing that bounds the table. Schedule it; an unscheduled install grows
``board_events`` forever.

Usage::

    python manage.py prune_board_events
    python manage.py prune_board_events --days 7 --dry-run
    # Add to cron: 0 3 * * * docker compose run --rm backend python manage.py prune_board_events

Consumers are not silently corrupted by a prune. A cursor that this command
removed comes back as ``410 Gone`` from ``GET /boards/<id>/events/`` — with a
pointer to re-sync via ``/full/`` — rather than as a page that quietly skips the
events in between.
"""

import datetime

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from boards.models import BoardEvent


class Command(BaseCommand):
    help = "Delete board change-feed events older than the retention window."

    def add_arguments(self, parser):
        parser.add_argument(
            "--days",
            type=int,
            default=None,
            help=(
                "Retention window in days. Defaults to settings.BOARD_EVENT_RETENTION_DAYS "
                "(env BOARD_EVENT_RETENTION_DAYS, default 30)."
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
            days = getattr(settings, "BOARD_EVENT_RETENTION_DAYS", 30)
        if days < 1:
            raise CommandError("--days must be at least 1.")
        batch_size = options["batch_size"]
        if batch_size < 1:
            raise CommandError("--batch-size must be at least 1.")

        cutoff = timezone.now() - datetime.timedelta(days=days)
        stale = BoardEvent.objects.filter(created_at__lt=cutoff)

        if options["dry_run"]:
            count = stale.count()
            self.stdout.write(
                f"Would delete {count} board event(s) created before {cutoff.isoformat()}."
            )
            return

        # Deleted in batches of primary keys rather than as one statement.
        # A single DELETE over months of a busy install's history holds its locks
        # and its WAL for the whole run; batching keeps each statement short so
        # concurrent writers to board_events are not queued behind the cleanup.
        # The ids are re-read each pass because rows are appended continuously —
        # a snapshot taken once would go stale mid-run.
        total = 0
        while True:
            ids = list(
                stale.order_by("id").values_list("pk", flat=True)[:batch_size]
            )
            if not ids:
                break
            deleted, _ = BoardEvent.objects.filter(pk__in=ids).delete()
            total += deleted
            if len(ids) < batch_size:
                break

        self.stdout.write(
            self.style.SUCCESS(
                f"Deleted {total} board event(s) created before {cutoff.isoformat()}."
            )
        )
