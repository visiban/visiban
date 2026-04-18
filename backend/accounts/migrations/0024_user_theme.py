# Generated manually for #183 — design token layer and light mode.
#
# Adds a per-user theme preference with values "system" / "dark" / "light".
# Default "system" follows the operating system's prefers-color-scheme. The
# column is non-nullable with a default, so zero-downtime deploys are safe:
# the backfill happens inline when the default is applied.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('accounts', '0023_invitelink_use_count'),
    ]

    operations = [
        migrations.AddField(
            model_name='user',
            name='theme',
            field=models.CharField(
                blank=True,
                choices=[
                    ('system', 'Follow operating system preference'),
                    ('dark', 'Always dark'),
                    ('light', 'Always light'),
                ],
                default='system',
                max_length=8,
            ),
        ),
    ]
