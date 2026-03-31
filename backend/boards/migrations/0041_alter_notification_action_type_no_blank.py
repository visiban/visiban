# Generated manually for #572 — tighten Notification.action_type constraint
# after the backfill migration (0040) has resolved empty-string rows.
# Removing blank=True and default="" prevents new code from accidentally
# omitting action_type; DRF serializer validation will reject empty values.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0040_backfill_notification_action_type"),
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
                ],
                blank=False,
            ),
        ),
    ]
