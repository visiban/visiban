"""Who may set ``group`` through the generic board endpoints (#1655).

``POST /api/v1/boards/`` and ``PATCH``/``PUT /api/v1/boards/{id}/`` accept a
``group`` id. Placing a board in a group is restricted to admins of that group
(or of one of its ancestors) — the same rule as
``POST /api/v1/groups/{id}/boards/``. An unknown group id and a group the
caller does not administer get the same 400 body.
"""
from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership
from groups.models import Group, GroupMembership


class BoardGroupFieldTests(TestCase):
    def setUp(self):
        self.group_owner = User.objects.create_user(username="gowner", password="x")
        self.group = Group.objects.create(name="Team", owner=self.group_owner)
        GroupMembership.objects.create(
            group=self.group, user=self.group_owner, role=GroupMembership.Role.ADMIN
        )

        self.outsider = User.objects.create_user(username="outsider", password="x")
        self.viewer = User.objects.create_user(username="gviewer", password="x")
        self.member = User.objects.create_user(username="gmember", password="x")
        self.group_admin = User.objects.create_user(username="gadmin", password="x")
        GroupMembership.objects.create(
            group=self.group, user=self.viewer, role=GroupMembership.Role.VIEWER
        )
        GroupMembership.objects.create(
            group=self.group, user=self.member, role=GroupMembership.Role.MEMBER
        )
        GroupMembership.objects.create(
            group=self.group, user=self.group_admin, role=GroupMembership.Role.ADMIN
        )

    def _client(self, user):
        c = APIClient()
        c.force_authenticate(user)
        return c

    def _own_board(self, user, group=None):
        board = Board.objects.create(name="Mine", owner=user, group=group)
        BoardMembership.objects.create(board=board, user=user, role=BoardMembership.Role.ADMIN)
        return board

    # --- create -----------------------------------------------------------

    def _create(self, user, group_id):
        return self._client(user).post(
            "/api/v1/boards/", {"name": "B", "group": group_id}, format="json"
        )

    def test_create_with_group_rejected_for_non_member(self):
        r = self._create(self.outsider, self.group.id)
        self.assertEqual(r.status_code, 400)
        self.assertIn("group", r.data)
        self.assertFalse(Board.objects.filter(group=self.group).exists())

    def test_create_with_group_rejected_for_group_viewer(self):
        r = self._create(self.viewer, self.group.id)
        self.assertEqual(r.status_code, 400)
        self.assertFalse(Board.objects.filter(group=self.group).exists())

    def test_create_with_group_rejected_for_group_member(self):
        r = self._create(self.member, self.group.id)
        self.assertEqual(r.status_code, 400)
        self.assertFalse(Board.objects.filter(group=self.group).exists())

    def test_create_with_group_allowed_for_group_admin(self):
        r = self._create(self.group_admin, self.group.id)
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(r.data["group"], self.group.id)

    def test_create_with_group_allowed_for_ancestor_group_admin(self):
        child = Group.objects.create(name="Child", owner=self.group_owner, parent=self.group)
        r = self._create(self.group_admin, child.id)
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(r.data["group"], child.id)

    def test_create_with_group_allowed_for_site_admin(self):
        site_admin = User.objects.create_user(
            username="sadmin", password="x", can_access_all_content=True
        )
        r =self._create(site_admin, self.group.id)
        self.assertEqual(r.status_code, 201, r.data)

    def test_create_without_group_unchanged(self):
        r = self._client(self.outsider).post("/api/v1/boards/", {"name": "B"}, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        self.assertIsNone(r.data["group"])
        r = self._create(self.outsider, None)
        self.assertEqual(r.status_code, 201, r.data)
        self.assertIsNone(r.data["group"])

    def test_create_unknown_group_matches_inaccessible_group_response(self):
        missing_id = Group.objects.order_by("-pk").first().pk + 1000
        r_missing = self._create(self.outsider, missing_id)
        r_denied = self._create(self.outsider, self.group.id)
        self.assertEqual(r_missing.status_code, 400)
        self.assertEqual(r_denied.status_code, 400)
        self.assertEqual(r_missing.data, r_denied.data)

    def test_create_with_group_rejected_for_nav_only_ancestor_admin(self):
        # Administering a child gives navigation-only sight of its parent, which
        # is not standing to place a board there.
        child = Group.objects.create(name="Child", owner=self.group_owner, parent=self.group)
        child_admin = User.objects.create_user(username="childadmin", password="x")
        GroupMembership.objects.create(
            group=child, user=child_admin, role=GroupMembership.Role.ADMIN
        )
        r = self._create(child_admin, self.group.id)
        self.assertEqual(r.status_code, 400)
        self.assertIn("group", r.data)
        self.assertFalse(Board.objects.filter(group=self.group).exists())

    # --- update -----------------------------------------------------------

    def _patch(self, user, board, group_id):
        return self._client(user).patch(
            f"/api/v1/boards/{board.id}/", {"group": group_id}, format="json"
        )

    def test_update_group_rejected_for_non_member(self):
        board = self._own_board(self.outsider)
        r = self._patch(self.outsider, board, self.group.id)
        self.assertEqual(r.status_code, 400)
        board.refresh_from_db()
        self.assertIsNone(board.group_id)

    def test_update_group_rejected_for_group_viewer(self):
        board = self._own_board(self.viewer)
        r = self._patch(self.viewer, board, self.group.id)
        self.assertEqual(r.status_code, 400)
        board.refresh_from_db()
        self.assertIsNone(board.group_id)

    def test_update_group_rejected_for_group_member(self):
        board = self._own_board(self.member)
        r = self._patch(self.member, board, self.group.id)
        self.assertEqual(r.status_code, 400)
        board.refresh_from_db()
        self.assertIsNone(board.group_id)

    def test_update_group_allowed_for_group_admin(self):
        board = self._own_board(self.group_admin)
        r = self._patch(self.group_admin, board, self.group.id)
        self.assertEqual(r.status_code, 200, r.data)
        board.refresh_from_db()
        self.assertEqual(board.group_id, self.group.id)

    def test_update_unknown_group_matches_inaccessible_group_response(self):
        board = self._own_board(self.outsider)
        missing_id = Group.objects.order_by("-pk").first().pk + 1000
        r_missing = self._patch(self.outsider, board, missing_id)
        r_denied = self._patch(self.outsider, board, self.group.id)
        self.assertEqual(r_missing.status_code, 400)
        self.assertEqual(r_missing.data, r_denied.data)

    def test_update_resending_current_group_is_allowed(self):
        # A client that round-trips the board it read (PUT, or a PATCH that
        # echoes `group`) must keep working even when the caller is a board
        # admin but not a group admin: an unchanged value is not a move.
        board = self._own_board(self.group_owner, group=self.group)
        BoardMembership.objects.create(board=board, user=self.member, role=BoardMembership.Role.ADMIN)
        r = self._client(self.member).patch(
            f"/api/v1/boards/{board.id}/", {"name": "Renamed", "group": self.group.id}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.data)
        board.refresh_from_db()
        self.assertEqual(board.name, "Renamed")
        self.assertEqual(board.group_id, self.group.id)

    def test_update_detach_from_group_allowed_for_board_admin(self):
        # Detaching (group -> null) follows move-group: a board admin may do it.
        board = self._own_board(self.group_owner, group=self.group)
        BoardMembership.objects.create(board=board, user=self.member, role=BoardMembership.Role.ADMIN)
        r = self._patch(self.member, board, None)
        self.assertEqual(r.status_code, 200, r.data)
        board.refresh_from_db()
        self.assertIsNone(board.group_id)

    def test_update_without_group_unchanged(self):
        board = self._own_board(self.outsider)
        r = self._client(self.outsider).patch(
            f"/api/v1/boards/{board.id}/", {"name": "Other"}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.data)

    # --- group-scoped create ----------------------------------------------

    def test_group_boards_post_ignores_matching_body_group(self):
        r = self._client(self.group_admin).post(
            f"/api/v1/groups/{self.group.id}/boards/",
            {"name": "B", "group": self.group.id},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(r.data["group"], self.group.id)

    def test_group_boards_post_ignores_differing_body_group(self):
        # The path group decides placement; a different `group` in the body is
        # ignored, even one the caller does not administer.
        other = Group.objects.create(name="Other", owner=self.outsider)
        GroupMembership.objects.create(group=other, user=self.outsider, role=GroupMembership.Role.ADMIN)
        r = self._client(self.group_admin).post(
            f"/api/v1/groups/{self.group.id}/boards/",
            {"name": "B", "group": other.id},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(r.data["group"], self.group.id)
        self.assertFalse(Board.objects.filter(group=other).exists())

    # --- re-check under the board lock ------------------------------------

    def test_update_echo_rechecked_when_group_changed_before_lock(self):
        # The caller echoes the group it read. If the board's group changes
        # before the update takes the row lock, the value is now a move and
        # must pass the group-admin rule.
        from unittest.mock import patch

        from boards.views import boards as board_views

        board = self._own_board(self.group_owner, group=self.group)
        BoardMembership.objects.create(board=board, user=self.member, role=BoardMembership.Role.ADMIN)
        real_lock = board_views.lock_board_row_or_404

        def change_group_then_lock(b, *args, **kwargs):
            Board.objects.filter(pk=b.pk).update(group=None)
            return real_lock(b, *args, **kwargs)

        with patch.object(board_views, "lock_board_row_or_404", side_effect=change_group_then_lock):
            r = self._client(self.member).patch(
                f"/api/v1/boards/{board.id}/", {"name": "Renamed", "group": self.group.id}, format="json"
            )
        self.assertEqual(r.status_code, 400, r.data)
        self.assertEqual(str(r.data["group"][0]), "Unknown group, or you are not an admin of it.")
        # Nothing from the PATCH was written. (The simulated concurrent change
        # ran inside the request's transaction here, so it rolls back with it.)
        board.refresh_from_db()
        self.assertEqual(board.name, "Mine")

    def test_recheck_group_under_lock_allows_group_admin(self):
        from rest_framework.test import APIRequestFactory

        from boards.serializers import BoardSerializer

        board = self._own_board(self.group_admin, group=self.group)
        request = APIRequestFactory().patch("/")
        request.user = self.group_admin
        ser = BoardSerializer(board, data={"group": self.group.id}, partial=True, context={"request": request})
        self.assertTrue(ser.is_valid(), ser.errors)
        board.group = None  # as if re-read under the lock after a detach
        ser.recheck_group_under_lock(board)  # does not raise

        request.user = self.member
        ser = BoardSerializer(board, data={"group": None}, partial=True, context={"request": request})
        self.assertTrue(ser.is_valid(), ser.errors)
        ser.recheck_group_under_lock(board)  # null is always accepted
