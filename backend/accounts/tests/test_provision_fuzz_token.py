"""Tests for the provision_fuzz_token management command (#1080).

Covers the guardrail that matters most: the command must refuse to mint a
token for a privileged account, because backend-schema-fuzz is required to
authenticate as a normal board member, not a superuser/site-admin.
"""
import os
import stat
import tempfile
from io import StringIO

from django.core.management import call_command, CommandError
from django.test import TestCase

from accounts.models import PAT_DEFAULT_SCOPES, PersonalAccessToken, User


class ProvisionFuzzTokenTests(TestCase):
    def setUp(self):
        self.member = User.objects.create_user(username="demo2", password="unused")
        self.tmp_dir = tempfile.mkdtemp()
        self.token_file = os.path.join(self.tmp_dir, "token")

    def test_mints_scoped_token_for_normal_member(self):
        out = StringIO()
        call_command(
            "provision_fuzz_token",
            "--username",
            "demo2",
            "--token-file",
            self.token_file,
            stdout=out,
        )

        pat = PersonalAccessToken.objects.get(user=self.member)
        self.assertEqual(pat.scopes, PAT_DEFAULT_SCOPES)
        self.assertEqual(pat.name, "backend-schema-fuzz (CI)")

        with open(self.token_file) as fh:
            raw_token = fh.read().strip()
        self.assertTrue(raw_token.startswith("vbn_"))
        self.assertIn("Minted", out.getvalue())

    def test_token_file_is_not_world_or_group_readable(self):
        call_command(
            "provision_fuzz_token",
            "--username",
            "demo2",
            "--token-file",
            self.token_file,
        )
        mode = stat.S_IMODE(os.stat(self.token_file).st_mode)
        self.assertEqual(mode, 0o600)

    def test_refuses_missing_user(self):
        with self.assertRaises(CommandError) as ctx:
            call_command(
                "provision_fuzz_token",
                "--username",
                "nobody",
                "--token-file",
                self.token_file,
            )
        self.assertIn("does not exist", str(ctx.exception))

    def test_refuses_superuser(self):
        User.objects.create_superuser(username="admin2", password="unused", email="admin2@example.com")
        with self.assertRaises(CommandError) as ctx:
            call_command(
                "provision_fuzz_token",
                "--username",
                "admin2",
                "--token-file",
                self.token_file,
            )
        self.assertIn("elevated privileges", str(ctx.exception))

    def test_refuses_site_admin(self):
        User.objects.create_user(username="siteadmin", password="unused", is_site_admin=True)
        with self.assertRaises(CommandError) as ctx:
            call_command(
                "provision_fuzz_token",
                "--username",
                "siteadmin",
                "--token-file",
                self.token_file,
            )
        self.assertIn("elevated privileges", str(ctx.exception))

    def test_refuses_can_access_all_content(self):
        User.objects.create_user(username="poweruser", password="unused", can_access_all_content=True)
        with self.assertRaises(CommandError) as ctx:
            call_command(
                "provision_fuzz_token",
                "--username",
                "poweruser",
                "--token-file",
                self.token_file,
            )
        self.assertIn("elevated privileges", str(ctx.exception))
