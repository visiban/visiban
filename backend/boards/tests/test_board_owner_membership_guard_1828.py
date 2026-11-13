"""The board owner's membership cannot be removed or demoted over REST (#1828).

``get_board_role`` grants the owner admin through ``Board.owner`` whatever their
membership row says, so deleting or lowering that row used to answer 204/200
while changing nothing the owner could do and hiding them from the roster.
Groups refuse the same request (#1722, #1787); boards now do too, with a 400
carrying ``code: board_owner_protected``.
"""
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardEvent, BoardMembership
from boards.views.boards import BOARD_OWNER_PROTECTED_CODE, BOARD_OWNER_PROTECTED_MESSAGE

_REFUSAL = {"detail": BOARD_OWNER_PROTECTED_MESSAGE, "code": BOARD_OWNER_PROTECTED_CODE}


class BoardOwnerMembershipGuardTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.admin = User.objects.create_user(username="admin", password="pass")
        self.viewer = User.objects.create_user(username="viewer", password="pass")
        self.site_admin = User.objects.create_user(
            username="siteadmin", password="pass", is_site_admin=True, can_access_all_content=True
        )
        self.other = User.objects.create_user(username="other", password="pass")
        self.board = Board.objects.create(name="B", owner=self.owner)
        self.owner_row = BoardMembership.objects.create(
            board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN
        )
        BoardMembership.objects.create(board=self.board, user=self.admin, role=BoardMembership.Role.ADMIN)
        BoardMembership.objects.create(board=self.board, user=self.viewer, role=BoardMembership.Role.VIEWER)
        BoardMembership.objects.create(board=self.board, user=self.other, role=BoardMembership.Role.ADMIN)
        self.client = APIClient()
        self.members_url = f"/api/v1/boards/{self.board.id}/members/"
        self.owner_url = f"/api/v1/boards/{self.board.id}/members/{self.owner.id}/"

    def _events(self):
        return BoardEvent.objects.filter(board_id=self.board.id).count()

    # --- DELETE -------------------------------------------------------------

    def test_admin_cannot_remove_owner(self):
        self.client.force_authenticate(self.admin)
        before = self._events()
        r = self.client.delete(self.owner_url)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(r.json(), _REFUSAL)
        self.assertTrue(BoardMembership.objects.filter(pk=self.owner_row.pk).exists())
        self.assertEqual(self._events(), before, "a refused removal records no member.removed event")

    def test_site_admin_cannot_remove_owner(self):
        self.client.force_authenticate(self.site_admin)
        r = self.client.delete(self.owner_url)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(r.json()["code"], BOARD_OWNER_PROTECTED_CODE)
        self.assertTrue(BoardMembership.objects.filter(pk=self.owner_row.pk).exists())

    def test_owner_cannot_remove_own_membership(self):
        self.client.force_authenticate(self.owner)
        r = self.client.delete(self.owner_url)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(r.json()["code"], BOARD_OWNER_PROTECTED_CODE)

    def test_viewer_gets_403_not_the_owner_refusal(self):
        """The role check still runs first: a caller below admin learns nothing."""
        self.client.force_authenticate(self.viewer)
        r = self.client.delete(self.owner_url)
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_other_admin_can_still_be_removed(self):
        self.client.force_authenticate(self.admin)
        r = self.client.delete(f"/api/v1/boards/{self.board.id}/members/{self.other.id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)

    # --- POST (role change) -------------------------------------------------

    def test_owner_cannot_be_demoted(self):
        self.client.force_authenticate(self.admin)
        for role in (
            BoardMembership.Role.MEMBER,
            BoardMembership.Role.COLLABORATOR,
            BoardMembership.Role.VIEWER,
        ):
            with self.subTest(role=role):
                before = self._events()
                r = self.client.post(
                    self.members_url, {"user_id": self.owner.id, "role": role}, format="json"
                )
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertEqual(r.json(), _REFUSAL)
                self.owner_row.refresh_from_db()
                self.assertEqual(self.owner_row.role, BoardMembership.Role.ADMIN)
                self.assertEqual(self._events(), before)

    def test_site_admin_cannot_demote_owner(self):
        self.client.force_authenticate(self.site_admin)
        r = self.client.post(
            self.members_url, {"user_id": self.owner.id, "role": "viewer"}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(r.json()["code"], BOARD_OWNER_PROTECTED_CODE)

    def test_setting_owner_to_admin_is_accepted(self):
        self.client.force_authenticate(self.admin)
        r = self.client.post(
            self.members_url, {"user_id": self.owner.id, "role": "admin"}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_moderator_only_change_on_owner_is_accepted(self):
        """No ``role`` keeps the stored role, so it is not a demotion."""
        self.client.force_authenticate(self.admin)
        r = self.client.post(
            self.members_url, {"user_id": self.owner.id, "is_moderator": True}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.owner_row.refresh_from_db()
        self.assertEqual(self.owner_row.role, BoardMembership.Role.ADMIN)
        self.assertTrue(self.owner_row.is_moderator)

    def test_owner_with_lower_legacy_row_keeps_it_on_a_roleless_request(self):
        """A lower stored row (Django admin, pre-1.3 API) is left as is, not refused."""
        BoardMembership.objects.filter(pk=self.owner_row.pk).update(role=BoardMembership.Role.MEMBER)
        self.client.force_authenticate(self.admin)
        r = self.client.post(
            self.members_url, {"user_id": self.owner.id, "is_moderator": False}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        # ...and it can be raised back to admin.
        r = self.client.post(
            self.members_url, {"user_id": self.owner.id, "role": "admin"}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.owner_row.refresh_from_db()
        self.assertEqual(self.owner_row.role, BoardMembership.Role.ADMIN)

    def test_owner_without_row_cannot_be_added_below_admin(self):
        """A missing owner row (removed before 1.3) can only come back as admin."""
        self.owner_row.delete()
        self.client.force_authenticate(self.admin)
        r = self.client.post(self.members_url, {"user_id": self.owner.id}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(r.json()["code"], BOARD_OWNER_PROTECTED_CODE)
        self.assertFalse(BoardMembership.objects.filter(board=self.board, user=self.owner).exists())
        r = self.client.post(
            self.members_url, {"user_id": self.owner.id, "role": "admin"}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)

    def test_other_member_can_still_be_demoted(self):
        self.client.force_authenticate(self.admin)
        r = self.client.post(
            self.members_url, {"user_id": self.other.id, "role": "viewer"}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
