"""Tests for group-scoped WebSocket broadcasts (#753).

Covers: perform_create, perform_update, destroy, move_group (old + new group),
GroupViewSet.boards POST — each must fire broadcast_group_event via
transaction.on_commit() with event types board.created / board.updated /
board.deleted on the appropriate group channels.
"""
from unittest.mock import patch

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership
from groups.models import Group, GroupMembership


def _make_group(owner, name="G", parent=None):
    group = Group.objects.create(name=name, owner=owner, parent=parent)
    GroupMembership.objects.create(
        group=group, user=owner, role=GroupMembership.Role.ADMIN
    )
    return group


def _make_board(owner, group=None, name="B"):
    board = Board.objects.create(name=name, owner=owner, group=group)
    BoardMembership.objects.create(
        board=board, user=owner, role=BoardMembership.Role.ADMIN
    )
    return board


class GroupBroadcastWiringTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="owner", password="pass")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.group = _make_group(self.user)

    def _group_broadcast_calls(self, mock):
        return [c.args for c in mock.call_args_list]

    def test_boards_post_fires_group_broadcast_on_commit(self):
        """POST /groups/<id>/boards/ must fire broadcast_group_event(board.created)."""
        with patch("groups.views.transaction.on_commit") as mock_on_commit, \
             patch("groups.broadcast.broadcast_group_event") as mock_group:
            # The view sets a nested import of broadcast_group_event inside the
            # closure, so patching groups.broadcast.broadcast_group_event suffices.
            # on_commit is patched to run the callback synchronously.
            mock_on_commit.side_effect = lambda fn: fn()
            resp = self.client.post(
                f"/api/v1/groups/{self.group.id}/boards/",
                {"name": "Live Board"},
            )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        called = self._group_broadcast_calls(mock_group)
        self.assertTrue(any(args[1] == "board.created" and args[0] == self.group.id for args in called))

    def test_board_create_in_group_fires_group_broadcast(self):
        """POST /boards/ with group=<id> fires broadcast_group_event(board.created)."""
        with patch("boards.views.boards.transaction.on_commit") as mock_on_commit, \
             patch("boards.views.boards._broadcast_group_event") as mock_group:
            mock_on_commit.side_effect = lambda fn: fn()
            resp = self.client.post(
                "/api/v1/boards/", {"name": "X", "group": self.group.id}
            )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        called = self._group_broadcast_calls(mock_group)
        self.assertTrue(any(args[0] == self.group.id and args[1] == "board.created" for args in called))

    def test_board_create_without_group_does_not_broadcast_group_event(self):
        """Personal (no-group) board create must NOT trigger a group broadcast."""
        with patch("boards.views.boards.transaction.on_commit") as mock_on_commit, \
             patch("boards.views.boards._broadcast_group_event") as mock_group:
            mock_on_commit.side_effect = lambda fn: fn()
            resp = self.client.post("/api/v1/boards/", {"name": "Solo"})
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        mock_group.assert_not_called()

    def test_board_update_fires_group_broadcast(self):
        board = _make_board(self.user, group=self.group)
        with patch("boards.views.boards.transaction.on_commit") as mock_on_commit, \
             patch("boards.views.boards._broadcast_group_event") as mock_group:
            mock_on_commit.side_effect = lambda fn: fn()
            resp = self.client.patch(
                f"/api/v1/boards/{board.id}/", {"name": "Renamed"}
            )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        called = self._group_broadcast_calls(mock_group)
        self.assertTrue(any(args[0] == self.group.id and args[1] == "board.updated" for args in called))

    def test_board_delete_fires_group_broadcast(self):
        board = _make_board(self.user, group=self.group)
        with patch("boards.views.boards.transaction.on_commit") as mock_on_commit, \
             patch("boards.views.boards._broadcast_group_event") as mock_group:
            mock_on_commit.side_effect = lambda fn: fn()
            resp = self.client.delete(f"/api/v1/boards/{board.id}/")
        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        called = self._group_broadcast_calls(mock_group)
        self.assertTrue(any(args[0] == self.group.id and args[1] == "board.deleted" for args in called))

    def test_move_group_fans_out_to_old_and_new_groups(self):
        """A board moved between groups fires board.deleted on the old and
        board.created on the new — in a single on_commit callback."""
        other_group = _make_group(self.user, name="Other")
        board = _make_board(self.user, group=self.group)
        with patch("boards.views.boards.transaction.on_commit") as mock_on_commit, \
             patch("boards.views.boards._broadcast_group_event") as mock_group:
            mock_on_commit.side_effect = lambda fn: fn()
            resp = self.client.post(
                f"/api/v1/boards/{board.id}/move-group/",
                {"group_id": other_group.id},
            )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        # move_group registers exactly one on_commit callback so the old/new
        # broadcasts are atomic from a subscriber's perspective.
        self.assertEqual(mock_on_commit.call_count, 1)
        called = self._group_broadcast_calls(mock_group)
        self.assertTrue(any(args[0] == self.group.id and args[1] == "board.deleted" for args in called))
        self.assertTrue(any(args[0] == other_group.id and args[1] == "board.created" for args in called))

    def test_broadcast_deferred_until_commit(self):
        """Group broadcast must not fire inside the transaction — clients would
        otherwise see state that could still roll back."""
        with patch("boards.views.boards._broadcast_group_event") as mock_group:
            with self.captureOnCommitCallbacks(execute=False):
                resp = self.client.post(
                    "/api/v1/boards/", {"name": "X", "group": self.group.id}
                )
            self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
            mock_group.assert_not_called()
