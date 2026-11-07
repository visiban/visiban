"""The admin account-change lock is ``FOR NO KEY UPDATE`` (#2076).

``lock_user_row`` is held while a deactivation revokes the user's group invite
links, which waits on those link rows. A join that already holds a link row and
then takes ``FOR KEY SHARE`` on the creator's account row (what PostgreSQL does
to check the link's foreign key) must not be blocked by that lock, or the two
wait on each other. ``FOR NO KEY UPDATE`` does not conflict with ``KEY SHARE``;
``FOR UPDATE`` did.

PostgreSQL only: SQLite has no row locks.
"""

import threading
from datetime import timedelta
from unittest import mock, skipUnless

from django.db import connection, connections, transaction
from django.test import TransactionTestCase
from django.utils import timezone
from rest_framework.test import APIClient

import accounts.admin_views as admin_views
from accounts.models import SiteSetting, User
from boards.tests.invite_fixtures import generate_invite
from boards.tests.lock_wait import assert_blocked_on_lock
from groups.models import Group, GroupInviteLink, GroupMembership

HOLD_TIMEOUT = 10.0
PW = "pw-2076-x!"


@skipUnless(connection.vendor == "postgresql", "row locks are only observable on PostgreSQL")
class AdminUserLockModeTests(TransactionTestCase):
    def setUp(self):
        SiteSetting.get()
        patcher = mock.patch("groups.broadcast.broadcast_group_event")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.root = User.objects.create_superuser(username="root_lm", password=PW, email="root_lm@example.com")
        User.objects.filter(pk=self.root.pk).update(is_site_admin=True, can_access_all_content=True)
        self.creator = User.objects.create_user(username="creator_lm", password=PW, email="creator_lm@example.com")
        self.group = Group.objects.create(name="Team lm", owner=self.creator)
        GroupMembership.objects.create(group=self.group, user=self.creator, role=GroupMembership.Role.ADMIN)
        self.link, _raw = generate_invite(
            GroupInviteLink, group=self.group, created_by=self.creator,
            role=GroupInviteLink.Role.MEMBER, expires_at=timezone.now() + timedelta(days=7),
        )

    def _patch_deactivate(self):
        client = APIClient()
        client.force_authenticate(User.objects.get(pk=self.root.pk))
        return client.patch(f"/api/v1/admin/users/{self.creator.pk}/", {"is_active": False}, format="json")

    def test_deactivation_does_not_deadlock_with_a_holder_of_the_link_row(self):
        """A holds the link row, then asks for KEY SHARE on the creator; B (PATCH) holds the account row.

        Under ``FOR UPDATE`` the key-share request waited on B while B waited
        on A's link row: a deadlock, one side aborted. Now A's request is
        granted at once, A commits, and B proceeds to deactivate.
        """
        have_link, proceed, results = threading.Event(), threading.Event(), {}

        def join_like():
            try:
                with transaction.atomic():
                    list(GroupInviteLink.objects.select_for_update().filter(pk=self.link.pk))
                    have_link.set()
                    proceed.wait(HOLD_TIMEOUT)
                    with connection.cursor() as cur:
                        cur.execute(
                            f"SELECT id FROM {User._meta.db_table} WHERE id = %s FOR KEY SHARE",
                            [self.creator.pk],
                        )
                        results["key_share_rows"] = cur.fetchall()
                results["join_like"] = "committed"
            except Exception as exc:  # surfaced by the assertions
                results["join_like"] = exc
            finally:
                connections.close_all()

        def deactivate():
            try:
                results["patch"] = self._patch_deactivate()
            except Exception as exc:  # surfaced by the assertions
                results["patch"] = exc
            finally:
                connections.close_all()

        holder = threading.Thread(target=join_like, name="join_like")
        holder.start()
        self.assertTrue(have_link.wait(HOLD_TIMEOUT), "the link-row holder never started")
        patcher = threading.Thread(target=deactivate, name="deactivate")
        patcher.start()
        try:
            assert_blocked_on_lock(self, patcher, "the deactivation must wait on the held link row")
        finally:
            proceed.set()
            holder.join(HOLD_TIMEOUT)
            patcher.join(HOLD_TIMEOUT)
        self.assertEqual(results.get("join_like"), "committed", results.get("join_like"))
        self.assertEqual(results["key_share_rows"], [(self.creator.pk,)])
        self.assertNotIsInstance(results["patch"], Exception, results["patch"])
        self.assertEqual(results["patch"].status_code, 200, results["patch"].content[:300])
        self.assertFalse(User.objects.get(pk=self.creator.pk).is_active)
        self.assertFalse(GroupInviteLink.objects.get(pk=self.link.pk).is_active)

    def test_lock_user_row_still_queues_concurrent_access_changes(self):
        """The weaker mode still conflicts with itself, so two changes of one account serialize."""
        held, release, results = threading.Event(), threading.Event(), {}

        def holder_fn():
            try:
                with transaction.atomic():
                    admin_views.lock_user_row(self.creator.pk)
                    held.set()
                    release.wait(HOLD_TIMEOUT)
            finally:
                connections.close_all()

        def second_fn():
            try:
                with transaction.atomic():
                    admin_views.lock_user_row(self.creator.pk)
                results["second"] = "locked"
            except Exception as exc:  # surfaced by the assertions
                results["second"] = exc
            finally:
                connections.close_all()

        holder = threading.Thread(target=holder_fn, name="holder")
        holder.start()
        self.assertTrue(held.wait(HOLD_TIMEOUT))
        second = threading.Thread(target=second_fn, name="second")
        second.start()
        try:
            assert_blocked_on_lock(self, second, "a second lock_user_row must queue behind the first")
        finally:
            release.set()
            holder.join(HOLD_TIMEOUT)
            second.join(HOLD_TIMEOUT)
        self.assertEqual(results.get("second"), "locked", results.get("second"))
