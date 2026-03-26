from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0033_board_enforce_wip_hard"),
    ]

    operations = [
        migrations.AddField(
            model_name="column",
            name="is_done",
            field=models.BooleanField(default=False),
        ),
    ]
