from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0018_add_stable_uids"),
    ]

    operations = [
        migrations.AddField(
            model_name="card",
            name="archived_at",
            field=models.DateTimeField(blank=True, db_index=True, null=True),
        ),
    ]
