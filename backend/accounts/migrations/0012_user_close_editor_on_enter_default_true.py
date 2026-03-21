from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0011_user_default_board"),
    ]

    operations = [
        migrations.AlterField(
            model_name="user",
            name="close_editor_on_enter",
            field=models.BooleanField(default=True),
        ),
    ]
