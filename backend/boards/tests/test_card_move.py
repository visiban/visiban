from unittest.mock import patch

from django.test import TestCase
from rest_framework.test import APIClient
from rest_framework import status

from accounts.models import User
from boards.models import Board, BoardMembership, Column, Swimlane, Card, CardMovement


def make_board(owner):
    board = Board.objects.create(name="Test Board", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    return board


class CardMoveTests(TestCase):
    def setUp(self):
        self._broadcast_patcher = patch("boards.views.broadcast_board_event")
        self._broadcast_patcher.start()

        self.client = APIClient()
        self.user = User.objects.create_user(username="tester", password="pass")
        self.client.force_authenticate(self.user)

        self.board = make_board(self.user)
        self.col_a = Column.objects.create(board=self.board, name="Backlog", position=0)
        self.col_b = Column.objects.create(board=self.board, name="In Progress", position=1)
        self.swim_x = Swimlane.objects.create(board=self.board, name="Acme", position=0)
        self.swim_y = Swimlane.objects.create(board=self.board, name="Globex", position=1)

        self.card = Card.objects.create(
            board=self.board,
            column=self.col_a,
            swimlane=self.swim_x,
            title="Test Card",
            created_by=self.user,
            position=0,
        )

    def tearDown(self):
        self._broadcast_patcher.stop()

    def _move_url(self):
        return f"/api/boards/{self.board.pk}/cards/{self.card.pk}/move/"

    def test_move_to_new_column_creates_movement(self):
        resp = self.client.post(self._move_url(), {
            "column_id": self.col_b.pk,
            "swimlane_id": self.swim_x.pk,
            "position": 0,
        })
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.card.refresh_from_db()
        self.assertEqual(self.card.column, self.col_b)
        self.assertEqual(CardMovement.objects.filter(card=self.card).count(), 1)
        movement = CardMovement.objects.get(card=self.card)
        self.assertEqual(movement.from_column, self.col_a)
        self.assertEqual(movement.to_column, self.col_b)

    def test_move_to_new_swimlane_creates_movement(self):
        resp = self.client.post(self._move_url(), {
            "column_id": self.col_a.pk,
            "swimlane_id": self.swim_y.pk,
            "position": 0,
        })
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.card.refresh_from_db()
        self.assertEqual(self.card.swimlane, self.swim_y)
        self.assertEqual(CardMovement.objects.filter(card=self.card).count(), 1)

    def test_reorder_within_same_cell_does_not_create_movement(self):
        Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.swim_x,
            title="Card 2", created_by=self.user, position=1,
        )
        resp = self.client.post(self._move_url(), {
            "column_id": self.col_a.pk,
            "swimlane_id": self.swim_x.pk,
            "position": 1,
        })
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(CardMovement.objects.filter(card=self.card).count(), 0)

    def test_move_cross_column_and_swimlane_simultaneously(self):
        resp = self.client.post(self._move_url(), {
            "column_id": self.col_b.pk,
            "swimlane_id": self.swim_y.pk,
            "position": 0,
        })
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.card.refresh_from_db()
        self.assertEqual(self.card.column, self.col_b)
        self.assertEqual(self.card.swimlane, self.swim_y)
        movement = CardMovement.objects.get(card=self.card)
        self.assertEqual(movement.from_column, self.col_a)
        self.assertEqual(movement.to_column, self.col_b)
        self.assertEqual(movement.from_swimlane, self.swim_x)
        self.assertEqual(movement.to_swimlane, self.swim_y)

    def test_move_validates_column_belongs_to_board(self):
        other_board = make_board(self.user)
        other_col = Column.objects.create(board=other_board, name="Other", position=0)
        resp = self.client.post(self._move_url(), {
            "column_id": other_col.pk,
            "swimlane_id": self.swim_x.pk,
            "position": 0,
        })
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_move_validates_swimlane_belongs_to_board(self):
        other_board = make_board(self.user)
        other_swim = Swimlane.objects.create(board=other_board, name="Other", position=0)
        resp = self.client.post(self._move_url(), {
            "column_id": self.col_b.pk,
            "swimlane_id": other_swim.pk,
            "position": 0,
        })
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_source_siblings_reordered_after_move(self):
        card2 = Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.swim_x,
            title="Card 2", created_by=self.user, position=1,
        )
        card3 = Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.swim_x,
            title="Card 3", created_by=self.user, position=2,
        )
        self.client.post(self._move_url(), {
            "column_id": self.col_b.pk,
            "swimlane_id": self.swim_x.pk,
            "position": 0,
        })
        card2.refresh_from_db()
        card3.refresh_from_db()
        self.assertEqual(card2.position, 0)
        self.assertEqual(card3.position, 1)

    def test_non_member_cannot_move_card(self):
        outsider = User.objects.create_user(username="outsider", password="pass")
        self.client.force_authenticate(outsider)
        resp = self.client.post(self._move_url(), {
            "column_id": self.col_b.pk,
            "swimlane_id": self.swim_x.pk,
            "position": 0,
        })
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_response_includes_movement_when_changed(self):
        resp = self.client.post(self._move_url(), {
            "column_id": self.col_b.pk,
            "swimlane_id": self.swim_x.pk,
            "position": 0,
        })
        data = resp.json()
        self.assertIn("card", data)
        self.assertIn("movement", data)

    def test_response_excludes_movement_on_reorder(self):
        resp = self.client.post(self._move_url(), {
            "column_id": self.col_a.pk,
            "swimlane_id": self.swim_x.pk,
            "position": 0,
        })
        data = resp.json()
        self.assertIn("card", data)
        self.assertNotIn("movement", data)

    def test_movement_stores_denormalized_column_names(self):
        resp = self.client.post(self._move_url(), {
            "column_id": self.col_b.pk,
            "swimlane_id": self.swim_x.pk,
            "position": 0,
        })
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        movement = CardMovement.objects.get(card=self.card)
        self.assertEqual(movement.from_column_name, self.col_a.name)
        self.assertEqual(movement.to_column_name, self.col_b.name)
        self.assertEqual(movement.from_swimlane_name, self.swim_x.name)
        self.assertEqual(movement.to_swimlane_name, self.swim_x.name)

    def test_movement_api_returns_names_after_column_deleted(self):
        """Names must survive column deletion — the key regression being fixed."""
        col_b_name = self.col_b.name
        self.client.post(self._move_url(), {
            "column_id": self.col_b.pk,
            "swimlane_id": self.swim_x.pk,
            "position": 0,
        })
        # Delete the destination column (simulates the bug scenario)
        self.col_b.delete()

        resp = self.client.get(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/movements/"
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        movements = resp.json()
        move = next(m for m in movements if m["to_column"] is None)
        self.assertEqual(move["to_column_name"], col_b_name)
