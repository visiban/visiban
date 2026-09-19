"""Tests for the admin action audit log — who/when for instance-wide toggles (#1126).

The behaviour under test is mostly about what is *not* written. An audit log
that records non-events is worse than a sparse one: every row then looks like a
transition, and "how long were we in maintenance?" stops being answerable from
the log. So the no-op and rollback cases below are the load-bearing ones, not
the happy path.
"""
from unittest import mock

from django.contrib.admin.sites import AdminSite
from django.db import transaction
from django.test import RequestFactory, TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.admin import SiteSettingAdmin
from accounts.models import (
    AdminActionLog,
    PersonalAccessToken,
    SCOPE_ADMIN,
    SCOPE_READ,
    SiteSetting,
    User,
    invalidate_maintenance_mode_cache,
    record_site_setting_changes,
    snapshot_site_setting,
)

ACTION_LOG_URL = "/api/v1/admin/action-log/"
SETTINGS_URL = "/api/v1/admin/settings/"
PASSWORD = "auditpass123!"


class AuditBaseTest(TestCase):
    def setUp(self):
        invalidate_maintenance_mode_cache()
        self.addCleanup(invalidate_maintenance_mode_cache)
        self.admin = User.objects.create_user(username="siteadmin", password=PASSWORD)
        self.admin.is_site_admin = True
        self.admin.save(update_fields=["is_site_admin"])
        self.member = User.objects.create_user(username="member", password=PASSWORD)
        self.client = APIClient()

    def _patch_settings(self, payload, user=None):
        self.client.force_authenticate(user or self.admin)
        return self.client.patch(SETTINGS_URL, payload, format="json")


# ---------------------------------------------------------------------------
# Write path: admin REST API
# ---------------------------------------------------------------------------

class AdminApiAuditTests(AuditBaseTest):
    def test_enabling_maintenance_mode_writes_a_row(self):
        r = self._patch_settings({"maintenance_mode": True})
        self.assertEqual(r.status_code, status.HTTP_200_OK)

        log = AdminActionLog.objects.get()
        self.assertEqual(log.action, AdminActionLog.Action.MAINTENANCE_MODE_ENABLED)
        self.assertEqual(log.actor_id, self.admin.pk)
        self.assertEqual(log.actor_username, "siteadmin")
        self.assertEqual(log.source, AdminActionLog.Source.ADMIN_API)

    def test_disabling_maintenance_mode_writes_a_distinct_action(self):
        self._patch_settings({"maintenance_mode": True})
        self._patch_settings({"maintenance_mode": False})

        actions = list(
            AdminActionLog.objects.order_by("id").values_list("action", flat=True)
        )
        self.assertEqual(
            actions,
            [
                AdminActionLog.Action.MAINTENANCE_MODE_ENABLED,
                AdminActionLog.Action.MAINTENANCE_MODE_DISABLED,
            ],
        )

    def test_enable_records_the_notice_in_force(self):
        """A retro must see what users were actually told, without a second row."""
        self._patch_settings(
            {"maintenance_mode": True, "maintenance_message": "Back by 14:00 UTC."}
        )
        enabled = AdminActionLog.objects.get(
            action=AdminActionLog.Action.MAINTENANCE_MODE_ENABLED
        )
        self.assertEqual(enabled.metadata["message"], "Back by 14:00 UTC.")

    def test_disable_records_the_notice_that_was_displayed_not_the_new_one(self):
        """Closing a window while clearing the notice must not lose the notice.

        The message on a ``disabled`` row is the one users saw *during* the
        window. Taking it from the post-change state instead would record an
        empty string here and erase the only copy on this row.
        """
        self._patch_settings(
            {"maintenance_mode": True, "maintenance_message": "Upgrading to 1.2."}
        )
        AdminActionLog.objects.all().delete()

        self._patch_settings({"maintenance_mode": False, "maintenance_message": ""})
        disabled = AdminActionLog.objects.get(
            action=AdminActionLog.Action.MAINTENANCE_MODE_DISABLED
        )
        self.assertEqual(disabled.metadata["message"], "Upgrading to 1.2.")

    def test_no_op_patch_writes_nothing(self):
        """Setting a value to what it already holds is not an auditable event."""
        self._patch_settings({"maintenance_mode": True})
        AdminActionLog.objects.all().delete()

        r = self._patch_settings({"maintenance_mode": True})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(AdminActionLog.objects.count(), 0)

    def test_submitting_an_unchanged_message_writes_nothing(self):
        self._patch_settings({"maintenance_message": "Same."})
        AdminActionLog.objects.all().delete()

        self._patch_settings({"maintenance_message": "Same."})
        self.assertEqual(AdminActionLog.objects.count(), 0)

    def test_combined_enable_and_message_writes_two_ordered_rows(self):
        """One PATCH, two real transitions — and their order must be stable."""
        r = self._patch_settings(
            {"maintenance_mode": True, "maintenance_message": "Upgrading."}
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(AdminActionLog.objects.count(), 2)

        # Default ordering is newest-first with an id tiebreak; both rows share a
        # timestamp, so without the tiebreak this order would be undefined.
        newest_first = list(AdminActionLog.objects.values_list("action", flat=True))
        self.assertEqual(
            newest_first,
            [
                AdminActionLog.Action.MAINTENANCE_MESSAGE_CHANGED,
                AdminActionLog.Action.MAINTENANCE_MODE_ENABLED,
            ],
        )

    def test_message_change_records_both_sides(self):
        self._patch_settings({"maintenance_message": "First notice."})
        AdminActionLog.objects.all().delete()
        self._patch_settings({"maintenance_message": "Second notice."})

        log = AdminActionLog.objects.get()
        self.assertEqual(log.metadata, {"from": "First notice.", "to": "Second notice."})

    def test_registration_mode_change_is_audited(self):
        """The same handler mutates three instance-wide toggles; all are audited."""
        self._patch_settings({"registration_mode": "closed"})
        log = AdminActionLog.objects.get()
        self.assertEqual(log.action, AdminActionLog.Action.REGISTRATION_MODE_CHANGED)
        self.assertEqual(log.metadata, {"from": "open", "to": "closed"})

    def test_uploads_toggle_is_audited(self):
        self._patch_settings({"uploads_enabled": False})
        log = AdminActionLog.objects.get()
        self.assertEqual(log.action, AdminActionLog.Action.UPLOADS_DISABLED)

    def test_invalid_payload_writes_nothing(self):
        r = self._patch_settings({"registration_mode": "not-a-mode"})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(AdminActionLog.objects.count(), 0)


class AuditAtomicityTests(AuditBaseTest):
    """A rolled-back change must not leave a row claiming it happened."""

    def test_rollback_leaves_neither_the_change_nor_the_row(self):
        setting = SiteSetting.get()
        before = snapshot_site_setting(setting)

        with self.assertRaises(RuntimeError):
            with transaction.atomic():
                setting.maintenance_mode = True
                setting.save(update_fields=["maintenance_mode"])
                record_site_setting_changes(
                    before=before,
                    after=setting,
                    actor=self.admin,
                    source=AdminActionLog.Source.ADMIN_API,
                )
                raise RuntimeError("simulated failure after the audit write")

        self.assertEqual(AdminActionLog.objects.count(), 0)
        self.assertFalse(SiteSetting.objects.get(pk=1).maintenance_mode)

    def test_patch_snapshots_the_singleton_under_a_row_lock(self):
        """Regression guard for the unlocked read-modify-write.

        Without ``select_for_update`` a concurrent PATCH can land between the
        snapshot and the save, and the resulting row describes a transition that
        never happened — A commits "X"→"Y", B (holding a stale "X") commits "Z",
        and B's row claims "X"→"Z" while A's edit vanishes from the trail.

        Asserts the lock is *taken* rather than observing contention: the test
        backend is SQLite, which ignores ``FOR UPDATE``, so a genuine two-writer
        race cannot be reproduced here. What can be protected is the call
        itself, which is the thing a future refactor would drop.
        """
        manager = SiteSetting.objects
        with mock.patch.object(
            manager, "select_for_update", wraps=manager.select_for_update
        ) as locked:
            self._patch_settings({"maintenance_mode": True})

        self.assertTrue(
            locked.called,
            "AdminSettingsView.patch must read the singleton via select_for_update",
        )
        self.assertEqual(AdminActionLog.objects.count(), 1)

    def test_audit_failure_rolls_back_the_setting(self):
        """The log and the change are one unit in both directions."""
        with mock.patch.object(
            AdminActionLog, "record", side_effect=RuntimeError("audit down")
        ):
            with self.assertRaises(RuntimeError):
                self._patch_settings({"maintenance_mode": True})

        self.assertFalse(SiteSetting.objects.get(pk=1).maintenance_mode)
        self.assertEqual(AdminActionLog.objects.count(), 0)


class CacheInvalidationTests(AuditBaseTest):
    """SiteSetting.save() evicts twice — immediately and again after commit.

    Both halves matter and neither is redundant, so both are pinned here.
    """

    def test_eviction_is_repeated_after_commit(self):
        """Regression guard for the post-commit eviction.

        The immediate eviction lands *inside* the transaction, where another
        worker can repopulate the cache from the still-old committed row; the
        repeat at commit time is what stops that stale value surviving to the
        TTL. Because ``TestCase`` never commits, deleting the on_commit line
        leaves every other test in this repo green — so this asserts the
        callback is registered rather than observing its effect.
        """
        # Materialize the singleton first: get_or_create saves on the create
        # path, which would contribute a second callback and blur the count.
        SiteSetting.get()

        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            self._patch_settings({"maintenance_mode": True})

        self.assertEqual(
            len(callbacks),
            1,
            "SiteSetting.save() must defer a cache eviction to transaction.on_commit",
        )

    def test_a_failing_cache_does_not_roll_back_the_setting(self):
        """A cache outage must never cost the operator the write.

        The eviction now runs inside the PATCH's transaction, so an exception
        escaping it would roll the change back — which would mean a Valkey
        outage could stop an admin turning maintenance mode ON, precisely when
        the outage makes them want to. Degrading to a TTL-bounded propagation
        delay is the correct trade.
        """
        with mock.patch(
            "accounts.models.cache.delete", side_effect=RuntimeError("valkey down")
        ):
            r = self._patch_settings({"maintenance_mode": True})

        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertTrue(SiteSetting.objects.get(pk=1).maintenance_mode)
        self.assertEqual(AdminActionLog.objects.count(), 1)


# ---------------------------------------------------------------------------
# Write path: management command (break-glass shell route)
# ---------------------------------------------------------------------------

class CliAuditTests(AuditBaseTest):
    def test_cli_enable_is_audited_with_no_actor(self):
        from django.core.management import call_command
        from io import StringIO

        call_command("maintenance_mode", "--on", stdout=StringIO())

        log = AdminActionLog.objects.get()
        self.assertEqual(log.action, AdminActionLog.Action.MAINTENANCE_MODE_ENABLED)
        self.assertEqual(log.source, AdminActionLog.Source.CLI)
        # No authenticated user exists on a shell path; the row says so rather
        # than inventing an OS username that would read as an identity.
        self.assertIsNone(log.actor_id)
        self.assertEqual(log.actor_username, "")

    def test_cli_status_query_writes_nothing(self):
        from django.core.management import call_command
        from io import StringIO

        call_command("maintenance_mode", stdout=StringIO())
        self.assertEqual(AdminActionLog.objects.count(), 0)


# ---------------------------------------------------------------------------
# Write path: Django admin (second break-glass route)
# ---------------------------------------------------------------------------

class DjangoAdminAuditTests(AuditBaseTest):
    """SiteSettingAdmin bypasses the REST serializer entirely."""

    def _save_via_admin(self, **changes):
        setting = SiteSetting.get()
        for field, value in changes.items():
            setattr(setting, field, value)
        request = RequestFactory().post("/admin/accounts/sitesetting/1/change/")
        request.user = self.admin
        SiteSettingAdmin(SiteSetting, AdminSite()).save_model(
            request, setting, form=None, change=True
        )
        return setting

    def test_django_admin_change_is_audited(self):
        self._save_via_admin(maintenance_mode=True)

        log = AdminActionLog.objects.get()
        self.assertEqual(log.action, AdminActionLog.Action.MAINTENANCE_MODE_ENABLED)
        self.assertEqual(log.source, AdminActionLog.Source.DJANGO_ADMIN)
        self.assertEqual(log.actor_id, self.admin.pk)
        self.assertEqual(log.actor_username, "siteadmin")

    def test_django_admin_no_op_save_writes_nothing(self):
        self._save_via_admin(maintenance_mode=False)
        self.assertEqual(AdminActionLog.objects.count(), 0)

    def test_creating_the_singleton_through_django_admin_is_audited(self):
        """The add form is reachable on a first-boot instance.

        With no stored row to diff against, the comparison is made against the
        model defaults — otherwise an operator who creates the singleton with
        maintenance mode already on would be the one change nothing records.
        """
        SiteSetting.objects.all().delete()

        fresh = SiteSetting(maintenance_mode=True)
        request = RequestFactory().post("/admin/accounts/sitesetting/add/")
        request.user = self.admin
        SiteSettingAdmin(SiteSetting, AdminSite()).save_model(
            request, fresh, form=None, change=False
        )

        log = AdminActionLog.objects.get()
        self.assertEqual(log.action, AdminActionLog.Action.MAINTENANCE_MODE_ENABLED)
        self.assertEqual(log.source, AdminActionLog.Source.DJANGO_ADMIN)


# ---------------------------------------------------------------------------
# Actor durability
# ---------------------------------------------------------------------------

class ActorDurabilityTests(AuditBaseTest):
    def test_row_survives_actor_deletion_with_identity_intact(self):
        """The whole point of the table: deleting the account must not erase who."""
        self._patch_settings({"maintenance_mode": True})
        actor_pk = self.admin.pk

        self.client.force_authenticate(None)
        self.admin.delete()

        log = AdminActionLog.objects.get()
        self.assertEqual(log.actor_username, "siteadmin")
        # actor_id is a plain integer, not a FK — it is not nulled by the delete.
        self.assertEqual(log.actor_id, actor_pk)

    def test_username_is_snapshotted_not_resolved_live(self):
        self._patch_settings({"maintenance_mode": True})
        self.admin.username = "renamed_admin"
        self.admin.save(update_fields=["username"])

        log = AdminActionLog.objects.get()
        self.assertEqual(log.actor_username, "siteadmin")


# ---------------------------------------------------------------------------
# Read endpoint
# ---------------------------------------------------------------------------

class ActionLogEndpointTests(AuditBaseTest):
    def setUp(self):
        super().setUp()
        AdminActionLog.record(
            action=AdminActionLog.Action.MAINTENANCE_MODE_ENABLED,
            source=AdminActionLog.Source.ADMIN_API,
            actor=self.admin,
        )
        AdminActionLog.record(
            action=AdminActionLog.Action.UPLOADS_DISABLED,
            source=AdminActionLog.Source.CLI,
        )

    def test_site_admin_can_read(self):
        self.client.force_authenticate(self.admin)
        r = self.client.get(ACTION_LOG_URL)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        body = r.json()
        self.assertEqual(body["count"], 2)
        self.assertEqual(len(body["results"]), 2)

    def test_response_exposes_no_email(self):
        """Audit rows identify an actor by username only — never by email."""
        self.client.force_authenticate(self.admin)
        r = self.client.get(ACTION_LOG_URL)
        self.assertNotIn("email", r.content.decode().lower())

    def test_serialized_shape(self):
        self.client.force_authenticate(self.admin)
        row = self.client.get(ACTION_LOG_URL).json()["results"][-1]
        self.assertEqual(
            sorted(row),
            ["action", "actor_id", "actor_username", "created_at", "id", "metadata", "source"],
        )

    def test_non_admin_is_rejected(self):
        self.client.force_authenticate(self.member)
        r = self.client.get(ACTION_LOG_URL)
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_anonymous_is_rejected(self):
        r = APIClient().get(ACTION_LOG_URL)
        self.assertIn(
            r.status_code,
            [status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN],
        )

    def test_action_filter(self):
        self.client.force_authenticate(self.admin)
        r = self.client.get(
            ACTION_LOG_URL, {"action": AdminActionLog.Action.UPLOADS_DISABLED}
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        results = r.json()["results"]
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["action"], AdminActionLog.Action.UPLOADS_DISABLED)

    def test_pagination_envelope_and_offset(self):
        for _ in range(3):
            AdminActionLog.record(
                action=AdminActionLog.Action.MAINTENANCE_MODE_DISABLED,
                source=AdminActionLog.Source.ADMIN_API,
                actor=self.admin,
            )
        self.client.force_authenticate(self.admin)

        first = self.client.get(ACTION_LOG_URL, {"page_size": 2}).json()
        self.assertEqual(first["count"], 5)
        self.assertEqual(first["page_size"], 2)
        self.assertEqual(first["offset"], 0)
        self.assertEqual(len(first["results"]), 2)

        second = self.client.get(ACTION_LOG_URL, {"page_size": 2, "offset": 2}).json()
        self.assertEqual(second["offset"], 2)
        # The id tiebreak on Meta.ordering is what keeps pages disjoint when
        # rows share a created_at timestamp.
        self.assertFalse(
            {r["id"] for r in first["results"]} & {r["id"] for r in second["results"]}
        )

    def test_log_is_readable_while_maintenance_mode_is_on(self):
        """The trail must be reachable during the incident it documents."""
        self._patch_settings({"maintenance_mode": True})
        self.client.force_authenticate(self.admin)
        r = self.client.get(ACTION_LOG_URL)
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_unknown_action_filter_is_a_400_not_an_empty_page(self):
        """An empty page would read as 'nothing ever happened' — a dangerous
        answer to give someone running an incident retrospective."""
        self.client.force_authenticate(self.admin)
        r = self.client.get(ACTION_LOG_URL, {"action": "bogus.action"})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_write_methods_are_not_allowed(self):
        """Append-only: an audit log an admin can edit is not evidence."""
        self.client.force_authenticate(self.admin)
        for method in ("post", "patch", "delete", "put"):
            with self.subTest(method=method):
                r = getattr(self.client, method)(ACTION_LOG_URL, {}, format="json")
                self.assertEqual(r.status_code, status.HTTP_405_METHOD_NOT_ALLOWED)


class ActionLogTokenScopeTests(AuditBaseTest):
    """A PAT reaches the admin surface only when it carries the admin scope."""

    def _client_with_scopes(self, scopes):
        token, raw = PersonalAccessToken.generate(user=self.admin, name="t", scopes=scopes)
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION=f"Token {raw}")
        return client

    def test_admin_scoped_token_is_allowed(self):
        # `admin` is a surface grant, not a verb: a GET needs `read` alongside it.
        r = self._client_with_scopes([SCOPE_ADMIN, SCOPE_READ]).get(ACTION_LOG_URL)
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_token_without_admin_scope_is_rejected(self):
        r = self._client_with_scopes([SCOPE_READ]).get(ACTION_LOG_URL)
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_admin_scope_alone_does_not_open_the_read(self):
        """The surface grant must not quietly imply the verb grant."""
        r = self._client_with_scopes([SCOPE_ADMIN]).get(ACTION_LOG_URL)
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_scopes_do_not_substitute_for_being_a_site_admin(self):
        """A non-admin cannot mint their way in by asking for the admin scope."""
        _, raw = PersonalAccessToken.generate(
            self.member, "escalate", scopes=[SCOPE_ADMIN, SCOPE_READ]
        )
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION=f"Token {raw}")
        self.assertEqual(client.get(ACTION_LOG_URL).status_code, status.HTTP_403_FORBIDDEN)
