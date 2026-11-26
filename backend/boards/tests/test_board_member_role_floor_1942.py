"""An explicit board membership row cannot sit below a group-derived admin role (#1942).

Mirrors the board owner guard (#1828): a request that would store a role below
``admin`` for a user whose group membership already gives them ``admin`` on the
board is refused with a 400 carrying ``code: group_admin_role_floor``. Nothing
is written and no event is recorded.
"""
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardEvent, BoardMembership
from boards.permissions import get_board_role, group_derived_board_role
from boards.views.boards import GROUP_ADMIN_FLOOR_CODE
from groups.models import Group, GroupMembership


class BoardMemberRoleFloorTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board_admin = User.objects.create_user(username="badmin", password="pass")
        self.group_admin = User.objects.create_user(username="gadmin", password="pass")
        self.group_member = User.objects.create_user(username="gmember", password="pass")
        self.group = Group.objects.create(name="G", owner=self.owner)
        GroupMembership.objects.create(group=self.group, user=self.group_admin, role=GroupMembership.Role.ADMIN)
        GroupMembership.objects.create(group=self.group, user=self.group_member, role=GroupMembership.Role.MEMBER)
        self.board = Board.objects.create(name="B", owner=self.owner, group=self.group)
        BoardMembership.objects.create(board=self.board, user=self.board_admin, role=BoardMembership.Role.ADMIN)
        self.client = APIClient()
        self.client.force_authenticate(self.board_admin)
        self.url = f"/api/v1/boards/{self.board.id}/members/"

    def _post(self, user, **body):
        return self.client.post(self.url, {"user_id": user.id, **body}, format="json")

    def _events(self):
        return BoardEvent.objects.filter(board_id=self.board.id).count()

    def _role(self, user):
        return get_board_role(user, Board.objects.get(pk=self.board.pk))

    def test_new_row_below_admin_is_refused(self):
        before = self._events()
        for role in ("member", "collaborator", "viewer"):
            with self.subTest(role=role):
                r = self._post(self.group_admin, role=role)
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertEqual(r.json()["code"], GROUP_ADMIN_FLOOR_CODE)
        self.assertFalse(BoardMembership.objects.filter(board=self.board, user=self.group_admin).exists())
        self.assertEqual(self._events(), before)
        self.assertEqual(self._role(self.group_admin), "admin")

    def test_omitted_role_defaults_to_member_and_is_refused(self):
        r = self._post(self.group_admin)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(r.json()["code"], GROUP_ADMIN_FLOOR_CODE)

    def test_new_admin_row_is_allowed(self):
        r = self._post(self.group_admin, role="admin")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)

    def test_existing_row_cannot_be_lowered(self):
        row = BoardMembership.objects.create(
            board=self.board, user=self.group_admin, role=BoardMembership.Role.ADMIN
        )
        r = self._post(self.group_admin, role="viewer")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        row.refresh_from_db()
        self.assertEqual(row.role, "admin")

    def test_stored_lower_row_can_be_raised_and_left_alone(self):
        # A row stored before the floor existed: raising it is fine, and a
        # request that names no role or the same role is not a demotion.
        row = BoardMembership.objects.create(
            board=self.board, user=self.group_admin, role=BoardMembership.Role.VIEWER
        )
        self.assertEqual(self._post(self.group_admin, role="viewer").status_code, status.HTTP_200_OK)
        self.assertEqual(self._post(self.group_admin, is_moderator=False).status_code, status.HTTP_200_OK)
        self.assertEqual(self._post(self.group_admin, role="admin").status_code, status.HTTP_200_OK)
        row.refresh_from_db()
        self.assertEqual(row.role, "admin")

    def test_stored_lower_row_can_be_removed_to_restore_group_role(self):
        BoardMembership.objects.create(board=self.board, user=self.group_admin, role=BoardMembership.Role.VIEWER)
        r = self.client.delete(f"{self.url}{self.group_admin.id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(self._role(self.group_admin), "admin")

    def test_group_member_can_still_get_an_explicit_lower_role(self):
        r = self._post(self.group_member, role="viewer")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertEqual(self._role(self.group_member), "viewer")

    def test_site_admin_caller_is_bound_by_the_floor_too(self):
        site_admin = User.objects.create_user(
            username="sa", password="pass", is_site_admin=True, can_access_all_content=True
        )
        self.client.force_authenticate(site_admin)
        r = self._post(self.group_admin, role="viewer")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(r.json()["code"], GROUP_ADMIN_FLOOR_CODE)

    def test_ancestor_group_admin_is_covered(self):
        child = Group.objects.create(name="child", owner=self.owner, parent=self.group)
        self.board.group = child
        self.board.save()
        r = self._post(self.group_admin, role="viewer")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)


class GroupDerivedRoleAbsentInputTests(TestCase):
    """The guard denies on what it can resolve and never trips on what it cannot (#1075)."""

    def setUp(self):
        self.owner = User.objects.create_user(username="o", password="pass")
        self.user = User.objects.create_user(username="u", password="pass")

    def test_board_without_group_has_no_group_derived_role(self):
        board = Board.objects.create(name="B", owner=self.owner)
        self.assertIsNone(group_derived_board_role(self.user, board))

    def test_user_outside_the_group_has_none(self):
        group = Group.objects.create(name="G", owner=self.owner)
        board = Board.objects.create(name="B", owner=self.owner, group=group)
        self.assertIsNone(group_derived_board_role(self.user, board))

    def test_board_without_group_allows_any_explicit_role(self):
        board = Board.objects.create(name="B", owner=self.owner)
        BoardMembership.objects.create(board=board, user=self.owner, role="admin")
        client = APIClient()
        client.force_authenticate(self.owner)
        r = client.post(
            f"/api/v1/boards/{board.id}/members/", {"user_id": self.user.id, "role": "viewer"}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)


class TrelloImportFloorTests(TestCase):
    def test_matched_group_admin_gets_no_direct_row(self):
        from boards.services.trello_import import ImportPlan, execute_plan

        owner = User.objects.create_user(username="o2", password="pass")
        gadmin = User.objects.create_user(username="ga2", password="pass")
        other = User.objects.create_user(username="ot2", password="pass")
        group = Group.objects.create(name="G2", owner=owner)
        GroupMembership.objects.create(group=group, user=owner, role=GroupMembership.Role.ADMIN)
        GroupMembership.objects.create(group=group, user=gadmin, role=GroupMembership.Role.ADMIN)
        plan = ImportPlan(
            board_name="T", board_description="", columns=[{"key": "c", "name": "C", "position": 0}],
            labels=[], swimlanes=[], cards=[], checklist_items={}, comments=[],
            member_user_ids=[gadmin.pk, other.pk], preview={},
        )
        board = execute_plan(plan, owner, group=group)
        self.assertFalse(BoardMembership.objects.filter(board=board, user=gadmin).exists())
        self.assertEqual(get_board_role(gadmin, board), "admin")
        self.assertTrue(BoardMembership.objects.filter(board=board, user=other, role="member").exists())
