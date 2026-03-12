from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0013_board_close_editor_on_enter"),
    ]

    operations = [
        migrations.AddField(
            model_name="board",
            name="allowed_priorities",
            field=models.JSONField(
                default=list,
                help_text="Allowed card priorities on this board. Empty list means all priorities are allowed.",
            ),
        ),
    ]
