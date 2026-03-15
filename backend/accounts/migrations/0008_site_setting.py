from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('accounts', '0007_locale_preferences'),
    ]

    operations = [
        migrations.CreateModel(
            name='SiteSetting',
            fields=[
                ('id', models.AutoField(primary_key=True, serialize=False)),
                ('require_invite_for_registration', models.BooleanField(
                    default=False,
                    help_text=(
                        'When enabled, self-registration is blocked. '
                        'New accounts can only be created by site admins via the admin panel.'
                    ),
                )),
            ],
            options={
                'db_table': 'site_settings',
            },
        ),
    ]
