import logging
import os
import secrets
import stat
from django.core.management.base import BaseCommand
from django.contrib.sites.models import Site
from accounts.models import User

logger = logging.getLogger(__name__)

# The password file path can be overridden via env var for environments where
# /tmp is not appropriate (e.g. read-only container filesystems).
_PASSWORD_FILE = os.environ.get("VISIBAN_ADMIN_PASSWORD_FILE", "/tmp/visiban_admin_password")  # nosec B108 — /tmp default kept for compatibility (docs/compose `exec cat /tmp/...`); the write is O_EXCL|O_NOFOLLOW 0600 (see _write_password_file), and Helm sets a private path


def _write_password_file(path, password):
    """Create ``path`` exclusively with mode 0600 and write the password to it.

    Why O_EXCL: the default path lives in the sticky, world-writable /tmp
    (Sonar python:S5443). Without O_EXCL, O_CREAT on a path an attacker
    pre-created would reuse *their* file (and its permissive mode / ownership),
    leaking the password to them. O_EXCL guarantees we only ever write to a
    file we just created, with our 0600 mode; O_NOFOLLOW additionally refuses a
    planted symlink at the final component.

    A stale file left by a previous bootstrap run is removed first, but only if
    it is a regular file owned by this process's user -- anything else (symlink,
    another user's file, directory) is left alone and raises OSError so the
    caller falls back to stdout instead of writing into an untrusted location.
    """
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(path, flags, 0o600)
    except FileExistsError:
        st = os.lstat(path)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid():
            raise
        os.unlink(path)
        fd = os.open(path, flags, 0o600)  # still O_EXCL: loses cleanly to a race
    with os.fdopen(fd, "w") as fh:
        fh.write(password + "\n")


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
        _pw_to_stdout = False
        try:
            _write_password_file(_PASSWORD_FILE, password)
            password_location = f"written to {_PASSWORD_FILE}"
        except OSError as exc:
            # File write failed — fall back to management command stdout only.
            # Do NOT log the credential via logger.*: log aggregators (CloudWatch,
            # Datadog, etc.) capture WARNING+ and would persist the plaintext password.
            # self.stdout goes to the terminal/container STDOUT of the command
            # invocation itself and is not forwarded to log aggregators.
            logger.warning(
                "ensure_site_admin: could not write password file (%s). "
                "Credential printed to command stdout only.",
                exc,
            )
            _pw_to_stdout = True
            password_location = f"stdout (file write failed: {exc})"

        self.stdout.write("")
        self.stdout.write(self.style.WARNING("=" * 60))
        self.stdout.write(self.style.WARNING("  VISIBAN INITIAL ADMIN CREDENTIALS"))
        self.stdout.write(self.style.WARNING("=" * 60))
        self.stdout.write(f"  {action} site admin: {username}")
        if _pw_to_stdout:
            self.stdout.write(f"  Password:            {password}")
        else:
            self.stdout.write(f"  Password:            [REDACTED — {password_location}]")
        self.stdout.write(self.style.WARNING("=" * 60))
        self.stdout.write(self.style.WARNING("  Retrieve the password, then delete the file."))
        self.stdout.write(self.style.WARNING("  You will be required to change it on first login."))
        self.stdout.write(self.style.WARNING("=" * 60))
        self.stdout.write("")
