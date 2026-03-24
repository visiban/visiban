import logging
import os
import secrets
from django.core.management.base import BaseCommand
from django.contrib.sites.models import Site
from accounts.models import User

logger = logging.getLogger(__name__)

# The password file path can be overridden via env var for environments where
# /tmp is not appropriate (e.g. read-only container filesystems).
_PASSWORD_FILE = os.environ.get("VISIBAN_ADMIN_PASSWORD_FILE", "/tmp/visiban_admin_password")  # nosec B108 — /tmp default is intentional for dev; production must set VISIBAN_ADMIN_PASSWORD_FILE


class Command(BaseCommand):
    help = (
        "Bootstrap a site admin on first run if none exists. "
        "Writes the one-time password to a file rather than stdout "
        "so it is not visible in container log aggregators."
    )

    def handle(self, *args, **options):
        # Keep Sites framework domain in sync so allauth OAuth callbacks work
        site_domain = os.environ.get("SITE_DOMAIN", "localhost:8000")
        Site.objects.update_or_create(id=1, defaults={"domain": site_domain, "name": "Visiban"})

        if User.objects.filter(is_site_admin=True).exists():
            return  # Already bootstrapped — nothing to do

        username = os.environ.get("DJANGO_SUPERUSER_USERNAME", "admin")
        email = os.environ.get("DJANGO_SUPERUSER_EMAIL", "admin@localhost")
        password = secrets.token_urlsafe(16)

        user, created = User.objects.get_or_create(
            username=username,
            defaults={"email": email},
        )
        user.set_password(password)
        user.is_site_admin = True
        user.can_access_all_content = True
        user.is_staff = True
        user.is_superuser = True
        user.must_change_password = True
        user.save()

        action = "Created" if created else "Promoted existing"

        # Write the password to a file rather than stdout. Printing credentials
        # to stdout means they appear in container log aggregators (CloudWatch,
        # Datadog, etc.) and any log retention system — a significant exposure
        # risk. The file is only readable by the process owner and should be
        # retrieved immediately then deleted.
        try:
            with open(_PASSWORD_FILE, "w") as fh:
                fh.write(password + "\n")
            os.chmod(_PASSWORD_FILE, 0o600)
            password_location = f"written to {_PASSWORD_FILE}"
        except OSError as exc:
            # Fall back to WARNING-level log if the file cannot be written.
            # Logging at WARNING keeps it out of standard INFO streams while
            # still surfacing it in environments that capture WARNING+.
            logger.warning(
                "VISIBAN INITIAL ADMIN PASSWORD (could not write to file: %s): %s",
                exc,
                password,
            )
            password_location = "logged at WARNING level (file write failed)"

        self.stdout.write("")
        self.stdout.write(self.style.WARNING("=" * 60))
        self.stdout.write(self.style.WARNING("  VISIBAN INITIAL ADMIN CREDENTIALS"))
        self.stdout.write(self.style.WARNING("=" * 60))
        self.stdout.write(f"  {action} site admin: {username}")
        self.stdout.write(f"  Password:            [REDACTED — {password_location}]")
        self.stdout.write(self.style.WARNING("=" * 60))
        self.stdout.write(self.style.WARNING("  Retrieve the password, then delete the file."))
        self.stdout.write(self.style.WARNING("  You will be required to change it on first login."))
        self.stdout.write(self.style.WARNING("=" * 60))
        self.stdout.write("")
