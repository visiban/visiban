"""A stage settings save racing a card move (#1102, #1921).

A move locks the card, then its columns (``_lock_move_columns``); a stage save
locks the column's cards in pk order, then the column row
(``services.stages._save_stage_attempt``). Same order, so the two must queue
rather than deadlock, and whichever goes second must read the first's result:
the card's ``gates_passed`` may never point past the sub-columns that exist
after both commit, and the transition log must end where the card ends.
PostgreSQL only (row locks are not observable on SQLite).
"""

import threading
from unittest import skipUnless
from unittest.mock import patch

from django.db import connection, connections
from django.test import TransactionTestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, CardGateTransition, Column, SubColumn, Swimlane,
)
from boards.tests.lock_wait import assert_blocked_on_lock

HOLD_TIMEOUT = 10.0


@skipUnless(connection.vendor == "postgresql", "row locks are only observable on PostgreSQL")
class StageSaveVsMoveTests(TransactionTestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="admin1921c", password="pass")
        self.board = Board.objects.create(name="B", owner=self.user)
        BoardMembership.objects.create(
            board=self.board, user=self.user, role=BoardMembership.Role.ADMIN,
        )
        self.stage = Column.objects.create(board=self.board, name="Build", position=0)
        self.subs = [
            SubColumn.objects.create(column=self.stage, position=i, name=n)
            for i, n in enumerate(["Doing", "Review", "Ready"])
        ]
        self.lane = Swimlane.objects.create(board=self.board, name="Lane", position=0)
        self.card = Card.objects.create(
            board=self.board, column=self.stage, swimlane=self.lane, title="C",
            created_by=self.user, position=0, gates_passed=0,
        )
        patcher = patch("boards.broadcast.broadcast_board_event")
        patcher.start()
        self.addCleanup(patcher.stop)

    def _client(self):
        client = APIClient()
        client.force_authenticate(self.user)
        return client

    def _move(self, gates_passed):
        return self._client().post(
            f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/move/",
            {"column_id": self.stage.pk, "swimlane_id": self.lane.pk, "position": 0,
             "gates_passed": gates_passed},
            format="json",
        )

    def _save_stage(self):
        # Drop "Review": a card that has passed it falls back one gate.
        keep = [{"id": self.subs[0].pk, "name": "Doing"}, {"id": self.subs[2].pk, "name": "Ready"}]
        return self._client().put(
            f"/api/v1/boards/{self.board.pk}/columns/{self.stage.pk}/stage/",
            {"sub_columns": keep}, format="json",
        )

    def _thread(self, name, fn, results):
        def run():
            try:
                results[name] = fn()
            except Exception as exc:  # surfaced by _status
                results[name] = exc
            finally:
                connections.close_all()

        t = threading.Thread(target=run, name=name)
        t.start()
        return t

    def _pause_after(self, target, thread_name, paused, release):
        module_path, attr = target.rsplit(".", 1)
        real = getattr(__import__(module_path, fromlist=[attr]), attr)

        def wrapper(*args, **kwargs):
            result = real(*args, **kwargs)
            if threading.current_thread().name == thread_name and not paused.is_set():
                paused.set()
                release.wait(HOLD_TIMEOUT)
            return result

        return patch(target, side_effect=wrapper)

    def _status(self, results, name):
        value = results.get(name, "missing")
        if isinstance(value, Exception):
            self.fail(f"{name} raised {type(value).__name__}: {value}")
        self.assertNotEqual(value, "missing", f"{name} never finished")
        return value.status_code

    def _assert_consistent(self):
        card = Card.objects.get(pk=self.card.pk)
        subs = SubColumn.objects.filter(column=self.stage).count()
        self.assertEqual(subs, 2)
        self.assertLessEqual(card.gates_passed, subs - 1, "gates_passed points past the stage")
        last = CardGateTransition.objects.filter(card=card).order_by("created_at", "pk").last()
        if last is not None:
            self.assertEqual(last.to_index, card.gates_passed, "gate log ends elsewhere than the card")
        return card

    def test_stage_save_queues_behind_a_move_and_reads_its_result(self):
        paused, release, results = threading.Event(), threading.Event(), {}
        # Paused with the card and column rows held, before the move commits.
        with self._pause_after(
            "boards.services.cards._lock_move_columns", "mover", paused, release,
        ):
            mover = self._thread("mover", lambda: self._move(1), results)
            self.assertTrue(paused.wait(HOLD_TIMEOUT), "move never reached its hold")
            saver = self._thread("saver", self._save_stage, results)
            assert_blocked_on_lock(self, saver, "stage save did not wait for the card lock")
            release.set()
            mover.join(HOLD_TIMEOUT)
            saver.join(HOLD_TIMEOUT)
        self.assertEqual(self._status(results, "mover"), 200)
        self.assertEqual(self._status(results, "saver"), 200)
        card = self._assert_consistent()
        # The save saw the move's gates_passed=1 and walked it back past the
        # dropped sub-column, logging a stage_edited row after the pass.
        self.assertEqual(card.gates_passed, 0)
        self.assertEqual(
            list(CardGateTransition.objects.filter(card=card).order_by("pk").values_list("cause", "to_index")),
            [(CardGateTransition.Cause.MOVE, 1), (CardGateTransition.Cause.STAGE_EDITED, 0)],
        )

    def test_move_queues_behind_a_stage_save(self):
        Card.objects.filter(pk=self.card.pk).update(gates_passed=1)
        paused, release, results = threading.Event(), threading.Event(), {}
        with self._pause_after(
            "boards.services.stages._clean_sub_columns", "saver", paused, release,
        ):
            saver = self._thread("saver", self._save_stage, results)
            self.assertTrue(paused.wait(HOLD_TIMEOUT), "stage save never reached its hold")
            mover = self._thread("mover", lambda: self._move(1), results)
            assert_blocked_on_lock(self, mover, "move did not wait for the stage's locks")
            release.set()
            saver.join(HOLD_TIMEOUT)
            mover.join(HOLD_TIMEOUT)
        self.assertEqual(self._status(results, "saver"), 200)
        self.assertEqual(self._status(results, "mover"), 200)
        self._assert_consistent()
