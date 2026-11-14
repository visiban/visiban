# #2242: health status change history. A new group history table (its
# indexes are built with it: the table is new, so no rows and no readers) and
# three nullable last-change columns on groups with no database default, so
# each ADD COLUMN is a catalog-only change on PostgreSQL. The FK column is
# added with db_index=False; its index is built concurrently in 0026_group_health_changed_by_idx.

import django.db.models.deletion
import django.db.models.functions.datetime
from django.conf import settings
from django.db import migrations, models

STATUS_CHOICES = [("on_track", "On track"), ("at_risk", "At risk"), ("off_track", "Off track")]


class Migration(migrations.Migration):

    dependencies = [
        ("groups", "0024_group_health_status"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name="group",
            name="health_status_changed_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="group",
            name="health_status_changed_by",
            field=models.ForeignKey(
                blank=True, db_index=False, null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="+", to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddField(
            model_name="group",
            name="health_status_note",
            field=models.CharField(blank=True, max_length=280, null=True),
        ),
        migrations.CreateModel(
            name="GroupHealthChange",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("from_status", models.CharField(blank=True, choices=STATUS_CHOICES, max_length=16, null=True)),
                ("to_status", models.CharField(blank=True, choices=STATUS_CHOICES, max_length=16, null=True)),
                ("changed_at", models.DateTimeField(db_default=django.db.models.functions.datetime.Now())),
                ("note", models.CharField(blank=True, max_length=280, null=True)),
                ("changed_by", models.ForeignKey(
                    blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                    related_name="+", to=settings.AUTH_USER_MODEL,
                )),
                ("group", models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name="health_changes", to="groups.group",
                )),
            ],
            options={
                "db_table": "group_health_changes",
                "indexes": [
                    models.Index(fields=["group", "-changed_at", "-id"], name="group_health_change_idx"),
                ],
            },
        ),
    ]
