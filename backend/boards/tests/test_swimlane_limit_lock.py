"""PostgreSQL race tests for the swimlane-limit row lock (#1150).

A swimlane limit counts cards across several columns, so the column lock that
serializes two moves into one full *column* cannot serialize two moves into one
full *row* through different columns. ``enforce_column_limits`` therefore locks
the target swimlane row (``FOR NO KEY UPDATE``) after the column rows, keeping
the card -> column -> swimlane order. These tests hold one move open inside its
transaction, right after the placement check took its locks, and prove with
``assert_blocked_on_lock`` (never a join timeout) that the second request waits
on it:

* a second move into the same row through another column queues and is then
  refused, so the row never ends over its hard limit;
* a swimlane reorder queues behind the move instead of deadlocking with it. The
  reorder used to lock the board row ``FOR UPDATE``, which blocks the
  ``FOR KEY SHARE`` the move's ``CardMovement`` insert needs on the board while
  the move holds the swimlane row the reorder waits for.

PostgreSQL only: SQLite has no row locks. Each thread closes its connections
before it exits (backend CLAUDE.md, threaded tests).
"""

import threading
from unittest import skipUnless
from unittest.mock import patch

from django.db import connection, connections
from django.test import TransactionTestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, CardMovement, Column, Swimlane
from boards.services import cards as card_services
from boards.tests.lock_wait import assert_blocked_on_lock

HOLD_TIMEOUT = 10


@skipUnless(connection.vendor == "postgresql", "row locks are only observable on PostgreSQL")
class SwimlaneLimitLockTests(TransactionTestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="lane-racer", password="pass")
        self.board = Board.objects.create(name="Lane race", owner=self.user)
        BoardMembership.objects.create(board=self.board, user=self.user, role=BoardMembership.Role.ADMIN)
        self.col_a = Column.objects.create(board=self.board, name="A", position=0)
        self.col_b = Column.objects.create(board=self.board, name="B", position=1)
        self.col_c = Column.objects.create(board=self.board, name="C", position=2)
        self.source = Swimlane.objects.create(board=self.board, name="Source", position=0)
        self.limited = Swimlane.objects.create(
            board=self.board, name="Limited", position=1, wip_limit=2, limit_enforcement="hard",
        )
        Card.objects.create(
            board=self.board, column=self.col_c, swimlane=self.limited, title="Resident",
            created_by=self.user, position=0,
        )

    def _card(self, title, column):
        return Card.objects.create(
            board=self.board, column=column, swimlane=self.source, title=title,
            created_by=self.user, position=Card.objects.filter(column=column, swimlane=self.source).count(),
        )

    def _client(self):
        client = APIClient()
        client.force_authenticate(self.user)
        return client

    def _move(self, card, column):
        def run():
            return self._client().post(
                f"/api/v1/boards/{self.board.pk}/cards/{card.pk}/move/",
                {"column_id": column.pk, "swimlane_id": self.limited.pk, "position": 0},
                format="json",
            )
        return run

    def _race(self, second):
        """Hold a move of ``self.first`` into the limited row right after its
        placement check (swimlane row locked), start ``second``, prove it waits
        on a lock, then release the first. Returns both responses."""
        held, release = threading.Event(), threading.Event()
        results, errors = {}, []
        real = card_services.enforce_column_limits

        def hold(*args, **kwargs):
            out = real(*args, **kwargs)
            if threading.current_thread().name == "first":
                held.set()
                release.wait(HOLD_TIMEOUT)
            return out

        def worker(name, fn):
            try:
                results[name] = fn()
            except BaseException as exc:  # noqa: BLE001 - surfaced after join
                errors.append(exc)
            finally:
                connections.close_all()  # release this thread's PostgreSQL connection

        with patch("boards.services.cards.enforce_column_limits", side_effect=hold), \
                patch("boards.broadcast.broadcast_board_event"):
            first = threading.Thread(target=worker, args=("first", self._move(self.first, self.col_a)), name="first")
            first.start()
            self.assertTrue(held.wait(HOLD_TIMEOUT), "the first move never reached its placement check")
            second_thread = threading.Thread(target=worker, args=("second", second), name="second")
            second_thread.start()
            try:
                assert_blocked_on_lock(self, second_thread, "the second request did not wait on the first move")
            finally:
                release.set()
                first.join(30)
                second_thread.join(30)
        self.assertFalse(first.is_alive() or second_thread.is_alive(), "a request hung")
        self.assertEqual(errors, [], "a request raised (a deadlock surfaces here)")
        return results["first"], results["second"]

    def test_two_moves_into_one_row_through_different_columns_queue(self):
        # One slot left in the row (1 of 2). Different source cells and target
        # columns, so only the swimlane row lock can make these queue.
        self.first = self._card("One", self.col_a)
        two = self._card("Two", self.col_b)
        first, second = self._race(self._move(two, self.col_b))
        self.assertEqual(first.status_code, 200, first.content)
        self.assertEqual(second.status_code, 409, second.content)
        self.assertEqual(second.json()["code"], "swimlane_wip_hard_blocked")
        self.assertEqual(second.json()["current_count"], 2)
        self.assertEqual(Card.objects.filter(swimlane=self.limited).count(), 2)
        self.assertFalse(CardMovement.objects.filter(card=two).exists())

    def test_swimlane_reorder_queues_behind_a_move_holding_the_row(self):
        self.first = self._card("One", self.col_a)

        def reorder():
            return self._client().post(
                f"/api/v1/boards/{self.board.pk}/swimlanes/reorder/",
                {"order": [self.limited.pk, self.source.pk]}, format="json",
            )

        first, second = self._race(reorder)
        self.assertEqual(first.status_code, 200, first.content)
        self.assertEqual(second.status_code, 200, second.content)
        self.limited.refresh_from_db()
        self.assertEqual(self.limited.position, 0)
