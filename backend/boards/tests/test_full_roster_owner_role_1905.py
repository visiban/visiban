"""The /full/ roster shows the owner with get_board_role's role (#1905).

``get_board_role`` ranks ownership above an explicit row, so an owner whose
stored row is lower is an admin (and assignable). The roster says so and
keeps the row's id. A row holding a role outside the enum stays listed as
stored, so an admin can find and remove it.
"""
from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership
from boards.permissions import get_board_role


class FullRosterOwnerRoleTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner_1905", password="pw")
        self.admin = User.objects.create_user(username="admin_1905", password="pw")
        self.odd = User.objects.create_user(username="odd_1905", password="pw")
        self.board = Board.objects.create(name="B", owner=self.owner)
        self.owner_row = BoardMembership.objects.create(board=self.board, user=self.owner, role="viewer")
        BoardMembership.objects.create(board=self.board, user=self.admin, role="admin")
        BoardMembership.objects.create(board=self.board, user=self.odd, role="bogus")

    def _roster(self, reader):
        c = APIClient()
        c.force_authenticate(reader)
        r = c.get(f"/api/v1/boards/{self.board.pk}/full/")
        self.assertEqual(r.status_code, 200, r.content)
        return {m["user"]["username"]: m for m in r.json()["members"]}

    def test_owner_with_lower_row_is_shown_as_admin(self):
        self.assertEqual(get_board_role(self.owner, self.board), "admin")
        rows = self._roster(self.admin)
        self.assertEqual(rows["owner_1905"]["role"], "admin")
        # Still the stored row, so it can be removed from the Members panel.
        self.assertEqual(rows["owner_1905"]["id"], self.owner_row.pk)

    def test_out_of_enum_row_listed_as_stored(self):
        rows = self._roster(self.admin)
        self.assertEqual(rows["odd_1905"]["role"], "bogus")

    def test_owner_with_admin_row_unchanged(self):
        self.owner_row.role = "admin"
        self.owner_row.save(update_fields=["role"])
        rows = self._roster(self.owner)
        self.assertEqual(rows["owner_1905"]["role"], "admin")
        self.assertEqual(rows["owner_1905"]["id"], self.owner_row.pk)
