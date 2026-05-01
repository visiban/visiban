"""Regression tests for the Wave 4 pre-release audit fixes (#920–#930, #952).

Each test class is named after the issue it guards against and contains the
minimal assertions needed to prevent the original bug from re-emerging.
"""

from unittest.mock import patch

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Column, Swimlane
from groups.models import Group, GroupMembership


class IsModeratorVisibilityTests(TestCase):
    """#920 — moderator status must not leak to non-admin board members."""

    def setUp(self):
        self.admin = User.objects.create_user(username="adm", password="x")
        self.viewer = User.objects.create_user(username="view", password="x")
        self.member = User.objects.create_user(username="mem", password="x")
        self.board = Board.objects.create(name="B", owner=self.admin)
        BoardMembership.objects.create(board=self.board, user=self.admin, role=BoardMembership.Role.ADMIN)
        BoardMembership.objects.create(
            board=self.board, user=self.member, role=BoardMembership.Role.MEMBER, is_moderator=True,
        )
        BoardMembership.objects.create(board=self.board, user=self.viewer, role=BoardMembership.Role.VIEWER)
        Column.objects.create(board=self.board, name="C", position=0)
        Swimlane.objects.create(board=self.board, name="L", position=0)
        self.client = APIClient()

    def _members_response(self, requester):
        self.client.force_authenticate(requester)
        r = self.client.get(f"/api/v1/boards/{self.board.id}/full/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        return r.data["members"]

    def test_admin_sees_is_moderator_field(self):
        members = self._members_response(self.admin)
        moderator_row = next(m for m in members if m["user"]["id"] == self.member.id)
        self.assertIn("is_moderator", moderator_row)
        self.assertTrue(moderator_row["is_moderator"])

    def test_viewer_does_not_see_is_moderator_field(self):
        members = self._members_response(self.viewer)
        for row in members:
            self.assertNotIn(
                "is_moderator", row,
                f"Viewer must not see is_moderator (#920); leaked on row {row}",
            )

    def test_member_does_not_see_is_moderator_field(self):
        members = self._members_response(self.member)
        for row in members:
            self.assertNotIn(
                "is_moderator", row,
                f"Member must not see is_moderator (#920); leaked on row {row}",
            )


class JsonImportTopLevelTypeValidationTests(TestCase):
    """#921 — malformed top-level keys must return 400, not 500."""

    def setUp(self):
        self.user = User.objects.create_user(username="imp", password="x")
        self.user.is_site_admin = True
        self.user.save(update_fields=["is_site_admin"])
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _import(self, payload_dict):
        import io
        import json
        f = io.BytesIO(json.dumps(payload_dict).encode("utf-8"))
        f.name = "board.json"
        return self.client.post(
            "/api/v1/boards/import/",
            {"file": f},
            format="multipart",
        )

    def test_cards_as_string_returns_400(self):
        r = self._import({"name": "B", "columns": [{"name": "c"}], "swimlanes": [{"name": "s"}], "cards": "not a list"})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("must be a list", str(r.data).lower())

    def test_columns_as_int_returns_400(self):
        r = self._import({"name": "B", "columns": 5, "swimlanes": [{"name": "s"}]})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_labels_as_dict_returns_400(self):
        r = self._import({"name": "B", "columns": [{"name": "c"}], "swimlanes": [{"name": "s"}], "labels": {"k": "v"}})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)


class StarChangedCrossChannelBroadcastTests(TestCase):
    """#952 — board.star_changed must fan out to the group channel when the
    board belongs to a group, in addition to the board channel."""

    def setUp(self):
        self.user = User.objects.create_user(username="starusr", password="x")
        self.group = Group.objects.create(name="G", owner=self.user)
        GroupMembership.objects.create(group=self.group, user=self.user, role=GroupMembership.Role.ADMIN)
        self.board = Board.objects.create(name="B", owner=self.user, group=self.group)
        BoardMembership.objects.create(board=self.board, user=self.user, role=BoardMembership.Role.ADMIN)
        Column.objects.create(board=self.board, name="C", position=0)
        Swimlane.objects.create(board=self.board, name="L", position=0)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_star_fires_on_both_board_and_group_channels(self):
        with patch("boards.broadcast.broadcast_board_event") as mock_board, \
             patch("boards.views.boards._broadcast_group_event") as mock_group:
            with self.captureOnCommitCallbacks(execute=True):
                r = self.client.post(f"/api/v1/boards/{self.board.id}/star/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        board_events = [c.args[1] for c in mock_board.call_args_list]
        group_events = [c.args[1] for c in mock_group.call_args_list]
        self.assertIn("board.star_changed", board_events)
        self.assertIn("board.star_changed", group_events)

    def test_star_on_groupless_board_does_not_fire_group_event(self):
        groupless = Board.objects.create(name="Solo", owner=self.user)
        BoardMembership.objects.create(board=groupless, user=self.user, role=BoardMembership.Role.ADMIN)
        Column.objects.create(board=groupless, name="C", position=0)
        Swimlane.objects.create(board=groupless, name="L", position=0)
        with patch("boards.views.boards._broadcast_group_event") as mock_group:
            with self.captureOnCommitCallbacks(execute=True):
                r = self.client.post(f"/api/v1/boards/{groupless.id}/star/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        # The board belongs to no group, so no group-channel event must fire.
        self.assertFalse(any(c.args[1] == "board.star_changed" for c in mock_group.call_args_list))
