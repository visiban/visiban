"""Migrate-time check of groups/0023 using historical models (#1940).

Proves the migration is in the graph and runs under ``migrate``, not only when
its function is called directly.
"""
import pytest
from datetime import timedelta

from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase
from django.utils import timezone

_DEPS = [
    ("accounts", "0035_invite_link_delivery"),
    ("boards", "0070_boardexportlog_row_count_help_text"),
]
BEFORE = [("groups", "0022_restore_group_owner_admin_rows"), *_DEPS]
AFTER = [("groups", "0023_revoke_legacy_group_invite_links"), *_DEPS]


pytestmark = pytest.mark.migrations


class RevokeLegacyLinksExecutorTests(TransactionTestCase):
    def _migrate(self, targets):
        executor = MigrationExecutor(connection)
        executor.migrate(targets)
        return executor.loader.project_state(targets).apps

    def tearDown(self):
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())

    def test_migrate_revokes_admin_and_caps_never_expiring(self):
        apps = self._migrate(BEFORE)
        User = apps.get_model("accounts", "User")
        Group = apps.get_model("groups", "Group")
        Link = apps.get_model("groups", "GroupInviteLink")
        owner = User.objects.create(username="own_1940x", password="x")
        group = Group.objects.create(name="g_1940x", owner=owner)
        far = timezone.now() + timedelta(days=20)

        def mk(name, **kw):
            return Link.objects.create(
                group=group, created_by=owner, token_hash=f"h-{name}-1940",
                delivery=kw.pop("delivery", "link"), **kw,
            ).pk

        admin = mk("admin", role="admin")
        never = mk("never", role="member")
        email = mk("email", role="admin", delivery="email")
        dated = mk("dated", role="member", expires_at=far)

        apps = self._migrate(AFTER)
        Link = apps.get_model("groups", "GroupInviteLink")
        self.assertFalse(Link.objects.get(pk=admin).is_active)
        capped = Link.objects.get(pk=never)
        self.assertTrue(capped.is_active)
        self.assertIsNotNone(capped.expires_at)
        self.assertLessEqual(capped.expires_at, timezone.now() + timedelta(days=7))
        self.assertGreater(capped.expires_at, timezone.now() + timedelta(days=6))
        emailed = Link.objects.get(pk=email)
        self.assertTrue(emailed.is_active)
        self.assertIsNone(emailed.expires_at)
        self.assertEqual(Link.objects.get(pk=dated).expires_at, far)
