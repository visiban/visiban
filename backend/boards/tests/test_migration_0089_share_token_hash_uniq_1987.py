"""boards/0089 share_token_hash unique index: forward/backward and invalid-index retry (#1987).

The PostgreSQL branch uses CREATE/DROP INDEX CONCURRENTLY and ``pg_index``, which
cannot run on the SQLite worktree databases. It is therefore tested with a fake
schema editor that records the SQL it is asked to execute, so the branching
(valid index skips, leftover INVALID index is dropped before rebuilding, reverse
drops concurrently) is asserted on every backend. The SQLite branch is run for
real through the migration executor.
"""
import importlib
from unittest import mock

from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import SimpleTestCase, TransactionTestCase

M0089 = importlib.import_module("boards.migrations.0089_board_share_token_hash_uniq")
NAME = M0089.NAME


class _FakeSchemaEditor:
    def __init__(self, vendor="postgresql"):
        self.connection = mock.Mock(vendor=vendor)
        self.executed = []
        self.added = []
        self.removed = []

    def execute(self, sql, *a, **k):
        self.executed.append(sql)

    def add_constraint(self, model, constraint):
        self.added.append((model, constraint))

    def remove_constraint(self, model, constraint):
        self.removed.append((model, constraint))


class PostgresBranchTests(SimpleTestCase):
    def _run(self, fn, valid):
        editor = _FakeSchemaEditor()
        with mock.patch.object(M0089, "_valid_index_exists", return_value=valid):
            fn(mock.Mock(), editor)
        return editor

    def test_forward_skips_when_a_valid_index_already_exists(self):
        self.assertEqual(self._run(M0089.forward, valid=True).executed, [])

    def test_forward_drops_leftover_invalid_index_then_builds_concurrently(self):
        # A failed CREATE INDEX CONCURRENTLY leaves an INVALID index; IF NOT EXISTS
        # would skip it on a re-run, so the retry must drop it first, in order.
        executed = self._run(M0089.forward, valid=False).executed
        self.assertEqual(len(executed), 2)
        self.assertIn(f"DROP INDEX CONCURRENTLY IF EXISTS {NAME}", executed[0])
        self.assertIn(f"CREATE UNIQUE INDEX CONCURRENTLY {NAME} ON boards (share_token_hash)", executed[1])
        self.assertIn("WHERE share_token_hash IS NOT NULL", executed[1])

    def test_backward_drops_the_index_concurrently(self):
        executed = self._run(M0089.backward, valid=True).executed
        self.assertEqual(len(executed), 1)
        self.assertIn(f"DROP INDEX CONCURRENTLY IF EXISTS {NAME}", executed[0])

    def test_non_postgres_branch_uses_constraint_api_not_raw_sql(self):
        editor = _FakeSchemaEditor(vendor="sqlite")
        apps = mock.Mock()
        M0089.forward(apps, editor)
        M0089.backward(apps, editor)
        self.assertEqual(editor.executed, [])
        self.assertEqual([c for _, c in editor.added], [M0089.CONSTRAINT])
        self.assertEqual([c for _, c in editor.removed], [M0089.CONSTRAINT])

    def test_valid_index_exists_reads_indisvalid(self):
        for row, expected in [((True,), True), ((False,), False), (None, False)]:
            editor = mock.MagicMock()
            cursor = editor.connection.cursor.return_value.__enter__.return_value
            cursor.fetchone.return_value = row
            self.assertIs(M0089._valid_index_exists(editor), expected)
            self.assertEqual(cursor.execute.call_args[0][1], [NAME])

    def test_migration_is_non_atomic(self):
        # CREATE INDEX CONCURRENTLY cannot run inside a transaction.
        self.assertFalse(M0089.Migration.atomic)


class ExecutorRoundTripTests(TransactionTestCase):
    """Real forward/backward through the executor (SQLite branch off PostgreSQL)."""

    BEFORE = [("boards", "0088_backfill_board_share_token_hash")]
    AFTER = [("boards", "0089_board_share_token_hash_uniq")]

    def tearDown(self):
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())

    def _unique_index_names(self):
        with connection.cursor() as cursor:
            constraints = connection.introspection.get_constraints(cursor, "boards")
        return {n for n, c in constraints.items() if c["unique"] and c["columns"] == ["share_token_hash"]}

    def test_backward_removes_and_forward_restores_the_unique_index(self):
        self.assertIn(NAME, self._unique_index_names())
        MigrationExecutor(connection).migrate(self.BEFORE)
        self.assertNotIn(NAME, self._unique_index_names())
        MigrationExecutor(connection).migrate(self.AFTER)
        self.assertIn(NAME, self._unique_index_names())
