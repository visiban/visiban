"""``import_summary.skipped.assignees`` counts unmatched assignees (#2198).

A card or checklist item whose ``assignee`` names nobody in the importer's
visible pool (security invariants Rule 5) imports unassigned; the count says
how many did, for JSON and CSV imports alike.
"""
import io
import json

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, CardChecklist

URL = "/api/v1/boards/import/"


class ImportSkippedAssigneesTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="importer", password="pass")
        self.mate = User.objects.create_user(username="mate", password="pass")
        # "outsider" exists but shares nothing with the importer.
        User.objects.create_user(username="outsider", password="pass")
        shared = Board.objects.create(name="Shared", owner=self.user)
        BoardMembership.objects.create(board=shared, user=self.user, role=BoardMembership.Role.ADMIN)
        BoardMembership.objects.create(board=shared, user=self.mate)
        self.client.force_authenticate(self.user)

    def _json(self, cards, options=None):
        data = {
            "name": "Imp",
            "columns": [{"name": "Todo", "position": 0}],
            "swimlanes": [{"name": "General", "position": 0}],
            "labels": [],
            "cards": cards,
        }
        f = io.BytesIO(json.dumps(data).encode())
        f.name = "board.json"
        payload = {"file": f}
        if options is not None:
            payload["options"] = json.dumps(options)
        resp = self.client.post(URL, payload, format="multipart")
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.content)
        return resp

    @staticmethod
    def _card(title, assignee=None, checklist=()):
        return {
            "title": title, "column": "Todo", "swimlane": "General", "position": 0,
            "assignee": assignee, "checklist": list(checklist),
        }

    def test_counts_unmatched_card_and_checklist_assignees(self):
        resp = self._json([
            self._card("A", "MATE", [{"text": "x", "assignee": "mate"}, {"text": "y", "assignee": "outsider"}]),
            self._card("B", "nobody", [{"text": "z", "assignee": "ghost"}, {"text": "w"}]),
            self._card("C"),
        ])
        self.assertEqual(resp.data["import_summary"]["skipped"]["assignees"], 3)
        board_id = resp.data["id"]
        self.assertEqual(Card.objects.get(board_id=board_id, title="A").assignee, self.mate)
        self.assertIsNone(Card.objects.get(board_id=board_id, title="B").assignee)
        self.assertEqual(
            CardChecklist.objects.filter(card__board_id=board_id, assignee__isnull=False).count(), 1,
        )

    def test_all_matched_reports_zero(self):
        resp = self._json([self._card("A", "mate", [{"text": "x", "assignee": "importer"}])])
        self.assertEqual(resp.data["import_summary"]["skipped"]["assignees"], 0)

    def test_checklist_option_off_does_not_count_checklist_assignees(self):
        resp = self._json(
            [self._card("A", None, [{"text": "x", "assignee": "ghost"}])], options={"checklist": False},
        )
        skipped = resp.data["import_summary"]["skipped"]
        self.assertEqual(skipped["assignees"], 0)
        self.assertEqual(skipped["checklist_items"], 1)

    def test_cards_option_off_counts_nothing(self):
        resp = self._json([self._card("A", "ghost", [{"text": "x", "assignee": "ghost"}])], options={"cards": False})
        self.assertEqual(resp.data["import_summary"]["skipped"]["assignees"], 0)

    def test_csv_counts_unmatched_card_assignees(self):
        csv_text = "Title,Column,Swimlane,Assignee\nA,Todo,General,mate\nB,Todo,General,outsider\nC,Todo,General,\n"
        f = io.BytesIO(csv_text.encode())
        f.name = "board.csv"
        resp = self.client.post(URL, {"file": f}, format="multipart")
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.content)
        self.assertEqual(resp.data["import_summary"]["skipped"]["assignees"], 1)
