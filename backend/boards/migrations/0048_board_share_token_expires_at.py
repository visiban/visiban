from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0047_add_cardchecklist_card_pos_index"),
    ]

    operations = [
        migrations.AddField(
            model_name="board",
            name="share_token_expires_at",
            field=models.DateTimeField(
                blank=True,
                default=None,
                help_text=(
                    "Optional TTL on the public share link (#804). Null means the token "
                    "never expires. Past this timestamp the share endpoint returns 410 "
                    "Gone — the token is not auto-rotated, only refused."
                ),
                null=True,
            ),
        ),
    ]
