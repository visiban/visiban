from django.db import migrations, models


def set_first_column_allow_creation(apps, schema_editor):
    Column = apps.get_model("boards", "Column")
    Board = apps.get_model("boards", "Board")
    for board in Board.objects.all():
        first = Column.objects.filter(board=board).order_by("position").first()
        if first:
            Column.objects.filter(pk=first.pk).update(allow_card_creation=True)


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0007_add_card_checklists"),
    ]

    operations = [
        migrations.AddField(
            model_name="column",
            name="allow_card_creation",
            field=models.BooleanField(default=False),
        ),
        # Reverse is a no-op: the backfill sets allow_card_creation=True on
        # the left-most column per board. Reversing would require knowing
        # which rows were True before the forward ran, which was never
        # recorded. Forward is idempotent (re-running simply sets the same
        # column True again) so a partial-apply re-run is safe.
        migrations.RunPython(set_first_column_allow_creation, migrations.RunPython.noop),
    ]
