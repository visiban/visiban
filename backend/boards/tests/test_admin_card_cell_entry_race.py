"""A Django admin card edit must take the column lock when it changes a cell (#1588).

``move_card`` re-reads its cells' members once it holds their column rows
(``_require_cells_locked``, #1567). That re-check is conclusive only if every
writer that puts a card into a cell holds that cell's column row until it
commits. Before #1588 the Django admin did not for a swimlane-only change
within one column, nor for any cell change on an archived card (archived cards
are still cell members), so a card could arrive behind the re-check:

1. T2 moves Y from B into cell (A, S1), locking Z (the cell's only card) and
   both columns, and passes its re-check.
2. The admin moves X (lowest pk) from (A, S2) into (A, S1) — same column, so
   no limit check and, before #1588, no lock — and commits.
3. T3 starts moving X out of (A, S1). It locks X, then queues on Z.
4. T2's shift of (A, S1) (``position >= 0``) needs X, which T3 holds while
   waiting on T2: ``deadlock detected``, a 500 on ``POST /cards/<id>/move/``.

The contract pinned here: the admin save locks X and then column A, so it
queues behind T2, and T3 queues behind the admin; all three succeed and the
board ends consistent. The archived variant is the same race with X archived —
the shift UPDATE has no ``archived_at`` filter.

Technique: the hold-the-transaction pattern from ``docs/development/testing.md``
("Row-lock tests"). PostgreSQL only; SQLite has no row locks. To see the bug,
make ``lock_card_cell_entry`` a no-op: the test then fails with ``deadlock
detected``.
"""

import threading
import time
from unittest import skipUnless
from unittest.mock import patch

from django.contrib import admin as django_admin
from django.db import connection, connections
from django.forms import MultiWidget
from django.test import Client, RequestFactory, TransactionTestCase
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, Column, Swimlane

SERVICES_CARDS = "boards.services.cards"
PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"
HOLD_SECONDS = 2.0
# How long after the admin request starts T3 waits before moving X. Long
# enough for an unlocked admin save to commit, short enough that T3 queues on
# Z well inside T2's hold.
THIRD_DELAY = 0.5


def _admin_post_data(card, **overrides):
    """The change form's own initial data for ``card``, as POST data."""
    superuser = User.objects.filter(is_superuser=True).first()
    request = RequestFactory().get("/")
    request.user = superuser
    model_admin = django_admin.site._registry[Card]
    form = model_admin.get_form(request, obj=card)(instance=card)
    data = {}
    for name, field in form.fields.items():
        value = overrides.get(name, form.initial.get(name))
        if isinstance(field.widget, MultiWidget):
            parts = field.widget.decompress(value)
            for i, part in enumerate(parts):
                data[f"{name}_{i}"] = "" if part is None else str(part)
        elif isinstance(value, (list, tuple)):
            data[name] = [getattr(v, "pk", v) for v in value]
        elif isinstance(value, bool):
            if value:
                data[name] = "on"
        else:
            data[name] = "" if value is None else str(getattr(value, "pk", value))
    return data


@skipUnless(connection.vendor == "postgresql", "row locks are only observable on PostgreSQL")
class AdminCardCellEntryRaceTests(TransactionTestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="racer1588", password="pass", is_staff=True, is_superuser=True,
        )
        self.board = Board.objects.create(name="Race Board", owner=self.user)
        BoardMembership.objects.create(
            board=self.board, user=self.user, role=BoardMembership.Role.ADMIN,
        )
        self.col_a = Column.objects.create(board=self.board, name="A", position=0)
        self.col_b = Column.objects.create(board=self.board, name="B", position=1)
        self.col_c = Column.objects.create(board=self.board, name="C", position=2)
        self.s1 = Swimlane.objects.create(board=self.board, name="S1", position=0)
        self.s2 = Swimlane.objects.create(board=self.board, name="S2", position=1)
        # X is created first so it has the lowest pk: T3 locks it before
        # queuing on Z, which is what closes the cycle.
        self.x = Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.s2,
            title="X", created_by=self.user, position=0,
        )
        self.z = Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.s1,
            title="Z", created_by=self.user, position=0,
        )
        self.y = Card.objects.create(
            board=self.board, column=self.col_b, swimlane=self.s1,
            title="Y", created_by=self.user, position=0,
        )
        self.assertLess(self.x.pk, self.z.pk)

    def _move(self, card, column, swimlane, position):
        def run():
            client = APIClient()
            client.force_authenticate(self.user)
            return client.post(
                f"/api/v1/boards/{self.board.pk}/cards/{card.pk}/move/",
                {"column_id": column.pk, "swimlane_id": swimlane.pk, "position": position},
            ).status_code
        return run

    def _admin_swimlane_change(self, data):
        def run():
            client = Client()
            client.force_login(self.user)
            response = client.post(reverse("admin:boards_card_change", args=[self.x.pk]), data)
            # 302 is the admin's redirect after a successful save; a 200 is
            # the form re-rendered with errors.
            return response.status_code
        return run

    def _run_race(self):
        # Position 5 keeps X clear of T3's compaction (``position > 5``) once
        # it leaves (A, S1), while T2's shift (``position >= 0``) still
        # matches it — the UPDATE that would lock it out of pk order.
        self.x.refresh_from_db()
        data = _admin_post_data(self.x, swimlane=self.s1.pk, position=5)

        module = __import__(SERVICES_CARDS, fromlist=["x"])
        original_recheck = module._require_cells_locked
        original_read = module._read_card_for_move
        second_paused = threading.Event()
        admin_started = threading.Event()
        read_calls = {"second": 0, "third": 0}
        results, errors, timings = {}, [], {}

        def hold_second(*args, **kwargs):
            # T2 holds Z and both columns, past its re-check and before its
            # shift, until the admin and T3 have both run into it.
            out = original_recheck(*args, **kwargs)
            if threading.current_thread().name == "second" and not second_paused.is_set():
                second_paused.set()
                threading.Event().wait(HOLD_SECONDS)
            return out

        def counting_read(*args, **kwargs):
            name = threading.current_thread().name
            if name in read_calls:
                read_calls[name] += 1
            return original_read(*args, **kwargs)

        def worker(name, fn, wait_for, delay=0.0, started=None):
            try:
                if wait_for is not None and not wait_for.wait(10):
                    raise RuntimeError(f"{name}: the previous step never reached its hold point")
                if delay:
                    threading.Event().wait(delay)
                if started is not None:
                    started.set()
                begin = time.monotonic()
                results[name] = fn()
                timings[name] = time.monotonic() - begin
            except BaseException as exc:  # noqa: BLE001 - surfaced after join
                errors.append(exc)
            finally:
                connections.close_all()  # release this thread's PostgreSQL connection

        threads = [
            threading.Thread(
                target=worker, name="second",
                args=("second", self._move(self.y, self.col_a, self.s1, 0), None),
            ),
            threading.Thread(
                target=worker, name="admin",
                args=("admin", self._admin_swimlane_change(data), second_paused),
                kwargs={"started": admin_started},
            ),
            threading.Thread(
                target=worker, name="third",
                args=("third", self._move(self.x, self.col_c, self.s1, 0), admin_started),
                kwargs={"delay": THIRD_DELAY},
            ),
        ]
        started = time.monotonic()
        with patch(f"{SERVICES_CARDS}._require_cells_locked", side_effect=hold_second), \
                patch(f"{SERVICES_CARDS}._read_card_for_move", side_effect=counting_read), \
                patch(PATCH_BROADCAST):
            for t in threads:
                t.start()
            for t in threads:
                t.join(30)
        self.assertFalse(any(t.is_alive() for t in threads), "a request hung")
        # Without the admin's column lock, T2 or T3 is aborted with "deadlock
        # detected" (an OperationalError the test client re-raises).
        self.assertEqual(errors, [])
        self.assertEqual(results, {"second": 200, "admin": 302, "third": 200})
        self.assertGreaterEqual(time.monotonic() - started, HOLD_SECONDS)
        # The admin save really queued on column A behind T2's hold.
        self.assertGreaterEqual(timings["admin"], HOLD_SECONDS - THIRD_DELAY - 0.3)
        # T3 read X in (A, S2), waited on the admin's lock on X, found its
        # swimlane changed and retried once. T2 never retried.
        self.assertEqual(read_calls, {"second": 1, "third": 2})

        self.x.refresh_from_db()
        self.y.refresh_from_db()
        self.z.refresh_from_db()
        self.assertEqual(
            (self.x.column_id, self.x.swimlane_id, self.x.position),
            (self.col_c.pk, self.s1.pk, 0),
        )
        self.assertEqual(
            (self.y.column_id, self.y.swimlane_id, self.y.position),
            (self.col_a.pk, self.s1.pk, 0),
        )
        self.assertEqual(
            (self.z.column_id, self.z.swimlane_id, self.z.position),
            (self.col_a.pk, self.s1.pk, 1),
        )
        return self.x

    def test_admin_swimlane_only_change_queues_behind_a_move_into_the_cell(self):
        x = self._run_race()
        self.assertIsNone(x.archived_at)

    def test_admin_cell_change_on_archived_card_queues_behind_a_move_into_the_cell(self):
        archived_at = timezone.now()
        Card.objects.filter(pk=self.x.pk).update(archived_at=archived_at)
        x = self._run_race()
        self.assertEqual(x.archived_at, archived_at)


@skipUnless(connection.vendor == "postgresql", "row locks are only observable on PostgreSQL")
class AdminRestoreVersusMoveRaceTests(TransactionTestCase):
    """An admin restore must lock the card before the column (#1588).

    Before the fix an in-place restore (or weight increase) ran
    ``enforce_column_limits`` with its own lock, taking column A *before* the
    card row, which the save then locked. ``move_card`` takes the card first
    and the columns after, so a move of the same card out of A deadlocked:

    1. The move locks X, then pauses before locking columns A and B.
    2. The admin restores X: it locks column A for the limit check, then its
       UPDATE of X queues on the move.
    3. The move asks for column A: ``deadlock detected``.

    With the fix the admin locks X first, queues behind the move, re-reads X
    (now in B) under the lock and restores it into A. To see the bug, restore
    ``CardAdminForm.clean`` from before the fix: this test then fails with
    ``deadlock detected``.
    """

    def setUp(self):
        self.user = User.objects.create_user(
            username="restore1588", password="pass", is_staff=True, is_superuser=True,
        )
        self.board = Board.objects.create(
            name="Restore Race", owner=self.user, enforce_wip_limits=True,
        )
        BoardMembership.objects.create(
            board=self.board, user=self.user, role=BoardMembership.Role.ADMIN,
        )
        # A has a WIP limit so the restore's limit check takes a column lock.
        self.col_a = Column.objects.create(board=self.board, name="A", position=0, wip_limit=5)
        self.col_b = Column.objects.create(board=self.board, name="B", position=1)
        self.s1 = Swimlane.objects.create(board=self.board, name="S1", position=0)
        self.x = Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.s1,
            title="X", created_by=self.user, position=0, archived_at=timezone.now(),
        )

    def test_admin_restore_queues_behind_a_move_of_the_same_card(self):
        data = _admin_post_data(self.x)
        data["archived_at_0"] = data["archived_at_1"] = ""

        module = __import__(SERVICES_CARDS, fromlist=["x"])
        original_lock_columns = module._lock_move_columns
        mover_paused = threading.Event()
        results, errors, timings = {}, [], {}

        def pause_before_columns(*args, **kwargs):
            # The move holds X's row and has not yet asked for the columns.
            if threading.current_thread().name == "mover" and not mover_paused.is_set():
                mover_paused.set()
                threading.Event().wait(HOLD_SECONDS)
            return original_lock_columns(*args, **kwargs)

        def restore():
            client = Client()
            client.force_login(self.user)
            return client.post(reverse("admin:boards_card_change", args=[self.x.pk]), data).status_code

        def move():
            client = APIClient()
            client.force_authenticate(self.user)
            return client.post(
                f"/api/v1/boards/{self.board.pk}/cards/{self.x.pk}/move/",
                {"column_id": self.col_b.pk, "swimlane_id": self.s1.pk, "position": 0},
            ).status_code

        def worker(name, fn, wait_for):
            try:
                if wait_for is not None and not wait_for.wait(10):
                    raise RuntimeError(f"{name}: the move never reached its pause")
                begin = time.monotonic()
                results[name] = fn()
                timings[name] = time.monotonic() - begin
            except BaseException as exc:  # noqa: BLE001 - surfaced after join
                errors.append(exc)
            finally:
                connections.close_all()  # release this thread's PostgreSQL connection

        threads = [
            threading.Thread(target=worker, name="mover", args=("mover", move, None)),
            threading.Thread(target=worker, name="admin", args=("admin", restore, mover_paused)),
        ]
        with patch(f"{SERVICES_CARDS}._lock_move_columns", side_effect=pause_before_columns), \
                patch(PATCH_BROADCAST):
            for t in threads:
                t.start()
            for t in threads:
                t.join(30)
        self.assertFalse(any(t.is_alive() for t in threads), "a request hung")
        self.assertEqual(errors, [])
        self.assertEqual(results, {"mover": 200, "admin": 302})
        # The admin queued on X behind the move's pause.
        self.assertGreaterEqual(timings["admin"], HOLD_SECONDS - 0.5)

        # The move committed X into B; the admin, re-reading under its lock,
        # then restored it into the column the form named.
        self.x.refresh_from_db()
        self.assertIsNone(self.x.archived_at)
        self.assertEqual(self.x.column_id, self.col_a.pk)
