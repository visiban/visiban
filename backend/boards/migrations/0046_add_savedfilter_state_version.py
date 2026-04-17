# Generated for #698: stamp a schema version on every SavedFilter row so the
# frontend can dispatch to a version-specific migrator the first time
# state_json changes in a non-additive way. Existing rows backfill to 1 via
# the column default (zero-downtime — NOT NULL with default).

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('boards', '0045_add_activity_comment_composite_indexes'),
    ]

    operations = [
        migrations.AddField(
            model_name='savedfilter',
            name='state_version',
            field=models.PositiveSmallIntegerField(
                default=1,
                help_text='Schema version for state_json. Bump when the shape changes in a non-additive way.',
            ),
        ),
    ]
