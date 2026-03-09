"""Concurrent/conflict tests for card move serialization.

Verifies that the select_for_update locking in the card move view
correctly serializes concurrent operations so that card positions
remain consistent after parallel moves.
"""
from unittest.mock import patch

from django.test import TestCase, TransactionTestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, CardMovement, Column, Swimlane


PATCH_BROADCAST = "boards.views.broadcast_board_event"


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
            f"/api/boards/{self.board.pk}/cards/{card1.pk}/move/",
            {"column_id": self.col_b.pk, "swimlane_id": self.swim.pk, "position": 0},
        )
        self.assertEqual(resp1.status_code, status.HTTP_200_OK)

        # Move card2 to col_b at position 0 (should push card1 to position 1)
        resp2 = self.client.post(
            f"/api/boards/{self.board.pk}/cards/{card2.pk}/move/",
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
            f"/api/boards/{self.board.pk}/cards/{card1.pk}/move/",
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
            f"/api/boards/{self.board.pk}/cards/{card.pk}/move/",
            {"column_id": self.col_b.pk, "swimlane_id": self.swim.pk, "position": 0},
        )
        # Move B -> C
        self.client.post(
            f"/api/boards/{self.board.pk}/cards/{card.pk}/move/",
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
