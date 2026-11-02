"""A deleted board/group and one the caller cannot access answer identically (#2041).

The SPA shows one "isn't available" page for both causes. That only holds if the
API gives the same status and body for both; otherwise the page would leak what
the copy deliberately hides.
"""
from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership
from groups.models import Group, GroupMembership

MISSING_ID = 987654


class BoardUnavailableIndistinguishableTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.outsider = User.objects.create_user(username="outsider", password="pass")
        self.board = Board.objects.create(name="B", owner=self.owner)
        BoardMembership.objects.create(
            board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN
        )
        self.client = APIClient()
        self.client.force_authenticate(self.outsider)

    def _assert_same(self, path_template):
        existing = self.client.get(path_template.format(id=self.board.id))
        missing = self.client.get(path_template.format(id=MISSING_ID))
        self.assertEqual(existing.status_code, 404)
        self.assertEqual(existing.status_code, missing.status_code)
        self.assertEqual(existing.data, missing.data)
        return existing

    def test_full_matches_for_outsider_and_nonexistent(self):
        self._assert_same("/api/v1/boards/{id}/full/")

    def test_retrieve_matches_for_outsider_and_nonexistent(self):
        self._assert_same("/api/v1/boards/{id}/")

    def test_deleted_board_matches_outsider_on_existing_board(self):
        deleted = Board.objects.create(name="Gone", owner=self.owner)
        deleted_id = deleted.id
        deleted.delete()
        inaccessible = self.client.get(f"/api/v1/boards/{self.board.id}/full/")
        gone = self.client.get(f"/api/v1/boards/{deleted_id}/full/")
        self.assertEqual(inaccessible.status_code, gone.status_code)
        self.assertEqual(inaccessible.data, gone.data)


class GroupUnavailableIndistinguishableTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="gowner", password="pass")
        self.outsider = User.objects.create_user(username="goutsider", password="pass")
        self.group = Group.objects.create(name="G", owner=self.owner)
        GroupMembership.objects.create(
            group=self.group, user=self.owner, role=GroupMembership.Role.ADMIN
        )
        self.client = APIClient()
        self.client.force_authenticate(self.outsider)

    def _assert_same(self, path_template):
        existing = self.client.get(path_template.format(id=self.group.id))
        missing = self.client.get(path_template.format(id=MISSING_ID))
        self.assertEqual(existing.status_code, 404)
        self.assertEqual(existing.status_code, missing.status_code)
        self.assertEqual(existing.data, missing.data)

    def test_retrieve_matches_for_outsider_and_nonexistent(self):
        self._assert_same("/api/v1/groups/{id}/")

    def test_sub_resources_match_for_outsider_and_nonexistent(self):
        # GroupDetail loads these four together; any one answering differently
        # would tell the cause apart.
        for suffix in ("members/", "subgroups/", "boards/"):
            with self.subTest(suffix=suffix):
                self._assert_same("/api/v1/groups/{id}/" + suffix)

    def test_deleted_group_matches_outsider_on_existing_group(self):
        deleted = Group.objects.create(name="Gone", owner=self.owner)
        deleted_id = deleted.id
        deleted.delete()
        inaccessible = self.client.get(f"/api/v1/groups/{self.group.id}/")
        gone = self.client.get(f"/api/v1/groups/{deleted_id}/")
        self.assertEqual(inaccessible.status_code, gone.status_code)
        self.assertEqual(inaccessible.data, gone.data)
