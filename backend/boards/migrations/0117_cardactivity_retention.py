# #1799 step 1 of 3: CardActivity survives a card hard delete, like
# CardMovement since #1469 (migrations 0078-0081, whose pattern this follows).
#
# PostgreSQL locking: every operation here is catalog-only.
# - ``board`` is a new nullable column, so the FK Django adds inline with
#   ADD COLUMN ... REFERENCES has nothing to validate. ``db_index=False``
#   keeps Django from building the implicit FK index here under ACCESS
#   EXCLUSIVE; the composite (board, -created_at) index is built concurrently
#   in 0119, after the 0118 backfill.
# - ``card_uid`` / ``card_title`` carry ``db_default=""`` (a constant default
#   is metadata-only on PostgreSQL 11+), which also keeps an INSERT from an
#   older release, which does not know these columns, working mid-upgrade.
# - ``card`` becomes nullable with ``ALTER COLUMN ... DROP NOT NULL`` only. A
#   plain AlterField would drop and re-add the foreign key, and the re-ADD
#   validates every card_activities row against cards under ACCESS EXCLUSIVE
#   (see 0079 and docs/development/database-migrations.md, "Changing an
#   existing foreign key's nullability"). ``on_delete`` emits no SQL.
# See docs/development/database-migrations.md.
import django.db.models.deletion
from django.db import migrations, models

import boards.models


class DropNotNullKeepingForeignKey(migrations.AlterField):
    """``AlterField`` whose PostgreSQL DDL is only ``ALTER COLUMN ... DROP NOT NULL``.

    A copy of 0079's operation (migrations stay self-contained, so a later
    squash of 0079 cannot break this one). Use it only when ``null`` (and
    Python-only attributes such as ``on_delete``) is the sole difference.
    """

    def _table_and_column(self, app_label, state):
        model = state.apps.get_model(app_label, self.model_name)
        return model._meta.db_table, model._meta.get_field(self.name).column

    def database_forwards(self, app_label, schema_editor, from_state, to_state):
        if schema_editor.connection.vendor != "postgresql":
            return super().database_forwards(app_label, schema_editor, from_state, to_state)
        table, column = self._table_and_column(app_label, to_state)
        qn = schema_editor.quote_name
        schema_editor.execute(f"ALTER TABLE {qn(table)} ALTER COLUMN {qn(column)} DROP NOT NULL")

    def database_backwards(self, app_label, schema_editor, from_state, to_state):
        # Reversing would need every row to have a card again. Rows whose card
        # was hard-deleted are retained audit history: refuse rather than
        # silently delete them, and say how to proceed deliberately.
        table, column = self._table_and_column(app_label, from_state)
        qn = schema_editor.quote_name
        with schema_editor.connection.cursor() as cursor:
            cursor.execute(f"SELECT 1 FROM {qn(table)} WHERE {qn(column)} IS NULL LIMIT 1")
            if cursor.fetchone() is not None:
                raise RuntimeError(
                    f"Cannot reverse boards.0117: {table} holds activity history of "
                    f"hard-deleted cards ({column} IS NULL). Restoring NOT NULL would "
                    f"require deleting that history. If that is intended, run "
                    f"DELETE FROM {table} WHERE {column} IS NULL; and migrate again."
                )
        if schema_editor.connection.vendor != "postgresql":
            return super().database_backwards(app_label, schema_editor, from_state, to_state)
        # SET NOT NULL scans the table under ACCESS EXCLUSIVE; acceptable for a
        # rollback, which is an offline operation anyway.
        schema_editor.execute(f"ALTER TABLE {qn(table)} ALTER COLUMN {qn(column)} SET NOT NULL")


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0116_cardmovement_board_moved_id_idx"),
    ]

    operations = [
        migrations.AddField(
            model_name="cardactivity",
            name="board",
            field=models.ForeignKey(
                blank=True,
                db_index=False,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="+",
                to="boards.board",
            ),
        ),
        migrations.AddField(
            model_name="cardactivity",
            name="card_title",
            field=models.CharField(blank=True, db_default="", default="", max_length=500),
        ),
        migrations.AddField(
            model_name="cardactivity",
            name="card_uid",
            field=models.CharField(blank=True, db_default="", default="", max_length=16),
        ),
        DropNotNullKeepingForeignKey(
            model_name="cardactivity",
            name="card",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=boards.models.set_null_keeping_board,
                related_name="activities",
                to="boards.card",
            ),
        ),
    ]
