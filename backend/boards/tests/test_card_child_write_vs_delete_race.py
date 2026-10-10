"""A card-child write racing a delete of its card answers 404, not 500 (#1584).

Deterministic interleaving, no sleeps: the card is deleted (on the request's own
connection, inside its transaction) at the moment the shared refetch builds its
query, i.e. after the write but before the card is re-read.
"""

from unittest.mock import patch

from rest_framework.test import APITestCase

from accounts.models import User
from boards.models import (
    Board, BoardEvent, BoardMembership, Card, CardActivity, CardChecklist,
    CardComment, Column, Swimlane,
)
from boards.serializers import _card_queryset as _real_card_queryset


class CardChildWriteVsDeleteRaceTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="racer1584", password="pass")
        self.board = Board.objects.create(name="B", owner=self.user)
        BoardMembership.objects.create(
            board=self.board, user=self.user, role=BoardMembership.Role.ADMIN,
        )
        col = Column.objects.create(board=self.board, name="A", position=0)
        swim = Swimlane.objects.create(board=self.board, name="G", position=0)
        self.card = Card.objects.create(
            board=self.board, column=col, swimlane=swim, title="C",
            created_by=self.user, position=0,
        )
        self.item = CardChecklist.objects.create(
            card=self.card, text="todo", created_by=self.user, position=0,
        )
        self.client.force_authenticate(self.user)
        self.base = f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}"

    def _delete_card_on_refetch(self):
        pk = self.card.pk

        def racing(qs):
            Card.objects.filter(pk=pk).delete()
            return _real_card_queryset(qs)

        return patch("boards.views._helpers._card_queryset", side_effect=racing)

    def test_checklist_patch_returns_404(self):
        events_before = BoardEvent.objects.count()
        with self._delete_card_on_refetch():
            resp = self.client.patch(
                f"{self.base}/checklist/{self.item.pk}/", {"is_checked": True}, format="json",
            )
        self.assertEqual(resp.status_code, 404)
        self.assertEqual(BoardEvent.objects.count(), events_before)

    def test_checklist_delete_returns_404(self):
        with self._delete_card_on_refetch():
            resp = self.client.delete(f"{self.base}/checklist/{self.item.pk}/")
        self.assertEqual(resp.status_code, 404)

    def test_comment_create_returns_404_and_rolls_back(self):
        with self._delete_card_on_refetch():
            resp = self.client.post(f"{self.base}/comments/", {"body": "hi"}, format="json")
        self.assertEqual(resp.status_code, 404)
        self.assertEqual(CardComment.objects.count(), 0)
        self.assertEqual(CardActivity.objects.filter(
            event_type=CardActivity.EventType.COMMENT_ADDED).count(), 0)

    def test_unraced_checklist_patch_still_200(self):
        resp = self.client.patch(
            f"{self.base}/checklist/{self.item.pk}/", {"is_checked": True}, format="json",
        )
        self.assertEqual(resp.status_code, 200)
