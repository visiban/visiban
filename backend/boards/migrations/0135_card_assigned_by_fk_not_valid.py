# #1923 step 2 of 4: the assigned_by foreign key on cards, added NOT VALID.
#
# 0134 added the column with ``db_constraint=False``. NOT VALID is
# catalog-only: ACCESS EXCLUSIVE on cards (and SHARE ROW EXCLUSIVE on users)
# only long enough to write the constraint, never across a table scan. Every
# existing row is NULL, so 0136's VALIDATE has nothing to reject. Hand-written
# like 0121: there is no AddConstraintNotValid for a ForeignKey.
#
# Not PostgreSQL: skipped (SQLite cannot add a constraint without a rebuild);
# the field's Python-level on_delete still applies.
from django.db import migrations

CONSTRAINT = "cards_assigned_by_id_fk_users_id"


def add_not_valid(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    schema_editor.execute(
        f"ALTER TABLE cards ADD CONSTRAINT {CONSTRAINT} "
        "FOREIGN KEY (assigned_by_id) REFERENCES users (id) "
        "DEFERRABLE INITIALLY DEFERRED NOT VALID"
    )


def drop_not_valid(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    schema_editor.execute(f"ALTER TABLE cards DROP CONSTRAINT IF EXISTS {CONSTRAINT}")


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0134_assignee_override_audit"),
    ]

    operations = [
        migrations.RunPython(add_not_valid, drop_not_valid),
    ]
