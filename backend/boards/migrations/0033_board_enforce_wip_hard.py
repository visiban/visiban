from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('boards', '0032_add_saved_filter'),
    ]

    operations = [
        migrations.AddField(
            model_name='board',
            name='enforce_wip_hard',
            field=models.BooleanField(
                default=False,
                help_text=(
                    'When True, WIP limits become a hard stop for all roles including board admins. '
                    'No override is possible. Active regardless of enforce_wip_limits.'
                ),
            ),
        ),
    ]
