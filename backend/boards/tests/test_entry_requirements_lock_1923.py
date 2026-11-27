"""PostgreSQL race tests: a card-value clear racing a move into a Block column (#1923).

An entry requirement reads the card's field values. ``move_card`` evaluates
them while it holds the card row lock, and ``update_card`` takes the same lock
before it writes values, so the two serialize and the decision is conclusive in
both orders. These tests hold one request open inside its transaction, prove
with ``assert_blocked_on_lock`` (never a join timeout) that the other waits on
the card row, then release the first:

* move first: the move passes on the value it read, the clear waits, then the
  value is cleared and the card stays in the column (clearing after entry is
  allowed and never refused);
* clear first: the clear commits, the waiting move re-reads the cleared value
  and is refused with ``entry_requirements_unmet``; the card does not move.

PostgreSQL only: SQLite has no row locks. Each thread closes its connections
before it exits (backend CLAUDE.md, threaded tests); ``patch`` is applied once
in the main thread, never inside a worker.
"""

import threading
from unittest import skipUnless
from unittest.mock import patch

from django.db import connection, connections
from django.test import TransactionTestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, CardMovement, Column, ColumnEntryRequirement,
    CustomFieldDefinition, CustomFieldValue, Swimlane,
)
from boards.services import cards as card_services
from boards.services import custom_fields as custom_field_services
from boards.tests.lock_wait import assert_blocked_on_lock

HOLD_TIMEOUT = 10


@skipUnless(connection.vendor == "postgresql", "row locks are only observable on PostgreSQL")
class EntryRequirementValueRaceTests(TransactionTestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="entry-racer", password="pass")
        self.board = Board.objects.create(name="Entry race", owner=self.user)
        BoardMembership.objects.create(board=self.board, user=self.user, role=BoardMembership.Role.ADMIN)
        self.src = Column.objects.create(board=self.board, name="Discovery", position=0)
        self.dst = Column.objects.create(board=self.board, name="Proposal", position=1)
        self.lane = Swimlane.objects.create(board=self.board, name="Enterprise", position=0)
        self.amount = CustomFieldDefinition.objects.create(
            board=self.board, name="Amount", field_type="number", position=0,
        )
        ColumnEntryRequirement.objects.create(
            column=self.dst, field_definition=self.amount, operator="gt", operand=50000,
        )
        self.dst.entry_enforcement = "block"
        self.dst.save(update_fields=["entry_enforcement"])
        self.card = Card.objects.create(
            board=self.board, column=self.src, swimlane=self.lane, title="Deal",
            created_by=self.user, position=0,
        )
        CustomFieldValue.objects.create(card=self.card, field_definition=self.amount, value="60000")

    def _client(self):
        client = APIClient()
        client.force_authenticate(self.user)
        return client

    def _move(self):
        return self._client().post(
            f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/move/",
            {"column_id": self.dst.pk, "swimlane_id": self.lane.pk, "position": 0},
            format="json",
        )

    def _clear(self):
        return self._client().patch(
            f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/",
            {"custom_field_values": [{"field_definition": self.amount.pk, "value": ""}]},
            format="json",
        )

    def _race(self, target, holder_fn, second_fn):
        """Run ``holder_fn`` with ``target`` (a module, attribute) held open right
        after it ran, start ``second_fn``, prove it waits on a lock, release.
        Returns both responses."""
        module, attr = target
        held, release = threading.Event(), threading.Event()
        results, errors = {}, []
        real = getattr(module, attr)

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

        with patch.object(module, attr, side_effect=hold), patch("boards.broadcast.broadcast_board_event"):
            first = threading.Thread(target=worker, args=("first", holder_fn), name="first")
            first.start()
            self.assertTrue(held.wait(HOLD_TIMEOUT), "the first request never reached its hold point")
            second = threading.Thread(target=worker, args=("second", second_fn), name="second")
            second.start()
            try:
                assert_blocked_on_lock(self, second, "the second request did not wait on the card row")
            finally:
                release.set()
                first.join(30)
                second.join(30)
        self.assertFalse(first.is_alive() or second.is_alive(), "a request hung")
        self.assertEqual(errors, [], "a request raised (a deadlock surfaces here)")
        return results["first"], results["second"]

    def test_a_clear_waits_for_a_move_that_already_passed_the_check(self):
        move, clear = self._race((card_services, "enforce_column_limits"), self._move, self._clear)
        self.assertEqual(move.status_code, 200, move.content)
        self.assertEqual(clear.status_code, 200, clear.content)
        self.card.refresh_from_db()
        self.assertEqual(self.card.column_id, self.dst.pk)
        self.assertFalse(CustomFieldValue.objects.filter(card=self.card, field_definition=self.amount).exists())

    def test_a_move_waits_for_a_clear_and_then_sees_the_cleared_value(self):
        clear, move = self._race(
            (custom_field_services, "apply_custom_field_values"), self._clear, self._move,
        )
        self.assertEqual(clear.status_code, 200, clear.content)
        self.assertEqual(move.status_code, 409, move.content)
        self.assertEqual(move.json()["code"], "entry_requirements_unmet")
        self.card.refresh_from_db()
        self.assertEqual(self.card.column_id, self.src.pk)
        self.assertFalse(CardMovement.objects.filter(card=self.card).exists())
