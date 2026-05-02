"""Regression tests for the 0051 card_density backfill (#961).

Migration 0051 adds the ``card_density`` column with default ``comfortable`` so
the design intent applies to *new* boards, then a RunPython data step flips
every existing row to ``dense`` so admins on already-deployed boards keep
their pre-1.1 visual.

These tests exercise the RunPython function directly (matching the pattern of
``test_action_type_backfill_migration.py``) so we verify backfill correctness
and idempotency without spinning up the migration state machine.
"""
import importlib

from django.apps import apps
from django.db import connection
from django.test import TestCase

from accounts.models import User
from boards.models import Board


_migration = importlib.import_module(
    "boards.migrations.0051_board_card_density"
)


class CardDensityBackfillTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="density_owner", password="pw")

    def _make_board(self, name: str, density: str = "comfortable") -> Board:
        # The model default is ``comfortable``; we mirror it explicitly so the
        # test is robust to default-value drift.
        return Board.objects.create(name=name, owner=self.owner, card_density=density)

    def test_backfill_flips_default_rows_to_dense(self):
        # Boards created at the moment of AddField inherit the column DEFAULT
        # (``comfortable``). The RunPython step then promotes them to ``dense``
        # so existing admins keep today's layout.
        b = self._make_board("Existing")
        self.assertEqual(b.card_density, "comfortable")

        _migration.backfill_existing_to_dense(apps, connection.schema_editor())

        b.refresh_from_db()
        self.assertEqual(b.card_density, "dense")

    def test_backfill_leaves_explicitly_set_rows_alone(self):
        # If a board was deliberately set to ``standard`` (e.g. a fresh install
        # configured by the admin between AddField and the data step, or a
        # post-migration override), the backfill must not stomp on that choice.
        b = self._make_board("DeliberateStandard", density="standard")
        _migration.backfill_existing_to_dense(apps, connection.schema_editor())
        b.refresh_from_db()
        self.assertEqual(b.card_density, "standard")

        b2 = self._make_board("DeliberateDense", density="dense")
        _migration.backfill_existing_to_dense(apps, connection.schema_editor())
        b2.refresh_from_db()
        self.assertEqual(b2.card_density, "dense")

    def test_backfill_is_idempotent(self):
        # A re-run after the data step has already executed must be a no-op.
        # Once the existing fleet is on ``dense``, there are no ``comfortable``
        # rows left for the .filter() to touch.
        self._make_board("First")
        _migration.backfill_existing_to_dense(apps, connection.schema_editor())
        _migration.backfill_existing_to_dense(apps, connection.schema_editor())
        self.assertEqual(Board.objects.filter(card_density="comfortable").count(), 0)
