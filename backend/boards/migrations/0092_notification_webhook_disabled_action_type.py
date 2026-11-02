# Generated for #863 — add the "webhook_disabled" value to Notification.action_type.
#
# Zero-downtime deploy: safe, and this migration emits no DDL at all. ``choices``
# is enforced by Django and DRF, never by the database: there is no CHECK
# constraint on this column (see 0062). State-only AlterField: no table lock, no
# rewrite, no ordering constraint against the code deploy.
#
# Additive for API clients: clients that switch on action_type fall through to a
# generic rendering for an unrecognized value (docs/api/notifications.md).

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0091_swimlane_limits"),
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
                    ("comment_added", "comment added"),
                    ("webhook_disabled", "webhook disabled"),
                ],
            ),
        ),
    ]
