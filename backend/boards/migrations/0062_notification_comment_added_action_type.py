# Generated for #1277 — add the "comment_added" value to Notification.action_type.
#
# Zero-downtime deploy: safe, and this migration emits no DDL at all
# (`sqlmigrate boards 0062` prints "(no-op)"). ``choices`` is enforced by Django
# and DRF, never by the database: there is no CHECK constraint on this column,
# exactly as for 0060 (due_soon). So this is a state-only AlterField — no table
# lock, no rewrite, no ordering constraint against the code deploy.
#
# Additive for API clients too: the value is new, and no existing value changes
# meaning or disappears. Clients that switch on action_type must fall through to
# a generic rendering for an unrecognized value; docs/api/notifications.md says so.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0061_add_card_external_ref"),
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
                ],
            ),
        ),
    ]
