"""Tests for ensure_site_admin and set_site_admin management commands (#407)."""
import os
import tempfile
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
        pw_fd, pw_file = tempfile.mkstemp(prefix="visiban_test_admin_pw_")
        os.close(pw_fd)
        os.unlink(pw_file)  # remove so the command creates it fresh
        try:
            with patch("accounts.management.commands.ensure_site_admin._PASSWORD_FILE", pw_file):
                out = StringIO()
                call_command("ensure_site_admin", stdout=out)
            self.assertTrue(os.path.exists(pw_file))
            with open(pw_file) as f:
                password = f.read().strip()
            self.assertGreater(len(password), 10)
            # File must be created with 0o600 permissions atomically (TOCTOU fix)
            self.assertEqual(oct(os.stat(pw_file).st_mode & 0o777), oct(0o600))
            # Password should not appear in stdout
            self.assertNotIn(password, out.getvalue())
        finally:
            if os.path.exists(pw_file):
                os.remove(pw_file)

    def _run_with_pw_path(self, path):
        out = StringIO()
        with patch("accounts.management.commands.ensure_site_admin._PASSWORD_FILE", path):
            call_command("ensure_site_admin", stdout=out)
        return out.getvalue()

    def test_password_file_replaces_stale_own_file_with_0600(self):
        """A stale own file (even world-readable) is replaced by a fresh 0600 file (S5443, #1379)."""
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "pw")
            with open(path, "w") as f:
                f.write("old\n")
            os.chmod(path, 0o666)
            output = self._run_with_pw_path(path)
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            with open(path) as f:
                self.assertNotEqual(f.read().strip(), "old")
            self.assertIn("REDACTED", output)

    def test_password_file_refuses_planted_symlink(self):
        """A symlink planted at the path is never followed or removed; password goes to stdout."""
        with tempfile.TemporaryDirectory() as d:
            target = os.path.join(d, "victim")
            path = os.path.join(d, "pw")
            os.symlink(target, path)
            output = self._run_with_pw_path(path)
            self.assertFalse(os.path.exists(target))
            self.assertTrue(os.path.islink(path))
            self.assertNotIn("REDACTED", output)

    def test_password_file_refuses_file_owned_by_another_user(self):
        """A pre-existing file not owned by us is not reused or unlinked (fail closed to stdout)."""
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "pw")
            with open(path, "w") as f:
                f.write("attacker\n")
            with patch("accounts.management._secure_file.os.geteuid", return_value=os.geteuid() + 1):
                output = self._run_with_pw_path(path)
            with open(path) as f:
                self.assertEqual(f.read(), "attacker\n")
            self.assertNotIn("REDACTED", output)

    def test_password_file_refuses_directory(self):
        """A directory at the path is never unlinked; password goes to stdout."""
        with tempfile.TemporaryDirectory() as d:
            output = self._run_with_pw_path(d)
            self.assertTrue(os.path.isdir(d))
            self.assertNotIn("REDACTED", output)

    def test_password_printed_to_stdout_when_file_write_fails(self):
        """When the password file cannot be written, the password is printed directly to stdout.

        This covers the OSError fallback path: the banner must contain the actual
        credential (so the operator can retrieve it) and must NOT contain "REDACTED"
        (which would be useless if the file write is the only delivery mechanism).
        """
        # Patch _PASSWORD_FILE to a directory path so open(..., "w") raises OSError.
        with patch(
            "accounts.management.commands.ensure_site_admin._PASSWORD_FILE",
            "/",  # opening a directory for writing always raises OSError
        ):
            out = StringIO()
            call_command("ensure_site_admin", stdout=out)

        output = out.getvalue()
        # The generated password must appear somewhere in the banner.
        # We cannot know the exact value, but we can confirm the banner does NOT
        # fall back to the REDACTED placeholder — that only appears on the success path.
        self.assertNotIn("REDACTED", output)
        # The banner heading must still be present so the operator notices the output.
        self.assertIn("VISIBAN INITIAL ADMIN CREDENTIALS", output)
        # The admin user must have been created despite the file write failure.
        self.assertTrue(User.objects.filter(username="admin", is_site_admin=True).exists())


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


class ProvisionFuzzTokenFileTests(TestCase):
    """provision_fuzz_token writes the PAT exclusively with mode 0600 (#1379)."""

    def setUp(self):
        User.objects.create_user(username="fuzzer", password="x", email="f@example.com")
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = os.path.join(self.dir.name, "tok")

    def _run(self):
        call_command("provision_fuzz_token", username="fuzzer", token_file=self.path, stdout=StringIO())

    def test_writes_token_0600(self):
        self._run()
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o600)

    def test_replaces_stale_own_file(self):
        with open(self.path, "w") as f:
            f.write("old\n")
        os.chmod(self.path, 0o666)
        self._run()
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o600)
        with open(self.path) as f:
            self.assertNotEqual(f.read().strip(), "old")

    def test_refuses_foreign_owned_file(self):
        with open(self.path, "w") as f:
            f.write("attacker\n")
        with patch("accounts.management._secure_file.os.geteuid", return_value=os.geteuid() + 1):
            with self.assertRaises(OSError):
                self._run()
        with open(self.path) as f:
            self.assertEqual(f.read(), "attacker\n")

    def test_refuses_symlink(self):
        os.symlink(os.path.join(self.dir.name, "victim"), self.path)
        with self.assertRaises(OSError):
            self._run()
        self.assertFalse(os.path.exists(os.path.join(self.dir.name, "victim")))
