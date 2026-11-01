"""The group admin minimum and account deactivation serialize on the account rows (#1814).

``lock_membership_for_removal_or_demotion`` counts only active admins, so the
admins' ``User.is_active`` is part of what it judges. It locks those account
rows first (``lock_member_accounts``), before the group row, and every
deactivation path updates or locks the same row, so a member change and a
deactivation of another admin queue on it in either order. The user delete
locks the other admins' account rows too, and a promotion of an account that
is being deleted queues behind the delete.

Deactivation itself is unchanged: it is never refused for being a group's last
active admin (a superuser ownership transfer repairs such a group).

The concurrent tests are PostgreSQL only: SQLite has no row locks.
"""

import threading
from unittest import mock, skipUnless

from django.contrib import admin as django_admin
from django.db import DatabaseError, connection, connections, transaction
from django.test import RequestFactory, TestCase
from rest_framework.test import APIClient

import accounts.admin as admin_module
import accounts.admin_views as admin_views
import groups.services as services
from accounts.models import SiteSetting, User
from boards.tests.lock_wait import assert_blocked_on_lock
from groups.models import Group, GroupMembership
from groups.services import LAST_ADMIN_MESSAGE, lock_member_accounts
from groups.tests.test_group_invite_vs_group_delete import HOLD_TIMEOUT, _GroupDeleteRaceBase

ADMIN = GroupMembership.Role.ADMIN
MEMBER = GroupMembership.Role.MEMBER
PW = "pw-1814-x!"

# Asserted literally: the refusal body is public API and stays unchanged (#1814).
_LAST_ADMIN_REFUSED = {"detail": LAST_ADMIN_MESSAGE, "code": "group_last_admin"}


def _root(name):
    """An active superuser with site-admin and all-content access (admin API and group admin)."""
    user = User.objects.create_superuser(username=name, password=PW, email=f"{name}@example.com")
    User.objects.filter(pk=user.pk).update(is_site_admin=True, can_access_all_content=True)
    return User.objects.get(pk=user.pk)


def _setup_group(test, suffix):
    """A group whose only active admins are ``test.a`` and ``test.b``.

    The owner keeps its admin row but is deactivated, so it does not count
    toward the minimum (the departed-owner case).
    """
    test.root = _root(f"root_{suffix}")
    test.gone_owner = User.objects.create_user(username=f"owner_{suffix}", password=PW, is_active=False)
    test.group = Group.objects.create(name=f"Team {suffix}", owner=test.gone_owner)
    test.group_id = test.group.pk
    GroupMembership.objects.create(group=test.group, user=test.gone_owner, role=ADMIN)
    test.a = User.objects.create_user(username=f"a_{suffix}", password=PW, email=f"a_{suffix}@example.com")
    test.b = User.objects.create_user(username=f"b_{suffix}", password=PW, email=f"b_{suffix}@example.com")
    for u in (test.a, test.b):
        GroupMembership.objects.create(group=test.group, user=u, role=ADMIN)


def _client(user):
    client = APIClient()
    client.force_authenticate(User.objects.get(pk=user.pk))
    return client


def _active_admin_count(group_id):
    return GroupMembership.objects.filter(group_id=group_id, role=ADMIN, user__is_active=True).count()


class DeactivationUnchangedTests(TestCase):
    """No new refusal: deactivating a group's last active admin still succeeds (#1814)."""

    def setUp(self):
        _setup_group(self, "plain")
        GroupMembership.objects.filter(group=self.group, user=self.b).delete()

    def test_patch_deactivates_the_last_active_group_admin(self):
        r = _client(self.root).patch(f"/api/v1/admin/users/{self.a.pk}/", {"is_active": False}, format="json")
        self.assertEqual(r.status_code, 200, r.content[:300])
        self.assertFalse(r.json()["is_active"])
        self.assertFalse(User.objects.get(pk=self.a.pk).is_active)
        # The membership is untouched: the role stays admin.
        self.assertEqual(GroupMembership.objects.get(group=self.group, user=self.a).role, ADMIN)

    def test_deactivate_endpoint_deactivates_the_last_active_group_admin(self):
        r = _client(self.root).post(f"/api/v1/admin/users/{self.a.pk}/deactivate/", {}, format="json")
        self.assertEqual(r.status_code, 200, r.content[:300])
        self.assertFalse(User.objects.get(pk=self.a.pk).is_active)
        self.assertEqual(GroupMembership.objects.get(group=self.group, user=self.a).role, ADMIN)

    def test_removal_is_refused_once_the_other_admin_is_deactivated(self):
        GroupMembership.objects.create(group=self.group, user=self.b, role=ADMIN)
        User.objects.filter(pk=self.b.pk).update(is_active=False)
        r = _client(self.root).delete(f"/api/v1/groups/{self.group.pk}/members/{self.a.pk}/")
        self.assertEqual(r.status_code, 400, r.content[:300])
        self.assertEqual(r.json(), _LAST_ADMIN_REFUSED)


class LockMemberAccountsTests(TestCase):
    def setUp(self):
        _setup_group(self, "set")
        self.member = User.objects.create_user(username="m_set", password=PW)
        GroupMembership.objects.create(group=self.group, user=self.member, role=MEMBER)

    def test_locks_every_admin_account_and_the_named_accounts(self):
        with transaction.atomic():
            ids = lock_member_accounts(self.group.pk, self.member.pk)
        self.assertEqual(ids, {self.gone_owner.pk, self.a.pk, self.b.pk, self.member.pk})

    def test_an_admin_whose_account_is_not_held_is_not_counted(self):
        """An admin promoted after the account lock cannot keep the minimum (#1814)."""
        held = {self.gone_owner.pk, self.a.pk}  # b's row "not locked"
        with mock.patch.object(services, "lock_member_accounts", return_value=held):
            r = _client(self.root).delete(f"/api/v1/groups/{self.group.pk}/members/{self.a.pk}/")
        self.assertEqual(r.status_code, 400, r.content[:300])
        self.assertEqual(r.json(), _LAST_ADMIN_REFUSED)
        self.assertTrue(GroupMembership.objects.filter(group=self.group, user=self.a).exists())


@skipUnless(connection.vendor == "postgresql", "row locks are only observable on PostgreSQL")
class MemberChangeVsDeactivationTests(_GroupDeleteRaceBase):
    """A member removal and a deactivation of the group's other admin queue, in both orders."""

    # Deactivation holds after its UPDATE of is_active, still uncommitted.
    PATCH_HOLD = (admin_views, "apply_access_loss_revocations", False)
    # The deactivate endpoint logs after its save, inside its transaction.
    DEACTIVATE_HOLD = (admin_views.logger, "info", False)
    # A member change holds once the guard returned, with its locks taken.
    GUARD_HOLD = (services, "lock_membership_for_removal_or_demotion", False)

    def setUp(self):
        # Not super().setUp(): only the base's _race / _thread harness is used.
        SiteSetting.get()
        patcher = mock.patch("groups.broadcast.broadcast_group_event")
        patcher.start()
        self.addCleanup(patcher.stop)
        _setup_group(self, "race")

    def _remove_a(self):
        return _client(self.root).delete(f"/api/v1/groups/{self.group_id}/members/{self.a.pk}/")

    def _demote_a(self):
        return _client(self.root).patch(
            f"/api/v1/groups/{self.group_id}/members/{self.a.pk}/", {"role": "member"}, format="json",
        )

    def _patch_deactivate_b(self):
        return _client(self.root).patch(f"/api/v1/admin/users/{self.b.pk}/", {"is_active": False}, format="json")

    def _endpoint_deactivate_b(self):
        return _client(self.root).post(f"/api/v1/admin/users/{self.b.pk}/deactivate/", {}, format="json")

    def test_removal_behind_patch_deactivation_sees_it_and_is_refused(self):
        deactivated, removed = self._race(self.PATCH_HOLD, self._patch_deactivate_b, self._remove_a)
        self.assertEqual(deactivated.status_code, 200, deactivated.content[:300])
        self.assertEqual(removed.status_code, 400, removed.content[:300])
        self.assertEqual(removed.json(), _LAST_ADMIN_REFUSED)
        # The group keeps an active admin: a stays.
        self.assertEqual(_active_admin_count(self.group_id), 1)
        self.assertTrue(GroupMembership.objects.filter(group_id=self.group_id, user=self.a, role=ADMIN).exists())

    def test_demotion_behind_deactivate_endpoint_sees_it_and_is_refused(self):
        deactivated, demoted = self._race(self.DEACTIVATE_HOLD, self._endpoint_deactivate_b, self._demote_a)
        self.assertEqual(deactivated.status_code, 200, deactivated.content[:300])
        self.assertEqual(demoted.status_code, 400, demoted.content[:300])
        self.assertEqual(demoted.json(), _LAST_ADMIN_REFUSED)
        self.assertEqual(_active_admin_count(self.group_id), 1)

    def test_deactivation_behind_removal_waits_and_still_succeeds(self):
        """The other order: the deactivation waits for the removal, then runs unchanged.

        Deactivation is never refused for being a group's last active admin,
        so it succeeds on the post-removal state.
        """
        removed, deactivated = self._race(self.GUARD_HOLD, self._remove_a, self._patch_deactivate_b)
        self.assertEqual(removed.status_code, 204, removed.content[:300])
        self.assertEqual(deactivated.status_code, 200, deactivated.content[:300])
        self.assertFalse(GroupMembership.objects.filter(group_id=self.group_id, user=self.a).exists())
        self.assertFalse(User.objects.get(pk=self.b.pk).is_active)

    def test_guard_takes_account_rows_before_the_group_row(self):
        """Lock order: while the guard waits on an account row it holds no group or membership row."""
        held, release, results = threading.Event(), threading.Event(), {}

        def hold_b():
            try:
                with transaction.atomic():
                    User.objects.select_for_update(no_key=True).get(pk=self.b.pk)
                    held.set()
                    release.wait(HOLD_TIMEOUT)
            finally:
                connections.close_all()

        holder = threading.Thread(target=hold_b, name="hold_b")
        holder.start()
        self.assertTrue(held.wait(HOLD_TIMEOUT))
        remover = self._thread("remover", self._remove_a, results)
        try:
            assert_blocked_on_lock(self, remover, "the removal must wait on the other admin's account row")
            try:
                with transaction.atomic():
                    Group.objects.select_for_update(nowait=True).get(pk=self.group_id)
                    list(GroupMembership.objects.select_for_update(nowait=True).filter(group_id=self.group_id))
            except DatabaseError as exc:  # pragma: no cover - only on a lock-order regression
                self.fail(f"the guard locked the group or memberships before the account rows: {exc}")
        finally:
            release.set()
            holder.join(HOLD_TIMEOUT)
            remover.join(HOLD_TIMEOUT)
        self.assertEqual(results["remover"].status_code, 204, results["remover"].content[:300])

    def test_transfer_takes_the_new_owner_account_before_the_group_row(self):
        held, release, results = threading.Event(), threading.Event(), {}

        def hold_a():
            try:
                with transaction.atomic():
                    User.objects.select_for_update(no_key=True).get(pk=self.a.pk)
                    held.set()
                    release.wait(HOLD_TIMEOUT)
            finally:
                connections.close_all()

        def transfer():
            # The Django admin route: a departed owner's group goes to an active member.
            return services.transfer_group_ownership(
                self.group_id, self.a.pk, require_admin_role=False, require_active=True,
            )

        holder = threading.Thread(target=hold_a, name="hold_a")
        holder.start()
        self.assertTrue(held.wait(HOLD_TIMEOUT))
        transferer = self._thread("transferer", transfer, results)
        try:
            assert_blocked_on_lock(self, transferer, "the transfer must wait on the new owner's account row")
            try:
                with transaction.atomic():
                    Group.objects.select_for_update(nowait=True).get(pk=self.group_id)
            except DatabaseError as exc:  # pragma: no cover - only on a lock-order regression
                self.fail(f"the transfer locked the group row before the account row: {exc}")
        finally:
            release.set()
            holder.join(HOLD_TIMEOUT)
            transferer.join(HOLD_TIMEOUT)
        self.assertNotIsInstance(results["transferer"], Exception, results["transferer"])
        self.assertEqual(Group.objects.get(pk=self.group_id).owner_id, self.a.pk)


@skipUnless(connection.vendor == "postgresql", "row locks are only observable on PostgreSQL")
class UserDeleteVsDeactivationTests(MemberChangeVsDeactivationTests):
    """The user delete holds the other admins' account rows, and a promotion of its target queues."""

    # The delete holds after statement 1 (account rows, then group rows).
    DELETE_HOLD = (admin_module.VisibanUserAdmin, "_lock_cards_then_targets", True)

    # Inherited setUp and helpers only.
    test_removal_behind_patch_deactivation_sees_it_and_is_refused = None
    test_demotion_behind_deactivate_endpoint_sees_it_and_is_refused = None
    test_deactivation_behind_removal_waits_and_still_succeeds = None
    test_guard_takes_account_rows_before_the_group_row = None
    test_transfer_takes_the_new_owner_account_before_the_group_row = None

    def _delete_user(self, user):
        request = RequestFactory().post("/")
        request.user = User.objects.get(pk=self.root.pk)
        try:
            django_admin.site._registry[User].delete_model(request, User.objects.get(pk=user.pk))
        except admin_module.DeletionRefused as exc:
            return ("refused", exc.messages)
        return "deleted"

    def test_delete_behind_deactivation_of_the_other_admin_is_refused(self):
        deactivated, deleted = self._race(self.PATCH_HOLD, self._patch_deactivate_b, lambda: self._delete_user(self.a))
        self.assertEqual(deactivated.status_code, 200, deactivated.content[:300])
        self.assertIsInstance(deleted, tuple, deleted)
        self.assertEqual(deleted[0], "refused")
        self.assertTrue(any("last active admin of a group" in m for m in deleted[1]), deleted)
        self.assertTrue(User.objects.filter(pk=self.a.pk).exists())

    def test_deactivation_of_the_other_admin_waits_for_the_delete(self):
        deleted, deactivated = self._race(self.DELETE_HOLD, lambda: self._delete_user(self.a), self._patch_deactivate_b)
        self.assertEqual(deleted, "deleted")
        # Unchanged deactivation behavior: it runs after the delete committed.
        self.assertEqual(deactivated.status_code, 200, deactivated.content[:300])
        self.assertFalse(User.objects.filter(pk=self.a.pk).exists())

    def test_promotion_of_the_deleted_account_waits_and_finds_it_gone(self):
        """A member promoted to admin while being deleted (#1786): the promotion queues."""
        other = Group.objects.create(name="Other race", owner=self.b)
        GroupMembership.objects.create(group=other, user=self.b, role=ADMIN)
        GroupMembership.objects.create(group=other, user=self.a, role=MEMBER)

        def promote():
            return _client(self.root).patch(
                f"/api/v1/groups/{other.pk}/members/{self.a.pk}/", {"role": "admin"}, format="json",
            )

        deleted, promoted = self._race(self.DELETE_HOLD, lambda: self._delete_user(self.a), promote)
        self.assertEqual(deleted, "deleted")
        self.assertEqual(promoted.status_code, 404, promoted.content[:300])
        self.assertFalse(GroupMembership.objects.filter(group=other, user_id=self.a.pk).exists())
