"""Tests for is_moderator entitlement and export role restriction (#362)."""
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Column, Swimlane


def _make_board(owner):
    board = Board.objects.create(name="Board", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col, swim


class ExportRoleRestrictionTests(TestCase):
    """Viewers and collaborators must not be able to export board data."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, _, _ = _make_board(self.owner)
        self.client = APIClient()

    def _add_member(self, username, role):
        user = User.objects.create_user(username=username, password="pass")
        BoardMembership.objects.create(board=self.board, user=user, role=role)
        return user

    def test_viewer_cannot_export(self):
        viewer = self._add_member("viewer", BoardMembership.Role.VIEWER)
        self.client.force_authenticate(viewer)
        r = self.client.get(f"/api/v1/boards/{self.board.id}/export/")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertIn("member or admin", r.data["detail"])

    def test_collaborator_cannot_export(self):
        collab = self._add_member("collab", BoardMembership.Role.COLLABORATOR)
        self.client.force_authenticate(collab)
        r = self.client.get(f"/api/v1/boards/{self.board.id}/export/")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_member_can_export(self):
        member = self._add_member("member", BoardMembership.Role.MEMBER)
        self.client.force_authenticate(member)
        r = self.client.get(f"/api/v1/boards/{self.board.id}/export/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_admin_can_export(self):
        self.client.force_authenticate(self.owner)
        r = self.client.get(f"/api/v1/boards/{self.board.id}/export/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_site_admin_can_export(self):
        sa = User.objects.create_user(username="sa", password="pass")
        sa.is_site_admin = True
        sa.can_access_all_content = True
        sa.save()
        self.client.force_authenticate(sa)
        r = self.client.get(f"/api/v1/boards/{self.board.id}/export/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)


class IsModeratorFieldTests(TestCase):
    """The is_moderator flag on BoardMembership."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, _, _ = _make_board(self.owner)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        self.member_user = User.objects.create_user(username="member", password="pass")
        BoardMembership.objects.create(
            board=self.board, user=self.member_user, role=BoardMembership.Role.MEMBER
        )

    def test_is_moderator_defaults_to_false(self):
        m = BoardMembership.objects.get(board=self.board, user=self.member_user)
        self.assertFalse(m.is_moderator)

    def test_is_moderator_in_serializer_response(self):
        r = self.client.get(f"/api/v1/boards/{self.board.id}/full/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        members = r.data["members"]
        member_data = next(m for m in members if m["user"]["id"] == self.member_user.id)
        self.assertIn("is_moderator", member_data)
        self.assertFalse(member_data["is_moderator"])

    def test_admin_can_toggle_moderator(self):
        r = self.client.post(
            f"/api/v1/boards/{self.board.id}/members/",
            {"user_id": self.member_user.id, "role": "member", "is_moderator": True},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertTrue(r.data["is_moderator"])
        m = BoardMembership.objects.get(board=self.board, user=self.member_user)
        self.assertTrue(m.is_moderator)

    def test_admin_can_revoke_moderator(self):
        BoardMembership.objects.filter(board=self.board, user=self.member_user).update(is_moderator=True)
        r = self.client.post(
            f"/api/v1/boards/{self.board.id}/members/",
            {"user_id": self.member_user.id, "role": "member", "is_moderator": False},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertFalse(r.data["is_moderator"])

    def test_collaborator_cannot_be_moderator(self):
        r = self.client.post(
            f"/api/v1/boards/{self.board.id}/members/",
            {"user_id": self.member_user.id, "role": "collaborator", "is_moderator": True},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("Moderator entitlement", r.data["detail"])

    def test_viewer_cannot_be_moderator(self):
        r = self.client.post(
            f"/api/v1/boards/{self.board.id}/members/",
            {"user_id": self.member_user.id, "role": "viewer", "is_moderator": True},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_demoting_to_collaborator_clears_moderator(self):
        BoardMembership.objects.filter(board=self.board, user=self.member_user).update(is_moderator=True)
        r = self.client.post(
            f"/api/v1/boards/{self.board.id}/members/",
            {"user_id": self.member_user.id, "role": "collaborator"},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertFalse(r.data["is_moderator"])

    def test_demoting_to_viewer_clears_moderator(self):
        BoardMembership.objects.filter(board=self.board, user=self.member_user).update(is_moderator=True)
        r = self.client.post(
            f"/api/v1/boards/{self.board.id}/members/",
            {"user_id": self.member_user.id, "role": "viewer"},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertFalse(r.data["is_moderator"])

    def test_non_admin_cannot_toggle_moderator(self):
        other = User.objects.create_user(username="other", password="pass")
        BoardMembership.objects.create(board=self.board, user=other, role=BoardMembership.Role.MEMBER)
        client = APIClient()
        client.force_authenticate(other)
        r = client.post(
            f"/api/v1/boards/{self.board.id}/members/",
            {"user_id": self.member_user.id, "role": "member", "is_moderator": True},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
