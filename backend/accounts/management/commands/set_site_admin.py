from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from accounts.admin_views import access_state, apply_access_loss_revocations, lock_user_row
from accounts.models import User


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
            # One implementation of the revocation housekeeping, shared with the
            # admin API and the Django admin user form (#1563).
            with transaction.atomic():
                prior = access_state(lock_user_row(user.pk))
                user.is_site_admin = False
                user.can_access_all_content = False
                user.save(update_fields=["is_site_admin", "can_access_all_content"])
                apply_access_loss_revocations(user, None, prior)
            self.stdout.write(self.style.WARNING(f'Revoked site admin from "{username}"'))
        else:
            user.is_site_admin = True
            user.can_access_all_content = True
            user.save(update_fields=["is_site_admin", "can_access_all_content"])
            self.stdout.write(self.style.SUCCESS(f'Granted site admin to "{username}"'))
