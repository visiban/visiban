# Generated for #356 — add the "due_soon" value to Notification.action_type.
#
# Zero-downtime deploy: safe, and this migration emits no DDL at all.
# ``choices`` is enforced by Django and DRF, never by the database: there is no
# CHECK constraint on this column anywhere in the boards migration history (0027,
# 0039 and 0041 are all choices/blank changes for the same reason). So this is a
# state-only AlterField — no table lock, no rewrite, no ordering constraint
# against the code deploy.
#
# Additive for API clients too: the value is new, and no existing value changes
# meaning or disappears. Clients that switch on action_type must fall through to
# a generic rendering for an unrecognized value; docs/api/notifications.md says so.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0059_add_swimlane_custom_fields"),
    ]

    operations = [
        migrations.AlterField(
            model_name="notification",
            name="action_type",
            field=models.CharField(
                max_length=32,
                choices=[
                    ("assigned", "assigned"),
                    ("mentioned", "mentioned"),
                    ("card_moved", "card moved"),
                    ("stale", "stale"),
                    ("board_invite", "board invite"),
                    ("due_soon", "due soon"),
                ],
            ),
        ),
    ]
