from django.core.management.base import BaseCommand
from django.db import transaction

from accounts.models import (
    AdminActionLog,
    MAINTENANCE_MESSAGE_MAX_LENGTH,
    SiteSetting,
    get_maintenance_message,
    record_site_setting_changes,
    snapshot_site_setting,
)


class Command(BaseCommand):
    """Turn instance-wide maintenance mode on or off from the shell (#783).

    This is the break-glass path. Every other way to clear the flag is an HTTP
    request — the admin API, or Django admin, which is itself restricted to
    loopback — so an operator with pod or shell access but a broken ingress
    would otherwise have no way to bring the instance back out of read-only
    mode. Saving through ``SiteSetting.save()`` invalidates the cache, so the
    change takes effect immediately for every worker, exactly as the admin API
    does.
    """

    help = "Show, enable, or disable instance-wide maintenance (read-only) mode"

    def add_arguments(self, parser):
        group = parser.add_mutually_exclusive_group()
        group.add_argument(
            "--on",
            action="store_true",
            help="Enable maintenance mode: block all non-admin writes",
        )
        group.add_argument(
            "--off",
            action="store_true",
            help="Disable maintenance mode and restore normal service",
        )
        parser.add_argument(
            "--message",
            help=(
                "Notice shown to users while maintenance mode is on "
                f"(max {MAINTENANCE_MESSAGE_MAX_LENGTH} characters). "
                "Pass an empty string to fall back to the built-in default."
            ),
        )

    def handle(self, *args, **options):
        # Materialize the singleton before locking it — select_for_update has
        # nothing to lock on a first-boot instance where the row is absent.
        SiteSetting.get()

        # Read, mutate and audit under one locked transaction, matching
        # AdminSettingsView.patch. An operator running this while another admin
        # uses the panel is not hypothetical — it is the normal shape of an
        # incident — and an unlocked read would produce an audit row describing
        # a transition that never happened.
        with transaction.atomic():
            setting = SiteSetting.objects.select_for_update().get(pk=1)
            before = snapshot_site_setting(setting)
            update_fields = []

            if options["message"] is not None:
                message = options["message"].strip()[:MAINTENANCE_MESSAGE_MAX_LENGTH]
                setting.maintenance_message = message
                update_fields.append("maintenance_message")

            if options["on"] or options["off"]:
                setting.maintenance_mode = bool(options["on"])
                update_fields.append("maintenance_mode")

            if update_fields:
                # Goes through save() rather than .update() so the cache
                # invalidation in SiteSetting.save() fires — without it the
                # change would not reach running workers until the 60s TTL
                # expired.
                #
                # actor is None: there is no authenticated user on a shell path,
                # and the audit row says so explicitly via source="cli".
                # Resolving an OS username here would be worse than nothing — in
                # a container it reports the image's user, which reads as an
                # identity while carrying none.
                setting.save(update_fields=update_fields)
                record_site_setting_changes(
                    before=before,
                    after=setting,
                    actor=None,
                    source=AdminActionLog.Source.CLI,
                )

        if setting.maintenance_mode:
            self.stdout.write(
                self.style.WARNING("Maintenance mode is ON — non-admin writes are blocked.")
            )
            self.stdout.write(f"  Notice: {get_maintenance_message(setting.maintenance_message)}")
            self.stdout.write("  Run with --off to restore normal service.")
        else:
            self.stdout.write(self.style.SUCCESS("Maintenance mode is OFF — writes are allowed."))
