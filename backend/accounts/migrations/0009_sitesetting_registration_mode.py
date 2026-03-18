from django.db import migrations, models


class Migration(migrations.Migration):
    """
    Replace the boolean require_invite_for_registration with a three-way
    registration_mode TextChoices field (open / invite_only / closed).

    Data migration: existing rows with require_invite_for_registration=True
    are mapped to 'invite_only'; False maps to 'open'.
    """

    dependencies = [
        ('accounts', '0008_site_setting'),
    ]

    operations = [
        migrations.AddField(
            model_name='sitesetting',
            name='registration_mode',
            field=models.CharField(
                choices=[
                    ('open', 'Open \u2014 anyone can register'),
                    ('invite_only', 'Invite-only \u2014 only users with a valid invite link can register'),
                    ('closed', 'Closed \u2014 self-registration is disabled; admins create accounts manually'),
                ],
                default='open',
                max_length=16,
                help_text="Controls who can self-register. 'open' = anyone; 'invite_only' = valid invite link required; 'closed' = admin-created accounts only.",
            ),
        ),
        # Data migration: map the old boolean to the new enum value.
        migrations.RunSQL(
            sql="""
                UPDATE site_settings
                SET registration_mode = CASE
                    WHEN require_invite_for_registration THEN 'invite_only'
                    ELSE 'open'
                END;
            """,
            reverse_sql="""
                UPDATE site_settings
                SET require_invite_for_registration = (registration_mode != 'open');
            """,
        ),
        migrations.RemoveField(
            model_name='sitesetting',
            name='require_invite_for_registration',
        ),
    ]
