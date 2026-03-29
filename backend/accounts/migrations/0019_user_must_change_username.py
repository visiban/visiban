from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0018_add_notif_board_invite"),
    ]

    operations = [
        migrations.AddField(
            model_name="user",
            name="must_change_username",
            field=models.BooleanField(default=False),
        ),
    ]
