import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0008_column_allow_card_creation"),
        ("groups", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="board",
            name="group",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="boards",
                to="groups.group",
            ),
        ),
    ]
