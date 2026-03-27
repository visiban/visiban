from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0032_add_saved_filter"),
    ]

    operations = [
        migrations.AddField(
            model_name="column",
            name="is_done",
            field=models.BooleanField(
                default=False,
                help_text="Columns marked as done are used as completion targets for cycle-time and throughput metrics.",
            ),
        ),
    ]
