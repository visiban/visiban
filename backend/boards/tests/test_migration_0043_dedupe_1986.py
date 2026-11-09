"""Migrate-time check of boards/0043 column-name dedupe (#1986)."""
import importlib

from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase

BEFORE = [("boards", "0042_add_card_version")]
AFTER = [("boards", "0043_column_unique_name_per_board")]


class ColumnDedupeMigrationTests(TransactionTestCase):
    def _migrate(self, targets):
        executor = MigrationExecutor(connection)
        executor.migrate(targets)
        # Rolling boards back also unapplies dependent accounts migrations, so
        # build the state from whatever accounts migration is actually applied;
        # otherwise the historical User model drifts from the live table.
        loader = MigrationExecutor(connection).loader
        accounts = max(n for n in loader.applied_migrations if n[0] == "accounts")
        return loader.project_state([*targets, accounts]).apps

    def tearDown(self):
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())

    def _names(self, apps, board):
        Column = apps.get_model("boards", "Column")
        return list(
            Column.objects.filter(board_id=board.pk).order_by("position").values_list("name", flat=True)
        )

    def test_dedupe_avoids_existing_suffixed_name(self):
        apps = self._migrate(BEFORE)
        User = apps.get_model("accounts", "User")
        Board = apps.get_model("boards", "Board")
        Column = apps.get_model("boards", "Column")
        owner = User.objects.create(username="own_1986x", password="x")
        b1 = Board.objects.create(name="b1_1986", owner=owner)
        b2 = Board.objects.create(name="b2_1986", owner=owner)
        for pos, name in enumerate(["Done", "Done", "Done (2)"]):
            Column.objects.create(board=b1, name=name, position=pos)
        for pos, name in enumerate(["Done", "Done", "Done"]):
            Column.objects.create(board=b2, name=name, position=pos)

        apps = self._migrate(AFTER)

        n1 = self._names(apps, b1)
        self.assertEqual(len(set(n1)), 3)
        self.assertEqual(n1, ["Done", "Done (3)", "Done (2)"])
        self.assertEqual(self._names(apps, b2), ["Done", "Done (2)", "Done (3)"])

    def test_dedupe_mixed_collisions_and_case_differing_name(self):
        apps = self._migrate(BEFORE)
        User = apps.get_model("accounts", "User")
        Board = apps.get_model("boards", "Board")
        Column = apps.get_model("boards", "Column")
        owner = User.objects.create(username="own_1986z", password="x")
        board = Board.objects.create(name="b4_1986", owner=owner)
        # "done" differs by case, so it is not a duplicate (the unique
        # constraint is case-sensitive) and must be left untouched.
        for pos, name in enumerate(["Done", "Done", "Done (2)", "Done (3)", "done"]):
            Column.objects.create(board=board, name=name, position=pos)

        apps = self._migrate(AFTER)

        self.assertEqual(
            self._names(apps, board),
            ["Done", "Done (4)", "Done (2)", "Done (3)", "done"],
        )

    def test_function_truncates_to_max_length(self):
        mod = importlib.import_module("boards.migrations.0043_column_unique_name_per_board")
        apps = self._migrate(BEFORE)
        User = apps.get_model("accounts", "User")
        Board = apps.get_model("boards", "Board")
        Column = apps.get_model("boards", "Column")
        owner = User.objects.create(username="own_1986y", password="x")
        board = Board.objects.create(name="b3_1986", owner=owner)
        long_name = "x" * 255
        for pos in range(2):
            Column.objects.create(board=board, name=long_name, position=pos)

        mod.deduplicate_column_names(apps, None)

        names = self._names(apps, board)
        self.assertEqual(len(set(names)), 2)
        self.assertTrue(all(len(n) <= 255 for n in names))
        self.assertEqual(names[1], "x" * 251 + " (2)")
