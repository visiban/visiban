from django.test import TestCase
from rest_framework.test import APIClient
from rest_framework import status

from accounts.models import User
from boards.models import Board, Column, Swimlane


class BoardCreationTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="creator", password="pass")
        self.client.force_authenticate(self.user)

    def _create_board(self, name="My Board"):
        return self.client.post("/api/boards/", {"name": name})

    def test_creates_four_default_columns(self):
        resp = self._create_board()
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        board_id = resp.data["id"]
        self.assertEqual(Column.objects.filter(board_id=board_id).count(), 4)

    def test_default_column_names(self):
        resp = self._create_board()
        board_id = resp.data["id"]
        names = list(
            Column.objects.filter(board_id=board_id).order_by("position").values_list("name", flat=True)
        )
        self.assertEqual(names, ["Backlog", "To Do", "Doing", "Done"])

    def test_only_first_column_allows_card_creation(self):
        resp = self._create_board()
        board_id = resp.data["id"]
        columns = Column.objects.filter(board_id=board_id).order_by("position")
        self.assertTrue(columns[0].allow_card_creation)
        for col in columns[1:]:
            self.assertFalse(col.allow_card_creation)

    def test_creates_general_swimlane(self):
        resp = self._create_board()
        board_id = resp.data["id"]
        swimlanes = Swimlane.objects.filter(board_id=board_id)
        self.assertEqual(swimlanes.count(), 1)
        self.assertEqual(swimlanes.first().name, "General")

    def test_board_listing_excludes_other_users_boards(self):
        other = User.objects.create_user(username="other", password="pass")
        Board.objects.create(name="Other's Board", owner=other)

        resp = self.client.get("/api/boards/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        board_ids = [b["id"] for b in resp.data]
        other_boards = Board.objects.filter(owner=other).values_list("id", flat=True)
        for board_id in other_boards:
            self.assertNotIn(board_id, board_ids)

    def test_creator_is_board_admin(self):
        from boards.models import BoardMembership
        resp = self._create_board()
        board_id = resp.data["id"]
        membership = BoardMembership.objects.get(board_id=board_id, user=self.user)
        self.assertEqual(membership.role, BoardMembership.Role.ADMIN)

    def test_unauthenticated_cannot_create_board(self):
        anon_client = APIClient()
        resp = anon_client.post("/api/boards/", {"name": "Anon Board"})
        self.assertIn(resp.status_code, (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN))
