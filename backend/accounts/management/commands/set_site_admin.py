from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from accounts.admin_views import access_state, lock_user_row
from accounts.invite_utils import revoke_site_invite_links
from accounts.models import AdminActionLog, User, record_access_flag_changes


class Command(BaseCommand):
    help = "Grant or revoke site admin status for a user"

    def add_arguments(self, parser):
        parser.add_argument("username", help="Username to update")
        parser.add_argument(
            "--revoke",
            action="store_true",
            help="Revoke site admin status instead of granting it",
        )

    def handle(self, *args, **options):
        username = options["username"]
        revoke = options["revoke"]

        try:
            user = User.objects.get(username__iexact=username)
        except User.DoesNotExist:
            raise CommandError(f'User "{username}" does not exist')

        if revoke:
            # The locked read keeps the prior flag value consistent with the
            # save. Revocation here is unconditional, as before: the command
            # is the break-glass route, so site links are revoked even for an
            # already-demoted user and group links lapse for an inactive one.
            with transaction.atomic():
                locked = lock_user_row(user.pk)
                # Superuser status implies site admin, so the flag cannot be
                # cleared while it is set (#1597). Checked under the row lock,
                # before any change or invite-link revocation.
                if locked.is_superuser:
                    raise CommandError(
                        f'User "{username}" is a superuser; remove superuser '
                        "status before revoking site admin"
                    )
                prior = access_state(locked)
                user.is_site_admin = False
                user.can_access_all_content = False
                user.save(update_fields=["is_site_admin", "can_access_all_content"])
                revoke_site_invite_links(user)
                if prior["can_access_all_content"]:
                    from groups.views import _revoke_lapsed_admin_invite_links

                    _revoke_lapsed_admin_invite_links(user)
                # Share links the account enabled through its site-admin
                # role end with it; boards it still administers keep theirs
                # (#1865).
                from boards.services.share_links import revoke_lapsed_share_links

                revoke_lapsed_share_links(enabler=user)
                # Same transaction as the change; no actor, like the other
                # operator commands that write this log.
                record_access_flag_changes(
                    prior=prior, target=user, source=AdminActionLog.Source.CLI
                )
            self.stdout.write(self.style.WARNING(f'Revoked site admin from "{username}"'))
        else:
            with transaction.atomic():
                # Locked so the log records what actually changed; granting a
                # flag the account already holds writes no entry.
                prior = access_state(lock_user_row(user.pk))
                user.is_site_admin = True
                user.can_access_all_content = True
                user.save(update_fields=["is_site_admin", "can_access_all_content"])
                record_access_flag_changes(
                    prior=prior, target=user, source=AdminActionLog.Source.CLI
                )
            self.stdout.write(self.style.SUCCESS(f'Granted site admin to "{username}"'))
