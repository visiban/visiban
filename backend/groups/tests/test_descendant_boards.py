"""Tests for the GET /api/groups/{id}/descendant-boards/ endpoint.

Verifies that boards in groups nested 3+ levels deep are returned, that the
response is scoped to what the requesting user is allowed to see, and that
boards from the root group itself are included.
"""
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, Column, Swimlane
from groups.models import Group, GroupMembership


def _make_group(owner, name="Group", parent=None):
    group = Group.objects.create(name=name, owner=owner, parent=parent)
    GroupMembership.objects.create(group=group, user=owner, role=GroupMembership.Role.ADMIN)
    return group


def _make_board(owner, group, name="Board"):
    return Board.objects.create(name=name, owner=owner, group=group)


class DescendantBoardsTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.other = User.objects.create_user(username="other", password="pass")
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

        # Build a 3-level deep group hierarchy:
        # root → child → grandchild
        self.root = _make_group(self.owner, name="Root")
        self.child = _make_group(self.owner, name="Child", parent=self.root)
        self.grandchild = _make_group(self.owner, name="Grandchild", parent=self.child)

        self.root_board = _make_board(self.owner, self.root, name="Root Board")
        self.child_board = _make_board(self.owner, self.child, name="Child Board")
        self.grandchild_board = _make_board(self.owner, self.grandchild, name="Grandchild Board")

    def _get(self, group_id):
        return self.client.get(f"/api/groups/{group_id}/descendant-boards/")

    def test_returns_boards_from_root_group(self):
        r = self._get(self.root.id)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        board_ids = [b["id"] for b in r.json()]
        self.assertIn(self.root_board.id, board_ids)

    def test_returns_boards_from_direct_child(self):
        r = self._get(self.root.id)
        board_ids = [b["id"] for b in r.json()]
        self.assertIn(self.child_board.id, board_ids)

    def test_returns_boards_from_deeply_nested_grandchild(self):
        """Board in a group 3 levels deep must appear in the descendant-boards response."""
        r = self._get(self.root.id)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        board_ids = [b["id"] for b in r.json()]
        self.assertIn(self.grandchild_board.id, board_ids)

    def test_scoped_to_subtree_not_all_groups(self):
        """Only descendants of the requested group are returned, not all boards."""
        # Create a sibling group (not a descendant of root)
        sibling = _make_group(self.owner, name="Sibling")
        sibling_board = _make_board(self.owner, sibling, name="Sibling Board")
        r = self._get(self.root.id)
        board_ids = [b["id"] for b in r.json()]
        self.assertNotIn(sibling_board.id, board_ids)

    def test_child_endpoint_returns_only_its_subtree(self):
        """Requesting the child group only returns boards in child and grandchild."""
        r = self._get(self.child.id)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        board_ids = [b["id"] for b in r.json()]
        self.assertIn(self.child_board.id, board_ids)
        self.assertIn(self.grandchild_board.id, board_ids)
        self.assertNotIn(self.root_board.id, board_ids)

    def test_requires_authentication(self):
        unauth_client = APIClient()
        r = unauth_client.get(f"/api/groups/{self.root.id}/descendant-boards/")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_non_member_cannot_access(self):
        self.client.force_authenticate(self.other)
        r = self._get(self.root.id)
        # Non-members get 404 because get_object() restricts to accessible group IDs.
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND])

    def test_response_includes_group_name_field(self):
        """Each board in the response must include the group_name field."""
        r = self._get(self.root.id)
        boards = r.json()
        for b in boards:
            self.assertIn("group_name", b, f"Board {b.get('id')} missing group_name field")

    def test_four_levels_deep(self):
        """Board nested 4 levels deep (root → child → grandchild → great-grandchild) is included."""
        great_grandchild = _make_group(self.owner, name="GreatGrandchild", parent=self.grandchild)
        deep_board = _make_board(self.owner, great_grandchild, name="Deep Board")
        r = self._get(self.root.id)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        board_ids = [b["id"] for b in r.json()]
        self.assertIn(deep_board.id, board_ids)
