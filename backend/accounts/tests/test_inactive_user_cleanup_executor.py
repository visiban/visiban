"""Migrate-time check of groups/0018 using historical models (#1583)."""
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase

_DEPS = [
    ("accounts", "0035_invite_link_delivery"),
    ("boards", "0070_boardexportlog_row_count_help_text"),
]
BEFORE = [("groups", "0017_deactivate_lapsed_admin_invite_links"), *_DEPS]
AFTER = [("groups", "0018_clean_up_inactive_user_credentials"), *_DEPS]


class InactiveUserCleanupExecutorTests(TransactionTestCase):
    def _migrate(self, targets):
        executor = MigrationExecutor(connection)
        executor.migrate(targets)
        return executor.loader.project_state(targets).apps

    def tearDown(self):
        # Always return the shared test DB to the latest schema.
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())

    def test_migration_cleans_inactive_accounts_only(self):
        apps = self._migrate(BEFORE)
        User = apps.get_model("accounts", "User")
        PAT = apps.get_model("accounts", "PersonalAccessToken")
        Invite = apps.get_model("accounts", "InviteLink")
        Group = apps.get_model("groups", "Group")
        GroupLink = apps.get_model("groups", "GroupInviteLink")

        owner = User.objects.create(username="own_1583x", password="x")
        group = Group.objects.create(name="g_1583x", owner=owner)
        users = {}
        for name, active in (("inactive", False), ("active", True)):
            u = User.objects.create(username=f"{name}_1583x", password="x", is_active=active)
            PAT.objects.create(user=u, name="t", prefix="vbn_aaaa", token_hash=f"th-{name}")
            Invite.objects.create(created_by=u, token_hash=f"ih-{name}")
            GroupLink.objects.create(group=group, created_by=u, token_hash=f"gh-{name}")
            users[name] = u

        apps = self._migrate(AFTER)
        PAT = apps.get_model("accounts", "PersonalAccessToken")
        Invite = apps.get_model("accounts", "InviteLink")
        GroupLink = apps.get_model("groups", "GroupInviteLink")
        gone, kept = users["inactive"].pk, users["active"].pk
        self.assertFalse(PAT.objects.filter(user_id=gone).exists())
        self.assertTrue(PAT.objects.filter(user_id=kept).exists())
        self.assertFalse(Invite.objects.filter(created_by_id=gone, revoked_at__isnull=True).exists())
        self.assertTrue(Invite.objects.filter(created_by_id=kept, revoked_at__isnull=True).exists())
        self.assertFalse(GroupLink.objects.filter(created_by_id=gone, is_active=True).exists())
        self.assertTrue(GroupLink.objects.filter(created_by_id=kept, is_active=True).exists())
