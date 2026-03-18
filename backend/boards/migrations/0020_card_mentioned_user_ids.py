from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0019_add_card_archived_at"),
    ]

    operations = [
        migrations.AddField(
            model_name="card",
            name="mentioned_user_ids",
            field=models.JSONField(blank=True, default=list),
        ),
    ]
