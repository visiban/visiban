from django.core.management.base import BaseCommand, CommandError
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
            user.is_site_admin = False
            user.can_access_all_content = False
            user.save(update_fields=["is_site_admin", "can_access_all_content"])
            self.stdout.write(self.style.WARNING(f'Revoked site admin from "{username}"'))
        else:
            user.is_site_admin = True
            user.can_access_all_content = True
            user.save(update_fields=["is_site_admin", "can_access_all_content"])
            self.stdout.write(self.style.SUCCESS(f'Granted site admin to "{username}"'))
