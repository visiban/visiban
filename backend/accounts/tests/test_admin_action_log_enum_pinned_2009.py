"""Pin the ``AdminActionLog.Action`` vocabulary (#2009).

``AdminActionLog`` stays in the OSS core only because it records a *closed set*
of admin control-plane actions (``docs/architecture/open-core-boundary.md``,
"Audit log (split)"). A general, growing audit vocabulary is the enterprise
compliance audit log. Nothing but convention held that line, so this test makes
every change to the enum a deliberate one.

If this test fails because you added an action: run the ``enterprise-check``
agent on the addition first. A new control-plane toggle of the same kind as the
ones below is OSS; board lifecycle, membership, or other "audit everything"
events are not. Then add the value here and to the action list in
``docs/api/admin.md``. Never remove or rename a value: stored rows keep it
verbatim, and ``GET /api/v1/admin/action-log/`` returns it.
"""
from django.test import SimpleTestCase

from accounts.models import AdminActionLog

PINNED_ACTIONS = {
    "maintenance_mode.enabled",
    "maintenance_mode.disabled",
    "maintenance_message.changed",
    "registration_mode.changed",
    "uploads_enabled.enabled",
    "uploads_enabled.disabled",
    "email_settings.source_changed",
    "email_settings.server_changed",
    "email_settings.from_email_changed",
    "email_settings.username_changed",
    "email_settings.password_changed",
    "email_settings.test_sent",
    "user.password_set",
    "user.password_disabled",
    "card_history.purged",
    "user.site_admin_granted",
    "user.site_admin_revoked",
    "user.all_content_granted",
    "user.all_content_revoked",
}


class AdminActionLogActionEnumPinnedTests(SimpleTestCase):
    def test_action_values_are_the_pinned_closed_set(self):
        actual = set(AdminActionLog.Action.values)
        added = sorted(actual - PINNED_ACTIONS)
        removed = sorted(PINNED_ACTIONS - actual)
        self.assertFalse(
            added,
            f"New AdminActionLog actions {added}: run enterprise-check on them before "
            "adding them to PINNED_ACTIONS (see this module's docstring).",
        )
        self.assertFalse(
            removed,
            f"AdminActionLog actions {removed} were removed or renamed; stored rows and "
            "the action-log API still carry them, so they must stay.",
        )
