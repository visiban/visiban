"""Provision a Personal Access Token for the backend-schema-fuzz CI job.

Mints a scoped (read+write, non-admin) PAT for an existing, non-superuser
board member so schemathesis (#1080) exercises the permission-shaped
responses a normal member actually gets, rather than a superuser's
unrestricted view of every endpoint. The issue is explicit that the fuzzer
must authenticate as "a normal board member — not a superuser".

Requires the target user to already exist — run `seed_demo_data` first. The
demo board's non-owner members (`demo2`..`demo5`) are plain `MEMBER`s with no
`is_superuser`/`is_site_admin`/`can_access_all_content` flag, which is why the
CI job defaults to `demo2`.

The raw token is written to a file (mode 0600), never to stdout or a log
statement, matching the pattern `ensure_site_admin` uses for the initial
admin password — CI reads the file into a job variable rather than the
command's output ever appearing in a pipeline log.
"""

import os

from django.core.management.base import BaseCommand, CommandError

from accounts.models import PAT_DEFAULT_SCOPES, User

_DEFAULT_TOKEN_FILE = os.environ.get(
    "VISIBAN_FUZZ_TOKEN_FILE", "/tmp/visiban_fuzz_token"  # nosec B108 — CI-only, overridable
)


class Command(BaseCommand):
    help = "Mint a scoped, non-admin Personal Access Token for the schema-fuzz CI job."

    def add_arguments(self, parser):
        parser.add_argument(
            "--username",
            default="demo2",
            help="Existing, non-superuser board member to mint the token for (default: demo2).",
        )
        parser.add_argument(
            "--token-file",
            default=_DEFAULT_TOKEN_FILE,
            help="Path to write the raw token to (default: %(default)s or VISIBAN_FUZZ_TOKEN_FILE).",
        )

    def handle(self, *args, **options):
        username = options["username"]
        try:
            user = User.objects.get(username=username)
        except User.DoesNotExist:
            raise CommandError(
                f"User '{username}' does not exist. Run `manage.py seed_demo_data` first."
            )

        # Fail loudly rather than silently minting a token with more authority
        # than the fuzz job is supposed to exercise (#1080 requires a normal
        # member, not an admin).
        if user.is_superuser or user.is_site_admin or user.can_access_all_content:
            raise CommandError(
                f"User '{username}' has elevated privileges "
                "(is_superuser/is_site_admin/can_access_all_content) — "
                "the schema-fuzz job must authenticate as a normal board member."
            )

        _, raw_token = user.personal_access_tokens.model.generate(
            user=user,
            name="backend-schema-fuzz (CI)",
            scopes=list(PAT_DEFAULT_SCOPES),
        )

        token_file = options["token_file"]
        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd = os.open(token_file, flags, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(raw_token + "\n")

        self.stdout.write(
            self.style.SUCCESS(
                f"Minted a scoped PAT for '{username}' (scopes={PAT_DEFAULT_SCOPES}) -> {token_file}"
            )
        )
