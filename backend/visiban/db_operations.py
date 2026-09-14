"""Vendor-aware wrappers around PostgreSQL's concurrent DDL migration operations.

Why this module exists
----------------------
``django.contrib.postgres.operations`` gives us ``CREATE INDEX CONCURRENTLY`` and
``ADD CONSTRAINT ... NOT VALID``, which is exactly what Visiban needs: both build
without taking ``ACCESS EXCLUSIVE`` on the table, so ``migrate`` no longer blocks
every read and write to ``cards`` for the duration of an index build (#1081).

They cannot be used directly, though. Every one of them emits PostgreSQL-only SQL
with no vendor guard — ``AddIndexConcurrently`` calls
``schema_editor.add_index(..., concurrently=True)``, a keyword the SQLite schema
editor does not accept, and ``ValidateConstraint`` executes a bare
``ALTER TABLE ... VALIDATE CONSTRAINT``. Visiban supports a SQLite configuration
for local development and small single-user installs, and those installs still run
``migrate``. A migration written against the raw operations would therefore be
un-runnable there.

These wrappers keep the concurrent path on PostgreSQL and fall back to the plain,
transactional operation everywhere else — where the fallback is harmless, because
SQLite takes a whole-database lock for any DDL regardless and those installs have
no concurrent traffic to protect.

Usage
-----
Set ``atomic = False`` on the ``Migration`` class. ``CREATE INDEX CONCURRENTLY``
cannot run inside a transaction, and Django wraps every migration in one by
default; without it the operation raises ``NotSupportedError`` on PostgreSQL::

    from django.db import migrations, models

    from visiban.db_operations import AddIndexConcurrently


    class Migration(migrations.Migration):
        atomic = False  # required: CREATE INDEX CONCURRENTLY cannot run in a transaction

        dependencies = [("boards", "0051_board_card_density")]

        operations = [
            AddIndexConcurrently(
                model_name="card",
                index=models.Index(fields=["board", "due_at"], name="card_board_due_idx"),
            ),
        ]

See ``docs/development/database-migrations.md`` for the full pattern, including
the check-constraint and unique-constraint variants and the failure modes of
``atomic = False``.
"""

from __future__ import annotations

from django.contrib.postgres.operations import (
    AddConstraintNotValid as _PgAddConstraintNotValid,
)
from django.contrib.postgres.operations import (
    AddIndexConcurrently as _PgAddIndexConcurrently,
)
from django.contrib.postgres.operations import (
    RemoveIndexConcurrently as _PgRemoveIndexConcurrently,
)
from django.contrib.postgres.operations import (
    ValidateConstraint as _PgValidateConstraint,
)
from django.db.migrations import AddConstraint, AddIndex, RemoveIndex

__all__ = [
    "AddConstraintNotValid",
    "AddIndexConcurrently",
    "RemoveIndexConcurrently",
    "ValidateConstraint",
]


def _is_postgresql(schema_editor) -> bool:
    return schema_editor.connection.vendor == "postgresql"


class AddIndexConcurrently(_PgAddIndexConcurrently):
    """``CREATE INDEX CONCURRENTLY`` on PostgreSQL, plain ``CREATE INDEX`` elsewhere."""

    def database_forwards(self, app_label, schema_editor, from_state, to_state):
        if not _is_postgresql(schema_editor):
            AddIndex.database_forwards(
                self, app_label, schema_editor, from_state, to_state
            )
            return
        super().database_forwards(app_label, schema_editor, from_state, to_state)

    def database_backwards(self, app_label, schema_editor, from_state, to_state):
        if not _is_postgresql(schema_editor):
            AddIndex.database_backwards(
                self, app_label, schema_editor, from_state, to_state
            )
            return
        super().database_backwards(app_label, schema_editor, from_state, to_state)


class RemoveIndexConcurrently(_PgRemoveIndexConcurrently):
    """``DROP INDEX CONCURRENTLY`` on PostgreSQL, plain ``DROP INDEX`` elsewhere."""

    def database_forwards(self, app_label, schema_editor, from_state, to_state):
        if not _is_postgresql(schema_editor):
            RemoveIndex.database_forwards(
                self, app_label, schema_editor, from_state, to_state
            )
            return
        super().database_forwards(app_label, schema_editor, from_state, to_state)

    def database_backwards(self, app_label, schema_editor, from_state, to_state):
        if not _is_postgresql(schema_editor):
            RemoveIndex.database_backwards(
                self, app_label, schema_editor, from_state, to_state
            )
            return
        super().database_backwards(app_label, schema_editor, from_state, to_state)


class AddConstraintNotValid(_PgAddConstraintNotValid):
    """``ADD CONSTRAINT ... NOT VALID`` on PostgreSQL, a normal add elsewhere.

    PostgreSQL-only, and check constraints only — ``AddConstraintNotValid`` rejects
    anything that is not a ``CheckConstraint`` at construction time, because
    ``NOT VALID`` is not accepted for unique or exclusion constraints. Adding a
    unique constraint concurrently needs ``CREATE UNIQUE INDEX CONCURRENTLY``
    followed by ``ADD CONSTRAINT ... USING INDEX``; see the docs page.

    On a non-PostgreSQL backend the constraint is added and validated in one step
    (there is no ``NOT VALID`` to defer), so the paired ``ValidateConstraint``
    below becomes a no-op rather than failing on unsupported SQL.

    ``atomic = False`` is not optional for the pair. ``ADD CONSTRAINT ... NOT VALID``
    takes a brief ``ACCESS EXCLUSIVE`` to update the catalog; ``VALIDATE CONSTRAINT``
    then scans the table under the much weaker ``SHARE UPDATE EXCLUSIVE``. Run both
    inside one transaction and the ``ACCESS EXCLUSIVE`` is held until commit — across
    the whole scan — which is the exact outage the pattern exists to avoid.
    """

    def database_forwards(self, app_label, schema_editor, from_state, to_state):
        if not _is_postgresql(schema_editor):
            AddConstraint.database_forwards(
                self, app_label, schema_editor, from_state, to_state
            )
            return
        super().database_forwards(app_label, schema_editor, from_state, to_state)


class ValidateConstraint(_PgValidateConstraint):
    """``ALTER TABLE ... VALIDATE CONSTRAINT`` on PostgreSQL, a no-op elsewhere.

    The no-op is correct rather than a shortcut: on a non-PostgreSQL backend the
    paired :class:`AddConstraintNotValid` already added the constraint in its fully
    validated form, so there is nothing left to validate.
    """

    def database_forwards(self, app_label, schema_editor, from_state, to_state):
        if not _is_postgresql(schema_editor):
            return
        super().database_forwards(app_label, schema_editor, from_state, to_state)
