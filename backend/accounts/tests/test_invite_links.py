"""Tests for InviteLink model, AdminInviteLinkListCreateView,
AdminInviteLinkRevokeView, and InviteRegisterView."""
import hashlib
import io
import threading
from datetime import timedelta

from django.db import connection
from django.test import TestCase, TransactionTestCase
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import InviteLink, MAX_ACTIVE_INVITE_LINKS, SiteSetting, User


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def make_admin(**kwargs):
    kwargs.setdefault("username", "admin")
    kwargs.setdefault("password", "adminpass123!")
    u = User.objects.create_user(**kwargs)
    u.is_site_admin = True
    u.save(update_fields=["is_site_admin"])
    return u


def make_user(**kwargs):
    kwargs.setdefault("password", "userpass123!")
    return User.objects.create_user(**kwargs)


def set_invite_only():
    s = SiteSetting.get()
    s.registration_mode = SiteSetting.RegistrationMode.INVITE_ONLY
    s.save()


def set_open():
    s = SiteSetting.get()
    s.registration_mode = SiteSetting.RegistrationMode.OPEN
    s.save()


# ---------------------------------------------------------------------------
# InviteLink.generate()
# ---------------------------------------------------------------------------

class InviteLinkGenerateTests(TestCase):
    def setUp(self):
        self.creator = make_user(username="creator")

    def test_returns_instance_and_raw_token(self):
        instance, raw = InviteLink.generate(created_by=self.creator)
        self.assertIsInstance(instance, InviteLink)
        self.assertIsNotNone(instance.pk)
        self.assertTrue(raw.startswith("vbnl_"))

    def test_raw_token_hashes_to_stored_hash(self):
        instance, raw = InviteLink.generate(created_by=self.creator)
        expected_hash = hashlib.sha256(raw.encode()).hexdigest()
        self.assertEqual(instance.token_hash, expected_hash)

    def test_prefix_matches_raw_token_prefix(self):
        instance, raw = InviteLink.generate(created_by=self.creator)
        self.assertEqual(instance.prefix, raw[:8])

    def test_expires_at_stored_when_provided(self):
        future = timezone.now() + timedelta(days=7)
        instance, _ = InviteLink.generate(created_by=self.creator, expires_at=future)
        self.assertIsNotNone(instance.expires_at)
        # Allow a one-second margin for slow test runners.
        self.assertAlmostEqual(
            instance.expires_at.timestamp(),
            future.timestamp(),
            delta=1,
        )

    def test_expires_at_null_by_default(self):
        instance, _ = InviteLink.generate(created_by=self.creator)
        self.assertIsNone(instance.expires_at)

    def test_single_use_stored(self):
        instance, _ = InviteLink.generate(created_by=self.creator, single_use=True)
        self.assertTrue(instance.single_use)

    def test_not_single_use_by_default(self):
        instance, _ = InviteLink.generate(created_by=self.creator)
        self.assertFalse(instance.single_use)

    def test_each_call_produces_unique_token(self):
        _, raw1 = InviteLink.generate(created_by=self.creator)
        _, raw2 = InviteLink.generate(created_by=self.creator)
        self.assertNotEqual(raw1, raw2)


# ---------------------------------------------------------------------------
# InviteLink.status and InviteLink.is_valid
# ---------------------------------------------------------------------------

class InviteLinkStatusTests(TestCase):
    def setUp(self):
        self.creator = make_user(username="status_creator")

    def _make_link(self, **kwargs):
        instance, _ = InviteLink.generate(created_by=self.creator)
        for attr, val in kwargs.items():
            setattr(instance, attr, val)
        instance.save()
        return instance

    def test_status_pending_for_fresh_link(self):
        link = self._make_link()
        self.assertEqual(link.status, "pending")

    def test_status_used_when_used_at_set(self):
        link = self._make_link(used_at=timezone.now())
        self.assertEqual(link.status, "used")

    def test_status_revoked_takes_precedence_over_used(self):
        # revoked_at is evaluated before used_at in the property.
        link = self._make_link(revoked_at=timezone.now(), used_at=timezone.now())
        self.assertEqual(link.status, "revoked")

    def test_status_expired_when_expires_at_in_past(self):
        link = self._make_link(expires_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(link.status, "expired")

    def test_status_pending_when_expires_at_in_future(self):
        link = self._make_link(expires_at=timezone.now() + timedelta(days=1))
        self.assertEqual(link.status, "pending")

    def test_status_revoked_when_revoked_at_set(self):
        link = self._make_link(revoked_at=timezone.now())
        self.assertEqual(link.status, "revoked")

    def test_is_valid_true_for_pending_link(self):
        link = self._make_link()
        self.assertTrue(link.is_valid)

    def test_is_valid_false_for_used_link(self):
        link = self._make_link(used_at=timezone.now())
        self.assertFalse(link.is_valid)

    def test_is_valid_false_for_revoked_link(self):
        link = self._make_link(revoked_at=timezone.now())
        self.assertFalse(link.is_valid)

    def test_is_valid_false_for_expired_link(self):
        link = self._make_link(expires_at=timezone.now() - timedelta(seconds=1))
        self.assertFalse(link.is_valid)


# ---------------------------------------------------------------------------
# AdminInviteLinkListCreateView — GET
# ---------------------------------------------------------------------------

class AdminInviteLinkListTests(TestCase):
    def setUp(self):
        self.admin = make_admin()
        self.other = make_user(username="other_list")
        self.client = APIClient()
        self.client.force_authenticate(self.admin)
        InviteLink.generate(created_by=self.admin)
        InviteLink.generate(created_by=self.admin)

    def test_returns_200_with_list(self):
        r = self.client.get("/api/v1/admin/invite-links/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIsInstance(r.json(), list)
        self.assertEqual(len(r.json()), 2)

    def test_response_shape_excludes_raw_token(self):
        r = self.client.get("/api/v1/admin/invite-links/")
        item = r.json()[0]
        self.assertIn("id", item)
        self.assertIn("prefix", item)
        self.assertIn("status", item)
        self.assertIn("expires_at", item)
        self.assertIn("single_use", item)
        self.assertNotIn("raw_token", item)

    def test_response_includes_use_count(self):
        r = self.client.get("/api/v1/admin/invite-links/")
        item = r.json()[0]
        self.assertIn("use_count", item)
        self.assertEqual(item["use_count"], 0)

    def test_created_by_username_present(self):
        r = self.client.get("/api/v1/admin/invite-links/")
        item = r.json()[0]
        self.assertEqual(item["created_by_username"], self.admin.username)

    def test_non_admin_rejected(self):
        self.client.force_authenticate(self.other)
        r = self.client.get("/api/v1/admin/invite-links/")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_unauthenticated_rejected(self):
        self.client.force_authenticate(None)
        r = self.client.get("/api/v1/admin/invite-links/")
        self.assertIn(r.status_code, [status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN])


# ---------------------------------------------------------------------------
# AdminInviteLinkListCreateView — POST
# ---------------------------------------------------------------------------

class AdminInviteLinkCreateTests(TestCase):
    def setUp(self):
        self.admin = make_admin()
        self.other = make_user(username="other_create")
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def test_create_with_no_expiry_returns_201(self):
        r = self.client.post("/api/v1/admin/invite-links/", {})
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)

    def test_response_includes_raw_token(self):
        r = self.client.post("/api/v1/admin/invite-links/", {})
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        data = r.json()
        self.assertIn("raw_token", data)
        self.assertTrue(data["raw_token"].startswith("vbnl_"))

    def test_raw_token_absent_on_subsequent_list(self):
        self.client.post("/api/v1/admin/invite-links/", {})
        r = self.client.get("/api/v1/admin/invite-links/")
        for item in r.json():
            self.assertNotIn("raw_token", item)

    def test_create_with_valid_expires_in_days_1(self):
        r = self.client.post("/api/v1/admin/invite-links/", {"expires_in_days": 1})
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertIsNotNone(r.json()["expires_at"])

    def test_create_with_valid_expires_in_days_7(self):
        r = self.client.post("/api/v1/admin/invite-links/", {"expires_in_days": 7})
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)

    def test_create_with_valid_expires_in_days_30(self):
        r = self.client.post("/api/v1/admin/invite-links/", {"expires_in_days": 30})
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)

    def test_create_with_null_expires_in_days(self):
        # Must use format='json' — multipart encoding cannot serialize None.
        r = self.client.post("/api/v1/admin/invite-links/", {"expires_in_days": None}, format="json")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertIsNone(r.json()["expires_at"])

    def test_invalid_expires_in_days_rejected(self):
        r = self.client.post("/api/v1/admin/invite-links/", {"expires_in_days": 5})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_invalid_expires_in_days_0_rejected(self):
        r = self.client.post("/api/v1/admin/invite-links/", {"expires_in_days": 0})
        # 0 is not None and not in VALID_TTL_DAYS (1, 7, 30) so the validator
        # raises a ValidationError → 400. A zero-day TTL is meaningless.
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_create_single_use_link(self):
        r = self.client.post("/api/v1/admin/invite-links/", {"single_use": True})
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertTrue(r.json()["single_use"])

    def test_max_active_links_limit_enforced(self):
        # Fill up to the cap with pre-existing objects directly to avoid 50
        # HTTP calls in this test.
        creator = self.admin
        for i in range(MAX_ACTIVE_INVITE_LINKS):
            InviteLink.generate(created_by=creator)

        r = self.client.post("/api/v1/admin/invite-links/", {})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn(str(MAX_ACTIVE_INVITE_LINKS), r.json()["detail"])

    def test_expired_links_do_not_count_toward_cap(self):
        # Create MAX_ACTIVE_INVITE_LINKS links, all already expired.
        for i in range(MAX_ACTIVE_INVITE_LINKS):
            link, _ = InviteLink.generate(
                created_by=self.admin,
                expires_at=timezone.now() - timedelta(days=1),
            )

        # A new link should be created successfully because expired links are excluded.
        r = self.client.post("/api/v1/admin/invite-links/", {})
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)

    def test_non_admin_rejected(self):
        self.client.force_authenticate(self.other)
        r = self.client.post("/api/v1/admin/invite-links/", {})
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)


# ---------------------------------------------------------------------------
# AdminInviteLinkRevokeView — DELETE
# ---------------------------------------------------------------------------

class AdminInviteLinkRevokeTests(TestCase):
    def setUp(self):
        self.admin = make_admin()
        self.other = make_user(username="other_revoke")
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def _make_link(self, **kwargs):
        instance, _ = InviteLink.generate(created_by=self.admin)
        if kwargs:
            for attr, val in kwargs.items():
                setattr(instance, attr, val)
            instance.save()
        return instance

    def test_revoke_pending_link_returns_200(self):
        link = self._make_link()
        r = self.client.delete(f"/api/v1/admin/invite-links/{link.pk}/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_revoke_stamps_revoked_at(self):
        link = self._make_link()
        self.client.delete(f"/api/v1/admin/invite-links/{link.pk}/")
        link.refresh_from_db()
        self.assertIsNotNone(link.revoked_at)

    def test_revoke_response_status_is_revoked(self):
        link = self._make_link()
        r = self.client.delete(f"/api/v1/admin/invite-links/{link.pk}/")
        self.assertEqual(r.json()["status"], "revoked")

    def test_revoke_already_revoked_returns_400(self):
        link = self._make_link(revoked_at=timezone.now())
        r = self.client.delete(f"/api/v1/admin/invite-links/{link.pk}/")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_revoke_already_used_returns_400(self):
        link = self._make_link(used_at=timezone.now())
        r = self.client.delete(f"/api/v1/admin/invite-links/{link.pk}/")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_revoke_nonexistent_returns_404(self):
        r = self.client.delete("/api/v1/admin/invite-links/99999/")
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)

    def test_revoke_preserves_use_count(self):
        # Audit trail: revocation must not erase how many registrations already
        # succeeded through the link.
        link = self._make_link(use_count=5)
        r = self.client.delete(f"/api/v1/admin/invite-links/{link.pk}/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        link.refresh_from_db()
        self.assertEqual(link.use_count, 5)

    def test_non_admin_rejected(self):
        link = self._make_link()
        self.client.force_authenticate(self.other)
        r = self.client.delete(f"/api/v1/admin/invite-links/{link.pk}/")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)


# ---------------------------------------------------------------------------
# InviteRegisterView — OPEN mode
# ---------------------------------------------------------------------------

class InviteRegisterOpenModeTests(TestCase):
    """In OPEN mode the endpoint behaves identically to the standard RegisterView."""

    def setUp(self):
        set_open()
        self.client = APIClient()

    def test_registration_succeeds_without_invite_token(self):
        r = self.client.post("/api/v1/auth/registration/", {
            "email": "open@example.com",
            "password1": "Sup3rS3cr3t!xyz",
            "password2": "Sup3rS3cr3t!xyz",
        })
        self.assertIn(r.status_code, [status.HTTP_201_CREATED, status.HTTP_204_NO_CONTENT])
        self.assertTrue(User.objects.filter(email="open@example.com").exists())

    def test_extra_invite_token_field_is_ignored(self):
        r = self.client.post("/api/v1/auth/registration/", {
            "email": "open2@example.com",
            "password1": "Sup3rS3cr3t!xyz",
            "password2": "Sup3rS3cr3t!xyz",
            "invite_token": "completely_bogus_value",
        })
        self.assertIn(r.status_code, [status.HTTP_201_CREATED, status.HTTP_204_NO_CONTENT])


# ---------------------------------------------------------------------------
# InviteRegisterView — INVITE_ONLY mode
# ---------------------------------------------------------------------------

class InviteRegisterInviteOnlyTests(TestCase):
    def setUp(self):
        set_invite_only()
        self.creator = make_admin(username="invite_admin")
        self.client = APIClient()

    def tearDown(self):
        # Restore open mode so subsequent test isolation is clean.
        set_open()

    def _make_link(self, **kwargs):
        instance, raw = InviteLink.generate(created_by=self.creator, **kwargs)
        return instance, raw

    def _register(self, email, invite_token=None, password="Sup3rS3cr3t!xyz"):
        payload = {
            "email": email,
            "password1": password,
            "password2": password,
        }
        if invite_token is not None:
            payload["invite_token"] = invite_token
        return self.client.post("/api/v1/auth/registration/", payload)

    # --- missing token ---

    def test_missing_invite_token_returns_400(self):
        r = self._register("missing@example.com")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("invite_token", r.json())

    def test_no_user_created_when_token_missing(self):
        self._register("missing2@example.com")
        self.assertFalse(User.objects.filter(email="missing2@example.com").exists())

    # --- invalid / nonexistent token ---

    def test_invalid_token_returns_400(self):
        r = self._register("invalid@example.com", invite_token="vbnl_notarealtoken")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("invite_token", r.json())

    def test_no_user_created_when_token_invalid(self):
        self._register("invalid2@example.com", invite_token="vbnl_notarealtoken")
        self.assertFalse(User.objects.filter(email="invalid2@example.com").exists())

    # --- expired token ---

    def test_expired_token_returns_400(self):
        _, raw = self._make_link(expires_at=timezone.now() - timedelta(seconds=1))
        r = self._register("expired@example.com", invite_token=raw)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("invite_token", r.json())

    def test_no_user_created_when_token_expired(self):
        _, raw = self._make_link(expires_at=timezone.now() - timedelta(seconds=1))
        self._register("expired2@example.com", invite_token=raw)
        self.assertFalse(User.objects.filter(email="expired2@example.com").exists())

    # --- revoked token ---

    def test_revoked_token_returns_400(self):
        link, raw = self._make_link()
        link.revoked_at = timezone.now()
        link.save(update_fields=["revoked_at"])
        r = self._register("revoked@example.com", invite_token=raw)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_no_user_created_when_token_revoked(self):
        link, raw = self._make_link()
        link.revoked_at = timezone.now()
        link.save(update_fields=["revoked_at"])
        self._register("revoked2@example.com", invite_token=raw)
        self.assertFalse(User.objects.filter(email="revoked2@example.com").exists())

    # --- single-use: happy path ---

    def test_valid_single_use_token_allows_registration(self):
        _, raw = self._make_link(single_use=True)
        r = self._register("singleuse@example.com", invite_token=raw)
        self.assertIn(r.status_code, [status.HTTP_201_CREATED, status.HTTP_204_NO_CONTENT])
        self.assertTrue(User.objects.filter(email="singleuse@example.com").exists())

    def test_single_use_token_stamped_used_after_registration(self):
        link, raw = self._make_link(single_use=True)
        self._register("singleuse2@example.com", invite_token=raw)
        link.refresh_from_db()
        self.assertIsNotNone(link.used_at)

    # --- single-use: failed registration leaves token unconsumed ---

    def test_single_use_token_not_consumed_on_registration_failure(self):
        # Use a password-mismatch failure (password1 ≠ password2) to trigger a
        # reliable 400 from dj_rest_auth's serializer validation. Duplicate-email
        # failures are not suitable here: allauth 65+ auto-logs-in on duplicate
        # email (returns 200/204), meaning the token would be consumed.
        link, raw = self._make_link(single_use=True)
        r = self.client.post("/api/v1/auth/registration/", {
            "email": "pwmismatch@example.com",
            "password1": "Sup3rS3cr3t!xyz",
            "password2": "D1fferentP@ss!",
            "invite_token": raw,
        })
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        link.refresh_from_db()
        self.assertIsNone(link.used_at)

    # --- multi-use: token NOT stamped after registration ---

    def test_multi_use_token_not_stamped_after_registration(self):
        link, raw = self._make_link(single_use=False)
        self._register("multiuse@example.com", invite_token=raw)
        link.refresh_from_db()
        self.assertIsNone(link.used_at)

    def test_multi_use_token_reusable_for_second_registration(self):
        _, raw = self._make_link(single_use=False)
        r1 = self._register("multi1@example.com", invite_token=raw)
        r2 = self._register("multi2@example.com", invite_token=raw)
        self.assertIn(r1.status_code, [status.HTTP_201_CREATED, status.HTTP_204_NO_CONTENT])
        self.assertIn(r2.status_code, [status.HTTP_201_CREATED, status.HTTP_204_NO_CONTENT])

    def test_multi_use_token_bumps_use_count_each_registration(self):
        link, raw = self._make_link(single_use=False)
        self.assertEqual(link.use_count, 0)
        self._register("ucount1@example.com", invite_token=raw)
        self._register("ucount2@example.com", invite_token=raw)
        link.refresh_from_db()
        self.assertEqual(link.use_count, 2)

    def test_single_use_token_sets_use_count_to_one(self):
        link, raw = self._make_link(single_use=True)
        self._register("ucsingle@example.com", invite_token=raw)
        link.refresh_from_db()
        self.assertEqual(link.use_count, 1)

    def test_failed_registration_does_not_bump_use_count(self):
        # use_count is only incremented after a 2xx response from the inner
        # RegisterView.create; a 400 (e.g. password mismatch) must leave the
        # counter unchanged.
        link, raw = self._make_link(single_use=False)
        r = self.client.post("/api/v1/auth/registration/", {
            "email": "ucfail@example.com",
            "password1": "Sup3rS3cr3t!xyz",
            "password2": "D1fferentP@ss!",
            "invite_token": raw,
        })
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        link.refresh_from_db()
        self.assertEqual(link.use_count, 0)

    # --- valid non-expiring token ---

    def test_valid_token_no_expiry_allows_registration(self):
        _, raw = self._make_link()
        r = self._register("noexpiry@example.com", invite_token=raw)
        self.assertIn(r.status_code, [status.HTTP_201_CREATED, status.HTTP_204_NO_CONTENT])

    def test_valid_token_future_expiry_allows_registration(self):
        _, raw = self._make_link(expires_at=timezone.now() + timedelta(days=7))
        r = self._register("futureexp@example.com", invite_token=raw)
        self.assertIn(r.status_code, [status.HTTP_201_CREATED, status.HTTP_204_NO_CONTENT])

    # --- multi-use: per-email dedup (#925) ---

    def test_multi_use_token_rejects_repeat_redemption_from_same_email(self):
        """The same email cannot redeem a multi-use invite link twice (#925)."""
        from accounts.models import InviteLinkRedemption

        _, raw = self._make_link(single_use=False)
        # First redemption succeeds; allauth blocks a second user with the same
        # email anyway (ACCOUNT_UNIQUE_EMAIL=True), so the regression path is
        # exercised by attempting the same redemption from a fresh registration
        # bypass: after the first user is created, manually simulate a second
        # call to consume_invite_token with the same email and confirm the
        # InviteTokenError fires.
        from accounts.invite_utils import (
            InviteTokenError,
            consume_invite_token,
            validate_invite_token,
        )
        from django.db import transaction

        r1 = self._register("dedup@example.com", invite_token=raw)
        self.assertIn(r1.status_code, [status.HTTP_201_CREATED, status.HTTP_204_NO_CONTENT])
        self.assertEqual(
            InviteLinkRedemption.objects.count(), 1,
            "First multi-use redemption must write a redemption row",
        )

        with self.assertRaises(InviteTokenError) as ctx, transaction.atomic():
            link = validate_invite_token(raw)
            consume_invite_token(link, email="dedup@example.com")
        self.assertEqual(ctx.exception.code, "invite_already_redeemed")

    def test_multi_use_token_dedup_is_case_insensitive(self):
        """Email dedup must canonicalise (lowercase + strip) so case variants
        of the same address are treated as one (#925)."""
        from accounts.invite_utils import (
            InviteTokenError,
            consume_invite_token,
            validate_invite_token,
        )
        from django.db import transaction

        _, raw = self._make_link(single_use=False)
        with transaction.atomic():
            link = validate_invite_token(raw)
            consume_invite_token(link, email="Mixed@Example.COM")

        with self.assertRaises(InviteTokenError) as ctx, transaction.atomic():
            link = validate_invite_token(raw)
            consume_invite_token(link, email="  mixed@example.com  ")
        self.assertEqual(ctx.exception.code, "invite_already_redeemed")

    def test_multi_use_token_allows_distinct_emails(self):
        """Different emails must each be allowed to redeem the same link
        once — dedup is per (link, email_hash), not per link (#925)."""
        from accounts.invite_utils import consume_invite_token, validate_invite_token
        from django.db import transaction

        _, raw = self._make_link(single_use=False)
        with transaction.atomic():
            link = validate_invite_token(raw)
            consume_invite_token(link, email="alice@example.com")
        with transaction.atomic():
            link = validate_invite_token(raw)
            consume_invite_token(link, email="bob@example.com")

        from accounts.models import InviteLinkRedemption
        self.assertEqual(InviteLinkRedemption.objects.count(), 2)

    def test_single_use_link_does_not_write_redemption_row(self):
        """Single-use links remain gated by used_at; no redemption row is
        written so the InviteLinkRedemption table only tracks multi-use
        redemptions (#925)."""
        from accounts.invite_utils import consume_invite_token, validate_invite_token
        from accounts.models import InviteLinkRedemption
        from django.db import transaction

        _, raw = self._make_link(single_use=True)
        with transaction.atomic():
            link = validate_invite_token(raw)
            consume_invite_token(link, email="single@example.com")
        self.assertEqual(InviteLinkRedemption.objects.count(), 0)


# ---------------------------------------------------------------------------
# InviteRegisterView — race condition (single-use token, concurrent requests)
# ---------------------------------------------------------------------------

class InviteRegisterRaceConditionTests(TransactionTestCase):
    """Only one of two concurrent requests sharing a single-use token may succeed.

    Must use TransactionTestCase (not TestCase) because TestCase wraps each test
    in a transaction that is invisible to other threads; threads would see an
    empty database and the race-condition logic could never be exercised.
    """

    def setUp(self):
        if connection.vendor == "sqlite":
            self.skipTest(
                "SQLite does not support concurrent writes or SELECT FOR UPDATE; "
                "this test requires PostgreSQL."
            )
        set_invite_only()
        self.creator = make_admin(username="race_admin")

    def tearDown(self):
        set_open()

    def test_only_one_of_two_concurrent_registrations_succeeds(self):
        link, raw = InviteLink.generate(created_by=self.creator, single_use=True)

        results = []
        barrier = threading.Barrier(2)

        def attempt(email):
            # Each thread gets its own client; APIClient is not thread-safe.
            client = APIClient()
            barrier.wait()  # Both threads start their POST at the same time.
            r = client.post("/api/v1/auth/registration/", {
                "email": email,
                "password1": "Sup3rS3cr3t!xyz",
                "password2": "Sup3rS3cr3t!xyz",
                "invite_token": raw,
            })
            results.append(r.status_code)
            # Explicitly close thread-local DB connections. Each thread that
            # touches the ORM opens its own PostgreSQL connection. Without this,
            # those connections remain open after the thread exits and
            # TransactionTestCase.teardown_databases() fails with
            # "database is being accessed by other users" when it tries to
            # DROP the test database.
            from django.db import connections as _conns
            _conns.close_all()

        t1 = threading.Thread(target=attempt, args=("race1@example.com",))
        t2 = threading.Thread(target=attempt, args=("race2@example.com",))
        t1.start()
        t2.start()
        t1.join()
        t2.join()

        success_count = sum(
            1 for s in results
            if s in (status.HTTP_201_CREATED, status.HTTP_204_NO_CONTENT)
        )
        self.assertEqual(success_count, 1, f"Expected exactly 1 success, got: {results}")

        # The token must be marked used exactly once.
        link.refresh_from_db()
        self.assertIsNotNone(link.used_at)


# ---------------------------------------------------------------------------
# Site invites — creator standing at redemption (#1540, registry Rule 2)
# ---------------------------------------------------------------------------

class SiteInviteCreatorStandingTests(TestCase):
    """A site invite admits people only while its creator is an active site admin.

    The creator is re-checked at redemption, so a change made outside the
    admin API (Django admin, a management command, a direct update) is
    honored as well as one made through it.
    """

    def setUp(self):
        set_invite_only()
        self.creator = make_admin(username="site_inviter")
        self.other_admin = make_admin(username="other_admin")
        self.client = APIClient()

    def tearDown(self):
        set_open()

    def _register(self, email, raw):
        return self.client.post(
            "/api/v1/auth/registration/",
            {"email": email, "password1": "Sup3rS3cr3t!xyz", "password2": "Sup3rS3cr3t!xyz", "invite_token": raw},
        )

    def _assert_refused(self, raw, email):
        r = self._register(email, raw)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("invite_token", r.json())
        self.assertFalse(User.objects.filter(email=email).exists())

    def test_link_from_an_active_site_admin_is_accepted(self):
        _, raw = InviteLink.generate(created_by=self.creator)
        r = self._register("ok@example.com", raw)
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.content)

    def test_creator_no_longer_site_admin_is_refused(self):
        link, raw = InviteLink.generate(created_by=self.creator, single_use=True)
        User.objects.filter(pk=self.creator.pk).update(is_site_admin=False)
        self._assert_refused(raw, "demoted@example.com")
        link.refresh_from_db()
        self.assertIsNone(link.used_at)
        self.assertEqual(link.use_count, 0)

    def test_creator_deactivated_outside_the_admin_api_is_refused(self):
        _, raw = InviteLink.generate(created_by=self.creator)
        User.objects.filter(pk=self.creator.pk).update(is_active=False)
        self._assert_refused(raw, "inactive@example.com")

    def test_creator_deleted_is_refused(self):
        _, raw = InviteLink.generate(created_by=self.creator)
        self.creator.delete()
        self._assert_refused(raw, "deleted@example.com")

    def test_validate_invite_token_raises_invite_invalid(self):
        from django.db import transaction

        from accounts.invite_utils import InviteTokenError, validate_invite_token

        _, raw = InviteLink.generate(created_by=self.creator)
        User.objects.filter(pk=self.creator.pk).update(is_site_admin=False)
        with self.assertRaises(InviteTokenError) as ctx, transaction.atomic():
            validate_invite_token(raw)
        self.assertEqual(ctx.exception.code, "invite_invalid")

    def test_admin_api_demotion_revokes_pending_site_invites(self):
        pending, _ = InviteLink.generate(created_by=self.creator)
        others, _ = InviteLink.generate(created_by=self.other_admin)
        self.client.force_authenticate(self.other_admin)
        r = self.client.patch(f"/api/v1/admin/users/{self.creator.pk}/", {"is_site_admin": False})
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        pending.refresh_from_db()
        others.refresh_from_db()
        self.assertIsNotNone(pending.revoked_at)
        self.assertIsNone(others.revoked_at)

    def test_admin_api_change_that_keeps_site_admin_leaves_links_alone(self):
        pending, _ = InviteLink.generate(created_by=self.creator)
        self.client.force_authenticate(self.other_admin)
        r = self.client.patch(f"/api/v1/admin/users/{self.creator.pk}/", {"has_completed_tour": True})
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        pending.refresh_from_db()
        self.assertIsNone(pending.revoked_at)

    def test_set_site_admin_revoke_command_revokes_pending_site_invites(self):
        from django.core.management import call_command

        pending, _ = InviteLink.generate(created_by=self.creator)
        call_command("set_site_admin", self.creator.username, "--revoke", stdout=io.StringIO())
        pending.refresh_from_db()
        self.assertIsNotNone(pending.revoked_at)


class SiteInviteRedemptionLockPostgresTests(TransactionTestCase):
    """Redemption locks the site invite row on PostgreSQL with a creator set and
    with ``created_by`` NULL (the creator join is nullable, so the lock must be
    limited to the invite row itself)."""

    def setUp(self):
        if connection.vendor != "postgresql":
            self.skipTest("Row-lock SQL differs on SQLite; this test requires PostgreSQL.")
        set_invite_only()
        self.creator = make_admin(username="pg_site_inviter")

    def tearDown(self):
        set_open()

    def _register(self, email, raw):
        return APIClient().post(
            "/api/v1/auth/registration/",
            {"email": email, "password1": "Sup3rS3cr3t!xyz", "password2": "Sup3rS3cr3t!xyz", "invite_token": raw},
        )

    def test_link_with_a_creator_is_redeemed(self):
        link, raw = InviteLink.generate(created_by=self.creator, single_use=True)
        r = self._register("pg-ok@example.com", raw)
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.content)
        link.refresh_from_db()
        self.assertIsNotNone(link.used_at)

    def test_link_without_a_creator_is_refused_cleanly(self):
        from django.db import transaction

        from accounts.invite_utils import InviteTokenError, validate_invite_token

        _, raw = InviteLink.generate(created_by=None)
        with self.assertRaises(InviteTokenError) as ctx, transaction.atomic():
            validate_invite_token(raw)
        self.assertEqual(ctx.exception.code, "invite_invalid")
        r = self._register("pg-nocreator@example.com", raw)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)
        self.assertFalse(User.objects.filter(email="pg-nocreator@example.com").exists())


class SiteInviteEffectiveStatusAndCapTests(TestCase):
    """The admin list and the active-link caps apply the redemption creator
    rule: a pending link whose creator may no longer admit accounts lists as
    ``revoked`` and frees its cap slot. Nothing is written to the row."""

    LIST_URL = "/api/v1/admin/invite-links/"

    def setUp(self):
        self.admin = make_admin(username="list_admin")
        self.creator = make_admin(username="list_creator")
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def _statuses(self):
        r = self.client.get(self.LIST_URL)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        return {row["id"]: row["status"] for row in r.json()}

    def _assert_lists_revoked_and_row_untouched(self, link):
        self.assertEqual(self._statuses()[link.pk], "revoked")
        link.refresh_from_db()
        self.assertIsNone(link.revoked_at)

    def test_active_site_admin_creator_lists_pending(self):
        link, _ = InviteLink.generate(created_by=self.creator)
        self.assertEqual(self._statuses()[link.pk], "pending")

    def test_deleted_creator_lists_revoked(self):
        link, _ = InviteLink.generate(created_by=self.creator)
        self.creator.delete()
        self._assert_lists_revoked_and_row_untouched(link)

    def test_creator_deactivated_outside_the_admin_api_lists_revoked(self):
        link, _ = InviteLink.generate(created_by=self.creator)
        User.objects.filter(pk=self.creator.pk).update(is_active=False)
        self._assert_lists_revoked_and_row_untouched(link)

    def test_demoted_creator_lists_revoked(self):
        link, _ = InviteLink.generate(created_by=self.creator)
        User.objects.filter(pk=self.creator.pk).update(is_site_admin=False)
        self._assert_lists_revoked_and_row_untouched(link)

    def test_used_and_expired_statuses_are_unchanged(self):
        used, _ = InviteLink.generate(created_by=self.creator)
        InviteLink.objects.filter(pk=used.pk).update(used_at=timezone.now())
        expired, _ = InviteLink.generate(created_by=self.creator, expires_at=timezone.now() - timedelta(days=1))
        User.objects.filter(pk=self.creator.pk).update(is_site_admin=False)
        statuses = self._statuses()
        self.assertEqual(statuses[used.pk], "used")
        self.assertEqual(statuses[expired.pk], "expired")

    def _fill_cap(self):
        for _ in range(MAX_ACTIVE_INVITE_LINKS):
            InviteLink.generate(created_by=self.creator)
        r = self.client.post(self.LIST_URL, {}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_links_of_a_deleted_creator_free_their_cap_slots(self):
        self._fill_cap()
        self.creator.delete()
        r = self.client.post(self.LIST_URL, {}, format="json")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.content)

    def test_links_of_a_creator_deactivated_outside_the_api_free_their_cap_slots(self):
        self._fill_cap()
        User.objects.filter(pk=self.creator.pk).update(is_active=False)
        r = self.client.post(self.LIST_URL, {}, format="json")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.content)

    def test_links_of_a_demoted_creator_free_their_cap_slots(self):
        self._fill_cap()
        User.objects.filter(pk=self.creator.pk).update(is_site_admin=False)
        r = self.client.post(self.LIST_URL, {}, format="json")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.content)

    def test_emailed_count_skips_links_whose_creator_no_longer_admits(self):
        from accounts.invite_utils import live_site_invite_count

        expires = timezone.now() + timedelta(days=7)
        InviteLink.generate(created_by=self.creator, expires_at=expires, single_use=True, delivery="email")
        InviteLink.generate(created_by=self.admin, expires_at=expires, single_use=True, delivery="email")
        self.assertEqual(live_site_invite_count(delivery="email"), 2)
        User.objects.filter(pk=self.creator.pk).update(is_site_admin=False)
        self.assertEqual(live_site_invite_count(delivery="email"), 1)

    def test_link_listed_revoked_for_creator_standing_can_be_revoked_explicitly(self):
        link, _ = InviteLink.generate(created_by=self.creator)
        User.objects.filter(pk=self.creator.pk).update(is_site_admin=False)
        r = self.client.delete(f"{self.LIST_URL}{link.pk}/")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        link.refresh_from_db()
        self.assertIsNotNone(link.revoked_at)
        # Stays revoked once the creator's standing is restored.
        User.objects.filter(pk=self.creator.pk).update(is_site_admin=True)
        self.assertEqual(self._statuses()[link.pk], "revoked")

    def test_link_listed_revoked_for_creator_standing_is_pending_again_on_restore(self):
        link, _ = InviteLink.generate(created_by=self.creator)
        User.objects.filter(pk=self.creator.pk).update(is_site_admin=False)
        self.assertEqual(self._statuses()[link.pk], "revoked")
        User.objects.filter(pk=self.creator.pk).update(is_site_admin=True)
        self.assertEqual(self._statuses()[link.pk], "pending")
