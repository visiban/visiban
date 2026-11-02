# #1133: a board's own health status (on_track / at_risk / off_track), null to
# inherit from the nearest group above it. Nullable with no database default
# (default=None) and no index, so on PostgreSQL the ADD COLUMN is a catalog-
# only change: it neither rewrites nor scans boards. The value set is enforced
# by the serializer, not by a database constraint.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0094_notification_webhook_disabled_action_type"),
    ]

    operations = [
        migrations.AddField(
            model_name="board",
            name="health_status",
            field=models.CharField(
                blank=True,
                choices=[("on_track", "On track"), ("at_risk", "At risk"), ("off_track", "Off track")],
                default=None,
                max_length=16,
                null=True,
            ),
        ),
    ]
