"""Tests for the optional TTL on Board.share_token (#804).

Covers:
- Enabling sharing without expires_in_days leaves share_token_expires_at null
- Enabling with expires_in_days sets share_token_expires_at to ~now+N days
- Invalid expires_in_days values are rejected with 400
- Disabling sharing clears both the token and the expiry
- Past-expiry public share endpoint returns 410 Gone (not 404)
- Future-expiry public share endpoint still returns 200
- Admin sees share_token_expires_at in BoardFullSerializer; non-admins do not
"""

from datetime import timedelta

from django.test import TestCase
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership


def _make_board(owner, name="TTL Board"):
    board = Board.objects.create(name=name, owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    return board


class EnableShareTtlTests(TestCase):
    """POST /api/v1/boards/{id}/share/ accepts an optional expires_in_days param."""

    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="pass")
        self.board = _make_board(self.admin)
        self.client_admin = APIClient()
        self.client_admin.force_authenticate(self.admin)

    def _enable_url(self):
        return f"/api/v1/boards/{self.board.id}/share/"

    def test_no_expiry_when_param_omitted(self):
        r = self.client_admin.post(self._enable_url())
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIsNone(r.data.get("share_token_expires_at"))
        self.board.refresh_from_db()
        self.assertIsNone(self.board.share_token_expires_at)

    def test_no_expiry_when_param_explicitly_null(self):
        r = self.client_admin.post(self._enable_url(), data={"expires_in_days": None}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIsNone(r.data.get("share_token_expires_at"))

    def test_seven_day_expiry_persists(self):
        before = timezone.now()
        r = self.client_admin.post(
            self._enable_url(), data={"expires_in_days": 7}, format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIsNotNone(r.data["share_token_expires_at"])
        self.board.refresh_from_db()
        self.assertIsNotNone(self.board.share_token_expires_at)
        delta = self.board.share_token_expires_at - before
        # Allow a generous bound for clock skew during the test.
        self.assertGreater(delta, timedelta(days=7) - timedelta(seconds=10))
        self.assertLess(delta, timedelta(days=7) + timedelta(seconds=10))

    def test_thirty_day_expiry_accepted(self):
        r = self.client_admin.post(
            self._enable_url(), data={"expires_in_days": 30}, format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_ninety_day_expiry_accepted(self):
        r = self.client_admin.post(
            self._enable_url(), data={"expires_in_days": 90}, format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_arbitrary_day_count_rejected(self):
        r = self.client_admin.post(
            self._enable_url(), data={"expires_in_days": 14}, format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_non_integer_rejected(self):
        r = self.client_admin.post(
            self._enable_url(), data={"expires_in_days": "soon"}, format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_disable_clears_both_token_and_expiry(self):
        self.client_admin.post(
            self._enable_url(), data={"expires_in_days": 7}, format="json",
        )
        self.board.refresh_from_db()
        self.assertIsNotNone(self.board.share_token)
        self.assertIsNotNone(self.board.share_token_expires_at)

        r = self.client_admin.delete(self._enable_url())
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIsNone(r.data.get("share_token_expires_at"))
        self.board.refresh_from_db()
        self.assertIsNone(self.board.share_token)
        self.assertIsNone(self.board.share_token_expires_at)

    def test_re_enable_after_disable_starts_with_no_expiry(self):
        """Re-enabling without expires_in_days should not inherit a stale TTL."""
        self.client_admin.post(self._enable_url(), data={"expires_in_days": 7}, format="json")
        self.client_admin.delete(self._enable_url())
        r = self.client_admin.post(self._enable_url())
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIsNone(r.data.get("share_token_expires_at"))


class PublicShareExpiryTests(TestCase):
    """GET /api/share/<token>/ honours share_token_expires_at."""

    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="pass")
        self.board = _make_board(self.admin)
        self.client_admin = APIClient()
        self.client_admin.force_authenticate(self.admin)
        r = self.client_admin.post(f"/api/v1/boards/{self.board.id}/share/")
        self.token = r.data["share_token"]
        self.anon = APIClient()

    def _url(self):
        return f"/api/share/{self.token}/"

    def test_no_expiry_returns_200(self):
        r = self.anon.get(self._url())
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_future_expiry_returns_200(self):
        self.board.share_token_expires_at = timezone.now() + timedelta(days=7)
        self.board.save(update_fields=["share_token_expires_at"])
        r = self.anon.get(self._url())
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_past_expiry_returns_410(self):
        self.board.share_token_expires_at = timezone.now() - timedelta(seconds=1)
        self.board.save(update_fields=["share_token_expires_at"])
        r = self.anon.get(self._url())
        self.assertEqual(r.status_code, status.HTTP_410_GONE)

    def test_expired_response_does_not_leak_board_data(self):
        self.board.share_token_expires_at = timezone.now() - timedelta(days=1)
        self.board.save(update_fields=["share_token_expires_at"])
        r = self.anon.get(self._url())
        self.assertEqual(r.status_code, status.HTTP_410_GONE)
        # The 410 body must not contain the board name, columns, or any
        # other board state — only an explanatory message.
        self.assertNotIn("name", r.data)
        self.assertNotIn("columns", r.data)
        self.assertNotIn("cards", r.data)


class ShareTokenExpiresAtSerializerTests(TestCase):
    """share_token_expires_at in BoardFullSerializer is admin-only (mirrors share_token)."""

    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="pass")
        self.member = User.objects.create_user(username="member", password="pass")
        self.board = _make_board(self.admin)
        BoardMembership.objects.create(
            board=self.board, user=self.member, role=BoardMembership.Role.MEMBER,
        )
        self.client_admin = APIClient()
        self.client_admin.force_authenticate(self.admin)
        self.client_member = APIClient()
        self.client_member.force_authenticate(self.member)

        self.client_admin.post(
            f"/api/v1/boards/{self.board.id}/share/",
            data={"expires_in_days": 7},
            format="json",
        )

    def test_admin_sees_expires_at(self):
        r = self.client_admin.get(f"/api/v1/boards/{self.board.id}/full/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIn("share_token_expires_at", r.data)
        self.assertIsNotNone(r.data["share_token_expires_at"])

    def test_member_sees_null_expires_at(self):
        r = self.client_member.get(f"/api/v1/boards/{self.board.id}/full/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        # Field is still present (so frontend types stay stable) but value is null.
        self.assertIn("share_token_expires_at", r.data)
        self.assertIsNone(r.data["share_token_expires_at"])
