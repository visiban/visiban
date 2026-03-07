from unittest.mock import patch

from django.test import TestCase
from rest_framework.test import APIClient
from rest_framework import status

from accounts.models import User
from boards.models import Board, BoardMembership, Column, Swimlane
from boards.permissions import get_board_role, SITE_ADMIN


def make_board(owner):
    board = Board.objects.create(name="Test Board", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col, swim


class GetBoardRoleTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, _, _ = make_board(self.owner)

    def test_owner_gets_admin_role(self):
        role = get_board_role(self.owner, self.board)
        self.assertEqual(role, BoardMembership.Role.ADMIN)

    def test_explicit_member_role(self):
        member = User.objects.create_user(username="member", password="pass")
        BoardMembership.objects.create(board=self.board, user=member, role=BoardMembership.Role.MEMBER)
        self.assertEqual(get_board_role(member, self.board), BoardMembership.Role.MEMBER)

    def test_explicit_viewer_role(self):
        viewer = User.objects.create_user(username="viewer", password="pass")
        BoardMembership.objects.create(board=self.board, user=viewer, role=BoardMembership.Role.VIEWER)
        self.assertEqual(get_board_role(viewer, self.board), BoardMembership.Role.VIEWER)

    def test_explicit_collaborator_role(self):
        collab = User.objects.create_user(username="collab", password="pass")
        BoardMembership.objects.create(board=self.board, user=collab, role=BoardMembership.Role.COLLABORATOR)
        self.assertEqual(get_board_role(collab, self.board), BoardMembership.Role.COLLABORATOR)

    def test_non_member_returns_none(self):
        stranger = User.objects.create_user(username="stranger", password="pass")
        self.assertIsNone(get_board_role(stranger, self.board))

    def test_site_admin_gets_site_admin_role(self):
        admin = User.objects.create_user(username="siteadmin", password="pass")
        admin.is_site_admin = True
        admin.save()
        self.assertEqual(get_board_role(admin, self.board), SITE_ADMIN)


class CardCreationRBACTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, self.col, self.swim = make_board(self.owner)

    def _create_card(self, user):
        self.client.force_authenticate(user)
        return self.client.post(
            f"/api/boards/{self.board.pk}/cards/",
            {"title": "New Card", "column": self.col.pk, "swimlane": self.swim.pk},
        )

    @patch("boards.views.broadcast_board_event")
    def test_member_can_create_card(self, _mock_broadcast):
        member = User.objects.create_user(username="member", password="pass")
        BoardMembership.objects.create(board=self.board, user=member, role=BoardMembership.Role.MEMBER)
        resp = self._create_card(member)
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

    def test_viewer_cannot_create_card(self):
        viewer = User.objects.create_user(username="viewer", password="pass")
        BoardMembership.objects.create(board=self.board, user=viewer, role=BoardMembership.Role.VIEWER)
        resp = self._create_card(viewer)
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_collaborator_cannot_create_card(self):
        collab = User.objects.create_user(username="collab", password="pass")
        BoardMembership.objects.create(board=self.board, user=collab, role=BoardMembership.Role.COLLABORATOR)
        resp = self._create_card(collab)
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_non_member_gets_403(self):
        stranger = User.objects.create_user(username="stranger", password="pass")
        resp = self._create_card(stranger)
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)


class ColumnCreationRBACTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, _, _ = make_board(self.owner)

    def _create_column(self, user):
        self.client.force_authenticate(user)
        return self.client.post(
            f"/api/boards/{self.board.pk}/columns/",
            {"name": "New Column", "position": 99},
        )

    @patch("boards.views.broadcast_board_event")
    def test_admin_can_create_column(self, _mock_broadcast):
        resp = self._create_column(self.owner)
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

    def test_member_cannot_create_column(self):
        member = User.objects.create_user(username="member", password="pass")
        BoardMembership.objects.create(board=self.board, user=member, role=BoardMembership.Role.MEMBER)
        resp = self._create_column(member)
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_viewer_cannot_create_column(self):
        viewer = User.objects.create_user(username="viewer", password="pass")
        BoardMembership.objects.create(board=self.board, user=viewer, role=BoardMembership.Role.VIEWER)
        resp = self._create_column(viewer)
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
