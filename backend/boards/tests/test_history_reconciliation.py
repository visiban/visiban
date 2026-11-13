"""The history reconciler agrees with the real API (#1889).

``history_reconciliation.history_problems`` is what the seed and sample tests
hold every seeded card to. These tests make a card the way a person does,
through the API endpoints, and require the reconciler to find nothing wrong:
so the forms it expects are the forms the API writes, not ones the seeders
invented. Then they break that history one way at a time and require the
reconciler to say so.
"""

from unittest.mock import patch

from django.db import transaction
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Card, CardActivity, CardChecklist, CardComment, CardMovement, Column, Label, Swimlane,
)
from boards.tests.conftest import _make_board
from boards.tests.history_reconciliation import history_problems


@override_settings(DEMO_MODE=False)  # the demo fence would refuse the comment and PATCH writes
class ApiMadeCardReconcilesTests(TestCase):
    def setUp(self):
        patcher = patch("boards.broadcast.broadcast_board_event")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.user = User.objects.create_user(username="maker", password="pass")
        self.other = User.objects.create_user(username="helper", password="pass")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.board = _make_board(self.user)
        self.board.memberships.create(user=self.other, role="member")
        self.todo = Column.objects.create(board=self.board, name="To Do", position=0, allow_card_creation=True)
        self.doing = Column.objects.create(board=self.board, name="Doing", position=1)
        self.won = Column.objects.create(board=self.board, name="Won", position=2, is_done=True)
        self.lost = Column.objects.create(board=self.board, name="Lost", position=3, is_done=True)
        self.lane = Swimlane.objects.create(board=self.board, name="Acme", position=0)
        self.bug = Label.objects.create(board=self.board, name="Bug", color="#EF4444")
        self.ux = Label.objects.create(board=self.board, name="UX", color="#3B82F6")
        self.base = f"/api/v1/boards/{self.board.pk}/cards/"

    def _ok(self, resp, code=200):
        self.assertEqual(resp.status_code, code, getattr(resp, "data", None))
        return resp

    def _make_card(self):
        resp = self._ok(self.client.post(self.base, {
            "title": "Draft", "description": "Body", "column": self.todo.pk, "swimlane": self.lane.pk,
        }, format="json"), 201)
        card_id = resp.data["id"]
        url = f"{self.base}{card_id}/"
        self._ok(self.client.patch(url, {
            "title": "Final title", "priority": "high", "weight": 3, "due_date": "2030-01-15",
            "assignee_id": self.other.pk, "label_ids": [self.bug.pk, self.ux.pk],
        }, format="json"))
        self._ok(self.client.patch(url, {"label_ids": [self.ux.pk], "priority": "urgent"}, format="json"))
        first = self._ok(self.client.post(f"{url}checklist/", {"text": "Write it"}, format="json"), 201)
        self._ok(self.client.post(f"{url}checklist/", {"text": "Ship it"}, format="json"), 201)
        self._ok(self.client.patch(f"{url}checklist/{first.data['id']}/", {"is_checked": True}, format="json"))
        self._ok(self.client.patch(f"{url}checklist/{first.data['id']}/", {
            "assignee_id": self.other.pk, "due_date": "2030-02-01",
        }, format="json"))
        self._ok(self.client.post(f"{url}comments/", {"body": "Looks good"}, format="json"), 201)
        self._ok(self.client.post(f"{url}move/", {
            "column_id": self.doing.pk, "swimlane_id": self.lane.pk, "position": 0,
        }, format="json"))
        self._ok(self.client.post(f"{url}move/", {
            "column_id": self.won.pk, "swimlane_id": self.lane.pk, "position": 0,
        }, format="json"))
        self._ok(self.client.post(f"{url}archive/", format="json"))
        return Card.objects.get(pk=card_id)

    def test_a_card_made_through_the_api_is_fully_explained(self):
        card = self._make_card()
        self.assertEqual(history_problems(card), [])

    def test_every_missing_or_wrong_entry_is_reported(self):
        card = self._make_card()
        cases = {
            "label UX has no +UX activity": lambda: CardActivity.objects.filter(
                card=card, event_type="label_change").delete(),
            "assignee helper has no assignee_change": lambda: CardActivity.objects.filter(
                card=card, event_type="assignee_change").delete(),
            "priority urgent has no priority_change": lambda: CardActivity.objects.filter(
                card=card, event_type="priority_change").delete(),
            "weight 3 has no weight_change": lambda: CardActivity.objects.filter(
                card=card, event_type="weight_change").delete(),
            "due date 2030-01-15 has no due_date_change": lambda: CardActivity.objects.filter(
                card=card, event_type="due_date_change").delete(),
            "checklist item 'Write it' is checked=True": lambda: CardActivity.objects.filter(
                card=card, event_type="checklist_item_checked").delete(),
            "checklist item 'Ship it' has no checklist_item_added": lambda: CardActivity.objects.filter(
                card=card, event_type="checklist_item_added", to_value="Ship it").delete(),
            "comment_added times do not match": lambda: CardActivity.objects.filter(
                card=card, event_type="comment_added").delete(),
            "archived state does not match": lambda: CardMovement.objects.filter(
                card=card, movement_type="archived").delete(),
            "first movement is not a creation": lambda: CardMovement.objects.filter(
                card=card, from_column__isnull=True).delete(),
            "is outside the card's life": lambda: CardComment.objects.filter(card=card).update(
                created_at=card.created_at.replace(year=2000)),
            "is not the creation movement's actor": lambda: Card.objects.filter(pk=card.pk).update(
                created_by=self.other),
            "was created by someone its history does not credit": lambda: CardChecklist.objects.filter(
                card=card, text="Ship it").update(created_by=self.other),
        }
        for expected, breaker in cases.items():
            with self.subTest(expected):
                # Each case breaks one thing, inside a savepoint that is rolled
                # back so the next case starts from the intact card.
                sid = transaction.savepoint()
                breaker()
                problems = history_problems(Card.objects.get(pk=card.pk))
                transaction.savepoint_rollback(sid)
                self.assertTrue(any(expected in p for p in problems), problems)

    def test_a_lost_deal_that_passed_through_won_is_reported(self):
        card = self._make_card()
        self._ok(self.client.post(f"{self.base}{card.pk}/unarchive/", format="json"))
        self._ok(self.client.post(f"{self.base}{card.pk}/move/", {
            "column_id": self.lost.pk, "swimlane_id": self.lane.pk, "position": 0,
        }, format="json"))
        problems = history_problems(Card.objects.get(pk=card.pk))
        self.assertIn("passed through outcome Won on the way to Lost", problems)

    def test_a_checklist_assignee_or_due_date_without_history_is_reported(self):
        card = self._make_card()
        self.assertEqual(history_problems(card), [])
        card.activities.filter(event_type="checklist_item_assigned").delete()
        card.activities.filter(event_type="checklist_item_due_changed").delete()
        problems = history_problems(Card.objects.get(pk=card.pk))
        self.assertTrue(any("is assigned to helper but has no checklist_item_assigned" in p for p in problems), problems)
        self.assertTrue(any("is due 2030-02-01 but has no checklist_item_due_changed" in p for p in problems), problems)
