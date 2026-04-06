"""Tests for the external read-only board share-link feature (#348).

Covers:
- Enable/disable share actions (admin-only, 403 for non-admin)
- Public endpoint 200 on valid token
- Public endpoint 404 on revoked or missing token
- PII absent from public payload (no email, no user id in nested user objects)
- Comments absent from public card payload
- Token regeneration: old token 404, new token 200
"""

import json

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Column, Swimlane, Card, CardComment


def _make_board(owner, name="Test Board"):
    board = Board.objects.create(name=name, owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    return board


def _make_member(board, username, role=BoardMembership.Role.MEMBER):
    user = User.objects.create_user(username=username, password="pass")
    BoardMembership.objects.create(board=board, user=user, role=role)
    return user


class EnableDisableShareTests(TestCase):
    """POST /api/boards/{id}/share/ and DELETE /api/boards/{id}/share/."""

    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="pass")
        self.board = _make_board(self.admin)
        self.member = _make_member(self.board, "member_user")
        self.viewer = _make_member(self.board, "viewer_user", role=BoardMembership.Role.VIEWER)

        self.admin_client = APIClient()
        self.admin_client.force_authenticate(self.admin)

        self.member_client = APIClient()
        self.member_client.force_authenticate(self.member)

        self.viewer_client = APIClient()
        self.viewer_client.force_authenticate(self.viewer)

    def _enable_url(self):
        return f"/api/v1/boards/{self.board.id}/share/"

    # --- Enable ---

    def test_admin_can_enable_sharing(self):
        r = self.admin_client.post(self._enable_url())
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIn("share_token", r.data)
        self.assertIn("share_url", r.data)
        self.assertIsNotNone(r.data["share_token"])

    def test_enable_share_persists_token_to_db(self):
        self.admin_client.post(self._enable_url())
        self.board.refresh_from_db()
        self.assertIsNotNone(self.board.share_token)

    def test_member_cannot_enable_sharing(self):
        r = self.member_client.post(self._enable_url())
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_401_UNAUTHORIZED])

    def test_viewer_cannot_enable_sharing(self):
        r = self.viewer_client.post(self._enable_url())
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_401_UNAUTHORIZED])

    def test_anonymous_cannot_enable_sharing(self):
        anon = APIClient()
        r = anon.post(self._enable_url())
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_401_UNAUTHORIZED])

    def test_regenerate_returns_new_token(self):
        r1 = self.admin_client.post(self._enable_url())
        token1 = r1.data["share_token"]
        r2 = self.admin_client.post(self._enable_url())
        token2 = r2.data["share_token"]
        self.assertNotEqual(token1, token2)

    # --- Disable ---

    def test_admin_can_disable_sharing(self):
        self.admin_client.post(self._enable_url())
        r = self.admin_client.delete(self._enable_url())
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIsNone(r.data["share_token"])

    def test_disable_share_clears_db_token(self):
        self.admin_client.post(self._enable_url())
        self.admin_client.delete(self._enable_url())
        self.board.refresh_from_db()
        self.assertIsNone(self.board.share_token)

    def test_member_cannot_disable_sharing(self):
        self.admin_client.post(self._enable_url())
        r = self.member_client.delete(self._enable_url())
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_401_UNAUTHORIZED])


class PublicBoardEndpointTests(TestCase):
    """GET /api/share/<token>/ — public endpoint behaviour."""

    def setUp(self):
        self.admin = User.objects.create_user(
            username="admin", password="pass", email="admin@example.com"
        )
        self.board = _make_board(self.admin)

        self.col = Column.objects.create(board=self.board, name="Todo", position=0)
        self.lane = Swimlane.objects.create(
            board=self.board, name="Customer A",
            contact_email="customer@example.com", notes="Private notes",
            position=0,
        )
        self.assignee = User.objects.create_user(
            username="worker", password="pass", email="worker@example.com"
        )
        self.card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.lane,
            title="My card", priority="medium", assignee=self.assignee,
            created_by=self.admin, position=0,
        )
        CardComment.objects.create(
            card=self.card, author=self.admin, body="This is a secret comment",
        )

        admin_client = APIClient()
        admin_client.force_authenticate(self.admin)
        r = admin_client.post(f"/api/v1/boards/{self.board.id}/share/")
        self.token = r.data["share_token"]

        self.anon = APIClient()

    def _url(self, token=None):
        return f"/api/share/{token or self.token}/"

    def test_valid_token_returns_200(self):
        r = self.anon.get(self._url())
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_missing_token_returns_404(self):
        import uuid
        r = self.anon.get(self._url(str(uuid.uuid4())))
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)

    def test_garbage_token_returns_404(self):
        r = self.anon.get(self._url("not-a-valid-token"))
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)

    # --- PII checks ---

    def test_no_email_in_response(self):
        r = self.anon.get(self._url())
        body = json.dumps(r.data)
        self.assertNotIn("@example.com", body)
        self.assertNotIn("email", body)

    def test_no_user_id_in_nested_user_objects(self):
        """Assignee and moved_by must not expose numeric user PKs."""
        r = self.anon.get(self._url())
        # Recurse through response to find any nested user-like dict with an 'id' key
        def _find_ids_in_users(data):
            if isinstance(data, dict):
                # If it looks like a user object (has display_name but also id), that's a leak
                if "display_name" in data and "id" in data:
                    return True
                return any(_find_ids_in_users(v) for v in data.values())
            if isinstance(data, list):
                return any(_find_ids_in_users(item) for item in data)
            return False

        self.assertFalse(_find_ids_in_users(r.data))

    def test_assignee_display_name_only(self):
        r = self.anon.get(self._url())
        card = next(c for c in r.data["cards"] if c["title"] == "My card")
        assignee = card["assignee"]
        self.assertIn("display_name", assignee)
        self.assertNotIn("id", assignee)
        self.assertNotIn("username", assignee)
        self.assertNotIn("email", assignee)

    def test_no_comments_in_public_card_payload(self):
        r = self.anon.get(self._url())
        card = next(c for c in r.data["cards"] if c["title"] == "My card")
        self.assertNotIn("comments", card)
        body = json.dumps(r.data)
        self.assertNotIn("secret comment", body)

    def test_swimlane_contact_email_absent(self):
        """contact_email and notes must not appear in the public swimlane payload."""
        r = self.anon.get(self._url())
        for lane in r.data["swimlanes"]:
            self.assertNotIn("contact_email", lane)
            self.assertNotIn("notes", lane)

    def test_members_list_absent(self):
        r = self.anon.get(self._url())
        self.assertNotIn("members", r.data)

    def test_view_only_badge_fields_present(self):
        """Board name and uid present so the frontend can render the header."""
        r = self.anon.get(self._url())
        self.assertIn("name", r.data)
        self.assertIn("uid", r.data)

    # --- Revocation ---

    def test_revoked_token_returns_404(self):
        admin_client = APIClient()
        admin_client.force_authenticate(self.admin)
        admin_client.delete(f"/api/v1/boards/{self.board.id}/share/")
        r = self.anon.get(self._url())
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)

    def test_old_token_404_after_regeneration_new_token_200(self):
        admin_client = APIClient()
        admin_client.force_authenticate(self.admin)
        old_token = self.token

        r2 = admin_client.post(f"/api/v1/boards/{self.board.id}/share/")
        new_token = r2.data["share_token"]

        # Old token must be gone
        r_old = self.anon.get(self._url(old_token))
        self.assertEqual(r_old.status_code, status.HTTP_404_NOT_FOUND)

        # New token must work
        r_new = self.anon.get(self._url(new_token))
        self.assertEqual(r_new.status_code, status.HTTP_200_OK)


class ShareTokenInBoardFullTests(TestCase):
    """share_token field in BoardFullSerializer is admin-only."""

    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="pass")
        self.member = User.objects.create_user(username="member", password="pass")
        self.board = _make_board(self.admin)
        BoardMembership.objects.create(board=self.board, user=self.member, role=BoardMembership.Role.MEMBER)

        self.admin_client = APIClient()
        self.admin_client.force_authenticate(self.admin)

        self.member_client = APIClient()
        self.member_client.force_authenticate(self.member)

        # Enable sharing
        self.admin_client.post(f"/api/v1/boards/{self.board.id}/share/")

    def test_admin_sees_share_token_in_full_response(self):
        r = self.admin_client.get(f"/api/v1/boards/{self.board.id}/full/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIn("share_token", r.data)
        self.assertIsNotNone(r.data["share_token"])

    def test_member_sees_null_share_token_in_full_response(self):
        r = self.member_client.get(f"/api/v1/boards/{self.board.id}/full/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIn("share_token", r.data)
        self.assertIsNone(r.data["share_token"])
