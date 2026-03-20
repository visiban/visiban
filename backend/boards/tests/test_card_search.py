"""Tests for server-side card search via ?search= query parameter on CardViewSet."""
from unittest.mock import patch

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, Column, Swimlane


PATCH_BROADCAST = "boards.views.broadcast_board_event"


def _make_board(owner, name="Test Board"):
    board = Board.objects.create(name=name, owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col, swim


def _make_card(board, col, swim, user, title="Card", description=""):
    return Card.objects.create(
        board=board, column=col, swimlane=swim,
        title=title, description=description, created_by=user, position=0,
    )


class CardSearchTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, self.swim = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _url(self):
        return f"/api/boards/{self.board.id}/cards/"

    @patch(PATCH_BROADCAST)
    def test_search_by_title_returns_match(self, _):
        _make_card(self.board, self.col, self.swim, self.user, title="Fix the login bug")
        _make_card(self.board, self.col, self.swim, self.user, title="Update readme")

        r = self.client.get(self._url(), {"search": "login"})

        self.assertEqual(r.status_code, status.HTTP_200_OK)
        titles = [c["title"] for c in r.json()]
        self.assertIn("Fix the login bug", titles)
        self.assertNotIn("Update readme", titles)

    @patch(PATCH_BROADCAST)
    def test_search_by_description_returns_match(self, _):
        _make_card(self.board, self.col, self.swim, self.user, title="Card A", description="OAuth token refresh")
        _make_card(self.board, self.col, self.swim, self.user, title="Card B", description="No relevant content")

        r = self.client.get(self._url(), {"search": "token"})

        self.assertEqual(r.status_code, status.HTTP_200_OK)
        titles = [c["title"] for c in r.json()]
        self.assertIn("Card A", titles)
        self.assertNotIn("Card B", titles)

    @patch(PATCH_BROADCAST)
    def test_search_is_board_scoped(self, _):
        """Cards from other boards must not appear in search results."""
        other_user = User.objects.create_user(username="other", password="pass")
        other_board, other_col, other_swim = _make_board(other_user, name="Other Board")
        # Add the test user as a viewer on the other board so they could access it,
        # but the search on self.board should never return cards from other_board.
        BoardMembership.objects.create(board=other_board, user=self.user, role=BoardMembership.Role.VIEWER)

        _make_card(self.board, self.col, self.swim, self.user, title="Shared keyword card")
        _make_card(other_board, other_col, other_swim, other_user, title="Shared keyword card other")

        r = self.client.get(self._url(), {"search": "Shared keyword"})

        self.assertEqual(r.status_code, status.HTTP_200_OK)
        ids = {c["id"] for c in r.json()}
        # Only the card belonging to self.board should appear.
        for card_data in r.json():
            card = Card.objects.get(id=card_data["id"])
            self.assertEqual(card.board_id, self.board.id)
        self.assertEqual(len(ids), 1)

    @patch(PATCH_BROADCAST)
    def test_empty_search_returns_all_cards(self, _):
        """?search= with an empty string must not filter — return all cards."""
        _make_card(self.board, self.col, self.swim, self.user, title="Alpha")
        _make_card(self.board, self.col, self.swim, self.user, title="Beta")
        _make_card(self.board, self.col, self.swim, self.user, title="Gamma")

        r = self.client.get(self._url(), {"search": ""})

        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(len(r.json()), 3)

    @patch(PATCH_BROADCAST)
    def test_no_search_param_returns_all_cards(self, _):
        """Omitting ?search= entirely must return all cards (regression guard)."""
        _make_card(self.board, self.col, self.swim, self.user, title="Alpha")
        _make_card(self.board, self.col, self.swim, self.user, title="Beta")

        r = self.client.get(self._url())

        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(len(r.json()), 2)

    @patch(PATCH_BROADCAST)
    def test_search_is_case_insensitive(self, _):
        """Title and description search must match regardless of case."""
        _make_card(self.board, self.col, self.swim, self.user, title="OAuth Integration", description="")
        _make_card(self.board, self.col, self.swim, self.user, title="Unrelated", description="oauth details here")

        r_upper = self.client.get(self._url(), {"search": "OAUTH"})
        r_lower = self.client.get(self._url(), {"search": "oauth"})
        r_mixed = self.client.get(self._url(), {"search": "OAuth"})

        for r in (r_upper, r_lower, r_mixed):
            self.assertEqual(r.status_code, status.HTTP_200_OK)
            titles = {c["title"] for c in r.json()}
            self.assertIn("OAuth Integration", titles)
            self.assertIn("Unrelated", titles)

    @patch(PATCH_BROADCAST)
    def test_search_excludes_archived_cards(self, _):
        """Archived cards must not appear in search results."""
        from django.utils import timezone
        active = _make_card(self.board, self.col, self.swim, self.user, title="Active searchable card")
        archived = _make_card(self.board, self.col, self.swim, self.user, title="Archived searchable card")
        archived.archived_at = timezone.now()
        archived.save(update_fields=["archived_at"])

        r = self.client.get(self._url(), {"search": "searchable"})

        self.assertEqual(r.status_code, status.HTTP_200_OK)
        titles = [c["title"] for c in r.json()]
        self.assertIn("Active searchable card", titles)
        self.assertNotIn("Archived searchable card", titles)
