from django.db import migrations


def deduplicate_column_names(apps, schema_editor):
    """Rename any duplicate (board, name) column pairs before the constraint is added.

    Duplicate column names silently collapse analytics results (names are used as dict
    keys).  A prior version of the application did not enforce uniqueness, so some
    installations may have boards where two columns share a name.  This pass renames
    any duplicate to "Name (2)", "Name (3)", etc. before the constraint is applied so
    the ALTER TABLE does not fail on existing data.
    """
    Column = apps.get_model("boards", "Column")

    seen: dict = {}
    for col in Column.objects.order_by("board_id", "position"):
        key = (col.board_id, col.name)
        if key in seen:
            seen[key] += 1
            col.name = f"{col.name} ({seen[key]})"
            col.save(update_fields=["name"])
        else:
            seen[key] = 1


class Migration(migrations.Migration):
    """Deduplicate column names then add unique_together on (board, name).

    Duplicate column names on a board would silently collapse entries in the
    analytics endpoint, which uses column names as dict keys. The dedup pass
    renames any conflicting columns before the constraint is applied so the
    migration is safe on pre-existing installations.
    """

    dependencies = [
        ("boards", "0042_add_card_version"),
    ]

    operations = [
        # Reverse is a no-op: the dedup pass rewrites column names in place
        # (e.g. "Done" → "Done (2)"). The original duplicate names cannot be
        # recovered from the suffixed forms. Forward is idempotent — a
        # re-run on already-deduped data produces no changes because the
        # (board_id, name) pairs are already unique.
        migrations.RunPython(deduplicate_column_names, migrations.RunPython.noop),
        migrations.AlterUniqueTogether(
            name="column",
            unique_together={("board", "position"), ("board", "name")},
        ),
    ]
