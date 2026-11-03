"""Management-command password sets are recorded in the admin action log (#1699).

``ensure_site_admin`` and ``provision_fuzz_token --set-random-password`` each
write a ``user.password_set`` entry with source ``cli`` in the same
transaction as the password write. ``seed_demo_data --demo-site`` is a
documented exception (docs/development/security-invariants.md, Rule 3).
"""

import os
import tempfile
from io import StringIO
from unittest.mock import patch

from django.core.management import call_command
from django.test import TestCase

from accounts.models import AdminActionLog, User

SET = AdminActionLog.Action.USER_PASSWORD_SET


def _assert_entry_is_secret_free(test, entry, user):
    test.assertEqual(entry.source, AdminActionLog.Source.CLI)
    test.assertIsNone(entry.actor_id)
    test.assertEqual(entry.actor_username, "")
    test.assertEqual(entry.metadata, {"target_id": user.pk, "target_username": user.username})
    blob = repr(
        (entry.action, entry.actor_username, entry.source, entry.metadata)
    )
    test.assertNotIn(user.password, blob)
    test.assertNotIn("pbkdf2", blob)


class EnsureSiteAdminLogTests(TestCase):
    def setUp(self):
        tmp = tempfile.mkdtemp()
        self.pw_file = os.path.join(tmp, "pw")
        patcher = patch(
            "accounts.management.commands.ensure_site_admin._PASSWORD_FILE", self.pw_file
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_new_account_is_recorded(self):
        call_command("ensure_site_admin", stdout=StringIO())
        user = User.objects.get(username="admin")
        entry = AdminActionLog.objects.get(action=SET)
        _assert_entry_is_secret_free(self, entry, user)
        with open(self.pw_file) as fh:
            generated = fh.read().strip()
        self.assertNotIn(generated, repr(entry.metadata))

    def test_existing_account_is_recorded(self):
        existing = User.objects.create_user(username="admin", password="oldpass-1699")
        call_command("ensure_site_admin", stdout=StringIO())
        entry = AdminActionLog.objects.get(action=SET)
        self.assertEqual(entry.metadata["target_id"], existing.pk)

    def test_log_failure_leaves_no_new_account(self):
        with patch.object(AdminActionLog, "record", side_effect=RuntimeError("log down")):
            with self.assertRaises(RuntimeError):
                call_command("ensure_site_admin", stdout=StringIO())
        self.assertFalse(User.objects.filter(username="admin").exists())

    def test_noop_run_records_nothing(self):
        User.objects.create_user(username="existing", password="x", is_site_admin=True)
        call_command("ensure_site_admin", stdout=StringIO())
        self.assertFalse(AdminActionLog.objects.exists())

    def test_log_failure_rolls_back_the_password(self):
        existing = User.objects.create_user(username="admin", password="oldpass-1699")
        before = User.objects.get(pk=existing.pk).password
        with patch.object(AdminActionLog, "record", side_effect=RuntimeError("log down")):
            with self.assertRaises(RuntimeError):
                call_command("ensure_site_admin", stdout=StringIO())
        existing.refresh_from_db()
        self.assertEqual(existing.password, before)
        self.assertFalse(existing.is_site_admin)
        self.assertFalse(os.path.exists(self.pw_file))


class ProvisionFuzzTokenLogTests(TestCase):
    def setUp(self):
        self.token_file = os.path.join(tempfile.mkdtemp(), "token")
        self.member = User.objects.create_user(username="fuzz1699")
        self.member.set_unusable_password()
        self.member.save()

    def _run(self, *extra):
        call_command(
            "provision_fuzz_token",
            "--username",
            "fuzz1699",
            "--token-file",
            self.token_file,
            *extra,
            stdout=StringIO(),
        )

    def test_random_password_set_is_recorded(self):
        self._run("--set-random-password")
        self.member.refresh_from_db()
        entry = AdminActionLog.objects.get(action=SET)
        _assert_entry_is_secret_free(self, entry, self.member)

    def test_no_entry_without_the_flag(self):
        self._run()
        self.assertFalse(AdminActionLog.objects.exists())

    def test_no_entry_when_account_already_has_a_password(self):
        usable = User.objects.create_user(username="fuzz1699b", password="pw-1699")
        call_command(
            "provision_fuzz_token",
            "--username",
            usable.username,
            "--token-file",
            self.token_file,
            "--set-random-password",
            stdout=StringIO(),
        )
        self.assertFalse(AdminActionLog.objects.exists())

    def test_log_failure_rolls_back_password_and_token(self):
        with patch.object(AdminActionLog, "record", side_effect=RuntimeError("log down")):
            with self.assertRaises(RuntimeError):
                self._run("--set-random-password")
        self.member.refresh_from_db()
        self.assertFalse(self.member.has_usable_password())
        self.assertFalse(self.member.personal_access_tokens.exists())
        self.assertFalse(os.path.exists(self.token_file))


class ChangePasswordLogTests(TestCase):
    NEW = "a-Strong-new-pass-1699"

    def setUp(self):
        self.user = User.objects.create_user(username="op1699", password="old-pass-1699x")

    def _run(self):
        with patch("getpass.getpass", side_effect=[self.NEW, self.NEW]):
            call_command("changepassword", "op1699", stdout=StringIO())

    def test_password_set_is_recorded_without_secrets(self):
        self._run()
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(self.NEW))
        entry = AdminActionLog.objects.get(action=SET)
        _assert_entry_is_secret_free(self, entry, self.user)
        self.assertNotIn(self.NEW, repr(entry.metadata))

    def test_log_failure_rolls_back_the_password(self):
        before = self.user.password
        with patch.object(AdminActionLog, "record", side_effect=RuntimeError("log down")):
            with self.assertRaises(RuntimeError):
                self._run()
        self.user.refresh_from_db()
        self.assertEqual(self.user.password, before)


class CreateSuperuserLogTests(TestCase):
    """Django's ``createsuperuser`` is overridden by ``operator_commands`` (#1801)."""

    PW = "a-Strong-new-pass-1801"

    def _noinput(self, username="root1801", password=PW):
        env = {"DJANGO_SUPERUSER_PASSWORD": password} if password else {}
        with patch.dict(os.environ, env):
            call_command(
                "createsuperuser",
                interactive=False,
                username=username,
                email="root1801@example.com",
                stdout=StringIO(),
            )

    def test_override_wins(self):
        from django.core.management import get_commands

        self.assertEqual(get_commands()["createsuperuser"], "operator_commands")

    def test_noinput_with_password_is_recorded(self):
        self._noinput()
        user = User.objects.get(username="root1801")
        self.assertTrue(user.is_superuser)
        entry = AdminActionLog.objects.get(action=SET)
        _assert_entry_is_secret_free(self, entry, user)
        self.assertNotIn(self.PW, repr(entry.metadata))

    def test_interactive_is_recorded(self):
        stdin = StringIO()
        stdin.isatty = lambda: True
        with patch("getpass.getpass", side_effect=[self.PW, self.PW]), patch(
            "builtins.input", side_effect=["root1801i", "root1801i@example.com"]
        ):
            call_command("createsuperuser", stdin=stdin, stdout=StringIO())
        user = User.objects.get(username="root1801i")
        entry = AdminActionLog.objects.get(action=SET)
        _assert_entry_is_secret_free(self, entry, user)

    def test_unusable_password_records_no_password_set(self):
        # No password was set, so there is no password set to record. The access
        # flags superuser status gives the account are still recorded (#1830).
        self._noinput(password=None)
        user = User.objects.get(username="root1801")
        self.assertFalse(user.has_usable_password())
        self.assertFalse(AdminActionLog.objects.filter(action=SET).exists())

    def test_log_failure_leaves_no_account(self):
        with patch.object(AdminActionLog, "record", side_effect=RuntimeError("log down")):
            with self.assertRaises(RuntimeError):
                self._noinput()
        self.assertFalse(User.objects.filter(username="root1801").exists())
