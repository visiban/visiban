"""Daily clear of expired previous webhook signing secrets (#2119).

A rotation with an overlap keeps the old secret's ciphertext in
``previous_secret_encrypted`` until ``previous_secret_expires_at``. It stops
signing at that moment, but the stored copy is only deleted by a sweep. The
sweep also runs on every dispatcher run and on a board admin's webhook API
requests; this command is the third path, so an install with no dispatcher
and a board whose admin never opens the webhook API still clears it. Run once
a day by ``run_scheduler`` (``SCHEDULE_SWEEP_WEBHOOK_SECRETS``, default 04:00
UTC) or the Helm ``scheduledJobs.sweepWebhookSecrets`` CronJob. Idempotent, and
it does not need ``WEBHOOKS_ENABLED``: ciphertext should not outlive its window
on an install that turned the feature off either.
"""

from django.core.management.base import BaseCommand

from webhooks.dispatch import sweep_expired_previous_secrets


class Command(BaseCommand):
    help = "Delete expired previous webhook signing secrets on every board (#2119)."

    def handle(self, *args, **options):
        cleared = sweep_expired_previous_secrets()
        self.stdout.write(f"cleared {cleared} expired previous webhook secret(s)")
