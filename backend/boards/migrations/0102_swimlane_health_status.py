# #2243: manual health status on swimlanes.
#
# PostgreSQL locking: catalog-only. The column is nullable with no default,
# so ADD COLUMN rewrites nothing and validates nothing, and an INSERT from an
# older release that does not name it stores NULL, which means "no status"
# (today's behavior) during a rolling upgrade. No index or constraint is
# added. See docs/development/database-migrations.md.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('boards', '0101_custom_field_thresholds'),
    ]

    operations = [
        migrations.AddField(
            model_name='swimlane',
            name='health_status',
            field=models.CharField(blank=True, choices=[('on_track', 'On track'), ('at_risk', 'At risk'), ('off_track', 'Off track')], default=None, max_length=16, null=True),
        ),
    ]
