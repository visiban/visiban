from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0004_add_must_change_password"),
    ]

    operations = [
        migrations.AddField(
            model_name="user",
            name="timezone",
            field=models.CharField(blank=True, default="", max_length=64),
        ),
    ]
