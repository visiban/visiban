# #2594 step 2 of 4: the assigned_by foreign key on card_activities, added
# NOT VALID.
#
# 0141 added the column with ``db_constraint=False``. NOT VALID is
# catalog-only: ACCESS EXCLUSIVE on card_activities (and SHARE ROW EXCLUSIVE on
# users) only long enough to write the constraint, never across a table scan.
# Every existing row is NULL, so 0143's VALIDATE has nothing to reject.
# Hand-written like 0135: there is no AddConstraintNotValid for a ForeignKey.
#
# Not PostgreSQL: skipped (SQLite cannot add a constraint without a rebuild);
# the field's Python-level on_delete still applies.
from django.db import migrations

CONSTRAINT = "card_activities_assigned_by_id_fk_users_id"


def add_not_valid(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    schema_editor.execute(
        f"ALTER TABLE card_activities ADD CONSTRAINT {CONSTRAINT} "
        "FOREIGN KEY (assigned_by_id) REFERENCES users (id) "
        "DEFERRABLE INITIALLY DEFERRED NOT VALID"
    )


def drop_not_valid(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    schema_editor.execute(f"ALTER TABLE card_activities DROP CONSTRAINT IF EXISTS {CONSTRAINT}")


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0141_activity_assigned_by"),
    ]

    operations = [
        migrations.RunPython(add_not_valid, drop_not_valid),
    ]
