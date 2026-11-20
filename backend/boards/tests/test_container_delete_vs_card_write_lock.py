"""A column, swimlane or board delete racing a card child write (#1599).

The mirror of #1587's ``delete_card`` fix. Deleting a container cascades to
its cards, and Django's collector reads the cards' child rows (comments,
checklist items, attachments, relations, activity) before it deletes them. A
child write holding ``lock_card_for_write`` could insert a row the collector
had not seen and commit before the container's card ``DELETE`` ran; the card
foreign keys are ``DEFERRABLE INITIALLY DEFERRED`` on PostgreSQL, so the
container delete then failed its own FK check at COMMIT with an
``IntegrityError`` — a 500 on ``DELETE`` of the column, swimlane or board.

The fix is ``boards.services.cards.lock_cards_for_cascade``: each container
delete locks every card it is about to cascade to, ``FOR UPDATE`` in one
pk-ordered statement, before the collector runs. A write that started first
then commits before the collector reads, so its new rows are cascaded away
too; a write that starts after waits, finds the card gone, and answers 404.

PostgreSQL only: the race needs real concurrent transactions (the
hold-the-transaction pattern from ``docs/development/testing.md``). To see
the bug, make ``lock_cards_for_cascade`` a no-op: every ``*_then_delete`` test
fails with an ``IntegrityError`` raised from the container delete.
"""

import threading
from unittest import skipUnless
from unittest.mock import patch

from django.db import connection, connections
from django.test import TransactionTestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board,
    BoardMembership,
    Card,
    CardActivity,
    CardChecklist,
    CardComment,
    Column,
    Swimlane,
)
from boards.services import cards as card_services
from boards.tests.lock_wait import assert_blocked_on_lock

SERVICES = "boards.services.cards"
HOLD_TIMEOUT = 10.0


@skipUnless(
    connection.vendor == "postgresql", "row locks are only observable on PostgreSQL"
)
class ContainerDeleteVsCardWriteLockTests(TransactionTestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="racer1599", password="pass")
        self.board = Board.objects.create(name="B", owner=self.user)
        BoardMembership.objects.create(
            board=self.board,
            user=self.user,
            role=BoardMembership.Role.ADMIN,
        )
        self.column = Column.objects.create(board=self.board, name="A", position=0)
        self.swimlane = Swimlane.objects.create(board=self.board, name="G", position=0)
        # Two cards in the container, the raced one with the higher pk, so the
        # cascade lock has more than one row to take in pk order.
        self.first = Card.objects.create(
            board=self.board,
            column=self.column,
            swimlane=self.swimlane,
            title="first",
            created_by=self.user,
            position=0,
        )
        self.card = Card.objects.create(
            board=self.board,
            column=self.column,
            swimlane=self.swimlane,
            title="raced",
            created_by=self.user,
            position=1,
        )
        self.item = CardChecklist.objects.create(
            card=self.card,
            text="todo",
            created_by=self.user,
            position=0,
        )
        self.card_base = f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}"
        patcher = patch("boards.broadcast.broadcast_board_event")
        patcher.start()
        self.addCleanup(patcher.stop)

    # -- helpers --------------------------------------------------------------

    def _container_url(self, kind):
        board_url = f"/api/v1/boards/{self.board.pk}/"
        return {
            "column": f"{board_url}columns/{self.column.pk}/",
            "swimlane": f"{board_url}swimlanes/{self.swimlane.pk}/",
            "board": board_url,
        }[kind]

    def _writes(self):
        return {
            "comment": lambda c: c.post(
                f"{self.card_base}/comments/", {"body": "hi"}, format="json"
            ),
            "checklist_create": lambda c: c.post(
                f"{self.card_base}/checklist/",
                {"text": "x"},
                format="json",
            ),
            # Writes an activity row against the card.
            "checklist_patch": lambda c: c.patch(
                f"{self.card_base}/checklist/{self.item.pk}/",
                {"is_checked": True},
                format="json",
            ),
        }

    def _client(self):
        client = APIClient()
        client.force_authenticate(self.user)
        return client

    def _thread(self, name, fn, results):
        def run():
            try:
                results[name] = fn(self._client())
            except Exception as exc:  # surfaced by _status below
                results[name] = exc
            finally:
                connections.close_all()

        t = threading.Thread(target=run, name=name)
        t.start()
        return t

    def _pause_in(self, target, thread_name, paused, release, *, after=False):
        """Wrap ``target`` so its first call on ``thread_name`` holds the
        caller's open transaction until ``release`` is set — before the real
        call, or after it when ``after`` is true."""
        module_path, attr = target.rsplit(".", 1)
        real = getattr(__import__(module_path, fromlist=[attr]), attr)

        def hold():
            if threading.current_thread().name == thread_name and not paused.is_set():
                paused.set()
                release.wait(HOLD_TIMEOUT)

        def wrapper(*args, **kwargs):
            if not after:
                hold()
            result = real(*args, **kwargs)
            if after:
                hold()
            return result

        return patch(target, side_effect=wrapper)

    def _status(self, results, name):
        value = results.get(name)
        if isinstance(value, Exception):
            self.fail(f"{name} raised {type(value).__name__}: {value}")
        return value.status_code

    def _assert_cards_and_children_gone(self):
        pks = [self.first.pk, self.card.pk]
        self.assertFalse(Card.objects.filter(pk__in=pks).exists())
        self.assertFalse(CardComment.objects.filter(card_id__in=pks).exists())
        self.assertFalse(CardChecklist.objects.filter(card_id__in=pks).exists())
        self.assertFalse(CardActivity.objects.filter(card_id__in=pks).exists())

    # -- the two orders -------------------------------------------------------

    def _write_then_delete(self, kind, write, expected):
        """The write holds the card lock with its new row uncommitted; the
        container delete must queue behind it, then cascade the new row away
        instead of failing its deferred FK check at COMMIT."""
        paused, release, results = threading.Event(), threading.Event(), {}
        # The refetch runs after the write's insert and before its COMMIT.
        with self._pause_in(
            "boards.views._helpers._card_queryset", "writer", paused, release
        ):
            writer = self._thread("writer", self._writes()[write], results)
            self.assertTrue(
                paused.wait(HOLD_TIMEOUT), "writer never reached its hold point"
            )
            deleter = self._thread(
                "deleter",
                lambda c: c.delete(self._container_url(kind)),
                results,
            )
            assert_blocked_on_lock(self, deleter, "container delete did not wait for the card lock")
            release.set()
            writer.join(HOLD_TIMEOUT)
            deleter.join(HOLD_TIMEOUT)
        self.assertEqual(self._status(results, "writer"), expected)
        self.assertEqual(self._status(results, "deleter"), 204)
        self._assert_cards_and_children_gone()

    def _delete_then_write(self, kind, write):
        """The container delete holds its card locks; the write queues behind
        them, finds the card gone, and answers 404 with nothing written."""
        paused, release, results = threading.Event(), threading.Event(), {}
        with self._pause_in(
            f"{SERVICES}.lock_cards_for_cascade",
            "deleter",
            paused,
            release,
            after=True,
        ):
            deleter = self._thread(
                "deleter",
                lambda c: c.delete(self._container_url(kind)),
                results,
            )
            self.assertTrue(
                paused.wait(HOLD_TIMEOUT), "delete never reached its hold point"
            )
            writer = self._thread("writer", self._writes()[write], results)
            assert_blocked_on_lock(self, writer, "write did not wait for the delete's card lock")
            release.set()
            deleter.join(HOLD_TIMEOUT)
            writer.join(HOLD_TIMEOUT)
        self.assertEqual(self._status(results, "deleter"), 204)
        self.assertEqual(self._status(results, "writer"), 404)
        self._assert_cards_and_children_gone()

    # -- column ---------------------------------------------------------------

    def test_comment_then_column_delete(self):
        self._write_then_delete("column", "comment", 201)

    def test_checklist_create_then_column_delete(self):
        self._write_then_delete("column", "checklist_create", 201)

    def test_checklist_patch_then_column_delete(self):
        self._write_then_delete("column", "checklist_patch", 200)

    def test_column_delete_then_comment_returns_404(self):
        self._delete_then_write("column", "comment")

    # -- swimlane -------------------------------------------------------------

    def test_comment_then_swimlane_delete(self):
        self._write_then_delete("swimlane", "comment", 201)

    def test_checklist_patch_then_swimlane_delete(self):
        self._write_then_delete("swimlane", "checklist_patch", 200)

    def test_swimlane_delete_then_comment_returns_404(self):
        self._delete_then_write("swimlane", "comment")

    # -- board ----------------------------------------------------------------

    def test_comment_then_board_delete(self):
        self._write_then_delete("board", "comment", 201)

    def test_checklist_patch_then_board_delete(self):
        self._write_then_delete("board", "checklist_patch", 200)

    def test_board_delete_then_comment_returns_404(self):
        self._delete_then_write("board", "comment")

    # -- lock shape -----------------------------------------------------------

    def test_cascade_lock_is_one_pk_ordered_for_update_statement(self):
        """One statement however many cards (no per-card query), ordered by
        pk so it queues with move_card's pk-ordered card lock instead of
        deadlocking, and FOR UPDATE because the cascade DELETEs the rows."""
        from django.db import transaction
        from django.test.utils import CaptureQueriesContext

        for i in range(5):
            Card.objects.create(
                board=self.board,
                column=self.column,
                swimlane=self.swimlane,
                title=f"extra{i}",
                created_by=self.user,
                position=2 + i,
            )
        with transaction.atomic(), CaptureQueriesContext(connection) as ctx:
            card_services.lock_cards_for_cascade(
                Card.objects.filter(column=self.column)
            )
        # Exactly one locking statement; the rest are the unlocked link-peer
        # reads and the re-read of #2409 (and the retry savepoint).
        locking = [q["sql"] for q in ctx.captured_queries if " FOR " in q["sql"]]
        self.assertEqual(len(locking), 1, ctx.captured_queries)
        sql = locking[0]
        self.assertIn("ORDER BY", sql)
        # OF "cards": a joined filter must not lock board rows (#1602).
        self.assertRegex(sql.rstrip(), r'FOR UPDATE OF "cards"$')
