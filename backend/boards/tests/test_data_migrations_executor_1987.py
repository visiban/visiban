"""RunPython data migrations in boards that had no executor coverage (#1987).

Covered: boards/0008 (first column allows card creation), boards/0016
(CardMovement name denormalization backfill) and boards/0054 (BoardTemplate
columns_json rewrite by slug, with a reverse that restores hardcoded
constants). Functions come from the real migration modules and run against
historical models from the migration loader's project state.
"""
import importlib

from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TestCase

M0008 = importlib.import_module("boards.migrations.0008_column_allow_card_creation")
M0016 = importlib.import_module("boards.migrations.0016_cardmovement_denorm_names")
M0054 = importlib.import_module("boards.migrations.0054_fix_board_template_drift")


def _historical_apps():
    # Leaf state: see accounts/tests/test_data_migrations_executor_1987.py.
    loader = MigrationExecutor(connection).loader
    return loader.project_state(loader.graph.leaf_nodes()).apps


class Migration0008Tests(TestCase):
    def test_only_leftmost_column_per_board_allows_creation(self):
        apps = _historical_apps()
        User, Board, Column = (apps.get_model("accounts", "User"), apps.get_model("boards", "Board"), apps.get_model("boards", "Column"))
        owner = User.objects.create(username="o_1987b", password="x")
        b1 = Board.objects.create(name="b1_1987", owner=owner)
        b2 = Board.objects.create(name="b2_1987", owner=owner)
        Board.objects.create(name="empty_1987", owner=owner)  # no columns: must not raise
        # Insert out of position order so "leftmost" is by position, not by pk.
        c_right = Column.objects.create(board=b1, name="Right", position=2)
        c_left = Column.objects.create(board=b1, name="Left", position=0)
        c_only = Column.objects.create(board=b2, name="Only", position=5)

        M0008.set_first_column_allow_creation(apps, None)

        flag = lambda c: Column.objects.get(pk=c.pk).allow_card_creation  # noqa: E731
        self.assertTrue(flag(c_left))
        self.assertFalse(flag(c_right))
        self.assertTrue(flag(c_only))

    def test_reverse_is_noop_and_forward_is_idempotent(self):
        runpython = [op for op in M0008.Migration.operations if op.__class__.__name__ == "RunPython"][0]
        self.assertIs(runpython.reverse_code, M0008.migrations.RunPython.noop)
        apps = _historical_apps()
        User, Board, Column = (apps.get_model("accounts", "User"), apps.get_model("boards", "Board"), apps.get_model("boards", "Column"))
        owner = User.objects.create(username="o2_1987b", password="x")
        board = Board.objects.create(name="b3_1987", owner=owner)
        col = Column.objects.create(board=board, name="A", position=0)
        M0008.set_first_column_allow_creation(apps, None)
        M0008.set_first_column_allow_creation(apps, None)
        self.assertTrue(Column.objects.get(pk=col.pk).allow_card_creation)


class Migration0016Tests(TestCase):
    def setUp(self):
        self.apps = _historical_apps()
        g = self.apps.get_model
        self.User, self.Board, self.Column = g("accounts", "User"), g("boards", "Board"), g("boards", "Column")
        self.Swimlane, self.Card, self.CardMovement = g("boards", "Swimlane"), g("boards", "Card"), g("boards", "CardMovement")

    def test_names_copied_from_live_fks_and_missing_fks_left_alone(self):
        owner = self.User.objects.create(username="o_1987c", password="x")
        board = self.Board.objects.create(name="b_1987c", owner=owner)
        col_a = self.Column.objects.create(board=board, name="Todo", position=0)
        col_b = self.Column.objects.create(board=board, name="Doing", position=1)
        lane = self.Swimlane.objects.create(board=board, name="Lane A", position=0)
        card = self.Card.objects.create(board=board, column=col_a, swimlane=lane, title="c", position=0)
        mv = self.CardMovement.objects.create(
            card=card, board=board, from_column=col_a, to_column=col_b, to_swimlane=lane,
        )
        # No swimlane FKs / from-column on this one: those *_name fields keep their value.
        stale = self.CardMovement.objects.create(
            card=card, board=board, to_column=col_b, from_swimlane_name="kept", from_column_name="kept-col",
        )

        M0016.backfill_names(self.apps, None)

        mv = self.CardMovement.objects.get(pk=mv.pk)
        self.assertEqual((mv.from_column_name, mv.to_column_name), ("Todo", "Doing"))
        self.assertEqual(mv.to_swimlane_name, "Lane A")
        self.assertEqual(mv.from_swimlane_name, "")
        stale = self.CardMovement.objects.get(pk=stale.pk)
        self.assertEqual(stale.to_column_name, "Doing")
        self.assertEqual(stale.from_swimlane_name, "kept")
        self.assertEqual(stale.from_column_name, "kept-col")


class Migration0054Tests(TestCase):
    def setUp(self):
        self.apps = _historical_apps()
        self.BoardTemplate = self.apps.get_model("boards", "BoardTemplate")

    def _tpl(self, slug, columns):
        obj, _ = self.BoardTemplate.objects.update_or_create(
            slug=slug, defaults={"name": slug, "description": "d", "columns_json": columns},
        )
        return obj

    def _cols(self, slug):
        return self.BoardTemplate.objects.get(slug=slug).columns_json

    def test_forward_overwrites_columns_by_slug_only(self):
        self._tpl("project_delivery", M0054.OLD_COLUMNS["project_delivery"])
        self._tpl("legal_compliance", M0054.OLD_COLUMNS["legal_compliance"])
        custom = [{"name": "Mine", "color": "#000000", "position": 0}]
        self._tpl("custom_user_template_1987", custom)

        M0054.fix_columns(self.apps, None)

        self.assertEqual(self._cols("project_delivery"), M0054.NEW_COLUMNS["project_delivery"])
        self.assertEqual(self._cols("project_delivery")[-1], {"name": "Done", "color": "#10B981", "position": 6, "is_done": True})
        self.assertEqual(self._cols("legal_compliance")[-1]["name"], "Closed")
        # A slug the migration does not know about is untouched.
        self.assertEqual(self._cols("custom_user_template_1987"), custom)

    def test_forward_tolerates_missing_rows(self):
        self.BoardTemplate.objects.all().delete()
        M0054.fix_columns(self.apps, None)
        self.assertEqual(self.BoardTemplate.objects.count(), 0)

    def test_reverse_restores_hardcoded_constants(self):
        self._tpl("legal_compliance", M0054.NEW_COLUMNS["legal_compliance"])
        self._tpl("simple_kanban", M0054.NEW_COLUMNS["simple_kanban"])

        M0054.unfix_columns(self.apps, None)

        legal = self._cols("legal_compliance")
        self.assertEqual(legal, M0054.OLD_COLUMNS["legal_compliance"])
        self.assertEqual(legal[-1]["name"], "Archived")
        self.assertFalse(any("is_done" in c for c in self._cols("simple_kanban")))

    def test_old_and_new_cover_the_same_slugs_with_is_done_the_only_drift_for_most(self):
        self.assertEqual(set(M0054.OLD_COLUMNS), set(M0054.NEW_COLUMNS))
        for slug in set(M0054.NEW_COLUMNS) - {"project_delivery", "legal_compliance"}:
            stripped = [{k: v for k, v in c.items() if k != "is_done"} for c in M0054.NEW_COLUMNS[slug]]
            self.assertEqual(stripped, M0054.OLD_COLUMNS[slug], slug)
