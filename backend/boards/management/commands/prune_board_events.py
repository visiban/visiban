"""Delete board change-feed events older than the retention window (#1114).

The feed is append-only and nothing expires on its own, so this command is the
only thing that bounds the table. Schedule it; an unscheduled install grows
``board_events`` forever.

Usage::

    python manage.py prune_board_events
    python manage.py prune_board_events --days 7 --dry-run
    # Add to cron: 0 3 * * * docker compose run --rm backend python manage.py prune_board_events

Consumers are not silently corrupted by a prune. Each batch records the highest
event id it deleted per board and event type (``BoardEventPruneTypeMark``,
#2058, #2079), and a cursor with a pruned event after it that the reader could
have seen comes back as ``410 Gone`` from ``GET /boards/<id>/events/`` — with a
pointer to re-sync via ``/full/`` — rather than as a page that quietly skips the
events in between. A cursor whose own row was pruned, with nothing visible to
that reader pruned after it, keeps reading.
"""

import datetime
from functools import reduce
from operator import or_

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import models, transaction
from django.db.models.functions import Greatest
from django.utils import timezone

from boards.models import BoardEvent, BoardEventPruneMark, BoardEventPruneTypeMark
from boards.permissions import PER_USER_EVENTS

# Marks per write statement. A first run on a large install can touch thousands
# of boards in one batch; chunking keeps each statement's CASE, WHERE and
# parameter list (seven parameters a mark) well inside every backend's limits.
_MARK_CHUNK = 200


def record_pruned(rows):
    """Record a deleted batch: ``rows`` is ``(pk, board_id, event, actor_id)`` per row.

    Called inside the delete's transaction so the rows and the marks covering
    them change together. Two writes:

    * **One mark per (board, event type, owner)**, raised to the highest id
      deleted. Only per-user events keep an owner, because only they are visible
      by actor: every other event's actor says nothing about who could read it,
      and keeping it would add a row per actor for nothing. A per-user row with
      no actor stores owner 0, which matches no reader, as the feed's own filter
      does for such a row.
    * **A row for a board this pruner has not seen before**, with its
      ``unrecorded_floor`` just below the lowest id it is deleting. A board with
      no row may have been pruned by an older pruner that recorded nothing, of
      unknown types, and those rows can only sit below this batch: prune deletes
      in id order. The floor keeps those gaps expiring for feed readers. An
      insert only, so a row that already exists (a real mark from before the
      per-type marks) keeps its values.

    Insert-then-raise rather than an upsert that overwrites: two prune runs can
    overlap (a cron job and a manual run), and the one that commits second may
    hold a lower id. ``GREATEST`` keeps a mark monotonic whatever the commit
    order, which the feed relies on — a mark that moved backwards would let a
    cursor skip events that are already gone.
    """
    marks = {}
    lowest = {}
    for pk, board_id, event, actor_id in rows:
        key = (board_id, event, (actor_id or 0) if event in PER_USER_EVENTS else 0)
        if pk > marks.get(key, 0):
            marks[key] = pk
        if board_id not in lowest or pk < lowest[board_id]:
            lowest[board_id] = pk

    floors = sorted(lowest.items())
    for start in range(0, len(floors), _MARK_CHUNK):
        BoardEventPruneMark.objects.bulk_create(
            [
                BoardEventPruneMark(board_id=b, max_pruned_id=0, unrecorded_floor=low - 1)
                for b, low in floors[start:start + _MARK_CHUNK]
            ],
            ignore_conflicts=True,
        )

    items = sorted(marks.items())
    for start in range(0, len(items), _MARK_CHUNK):
        chunk = items[start:start + _MARK_CHUNK]
        BoardEventPruneTypeMark.objects.bulk_create(
            [BoardEventPruneTypeMark(board_id=b, event=e, actor_id=a, max_pruned_id=m) for (b, e, a), m in chunk],
            ignore_conflicts=True,
        )
        BoardEventPruneTypeMark.objects.filter(
            reduce(or_, (models.Q(board_id=b, event=e, actor_id=a) for (b, e, a), _ in chunk))
        ).update(
            max_pruned_id=Greatest(
                models.F("max_pruned_id"),
                models.Case(
                    *[
                        models.When(board_id=b, event=e, actor_id=a, then=models.Value(m))
                        for (b, e, a), m in chunk
                    ],
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
                # Only the columns the marks need: never the JSON payload.
                batch = list(
                    stale.order_by("id").values_list("pk", "board_id", "event", "actor_id")[:batch_size]
                )
                if not batch:
                    break
                deleted, _ = BoardEvent.objects.filter(
                    pk__in=[row[0] for row in batch]
                ).delete()
                # Same transaction as the delete: a feed reader sees both the
                # rows gone and the marks covering them, or neither (#2058).
                record_pruned(batch)
            total += deleted
            if len(batch) < batch_size:
                break

        self.stdout.write(
            self.style.SUCCESS(
                f"Deleted {total} board event(s) created before {cutoff.isoformat()}."
            )
        )
