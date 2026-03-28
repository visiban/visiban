from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("groups", "0009_group_description_field"),
    ]

    operations = [
        migrations.AddField(
            model_name="groupinvitelink",
            name="token_hash",
            field=models.CharField(
                db_index=True, max_length=64, null=True, unique=True
            ),
        ),
        migrations.AddField(
            model_name="groupinvitelink",
            name="prefix",
            field=models.CharField(blank=True, default="", max_length=8),
        ),
    ]
