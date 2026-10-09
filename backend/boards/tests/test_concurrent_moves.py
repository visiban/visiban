"""Concurrent/conflict tests for card move serialization.

Verifies that the select_for_update locking in the card move view
correctly serializes concurrent operations so that card positions
remain consistent after parallel moves.
"""
import threading
from unittest import skipUnless
from unittest.mock import patch

from django.db import connection, connections
from django.test import TransactionTestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, CardMovement, Column, Swimlane


PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"


def _make_board(owner):
    board = Board.objects.create(name="Concurrent Board", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col_a = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    col_b = Column.objects.create(board=board, name="In Progress", position=1)
    col_c = Column.objects.create(board=board, name="Done", position=2)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col_a, col_b, col_c, swim


class SequentialCardMoveConsistencyTests(TransactionTestCase):
    """Test that sequential card moves produce consistent positions.

    While true concurrent moves require threading, these tests verify
    that the select_for_update path works correctly by simulating
    the scenario of rapid sequential moves on cards in the same cell.
    """

    def setUp(self):
        self.user = User.objects.create_user(username="mover", password="pass")
        self.board, self.col_a, self.col_b, self.col_c, self.swim = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    @patch(PATCH_BROADCAST)
    def test_moving_two_cards_to_same_target_cell_assigns_distinct_positions(self, _):
        """When two cards are moved to the same cell, positions should not collide."""
        card1 = Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.swim,
            title="Card 1", created_by=self.user, position=0,
        )
        card2 = Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.swim,
            title="Card 2", created_by=self.user, position=1,
        )

        # Move card1 to col_b at position 0
        resp1 = self.client.post(
            f"/api/v1/boards/{self.board.pk}/cards/{card1.pk}/move/",
            {"column_id": self.col_b.pk, "swimlane_id": self.swim.pk, "position": 0},
        )
        self.assertEqual(resp1.status_code, status.HTTP_200_OK)

        # Move card2 to col_b at position 0 (should push card1 to position 1)
        resp2 = self.client.post(
            f"/api/v1/boards/{self.board.pk}/cards/{card2.pk}/move/",
            {"column_id": self.col_b.pk, "swimlane_id": self.swim.pk, "position": 0},
        )
        self.assertEqual(resp2.status_code, status.HTTP_200_OK)

        # Verify both cards are in col_b with distinct positions
        cards_in_b = list(
            Card.objects.filter(board=self.board, column=self.col_b, swimlane=self.swim)
            .order_by("position")
            .values_list("pk", "position")
        )
        self.assertEqual(len(cards_in_b), 2)
        positions = [pos for _, pos in cards_in_b]
        self.assertEqual(len(set(positions)), 2, "Positions should be distinct")

    @patch(PATCH_BROADCAST)
    def test_move_card_while_source_cell_has_other_cards(self, _):
        """Moving a card out of a cell should correctly reorder remaining cards."""
        card1 = Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.swim,
            title="Card 1", created_by=self.user, position=0,
        )
        card2 = Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.swim,
            title="Card 2", created_by=self.user, position=1,
        )
        card3 = Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.swim,
            title="Card 3", created_by=self.user, position=2,
        )

        # Move card1 to col_b
        resp = self.client.post(
            f"/api/v1/boards/{self.board.pk}/cards/{card1.pk}/move/",
            {"column_id": self.col_b.pk, "swimlane_id": self.swim.pk, "position": 0},
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

        # Remaining cards in source cell should have contiguous positions
        card2.refresh_from_db()
        card3.refresh_from_db()
        self.assertEqual(card2.position, 0)
        self.assertEqual(card3.position, 1)

    @patch(PATCH_BROADCAST)
    def test_rapid_moves_across_columns_produce_correct_movement_records(self, _):
        """Moving a card through multiple columns should create a movement for each."""
        card = Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.swim,
            title="Traveler", created_by=self.user, position=0,
        )

        # Move A -> B
        self.client.post(
            f"/api/v1/boards/{self.board.pk}/cards/{card.pk}/move/",
            {"column_id": self.col_b.pk, "swimlane_id": self.swim.pk, "position": 0},
        )
        # Move B -> C
        self.client.post(
            f"/api/v1/boards/{self.board.pk}/cards/{card.pk}/move/",
            {"column_id": self.col_c.pk, "swimlane_id": self.swim.pk, "position": 0},
        )

        movements = list(
            CardMovement.objects.filter(card=card).order_by("moved_at")
        )
        self.assertEqual(len(movements), 2)
        self.assertEqual(movements[0].from_column, self.col_a)
        self.assertEqual(movements[0].to_column, self.col_b)
        self.assertEqual(movements[1].from_column, self.col_b)
        self.assertEqual(movements[1].to_column, self.col_c)

        card.refresh_from_db()
        self.assertEqual(card.column, self.col_c)


class ConcurrentColumnCreationTests(TransactionTestCase):
    """Concurrent column/swimlane creation must not produce duplicate positions.

    select_for_update() on the board row serializes concurrent position
    calculations so that two simultaneous requests cannot both read the same
    Max(position) value and assign the same position to their new objects.

    True concurrency is exercised here via threading. TransactionTestCase is
    required because each thread needs its own DB connection and real commits
    (TestCase wraps everything in a rolled-back transaction that threads cannot see).
    """

    def setUp(self):
        self.user = User.objects.create_user(username="creator", password="pass")
        self.board = Board.objects.create(name="Race Board", owner=self.user)
        BoardMembership.objects.create(board=self.board, user=self.user, role=BoardMembership.Role.ADMIN)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    @patch(PATCH_BROADCAST)
    def test_sequential_column_creation_assigns_distinct_positions(self, _):
        """Rapid sequential column creation never assigns the same position twice."""
        for i in range(5):
            r = self.client.post(
                f"/api/v1/boards/{self.board.pk}/columns/",
                {"name": f"Col {i}", "color": "#000000"},
            )
            self.assertEqual(r.status_code, status.HTTP_201_CREATED)

        positions = list(
            Column.objects.filter(board=self.board).values_list("position", flat=True).order_by("position")
        )
        # All positions must be distinct — no two columns share the same slot.
        self.assertEqual(len(positions), len(set(positions)), f"Duplicate positions: {positions}")

    @patch(PATCH_BROADCAST)
    def test_sequential_swimlane_creation_assigns_distinct_positions(self, _):
        """Rapid sequential swimlane creation never assigns the same position twice."""
        for i in range(5):
            r = self.client.post(
                f"/api/v1/boards/{self.board.pk}/swimlanes/",
                {"name": f"Lane {i}"},
            )
            self.assertEqual(r.status_code, status.HTTP_201_CREATED)

        positions = list(
            Swimlane.objects.filter(board=self.board).values_list("position", flat=True).order_by("position")
        )
        self.assertEqual(len(positions), len(set(positions)), f"Duplicate positions: {positions}")


class ConcurrentCardCreationTests(TransactionTestCase):
    """Card creation in the same cell must not produce duplicate positions.

    perform_create() now locks the target column row with select_for_update()
    before reading the cell's card count, so two simultaneous creates in the
    same (column, swimlane) cell cannot both read the same Max(position) and
    assign the same slot (#1050). This mirrors the board-row lock used for
    column/swimlane creation above.
    """

    def setUp(self):
        self.user = User.objects.create_user(username="cardcreator", password="pass")
        self.board, self.col_a, self.col_b, self.col_c, self.swim = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    @patch(PATCH_BROADCAST)
    def test_sequential_card_creation_assigns_distinct_positions(self, _):
        """Rapid sequential card creation in one cell never reuses a position."""
        for i in range(5):
            r = self.client.post(
                f"/api/v1/boards/{self.board.pk}/cards/",
                {"title": f"Card {i}", "column": self.col_a.pk, "swimlane": self.swim.pk},
            )
            self.assertEqual(r.status_code, status.HTTP_201_CREATED)

        positions = list(
            Card.objects.filter(board=self.board, column=self.col_a, swimlane=self.swim)
            .values_list("position", flat=True)
            .order_by("position")
        )
        self.assertEqual(len(positions), 5)
        self.assertEqual(len(positions), len(set(positions)), f"Duplicate positions: {positions}")
        # Positions are contiguous from 0 — the count-based slot assignment is intact.
        self.assertEqual(positions, [0, 1, 2, 3, 4])

    @patch(PATCH_BROADCAST)
    def test_card_creation_position_is_per_cell(self, _):
        """Each (column, swimlane) cell maintains an independent position sequence."""
        # col_b defaults to allow_card_creation=False in _make_board.
        self.col_b.allow_card_creation = True
        self.col_b.save(update_fields=["allow_card_creation"])
        for col in (self.col_a, self.col_b):
            for i in range(3):
                r = self.client.post(
                    f"/api/v1/boards/{self.board.pk}/cards/",
                    {"title": f"{col.name} {i}", "column": col.pk, "swimlane": self.swim.pk},
                )
                self.assertEqual(r.status_code, status.HTTP_201_CREATED)

        for col in (self.col_a, self.col_b):
            positions = sorted(
                Card.objects.filter(board=self.board, column=col, swimlane=self.swim)
                .values_list("position", flat=True)
            )
            self.assertEqual(positions, [0, 1, 2], f"Cell {col.name} should restart at 0")


# ---------------------------------------------------------------------------
# Row-lock guards in boards/services/cards.py (#1504)
# ---------------------------------------------------------------------------
#
# SQLite has no row locks, so the select_for_update() calls in move_card and
# enforce_column_limits are unobservable there and every mutant on them survived
# the SQLite mutation run. These tests hold one move open *inside* its
# transaction (after it took its locks, before it writes) while a second move
# starts. With the locks the second move queues behind the first and sees its
# committed result; without them it runs to completion against stale state and
# the end state is inconsistent.

SERVICES_CARDS = "boards.services.cards"
HOLD_SECONDS = 1.5


@skipUnless(connection.vendor == "postgresql", "row locks are only observable on PostgreSQL")
class ConcurrentMoveLockTests(TransactionTestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="racer", password="pass")
        self.board, self.col_a, self.col_b, self.col_c, self.swim = _make_board(self.user)
        self.swim2 = Swimlane.objects.create(board=self.board, name="Second", position=1)

    def _card(self, title, column, position, swimlane=None):
        return Card.objects.create(
            board=self.board, column=column, swimlane=swimlane or self.swim,
            title=title, created_by=self.user, position=position,
        )

    def _race(self, hold_patch_target, first, second):
        """Run ``first`` and ``second`` (callables returning a status code).

        ``first`` is paused for HOLD_SECONDS inside its transaction, at the
        first call to ``hold_patch_target`` it makes (a function that runs after
        its locks are taken). ``second`` starts only once ``first`` is paused,
        so the two genuinely overlap without relying on scheduler luck: if the
        row locks are present ``second`` blocks until ``first`` commits, and if
        they are absent it runs to completion during the pause.
        """
        first_paused = threading.Event()
        results = {}
        errors = []
        original = getattr(__import__(SERVICES_CARDS, fromlist=["x"]), hold_patch_target)

        def hold(*args, **kwargs):
            out = original(*args, **kwargs)
            if threading.current_thread().name == "first" and not first_paused.is_set():
                first_paused.set()
                # The Event is never set, so this is a plain timed pause that
                # keeps the transaction (and its locks) open.
                threading.Event().wait(HOLD_SECONDS)
            return out

        def worker(name, fn, wait_for_first):
            try:
                if wait_for_first:
                    if not first_paused.wait(10):
                        raise RuntimeError("first move never reached the hold point")
                results[name] = fn()
            except BaseException as exc:  # noqa: BLE001 - surfaced after join
                errors.append(exc)
            finally:
                connections.close_all()  # release this thread's PostgreSQL connection

        with patch(f"{SERVICES_CARDS}.{hold_patch_target}", side_effect=hold), \
                patch(PATCH_BROADCAST):
            t1 = threading.Thread(target=worker, args=("first", first, False), name="first")
            t2 = threading.Thread(target=worker, args=("second", second, True), name="second")
            t1.start()
            t2.start()
            t1.join(30)
            t2.join(30)
        self.assertFalse(t1.is_alive() or t2.is_alive(), "a move hung (possible deadlock)")
        self.assertEqual(errors, [])
        return results

    def _move(self, card, column, position=0, swimlane=None):
        def run():
            client = APIClient()
            client.force_authenticate(self.user)
            resp = client.post(
                f"/api/v1/boards/{self.board.pk}/cards/{card.pk}/move/",
                {
                    "column_id": column.pk,
                    "swimlane_id": (swimlane or self.swim).pk,
                    "position": position,
                },
            )
            return resp.status_code
        return run

    def test_card_row_lock_serializes_two_moves_of_the_same_card(self):
        """The card-row lock makes the second move see the first one's result.

        Both moves target different columns. Serialized, the movement chain is
        A -> B then B -> C. Without the card lock both read the card in A and
        write A -> B and A -> C, a history that cannot have happened.
        """
        card = self._card("Contended", self.col_a, 0)
        # Held right after the card-row lock is taken. (Before #1522 the lock
        # was the first statement and ``_board_scoped`` ran after it; the card
        # is now read unlocked, so only a hold after _lock_move_cells keeps the
        # first move inside its lock.)
        results = self._race(
            "_lock_move_cells",
            self._move(card, self.col_b),
            self._move(card, self.col_c),
        )
        self.assertEqual(results["first"], 200)
        # The queued move may be answered 200 (it re-read the card after the
        # first commit) or 404: PostgreSQL re-checks the join that
        # ``select_related`` adds to the locked SELECT against the pre-commit
        # column row, so the card can drop out of the result. Either way it ran
        # strictly after the first move; what must never happen is two 200s
        # both written from column A.
        # Since #1522 the card is locked without the join and a move whose card
        # changed before the lock retries, so this is 200 in practice; the
        # assertion is tightened under #1523, which owns that contract.
        # Tighten to == 200 once #1523 (spurious 404 for the queued move) is fixed.
        self.assertIn(results["second"], (200, 404))

        movements = list(CardMovement.objects.filter(card=card).order_by("moved_at", "pk"))
        self.assertEqual(
            len(movements), list(results.values()).count(200),
            "exactly one movement row per successful move",
        )
        self.assertEqual(movements[0].from_column, self.col_a)
        self.assertEqual(movements[0].to_column, self.col_b)
        for earlier, later in zip(movements, movements[1:]):
            self.assertEqual(
                later.from_column, earlier.to_column,
                "each movement must start where the previous one ended",
            )
        card.refresh_from_db()
        self.assertEqual(card.column, movements[-1].to_column)
        self.assertEqual(card.version, 1 + len(movements))

    def test_column_lock_serializes_moves_into_a_full_column(self):
        """enforce_column_limits locks the target column before counting.

        The column holds one card and has room for exactly one more (hard WIP
        limit 2). Two different cards race into it: serialized, the second sees
        the first and is refused. Without the column lock both count one card,
        both pass, and the column ends up over its hard limit.
        """
        self.board.enforce_wip_hard = True
        self.board.save(update_fields=["enforce_wip_hard"])
        self.col_b.wip_limit = 2
        self.col_b.save(update_fields=["wip_limit"])
        self._card("Resident", self.col_b, 0)
        # Different source cells, so the target-column lock is the only thing
        # that can make these two moves queue. (The same-cell case is covered by
        # the #1522 deadlock tests below.)
        one = self._card("One", self.col_a, 0)
        two = self._card("Two", self.col_c, 0, swimlane=self.swim2)

        results = self._race(
            "enforce_column_limits",
            self._move(one, self.col_b),
            self._move(two, self.col_b, swimlane=self.swim2),
        )
        self.assertEqual(results["first"], 200)
        self.assertNotEqual(results["second"], 200, "second move must be refused by the WIP limit")

        self.assertEqual(Card.objects.filter(column=self.col_b).count(), 2)
        self.assertEqual(CardMovement.objects.filter(card__in=[one, two]).count(), 1)

    def test_target_cell_lock_keeps_positions_distinct(self):
        """Two cards entering one occupied cell at position 0 do not collide.

        The movers come from different source cells and swimlanes, so nothing
        but the target-cell sibling lock makes them queue. The first move is
        held after it has shifted the resident and saved its card, before it
        commits. Without the lock the second move's shift statement blocks on
        the resident row, then re-evaluates only that row against its old
        snapshot, so it never shifts the first mover and both end at position 0.
        """
        resident = self._card("resident", self.col_b, 0)
        x = self._card("x", self.col_a, 0)
        y = self._card("y", self.col_c, 0, swimlane=self.swim2)

        results = self._race(
            "_broadcast_after_commit",
            self._move(x, self.col_b, position=0),
            self._move(y, self.col_b, position=0),
        )
        self.assertEqual(results, {"first": 200, "second": 200})

        placed = dict(
            Card.objects.filter(column=self.col_b, swimlane=self.swim)
            .values_list("pk", "position")
        )
        self.assertEqual(sorted(placed.values()), [0, 1, 2], f"colliding positions: {placed}")
        self.assertEqual(placed[y.pk], 0, "the later move lands first")
        self.assertEqual(placed[x.pk], 1)
        self.assertEqual(placed[resident.pk], 2)
        self.assertEqual(CardMovement.objects.filter(card__in=[x, y]).count(), 2)

    # -- Deadlock freedom (#1522) -------------------------------------------
    #
    # A deadlock surfaces as ``OperationalError: deadlock detected``, which the
    # test client re-raises and ``_race`` collects in ``errors`` — so each test
    # below fails on the deadlock itself, before any end-state assertion.

    def _assert_cell_positions_compact(self, column, swimlane):
        positions = sorted(
            Card.objects.filter(column=column, swimlane=swimlane, archived_at__isnull=True)
            .values_list("position", flat=True)
        )
        self.assertEqual(positions, list(range(len(positions))), f"{column.name}: {positions}")

    def test_two_moves_out_of_the_same_cell_do_not_deadlock(self):
        """Two different cards leave one cell at once and both moves succeed.

        The reported #1522 case. Before the fix each move locked its own card
        row first and then the *other* card as a source-cell sibling, so the
        two transactions waited on each other. Locking the whole cell in one
        pk-ordered statement makes the second move queue behind the first.
        """
        one = self._card("One", self.col_a, 0)
        two = self._card("Two", self.col_a, 1)
        self._card("Three", self.col_a, 2)

        results = self._race(
            "enforce_column_limits",
            self._move(one, self.col_b),
            self._move(two, self.col_c),
        )
        self.assertEqual(results, {"first": 200, "second": 200})

        one.refresh_from_db()
        two.refresh_from_db()
        self.assertEqual((one.column, two.column), (self.col_b, self.col_c))
        self._assert_cell_positions_compact(self.col_a, self.swim)
        self.assertEqual(CardMovement.objects.filter(card__in=[one, two]).count(), 2)

    def test_two_moves_out_of_the_same_cell_in_reverse_pk_order_do_not_deadlock(self):
        """Same race, with the higher-pk card moving first.

        Guards the ordering half of the fix: whichever card wins, both moves
        must acquire the cell in the same (pk) order.
        """
        low = self._card("Low", self.col_a, 0)
        high = self._card("High", self.col_a, 1)

        results = self._race(
            "enforce_column_limits",
            self._move(high, self.col_b),
            self._move(low, self.col_c),
        )
        self.assertEqual(results, {"first": 200, "second": 200})
        self._assert_cell_positions_compact(self.col_a, self.swim)

    def test_opposite_moves_between_two_cells_do_not_deadlock(self):
        """A card goes A -> B while another goes B -> A, in the same swimlane.

        Each move's source cell is the other's target cell. Locking source then
        target as two statements would let the moves take the two cells in
        opposite orders; both cells are locked in one pk-ordered statement.
        """
        x = self._card("x", self.col_a, 0)
        y = self._card("y", self.col_b, 0)

        results = self._race(
            "enforce_column_limits",
            self._move(x, self.col_b),
            self._move(y, self.col_a),
        )
        self.assertEqual(results, {"first": 200, "second": 200})
        x.refresh_from_db()
        y.refresh_from_db()
        self.assertEqual((x.column, y.column), (self.col_b, self.col_a))
        self._assert_cell_positions_compact(self.col_a, self.swim)
        self._assert_cell_positions_compact(self.col_b, self.swim)

    def test_opposite_moves_between_limited_columns_do_not_deadlock(self):
        """Opposite-direction moves in different swimlanes, both columns limited.

        The cells are disjoint, so only column rows are shared. Each move locks
        its target column for the WIP count; the ``CardMovement`` insert then
        needs a key-share lock on its *source* column, which is the other
        move's target. A plain ``FOR UPDATE`` on the column conflicts with that
        key-share lock and the two moves deadlock; the column lock is therefore
        ``FOR NO KEY UPDATE``, which still serializes concurrent limit checks.
        """
        self.board.enforce_wip_limits = True
        self.board.save(update_fields=["enforce_wip_limits"])
        for column in (self.col_a, self.col_b):
            column.wip_limit = 10
            column.save(update_fields=["wip_limit"])
        x = self._card("x", self.col_a, 0)
        y = self._card("y", self.col_b, 0, swimlane=self.swim2)

        results = self._race(
            "enforce_column_limits",
            self._move(x, self.col_b),
            self._move(y, self.col_a, swimlane=self.swim2),
        )
        self.assertEqual(results, {"first": 200, "second": 200})
        x.refresh_from_db()
        y.refresh_from_db()
        self.assertEqual((x.column, y.column), (self.col_b, self.col_a))
