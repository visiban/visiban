"""RunPython data migrations in accounts that had no executor coverage (#1987).

Covered here: accounts/0014 (backfill/reverse of can_access_all_content, which
is privilege-relevant) and accounts/0030 (notif_due_soon copied into
notif_stale). The functions are loaded from the real migration modules and run
against historical models from the migration loader's project state, so they
are exercised exactly as ``migrate`` would call them.
"""
import importlib

from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TestCase

M0014 = importlib.import_module("accounts.migrations.0014_user_can_access_all_content")
M0030 = importlib.import_module("accounts.migrations.0030_notification_email_preferences")


def _historical_apps():
    # Leaf state, not the migration's own state: the live table already has every
    # later column, and a model state missing a later NOT NULL column could not
    # insert. The migration functions only use fields that exist in both.
    loader = MigrationExecutor(connection).loader
    return loader.project_state(loader.graph.leaf_nodes()).apps


class CanAccessAllContentBackfillTests(TestCase):
    def setUp(self):
        self.apps = _historical_apps()
        User = self.apps.get_model("accounts", "User")
        self.admin = User.objects.create(username="adm_1987", password="x", is_site_admin=True)
        self.plain = User.objects.create(username="plain_1987", password="x")
        # A non-admin who already holds the flag must survive both directions.
        self.holder = User.objects.create(
            username="holder_1987", password="x", can_access_all_content=True
        )

    def _flag(self, user):
        User = self.apps.get_model("accounts", "User")
        return User.objects.get(pk=user.pk).can_access_all_content

    def test_forward_grants_flag_to_site_admins_only(self):
        M0014.backfill_can_access_all_content(self.apps, None)
        self.assertTrue(self._flag(self.admin))
        self.assertFalse(self._flag(self.plain))
        self.assertTrue(self._flag(self.holder))

    def test_reverse_clears_flag_for_site_admins_only(self):
        M0014.backfill_can_access_all_content(self.apps, None)
        M0014.reverse_can_access_all_content(self.apps, None)
        self.assertFalse(self._flag(self.admin))
        # The reverse is scoped to site admins; it must not strip other holders.
        self.assertTrue(self._flag(self.holder))
        self.assertFalse(self._flag(self.plain))

    def test_forward_is_idempotent(self):
        M0014.backfill_can_access_all_content(self.apps, None)
        M0014.backfill_can_access_all_content(self.apps, None)
        self.assertTrue(self._flag(self.admin))


class NotifDueSoonCopyTests(TestCase):
    def setUp(self):
        self.apps = _historical_apps()
        self.User = self.apps.get_model("accounts", "User")

    def test_opted_in_users_get_notif_stale(self):
        on = self.User.objects.create(username="on_1987", password="x", notif_due_soon=True)
        off = self.User.objects.create(username="off_1987", password="x", notif_due_soon=False)
        M0030.copy_due_soon_to_stale(self.apps, None)
        self.assertTrue(self.User.objects.get(pk=on.pk).notif_stale)
        self.assertFalse(self.User.objects.get(pk=off.pk).notif_stale)

    def test_does_not_clear_existing_notif_stale(self):
        # Only opted-in rows are written, so a user who already set notif_stale
        # without notif_due_soon keeps it.
        user = self.User.objects.create(
            username="stale_1987", password="x", notif_due_soon=False, notif_stale=True
        )
        M0030.copy_due_soon_to_stale(self.apps, None)
        self.assertTrue(self.User.objects.get(pk=user.pk).notif_stale)

    def test_reverse_is_noop(self):
        # The reverse is RunPython.noop; reversing the AddField drops the column.
        runpython = [op for op in M0030.Migration.operations if op.__class__.__name__ == "RunPython"][0]
        self.assertIs(runpython.reverse_code, M0030.migrations.RunPython.noop)
