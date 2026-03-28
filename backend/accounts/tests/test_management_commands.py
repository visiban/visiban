"""Tests for ensure_site_admin and set_site_admin management commands (#407)."""
import os
from io import StringIO
from unittest.mock import patch

from django.core.management import call_command, CommandError
from django.test import TestCase

from accounts.models import User


class EnsureSiteAdminTests(TestCase):
    """ensure_site_admin creates a site admin on first run and is idempotent on subsequent runs."""

    def test_creates_admin_when_none_exists(self):
        """Running ensure_site_admin with no site admins creates one."""
        self.assertFalse(User.objects.filter(is_site_admin=True).exists())

        out = StringIO()
        call_command("ensure_site_admin", stdout=out)

        admin = User.objects.get(username="admin")
        self.assertTrue(admin.is_site_admin)
        self.assertTrue(admin.can_access_all_content)
        self.assertTrue(admin.is_staff)
        self.assertTrue(admin.is_superuser)
        self.assertTrue(admin.must_change_password)

    def test_noop_when_admin_already_exists(self):
        """Running ensure_site_admin when a site admin exists does nothing."""
        User.objects.create_user(username="existing", password="pass", is_site_admin=True)

        out = StringIO()
        call_command("ensure_site_admin", stdout=out)

        # No new admin was created
        self.assertFalse(User.objects.filter(username="admin").exists())

    @patch.dict(os.environ, {"DJANGO_SUPERUSER_USERNAME": "boss", "DJANGO_SUPERUSER_EMAIL": "boss@example.com"})
    def test_respects_env_vars_for_username_and_email(self):
        out = StringIO()
        call_command("ensure_site_admin", stdout=out)

        admin = User.objects.get(username="boss")
        self.assertEqual(admin.email, "boss@example.com")
        self.assertTrue(admin.is_site_admin)

    def test_promotes_existing_user_if_username_matches(self):
        """If a non-admin user with the target username exists, promote rather than duplicate."""
        existing = User.objects.create_user(username="admin", password="oldpass")
        self.assertFalse(existing.is_site_admin)

        out = StringIO()
        call_command("ensure_site_admin", stdout=out)

        existing.refresh_from_db()
        self.assertTrue(existing.is_site_admin)
        self.assertTrue(existing.must_change_password)
        # Exactly one user with this username
        self.assertEqual(User.objects.filter(username="admin").count(), 1)

    def test_writes_password_to_file(self):
        """The generated password is written to a file, not printed to stdout."""
        pw_file = "/tmp/visiban_test_admin_pw"
        try:
            with patch("accounts.management.commands.ensure_site_admin._PASSWORD_FILE", pw_file):
                out = StringIO()
                call_command("ensure_site_admin", stdout=out)
            self.assertTrue(os.path.exists(pw_file))
            with open(pw_file) as f:
                password = f.read().strip()
            self.assertGreater(len(password), 10)
            # Password should not appear in stdout
            self.assertNotIn(password, out.getvalue())
        finally:
            if os.path.exists(pw_file):
                os.remove(pw_file)


class SetSiteAdminTests(TestCase):
    """set_site_admin grants or revokes site admin status for an existing user."""

    def setUp(self):
        self.user = User.objects.create_user(username="testuser", password="pass")

    def test_grant_site_admin(self):
        out = StringIO()
        call_command("set_site_admin", "testuser", stdout=out)

        self.user.refresh_from_db()
        self.assertTrue(self.user.is_site_admin)
        self.assertTrue(self.user.can_access_all_content)
        self.assertIn("Granted", out.getvalue())

    def test_revoke_site_admin(self):
        self.user.is_site_admin = True
        self.user.can_access_all_content = True
        self.user.save()

        out = StringIO()
        call_command("set_site_admin", "testuser", "--revoke", stdout=out)

        self.user.refresh_from_db()
        self.assertFalse(self.user.is_site_admin)
        self.assertFalse(self.user.can_access_all_content)
        self.assertIn("Revoked", out.getvalue())

    def test_nonexistent_user_raises_error(self):
        with self.assertRaises(CommandError) as ctx:
            call_command("set_site_admin", "nobody")
        self.assertIn("does not exist", str(ctx.exception))

    def test_grant_is_idempotent(self):
        """Granting site admin to an already-admin user does not error."""
        self.user.is_site_admin = True
        self.user.can_access_all_content = True
        self.user.save()

        out = StringIO()
        call_command("set_site_admin", "testuser", stdout=out)

        self.user.refresh_from_db()
        self.assertTrue(self.user.is_site_admin)
