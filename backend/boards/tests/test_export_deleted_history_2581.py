"""#2581: ``deleted_card_history`` is read in chunks, from partial ``card IS NULL`` indexes.

Measured on PostgreSQL 17 (20,000 card-less movements and activities on the
exported board among 200,000 live rows of each, 200,000 more card-less rows of
each on another board): without the indexes the movement read took 75 ms and
the activity read 34 ms, discarding 200,000 to 400,000 rows; with them 7 ms and
5 ms. Blocks and gate transitions (2,000 rows) took about 1 ms either way, so
they have no partial index. Reading 20,000 card-less movements and 20,000
activities peaked at 80 MB unchunked and 28 MB chunked (21 MB of it the
entries themselves).
"""
import unittest
from unittest import mock

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext

from accounts.models import User
from boards.models import Board, CardActivity, CardMovement, Column, Swimlane
from boards.tests.test_export_relations_history_2413 import _Fixture
from boards.views import import_export as ie


class DeletedHistoryChunkTests(_Fixture):
    def setUp(self):
        super().setUp()
        for i in range(3):
            self._deleted_card(f"Gone {i}", minutes=100 + 30 * i, open_block=True)

    def _history(self, size):
        with mock.patch.object(ie, "_EXPORT_CHUNK_SIZE", size), CaptureQueriesContext(connection) as ctx:
            history = ie._deleted_card_history_export(self.board)
        return history, [q["sql"] for q in ctx.captured_queries]

    def test_output_does_not_depend_on_the_chunk_size(self):
        expected, queries = self._history(500)
        self.assertEqual(len(expected), 3)
        # One query per record type below a chunk, as before chunking.
        self.assertEqual(len(queries), 4)
        for size in (1, 2, 3, 6):
            with self.subTest(size):
                self.assertEqual(self._history(size)[0], expected)

    def test_a_type_larger_than_a_chunk_is_read_a_window_at_a_time(self):
        _, queries = self._history(2)
        movement_reads = [q for q in queries if 'FROM "card_movements"' in q]
        # First page, the id list, then the one remaining row fetched by id.
        self.assertEqual(len(movement_reads), 3, movement_reads)
        self.assertIn("LIMIT 2", movement_reads[0])
        self.assertIn('"card_movements"."id" IN (', movement_reads[2])


@unittest.skipUnless(connection.vendor == "postgresql", "reads PostgreSQL query plans")
class DeletedHistoryIndexPlanTests(TestCase):
    def test_card_less_reads_use_the_partial_indexes(self):
        user = User.objects.create_user(username="plan", password="pw-2581-x")
        board = Board.objects.create(name="Plan", owner=user)
        other = Board.objects.create(name="Other", owner=user)
        column = Column.objects.create(board=board, name="C", position=0)
        lane = Swimlane.objects.create(board=board, name="L", position=0)
        card = board.cards.create(column=column, swimlane=lane, title="Live", created_by=user, position=0)
        other_card = other.cards.create(
            column=Column.objects.create(board=other, name="C", position=0),
            swimlane=Swimlane.objects.create(board=other, name="L", position=0),
            title="Elsewhere", created_by=user, position=0,
        )

        for model, extra in ((CardMovement, {}), (CardActivity, {"event_type": "title_change"})):
            # The exported board is a small part of the table, and most
            # card-less rows are other boards': the case the card_id index and
            # the (board, time) index each read too much for.
            model.objects.bulk_create(
                [model(board=board, card=card, card_uid=card.uid, **extra) for _ in range(2000)]
                + [model(board=other, card=other_card, card_uid=other_card.uid, **extra) for _ in range(5000)]
                + [model(board=other, card=None, **extra) for _ in range(40000)]
                + [model(board=board, card=None, **extra) for _ in range(100)]
            )
        with connection.cursor() as cursor:
            cursor.execute("ANALYZE card_movements")
            cursor.execute("ANALYZE card_activities")

        for model, ordering, index in (
            (CardMovement, "moved_at", "movement_deleted_board_idx"),
            (CardActivity, "created_at", "activity_deleted_board_idx"),
        ):
            with self.subTest(model.__name__):
                rows = model.objects.filter(board=board, card__isnull=True).order_by(ordering, "id")
                self.assertIn(index, rows.explain())
                self.assertIn(index, rows.values_list("pk", flat=True).explain())
