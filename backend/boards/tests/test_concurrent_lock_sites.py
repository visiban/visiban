"""PostgreSQL lock tests for the remaining ``select_for_update`` sites (#1524).

#1504 covers the locks in ``move_card`` / ``enforce_column_limits``
(``test_concurrent_moves.py``). This module covers the other sites, which have
the same shape: SQLite has no row locks, so the ``select_for_update()`` calls are
unobservable there and removing one passes the whole SQLite suite.

Technique (same as ``ConcurrentMoveLockTests``): the first request is paused
inside its transaction, after it took its lock and wrote, before it commits. The
second request starts only once the first is paused. With the lock the second
queues behind the first, so it cannot finish before the pause ends and it sees
the first's committed rows. Without the lock it runs to completion during the
pause against stale state. Each test asserts both the ordering (``second``
finished no earlier than the pause ended) and the resulting state.

Site coverage:

* ``services/cards.py`` ``create_card`` column-row lock -> ``CreateCardLockTests``
* ``views/cards.py`` ``relations`` card-row lock       -> ``CardRelationLockTests``
* ``views/columns.py`` ``perform_create`` board lock   -> ``BoardRowLockTests``
* ``views/swimlanes.py`` ``perform_create`` / ``reorder`` -> ``BoardRowLockTests``
* ``views/custom_fields.py`` create / update           -> ``BoardRowLockTests``
* ``views/swimlane_custom_fields.py`` create / update  -> ``BoardRowLockTests``
* ``views/columns.py`` ``reorder`` board lock          -> deliberately NOT here:
  #1522 is changing the column reorder locking, so a test here would pin the
  ordering that issue replaces. Covered by #1522.

Not covered: the ``order_by("pk")`` in the card-relation lock. It only matters
when two requests acquire the *same pair* of locks in opposite orders, and this
harness pauses after both locks are held, so it cannot make a missing sort
deadlock deterministically.
"""

import threading
import time
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
    CardRelation,
    Column,
    CustomFieldDefinition,
    Swimlane,
    SwimlaneCustomFieldDefinition,
)
from boards.views.cards import CardViewSet

PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"
RECORD_EVENT = "boards.broadcast.record_board_event"
HOLD_SECONDS = 1.5


@skipUnless(
    connection.vendor == "postgresql", "row locks are only observable on PostgreSQL"
)
class _LockRaceBase(TransactionTestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="locker", password="pass")
        self.board = Board.objects.create(name="Lock Board", owner=self.user)
        BoardMembership.objects.create(
            board=self.board, user=self.user, role=BoardMembership.Role.ADMIN
        )
        self.col = Column.objects.create(
            board=self.board, name="Backlog", position=0, allow_card_creation=True
        )
        self.swim = Swimlane.objects.create(
            board=self.board, name="General", position=0
        )

    @property
    def base(self):
        return f"/api/v1/boards/{self.board.pk}"

    def _request(self, method, path, data=None):
        """Return a callable that performs one authenticated API request."""

        def run():
            client = APIClient()
            client.force_authenticate(self.user)
            return getattr(client, method)(f"{self.base}{path}", data, format="json")

        return run

    def _race(
        self, first, second, *, patch_target=RECORD_EVENT, patch_obj=None, attr=None
    ):
        """Run two request callables with ``first`` paused inside its transaction.

        The pause happens at the first call ``first`` makes to the patched hook
        (always a function that runs after the lock is taken and the rows are
        written, before commit). Returns ``(responses, hold_ended)`` where
        ``hold_ended`` is the monotonic time the pause finished and
        ``responses`` maps ``first``/``second`` to ``(response, finished_at)``.
        """
        paused = threading.Event()
        done = {}
        errors = []
        marks = {}
        holder = (
            patch_obj
            if patch_obj is not None
            else __import__(patch_target.rsplit(".", 1)[0], fromlist=["x"])
        )
        name = attr or patch_target.rsplit(".", 1)[1]
        original = getattr(holder, name)

        def hold(*args, **kwargs):
            out = original(*args, **kwargs)
            if threading.current_thread().name == "first" and not paused.is_set():
                paused.set()
                # Never set: a plain timed pause that keeps the transaction and
                # its locks open.
                threading.Event().wait(HOLD_SECONDS)
                marks["hold_ended"] = time.monotonic()
            return out

        def worker(label, fn, wait_for_first):
            try:
                if wait_for_first and not paused.wait(10):
                    raise RuntimeError("first request never reached the hold point")
                resp = fn()
                done[label] = (resp, time.monotonic())
            except BaseException as exc:  # noqa: BLE001 - surfaced after join
                errors.append(exc)
            finally:
                connections.close_all()  # release this thread's PostgreSQL connection

        with patch.object(holder, name, new=hold), patch(PATCH_BROADCAST):
            t1 = threading.Thread(
                target=worker, args=("first", first, False), name="first"
            )
            t2 = threading.Thread(
                target=worker, args=("second", second, True), name="second"
            )
            t1.start()
            t2.start()
            t1.join(30)
            t2.join(30)
        self.assertFalse(
            t1.is_alive() or t2.is_alive(), "a request hung (possible deadlock)"
        )
        self.assertEqual(errors, [])
        self.assertIn("hold_ended", marks, "first request never reached the hold point")
        return done, marks["hold_ended"]

    def assertQueued(self, done, hold_ended):
        """``second`` could not finish before ``first`` released its lock."""
        self.assertGreaterEqual(
            done["second"][1],
            hold_ended,
            "second request finished while the first was still holding its transaction "
            "open: the lock did not make it wait",
        )


class CreateCardLockTests(_LockRaceBase):
    def test_column_lock_serializes_creates_in_one_cell(self):
        """create_card's column-row lock keeps positions distinct (#1050).

        Positions come from a count taken after the lock. Without it both
        creates count 0 and both take position 0.
        """
        body = {"column": self.col.pk, "swimlane": self.swim.pk}
        done, hold_ended = self._race(
            self._request("post", "/cards/", {**body, "title": "One"}),
            self._request("post", "/cards/", {**body, "title": "Two"}),
            patch_target="boards.services.cards.enforce_column_limits",
        )
        self.assertEqual(done["first"][0].status_code, 201)
        self.assertEqual(done["second"][0].status_code, 201)
        self.assertQueued(done, hold_ended)
        positions = sorted(
            Card.objects.filter(column=self.col, swimlane=self.swim).values_list(
                "position", flat=True
            )
        )
        self.assertEqual(positions, [0, 1])


class CardRelationLockTests(_LockRaceBase):
    def test_card_lock_rejects_the_opposite_direction_link(self):
        """The relation view's card-row lock closes the mutual-block race.

        A-blocks-B and B-blocks-A are different unique tuples, so only the lock
        lets the second request's validation see the first's uncommitted row.
        Without it both commit and the cards block each other.
        """
        a = Card.objects.create(
            board=self.board,
            column=self.col,
            swimlane=self.swim,
            title="A",
            created_by=self.user,
            position=0,
        )
        b = Card.objects.create(
            board=self.board,
            column=self.col,
            swimlane=self.swim,
            title="B",
            created_by=self.user,
            position=1,
        )
        done, hold_ended = self._race(
            self._request(
                "post",
                f"/cards/{a.pk}/relations/",
                {"to_card": b.pk, "direction": "blocks"},
            ),
            self._request(
                "post",
                f"/cards/{b.pk}/relations/",
                {"to_card": a.pk, "direction": "blocks"},
            ),
            patch_obj=CardViewSet,
            attr="_broadcast_relation_change",
            patch_target="boards.views.cards.CardViewSet._broadcast_relation_change",
        )
        self.assertEqual(done["first"][0].status_code, 201)
        self.assertEqual(done["second"][0].status_code, 400)
        self.assertQueued(done, hold_ended)
        self.assertEqual(CardRelation.objects.count(), 1)


class BoardRowLockTests(_LockRaceBase):
    def _swimlane_post(self, name):
        return self._request("post", "/swimlanes/", {"name": name})

    def test_column_create_lock_gives_distinct_positions(self):
        done, hold_ended = self._race(
            self._request("post", "/columns/", {"name": "X"}),
            self._request("post", "/columns/", {"name": "Y"}),
        )
        self.assertEqual(done["first"][0].status_code, 201)
        self.assertEqual(done["second"][0].status_code, 201)
        self.assertQueued(done, hold_ended)
        positions = sorted(
            Column.objects.filter(board=self.board).values_list("position", flat=True)
        )
        self.assertEqual(positions, [0, 1, 2])

    def test_swimlane_create_lock_gives_distinct_positions(self):
        done, hold_ended = self._race(
            self._swimlane_post("X"), self._swimlane_post("Y")
        )
        self.assertEqual(done["first"][0].status_code, 201)
        self.assertEqual(done["second"][0].status_code, 201)
        self.assertQueued(done, hold_ended)
        positions = sorted(
            Swimlane.objects.filter(board=self.board).values_list("position", flat=True)
        )
        self.assertEqual(positions, [0, 1, 2])

    def test_swimlane_reorder_lock_queues_a_concurrent_create(self):
        """A create must not slip in between reorder's set check and its writes."""
        extra = Swimlane.objects.create(board=self.board, name="Extra", position=1)
        done, hold_ended = self._race(
            self._request(
                "post", "/swimlanes/reorder/", {"order": [extra.pk, self.swim.pk]}
            ),
            self._swimlane_post("Late"),
        )
        self.assertEqual(done["first"][0].status_code, 200)
        self.assertEqual(done["second"][0].status_code, 201)
        self.assertQueued(done, hold_ended)

    def _fill(self, model, count, pinned_attr, pinned):
        return [
            model.objects.create(
                board=self.board,
                name=f"f{i}",
                position=i,
                field_type="text",
                **{pinned_attr: i < pinned},
            )
            for i in range(count)
        ]

    def test_custom_field_create_lock_enforces_the_per_board_cap(self):
        self._fill(
            CustomFieldDefinition,
            CustomFieldDefinition.MAX_PER_BOARD - 1,
            "show_on_card",
            0,
        )
        post = lambda n: self._request(  # noqa: E731
            "post", "/custom-fields/", {"name": n, "field_type": "text"}
        )
        done, hold_ended = self._race(post("X"), post("Y"))
        self.assertEqual(done["first"][0].status_code, 201)
        self.assertEqual(done["second"][0].status_code, 400)
        self.assertQueued(done, hold_ended)
        self.assertEqual(
            CustomFieldDefinition.objects.filter(board=self.board).count(),
            CustomFieldDefinition.MAX_PER_BOARD,
        )

    def test_custom_field_update_lock_enforces_the_pinned_cap(self):
        cap = CustomFieldDefinition.MAX_PINNED_PER_BOARD
        defs = self._fill(CustomFieldDefinition, cap + 1, "show_on_card", cap - 1)
        patch_pin = lambda d: self._request(  # noqa: E731
            "patch", f"/custom-fields/{d.pk}/", {"show_on_card": True}
        )
        done, hold_ended = self._race(patch_pin(defs[-1]), patch_pin(defs[-2]))
        statuses = {done["first"][0].status_code, done["second"][0].status_code}
        self.assertEqual(done["first"][0].status_code, 200)
        self.assertEqual(done["second"][0].status_code, 400, statuses)
        self.assertQueued(done, hold_ended)
        self.assertEqual(
            CustomFieldDefinition.objects.filter(
                board=self.board, show_on_card=True
            ).count(),
            cap,
        )

    def test_swimlane_custom_field_create_lock_enforces_the_per_board_cap(self):
        self._fill(
            SwimlaneCustomFieldDefinition,
            SwimlaneCustomFieldDefinition.MAX_PER_BOARD - 1,
            "show_on_row",
            0,
        )
        post = lambda n: self._request(  # noqa: E731
            "post", "/swimlane-custom-fields/", {"name": n, "field_type": "text"}
        )
        done, hold_ended = self._race(post("X"), post("Y"))
        self.assertEqual(done["first"][0].status_code, 201)
        self.assertEqual(done["second"][0].status_code, 400)
        self.assertQueued(done, hold_ended)
        self.assertEqual(
            SwimlaneCustomFieldDefinition.objects.filter(board=self.board).count(),
            SwimlaneCustomFieldDefinition.MAX_PER_BOARD,
        )

    def test_swimlane_custom_field_update_lock_enforces_the_pinned_cap(self):
        cap = SwimlaneCustomFieldDefinition.MAX_PINNED_PER_BOARD
        defs = self._fill(
            SwimlaneCustomFieldDefinition, cap + 1, "show_on_row", cap - 1
        )
        patch_pin = lambda d: self._request(  # noqa: E731
            "patch", f"/swimlane-custom-fields/{d.pk}/", {"show_on_row": True}
        )
        done, hold_ended = self._race(patch_pin(defs[-1]), patch_pin(defs[-2]))
        self.assertEqual(done["first"][0].status_code, 200)
        self.assertEqual(done["second"][0].status_code, 400)
        self.assertQueued(done, hold_ended)
        self.assertEqual(
            SwimlaneCustomFieldDefinition.objects.filter(
                board=self.board, show_on_row=True
            ).count(),
            cap,
        )
