"""
Tests for #204: broadcast_board_event must fire via transaction.on_commit(),
not directly inside the transaction, so a rollback cannot push stale state
to connected WebSocket clients.
"""
from unittest.mock import patch

from django.db import transaction
from django.test import TestCase, TransactionTestCase
from rest_framework.test import APIClient
from rest_framework import status

from accounts.models import User
from boards.models import Board, BoardMembership, Column, Swimlane, Card


def make_board(owner):
    board = Board.objects.create(name="Test Board", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    return board


class CardCreatedBroadcastOnCommitTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="tester", password="pass")
        self.client.force_authenticate(self.user)
        self.board = make_board(self.user)
        self.col = Column.objects.create(board=self.board, name="Backlog", position=0, allow_card_creation=True)
        self.swim = Swimlane.objects.create(board=self.board, name="Acme", position=0)

    def test_card_created_broadcast_fires_after_commit(self):
        """broadcast_board_event for card.created fires via on_commit, not inside the transaction."""
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.post(
                    f"/api/boards/{self.board.pk}/cards/",
                    {"title": "New card", "column": self.col.pk, "swimlane": self.swim.pk},
                )
            self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
            mock_broadcast.assert_called_once()
            event_type = mock_broadcast.call_args[0][1]
            self.assertEqual(event_type, "card.created")

    def test_card_created_broadcast_not_called_before_commit(self):
        """Broadcast must not have fired before on_commit callbacks execute."""
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=False):
                self.client.post(
                    f"/api/boards/{self.board.pk}/cards/",
                    {"title": "New card", "column": self.col.pk, "swimlane": self.swim.pk},
                )
                # on_commit callbacks have not run yet
                mock_broadcast.assert_not_called()


class CardMovedBroadcastOnCommitTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="tester", password="pass")
        self.client.force_authenticate(self.user)
        self.board = make_board(self.user)
        self.col_a = Column.objects.create(board=self.board, name="Backlog", position=0)
        self.col_b = Column.objects.create(board=self.board, name="Done", position=1)
        self.swim = Swimlane.objects.create(board=self.board, name="Acme", position=0)
        self.card = Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.swim,
            title="Test Card", created_by=self.user, position=0,
        )

    def _move_url(self):
        return f"/api/boards/{self.board.pk}/cards/{self.card.pk}/move/"

    def test_card_moved_broadcast_fires_after_commit(self):
        """broadcast_board_event for card.moved fires via on_commit, not inside the transaction."""
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.post(self._move_url(), {
                    "column_id": self.col_b.pk,
                    "swimlane_id": self.swim.pk,
                    "position": 0,
                })
            self.assertEqual(resp.status_code, status.HTTP_200_OK)
            mock_broadcast.assert_called_once()
            event_type = mock_broadcast.call_args[0][1]
            self.assertEqual(event_type, "card.moved")

    def test_card_moved_broadcast_not_called_before_commit(self):
        """Broadcast must not have fired before on_commit callbacks execute."""
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=False):
                self.client.post(self._move_url(), {
                    "column_id": self.col_b.pk,
                    "swimlane_id": self.swim.pk,
                    "position": 0,
                })
                mock_broadcast.assert_not_called()

    def test_pure_reorder_broadcasts_card_moved(self):
        """Moving a card within the same cell (position change only) still broadcasts card.moved."""
        card2 = Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.swim,
            title="Other Card", created_by=self.user, position=1,
        )
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.post(self._move_url(), {
                    "column_id": self.col_a.pk,
                    "swimlane_id": self.swim.pk,
                    "position": 1,
                })
            self.assertEqual(resp.status_code, status.HTTP_200_OK)
            mock_broadcast.assert_called_once()
        card2.delete()


class CardMoveBroadcastRollbackTests(TransactionTestCase):
    """
    Uses TransactionTestCase (real transactions, no savepoint wrapping) to verify
    that on_commit callbacks are suppressed when a transaction rolls back.
    """

    def setUp(self):
        self.user = User.objects.create_user(username="tester", password="pass")
        self.board = Board.objects.create(name="Test Board", owner=self.user)
        BoardMembership.objects.create(board=self.board, user=self.user, role=BoardMembership.Role.ADMIN)
        self.col_a = Column.objects.create(board=self.board, name="Backlog", position=0)
        self.col_b = Column.objects.create(board=self.board, name="Done", position=1)
        self.swim = Swimlane.objects.create(board=self.board, name="Acme", position=0)
        self.card = Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.swim,
            title="Test Card", created_by=self.user, position=0,
        )

    def test_broadcast_suppressed_on_rollback(self):
        """on_commit callback must not fire if the enclosing transaction rolls back."""
        broadcast_calls = []

        def capture_broadcast(*args, **kwargs):
            broadcast_calls.append(args)

        with patch("boards.broadcast.broadcast_board_event", side_effect=capture_broadcast):
            try:
                with transaction.atomic():
                    # Manually queue an on_commit callback the same way the view does.
                    transaction.on_commit(lambda: capture_broadcast("should_not_fire"))
                    raise Exception("forced rollback")
            except Exception:
                pass

        # The on_commit callback should NOT have fired because the transaction rolled back.
        self.assertEqual(broadcast_calls, [])


class HardWipBroadcastTests(TestCase):
    """Verify that a hard-blocked move does not emit any broadcast event (#341).

    The 409 response is returned before a CardMovement is created, so the
    on_commit handler that broadcasts card.moved is never registered.
    """

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="hardwiptester", password="pass")
        self.client.force_authenticate(self.user)
        self.board = Board.objects.create(
            name="Hard WIP Broadcast Board",
            owner=self.user,
            enforce_wip_hard=True,
        )
        BoardMembership.objects.create(board=self.board, user=self.user, role=BoardMembership.Role.ADMIN)
        self.col_a = Column.objects.create(board=self.board, name="Backlog", position=0)
        self.col_b = Column.objects.create(board=self.board, name="In Progress", position=1, wip_limit=1)
        self.swim = Swimlane.objects.create(board=self.board, name="Acme", position=0)
        # Fill col_b to its limit so the next move will be hard-blocked.
        Card.objects.create(
            board=self.board, column=self.col_b, swimlane=self.swim,
            title="Blocker", created_by=self.user, position=0,
        )
        self.card = Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.swim,
            title="Moving Card", created_by=self.user, position=0,
        )

    def test_no_broadcast_on_hard_blocked_move(self):
        """No broadcast fires when a move is rejected by hard WIP enforcement."""
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.post(
                    f"/api/boards/{self.board.pk}/cards/{self.card.pk}/move/",
                    {"column_id": self.col_b.pk, "swimlane_id": self.swim.pk, "position": 0},
                )
            self.assertEqual(resp.status_code, 409)
            self.assertEqual(resp.json()["code"], "wip_hard_blocked")
            # The view must have returned before registering any on_commit broadcast.
            mock_broadcast.assert_not_called()
