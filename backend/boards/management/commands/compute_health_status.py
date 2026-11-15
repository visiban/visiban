"""Nightly auto health status computation (#2245).

For every board with ``health_auto_enabled``, computes each lane's status from
its own open cards and the board's roll-up, through
``boards.services.health_compute.compute_board_health``: the same code path
as the board admin's "Recompute now". Run once a day (``run_scheduler`` job
``SCHEDULE_COMPUTE_HEALTH``, default 02:00 UTC; Helm
``scheduledJobs.computeHealthStatus``).

Boards are read in pk-ordered keyset chunks (as ``notify_stale_cards`` does,
#1960), each computed in its own transaction under its own row lock, so one
failing board is logged and skipped rather than aborting the rest; the
command then exits non-zero so the scheduler and the CronJob report it.
Idempotent: a re-run, or a run overlapping "Recompute now", finds nothing
changed and records no second history row.
"""

import logging

from django.core.management.base import BaseCommand, CommandError

from boards.models import Board
from boards.services.health_compute import compute_board_health

logger = logging.getLogger(__name__)

BOARD_CHUNK_SIZE = 200


class Command(BaseCommand):
    help = "Compute the auto health status of every board that has it turned on (#2245)."

    def handle(self, *args, **options):
        computed = changed = 0
        failed = []
        last_pk = 0
        while True:
            ids = list(
                Board.objects.filter(pk__gt=last_pk, health_auto_enabled=True)
                .order_by("pk").values_list("pk", flat=True)[:BOARD_CHUNK_SIZE]
            )
            for board_id in ids:
                try:
                    result = compute_board_health(board_id)
                except Exception:  # noqa: BLE001 - one board must not stop the run
                    logger.exception("compute_health_status: board %s failed", board_id)
                    failed.append(board_id)
                    continue
                if result is not None:
                    computed += 1
                    changed += bool(result.board_changed or result.changed_lane_ids)
            if len(ids) < BOARD_CHUNK_SIZE:
                break
            last_pk = ids[-1]
        self.stdout.write(f"Computed health for {computed} board(s); {changed} changed.")
        if failed:
            raise CommandError(f"Health computation failed for {len(failed)} board(s): {failed}")
