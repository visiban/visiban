from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("groups", "0002_groupmembership_viewer_role"),
    ]

    operations = [
        migrations.AddField(
            model_name="group",
            name="default_board_member_role",
            field=models.CharField(
                choices=[
                    ("admin", "Admin"),
                    ("member", "Member"),
                    ("collaborator", "Collaborator"),
                    ("viewer", "Viewer"),
                ],
                default="member",
                max_length=20,
            ),
        ),
        migrations.AddField(
            model_name="group",
            name="allowed_priorities",
            field=models.JSONField(default=list),
        ),
        migrations.CreateModel(
            name="GroupLabel",
            fields=[
                ("id", models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.CharField(max_length=50)),
                ("color", models.CharField(default="#EAB308", max_length=7)),
                (
                    "group",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="labels",
                        to="groups.group",
                    ),
                ),
            ],
            options={
                "db_table": "group_labels",
                "unique_together": {("group", "name")},
            },
        ),
    ]
