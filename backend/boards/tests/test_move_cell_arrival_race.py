"""A card committed into a locked cell must not deadlock a third move (#1567).

``move_card`` locks the moved card and every card in its source and target
cells in one pk-ordered ``SELECT ... FOR UPDATE`` (``_lock_move_cells``, #1522).
That statement locks the rows of the snapshot it took *before* it waited, so a
card that a concurrent move commits into one of the cells during the wait is
not locked. Before #1567 the later compaction UPDATE then locked that card
outside pk order, and a third move could deadlock against it:

1. T1 moves X (lower pk) from C into A, locking Y (A's only card). Before T1
   commits, T2 starts moving Y from A to B and queues on Y.
2. T1 commits. T2 now holds Y but not X, which is in A at position 1.
3. T3 starts moving X out of A. It locks X, then queues on Y.
4. T2's compaction of A (``position > 0``) needs X, which T3 holds while
   waiting on T2: ``deadlock detected``, a 500 on ``POST /cards/<id>/move/``.

The contract pinned here: T2 re-reads its cells once it holds their columns
(``_require_cells_locked``), sees X unlocked, and retries, so all three moves
succeed and the board ends consistent.

Technique: the hold-the-transaction pattern from ``docs/development/testing.md``
("Row-lock tests"), with two holds. PostgreSQL only; SQLite has no row locks.
To see the bug, make ``_require_cells_locked`` a no-op: the test then fails
with ``deadlock detected``.
"""

import threading
import time
from unittest import skipUnless
from unittest.mock import patch

from django.db import connection, connections
from django.test import TransactionTestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, CardMovement, Column, Swimlane

SERVICES_CARDS = "boards.services.cards"
PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"
HOLD_SECONDS = 1.5


@skipUnless(connection.vendor == "postgresql", "row locks are only observable on PostgreSQL")
class CardCommittedIntoLockedCellRaceTests(TransactionTestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="racer1567", password="pass")
        self.board = Board.objects.create(name="Race Board", owner=self.user)
        BoardMembership.objects.create(
            board=self.board, user=self.user, role=BoardMembership.Role.ADMIN,
        )
        self.col_a = Column.objects.create(board=self.board, name="A", position=0)
        self.col_b = Column.objects.create(board=self.board, name="B", position=1)
        self.col_c = Column.objects.create(board=self.board, name="C", position=2)
        self.swim = Swimlane.objects.create(board=self.board, name="General", position=0)
        # X is created first so it has the lower pk: T3 locks it before
        # queuing on Y, which is what closes the cycle.
        self.x = Card.objects.create(
            board=self.board, column=self.col_c, swimlane=self.swim,
            title="X", created_by=self.user, position=0,
        )
        self.y = Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.swim,
            title="Y", created_by=self.user, position=0,
        )
        self.assertLess(self.x.pk, self.y.pk)

    def _move(self, card, column, position):
        def run():
            client = APIClient()
            client.force_authenticate(self.user)
            return client.post(
                f"/api/v1/boards/{self.board.pk}/cards/{card.pk}/move/",
                {"column_id": column.pk, "swimlane_id": self.swim.pk, "position": position},
            ).status_code
        return run

    def test_third_move_does_not_deadlock_on_a_card_committed_into_the_cell(self):
        module = __import__(SERVICES_CARDS, fromlist=["x"])
        original_lock_cells = module._lock_move_cells
        original_lock_columns = module._lock_move_columns
        original_read = module._read_card_for_move
        first_paused = threading.Event()
        second_paused = threading.Event()
        read_calls = {"first": 0, "second": 0, "third": 0}
        results, errors = {}, []

        def hold_first(*args, **kwargs):
            # T1 holds Y (and X) until T2 has queued on Y.
            out = original_lock_cells(*args, **kwargs)
            if threading.current_thread().name == "first" and not first_paused.is_set():
                first_paused.set()
                threading.Event().wait(HOLD_SECONDS)
            return out

        def hold_second(*args, **kwargs):
            # T2 holds Y and the columns, before its compaction, until T3 has
            # locked X and queued on Y.
            out = original_lock_columns(*args, **kwargs)
            if threading.current_thread().name == "second" and not second_paused.is_set():
                second_paused.set()
                threading.Event().wait(HOLD_SECONDS)
            return out

        def counting_read(*args, **kwargs):
            read_calls[threading.current_thread().name] += 1
            return original_read(*args, **kwargs)

        def worker(name, fn, wait_for):
            try:
                if wait_for is not None and not wait_for.wait(10):
                    raise RuntimeError(f"{name}: the previous move never reached its hold point")
                results[name] = fn()
            except BaseException as exc:  # noqa: BLE001 - surfaced after join
                errors.append(exc)
            finally:
                connections.close_all()  # release this thread's PostgreSQL connection

        threads = [
            threading.Thread(
                target=worker, name="first",
                args=("first", self._move(self.x, self.col_a, 1), None),
            ),
            threading.Thread(
                target=worker, name="second",
                args=("second", self._move(self.y, self.col_b, 0), first_paused),
            ),
            threading.Thread(
                target=worker, name="third",
                args=("third", self._move(self.x, self.col_c, 0), second_paused),
            ),
        ]
        started = time.monotonic()
        with patch(f"{SERVICES_CARDS}._lock_move_cells", side_effect=hold_first), \
                patch(f"{SERVICES_CARDS}._lock_move_columns", side_effect=hold_second), \
                patch(f"{SERVICES_CARDS}._read_card_for_move", side_effect=counting_read), \
                patch(PATCH_BROADCAST):
            for t in threads:
                t.start()
            for t in threads:
                t.join(30)
        self.assertFalse(any(t.is_alive() for t in threads), "a move hung")
        # Without the re-check, T2 or T3 is aborted with "deadlock detected"
        # (an OperationalError the test client re-raises, i.e. a 500).
        self.assertEqual(errors, [])
        self.assertEqual(results, {"first": 200, "second": 200, "third": 200})
        # Both holds really happened, so the moves really overlapped.
        self.assertGreaterEqual(time.monotonic() - started, 2 * HOLD_SECONDS)
        # T2 found X unlocked in A and retried once; T1 never retried.
        self.assertEqual(read_calls["second"], 2)
        self.assertEqual(read_calls["first"], 1)

        self.x.refresh_from_db()
        self.y.refresh_from_db()
        self.assertEqual((self.x.column_id, self.x.position), (self.col_c.pk, 0))
        self.assertEqual((self.y.column_id, self.y.position), (self.col_b.pk, 0))
        self.assertFalse(Card.objects.filter(column=self.col_a).exists())
        self.assertEqual(
            list(
                CardMovement.objects.filter(card=self.x).order_by("moved_at", "pk")
                .values_list("from_column_id", "to_column_id")
            ),
            [(self.col_c.pk, self.col_a.pk), (self.col_a.pk, self.col_c.pk)],
        )
        self.assertEqual(
            list(CardMovement.objects.filter(card=self.y).values_list("from_column_id", "to_column_id")),
            [(self.col_a.pk, self.col_b.pk)],
        )
