from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0005_add_user_timezone"),
    ]

    operations = [
        migrations.AddField(
            model_name="user",
            name="notif_card_assigned",
            field=models.BooleanField(default=True),
        ),
        migrations.AddField(
            model_name="user",
            name="notif_mentioned",
            field=models.BooleanField(default=True),
        ),
        migrations.AddField(
            model_name="user",
            name="notif_due_soon",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="user",
            name="notif_card_moved",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="user",
            name="notif_comment_added",
            field=models.BooleanField(default=False),
        ),
    ]
