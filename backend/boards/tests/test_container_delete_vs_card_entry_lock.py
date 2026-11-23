"""A column, swimlane or board delete racing a card *entering* it (#1602).

The follow-up to #1599 (``test_container_delete_vs_card_write_lock``).
``lock_cards_for_cascade`` locks the cards a container delete cascades to, but
only the ones that exist when it runs. A card ``create_card`` inserted into the
container, or one ``move_card`` moved into an empty cell of it (so there was no
container card to wait on), could commit after that statement and before the
collector's card ``DELETE``. The card's foreign keys are ``DEFERRABLE
INITIALLY DEFERRED`` on PostgreSQL, so the container delete then failed its FK
check at COMMIT with an ``IntegrityError`` — a 500 on ``DELETE``. The other
order was a 500 too: a create that queued behind the delete's column row found
it gone (``Column.DoesNotExist``), and a create or move into a deleted
swimlane failed its own deferred FK check.

The fix: the helper also takes ``entry_columns``, the column rows every
service path that puts a card into the container holds until it commits, and
locks them after the cards (card -> column, the documented order), then
re-reads the container's cards and retries under a savepoint if one arrived
that it did not lock. ``create_card`` and ``move_card`` re-check their target
column and swimlane once they hold the column row, answering 404 for a
container deleted while they waited.

Two orders per (container x entry path), over REST and the Django admin:

* ``entry_then_delete`` — the entry holds its column row with the new card
  uncommitted; the delete queues on the column, retries, and cascades the
  newcomer away (204), and the entry itself succeeds.
* ``delete_then_entry`` — the delete holds its locks; the entry queues on the
  column row, finds its target gone, and answers 404 with nothing written.

PostgreSQL only, except ``ContainerChangedTests``, which forces the retry to
exhaust and runs on SQLite too. To see the bug, call the helper without
``entry_columns`` in the views and admins: every ``entry_then_delete`` test
fails with a 500 or an ``IntegrityError`` and every ``delete_then_entry`` test
fails its "did not wait" assertion.
"""

import threading
from unittest import skipUnless
from unittest.mock import patch

import pytest
from django.contrib import admin as django_admin
from django.db import connection, connections, transaction
from django.contrib.admin.models import DELETION, LogEntry
from django.contrib.messages import get_messages
from django.test import (
    Client, RequestFactory, TestCase, TransactionTestCase, override_settings,
)
from django.urls import reverse
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board,
    BoardEvent,
    BoardMembership,
    Card,
    Column,
    Label,
    Swimlane,
)
from boards.services import cards as card_services
from boards.services.errors import ColumnNotFound, ContainerChanged, SwimlaneNotFound
from boards.tests.test_admin_card_cell_entry_race import _admin_post_data
from boards.tests.lock_wait import assert_blocked_on_lock

SERVICES = "boards.services.cards"
HOLD_TIMEOUT = 10.0
NEWCOMER = "newcomer1602"


class _EntryRaceBase:
    """Board with two columns (A, B) and two swimlanes (G, H).

    A and G are the containers deleted. Two cards sit in (A, G), so the
    cascade lock has rows to take; the mover sits in (B, H), outside both
    containers, and the entry targets are empty cells of the container so
    the entry never waits on a container card.
    """

    def setUp(self):
        self.owner = User.objects.create_user(username="owner1602", password="pass")
        self.user = User.objects.create_user(username="racer1602", password="pass")
        self.board = Board.objects.create(name="B", owner=self.owner)
        for member in (self.owner, self.user):
            BoardMembership.objects.create(
                board=self.board, user=member, role=BoardMembership.Role.ADMIN
            )
        self.col_a = Column.objects.create(
            board=self.board, name="A", position=0, allow_card_creation=True
        )
        self.col_b = Column.objects.create(
            board=self.board, name="B", position=1, allow_card_creation=True
        )
        self.lane_g = Swimlane.objects.create(board=self.board, name="G", position=0)
        self.lane_h = Swimlane.objects.create(board=self.board, name="H", position=1)
        self.cards = [
            Card.objects.create(
                board=self.board, column=self.col_a, swimlane=self.lane_g,
                title=f"c{i}", created_by=self.user, position=i,
            )
            for i in range(2)
        ]
        self.mover = Card.objects.create(
            board=self.board, column=self.col_b, swimlane=self.lane_h,
            title="mover", created_by=self.user, position=0,
        )
        patcher = patch("boards.broadcast.broadcast_board_event")
        patcher.start()
        self.addCleanup(patcher.stop)

    # -- helpers --------------------------------------------------------------

    def _target_cell(self, kind):
        """An empty cell inside the container ``kind``."""
        return {
            "column": (self.col_a, self.lane_h),
            "swimlane": (self.col_b, self.lane_g),
            "board": (self.col_a, self.lane_h),
            "user": (self.col_a, self.lane_h),
        }[kind]

    def _entry(self, kind, how):
        column, swimlane = self._target_cell(kind)
        base = f"/api/v1/boards/{self.board.pk}/cards/"
        if how == "create":
            return lambda c: c.post(
                base,
                {"column": column.pk, "swimlane": swimlane.pk, "title": NEWCOMER},
                format="json",
            )
        return lambda c: c.post(
            f"{base}{self.mover.pk}/move/",
            {"column_id": column.pk, "swimlane_id": swimlane.pk, "position": 0},
            format="json",
        )

    def _client(self):
        client = APIClient()
        client.force_authenticate(self.user)
        return client

    def _thread(self, name, fn, results):
        def run():
            try:
                results[name] = fn()
            except Exception as exc:  # surfaced by the status assertions
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
        value = results.get(name, "missing")
        if isinstance(value, Exception):
            self.fail(f"{name} raised {type(value).__name__}: {value}")
        self.assertNotEqual(value, "missing", f"{name} never finished")
        return getattr(value, "status_code", None)

    def _assert_container_and_cards_gone(self, kind, how):
        pks = [c.pk for c in self.cards]
        self.assertFalse(Card.objects.filter(pk__in=pks).exists())
        if how == "create":
            self.assertFalse(Card.objects.filter(title=NEWCOMER).exists())
        else:
            # The mover entered the container, so the cascade took it too.
            self.assertFalse(Card.objects.filter(pk=self.mover.pk).exists())
        model, pk = {
            "column": (Column, self.col_a.pk),
            "swimlane": (Swimlane, self.lane_g.pk),
            "board": (Board, self.board.pk),
            "user": (User, self.owner.pk),
        }[kind]
        self.assertFalse(model.objects.filter(pk=pk).exists())

    def _assert_entry_wrote_nothing(self, how):
        if how == "create":
            self.assertFalse(Card.objects.filter(title=NEWCOMER).exists())

    # -- the two orders -------------------------------------------------------

    def _rest_delete(self, kind):
        url = {
            "column": f"/api/v1/boards/{self.board.pk}/columns/{self.col_a.pk}/",
            "swimlane": f"/api/v1/boards/{self.board.pk}/swimlanes/{self.lane_g.pk}/",
            "board": f"/api/v1/boards/{self.board.pk}/",
        }[kind]
        # The board delete is owner-only; the owner is an admin of the board.
        client = APIClient()
        client.force_authenticate(self.owner)
        return lambda: client.delete(url)

    def _entry_then_delete(self, kind, how, delete, *, entry_status):
        """The entry holds its column row with the card uncommitted; the delete
        must queue on that column, then lock the newcomer on its retry and
        cascade it away instead of failing its deferred FK check at COMMIT."""
        paused, release, results = threading.Event(), threading.Event(), {}
        # Called after every write create_card / move_card makes, before COMMIT.
        with self._pause_in(
            f"{SERVICES}._broadcast_after_commit", "entry", paused, release
        ):
            entry = self._thread(
                "entry", lambda: self._entry(kind, how)(self._client()), results
            )
            self.assertTrue(paused.wait(HOLD_TIMEOUT), "entry never reached its hold")
            deleter = self._thread("deleter", delete, results)
            assert_blocked_on_lock(self, deleter, "container delete did not wait for the entry")
            release.set()
            entry.join(HOLD_TIMEOUT)
            deleter.join(HOLD_TIMEOUT)
        self.assertEqual(self._status(results, "entry"), entry_status)
        return results

    def _delete_then_entry(self, kind, how, delete, pause_target):
        """The delete holds its card and column locks; the entry queues on
        the column row, finds its target gone, and answers 404."""
        paused, release, results = threading.Event(), threading.Event(), {}
        with self._pause_in(pause_target, "deleter", paused, release, after=True):
            deleter = self._thread("deleter", delete, results)
            self.assertTrue(paused.wait(HOLD_TIMEOUT), "delete never reached its hold")
            entry = self._thread(
                "entry", lambda: self._entry(kind, how)(self._client()), results
            )
            assert_blocked_on_lock(self, entry, "entry did not wait for the delete")
            release.set()
            deleter.join(HOLD_TIMEOUT)
            entry.join(HOLD_TIMEOUT)
        self.assertEqual(self._status(results, "entry"), 404)
        self._assert_entry_wrote_nothing(how)
        return results


@skipUnless(
    connection.vendor == "postgresql", "row locks are only observable on PostgreSQL"
)
class RestContainerDeleteVsCardEntryTests(_EntryRaceBase, TransactionTestCase):
    def _check_entry_then_delete(self, kind, how):
        status = 201 if how == "create" else 200
        results = self._entry_then_delete(
            kind, how, self._rest_delete(kind), entry_status=status
        )
        self.assertEqual(self._status(results, "deleter"), 204)
        self._assert_container_and_cards_gone(kind, how)

    def _check_delete_then_entry(self, kind, how):
        results = self._delete_then_entry(
            kind, how, self._rest_delete(kind), f"{SERVICES}.lock_cards_for_cascade"
        )
        self.assertEqual(self._status(results, "deleter"), 204)

    def test_column_lock_shape_cards_then_columns(self):
        """Board row FOR NO KEY UPDATE, then cards in one pk-ordered FOR
        UPDATE, then the entry columns in one pk-ordered FOR NO KEY UPDATE,
        then a plain re-read: board -> card -> column, the documented order.
        The two unlocked link-peer reads (#2409) bracket the card lock: one
        decides which peers join the card statement, one re-checks them."""
        with transaction.atomic(), CaptureQueriesContext(connection) as ctx:
            card_services.lock_cards_for_cascade(
                Card.objects.filter(board=self.board),
                entry_columns=Column.objects.filter(board=self.board),
                boards=Board.objects.filter(pk=self.board.pk),
            )
        sqls = [
            q["sql"] for q in ctx.captured_queries
            if not q["sql"].upper().startswith(("SAVEPOINT", "RELEASE"))
        ]
        self.assertEqual(len(sqls), 6, sqls)
        boards_sql, peers_sql, cards_sql, columns_sql, reread_sql, peers_reread_sql = sqls
        for peer_read in (peers_sql, peers_reread_sql):
            self.assertIn('FROM "card_parent_links"', peer_read)
            self.assertNotIn(" FOR ", peer_read)
        # Board row first, FOR NO KEY UPDATE: conflicts with column create and
        # reorder, but not with the FOR KEY SHARE a card insert needs (#1602).
        self.assertIn('FROM "boards"', boards_sql)
        self.assertRegex(boards_sql, r'FOR NO KEY UPDATE OF "boards"$')
        self.assertIn('FROM "cards"', cards_sql)
        self.assertIn("ORDER BY", cards_sql)
        self.assertRegex(cards_sql, r'FOR UPDATE OF "cards"$')
        self.assertIn('FROM "columns"', columns_sql)
        self.assertIn("ORDER BY", columns_sql)
        self.assertRegex(columns_sql, r'FOR NO KEY UPDATE OF "columns"$')
        self.assertIn('FROM "cards"', reread_sql)
        self.assertNotIn(" FOR ", reread_sql)


def _make_rest(order, kind, how):
    def test(self):
        getattr(self, f"_check_{order}")(kind, how)

    test.__name__ = f"test_{how}_{order}_{kind}"
    return test


for _order in ("entry_then_delete", "delete_then_entry"):
    for _kind, _how in (
        ("column", "create"), ("column", "move"),
        ("swimlane", "create"), ("swimlane", "move"),
        ("board", "create"), ("board", "move"),
    ):
        _t = _make_rest(_order, _kind, _how)
        setattr(RestContainerDeleteVsCardEntryTests, _t.__name__, _t)


@skipUnless(
    connection.vendor == "postgresql", "row locks are only observable on PostgreSQL"
)
class AdminContainerDeleteVsCardEntryTests(_EntryRaceBase, TransactionTestCase):
    """The Django admin twin (#1603's paths share the helper and its limit)."""

    def setUp(self):
        super().setUp()
        self.staff = User.objects.create_superuser(
            username="staff1602", password="pass", email="s1602@example.com"
        )

    def _admin_delete(self, kind, mode):
        obj = {
            "column": self.col_a, "swimlane": self.lane_g,
            "board": self.board, "user": self.owner,
        }[kind]
        model = type(obj)
        model_admin = django_admin.site._registry[model]

        def run():
            request = RequestFactory().post("/")
            request.user = self.staff
            if mode == "model":
                model_admin.delete_model(request, model.objects.get(pk=obj.pk))
            else:
                model_admin.delete_queryset(request, model.objects.filter(pk=obj.pk))
            return True

        return run

    def _check_entry_then_delete(self, kind, mode, how="create"):
        self._entry_then_delete(
            kind, how, self._admin_delete(kind, mode),
            entry_status=201 if how == "create" else 200,
        )
        self._status({"deleter": True}, "deleter")
        self._assert_container_and_cards_gone(kind, how)

    def _check_delete_then_entry(self, kind, mode, how="create"):
        target = "accounts.admin.lock_cards_for_cascade" if kind == "user" else (
            "boards.admin.lock_cards_for_cascade"
        )
        results = self._delete_then_entry(
            kind, how, self._admin_delete(kind, mode), target
        )
        self.assertIs(results.get("deleter"), True, results.get("deleter"))

    def _entry_then_delete(self, kind, how, delete, *, entry_status):
        results = super()._entry_then_delete(kind, how, delete, entry_status=entry_status)
        self.assertIs(results.get("deleter"), True, results.get("deleter"))
        return results


def _make_admin(order, kind, mode, how="create"):
    def test(self):
        getattr(self, f"_check_{order}")(kind, mode, how)

    test.__name__ = f"test_{how}_{order}_{kind}_admin_{mode}"
    return test


# A REST move into the container races the admin delete too (#1602). For the
# board kind the mover is already in the deleted board, so it is locked by the
# cascade itself and the move queues on its card row. The user admin is not in
# the matrix: since #1616 it refuses to delete a board owner, so a user delete
# never cascades to a board (see UserAdminLocksContainersTests).
for _order in ("entry_then_delete", "delete_then_entry"):
    for _kind in ("column", "swimlane", "board"):
        for _mode in ("model", "queryset"):
            _t = _make_admin(_order, _kind, _mode, "move")
            setattr(AdminContainerDeleteVsCardEntryTests, _t.__name__, _t)

for _order in ("entry_then_delete", "delete_then_entry"):
    for _kind in ("column", "swimlane", "board"):
        for _mode in ("model", "queryset"):
            _t = _make_admin(_order, _kind, _mode)
            setattr(AdminContainerDeleteVsCardEntryTests, _t.__name__, _t)


class ContainerChangedTests(TestCase):
    """A container that gains a card on every attempt ends in a clean 409,
    never a 500 or an unbounded loop. Runs on SQLite too: the newcomer is
    simulated by making the post-lock re-read report an unlocked pk."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner1602c", password="pass")
        self.board = Board.objects.create(name="B", owner=self.owner)
        BoardMembership.objects.create(
            board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN
        )
        self.column = Column.objects.create(board=self.board, name="A", position=0)
        self.swimlane = Swimlane.objects.create(board=self.board, name="G", position=0)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        patcher = patch("boards.broadcast.broadcast_board_event")
        self.broadcast = patcher.start()
        self.addCleanup(patcher.stop)
        group_patcher = patch("boards.views.boards._broadcast_group_event")
        self.group_broadcast = group_patcher.start()
        self.addCleanup(group_patcher.stop)

    def _always_gains_a_card(self):
        real = card_services._cascade_card_pks
        calls = []

        def fake(cards):
            calls.append(1)
            return real(cards) | {-len(calls)}

        return patch(f"{SERVICES}._cascade_card_pks", side_effect=fake), calls

    def test_helper_raises_after_bounded_attempts(self):
        patcher, calls = self._always_gains_a_card()
        with patcher, self.assertRaises(ContainerChanged), transaction.atomic():
            card_services.lock_cards_for_cascade(
                Card.objects.filter(column=self.column),
                entry_columns=Column.objects.filter(pk=self.column.pk),
            )
        self.assertEqual(len(calls), card_services._CASCADE_LOCK_ATTEMPTS)

    def test_helper_requires_an_outer_transaction(self):
        with self.assertRaises(RuntimeError):
            # TestCase wraps each test in atomic; leave it to reach autocommit.
            with patch.object(transaction.get_connection(), "in_atomic_block", False):
                card_services.lock_cards_for_cascade(
                    Card.objects.none(), entry_columns=Column.objects.none()
                )

    def _assert_409(self, url, model, pk):
        patcher, _ = self._always_gains_a_card()
        events_before = BoardEvent.objects.count()
        # execute=True runs whatever the request queued for commit, so a
        # broadcast queued for a delete that did not happen would hit the mocks.
        with patcher, self.captureOnCommitCallbacks(execute=True):
            response = self.client.delete(url)
        self.assertEqual(response.status_code, 409, response.content)
        self.assertEqual(
            response.json(),
            {"code": "container_changed", "detail": ContainerChanged.detail},
        )
        self.assertTrue(model.objects.filter(pk=pk).exists())
        # Nothing was recorded or queued for broadcast for a delete that
        # did not happen.
        self.assertEqual(BoardEvent.objects.count(), events_before)
        self.broadcast.assert_not_called()
        self.group_broadcast.assert_not_called()

    def test_column_delete_answers_409(self):
        self._assert_409(
            f"/api/v1/boards/{self.board.pk}/columns/{self.column.pk}/",
            Column, self.column.pk,
        )

    def test_swimlane_delete_answers_409(self):
        self._assert_409(
            f"/api/v1/boards/{self.board.pk}/swimlanes/{self.swimlane.pk}/",
            Swimlane, self.swimlane.pk,
        )

    def test_board_delete_answers_409(self):
        self._assert_409(f"/api/v1/boards/{self.board.pk}/", Board, self.board.pk)

    # -- Django admin -------------------------------------------------------

    def _admin_target(self, kind):
        obj = {
            "column": self.column, "swimlane": self.swimlane,
            "board": self.board, "user": self.owner,
        }[kind]
        return type(obj), obj.pk, obj._meta.app_label, obj._meta.model_name

    def _admin_client(self):
        staff = User.objects.create_superuser(
            username="staff1602c", password="pass", email="s1602c@example.com"
        )
        client = Client()
        client.force_login(staff)
        return client

    def _assert_admin_refused(self, response, model, pk, expected_url):
        """Error message, redirect, nothing deleted, no deletion log entry,
        and no misleading "deleted successfully" message."""
        self.assertEqual(response.status_code, 302, response.content[:500])
        self.assertEqual(response["Location"], expected_url)
        texts = [str(m) for m in get_messages(response.wsgi_request)]
        self.assertIn(ContainerChanged.detail, texts)
        self.assertFalse(any("success" in t.lower() for t in texts), texts)
        self.assertTrue(model.objects.filter(pk=pk).exists())
        self.assertFalse(LogEntry.objects.filter(action_flag=DELETION).exists())

    def _check_admin_single(self, kind):
        model, pk, app, name = self._admin_target(kind)
        client = self._admin_client()
        patcher, _ = self._always_gains_a_card()
        with patcher:
            response = client.post(
                reverse(f"admin:{app}_{name}_delete", args=[pk]), {"post": "yes"}
            )
        self._assert_admin_refused(
            response, model, pk, reverse(f"admin:{app}_{name}_change", args=[pk])
        )

    def _check_admin_bulk(self, kind):
        model, pk, app, name = self._admin_target(kind)
        client = self._admin_client()
        url = reverse(f"admin:{app}_{name}_changelist")
        patcher, _ = self._always_gains_a_card()
        with patcher:
            response = client.post(
                url,
                {"action": "delete_selected", "_selected_action": [pk], "post": "yes"},
            )
        self._assert_admin_refused(response, model, pk, url)


def _make_admin_refusal(mode, kind):
    def test(self):
        getattr(self, f"_check_admin_{mode}")(kind)

    test.__name__ = f"test_admin_{mode}_delete_of_{kind}_shows_error_not_500"
    return test


for _mode in ("single", "bulk"):
    for _kind in ("column", "swimlane", "board"):
        _t = _make_admin_refusal(_mode, _kind)
        setattr(ContainerChangedTests, _t.__name__, _t)


@skipUnless(
    connection.vendor == "postgresql", "row locks are only observable on PostgreSQL"
)
class ContainerDeleteVsBoardStructureTests(_EntryRaceBase, TransactionTestCase):
    """A container delete against column/swimlane create and reorder (#1602,
    covering #1604's board-delete-vs-reorder cases).

    Taking the entry columns made a board delete hold every column of the
    board until its final board-row DELETE, while column reorder takes the
    board row and then the columns: a deadlock (500). Every container delete
    now takes its board row FOR NO KEY UPDATE first, the order reorder and
    create use, so each pair below queues in either order. Two orders each:

    * ``delete_first`` — the delete holds all its locks; the structure write
      must wait for it, then answer cleanly (404 when the board is gone, 400
      for a reorder whose column set went stale, otherwise success).
    * ``write_first`` — the structure write holds its board (and column)
      locks; the delete must wait for it, then answer 204.
    """

    def _write(self, what):
        base = f"/api/v1/boards/{self.board.pk}"
        client = APIClient()
        client.force_authenticate(self.owner)
        return {
            "column_reorder": lambda: client.post(
                f"{base}/columns/reorder/",
                {"order": [self.col_b.pk, self.col_a.pk]}, format="json",
            ),
            "swimlane_reorder": lambda: client.post(
                f"{base}/swimlanes/reorder/",
                {"order": [self.lane_h.pk, self.lane_g.pk]}, format="json",
            ),
            "column_create": lambda: client.post(
                f"{base}/columns/", {"name": "N1602"}, format="json",
            ),
        }[what]

    def _delete_first(self, kind, what, expected):
        paused, release, results = threading.Event(), threading.Event(), {}
        with self._pause_in(
            f"{SERVICES}.lock_cards_for_cascade", "deleter", paused, release, after=True
        ):
            deleter = self._thread("deleter", self._rest_delete(kind), results)
            self.assertTrue(paused.wait(HOLD_TIMEOUT), "delete never reached its hold")
            writer = self._thread("writer", self._write(what), results)
            assert_blocked_on_lock(self, writer, f"{what} did not wait for the delete")
            release.set()
            deleter.join(HOLD_TIMEOUT)
            writer.join(HOLD_TIMEOUT)
        self.assertEqual(self._status(results, "deleter"), 204)
        self.assertEqual(self._status(results, "writer"), expected)

    def _write_first(self, kind, what, expected):
        paused, release, results = threading.Event(), threading.Event(), {}
        # Called inside each write's transaction after all of its locks.
        with self._pause_in(
            "boards.broadcast.record_board_event", "writer", paused, release
        ):
            writer = self._thread("writer", self._write(what), results)
            self.assertTrue(paused.wait(HOLD_TIMEOUT), f"{what} never reached its hold")
            deleter = self._thread("deleter", self._rest_delete(kind), results)
            assert_blocked_on_lock(self, deleter, f"delete did not wait for {what}")
            release.set()
            writer.join(HOLD_TIMEOUT)
            deleter.join(HOLD_TIMEOUT)
        self.assertEqual(self._status(results, "writer"), expected)
        self.assertEqual(self._status(results, "deleter"), 204)

    # board delete vs column reorder (#1604)
    def test_board_delete_first_then_column_reorder(self):
        self._delete_first("board", "column_reorder", 404)

    def test_column_reorder_first_then_board_delete(self):
        self._write_first("board", "column_reorder", 200)

    # board delete vs swimlane reorder (#1604)
    def test_board_delete_first_then_swimlane_reorder(self):
        self._delete_first("board", "swimlane_reorder", 404)

    def test_swimlane_reorder_first_then_board_delete(self):
        self._write_first("board", "swimlane_reorder", 200)

    # board delete vs column create
    def test_board_delete_first_then_column_create(self):
        self._delete_first("board", "column_create", 404)

    def test_column_create_first_then_board_delete(self):
        self._write_first("board", "column_create", 201)

    # swimlane delete vs column reorder and column create
    def test_swimlane_delete_first_then_column_reorder(self):
        self._delete_first("swimlane", "column_reorder", 200)

    def test_column_reorder_first_then_swimlane_delete(self):
        self._write_first("swimlane", "column_reorder", 200)

    def test_swimlane_delete_first_then_column_create(self):
        """The residual #1602 closes: no column can be created in the board
        while a swimlane delete runs, so its entry-column snapshot is whole."""
        self._delete_first("swimlane", "column_create", 201)

    def test_column_create_first_then_swimlane_delete(self):
        self._write_first("swimlane", "column_create", 201)

    # column delete vs column reorder
    def test_column_delete_first_then_column_reorder(self):
        # The reorder's full-set check sees the deleted column missing.
        self._delete_first("column", "column_reorder", 400)

    def test_column_reorder_first_then_column_delete(self):
        self._write_first("column", "column_reorder", 200)

    def _admin_delete_first(self, kind, mode, what, expected):
        """Same as ``_delete_first`` with the Django admin as the deleter:
        the board, swimlane and user admins take the board row first too."""
        staff = User.objects.create_superuser(
            username="staff1602r", password="pass", email="s1602r@example.com"
        )
        obj = {"swimlane": self.lane_g, "board": self.board, "user": self.owner}[kind]
        model_admin = django_admin.site._registry[type(obj)]

        def delete():
            request = RequestFactory().post("/")
            request.user = staff
            if mode == "model":
                model_admin.delete_model(request, type(obj).objects.get(pk=obj.pk))
            else:
                model_admin.delete_queryset(request, type(obj).objects.filter(pk=obj.pk))
            return True

        target = "accounts.admin.lock_cards_for_cascade" if kind == "user" else (
            "boards.admin.lock_cards_for_cascade"
        )
        paused, release, results = threading.Event(), threading.Event(), {}
        with self._pause_in(target, "deleter", paused, release, after=True):
            deleter = self._thread("deleter", delete, results)
            self.assertTrue(paused.wait(HOLD_TIMEOUT), "delete never reached its hold")
            writer = self._thread("writer", self._write(what), results)
            assert_blocked_on_lock(self, writer, f"{what} did not wait for the delete")
            release.set()
            deleter.join(HOLD_TIMEOUT)
            writer.join(HOLD_TIMEOUT)
        self.assertIs(results.get("deleter"), True, results.get("deleter"))
        self.assertEqual(self._status(results, "writer"), expected)

    def test_admin_column_create_waits_for_swimlane_delete(self):
        """ColumnAdmin takes the board row too, so an admin-added column
        cannot slip into a board whose swimlane is being deleted either."""
        staff = User.objects.create_superuser(
            username="staff1602s", password="pass", email="s1602s@example.com"
        )

        def admin_add():
            request = RequestFactory().post("/")
            request.user = staff
            with transaction.atomic():
                django_admin.site._registry[Column].save_model(
                    request, Column(board_id=self.board.pk, name="N1602", position=9),
                    None, False,
                )
            return True

        paused, release, results = threading.Event(), threading.Event(), {}
        with self._pause_in(
            f"{SERVICES}.lock_cards_for_cascade", "deleter", paused, release, after=True
        ):
            deleter = self._thread("deleter", self._rest_delete("swimlane"), results)
            self.assertTrue(paused.wait(HOLD_TIMEOUT), "delete never reached its hold")
            writer = self._thread("writer", admin_add, results)
            assert_blocked_on_lock(self, writer, "admin column add did not wait")
            release.set()
            deleter.join(HOLD_TIMEOUT)
            writer.join(HOLD_TIMEOUT)
        self.assertEqual(self._status(results, "deleter"), 204)
        self.assertIs(results.get("writer"), True, results.get("writer"))


@skipUnless(
    connection.vendor == "postgresql", "row locks are only observable on PostgreSQL"
)
class ServiceEntryVsContainerDeleteTests(_EntryRaceBase, TransactionTestCase):
    """``create_card``/``move_card`` called directly, with a render that does
    not re-read the card, so the target re-checks they make under the column
    lock are the only thing between a deleted container and a COMMIT-time
    IntegrityError (the REST tests also get a 404 from the render refetch,
    #1585). Make ``require_swimlane_exists`` a no-op and the swimlane tests
    fail with ``IntegrityError``."""

    def _service_entry(self, kind, how):
        column, swimlane = self._target_cell(kind)

        def run():
            board = Board.objects.get(pk=self.board.pk)
            if how == "create":
                card_services.create_card(
                    actor=self.user, board=board, role=BoardMembership.Role.ADMIN,
                    column_id=column.pk, swimlane_id=swimlane.pk,
                    save=lambda position: Card.objects.create(
                        board=board, column_id=column.pk, swimlane_id=swimlane.pk,
                        title=NEWCOMER, created_by=self.user, position=position,
                    ),
                    render=lambda card: {"id": card.pk},
                )
            else:
                card_services.move_card(
                    actor=self.user, board=board, role=BoardMembership.Role.ADMIN,
                    card_id=self.mover.pk, target_column_id=column.pk,
                    target_swimlane_id=swimlane.pk, position=0,
                    render=lambda card, movement: {"id": card.pk},
                )
            return "ok"

        return run

    def _check(self, kind, how, expected_exc):
        paused, release, results = threading.Event(), threading.Event(), {}
        with self._pause_in(
            f"{SERVICES}.lock_cards_for_cascade", "deleter", paused, release, after=True
        ):
            deleter = self._thread("deleter", self._rest_delete(kind), results)
            self.assertTrue(paused.wait(HOLD_TIMEOUT), "delete never reached its hold")
            entry = self._thread("entry", self._service_entry(kind, how), results)
            assert_blocked_on_lock(self, entry, "entry did not wait for the delete")
            release.set()
            deleter.join(HOLD_TIMEOUT)
            entry.join(HOLD_TIMEOUT)
        self.assertEqual(self._status(results, "deleter"), 204)
        self.assertIsInstance(results.get("entry"), expected_exc, results.get("entry"))
        self._assert_entry_wrote_nothing(how)

    def test_create_into_deleted_swimlane_raises_swimlane_not_found(self):
        self._check("swimlane", "create", SwimlaneNotFound)

    def test_move_into_deleted_swimlane_raises_swimlane_not_found(self):
        self._check("swimlane", "move", SwimlaneNotFound)

    def test_create_into_deleted_column_raises_column_not_found(self):
        self._check("column", "create", ColumnNotFound)

    def test_move_into_deleted_column_raises_column_not_found(self):
        self._check("column", "move", ColumnNotFound)

    def test_create_into_deleted_board_raises_column_not_found(self):
        self._check("board", "create", ColumnNotFound)


@skipUnless(
    connection.vendor == "postgresql", "row locks are only observable on PostgreSQL"
)
# The refused form is re-rendered; plain static storage so the admin template
# does not need a collected manifest.
@override_settings(
    STORAGES={
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
        "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
    }
)
class AdminCardFormVsContainerDeleteTests(_EntryRaceBase, TransactionTestCase):
    """The Django admin card form is an entry path too (#1602): a card add or
    move that waited on the column lock a container delete holds must be
    refused as a form error, not saved into a deleted column or swimlane
    (which failed its deferred FK check at COMMIT with a 500)."""

    def setUp(self):
        super().setUp()
        self.staff = User.objects.create_superuser(
            username="staff1602f", password="pass", email="s1602f@example.com"
        )

    def _admin_entry(self, kind, how):
        column, swimlane = self._target_cell(kind)
        if how == "move":
            data = _admin_post_data(self.mover, column=column, swimlane=swimlane)
            url = reverse("admin:boards_card_change", args=[self.mover.pk])
        else:
            draft = Card(
                board=self.board, column=column, swimlane=swimlane, title=NEWCOMER,
                created_by=self.user, position=0,
            )
            data = _admin_post_data(draft)
            url = reverse("admin:boards_card_add")

        def run():
            client = Client()
            client.force_login(self.staff)
            return client.post(url, data)

        return run

    def _check(self, kind, how, message):
        paused, release, results = threading.Event(), threading.Event(), {}
        with self._pause_in(
            f"{SERVICES}.lock_cards_for_cascade", "deleter", paused, release, after=True
        ):
            deleter = self._thread("deleter", self._rest_delete(kind), results)
            self.assertTrue(paused.wait(HOLD_TIMEOUT), "delete never reached its hold")
            entry = self._thread("entry", self._admin_entry(kind, how), results)
            assert_blocked_on_lock(self, entry, "admin card form did not wait")
            release.set()
            deleter.join(HOLD_TIMEOUT)
            entry.join(HOLD_TIMEOUT)
        self.assertEqual(self._status(results, "deleter"), 204)
        # 200 is the form re-rendered with its error; a save would redirect.
        self.assertEqual(self._status(results, "entry"), 200)
        self.assertContains(results["entry"], message)
        if how == "create":
            self.assertFalse(Card.objects.filter(title=NEWCOMER).exists())
        else:
            self.mover.refresh_from_db()
            self.assertEqual(
                (self.mover.column_id, self.mover.swimlane_id),
                (self.col_b.pk, self.lane_h.pk),
            )

    def test_admin_add_into_deleted_column(self):
        self._check("column", "create", "This column was deleted")

    def test_admin_move_into_deleted_column(self):
        self._check("column", "move", "This column was deleted")

    def test_admin_add_into_deleted_swimlane(self):
        self._check("swimlane", "create", "This swimlane was deleted")

    def test_admin_move_into_deleted_swimlane(self):
        self._check("swimlane", "move", "This swimlane was deleted")


def _make_admin_structure(kind, mode, what, expected):
    def test(self):
        self._admin_delete_first(kind, mode, what, expected)

    test.__name__ = f"test_admin_{kind}_{mode}_delete_first_then_{what}"
    return test


for _kind, _what, _expected in (
    ("board", "column_reorder", 404),
    ("board", "swimlane_reorder", 404),
    ("swimlane", "column_reorder", 200),
):
    for _mode in ("model", "queryset"):
        _t = _make_admin_structure(_kind, _mode, _what, _expected)
        setattr(ContainerDeleteVsBoardStructureTests, _t.__name__, _t)


@skipUnless(
    connection.vendor == "postgresql", "row locks are only observable on PostgreSQL"
)
@override_settings(
    INVITE_EMAIL_ENABLED=True,
    DEMO_MODE=False,
    FRONTEND_URL="https://kanban.acme.test",
    DEFAULT_FROM_EMAIL="invites@acme.test",
)
class BoardRowLockSitesVsBoardDeleteTests(_EntryRaceBase, TransactionTestCase):
    """Every view that serializes on the board row queues behind a board
    delete, which now holds that row from the start of its cascade (#1602).
    Once granted, the row is gone: each must answer 404, not raise
    ``Board.DoesNotExist`` (a bare ``.get()``) or insert a row whose deferred
    board FK fails at COMMIT (a bare ``.first()``) — both 500s. All of them
    go through ``lock_board_row_or_404``; make it skip its ``None`` check and
    every test here fails with a 500."""

    def setUp(self):
        super().setUp()
        from boards.models import CustomFieldDefinition, SwimlaneCustomFieldDefinition

        self.card_field = CustomFieldDefinition.objects.create(
            board=self.board, name="Effort", field_type="text", position=0,
        )
        self.lane_field = SwimlaneCustomFieldDefinition.objects.create(
            board=self.board, name="Tier", field_type="text", position=0,
        )

    def _site(self, site):
        base = f"/api/v1/boards/{self.board.pk}"
        client = APIClient()
        client.force_authenticate(self.owner)
        return {
            "custom_field_create": lambda: client.post(
                f"{base}/custom-fields/", {"name": "F1602", "field_type": "text"},
                format="json",
            ),
            "custom_field_update": lambda: client.patch(
                f"{base}/custom-fields/{self.card_field.pk}/", {"name": "Renamed"},
                format="json",
            ),
            "swimlane_custom_field_create": lambda: client.post(
                f"{base}/swimlane-custom-fields/", {"name": "S1602", "field_type": "text"},
                format="json",
            ),
            "swimlane_custom_field_update": lambda: client.patch(
                f"{base}/swimlane-custom-fields/{self.lane_field.pk}/", {"name": "Renamed"},
                format="json",
            ),
            "invite_link_create": lambda: client.post(
                f"{base}/invite-links/", {"expiry_days": 7}, format="json",
            ),
            "invite_email_send": lambda: client.post(
                f"{base}/invite-links/send/", {"email": "guest1602@acme.test"},
                format="json",
            ),
            "swimlane_create": lambda: client.post(
                f"{base}/swimlanes/", {"name": "L1602"}, format="json",
            ),
        }[site]

    def _check(self, site):
        paused, release, results = threading.Event(), threading.Event(), {}
        with self._pause_in(
            f"{SERVICES}.lock_cards_for_cascade", "deleter", paused, release, after=True
        ):
            deleter = self._thread("deleter", self._rest_delete("board"), results)
            self.assertTrue(paused.wait(HOLD_TIMEOUT), "delete never reached its hold")
            writer = self._thread("writer", self._site(site), results)
            assert_blocked_on_lock(self, writer, f"{site} did not wait for the delete")
            release.set()
            deleter.join(HOLD_TIMEOUT)
            writer.join(HOLD_TIMEOUT)
        self.assertEqual(self._status(results, "deleter"), 204)
        self.assertEqual(self._status(results, "writer"), 404)

    def test_admin_column_add_waits_then_404(self):
        """ColumnAdmin cannot answer a DRF 404; it raises Django's Http404."""
        from django.http import Http404

        staff = User.objects.create_superuser(
            username="staff1602b", password="pass", email="s1602b@example.com"
        )

        def admin_add():
            request = RequestFactory().post("/")
            request.user = staff
            with transaction.atomic():
                django_admin.site._registry[Column].save_model(
                    request, Column(board_id=self.board.pk, name="N1602", position=9),
                    None, False,
                )
            return True

        paused, release, results = threading.Event(), threading.Event(), {}
        with self._pause_in(
            f"{SERVICES}.lock_cards_for_cascade", "deleter", paused, release, after=True
        ):
            deleter = self._thread("deleter", self._rest_delete("board"), results)
            self.assertTrue(paused.wait(HOLD_TIMEOUT), "delete never reached its hold")
            writer = self._thread("writer", admin_add, results)
            assert_blocked_on_lock(self, writer, "admin column add did not wait")
            release.set()
            deleter.join(HOLD_TIMEOUT)
            writer.join(HOLD_TIMEOUT)
        self.assertEqual(self._status(results, "deleter"), 204)
        self.assertIsInstance(results.get("writer"), Http404, results.get("writer"))


def _make_board_lock_site(site):
    def test(self):
        self._check(site)

    test.__name__ = f"test_{site}_waiting_on_board_delete_answers_404"
    return test


for _site in (
    "custom_field_create", "custom_field_update",
    "swimlane_custom_field_create", "swimlane_custom_field_update",
    "invite_link_create", "invite_email_send", "swimlane_create",
):
    _t = _make_board_lock_site(_site)
    setattr(BoardRowLockSitesVsBoardDeleteTests, _t.__name__, _t)


_DELETION_EVENTS = {"board.deleted", "column.deleted", "swimlane.deleted"}


@skipUnless(
    connection.vendor == "postgresql", "row locks are only observable on PostgreSQL"
)
class RowWritersVsContainerDeleteTests(_EntryRaceBase, TransactionTestCase):
    """UPDATE writers of a board, column or swimlane row against a container
    delete (#1602).

    A container delete holds the board row FOR NO KEY UPDATE from its start.
    A writer that UPDATEs the board row (or a column the delete holds) used
    to queue behind the whole cascade and then re-insert the deleted row
    (``save()`` falls back to INSERT when its UPDATE matches nothing: a
    zombie board), raise on ``save(update_fields=...)`` (500), or report the
    INSERT's IntegrityError as a 400. Each writer now takes the board row,
    then its own row, first: it must wait, answer 404, write nothing, and
    leave no zombie row, event or broadcast behind. Make
    ``lock_board_row_or_404`` skip its check and these fail.
    """

    def _rest_writer(self, site):
        base = f"/api/v1/boards/{self.board.pk}"
        client = APIClient()
        client.force_authenticate(self.owner)
        return {
            "board_patch": lambda: client.patch(f"{base}/", {"name": "Zombie"}, format="json"),
            "board_put": lambda: client.put(f"{base}/", {"name": "Zombie"}, format="json"),
            "share_post": lambda: client.post(f"{base}/share/", {}, format="json"),
            "share_delete": lambda: client.delete(f"{base}/share/"),
            "move_group": lambda: client.post(
                f"{base}/move-group/", {"group_id": None}, format="json",
            ),
            "column_patch": lambda: client.patch(
                f"{base}/columns/{self.col_a.pk}/", {"name": "Zombie"}, format="json",
            ),
            "swimlane_patch": lambda: client.patch(
                f"{base}/swimlanes/{self.lane_g.pk}/", {"name": "Zombie"}, format="json",
            ),
            "member_update": lambda: client.post(
                f"{base}/members/", {"user_id": self.user.pk, "role": "viewer"},
                format="json",
            ),
            "member_remove": lambda: client.delete(f"{base}/members/{self.user.pk}/"),
            "label_patch": lambda: client.patch(
                f"{base}/labels/{Label.objects.create(board=self.board, name='L1602').pk}/",
                {"name": "Zombie"}, format="json",
            ),
            "swimlane_set_collapsed": lambda: client.patch(
                f"{base}/swimlanes/{self.lane_g.pk}/set-collapsed/",
                {"is_collapsed": True}, format="json",
            ),
        }[site]

    def _admin_writer(self, site):
        """An admin change form's save_model, run as changeform_view does
        (inside one transaction), on an object read before the delete."""
        from django.http import Http404

        staff = User.objects.create_superuser(
            username="staff1602w", password="pass", email="s1602w@example.com"
        )
        obj = {
            "board_admin": Board.objects.get(pk=self.board.pk),
            "column_admin": Column.objects.get(pk=self.col_a.pk),
            "swimlane_admin": Swimlane.objects.get(pk=self.lane_g.pk),
        }[site]
        obj.name = "Zombie"

        def run():
            request = RequestFactory().post("/")
            request.user = staff
            try:
                with transaction.atomic():
                    django_admin.site._registry[type(obj)].save_model(
                        request, obj, None, True,
                    )
            except Http404 as exc:
                return exc
            return "saved"

        return run

    def _race(self, kind, writer):
        paused, release, results = threading.Event(), threading.Event(), {}
        with self._pause_in(
            f"{SERVICES}.lock_cards_for_cascade", "deleter", paused, release, after=True
        ):
            deleter = self._thread("deleter", self._rest_delete(kind), results)
            self.assertTrue(paused.wait(HOLD_TIMEOUT), "delete never reached its hold")
            w = self._thread("writer", writer, results)
            assert_blocked_on_lock(self, w, "writer did not wait for the delete")
            release.set()
            deleter.join(HOLD_TIMEOUT)
            w.join(HOLD_TIMEOUT)
        self.assertEqual(self._status(results, "deleter"), 204)
        return results.get("writer")

    def _assert_nothing_written(self, kind):
        gone = {
            "board": (Board, self.board.pk),
            "column": (Column, self.col_a.pk),
            "swimlane": (Swimlane, self.lane_g.pk),
        }[kind]
        self.assertFalse(gone[0].objects.filter(pk=gone[1]).exists(), "zombie row")
        self.assertFalse(Board.objects.filter(name="Zombie").exists())
        self.assertFalse(Column.objects.filter(name="Zombie").exists())
        self.assertFalse(Swimlane.objects.filter(name="Zombie").exists())
        events = set(
            BoardEvent.objects.filter(board_id=self.board.pk).values_list("event", flat=True)
        )
        self.assertLessEqual(events, _DELETION_EVENTS, events)
        import boards.broadcast as _b

        sent = {c.args[1] for c in _b.broadcast_board_event.call_args_list}
        self.assertLessEqual(sent, _DELETION_EVENTS, sent)

    def _check_rest(self, kind, site):
        response = self._race(kind, self._rest_writer(site))
        self.assertNotIsInstance(response, Exception, response)
        self.assertEqual(response.status_code, 404, response.content[:300])
        self._assert_nothing_written(kind)

    def _check_admin(self, kind, site):
        from django.http import Http404

        outcome = self._race(kind, self._admin_writer(site))
        self.assertIsInstance(outcome, Http404, outcome)
        self._assert_nothing_written(kind)


def _make_writer(check, kind, site):
    def test(self):
        getattr(self, f"_check_{check}")(kind, site)

    test.__name__ = f"test_{site}_waiting_on_{kind}_delete_answers_404"
    return test


for _check, _kind, _site in (
    ("rest", "board", "board_patch"),
    ("rest", "board", "board_put"),
    ("rest", "board", "share_post"),
    ("rest", "board", "share_delete"),
    ("rest", "board", "move_group"),
    ("rest", "board", "column_patch"),
    ("rest", "column", "column_patch"),
    ("rest", "board", "member_update"),
    ("rest", "board", "member_remove"),
    ("rest", "board", "label_patch"),
    ("rest", "board", "swimlane_patch"),
    ("rest", "swimlane", "swimlane_patch"),
    ("rest", "swimlane", "swimlane_set_collapsed"),
    ("admin", "board", "board_admin"),
    ("admin", "board", "column_admin"),
    ("admin", "column", "column_admin"),
    ("admin", "swimlane", "swimlane_admin"),
):
    _t = _make_writer(_check, _kind, _site)
    setattr(RowWritersVsContainerDeleteTests, _t.__name__, _t)


@skipUnless(
    connection.vendor == "postgresql", "row locks are only observable on PostgreSQL"
)
class DeleteBoardsLockedTests(_EntryRaceBase, TransactionTestCase):
    """``delete_boards_locked`` (the seed commands' --wipe) takes the same
    locks as the board destroy view, so a card created into the board while
    it is wiped is cascaded away instead of failing the delete at COMMIT."""

    def _wipe(self):
        return card_services.delete_boards_locked(Board.objects.filter(pk=self.board.pk)) and True

    def test_create_then_wipe(self):
        results = self._entry_then_delete(
            "board", "create", self._wipe, entry_status=201,
        )
        self.assertIs(results.get("deleter"), True, results.get("deleter"))
        self._assert_container_and_cards_gone("board", "create")

    def test_wipe_then_create(self):
        results = self._delete_then_entry(
            "board", "create", self._wipe, f"{SERVICES}.lock_cards_for_cascade",
        )
        self.assertIs(results.get("deleter"), True, results.get("deleter"))


class SeedWipeUsesLockedDeleteTests(TestCase):
    """Both seed commands' --wipe go through delete_boards_locked (#1602).

    Through ``_seed_history.delete_seed_boards`` since #1889, which also
    records each board's board.deleted feed row (#1636). The demo-site boards
    are covered too: before #1889 their --wipe was a bare QuerySet.delete().
    """

    TARGET = "boards.management.commands._seed_history.delete_boards_locked"

    def test_seed_template_boards_wipe(self):
        from boards.tests.test_seed_template_boards import _seed

        _seed("sales_pipeline", force=True)
        with patch(self.TARGET, wraps=card_services.delete_boards_locked) as spy:
            _seed("sales_pipeline", wipe=True, force=True)
        spy.assert_called()

    def test_seed_demo_data_wipe(self):
        from boards.tests.test_seed_demo_data import _seed

        _seed(force=True)
        with patch(self.TARGET, wraps=card_services.delete_boards_locked) as spy:
            _seed(wipe=True, force=True)
        spy.assert_called()

    @pytest.mark.slow
    def test_seed_demo_data_demo_site_wipe(self):
        from django.test import override_settings

        from boards.tests.test_seed_demo_data import _DEMO_SITE_SETTINGS, _seed

        with override_settings(**_DEMO_SITE_SETTINGS):
            _seed(demo_site=True)
            deleted = set()

            def record(boards):
                deleted.update(boards.values_list("name", flat=True))
                return card_services.delete_boards_locked(boards)

            with patch(self.TARGET, side_effect=record):
                _seed(demo_site=True, wipe=True)
        self.assertIn("Sales Territory (Overlay)", deleted)
        self.assertIn("Software Team", deleted)


@skipUnless(
    connection.vendor == "postgresql", "row locks are only observable on PostgreSQL"
)
class DeleteSeedBoardsQueuedBehindDeleteTests(TransactionTestCase):
    """A seed --wipe queued behind another delete of the same board records no
    second board.deleted (#1889), as BoardViewSet.destroy does (#1602, #1712):
    which boards to announce is read under the board row lock, not before it."""

    def test_wipe_that_waited_on_a_delete_announces_nothing(self):
        from boards.management.commands._seed_history import delete_seed_boards

        owner = User.objects.create_user(username="owner1889", password="x")
        board = Board.objects.create(name="Wiped twice", owner=owner)
        held, release = threading.Event(), threading.Event()
        results = {}

        def first_delete():
            try:
                with transaction.atomic():
                    list(Board.objects.select_for_update().filter(pk=board.pk))
                    held.set()
                    release.wait(HOLD_TIMEOUT)
                    Board.objects.filter(pk=board.pk).delete()
            finally:
                connections.close_all()

        def wipe():
            try:
                results["wipe"] = delete_seed_boards(Board.objects.filter(name="Wiped twice"))
            except Exception as exc:  # surfaced by the assertion below
                results["wipe"] = exc
            finally:
                connections.close_all()

        holder = threading.Thread(target=first_delete)
        holder.start()
        self.assertTrue(held.wait(HOLD_TIMEOUT))
        waiter = threading.Thread(target=wipe)
        waiter.start()
        try:
            assert_blocked_on_lock(self, waiter, "the wipe did not wait on the board row lock")
        finally:
            release.set()
            holder.join(HOLD_TIMEOUT)
            waiter.join(HOLD_TIMEOUT)
        self.assertEqual(results.get("wipe"), (0, {}), results.get("wipe"))
        self.assertFalse(BoardEvent.objects.filter(board_id=board.pk, event="board.deleted").exists())


class UserAdminLocksContainersTests(TestCase):
    """The user admin's delete still takes the container locks (#1602, #1616).

    #1616 refuses to delete a board owner, so the cascade to boards is only
    reachable through the window the refusal's re-check closes. The delete
    therefore passes ``boards`` and ``entry_columns`` (the owned boards and
    their columns) to ``lock_cards_for_cascade`` so a board that commits
    between the first check and the target-row lock is locked in the same
    board -> card -> column order as every other container delete.
    """

    def test_user_delete_passes_owned_boards_and_entry_columns(self):
        staff = User.objects.create_superuser(
            username="staff1602u", password="pass", email="s1602u@example.com"
        )
        target = User.objects.create_user(
            username="target1602u", password="pass", email="t1602u@example.com"
        )
        model_admin = django_admin.site._registry[User]
        request = RequestFactory().post("/")
        request.user = staff
        with patch("accounts.admin.lock_cards_for_cascade") as lock:
            model_admin.delete_model(request, target)
        lock.assert_called_once()
        kwargs = lock.call_args.kwargs
        self.assertEqual(set(kwargs), {"entry_columns", "boards"})
        self.assertEqual(kwargs["boards"].model, Board)
        self.assertEqual(kwargs["entry_columns"].model, Column)
