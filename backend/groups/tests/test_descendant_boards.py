"""Tests for the GET /api/groups/{id}/descendant-boards/ endpoint.

Verifies that boards in groups nested 3+ levels deep are returned, that the
response is scoped to what the requesting user is allowed to see, and that
boards from the root group itself are included.
"""
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board
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
        return self.client.get(f"/api/v1/groups/{group_id}/descendant-boards/")

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
        r = unauth_client.get(f"/api/v1/groups/{self.root.id}/descendant-boards/")
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)

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

    # ------------------------------------------------------------------
    # #845 — ancestors in group_detail for full relative breadcrumb
    # ------------------------------------------------------------------

    def test_group_detail_includes_ancestors_root_first(self):
        """Each board response includes group_detail.ancestors (root-first)."""
        r = self._get(self.root.id)
        boards = {b["id"]: b for b in r.json()}

        grandchild_payload = boards[self.grandchild_board.id]
        self.assertIsNotNone(grandchild_payload.get("group_detail"))
        ancestors = grandchild_payload["group_detail"]["ancestors"]
        # Root-first: [root, child]; the board's own group (grandchild) is NOT
        # in the ancestors list — it is the subject.
        self.assertEqual([a["name"] for a in ancestors], ["Root", "Child"])
        self.assertEqual([a["id"] for a in ancestors], [self.root.id, self.child.id])

    def test_group_detail_ancestors_empty_for_root_level_board(self):
        """A board whose group has no parent returns ancestors=[]."""
        # The root_board lives in self.root which has parent=None.
        r = self._get(self.root.id)
        boards = {b["id"]: b for b in r.json()}
        self.assertEqual(boards[self.root_board.id]["group_detail"]["ancestors"], [])

    def test_descendant_boards_ancestors_avoids_n_plus_1(self):
        """Resolving ancestors for many boards must not scale per-board.

        Uses 50 boards so any per-board FK lookup (ancestors walk or the
        parent_name join) would clearly exceed the constant-query budget.
        """
        for i in range(50):
            _make_board(self.owner, self.grandchild, name=f"Extra {i}")

        from django.test.utils import CaptureQueriesContext
        from django.db import connection

        # Warm any first-request caches (session, user lookup).
        self._get(self.root.id)

        with CaptureQueriesContext(connection) as ctx:
            r = self._get(self.root.id)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        # With the bulk ancestor map (#845) and ``group__parent`` joined in
        # the boards queryset, query count is bounded regardless of how many
        # boards are returned. A per-board FK lookup would push this well
        # past the threshold at 50+ boards.
        self.assertLess(
            len(ctx.captured_queries),
            25,
            msg=f"Descendant boards endpoint issued {len(ctx.captured_queries)} "
                f"queries for 53 boards — ancestor / parent_name N+1 regression "
                f"suspected.",
        )
