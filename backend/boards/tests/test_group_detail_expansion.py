"""Tests for the ``?expand=group`` opt-in on Board / BoardFull (#817).

The existing ``group`` (FK id) and ``group_name`` fields must remain in the
default response shape for every 1.x release — removing either would break
the public contract. The nested ``group_detail`` object is additive and only
populated when the caller passes ``?expand=group``; the field is always
present in the response schema but defaults to ``None``.
"""

from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.db import connection
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Column, Swimlane
from groups.models import Group, GroupMembership


class GroupDetailExpansionTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner817", password="pass")
        self.parent_group = Group.objects.create(name="Parent Workspace", owner=self.owner)
        self.group = Group.objects.create(
            name="Engineering", owner=self.owner, parent=self.parent_group
        )
        GroupMembership.objects.create(
            group=self.group, user=self.owner, role=GroupMembership.Role.ADMIN
        )
        GroupMembership.objects.create(
            group=self.parent_group, user=self.owner, role=GroupMembership.Role.ADMIN
        )
        self.board = Board.objects.create(
            name="Grouped Board", owner=self.owner, group=self.group
        )
        BoardMembership.objects.create(
            board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN
        )
        Column.objects.create(board=self.board, name="Todo", position=0, allow_card_creation=True)
        Swimlane.objects.create(board=self.board, name="General", position=0)

        self.ungrouped = Board.objects.create(name="Personal", owner=self.owner)
        BoardMembership.objects.create(
            board=self.ungrouped, user=self.owner, role=BoardMembership.Role.ADMIN
        )

        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def test_list_default_shape_unchanged(self):
        """Default Board list must still return group (FK id) + group_name."""
        r = self.client.get("/api/v1/boards/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        board_payload = next(b for b in r.data["results"] if b["id"] == self.board.id)
        self.assertEqual(board_payload["group"], self.group.id)
        self.assertEqual(board_payload["group_name"], "Engineering")
        # group_detail is present in schema but None without ?expand=group.
        self.assertIsNone(board_payload["group_detail"])

    def test_list_expand_group_populates_detail(self):
        r = self.client.get("/api/v1/boards/?expand=group")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        board_payload = next(b for b in r.data["results"] if b["id"] == self.board.id)
        detail = board_payload["group_detail"]
        self.assertIsNotNone(detail)
        self.assertEqual(detail["id"], self.group.id)
        self.assertEqual(detail["name"], "Engineering")
        self.assertEqual(detail["parent"], self.parent_group.id)
        self.assertEqual(detail["parent_name"], "Parent Workspace")

    def test_list_expand_none_on_ungrouped_board(self):
        """Boards without a group still have group_detail=None even when expanded."""
        r = self.client.get("/api/v1/boards/?expand=group")
        payload = next(b for b in r.data["results"] if b["id"] == self.ungrouped.id)
        self.assertIsNone(payload["group"])
        self.assertIsNone(payload["group_name"])
        self.assertIsNone(payload["group_detail"])

    def test_full_default_shape_unchanged(self):
        r = self.client.get(f"/api/v1/boards/{self.board.id}/full/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.data["group"], self.group.id)
        self.assertEqual(r.data["group_name"], "Engineering")
        self.assertIsNone(r.data["group_detail"])

    def test_full_expand_group_populates_detail(self):
        r = self.client.get(f"/api/v1/boards/{self.board.id}/full/?expand=group")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        detail = r.data["group_detail"]
        self.assertEqual(detail["id"], self.group.id)
        self.assertEqual(detail["name"], "Engineering")
        self.assertEqual(detail["parent"], self.parent_group.id)
        self.assertEqual(detail["parent_name"], "Parent Workspace")

    def test_expand_csv_includes_group(self):
        """A comma-separated expand list must recognize `group` as a member."""
        r = self.client.get(f"/api/v1/boards/{self.board.id}/full/?expand=other,group")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIsNotNone(r.data["group_detail"])

    def test_expand_unrelated_does_not_populate_detail(self):
        """Unrelated expand values must not accidentally trigger the group branch."""
        r = self.client.get(f"/api/v1/boards/{self.board.id}/full/?expand=members")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIsNone(r.data["group_detail"])

    def test_list_with_expand_group_has_no_n_plus_one(self):
        """Adding more grouped boards must not add queries to the list response.

        GroupBriefSerializer reads ``group.parent.name``; without
        ``select_related("group__parent")`` on the viewset queryset, each
        additional grouped board would fire two extra queries (group + parent).
        """
        # Add several more grouped boards so a regression would show up as a
        # query-count explosion rather than a single stray query.
        for i in range(5):
            extra = Board.objects.create(
                name=f"Extra {i}", owner=self.owner, group=self.group
            )
            BoardMembership.objects.create(
                board=extra, user=self.owner, role=BoardMembership.Role.ADMIN
            )

        with CaptureQueriesContext(connection) as ctx_small:
            r = self.client.get("/api/v1/boards/?expand=group")
            self.assertEqual(r.status_code, status.HTTP_200_OK)
            _ = r.data["results"]

        baseline = len(ctx_small.captured_queries)

        # Add 10 more grouped boards and re-measure. Query count must stay flat.
        for i in range(10):
            extra = Board.objects.create(
                name=f"More {i}", owner=self.owner, group=self.group
            )
            BoardMembership.objects.create(
                board=extra, user=self.owner, role=BoardMembership.Role.ADMIN
            )

        with CaptureQueriesContext(connection) as ctx_big:
            r = self.client.get("/api/v1/boards/?expand=group")
            self.assertEqual(r.status_code, status.HTTP_200_OK)
            _ = r.data["results"]

        self.assertEqual(
            len(ctx_big.captured_queries),
            baseline,
            "?expand=group added queries when more grouped boards were present — "
            "select_related('group__parent') is missing.",
        )

    def test_group_detail_brief_does_not_leak_owner_or_counts(self):
        """GroupBriefSerializer is deliberately minimal — no owner / counts / labels.

        Keeping the inline payload tiny avoids adding N+1 or extra join cost
        to endpoints that only needed the FK id in the first place.
        """
        r = self.client.get(f"/api/v1/boards/{self.board.id}/full/?expand=group")
        detail = r.data["group_detail"]
        self.assertEqual(set(detail.keys()), {"id", "name", "parent", "parent_name"})
