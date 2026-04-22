"""Regression tests for the Notification.action_type residual backfill (#822).

Migration 0040 infers action_type from verb text but explicitly leaves rows
it cannot classify as action_type="". Migration 0041 then tightens the
model-level ``blank=False`` constraint, so any residual "" row could no
longer be re-saved through full_clean / ModelForm / serializer code paths.

Migration 0049 is a catch-all pass that assigns ``card_moved`` to every
remaining "" row. These tests exercise the migration's RunPython function
directly to verify backfill correctness and idempotency without needing to
run the migration state machine inside the test (which is fragile across
TransactionTestCase boundaries).
"""

import importlib

from django.apps import apps
from django.db import connection
from django.test import TestCase

from accounts.models import User
from boards.models import Notification


# Load the migration module once; RunPython expects (apps_registry, schema_editor)
# so we pass the live registry — functionally equivalent to the historical one
# for a single-field char update.
_migration = importlib.import_module(
    "boards.migrations.0049_backfill_residual_action_type"
)


class ResidualActionTypeBackfillTests(TestCase):
    def setUp(self):
        self.recipient = User.objects.create_user(username="recipient", password="pw")

    def _insert_blank_notification(self, verb: str) -> int:
        """Insert a notification with action_type="" via raw SQL.

        The model enforces ``blank=False`` so ``Notification.objects.create``
        would raise; raw SQL lets us reproduce the historical unmatchable row
        that 0040 left behind.
        """
        # CURRENT_TIMESTAMP is ANSI SQL (PostgreSQL prod + SQLite dev both
        # support it); NOW() is PostgreSQL-only and breaks the local test run.
        # SQLite also does not support RETURNING across all versions we target,
        # so fetch lastrowid / sequence via a follow-up query for portability.
        with connection.cursor() as cur:
            cur.execute(
                "INSERT INTO notifications (recipient_id, actor_id, action_type, verb, read, created_at) "
                "VALUES (%s, NULL, '', %s, FALSE, CURRENT_TIMESTAMP)",
                [self.recipient.id, verb],
            )
        return Notification.objects.filter(
            recipient=self.recipient, verb=verb, action_type=""
        ).values_list("id", flat=True).first()

    def test_backfill_converts_residual_blank_rows(self):
        id_a = self._insert_blank_notification("some verb 0040 could not match")
        id_b = self._insert_blank_notification("another unmatched verb")
        self.assertEqual(Notification.objects.filter(action_type="").count(), 2)

        _migration.backfill_residual(apps, connection.schema_editor())

        self.assertEqual(Notification.objects.filter(action_type="").count(), 0)
        self.assertEqual(
            Notification.objects.get(id=id_a).action_type, "card_moved"
        )
        self.assertEqual(
            Notification.objects.get(id=id_b).action_type, "card_moved"
        )

    def test_backfill_leaves_classified_rows_untouched(self):
        mentioned = Notification.objects.create(
            recipient=self.recipient,
            action_type="mentioned",
            verb="You were mentioned",
        )
        blank_id = self._insert_blank_notification("fallback verb")

        _migration.backfill_residual(apps, connection.schema_editor())

        mentioned.refresh_from_db()
        self.assertEqual(mentioned.action_type, "mentioned")
        self.assertEqual(
            Notification.objects.get(id=blank_id).action_type, "card_moved"
        )

    def test_backfill_is_idempotent(self):
        self._insert_blank_notification("fallback verb")
        _migration.backfill_residual(apps, connection.schema_editor())
        # Re-run — nothing left to match, no-op.
        _migration.backfill_residual(apps, connection.schema_editor())
        self.assertEqual(Notification.objects.filter(action_type="").count(), 0)
