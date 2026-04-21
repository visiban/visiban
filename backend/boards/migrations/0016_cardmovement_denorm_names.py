from django.db import migrations, models


def backfill_names(apps, schema_editor):
    CardMovement = apps.get_model("boards", "CardMovement")
    for mv in CardMovement.objects.select_related(
        "from_column", "to_column", "from_swimlane", "to_swimlane"
    ).iterator():
        changed = False
        if mv.from_column_id and mv.from_column:
            mv.from_column_name = mv.from_column.name
            changed = True
        if mv.to_column_id and mv.to_column:
            mv.to_column_name = mv.to_column.name
            changed = True
        if mv.from_swimlane_id and mv.from_swimlane:
            mv.from_swimlane_name = mv.from_swimlane.name
            changed = True
        if mv.to_swimlane_id and mv.to_swimlane:
            mv.to_swimlane_name = mv.to_swimlane.name
            changed = True
        if changed:
            mv.save(update_fields=[
                "from_column_name", "to_column_name",
                "from_swimlane_name", "to_swimlane_name",
            ])


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0015_boardfavorite"),
    ]

    operations = [
        migrations.AddField(
            model_name="cardmovement",
            name="from_column_name",
            field=models.CharField(blank=True, default="", max_length=255),
        ),
        migrations.AddField(
            model_name="cardmovement",
            name="to_column_name",
            field=models.CharField(blank=True, default="", max_length=255),
        ),
        migrations.AddField(
            model_name="cardmovement",
            name="from_swimlane_name",
            field=models.CharField(blank=True, default="", max_length=255),
        ),
        migrations.AddField(
            model_name="cardmovement",
            name="to_swimlane_name",
            field=models.CharField(blank=True, default="", max_length=255),
        ),
        # Reverse is a no-op: the denormalized name columns are added by
        # this migration, so a reverse would drop them anyway via the
        # AddField reverse. Forward is idempotent — re-running copies the
        # current FK.name into the denorm column; existing values are
        # overwritten with the same values for live FKs and left unchanged
        # for deleted FKs.
        migrations.RunPython(backfill_names, migrations.RunPython.noop),
    ]
