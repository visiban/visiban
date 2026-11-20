# #1799 step 3 of 5: the board foreign key on card_activities, added NOT VALID.
#
# 0119 added the ``board`` column with ``db_constraint=False`` so Django emitted
# no FOREIGN KEY clause. This adds the constraint by hand as NOT VALID, which is
# catalog-only: it takes ACCESS EXCLUSIVE on card_activities (and SHARE ROW
# EXCLUSIVE on boards) only long enough to write the constraint, not to scan
# the table. New and updated rows are checked from this point on; the existing
# rows, including those 0120 backfilled, are checked once by 0122's VALIDATE
# under a weaker lock. Hand-written because there is no AddConstraintNotValid
# for a ForeignKey (docs/development/database-migrations.md, "A foreign key on
# a column that already holds data"); the constraint name follows Django's
# ``<table>_<column>_fk_<to_table>_<to_column>`` shape without the hash.
#
# Not PostgreSQL: skipped. SQLite cannot add a constraint to an existing table
# without rebuilding it, and those installs have no concurrent traffic to
# protect; the field's Python-level on_delete still applies.
from django.db import migrations

CONSTRAINT = "card_activities_board_id_fk_boards_id"


def add_not_valid(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    schema_editor.execute(
        f"ALTER TABLE card_activities ADD CONSTRAINT {CONSTRAINT} "
        "FOREIGN KEY (board_id) REFERENCES boards (id) "
        "DEFERRABLE INITIALLY DEFERRED NOT VALID"
    )


def drop_not_valid(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    schema_editor.execute(
        f"ALTER TABLE card_activities DROP CONSTRAINT IF EXISTS {CONSTRAINT}"
    )


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0120_backfill_cardactivity_board_snapshots"),
    ]

    operations = [
        migrations.RunPython(add_not_valid, drop_not_valid),
    ]
