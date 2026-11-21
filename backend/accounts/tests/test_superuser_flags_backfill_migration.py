"""Migrate-time check of accounts/0036 using historical models (#1629)."""

import pytest
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase

BEFORE = [("accounts", "0035_invite_link_delivery")]
AFTER = [("accounts", "0036_backfill_superuser_flags")]


pytestmark = pytest.mark.migrations


class SuperuserFlagsBackfillTests(TransactionTestCase):
    def _migrate(self, targets):
        executor = MigrationExecutor(connection)
        executor.migrate(targets)
        return executor.loader.project_state(targets).apps

    def tearDown(self):
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())

    def test_superusers_normalized_and_others_untouched(self):
        apps = self._migrate(BEFORE)
        User = apps.get_model("accounts", "User")
        su = User.objects.create(username="su_1629a", password="x", is_superuser=True)
        partial = User.objects.create(
            username="su_1629b", password="x", is_superuser=True, is_site_admin=True
        )
        only_content = User.objects.create(
            username="su_1629c",
            password="x",
            is_superuser=True,
            can_access_all_content=True,
        )
        plain = User.objects.create(username="plain_1629", password="x")
        admin = User.objects.create(
            username="adm_1629", password="x", is_site_admin=True
        )

        apps = self._migrate(AFTER)
        User = apps.get_model("accounts", "User")
        for pk in (su.pk, partial.pk, only_content.pk):
            u = User.objects.get(pk=pk)
            self.assertTrue(u.is_site_admin)
            self.assertTrue(u.can_access_all_content)
        u = User.objects.get(pk=plain.pk)
        self.assertFalse(u.is_site_admin)
        self.assertFalse(u.can_access_all_content)
        u = User.objects.get(pk=admin.pk)
        self.assertTrue(u.is_site_admin)
        self.assertFalse(u.can_access_all_content)

    def test_forward_is_idempotent(self):
        import importlib

        mod = importlib.import_module(
            "accounts.migrations.0036_backfill_superuser_flags"
        )
        apps = self._migrate(BEFORE)
        User = apps.get_model("accounts", "User")
        su = User.objects.create(username="su_1629d", password="x", is_superuser=True)
        for _ in range(2):
            mod.backfill_superuser_flags(apps, None)
            u = User.objects.get(pk=su.pk)
            self.assertTrue(u.is_site_admin)
            self.assertTrue(u.can_access_all_content)
