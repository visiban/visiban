from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0012_board_staleness_threshold_notification"),
    ]

    operations = [
        migrations.AddField(
            model_name="board",
            name="close_editor_on_enter",
            field=models.BooleanField(default=True),
        ),
    ]
