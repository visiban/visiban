"""The loser of two concurrent moves of the same card (#1523).

Before #1522 the move locked its card with
``Card.objects.select_for_update().select_related("column", "swimlane")``. On
PostgreSQL a second move of the same card queued on that row lock, and when the
first committed, PostgreSQL re-evaluated the locked SELECT against the updated
card row (EvalPlanQual) but joined it to the column row from its pre-commit
snapshot. ``card.column_id = column.id`` no longer held, the card dropped out
of the result, and the loser answered 404 for a card that existed.

The contract these tests pin: the locked SELECT joins nothing, so the queued
move always finds its card; it then sees that the card changed since its
unlocked read and goes through ``move_card``'s existing ``_CardChangedBeforeLock``
retry, so it either applies its move on the new state (200) or, when it sent an
``expected_version``, gets the deliberate 409 that version check produces. A
404 is only answered for a card that is really gone.

Technique: the hold-the-first-transaction pattern from
``docs/development/testing.md`` ("Row-lock tests"). PostgreSQL only; SQLite has
no row locks. To see the bug, put ``.select_related("column", "swimlane")``
back on the statement in ``_lock_move_cells``: the race tests below then fail
with a 404 for the second move.
"""

import threading
import time
from unittest import skipUnless
from unittest.mock import patch

from django.db import connection, connections
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from accounts.models import User
from boards import broadcast as _broadcast
from boards.models import (
    Board, BoardEvent, BoardMembership, Card, CardMovement, Column, Swimlane,
)

SERVICES_CARDS = "boards.services.cards"
PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"
HOLD_SECONDS = 1.5


@skipUnless(connection.vendor == "postgresql", "row locks are only observable on PostgreSQL")
class SameCardMoveRaceTests(TransactionTestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="racer1523", password="pass")
        self.board = Board.objects.create(name="Race Board", owner=self.user)
        BoardMembership.objects.create(
            board=self.board, user=self.user, role=BoardMembership.Role.ADMIN,
        )
        self.col_a = Column.objects.create(board=self.board, name="A", position=0)
        self.col_b = Column.objects.create(board=self.board, name="B", position=1)
        self.col_c = Column.objects.create(board=self.board, name="C", position=2)
        self.swim = Swimlane.objects.create(board=self.board, name="General", position=0)
        self.card = Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.swim,
            title="Contended", created_by=self.user, position=0,
        )

    # -- harness ------------------------------------------------------------

    def _race(self, hold_patch_target, first, second):
        """Run ``first`` paused inside its transaction, then ``second``.

        ``first`` pauses for HOLD_SECONDS at its first call to
        ``hold_patch_target`` (a services.cards function that runs after its
        row lock is held); ``second`` starts only once it is paused. Returns
        ``(results, finished_at, pause_ended_at, broadcast_mock, read_calls)``
        where ``read_calls`` counts ``_read_card_for_move`` calls per thread.
        """
        module = __import__(SERVICES_CARDS, fromlist=["x"])
        original_hold = getattr(module, hold_patch_target)
        original_read = module._read_card_for_move
        first_paused = threading.Event()
        pause_ended = {}
        results, finished, errors = {}, {}, []
        read_calls = {"first": 0, "second": 0}

        def hold(*args, **kwargs):
            out = original_hold(*args, **kwargs)
            if threading.current_thread().name == "first" and not first_paused.is_set():
                first_paused.set()
                threading.Event().wait(HOLD_SECONDS)  # keep the transaction open
                pause_ended["at"] = time.monotonic()
            return out

        def counting_read(*args, **kwargs):
            read_calls[threading.current_thread().name] += 1
            return original_read(*args, **kwargs)

        def worker(name, fn, wait_for_first):
            try:
                if wait_for_first and not first_paused.wait(10):
                    raise RuntimeError("first request never reached the hold point")
                results[name] = fn()
                finished[name] = time.monotonic()
            except BaseException as exc:  # noqa: BLE001 - surfaced after join
                errors.append(exc)
            finally:
                connections.close_all()  # release this thread's PostgreSQL connection

        with patch(f"{SERVICES_CARDS}.{hold_patch_target}", side_effect=hold), \
                patch(f"{SERVICES_CARDS}._read_card_for_move", side_effect=counting_read), \
                patch(PATCH_BROADCAST) as broadcast_mock:
            t1 = threading.Thread(target=worker, args=("first", first, False), name="first")
            t2 = threading.Thread(target=worker, args=("second", second, True), name="second")
            t1.start()
            t2.start()
            t1.join(30)
            t2.join(30)
        self.assertFalse(t1.is_alive() or t2.is_alive(), "a request hung (possible deadlock)")
        self.assertEqual(errors, [])
        # Ordering: the second request queued on the card-row lock, so it
        # cannot have finished while the first was still holding it.
        self.assertGreaterEqual(finished["second"], pause_ended["at"])
        return results, broadcast_mock, read_calls

    def _client(self):
        client = APIClient()
        client.force_authenticate(self.user)
        return client

    def _move(self, column, *, expected_version=None):
        def run():
            body = {"column_id": column.pk, "swimlane_id": self.swim.pk, "position": 0}
            if expected_version is not None:
                body["version"] = expected_version
            return self._client().post(
                f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/move/", body,
            ).status_code
        return run

    def _delete(self):
        def run():
            return self._client().delete(
                f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/",
            ).status_code
        return run

    def _moved_broadcasts(self, broadcast_mock):
        return [c for c in broadcast_mock.call_args_list if c.args[1] == _broadcast.EVT_CARD_MOVED]

    # -- tests --------------------------------------------------------------

    def test_loser_applies_its_move_on_the_winners_result(self):
        """The queued move re-reads the card and moves it on from B, never 404."""
        results, broadcast_mock, read_calls = self._race(
            "_lock_move_cells", self._move(self.col_b), self._move(self.col_c),
        )
        self.assertEqual(results, {"first": 200, "second": 200})
        # The loser went through the _CardChangedBeforeLock retry: its first
        # attempt read the card in A, found it in B under the lock, rolled back
        # and read again.
        self.assertEqual(read_calls["second"], 2)

        movements = list(CardMovement.objects.filter(card=self.card).order_by("moved_at", "pk"))
        self.assertEqual(
            [(m.from_column_id, m.to_column_id) for m in movements],
            [(self.col_a.pk, self.col_b.pk), (self.col_b.pk, self.col_c.pk)],
        )
        self.card.refresh_from_db()
        self.assertEqual(self.card.column_id, self.col_c.pk)
        self.assertEqual(self.card.position, 0)
        self.assertEqual(self.card.version, 3)

        # One card.moved per committed move: the rolled-back attempt neither
        # recorded a feed row nor published one.
        self.assertEqual(
            BoardEvent.objects.filter(board_id=self.board.pk, event=_broadcast.EVT_CARD_MOVED).count(),
            2,
        )
        self.assertEqual(len(self._moved_broadcasts(broadcast_mock)), 2)

    def test_loser_with_stale_expected_version_gets_a_conflict_not_404(self):
        """A loser that pinned the version it read gets 409 on the retry."""
        results, broadcast_mock, read_calls = self._race(
            "_lock_move_cells",
            self._move(self.col_b, expected_version=1),
            self._move(self.col_c, expected_version=1),
        )
        self.assertEqual(results, {"first": 200, "second": 409})
        self.assertEqual(read_calls["second"], 2)
        self.assertEqual(CardMovement.objects.filter(card=self.card).count(), 1)
        self.card.refresh_from_db()
        self.assertEqual(self.card.column_id, self.col_b.pk)
        self.assertEqual(self.card.version, 2)
        self.assertEqual(len(self._moved_broadcasts(broadcast_mock)), 1)

    def test_loser_gets_404_when_the_winner_deleted_the_card(self):
        """A real 404 survives: the card the loser queued on no longer exists."""
        results, broadcast_mock, _ = self._race(
            "_broadcast_after_commit", self._delete(), self._move(self.col_c),
        )
        self.assertEqual(results, {"first": 204, "second": 404})
        self.assertFalse(Card.objects.filter(pk=self.card.pk).exists())
        self.assertEqual(CardMovement.objects.filter(card_id=self.card.pk).count(), 0)
        self.assertEqual(self._moved_broadcasts(broadcast_mock), [])

    def test_card_lock_statement_joins_nothing(self):
        """Structural guard: the FOR UPDATE on cards must not carry a join.

        A joined row in the locked SELECT is what PostgreSQL re-checks against
        a stale snapshot after the wait; ``OF`` alone does not prevent that.
        """
        with patch(PATCH_BROADCAST), CaptureQueriesContext(connection) as ctx:
            status = self._client().post(
                f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/move/",
                {"column_id": self.col_b.pk, "swimlane_id": self.swim.pk, "position": 0},
            ).status_code
        self.assertEqual(status, 200)
        card_locks = [
            q["sql"] for q in ctx.captured_queries
            if "FOR UPDATE" in q["sql"]
            and q["sql"].lstrip().startswith(f'SELECT "{Card._meta.db_table}"')
        ]
        self.assertEqual(len(card_locks), 1, card_locks)
        self.assertNotIn("JOIN", card_locks[0])


class SameCardMoveScopingTests(TransactionTestCase):
    """The post-lock re-read stays scoped to the caller's board (any database)."""

    def test_move_of_a_card_on_another_board_is_404(self):
        user = User.objects.create_user(username="scoped1523", password="pass")
        mine = Board.objects.create(name="Mine", owner=user)
        BoardMembership.objects.create(board=mine, user=user, role=BoardMembership.Role.ADMIN)
        col = Column.objects.create(board=mine, name="A", position=0)
        swim = Swimlane.objects.create(board=mine, name="General", position=0)

        other_owner = User.objects.create_user(username="other1523", password="pass")
        theirs = Board.objects.create(name="Theirs", owner=other_owner)
        their_col = Column.objects.create(board=theirs, name="A", position=0)
        their_swim = Swimlane.objects.create(board=theirs, name="General", position=0)
        their_card = Card.objects.create(
            board=theirs, column=their_col, swimlane=their_swim,
            title="Not yours", created_by=other_owner, position=0,
        )

        client = APIClient()
        client.force_authenticate(user)
        with patch(PATCH_BROADCAST):
            resp = client.post(
                f"/api/v1/boards/{mine.pk}/cards/{their_card.pk}/move/",
                {"column_id": col.pk, "swimlane_id": swim.pk, "position": 0},
            )
        self.assertEqual(resp.status_code, 404)
        their_card.refresh_from_db()
        self.assertEqual(their_card.column_id, their_col.pk)
        self.assertFalse(CardMovement.objects.filter(card=their_card).exists())
