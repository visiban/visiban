"""Delete board change-feed events older than the retention window (#1114).

The feed is append-only and nothing expires on its own, so this command is the
only thing that bounds the table. Schedule it; an unscheduled install grows
``board_events`` forever.

Usage::

    python manage.py prune_board_events
    python manage.py prune_board_events --days 7 --dry-run
    # Add to cron: 0 3 * * * docker compose run --rm backend python manage.py prune_board_events

Consumers are not silently corrupted by a prune. Each batch records, per board,
the highest event id it deleted (``BoardEventPruneMark``, #2058), and a cursor
with a pruned event after it comes back as ``410 Gone`` from
``GET /boards/<id>/events/`` — with a pointer to re-sync via ``/full/`` — rather
than as a page that quietly skips the events in between. A cursor whose own row
was pruned, with nothing after it pruned, keeps reading.
"""

import datetime

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import models, transaction
from django.db.models.functions import Greatest
from django.utils import timezone

from boards.models import BoardEvent, BoardEventPruneMark

# Boards per mark-write statement. A first run on a large install can touch
# thousands of boards in one batch; chunking keeps each statement's CASE and
# parameter list well inside every backend's limits.
_MARK_CHUNK = 500


def record_pruned(maxes):
    """Raise each board's prune mark to at least the given id, never lower it.

    ``maxes`` maps board id to the highest event id just deleted for it. Called
    inside the delete's transaction so the rows and the mark covering them
    change together.

    Insert-then-raise rather than an upsert that overwrites: two prune runs can
    overlap (a cron job and a manual run), and the one that commits second may
    hold a lower id. ``GREATEST`` keeps the mark monotonic whatever the commit
    order, which the feed relies on — a mark that moved backwards would let a
    cursor skip events that are already gone.
    """
    items = sorted(maxes.items())
    for start in range(0, len(items), _MARK_CHUNK):
        chunk = items[start:start + _MARK_CHUNK]
        BoardEventPruneMark.objects.bulk_create(
            [BoardEventPruneMark(board_id=b, max_pruned_id=m) for b, m in chunk],
            ignore_conflicts=True,
        )
        BoardEventPruneMark.objects.filter(board_id__in=[b for b, _ in chunk]).update(
            max_pruned_id=Greatest(
                models.F("max_pruned_id"),
                models.Case(
                    *[models.When(board_id=b, then=models.Value(m)) for b, m in chunk],
                    output_field=models.BigIntegerField(),
                ),
            )
        )


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
            with transaction.atomic():
                batch = list(
                    stale.order_by("id").values_list("pk", "board_id")[:batch_size]
                )
                if not batch:
                    break
                maxes = {}
                for pk, board_id in batch:
                    if pk > maxes.get(board_id, 0):
                        maxes[board_id] = pk
                deleted, _ = BoardEvent.objects.filter(
                    pk__in=[pk for pk, _ in batch]
                ).delete()
                # Same transaction as the delete: a feed reader sees both the
                # rows gone and the mark covering them, or neither (#2058).
                record_pruned(maxes)
            total += deleted
            if len(batch) < batch_size:
                break

        self.stdout.write(
            self.style.SUCCESS(
                f"Deleted {total} board event(s) created before {cutoff.isoformat()}."
            )
        )
