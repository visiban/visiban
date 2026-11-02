"""Deliver due outbound webhooks (#863).

    python manage.py dispatch_webhooks                    # one run, then exit
    python manage.py dispatch_webhooks --loop --interval 15

One-shot mode is for host cron (every minute is plenty). ``--loop`` is what the
Compose ``webhook-dispatcher`` service and the Helm ``webhooks.dispatcher``
Deployment run. Overlapping runs are safe: each subscription is leased, so two
dispatchers never deliver the same event (webhooks.dispatch). Before exiting,
either mode waits briefly for a disable notice's email, which is sent on a
daemon thread and would otherwise die with the process.

Exits at once, writing nothing, while ``WEBHOOKS_ENABLED`` is off or
``DEMO_MODE`` is on. In ``--loop`` mode it keeps sleeping in that state, so
turning the setting on needs only a restart of the backend, not a new service.
"""

import signal
import threading

from django.core.management.base import BaseCommand
from django.db import close_old_connections

from boards.notifications_email import EMAIL_DRAIN_SECONDS, wait_for_pending_email  # noqa: F401 — EMAIL_DRAIN_SECONDS stays importable from here
from webhooks import dispatch


class Command(BaseCommand):
    help = "Deliver due outbound webhooks from the board change feed."

    def add_arguments(self, parser):
        parser.add_argument("--loop", action="store_true", help="Run until stopped.")
        parser.add_argument(
            "--interval",
            type=float,
            default=15.0,
            help="Seconds to sleep between runs with --loop (default 15).",
        )

    def handle(self, *args, **options):
        self.verbosity = int(options.get("verbosity", 1))
        if not options["loop"]:
            self._report(dispatch.run_once())
            self._drain_email()
            return
        interval = max(float(options["interval"]), 1.0)
        stop = threading.Event()

        def _stop(signum, frame):
            stop.set()

        signal.signal(signal.SIGTERM, _stop)
        signal.signal(signal.SIGINT, _stop)
        while not stop.is_set():
            close_old_connections()
            try:
                self._report(dispatch.run_once())
            except Exception as exc:  # noqa: BLE001 — keep the loop alive; logged by class only
                self.stderr.write(f"dispatch run failed: {type(exc).__name__}")
            stop.wait(interval)
        self._drain_email()

    def _drain_email(self):
        if not wait_for_pending_email(EMAIL_DRAIN_SECONDS):
            self.stderr.write("A webhook notice email was still sending at exit and may be lost.")

    def _report(self, result):
        if result.skipped:
            if self.verbosity >= 2:
                self.stdout.write("Webhooks are disabled (WEBHOOKS_ENABLED off or DEMO_MODE on); nothing to do.")
            return
        if self.verbosity >= 1 and (result.delivered or result.failed or result.disabled or result.errored):
            self.stdout.write(
                f"webhooks: {result.subscriptions} subscription(s), {result.delivered} delivered, "
                f"{result.failed} failed, {result.disabled} disabled, {result.errored} errored"
            )
