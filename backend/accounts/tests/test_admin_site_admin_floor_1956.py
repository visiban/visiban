"""The admin API judges the last-active-site-admin floor on locked rows (#1956).

``AdminUserDetailView.patch`` (``is_site_admin`` or ``is_active`` false) and
``AdminUserDeactivateView.post`` lock the target, the actor and every active
administrator in one pk-ordered statement (``lock_admin_accounts``), then
re-check the actor's standing and the floor with fresh reads
(``site_admin_floor_refusal``). Concurrent changes of this kind are judged in
turn, and at least one active site admin remains.

``SiteAdminFloorRecheckTests`` runs on every backend: it changes state between
the lock and the re-check from inside the request's own transaction.
``ConcurrentSiteAdminRemovalTests`` runs two real requests in threads and is
PostgreSQL only (SQLite has no row locks).
"""

import threading
from unittest import mock, skipUnless

from django.db import connection, connections
from django.test import Client, TestCase, TransactionTestCase
from django.urls import reverse
from rest_framework.test import APIClient

import accounts.admin_views as admin_views
from accounts.models import SiteSetting, User
from accounts.permissions import IsSiteAdmin
from accounts.tests.test_admin_access_revocation import _form_data
from accounts.tests.test_admin_user_form_guards import _PLAIN_STATIC
from boards.tests.lock_wait import assert_blocked_on_lock

HOLD_TIMEOUT = 10.0
PW = "pw-1956-x!"


def _site_admin(username):
    user = User.objects.create_user(username=username, password=PW, email=f"{username}@example.com")
    User.objects.filter(pk=user.pk).update(is_site_admin=True)
    return User.objects.get(pk=user.pk)


def _client(user):
    client = APIClient()
    client.force_authenticate(User.objects.get(pk=user.pk))
    return client


def _demote(actor, target):
    return _client(actor).patch(f"/api/v1/admin/users/{target.pk}/", {"is_site_admin": False}, format="json")


def _patch_deactivate(actor, target):
    return _client(actor).patch(f"/api/v1/admin/users/{target.pk}/", {"is_active": False}, format="json")


def _deactivate(actor, target):
    return _client(actor).post(f"/api/v1/admin/users/{target.pk}/deactivate/", {}, format="json")


class SiteAdminFloorRecheckTests(TestCase):
    """The re-check under the lock sees a change committed after the unlocked guards ran."""

    def setUp(self):
        SiteSetting.get()
        self.a = _site_admin("floor_a")
        self.b = _site_admin("floor_b")

    def _actor_loses_standing_after_lock(self, **flags):
        """Wrap the lock so the actor (``a``) loses site-admin standing right after it is taken.

        Stands in for a concurrent request that committed that change while
        this one waited on the lock.
        """
        real = admin_views.lock_admin_accounts

        def lock_then_change_actor(*pks):
            rows = real(*pks)
            User.objects.filter(pk=self.a.pk).update(**flags)
            return rows

        return mock.patch.object(admin_views, "lock_admin_accounts", side_effect=lock_then_change_actor)

    def assert_forbidden(self, response):
        self.assertEqual(response.status_code, 403, response.content[:300])
        self.assertEqual(response.json(), {"detail": IsSiteAdmin.message})

    def test_demotion_refused_when_the_actor_was_demoted_meanwhile(self):
        with self._actor_loses_standing_after_lock(is_site_admin=False):
            r = _demote(self.a, self.b)
        self.assert_forbidden(r)
        self.assertTrue(User.objects.get(pk=self.b.pk).is_site_admin)

    def test_patch_deactivation_refused_when_the_actor_was_deactivated_meanwhile(self):
        with self._actor_loses_standing_after_lock(is_active=False):
            r = _patch_deactivate(self.a, self.b)
        self.assert_forbidden(r)
        self.assertTrue(User.objects.get(pk=self.b.pk).is_active)

    def test_deactivate_endpoint_refused_when_the_actor_was_demoted_meanwhile(self):
        with self._actor_loses_standing_after_lock(is_site_admin=False):
            r = _deactivate(self.a, self.b)
        self.assert_forbidden(r)
        self.assertTrue(User.objects.get(pk=self.b.pk).is_active)

    def test_deactivate_endpoint_judges_the_actor_before_the_target(self):
        """A caller without standing gets the 403, not the target's 404 or 400 answers."""
        missing_pk = User.objects.order_by("-pk").values_list("pk", flat=True).first() + 1000
        with self._actor_loses_standing_after_lock(is_site_admin=False):
            r = _client(self.a).post(f"/api/v1/admin/users/{missing_pk}/deactivate/", {}, format="json")
        self.assert_forbidden(r)
        User.objects.filter(pk=self.a.pk).update(is_site_admin=True)
        User.objects.filter(pk=self.b.pk).update(is_active=False)
        with self._actor_loses_standing_after_lock(is_site_admin=False):
            r = _deactivate(self.a, self.b)
        self.assert_forbidden(r)

    def test_non_reducing_patch_takes_no_admin_lock(self):
        """A change that cannot lower the site-admin count keeps the single-row lock."""
        with mock.patch.object(admin_views, "lock_admin_accounts", wraps=admin_views.lock_admin_accounts) as lock:
            r = _client(self.a).patch(
                f"/api/v1/admin/users/{self.b.pk}/", {"must_change_password": True}, format="json"
            )
        self.assertEqual(r.status_code, 200, r.content[:300])
        lock.assert_not_called()

    def test_reducing_requests_lock_target_and_actor(self):
        with mock.patch.object(admin_views, "lock_admin_accounts", wraps=admin_views.lock_admin_accounts) as lock:
            self.assertEqual(_demote(self.a, self.b).status_code, 200)
        lock.assert_called_once_with(self.b.pk, self.a.pk)

    def test_uncontended_removals_still_succeed(self):
        c = _site_admin("floor_c")
        self.assertEqual(_demote(self.a, self.b).status_code, 200)
        self.assertEqual(_patch_deactivate(self.a, self.b).status_code, 200)
        self.assertEqual(_deactivate(self.a, c).status_code, 200)
        self.assertEqual(
            list(User.objects.filter(is_site_admin=True, is_active=True).values_list("pk", flat=True)),
            [self.a.pk],
        )

    def test_floor_refusal_keeps_the_last_active_site_admin(self):
        """The count branch, called directly: only reachable when the actor is the target."""
        User.objects.filter(pk=self.b.pk).update(is_site_admin=False)
        a = User.objects.get(pk=self.a.pk)
        refusal = admin_views.site_admin_floor_refusal(a, a, demoting=True)
        self.assertEqual(refusal.status, 400)
        self.assertEqual(refusal.body, {"detail": "Cannot demote the last active site admin."})
        refusal = admin_views.site_admin_floor_refusal(a, a, deactivating=True)
        self.assertEqual(refusal.body, {"detail": "Cannot deactivate the last active site admin."})
        self.assertIsNone(admin_views.site_admin_floor_refusal(a, a))

    def test_lock_set_is_target_actor_and_active_admins(self):
        plain = User.objects.create_user(username="floor_plain", password=PW, email="floor_plain@example.com")
        other = User.objects.create_user(username="floor_other", password=PW, email="floor_other@example.com")
        inactive = _site_admin("floor_inactive")
        User.objects.filter(pk=inactive.pk).update(is_active=False)
        root = User.objects.create_superuser(username="floor_root", password=PW, email="floor_root@example.com")
        rows = admin_views.lock_admin_accounts(plain.pk)
        self.assertEqual([u.pk for u in rows], sorted([self.a.pk, self.b.pk, root.pk, plain.pk]))
        self.assertNotIn(other.pk, [u.pk for u in rows])


class _RaceBase(TransactionTestCase):
    """Run two requests in threads, the first paused right after its lock_admin_accounts."""

    HOLDER = "holder_1956"

    def setUp(self):
        SiteSetting.get()
        patcher = mock.patch("groups.broadcast.broadcast_group_event")
        patcher.start()
        self.addCleanup(patcher.stop)

    def _race(self, first, second):
        """Run ``first`` (paused after its lock) and then ``second``; return both responses."""
        held, release, results = threading.Event(), threading.Event(), {}
        real = admin_views.lock_admin_accounts

        def lock_and_hold(*pks):
            rows = real(*pks)
            if threading.current_thread().name == self.HOLDER:
                held.set()
                release.wait(HOLD_TIMEOUT)
            return rows

        def run(key, fn):
            try:
                results[key] = fn()
            except Exception as exc:  # surfaced by the assertions
                results[key] = exc
            finally:
                connections.close_all()

        waiter = None
        with mock.patch.object(admin_views, "lock_admin_accounts", side_effect=lock_and_hold):
            holder = threading.Thread(target=run, args=("first", first), name=self.HOLDER)
            holder.start()
            try:
                self.assertTrue(held.wait(HOLD_TIMEOUT), "the first request never took its lock")
                waiter = threading.Thread(target=run, args=("second", second), name="waiter_1956")
                waiter.start()
                assert_blocked_on_lock(self, waiter, "the second removal must wait on the first's locks")
            finally:
                release.set()
                holder.join(HOLD_TIMEOUT)
                if waiter is not None:
                    waiter.join(HOLD_TIMEOUT)
        for key in ("first", "second"):
            self.assertNotIsInstance(results.get(key), Exception, results.get(key))
        return results["first"], results["second"]


@skipUnless(connection.vendor == "postgresql", "row locks are only observable on PostgreSQL")
class ConcurrentSiteAdminRemovalTests(_RaceBase):
    """Two concurrent site-admin removals with only two site admins and no superuser.

    The first request is paused holding its locks; the second must wait on
    them, and once the first commits it is judged on the committed state. One
    active site admin remains.
    """

    def setUp(self):
        super().setUp()
        self.a = _site_admin("race_a")
        self.b = _site_admin("race_b")
        self.assertFalse(User.objects.filter(is_superuser=True).exists())

    def assert_one_active_site_admin_left(self):
        self.assertEqual(User.objects.filter(is_site_admin=True, is_active=True).count(), 1)

    def test_concurrent_demotions_keep_one_site_admin(self):
        first, second = self._race(lambda: _demote(self.a, self.b), lambda: _demote(self.b, self.a))
        self.assertEqual(first.status_code, 200, first.content[:300])
        self.assertEqual(second.status_code, 403, second.content[:300])
        self.assertTrue(User.objects.get(pk=self.a.pk).is_site_admin)
        self.assertFalse(User.objects.get(pk=self.b.pk).is_site_admin)
        self.assert_one_active_site_admin_left()

    def test_concurrent_deactivations_keep_one_site_admin(self):
        first, second = self._race(lambda: _deactivate(self.a, self.b), lambda: _deactivate(self.b, self.a))
        self.assertEqual(first.status_code, 200, first.content[:300])
        self.assertEqual(second.status_code, 403, second.content[:300])
        self.assertTrue(User.objects.get(pk=self.a.pk).is_active)
        self.assertFalse(User.objects.get(pk=self.b.pk).is_active)
        self.assert_one_active_site_admin_left()

    def test_concurrent_patch_and_endpoint_deactivations_keep_one_site_admin(self):
        first, second = self._race(lambda: _patch_deactivate(self.a, self.b), lambda: _deactivate(self.b, self.a))
        self.assertEqual(first.status_code, 200, first.content[:300])
        self.assertEqual(second.status_code, 403, second.content[:300])
        self.assert_one_active_site_admin_left()

    def test_concurrent_demotion_and_deactivation_keep_one_site_admin(self):
        first, second = self._race(lambda: _demote(self.b, self.a), lambda: _patch_deactivate(self.a, self.b))
        self.assertEqual(first.status_code, 200, first.content[:300])
        self.assertEqual(second.status_code, 403, second.content[:300])
        self.assertTrue(User.objects.get(pk=self.b.pk).is_site_admin)
        self.assert_one_active_site_admin_left()


@_PLAIN_STATIC
@skipUnless(connection.vendor == "postgresql", "row locks are only observable on PostgreSQL")
class AdminApiVsDjangoAdminFormTests(_RaceBase):
    """The admin API and the Django admin user form take the same lock set and queue in one order."""

    def setUp(self):
        super().setUp()
        self.root = User.objects.create_superuser(username="race_root", password=PW, email="race_root@example.com")
        self.a = _site_admin("race_form_a")
        self.b = _site_admin("race_form_b")

    def _form_deactivate(self, target):
        client = Client()
        client.force_login(User.objects.get(pk=self.root.pk))
        target = User.objects.get(pk=target.pk)
        return client.post(
            reverse("admin:accounts_user_change", args=[target.pk]), _form_data(target, is_active="")
        )

    def test_api_demotion_waits_for_a_form_deactivation_of_its_caller(self):
        first, second = self._race(lambda: self._form_deactivate(self.a), lambda: _demote(self.a, self.b))
        self.assertEqual(first.status_code, 302, first.content[:300])
        self.assertFalse(User.objects.get(pk=self.a.pk).is_active)
        self.assertEqual(second.status_code, 403, second.content[:300])
        self.assertTrue(User.objects.get(pk=self.b.pk).is_site_admin)

    def test_form_deactivation_waits_for_an_api_demotion(self):
        first, second = self._race(lambda: _demote(self.a, self.b), lambda: self._form_deactivate(self.a))
        self.assertEqual(first.status_code, 200, first.content[:300])
        self.assertEqual(second.status_code, 302, second.content[:300])
        self.assertFalse(User.objects.get(pk=self.b.pk).is_site_admin)
        self.assertFalse(User.objects.get(pk=self.a.pk).is_active)
