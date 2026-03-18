from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0010_user_close_editor_on_enter"),
        ("boards", "0023_seed_board_templates"),
    ]

    operations = [
        migrations.AddField(
            model_name="user",
            name="default_board",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="+",
                to="boards.board",
            ),
        ),
    ]
