"""Tests for GroupInviteLink single-use mode (#689).

Covers:
- GroupInviteLink.status property
- GroupInviteLink.generate() with single_use=True
- GroupInviteLinkSerializer exposes single_use, used_at, status
- GroupInviteLinkCreateSerializer validates single_use field
- invite_links POST creates single-use links and returns status
- invite_links GET returns consumed single-use links (audit visibility)
- JoinGroupView.post() consumes single-use links atomically
- JoinGroupView.post() returns 410 on already-consumed link
- JoinGroupView.get() returns 410 on already-consumed link
- Race condition: only one of two concurrent joins on a single-use link succeeds
"""
import threading

from django.db import connection
from django.test import TestCase, TransactionTestCase
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from groups.models import Group, GroupInviteLink, GroupMembership


def _make_group(owner, name="Group"):
    group = Group.objects.create(name=name, owner=owner)
    GroupMembership.objects.create(group=group, user=owner, role=GroupMembership.Role.ADMIN)
    return group


# ---------------------------------------------------------------------------
# GroupInviteLink.status property
# ---------------------------------------------------------------------------

class GroupInviteLinkStatusTests(TestCase):

    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="pass")
        self.group = _make_group(self.admin)

    def test_status_pending_for_fresh_link(self):
        link, _ = GroupInviteLink.generate(group=self.group, created_by=self.admin)
        self.assertEqual(link.status, "pending")

    def test_status_pending_for_fresh_single_use_link(self):
        link, _ = GroupInviteLink.generate(group=self.group, created_by=self.admin, single_use=True)
        self.assertEqual(link.status, "pending")

    def test_status_used_after_used_at_stamped(self):
        link, _ = GroupInviteLink.generate(group=self.group, created_by=self.admin, single_use=True)
        link.used_at = timezone.now()
        link.save(update_fields=["used_at"])
        self.assertEqual(link.status, "used")

    def test_status_revoked_when_is_active_false(self):
        link, _ = GroupInviteLink.generate(group=self.group, created_by=self.admin)
        link.is_active = False
        link.save(update_fields=["is_active"])
        self.assertEqual(link.status, "revoked")

    def test_status_expired_when_expires_at_in_past(self):
        from datetime import timedelta
        link, _ = GroupInviteLink.generate(
            group=self.group,
            created_by=self.admin,
            expires_at=timezone.now() - timedelta(seconds=1),
        )
        self.assertEqual(link.status, "expired")

    def test_revoked_takes_precedence_over_expired(self):
        """A revoked link reports 'revoked' even if it is also expired."""
        from datetime import timedelta
        link, _ = GroupInviteLink.generate(
            group=self.group,
            created_by=self.admin,
            expires_at=timezone.now() - timedelta(seconds=1),
        )
        link.is_active = False
        link.save(update_fields=["is_active"])
        self.assertEqual(link.status, "revoked")

    def test_used_takes_precedence_over_expired(self):
        """A used single-use link reports 'used' even if its expiry has also passed."""
        from datetime import timedelta
        link, _ = GroupInviteLink.generate(
            group=self.group,
            created_by=self.admin,
            single_use=True,
            expires_at=timezone.now() - timedelta(seconds=1),
        )
        link.used_at = timezone.now()
        link.save(update_fields=["used_at"])
        self.assertEqual(link.status, "used")


# ---------------------------------------------------------------------------
# GroupInviteLinkSerializer — new fields exposed
# ---------------------------------------------------------------------------

class GroupInviteLinkSerializerFieldTests(TestCase):

    def test_serializer_exposes_single_use(self):
        from groups.serializers import GroupInviteLinkSerializer
        self.assertIn("single_use", GroupInviteLinkSerializer.Meta.fields)

    def test_serializer_exposes_used_at(self):
        from groups.serializers import GroupInviteLinkSerializer
        self.assertIn("used_at", GroupInviteLinkSerializer.Meta.fields)

    def test_serializer_exposes_status(self):
        from groups.serializers import GroupInviteLinkSerializer
        self.assertIn("status", GroupInviteLinkSerializer.Meta.fields)

    def test_serializer_does_not_expose_token_hash(self):
        from groups.serializers import GroupInviteLinkSerializer
        self.assertNotIn("token_hash", GroupInviteLinkSerializer.Meta.fields)

    def test_serializer_used_at_is_read_only(self):
        from groups.serializers import GroupInviteLinkSerializer
        self.assertIn("used_at", GroupInviteLinkSerializer.Meta.read_only_fields)

    def test_serializer_status_is_read_only(self):
        from groups.serializers import GroupInviteLinkSerializer
        self.assertIn("status", GroupInviteLinkSerializer.Meta.read_only_fields)


# ---------------------------------------------------------------------------
# GroupInviteLinkCreateSerializer — input validation
# ---------------------------------------------------------------------------

class GroupInviteLinkCreateSerializerTests(TestCase):

    def _make(self, data):
        from groups.serializers import GroupInviteLinkCreateSerializer
        s = GroupInviteLinkCreateSerializer(data=data)
        return s

    def test_defaults_to_single_use_false(self):
        s = self._make({"role": "member"})
        self.assertTrue(s.is_valid(), s.errors)
        self.assertFalse(s.validated_data["single_use"])

    def test_accepts_single_use_true(self):
        s = self._make({"single_use": True})
        self.assertTrue(s.is_valid(), s.errors)
        self.assertTrue(s.validated_data["single_use"])

    def test_rejects_invalid_role(self):
        s = self._make({"role": "superuser"})
        self.assertFalse(s.is_valid())
        self.assertIn("role", s.errors)

    def test_empty_payload_uses_all_defaults(self):
        s = self._make({})
        self.assertTrue(s.is_valid(), s.errors)
        self.assertEqual(s.validated_data["role"], GroupInviteLink.Role.MEMBER)
        self.assertFalse(s.validated_data["single_use"])
        self.assertIsNone(s.validated_data["expiry_days"])


# ---------------------------------------------------------------------------
# invite_links POST — create single-use link
# ---------------------------------------------------------------------------

class InviteLinkCreateSingleUseTests(TestCase):

    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="pass")
        self.group = _make_group(self.admin)
        self.client = APIClient()
        self.client.force_authenticate(self.admin)
        self.url = f"/api/v1/groups/{self.group.id}/invite-links/"

    def test_create_single_use_link_returns_201(self):
        r = self.client.post(self.url, {"single_use": True})
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)

    def test_created_link_has_single_use_true(self):
        r = self.client.post(self.url, {"single_use": True})
        self.assertTrue(r.json()["single_use"])

    def test_created_link_has_status_pending(self):
        r = self.client.post(self.url, {"single_use": True})
        self.assertEqual(r.json()["status"], "pending")

    def test_created_link_used_at_is_null(self):
        r = self.client.post(self.url, {"single_use": True})
        self.assertIsNone(r.json()["used_at"])

    def test_create_multi_use_link_has_single_use_false(self):
        r = self.client.post(self.url, {})
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertFalse(r.json()["single_use"])

    def test_create_link_invalid_role_returns_400(self):
        r = self.client.post(self.url, {"role": "superuser"})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("role", r.json())


# ---------------------------------------------------------------------------
# invite_links GET — consumed links remain visible
# ---------------------------------------------------------------------------

class InviteLinkListConsumedVisibilityTests(TestCase):

    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="pass")
        self.group = _make_group(self.admin)
        self.client = APIClient()
        self.client.force_authenticate(self.admin)
        self.url = f"/api/v1/groups/{self.group.id}/invite-links/"

    def test_consumed_single_use_link_appears_in_list(self):
        link, _ = GroupInviteLink.generate(
            group=self.group, created_by=self.admin, single_use=True
        )
        link.used_at = timezone.now()
        link.save(update_fields=["used_at"])

        r = self.client.get(self.url)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        ids = [lnk["id"] for lnk in r.json()]
        self.assertIn(link.id, ids)

    def test_consumed_link_has_status_used_in_list(self):
        link, _ = GroupInviteLink.generate(
            group=self.group, created_by=self.admin, single_use=True
        )
        link.used_at = timezone.now()
        link.save(update_fields=["used_at"])

        r = self.client.get(self.url)
        link_data = next(lnk for lnk in r.json() if lnk["id"] == link.id)
        self.assertEqual(link_data["status"], "used")

    def test_revoked_link_does_not_appear_in_list(self):
        """Revoked links are is_active=False and have no used_at — they are excluded."""
        link, _ = GroupInviteLink.generate(group=self.group, created_by=self.admin)
        link.is_active = False
        link.save(update_fields=["is_active"])

        r = self.client.get(self.url)
        ids = [lnk["id"] for lnk in r.json()]
        self.assertNotIn(link.id, ids)

    # ------------------------------------------------------------------
    # revoke_invite_link — guard against revoking consumed links (#751)
    # ------------------------------------------------------------------

    def test_revoke_consumed_single_use_link_returns_400(self):
        """Revoking a consumed single-use link must return 400.

        After a single-use link is consumed (used_at IS NOT NULL, is_active
        still True), calling DELETE on it must be rejected. If we allowed the
        revoke, is_active would flip to False while used_at is also set,
        making status() return "revoked" instead of "used" and silently
        dropping the consumption record from the admin audit list.
        """
        link, _ = GroupInviteLink.generate(
            group=self.group, created_by=self.admin, single_use=True
        )
        link.used_at = timezone.now()
        link.save(update_fields=["used_at"])

        revoke_url = f"/api/v1/groups/{self.group.id}/invite-links/{link.id}/"
        r = self.client.delete(revoke_url)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("consumed", r.json()["detail"])

    def test_revoke_consumed_link_preserves_status_as_used(self):
        """After a rejected revoke attempt the link still reports status 'used'."""
        link, _ = GroupInviteLink.generate(
            group=self.group, created_by=self.admin, single_use=True
        )
        link.used_at = timezone.now()
        link.save(update_fields=["used_at"])

        revoke_url = f"/api/v1/groups/{self.group.id}/invite-links/{link.id}/"
        self.client.delete(revoke_url)  # rejected

        link.refresh_from_db()
        self.assertTrue(link.is_active)
        self.assertEqual(link.status, "used")

    def test_revoke_unconsumed_single_use_link_succeeds(self):
        """A single-use link that has not been consumed may still be revoked."""
        link, _ = GroupInviteLink.generate(
            group=self.group, created_by=self.admin, single_use=True
        )
        revoke_url = f"/api/v1/groups/{self.group.id}/invite-links/{link.id}/"
        r = self.client.delete(revoke_url)
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        link.refresh_from_db()
        self.assertFalse(link.is_active)

    def test_active_multi_use_link_appears_in_list(self):
        link, _ = GroupInviteLink.generate(group=self.group, created_by=self.admin)
        r = self.client.get(self.url)
        ids = [lnk["id"] for lnk in r.json()]
        self.assertIn(link.id, ids)


# ---------------------------------------------------------------------------
# JoinGroupView — single-use link consumption
# ---------------------------------------------------------------------------

class JoinGroupSingleUseTests(TestCase):

    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="pass")
        self.group = _make_group(self.admin)
        self.joiner = User.objects.create_user(username="joiner", password="pass")
        self.client = APIClient()
        self.client.force_authenticate(self.joiner)

    def _join_url(self, raw_token):
        return f"/api/v1/groups/join/{raw_token}/"

    def test_single_use_join_succeeds_first_time(self):
        _, raw = GroupInviteLink.generate(
            group=self.group, created_by=self.admin, single_use=True
        )
        r = self.client.post(self._join_url(raw))
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)

    def test_single_use_link_stamped_used_at_after_join(self):
        link, raw = GroupInviteLink.generate(
            group=self.group, created_by=self.admin, single_use=True
        )
        self.client.post(self._join_url(raw))
        link.refresh_from_db()
        self.assertIsNotNone(link.used_at)

    def test_single_use_join_returns_410_on_second_attempt(self):
        link, raw = GroupInviteLink.generate(
            group=self.group, created_by=self.admin, single_use=True
        )
        # First join by joiner succeeds
        self.client.post(self._join_url(raw))
        # Second attempt (different user) should get 410
        second_user = User.objects.create_user(username="second", password="pass")
        second_client = APIClient()
        second_client.force_authenticate(second_user)
        r = second_client.post(self._join_url(raw))
        self.assertEqual(r.status_code, status.HTTP_410_GONE)
        self.assertIn("already been used", r.json()["detail"])

    def test_get_on_consumed_link_returns_410(self):
        link, raw = GroupInviteLink.generate(
            group=self.group, created_by=self.admin, single_use=True
        )
        link.used_at = timezone.now()
        link.save(update_fields=["used_at"])

        public_client = APIClient()
        r = public_client.get(self._join_url(raw))
        self.assertEqual(r.status_code, status.HTTP_410_GONE)
        self.assertIn("already been used", r.json()["detail"])

    def test_multi_use_link_is_not_consumed_after_join(self):
        link, raw = GroupInviteLink.generate(
            group=self.group, created_by=self.admin, single_use=False
        )
        self.client.post(self._join_url(raw))
        link.refresh_from_db()
        self.assertIsNone(link.used_at)

    def test_multi_use_link_allows_second_user(self):
        _, raw = GroupInviteLink.generate(
            group=self.group, created_by=self.admin, single_use=False
        )
        self.client.post(self._join_url(raw))
        second = User.objects.create_user(username="second", password="pass")
        second_client = APIClient()
        second_client.force_authenticate(second)
        r = second_client.post(self._join_url(raw))
        self.assertIn(r.status_code, [status.HTTP_200_OK, status.HTTP_201_CREATED])

    def test_join_on_consumed_link_does_not_create_additional_membership(self):
        link, raw = GroupInviteLink.generate(
            group=self.group, created_by=self.admin, single_use=True
        )
        self.client.post(self._join_url(raw))
        second = User.objects.create_user(username="second", password="pass")
        second_client = APIClient()
        second_client.force_authenticate(second)
        second_client.post(self._join_url(raw))
        # second user must NOT be a member
        self.assertFalse(
            GroupMembership.objects.filter(group=self.group, user=second).exists()
        )


# ---------------------------------------------------------------------------
# JoinGroupView — race condition (single-use, concurrent requests)
# ---------------------------------------------------------------------------

class JoinGroupSingleUseRaceConditionTests(TransactionTestCase):
    """Only one of two concurrent join requests on a single-use link may succeed.

    Must use TransactionTestCase (not TestCase) because TestCase wraps each test
    in a savepoint that is invisible to threads started inside the test; the
    select_for_update() lock would deadlock or see an empty database.
    """

    def setUp(self):
        if connection.vendor == "sqlite":
            self.skipTest(
                "SQLite does not support concurrent writes or SELECT FOR UPDATE; "
                "this test requires PostgreSQL."
            )
        self.admin = User.objects.create_user(username="race_admin", password="pass")
        self.group = _make_group(self.admin, name="RaceGroup")

    def test_only_one_of_two_concurrent_joins_succeeds(self):
        link, raw = GroupInviteLink.generate(
            group=self.group, created_by=self.admin, single_use=True
        )
        u1 = User.objects.create_user(username="race_u1", password="pass")
        u2 = User.objects.create_user(username="race_u2", password="pass")

        results = []
        barrier = threading.Barrier(2)

        def attempt(user):
            client = APIClient()
            client.force_authenticate(user)
            barrier.wait()  # Both threads attempt the join simultaneously.
            r = client.post(f"/api/v1/groups/join/{raw}/")
            results.append(r.status_code)
            # Release thread-local DB connection. Without this,
            # TransactionTestCase.teardown_databases() fails with
            # "database is being accessed by other users" on DROP.
            from django.db import connections as _conns
            _conns.close_all()

        t1 = threading.Thread(target=attempt, args=(u1,))
        t2 = threading.Thread(target=attempt, args=(u2,))
        t1.start()
        t2.start()
        t1.join()
        t2.join()

        success_count = sum(1 for s in results if s == status.HTTP_201_CREATED)
        self.assertEqual(success_count, 1, f"Expected exactly 1 success, got: {results}")

        link.refresh_from_db()
        self.assertIsNotNone(link.used_at)

        # Exactly one membership was created.
        member_count = GroupMembership.objects.filter(
            group=self.group, user__in=[u1, u2]
        ).count()
        self.assertEqual(member_count, 1)
