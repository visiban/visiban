from django.db import migrations


class Migration(migrations.Migration):
    """Add unique_together constraint on (board, name) for Column.

    Duplicate column names on a board would silently collapse entries in the
    analytics endpoint, which uses column names as dict keys. This constraint
    prevents that data-integrity issue going forward.
    """

    dependencies = [
        ("boards", "0042_add_card_version"),
    ]

    operations = [
        migrations.AlterUniqueTogether(
            name="column",
            unique_together={("board", "position"), ("board", "name")},
        ),
    ]
