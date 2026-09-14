"""Tests for the concurrent index/constraint migration pattern (#1081).

Three things are under test here:

1. ``visiban.db_operations`` — the vendor-aware wrappers actually build the index
   on whichever backend the suite is running against, and dispatch to the
   ``CONCURRENTLY`` path only on PostgreSQL.
2. ``check_migration_concurrency`` — the scanner that keeps plain ``AddIndex`` /
   ``AddConstraint`` out of new migrations.
3. The repository baseline — the grandfathered list still matches the tree, so a
   squash or a new migration cannot silently widen the exemption.
"""

import textwrap
from io import StringIO
from pathlib import Path
from unittest import mock

from django.apps import apps
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection, models
from django.db.migrations.state import ProjectState
from django.test import SimpleTestCase, TransactionTestCase

from boards.management.commands.check_migration_concurrency import (
    EXEMPT_MARKER,
    GRANDFATHERED,
    scan_source,
)
from visiban.db_operations import AddIndexConcurrently, ValidateConstraint

BACKEND_ROOT = Path(__file__).resolve().parents[2]

TEST_INDEX_NAME = "tmp_1081_concurrency_idx"


class _FakeConnection:
    def __init__(self, vendor):
        self.vendor = vendor
        self.alias = "default"
        self.in_atomic_block = False


class _FakeSchemaEditor:
    """Records which index API the operation reached for, and with what kwargs."""

    def __init__(self, vendor):
        self.connection = _FakeConnection(vendor)
        self.calls = []

    def add_index(self, model, index, **kwargs):
        self.calls.append(("add_index", kwargs))

    def remove_index(self, model, index, **kwargs):
        self.calls.append(("remove_index", kwargs))

    def execute(self, sql, params=None):
        self.calls.append(("execute", sql))

    def quote_name(self, name):
        return f'"{name}"'


class VendorDispatchTests(SimpleTestCase):
    """The wrappers must not emit PostgreSQL-only SQL on a SQLite install."""

    def setUp(self):
        self.index = models.Index(fields=["board"], name=TEST_INDEX_NAME)
        self.state = ProjectState.from_apps(apps)

    def test_add_index_uses_concurrently_on_postgresql(self):
        editor = _FakeSchemaEditor("postgresql")
        op = AddIndexConcurrently(model_name="card", index=self.index)

        op.database_forwards("boards", editor, self.state, self.state)

        self.assertEqual(editor.calls, [("add_index", {"concurrently": True})])

    def test_add_index_falls_back_to_plain_create_on_sqlite(self):
        editor = _FakeSchemaEditor("sqlite")
        op = AddIndexConcurrently(model_name="card", index=self.index)

        op.database_forwards("boards", editor, self.state, self.state)

        # No `concurrently` kwarg — the SQLite schema editor does not accept one.
        self.assertEqual(editor.calls, [("add_index", {})])

    def test_reverse_drops_concurrently_on_postgresql(self):
        editor = _FakeSchemaEditor("postgresql")
        op = AddIndexConcurrently(model_name="card", index=self.index)

        op.database_backwards("boards", editor, self.state, self.state)

        self.assertEqual(editor.calls, [("remove_index", {"concurrently": True})])

    def test_reverse_falls_back_to_plain_drop_on_sqlite(self):
        editor = _FakeSchemaEditor("sqlite")
        op = AddIndexConcurrently(model_name="card", index=self.index)

        op.database_backwards("boards", editor, self.state, self.state)

        self.assertEqual(editor.calls, [("remove_index", {})])

    def test_validate_constraint_is_a_noop_off_postgresql(self):
        # AddConstraintNotValid already added the constraint in validated form on a
        # non-PostgreSQL backend, so there is nothing to validate — and the raw
        # `ALTER TABLE ... VALIDATE CONSTRAINT` would be a syntax error there.
        editor = _FakeSchemaEditor("sqlite")
        op = ValidateConstraint(model_name="card", name="whatever")

        op.database_forwards("boards", editor, self.state, self.state)

        self.assertEqual(editor.calls, [])

    def test_validate_constraint_runs_on_postgresql(self):
        editor = _FakeSchemaEditor("postgresql")
        op = ValidateConstraint(model_name="card", name="whatever")

        op.database_forwards("boards", editor, self.state, self.state)

        self.assertEqual(len(editor.calls), 1)
        self.assertIn("VALIDATE CONSTRAINT", editor.calls[0][1])


class ConcurrentIndexRoundTripTests(TransactionTestCase):
    """Build and drop a real index through the wrappers on the configured backend.

    ``TransactionTestCase`` rather than ``TestCase``: ``CREATE INDEX CONCURRENTLY``
    refuses to run inside a transaction, and ``TestCase`` wraps every test in one.
    This is the same constraint that forces ``atomic = False`` on the migration.
    """

    def _index_names(self):
        with connection.cursor() as cursor:
            return set(connection.introspection.get_constraints(cursor, "cards"))

    def test_index_is_created_and_dropped(self):
        index = models.Index(fields=["board"], name=TEST_INDEX_NAME)
        state = ProjectState.from_apps(apps)
        add = AddIndexConcurrently(model_name="card", index=index)

        self.assertNotIn(TEST_INDEX_NAME, self._index_names())

        with connection.schema_editor(atomic=False) as editor:
            add.database_forwards("boards", editor, state, state)
        try:
            self.assertIn(TEST_INDEX_NAME, self._index_names())
            if connection.vendor == "postgresql":
                # A CONCURRENTLY build that is interrupted leaves an INVALID index
                # behind that silently serves no queries — assert we did not.
                with connection.cursor() as cursor:
                    cursor.execute(
                        "SELECT indisvalid FROM pg_index "
                        "WHERE indexrelid = %s::regclass",
                        [TEST_INDEX_NAME],
                    )
                    self.assertTrue(cursor.fetchone()[0])
        finally:
            with connection.schema_editor(atomic=False) as editor:
                add.database_backwards("boards", editor, state, state)

        self.assertNotIn(TEST_INDEX_NAME, self._index_names())


class ScannerTests(SimpleTestCase):
    """Unit tests for the AST scan behind `manage.py check_migration_concurrency`."""

    def _scan(self, source):
        self._source = textwrap.dedent(source)
        return scan_source(self._source, "boards/migrations/0099_x.py")

    def _line(self, violation):
        """The source line a violation points at — asserts we flagged the right one."""
        return self._source.splitlines()[violation.line - 1]

    def test_flags_plain_add_index(self):
        findings = self._scan(
            """
            from django.db import migrations, models

            class Migration(migrations.Migration):
                operations = [
                    migrations.AddIndex(
                        model_name="card",
                        index=models.Index(fields=["board"], name="x_idx"),
                    ),
                ]
            """
        )
        self.assertEqual([f.operation for f in findings], ["AddIndex"])

    def test_flags_plain_add_constraint(self):
        findings = self._scan(
            """
            from django.db import migrations, models

            class Migration(migrations.Migration):
                operations = [
                    migrations.AddConstraint(
                        model_name="card",
                        constraint=models.CheckConstraint(
                            condition=models.Q(position__gte=0), name="x_chk"
                        ),
                    ),
                ]
            """
        )
        self.assertEqual([f.operation for f in findings], ["AddConstraint"])

    def test_accepts_the_concurrent_operations(self):
        findings = self._scan(
            """
            from django.db import migrations, models

            from visiban.db_operations import AddConstraintNotValid, AddIndexConcurrently

            class Migration(migrations.Migration):
                atomic = False
                operations = [
                    AddIndexConcurrently(
                        model_name="card",
                        index=models.Index(fields=["board"], name="x_idx"),
                    ),
                    AddConstraintNotValid(
                        model_name="card",
                        constraint=models.CheckConstraint(
                            condition=models.Q(position__gte=0), name="x_chk"
                        ),
                    ),
                ]
            """
        )
        self.assertEqual(findings, [])

    def test_flags_db_index_turned_on_for_an_existing_column(self):
        # Migration 0036 built an index exactly this way, never touching AddIndex.
        # A checker that only matched AddIndex would leave the rule evadable.
        findings = self._scan(
            """
            from django.db import migrations, models

            class Migration(migrations.Migration):
                operations = [
                    migrations.AlterField(
                        model_name="cardmovement",
                        name="moved_at",
                        field=models.DateTimeField(auto_now_add=True, db_index=True),
                    ),
                ]
            """
        )
        self.assertEqual([f.operation for f in findings], ["AlterField(db_index=True)"])

    def test_flags_db_index_on_a_field_added_to_an_existing_table(self):
        findings = self._scan(
            """
            from django.db import migrations, models

            class Migration(migrations.Migration):
                operations = [
                    migrations.AddField(
                        model_name="card",
                        name="archived_at",
                        field=models.DateTimeField(null=True, db_index=True),
                    ),
                ]
            """
        )
        self.assertEqual([f.operation for f in findings], ["AddField(db_index=True)"])

    def test_flags_unique_turned_on_for_an_existing_column(self):
        # Migration 0018 did this five times, once on `cards`. unique=True makes
        # Django build a unique index — same lock class, no AddIndex in sight.
        findings = self._scan(
            """
            from django.db import migrations, models

            class Migration(migrations.Migration):
                operations = [
                    migrations.AlterField(
                        model_name="card",
                        name="uid",
                        field=models.CharField(max_length=16, unique=True),
                    ),
                ]
            """
        )
        self.assertEqual([f.operation for f in findings], ["AlterField(unique=True)"])

    def test_flags_unique_on_a_field_added_to_an_existing_table(self):
        findings = self._scan(
            """
            from django.db import migrations, models

            class Migration(migrations.Migration):
                operations = [
                    migrations.AddField(
                        model_name="board",
                        name="share_token",
                        field=models.CharField(max_length=32, null=True, unique=True),
                    ),
                ]
            """
        )
        self.assertEqual([f.operation for f in findings], ["AddField(unique=True)"])

    def test_flags_alter_unique_together(self):
        # Migration 0043's shape. Rebuilds the table's constraint set in place.
        findings = self._scan(
            """
            from django.db import migrations

            class Migration(migrations.Migration):
                operations = [
                    migrations.AlterUniqueTogether(
                        name="column",
                        unique_together={("board", "name")},
                    ),
                ]
            """
        )
        self.assertEqual([f.operation for f in findings], ["AlterUniqueTogether"])

    def test_ignores_unique_inside_create_model(self):
        findings = self._scan(
            """
            from django.db import migrations, models

            class Migration(migrations.Migration):
                operations = [
                    migrations.CreateModel(
                        name="CardReminder",
                        fields=[
                            ("uid", models.CharField(max_length=16, unique=True)),
                        ],
                    ),
                ]
            """
        )
        self.assertEqual(findings, [])

    def test_ignores_db_index_inside_create_model(self):
        # A table created in this migration has no rows and no readers, so the lock
        # is uncontended by construction — no exemption comment needed.
        findings = self._scan(
            """
            from django.db import migrations, models

            class Migration(migrations.Migration):
                operations = [
                    migrations.CreateModel(
                        name="CardReminder",
                        fields=[
                            ("remind_at", models.DateTimeField(db_index=True)),
                        ],
                    ),
                ]
            """
        )
        self.assertEqual(findings, [])

    def test_flags_raw_create_index_sql(self):
        # Migration 0030 builds its GIN indexes this way; a pure AST check that only
        # looked at operation names would be structurally blind to it.
        findings = self._scan(
            """
            from django.db import migrations

            class Migration(migrations.Migration):
                operations = [
                    migrations.RunSQL(
                        "CREATE INDEX card_title_trgm_idx ON cards USING gin (title);"
                    ),
                ]
            """
        )
        self.assertEqual([f.operation for f in findings], ["raw CREATE INDEX"])

    def test_accepts_raw_create_index_concurrently(self):
        findings = self._scan(
            """
            from django.db import migrations

            class Migration(migrations.Migration):
                atomic = False
                operations = [
                    migrations.RunSQL(
                        "CREATE UNIQUE INDEX CONCURRENTLY card_slug_uniq ON cards (slug);"
                    ),
                ]
            """
        )
        self.assertEqual(findings, [])

    def test_squashed_migrations_are_not_relinted(self):
        # A squash reproduces operations written long before this rule, under
        # original filenames that no longer exist on disk to be grandfathered.
        findings = self._scan(
            """
            from django.db import migrations, models

            class Migration(migrations.Migration):
                replaces = [("boards", "0024_enforce_wip_limits_and_card_index")]
                operations = [
                    migrations.AddIndex(
                        model_name="card",
                        index=models.Index(fields=["board"], name="x_idx"),
                    ),
                ]
            """
        )
        self.assertEqual(findings, [])

    def test_constraint_guidance_differs_by_constraint_type(self):
        unique = self._scan(
            """
            from django.db import migrations, models
            from django.db.models.functions import Lower

            class Migration(migrations.Migration):
                operations = [
                    migrations.AddConstraint(
                        model_name="user",
                        constraint=models.UniqueConstraint(
                            Lower("username"), name="unique_username_ci"
                        ),
                    ),
                ]
            """
        )
        check = self._scan(
            """
            from django.db import migrations, models

            class Migration(migrations.Migration):
                operations = [
                    migrations.AddConstraint(
                        model_name="card",
                        constraint=models.CheckConstraint(
                            condition=models.Q(position__gte=0), name="x_chk"
                        ),
                    ),
                ]
            """
        )
        # NOT VALID is not accepted for unique constraints — telling the author to
        # use AddConstraintNotValid there would be guidance that cannot work.
        self.assertEqual(unique[0].guidance_key, "UniqueConstraint")
        self.assertNotIn("AddConstraintNotValid", unique[0].render())
        self.assertEqual(check[0].guidance_key, "CheckConstraint")
        self.assertIn("AddConstraintNotValid", check[0].render())

    def test_ignores_state_only_operations(self):
        # This is the shape migration 0030 uses: the DDL is issued by a
        # vendor-guarded RunPython/RunSQL and AddIndex only updates Django's
        # in-memory state, so it takes no lock at all.
        findings = self._scan(
            """
            from django.db import migrations, models

            class Migration(migrations.Migration):
                operations = [
                    migrations.SeparateDatabaseAndState(
                        database_operations=[],
                        state_operations=[
                            migrations.AddIndex(
                                model_name="card",
                                index=models.Index(fields=["board"], name="x_idx"),
                            ),
                        ],
                    ),
                ]
            """
        )
        self.assertEqual(findings, [])

    def test_inline_exemption_with_a_reason_suppresses_the_finding(self):
        findings = self._scan(
            f"""
            from django.db import migrations, models

            class Migration(migrations.Migration):
                operations = [
                    migrations.CreateModel(name="Widget", fields=[]),
                    # {EXEMPT_MARKER} table created in this same migration, zero rows
                    migrations.AddIndex(
                        model_name="widget",
                        index=models.Index(fields=["name"], name="w_idx"),
                    ),
                ]
            """
        )
        self.assertEqual(findings, [])

    def test_bare_exemption_marker_without_a_reason_still_fails(self):
        findings = self._scan(
            f"""
            from django.db import migrations, models

            class Migration(migrations.Migration):
                operations = [
                    # {EXEMPT_MARKER}
                    migrations.AddIndex(
                        model_name="card",
                        index=models.Index(fields=["board"], name="x_idx"),
                    ),
                ]
            """
        )
        self.assertEqual([f.operation for f in findings], ["AddIndex"])

    def test_exemption_does_not_bleed_onto_the_next_compact_operation(self):
        # One operation per line is common formatting. A raw line window would let a
        # comment about a brand-new table wave through the very next index, on a
        # live table, that its stated reason does not cover.
        findings = self._scan(
            f"""
            from django.db import migrations, models

            class Migration(migrations.Migration):
                operations = [
                    migrations.CreateModel(name="Widget", fields=[]),
                    # {EXEMPT_MARKER} table created in this same migration, no rows
                    migrations.AddIndex(model_name="widget", index=models.Index(fields=["name"], name="w_idx")),
                    migrations.AddIndex(model_name="card", index=models.Index(fields=["board"], name="x_idx")),
                ]
            """
        )
        self.assertEqual(len(findings), 1)
        self.assertIn('name="x_idx"', self._line(findings[0]))

    def test_two_adjacent_exempt_operations_need_two_comments(self):
        findings = self._scan(
            f"""
            from django.db import migrations, models

            class Migration(migrations.Migration):
                operations = [
                    migrations.CreateModel(name="Widget", fields=[]),
                    # {EXEMPT_MARKER} table created in this same migration, no rows
                    migrations.AddIndex(model_name="widget", index=models.Index(fields=["name"], name="w_idx")),
                    # {EXEMPT_MARKER} same new table, still no rows
                    migrations.AddIndex(model_name="widget", index=models.Index(fields=["at"], name="w2_idx")),
                ]
            """
        )
        self.assertEqual(findings, [])

    def test_concurrent_operation_requires_atomic_false(self):
        findings = self._scan(
            """
            from django.db import migrations, models

            from visiban.db_operations import AddIndexConcurrently

            class Migration(migrations.Migration):
                operations = [
                    AddIndexConcurrently(
                        model_name="card",
                        index=models.Index(fields=["board"], name="x_idx"),
                    ),
                ]
            """
        )
        # Without atomic = False this raises NotSupportedError at migrate time —
        # loud, but only once it reaches an environment that runs migrations.
        self.assertEqual([f.guidance_key for f in findings], ["atomic"])
        self.assertIn("atomic = False", findings[0].render())

    def test_exemption_does_not_reach_a_distant_operation(self):
        findings = self._scan(
            f"""
            from django.db import migrations, models

            class Migration(migrations.Migration):
                operations = [
                    # {EXEMPT_MARKER} only covers the operation right below it
                    migrations.AddIndex(
                        model_name="widget",
                        index=models.Index(fields=["name"], name="w_idx"),
                    ),
                    migrations.RunPython(migrations.RunPython.noop),
                    migrations.RunPython(migrations.RunPython.noop),
                    migrations.AddIndex(
                        model_name="card",
                        index=models.Index(fields=["board"], name="x_idx"),
                    ),
                ]
            """
        )
        # The first AddIndex sits directly under the comment and is exempt; the
        # second is four operations further down and is not.
        self.assertEqual(len(findings), 1)


class CheckCommandTests(SimpleTestCase):
    def test_repository_baseline_is_clean(self):
        """Every migration outside the grandfathered set is already concurrent.

        This is the regression guard: it fails the moment somebody adds a
        non-concurrent index migration, which is acceptance criterion 1 of #1081.
        """
        out, err = StringIO(), StringIO()
        call_command("check_migration_concurrency", stdout=out, stderr=err)
        self.assertIn("no non-concurrent index or constraint operations", out.getvalue())
        self.assertEqual(err.getvalue(), "")

    def test_grandfathered_migrations_all_still_exist(self):
        # If a squash removes one, the list must be pruned rather than left to rot.
        missing = [e for e in GRANDFATHERED if not (BACKEND_ROOT / e).exists()]
        self.assertEqual(missing, [])

    def test_command_fails_on_a_violating_migration(self):
        with mock.patch(
            "boards.management.commands.check_migration_concurrency.iter_migration_files"
        ) as iter_files:
            fake = mock.Mock()
            fake.relative_to.return_value = Path("boards/migrations/0099_bad.py")
            fake.read_text.return_value = (
                "from django.db import migrations, models\n"
                "class Migration(migrations.Migration):\n"
                "    operations = [migrations.AddIndex(model_name='card', "
                "index=models.Index(fields=['board'], name='x_idx'))]\n"
            )
            iter_files.return_value = [fake]

            with self.assertRaises(CommandError) as ctx:
                call_command(
                    "check_migration_concurrency", stdout=StringIO(), stderr=StringIO()
                )

        self.assertIn("1 non-concurrent", str(ctx.exception))
