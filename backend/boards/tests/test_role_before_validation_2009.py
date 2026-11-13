"""Board and column PUT/PATCH check the role before validating the body (#2009).

DRF validates the serializer before ``perform_update``, so a caller below admin
sending an invalid body got a 400 that named the bad fields, while a valid body
got 403. ``CardViewSet.update`` already checked first; these two now do too.
"""
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Column


class RoleBeforeValidationTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="rbv_owner", password="pass")
        self.board = Board.objects.create(name="RBV", owner=self.owner)
        BoardMembership.objects.create(board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN)
        self.column = Column.objects.create(board=self.board, name="Todo", position=0)
        self.users = {}
        for role in (
            BoardMembership.Role.VIEWER,
            BoardMembership.Role.COLLABORATOR,
            BoardMembership.Role.MEMBER,
        ):
            user = User.objects.create_user(username=f"rbv_{role}", password="pass")
            BoardMembership.objects.create(board=self.board, user=user, role=role)
            self.users[role] = user
        self.board_url = f"/api/v1/boards/{self.board.pk}/"
        self.column_url = f"/api/v1/boards/{self.board.pk}/columns/{self.column.pk}/"

    def _client(self, user):
        c = APIClient()
        c.force_authenticate(user)
        return c

    def test_below_admin_invalid_board_body_is_403(self):
        bad = {"name": "", "staleness_threshold_days": "not-a-number"}
        for role, user in self.users.items():
            for method in ("patch", "put"):
                with self.subTest(role=role, method=method):
                    r = getattr(self._client(user), method)(self.board_url, bad, format="json")
                    self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN, r.content)
                    self.assertNotIn("staleness_threshold_days", r.json())
        self.board.refresh_from_db()
        self.assertEqual(self.board.name, "RBV")

    def test_below_admin_invalid_column_body_is_403(self):
        bad = {"name": "", "wip_limit": "not-a-number"}
        for role, user in self.users.items():
            for method in ("patch", "put"):
                with self.subTest(role=role, method=method):
                    r = getattr(self._client(user), method)(self.column_url, bad, format="json")
                    self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN, r.content)
                    self.assertNotIn("wip_limit", r.json())
        self.column.refresh_from_db()
        self.assertEqual(self.column.name, "Todo")

    def test_admin_invalid_body_is_still_400(self):
        admin = self._client(self.owner)
        r = admin.patch(self.board_url, {"staleness_threshold_days": "not-a-number"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("staleness_threshold_days", r.json())
        r = admin.patch(self.column_url, {"wip_limit": "not-a-number"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("wip_limit", r.json())

    def test_admin_valid_patch_still_applies(self):
        admin = self._client(self.owner)
        r = admin.patch(self.board_url, {"name": "Renamed"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assertEqual(r.json()["name"], "Renamed")
        r = admin.patch(self.column_url, {"name": "Doing"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assertEqual(r.json()["name"], "Doing")

    def test_non_member_still_gets_404(self):
        outsider = User.objects.create_user(username="rbv_out", password="pass")
        c = self._client(outsider)
        self.assertEqual(c.patch(self.board_url, {"name": ""}, format="json").status_code, 404)
        self.assertEqual(c.patch(self.column_url, {"name": ""}, format="json").status_code, 404)
