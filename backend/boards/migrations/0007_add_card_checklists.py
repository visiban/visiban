from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0006_alter_swimlane_board"),
    ]

    operations = [
        migrations.CreateModel(
            name="CardChecklist",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("text", models.CharField(max_length=500)),
                ("is_checked", models.BooleanField(default=False)),
                ("position", models.IntegerField(default=0)),
                ("card", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="checklist_items", to="boards.card")),
            ],
            options={
                "db_table": "card_checklist_items",
                "ordering": ["position"],
            },
        ),
    ]
