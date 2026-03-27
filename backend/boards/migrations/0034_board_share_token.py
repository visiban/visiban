from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0033_column_is_done"),
    ]

    operations = [
        migrations.AddField(
            model_name="board",
            name="share_token",
            field=models.UUIDField(
                blank=True,
                default=None,
                editable=False,
                help_text="Public share token. Null means sharing is disabled. Never set directly — use the share action.",
                null=True,
                unique=True,
            ),
        ),
    ]
