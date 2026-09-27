"""Long-running scheduler for Visiban's daily maintenance commands (#1157).

Visiban has no task queue, and the backend image has no cron daemon, so before
1.2 the scheduled commands (``notify_due_soon``, ``notify_stale_cards``,
``prune_board_events``, ``prune_notifications``) ran only if an operator wrote
host cron lines by hand. This command is the Docker Compose answer: the opt-in
``scheduler`` service in docker-compose.prod.yml runs it as a sidecar. The Helm
chart uses native CronJobs instead (``scheduledJobs`` in values.yaml) and does
not run this command.

Each job runs once a day at a fixed UTC time taken from an env var:

    SCHEDULE_NOTIFY_DUE_SOON       default 07:00
    SCHEDULE_NOTIFY_STALE_CARDS    default 08:00
    SCHEDULE_PRUNE_BOARD_EVENTS    default off
    SCHEDULE_PRUNE_NOTIFICATIONS   default off

A value is ``HH:MM`` (24-hour, UTC) or ``off``/empty. The prune jobs default to
off because turning on scheduled deletion is an operator decision, not
something an upgrade should do on its own.

Semantics, chosen deliberately:

* **No catch-up.** A job whose time already passed today when the process
  starts waits for tomorrow. Both notify commands treat a missed day as a skip
  anyway, and a restart loop must not fire every job on every restart.
* **A failing job does not stop the scheduler.** It is logged with its
  traceback and the loop carries on; the next day's run is unaffected.
* **Bad configuration fails at startup**, loudly, rather than silently
  scheduling nothing.
"""

import dataclasses
import datetime
import logging
import os
import signal
import threading
import traceback

from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError
from django.db import close_old_connections

logger = logging.getLogger(__name__)

OFF_VALUES = {"", "off", "false", "disabled", "none"}


@dataclasses.dataclass(frozen=True)
class JobSpec:
    command: str
    env_var: str
    default: str


# Defaults match helm/visiban/values.yaml `scheduledJobs`, so a Compose install
# and a Kubernetes install run the same jobs at the same times.
JOB_SPECS = (
    JobSpec("prune_board_events", "SCHEDULE_PRUNE_BOARD_EVENTS", "off"),
    JobSpec("prune_notifications", "SCHEDULE_PRUNE_NOTIFICATIONS", "off"),
    JobSpec("notify_due_soon", "SCHEDULE_NOTIFY_DUE_SOON", "07:00"),
    JobSpec("notify_stale_cards", "SCHEDULE_NOTIFY_STALE_CARDS", "08:00"),
)


@dataclasses.dataclass(frozen=True)
class Job:
    command: str
    at: datetime.time


def parse_time(value, env_var):
    """Parse ``HH:MM`` (UTC); return None when the job is switched off."""
    value = (value or "").strip()
    if value.lower() in OFF_VALUES:
        return None
    try:
        hours, minutes = value.split(":")
        return datetime.time(int(hours), int(minutes))
    except ValueError:
        raise CommandError(
            f"{env_var}={value!r} is not a valid time — use HH:MM (24-hour, UTC) or 'off'."
        ) from None


def load_jobs(environ=None):
    environ = os.environ if environ is None else environ
    jobs = []
    for spec in JOB_SPECS:
        at = parse_time(environ.get(spec.env_var, spec.default), spec.env_var)
        if at is not None:
            jobs.append(Job(spec.command, at))
    return jobs


class Scheduler:
    """Decides which jobs are due. Holds no clock of its own, so it is testable."""

    def __init__(self, jobs, now, run_job):
        self.jobs = jobs
        self.run_job = run_job
        # No catch-up: anything whose time has already passed today is marked as
        # done for today, so a process (re)started at 09:00 does not fire the
        # 07:00 and 08:00 jobs immediately.
        self.last_run = {job.command: now.date() for job in jobs if now.time() >= job.at}

    def tick(self, now):
        ran = []
        for job in self.jobs:
            if self.last_run.get(job.command) == now.date() or now.time() < job.at:
                continue
            # Recorded before running, so a job that raises is still considered
            # done for today rather than retried on every tick.
            self.last_run[job.command] = now.date()
            self.run_job(job)
            ran.append(job.command)
        return ran


class Command(BaseCommand):
    help = "Run Visiban's daily maintenance commands on a fixed UTC schedule (Compose sidecar)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--poll-seconds",
            type=int,
            default=30,
            help="How often to check for due jobs. Default 30.",
        )

    def handle(self, *args, **options):
        poll = options["poll_seconds"]
        if poll < 1:
            raise CommandError("--poll-seconds must be at least 1.")
        jobs = load_jobs()
        if not jobs:
            raise CommandError(
                "Every scheduled job is switched off — nothing to run. Set at least one "
                "SCHEDULE_* variable, or stop the scheduler service."
            )

        stop = threading.Event()

        def _stop(signum, frame):  # noqa: ARG001 — signal handler signature
            stop.set()

        # The scheduler runs as PID 1 in its container, and PID 1 ignores
        # SIGTERM unless it installs a handler — without this, `docker compose
        # stop` would wait out its full timeout and then SIGKILL.
        signal.signal(signal.SIGTERM, _stop)
        signal.signal(signal.SIGINT, _stop)

        for job in jobs:
            self._log(f"scheduled {job.command} daily at {job.at:%H:%M} UTC")

        scheduler = Scheduler(jobs, self._now(), self._run_job)
        while True:
            scheduler.tick(self._now())
            if stop.wait(poll):
                break
        self._log("scheduler stopped")

    @staticmethod
    def _now():
        return datetime.datetime.now(datetime.timezone.utc)

    def _run_job(self, job):
        self._log(f"running {job.command}")
        # This process lives for weeks. A database restart between runs leaves
        # the cached connection dead, and without this every later run fails on
        # it; close_old_connections() discards unusable connections either side.
        close_old_connections()
        try:
            call_command(job.command, stdout=self.stdout, stderr=self.stderr)
        except Exception:  # noqa: BLE001 — one failed job must not stop the others
            logger.exception("scheduled job %s failed", job.command)
            self.stderr.write(f"scheduled job {job.command} FAILED:\n{traceback.format_exc()}")
            self.stderr.flush()
        else:
            self._log(f"finished {job.command}")
        finally:
            close_old_connections()

    def _log(self, message):
        # Wall clock directly, not self._now(): the scheduling clock is the one
        # tests substitute, and a log line must not consume one of its readings.
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        self.stdout.write(f"[{stamp}] run_scheduler: {message}")
        # Container logs are the only place this output goes; do not leave it
        # sitting in a buffer when the job it describes has already finished.
        self.stdout.flush()
