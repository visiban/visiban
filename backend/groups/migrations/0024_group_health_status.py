# #1133: a group's own health status (on_track / at_risk / off_track), null to
# inherit from the nearest ancestor group. Nullable with no database default
# (default=None) and no index, so on PostgreSQL the ADD COLUMN is a catalog-
# only change: it neither rewrites nor scans groups. The value set is enforced
# by the serializer, not by a database constraint.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("groups", "0023_revoke_legacy_group_invite_links"),
    ]

    operations = [
        migrations.AddField(
            model_name="group",
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
