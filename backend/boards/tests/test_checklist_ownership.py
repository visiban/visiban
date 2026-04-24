"""Tests for CardChecklist ownership gate (#692).

Covers:
- created_by is set to request.user when a checklist item is created
- collaborators may only edit/delete items they created
- collaborators cannot edit/delete items created by others
- admins and moderators can edit/delete any item
- null created_by (pre-migration rows) is unrestricted for backward compat
"""
from unittest.mock import patch

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, CardChecklist, Column, Swimlane,
)


PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"


def _make_board(owner):
    board = Board.objects.create(name="B", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Todo", position=0, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col, swim


def _make_card(board, col, swim, user):
    return Card.objects.create(
        board=board, column=col, swimlane=swim,
        title="Card", created_by=user, position=0,
    )


def _make_item(card, user, text="Item"):
    return CardChecklist.objects.create(card=card, text=text, position=0, created_by=user)


class ChecklistCreatedByTests(TestCase):
    """created_by is populated when a checklist item is created via the API."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, self.col, self.swim = _make_board(self.owner)
        self.card = _make_card(self.board, self.col, self.swim, self.owner)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        self.url = f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/checklist/"

    @patch(PATCH_BROADCAST)
    def test_created_by_set_on_post(self, _):
        r = self.client.post(self.url, {"text": "Do something"})
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        item = CardChecklist.objects.get(card=self.card)
        self.assertEqual(item.created_by, self.owner)

    @patch(PATCH_BROADCAST)
    def test_created_by_id_not_in_response(self, _):
        r = self.client.post(self.url, {"text": "Do something"})
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertNotIn("created_by_id", r.json())


class ChecklistOwnershipGateTests(TestCase):
    """Collaborators can only edit/delete items they created."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.collab = User.objects.create_user(username="collab", password="pass")
        self.other = User.objects.create_user(username="other", password="pass")
        self.board, self.col, self.swim = _make_board(self.owner)
        BoardMembership.objects.create(
            board=self.board, user=self.collab, role=BoardMembership.Role.COLLABORATOR
        )
        BoardMembership.objects.create(
            board=self.board, user=self.other, role=BoardMembership.Role.COLLABORATOR
        )
        self.card = _make_card(self.board, self.col, self.swim, self.owner)
        self.client = APIClient()

    def _item_url(self, item_pk):
        return f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/checklist/{item_pk}/"

    @patch(PATCH_BROADCAST)
    def test_collab_can_delete_own_item(self, _):
        item = _make_item(self.card, self.collab)
        self.client.force_authenticate(self.collab)
        r = self.client.delete(self._item_url(item.pk))
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(CardChecklist.objects.filter(pk=item.pk).exists())

    def test_collab_cannot_delete_others_item(self):
        item = _make_item(self.card, self.other)
        self.client.force_authenticate(self.collab)
        r = self.client.delete(self._item_url(item.pk))
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertTrue(CardChecklist.objects.filter(pk=item.pk).exists())

    @patch(PATCH_BROADCAST)
    def test_collab_can_patch_own_item(self, _):
        item = _make_item(self.card, self.collab)
        self.client.force_authenticate(self.collab)
        r = self.client.patch(self._item_url(item.pk), {"text": "Updated"})
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_collab_cannot_patch_others_item(self):
        item = _make_item(self.card, self.other)
        self.client.force_authenticate(self.collab)
        r = self.client.patch(self._item_url(item.pk), {"text": "Hacked"})
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    @patch(PATCH_BROADCAST)
    def test_admin_can_delete_any_item(self, _):
        item = _make_item(self.card, self.collab)
        self.client.force_authenticate(self.owner)  # owner is admin
        r = self.client.delete(self._item_url(item.pk))
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)

    @patch(PATCH_BROADCAST)
    def test_admin_can_patch_any_item(self, _):
        item = _make_item(self.card, self.collab)
        self.client.force_authenticate(self.owner)
        r = self.client.patch(self._item_url(item.pk), {"text": "Admin edit"})
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    @patch(PATCH_BROADCAST)
    def test_null_created_by_is_unrestricted(self, _):
        """Pre-migration items with null created_by must not be blocked for any collaborator."""
        item = CardChecklist.objects.create(card=self.card, text="Legacy", position=0)
        # created_by is None — backward-compat: any collaborator+ may edit/delete
        self.client.force_authenticate(self.collab)
        r = self.client.delete(self._item_url(item.pk))
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
