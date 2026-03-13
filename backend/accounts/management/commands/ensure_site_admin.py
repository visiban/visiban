import os
import secrets
from django.core.management.base import BaseCommand
from django.contrib.sites.models import Site
from accounts.models import User


class Command(BaseCommand):
    help = "Bootstrap a site admin on first run if none exists. Prints a one-time password to stdout."

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
        user.is_staff = True
        user.is_superuser = True
        user.must_change_password = True
        user.save()

        action = "Created" if created else "Promoted existing"
        self.stdout.write("")
        self.stdout.write(self.style.WARNING("=" * 60))
        self.stdout.write(self.style.WARNING("  VISIBAN INITIAL ADMIN CREDENTIALS"))
        self.stdout.write(self.style.WARNING("=" * 60))
        self.stdout.write(f"  {action} site admin: {username}")
        self.stdout.write(f"  Password:            {password}")
        self.stdout.write(self.style.WARNING("=" * 60))
        self.stdout.write(self.style.WARNING("  You will be required to change this password"))
        self.stdout.write(self.style.WARNING("  on first login. Store it somewhere safe now."))
        self.stdout.write(self.style.WARNING("=" * 60))
        self.stdout.write("")
