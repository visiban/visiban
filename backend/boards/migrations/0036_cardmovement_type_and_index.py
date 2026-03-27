from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0035_merge_enforce_wip_hard_share_token"),
    ]

    operations = [
        migrations.AddField(
            model_name="cardmovement",
            name="movement_type",
            field=models.CharField(
                choices=[
                    ("move", "Move"),
                    ("archived", "Archived"),
                    ("unarchived", "Unarchived"),
                ],
                default="move",
                max_length=20,
            ),
        ),
        migrations.AlterField(
            model_name="cardmovement",
            name="moved_at",
            field=models.DateTimeField(auto_now_add=True, db_index=True),
        ),
    ]
