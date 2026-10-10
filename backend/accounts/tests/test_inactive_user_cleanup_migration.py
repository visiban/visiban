"""Cleanup of credentials and pending invites held by inactive accounts (#1583)."""
import importlib

from django.apps import apps
from django.test import TestCase

from accounts.models import InviteLink, PersonalAccessToken, User
from boards.models import Board, BoardInviteLink
from groups.models import Group, GroupInviteLink

_migration = importlib.import_module("groups.migrations.0018_clean_up_inactive_user_credentials")


def _run():
    _migration.clean_up_inactive_user_credentials(apps, None)


class InactiveUserCleanupMigrationTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner_1583", password="pw123456!x")
        self.board = Board.objects.create(name="b1583", owner=self.owner)
        self.group = Group.objects.create(name="g1583", owner=self.owner)
        self.inactive = self._user_with_credentials("inactive_1583")
        self.active = self._user_with_credentials("active_1583")
        # Deactivated directly, as accounts were before revocation existed.
        User.objects.filter(pk=self.inactive.pk).update(is_active=False)

    def _user_with_credentials(self, name):
        user = User.objects.create_user(username=name, password="pw123456!x")
        PersonalAccessToken.generate(user, "tok")
        InviteLink.generate(created_by=user)
        BoardInviteLink.objects.create(
            board=self.board, created_by=user, token_hash=f"bh-{name}", role="viewer",
        )
        GroupInviteLink.objects.create(
            group=self.group, created_by=user, token_hash=f"gh-{name}", is_active=True,
        )
        return user

    def test_inactive_user_credentials_and_pending_invites_removed(self):
        _run()
        u = self.inactive
        self.assertEqual(u.personal_access_tokens.count(), 0)
        self.assertFalse(InviteLink.objects.filter(created_by=u, revoked_at__isnull=True).exists())
        self.assertFalse(
            BoardInviteLink.objects.filter(created_by=u, revoked_at__isnull=True).exists()
        )
        self.assertFalse(GroupInviteLink.objects.filter(created_by=u, is_active=True).exists())

    def test_active_user_untouched(self):
        _run()
        u = self.active
        self.assertEqual(u.personal_access_tokens.count(), 1)
        self.assertTrue(InviteLink.objects.filter(created_by=u, revoked_at__isnull=True).exists())
        self.assertTrue(
            BoardInviteLink.objects.filter(created_by=u, revoked_at__isnull=True).exists()
        )
        self.assertTrue(GroupInviteLink.objects.filter(created_by=u, is_active=True).exists())

    def test_consumed_links_keep_history(self):
        from django.utils import timezone

        used = timezone.now()
        InviteLink.objects.filter(created_by=self.inactive).update(used_at=used)
        GroupInviteLink.objects.filter(created_by=self.inactive).update(used_at=used, single_use=True)
        _run()
        self.assertTrue(
            InviteLink.objects.filter(created_by=self.inactive, revoked_at__isnull=True).exists()
        )
        self.assertTrue(
            GroupInviteLink.objects.filter(created_by=self.inactive, is_active=True).exists()
        )

    def test_consumed_board_link_untouched(self):
        from django.utils import timezone

        BoardInviteLink.objects.filter(created_by=self.inactive).update(
            used_at=timezone.now(), single_use=True,
        )
        _run()
        link = BoardInviteLink.objects.get(created_by=self.inactive)
        self.assertIsNone(link.revoked_at)

    def test_already_revoked_link_keeps_original_revoked_at(self):
        from datetime import timedelta

        from django.utils import timezone

        earlier = timezone.now() - timedelta(days=30)
        BoardInviteLink.objects.filter(created_by=self.inactive).update(revoked_at=earlier)
        InviteLink.objects.filter(created_by=self.inactive).update(revoked_at=earlier)
        _run()
        self.assertEqual(BoardInviteLink.objects.get(created_by=self.inactive).revoked_at, earlier)
        self.assertEqual(InviteLink.objects.get(created_by=self.inactive).revoked_at, earlier)

    def test_idempotent(self):
        _run()
        _run()
        self.assertEqual(self.inactive.personal_access_tokens.count(), 0)
