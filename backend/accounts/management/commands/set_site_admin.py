from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from accounts.invite_utils import revoke_site_invite_links
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
            had_all_content = user.can_access_all_content
            user.is_site_admin = False
            user.can_access_all_content = False
            with transaction.atomic():
                user.save(update_fields=["is_site_admin", "can_access_all_content"])
                # Only an active site admin may admit accounts through a site
                # invite; take this user's pending ones out of circulation.
                revoke_site_invite_links(user)
                if had_all_content:
                    # can_access_all_content conferred group-admin rights
                    # everywhere; group links held only through it lapse, the
                    # same as clearing the flag through the admin API.
                    from groups.views import _revoke_lapsed_admin_invite_links

                    _revoke_lapsed_admin_invite_links(user)
            self.stdout.write(self.style.WARNING(f'Revoked site admin from "{username}"'))
        else:
            user.is_site_admin = True
            user.can_access_all_content = True
            user.save(update_fields=["is_site_admin", "can_access_all_content"])
            self.stdout.write(self.style.SUCCESS(f'Granted site admin to "{username}"'))
