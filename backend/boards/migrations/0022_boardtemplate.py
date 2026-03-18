import uuid
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0021_remove_board_close_editor_on_enter"),
    ]

    operations = [
        migrations.CreateModel(
            name="BoardTemplate",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("name", models.CharField(max_length=100)),
                ("slug", models.SlugField(max_length=100, unique=True)),
                ("description", models.CharField(max_length=120)),
                ("icon", models.CharField(blank=True, max_length=32)),
                ("lane_label", models.CharField(
                    blank=True,
                    help_text="Label shown in the swimlane prompt (e.g. 'Account', 'Project').",
                    max_length=50,
                )),
                ("lane_placeholder", models.CharField(
                    blank=True,
                    help_text="Placeholder text in the first-swimlane name input.",
                    max_length=100,
                )),
                ("columns_json", models.JSONField(
                    default=list,
                    help_text="Ordered list of column dicts: [{name, color, position}].",
                )),
                ("sort_order", models.PositiveSmallIntegerField(default=0)),
                ("is_active", models.BooleanField(default=True)),
            ],
            options={
                "db_table": "board_templates",
                "ordering": ["sort_order", "name"],
            },
        ),
    ]
