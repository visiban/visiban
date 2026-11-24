"""Site-admin personal access token lifetime policy (#1572).

Two SiteSetting fields: ``pat_max_lifetime_days`` (when set, token creation
needs an expiry within that many days) and ``pat_default_lifetime_days`` (what
the token form pre-fills). Both default to null, which keeps today's behavior.
"""
from datetime import datetime, time, timedelta, timezone as dt_timezone

from django.core.exceptions import ValidationError
from django.test import TestCase
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from accounts.admin_views import SiteSettingSerializer
from accounts.models import (
    PAT_HARD_MAX_LIFETIME_DAYS,
    PAT_MAX_PER_USER,
    AdminActionLog,
    PersonalAccessToken,
    SiteSetting,
    User,
)
from accounts.serializers import pat_expiry_policy_error

TOKENS = "/api/v1/auth/tokens/"
POLICY = "/api/v1/auth/tokens/policy/"
SETTINGS = "/api/v1/admin/settings/"


def set_policy(max_days=None, default_days=None):
    s = SiteSetting.get()
    s.pat_max_lifetime_days = max_days
    s.pat_default_lifetime_days = default_days
    s.save()


def utc_date(days_from_now):
    """The date-only string the token form sends, ``days_from_now`` UTC days ahead."""
    return (timezone.now() + timedelta(days=days_from_now)).astimezone(dt_timezone.utc).date().isoformat()


class TokenCreatePolicyTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="alice", password="pass123secure!")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def create(self, **body):
        return self.client.post(TOKENS, {"name": "ci", **body}, format="json")

    def test_unset_policy_keeps_non_expiring_tokens(self):
        self.assertIsNone(SiteSetting.get().pat_max_lifetime_days)
        r = self.create()
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertIsNone(r.json()["expires_at"])

    def test_unset_policy_keeps_the_built_in_one_year_cap(self):
        r = self.create(expires_at=utc_date(PAT_HARD_MAX_LIFETIME_DAYS + 2))
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(r.json()["detail"], "Token expiry cannot be more than 1 year from now.")

    def test_default_alone_does_not_change_the_api(self):
        set_policy(default_days=30)
        r = self.create()
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertIsNone(r.json()["expires_at"])

    def test_missing_expiry_is_refused_when_a_max_is_set(self):
        set_policy(max_days=90)
        for body in ({}, {"expires_at": None}, {"expires_at": ""}):
            with self.subTest(body=body):
                r = self.create(**body)
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertEqual(
                    r.json(),
                    {"detail": "This site requires access tokens to expire within 90 days. Choose an expiry date."},
                )
        self.assertFalse(PersonalAccessToken.objects.exists())

    def test_expiry_past_the_max_is_refused(self):
        set_policy(max_days=30)
        r = self.create(expires_at=utc_date(31))
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(r.json()["detail"], "Token expiry cannot be more than 30 days from now on this site.")
        self.assertFalse(PersonalAccessToken.objects.exists())

    def test_expiry_within_the_max_is_accepted(self):
        set_policy(max_days=30)
        for days in (1, 29):
            with self.subTest(days=days):
                r = self.create(expires_at=utc_date(days))
                self.assertEqual(r.status_code, status.HTTP_201_CREATED)

    def test_the_last_allowed_date_is_accepted_at_any_time_of_day(self):
        """A date-only value N days out is midnight UTC, earlier than now + N days in time, and later
        datetimes on that same UTC date are inside the limit too: the limit is a date."""
        set_policy(max_days=30)
        last = (timezone.now() + timedelta(days=30)).astimezone(dt_timezone.utc).date()
        self.assertEqual(self.create(expires_at=last.isoformat()).status_code, status.HTTP_201_CREATED)
        late = datetime.combine(last, time(23, 59), tzinfo=dt_timezone.utc).isoformat()
        self.assertEqual(self.create(expires_at=late).status_code, status.HTTP_201_CREATED)
        next_day = datetime.combine(last + timedelta(days=1), time(0, 1), tzinfo=dt_timezone.utc).isoformat()
        self.assertEqual(self.create(expires_at=next_day).status_code, status.HTTP_400_BAD_REQUEST)

    def test_existing_tokens_are_not_affected(self):
        _, raw = PersonalAccessToken.generate(self.user, "old", scopes=["read"])
        set_policy(max_days=7)
        client = APIClient()
        r = client.get(TOKENS, HTTP_AUTHORIZATION=f"Token {raw}")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIsNone(PersonalAccessToken.objects.get(name="old").expires_at)

    def test_policy_helper_absent_max_refuses_nothing(self):
        now = timezone.now()
        self.assertIsNone(pat_expiry_policy_error(None, None, now=now))
        self.assertIsNone(pat_expiry_policy_error(now + timedelta(days=300), None, now=now))
        self.assertIsNotNone(pat_expiry_policy_error(None, 5, now=now))


class TokenPolicyEndpointTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="alice", password="pass123secure!")

    def test_anonymous_is_refused(self):
        self.assertEqual(APIClient().get(POLICY).status_code, status.HTTP_401_UNAUTHORIZED)

    def test_defaults_are_unset(self):
        client = APIClient()
        client.force_authenticate(self.user)
        r = client.get(POLICY)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json(), {
            "max_lifetime_days": None,
            "default_lifetime_days": None,
            "hard_max_lifetime_days": PAT_HARD_MAX_LIFETIME_DAYS,
            "max_tokens": PAT_MAX_PER_USER,
        })

    def test_reports_the_site_policy(self):
        set_policy(max_days=90, default_days=30)
        client = APIClient()
        client.force_authenticate(self.user)
        body = client.get(POLICY).json()
        self.assertEqual((body["max_lifetime_days"], body["default_lifetime_days"]), (90, 30))

    def test_a_read_scoped_token_can_read_it(self):
        _, raw = PersonalAccessToken.generate(self.user, "r", scopes=["read"])
        r = APIClient().get(POLICY, HTTP_AUTHORIZATION=f"Token {raw}")
        self.assertEqual(r.status_code, status.HTTP_200_OK)


class AdminPolicySettingsTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="adminpass123!")
        User.objects.filter(pk=self.admin.pk).update(is_site_admin=True)
        self.admin.refresh_from_db()
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def patch(self, body):
        return self.client.patch(SETTINGS, body, format="json")

    def test_get_reports_both_as_null_by_default(self):
        body = self.client.get(SETTINGS).json()
        self.assertIsNone(body["pat_max_lifetime_days"])
        self.assertIsNone(body["pat_default_lifetime_days"])

    def test_patch_sets_and_clears(self):
        r = self.patch({"pat_max_lifetime_days": 90, "pat_default_lifetime_days": 30})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual((r.json()["pat_max_lifetime_days"], r.json()["pat_default_lifetime_days"]), (90, 30))
        r = self.patch({"pat_max_lifetime_days": None})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        s = SiteSetting.get()
        self.assertEqual((s.pat_max_lifetime_days, s.pat_default_lifetime_days), (None, 30))

    def test_absent_key_keeps_the_stored_value(self):
        set_policy(max_days=90, default_days=30)
        self.assertEqual(self.patch({"uploads_enabled": False}).status_code, status.HTTP_200_OK)
        s = SiteSetting.get()
        self.assertEqual((s.pat_max_lifetime_days, s.pat_default_lifetime_days), (90, 30))

    def test_bounds(self):
        for field in ("pat_max_lifetime_days", "pat_default_lifetime_days"):
            for value in (0, -1, PAT_HARD_MAX_LIFETIME_DAYS + 1, "abc"):
                with self.subTest(field=field, value=value):
                    r = self.patch({field: value})
                    self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
                    self.assertIn(field, r.json())

    def test_default_longer_than_max_is_refused(self):
        r = self.patch({"pat_max_lifetime_days": 30, "pat_default_lifetime_days": 60})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("pat_default_lifetime_days", r.json())

    def test_lowering_the_max_below_the_stored_default_is_refused(self):
        set_policy(max_days=90, default_days=60)
        r = self.patch({"pat_max_lifetime_days": 30})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("pat_default_lifetime_days", r.json())
        self.assertEqual(SiteSetting.get().pat_max_lifetime_days, 90)

    def test_raising_the_default_above_the_stored_max_is_refused(self):
        set_policy(max_days=30)
        r = self.patch({"pat_default_lifetime_days": 31})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_non_admin_cannot_read_or_change_the_policy(self):
        user = User.objects.create_user(username="reg", password="userpass123!")
        self.client.force_authenticate(user)
        self.assertEqual(self.client.get(SETTINGS).status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(self.patch({"pat_max_lifetime_days": 1}).status_code, status.HTTP_403_FORBIDDEN)
        self.assertIsNone(SiteSetting.get().pat_max_lifetime_days)

    def test_changes_are_recorded_in_the_action_log(self):
        self.patch({"pat_max_lifetime_days": 90, "pat_default_lifetime_days": 30})
        self.patch({"pat_max_lifetime_days": None})
        rows = list(AdminActionLog.objects.order_by("id").values_list("action", "metadata"))
        self.assertEqual(rows, [
            ("pat_max_lifetime.changed", {"from": None, "to": 90}),
            ("pat_default_lifetime.changed", {"from": None, "to": 30}),
            ("pat_max_lifetime.changed", {"from": 90, "to": None}),
        ])

    def test_resubmitting_the_same_value_records_nothing(self):
        set_policy(max_days=90)
        self.patch({"pat_max_lifetime_days": 90})
        self.assertFalse(AdminActionLog.objects.exists())


class PolicyValidationGuardTests(TestCase):
    """Absent-input guard (#1075): the merged-state check must not pass without the stored row."""

    def test_write_serializer_without_the_stored_row_is_invalid(self):
        serializer = SiteSettingSerializer(data={"pat_max_lifetime_days": 30}, partial=True)
        self.assertFalse(serializer.is_valid())

    def test_with_the_stored_row_it_validates(self):
        serializer = SiteSettingSerializer(data={"pat_max_lifetime_days": 30}, partial=True, current=SiteSetting.get())
        self.assertTrue(serializer.is_valid(), serializer.errors)

    def test_model_clean_refuses_default_over_max(self):
        s = SiteSetting.get()
        s.pat_max_lifetime_days, s.pat_default_lifetime_days = 10, 20
        with self.assertRaises(ValidationError) as ctx:
            s.full_clean()
        self.assertIn("pat_default_lifetime_days", ctx.exception.message_dict)

    def test_model_validators_bound_both_fields(self):
        s = SiteSetting.get()
        s.pat_max_lifetime_days = PAT_HARD_MAX_LIFETIME_DAYS + 1
        with self.assertRaises(ValidationError):
            s.full_clean()
