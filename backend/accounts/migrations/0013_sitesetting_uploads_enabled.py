from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0012_user_close_editor_on_enter_default_true"),
    ]

    operations = [
        migrations.AddField(
            model_name="sitesetting",
            name="uploads_enabled",
            field=models.BooleanField(
                default=True,
                help_text="When False, attachment uploads are disabled for all users.",
            ),
        ),
    ]
