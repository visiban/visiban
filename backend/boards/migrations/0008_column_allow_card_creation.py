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
        migrations.RunPython(set_first_column_allow_creation, migrations.RunPython.noop),
    ]
