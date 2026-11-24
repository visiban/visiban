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

For throwaway CI databases only. ``--set-random-password`` (off by default)
gives a password-less target a random password that is never recorded (#1607).
The seeded members are social-only, and both password-change routes
(``/auth/password/change/``, ``/auth/change-password/``) skip the
current-password check for such an account so it can set its first password,
but only from an interactive session: a request authenticated with the fuzz
token is refused with 403 and nothing changes (#1609). This flag is therefore
defense in depth rather than what keeps the fuzzer working: with a password
nobody holds, those routes also require a current password the fuzzer cannot
supply, so the token stays valid even if the session requirement changes. The
flag is opt-in because on a real social-only or
SSO-only account a usable password also lifts the verified-email gate on
password reset (``accounts/forms.py``), so whoever controls the stored mailbox
could set a password and sign in.

The flag uses a bare ``set_password`` rather than
``credentials.finalize_password_change`` on purpose. The CI database is fresh,
and the token is minted after the password change under the same user-row
lock, so there is nothing to revoke and the new token is not revoked either.
That exemption holds only for a throwaway database. Any other password change
must go through ``finalize_password_change``.
"""

import os
import secrets

from django.db import transaction
from django.core.management.base import BaseCommand, CommandError

from accounts import credentials
from accounts.management._secure_file import write_secret_file
from accounts.models import PAT_DEFAULT_SCOPES, AdminActionLog, User

_DEFAULT_TOKEN_FILE = os.environ.get(
    "VISIBAN_FUZZ_TOKEN_FILE", "/tmp/visiban_fuzz_token"  # nosec B108 — CI-only, overridable
)


class Command(BaseCommand):
    help = (
        "Mint a scoped, non-admin Personal Access Token for the schema-fuzz and "
        "nightly-load-test CI jobs. For throwaway CI databases only."
    )

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
        parser.add_argument(
            "--set-random-password",
            action="store_true",
            help=(
                "If the user has no usable password, set a random one that is not kept so a "
                "fuzzed password change cannot revoke the token (#1607). Throwaway CI "
                "databases only: on a real social-only account it lifts the "
                "verified-email gate on password reset."
            ),
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

        # Token creation is serialized with credential changes on the user row.
        with transaction.atomic():
            locked = credentials.lock_user_row(user)
            # --set-random-password (#1607): see the module docstring for why
            # the token needs it, why it is opt-in, and why a bare
            # set_password (not finalize_password_change) is correct here.
            # Set before the token is minted, under the same row lock.
            password_locked = (
                options["set_random_password"] and not locked.has_usable_password()
            )
            if password_locked:
                locked.set_password(secrets.token_urlsafe(32))
                locked.save(update_fields=["password"])
                # Same transaction as the password write: a failed log write
                # rolls the password back. Only id and username are stored.
                AdminActionLog.record(
                    action=AdminActionLog.Action.USER_PASSWORD_SET,
                    source=AdminActionLog.Source.CLI,
                    metadata={"target_id": locked.pk, "target_username": locked.username},
                )
            # Not subject to the site token-lifetime policy (#1572): that
            # governs tokens people create through the API and the token form.
            # This is an operator-shell command that mints the CI fuzz token.
            _, raw_token = locked.personal_access_tokens.model.generate(
                user=locked,
                name="backend-schema-fuzz (CI)",
                scopes=list(PAT_DEFAULT_SCOPES),
            )

        token_file = options["token_file"]
        # O_EXCL|O_NOFOLLOW 0600 -- the default path is in shared /tmp (#1379).
        write_secret_file(token_file, raw_token)

        self.stdout.write(
            self.style.SUCCESS(
                f"Minted a scoped PAT for '{username}' (scopes={PAT_DEFAULT_SCOPES}) -> {token_file}"
            )
        )
        if password_locked:
            self.stdout.write(
                f"Set a random password that is not kept on '{username}' (it had none), so "
                "the password-change routes require a current password the fuzzer cannot supply."
            )
