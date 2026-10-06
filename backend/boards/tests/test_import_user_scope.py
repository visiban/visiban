"""Imported usernames resolve only against users visible to the importer (#1434)."""
import io
import json

from django.core.cache import cache
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, CardActivity, CardMovement
from groups.models import Group, GroupMembership

URL = "/api/v1/boards/import/"


def _file(data):
    f = io.BytesIO(json.dumps(data).encode("utf-8"))
    f.name = "board.json"
    return f


def _payload(card_count=1, assignee="seen", mover="seen", actor="seen"):
    cards = []
    for i in range(card_count):
        cards.append({
            "title": f"Card {i}", "column": "To Do", "swimlane": "General",
            "assignee": assignee, "position": i,
            "movements": [{"from_column": "To Do", "to_column": "To Do", "moved_by": mover}],
            "activities": [{"event_type": "weight_change", "from_value": "1", "to_value": "2", "actor": actor}],
        })
    return {
        "name": "Scoped",
        "columns": [{"name": "To Do", "position": 0}],
        "swimlanes": [{"name": "General", "position": 0}],
        "labels": [],
        "cards": cards,
    }


class ImportUserScopeTests(TestCase):
    def setUp(self):
        cache.clear()
        self.importer = User.objects.create_user(username="importer", password="x")
        self.seen = User.objects.create_user(username="seen", password="x")
        self.hidden = User.objects.create_user(username="hidden", password="x")
        board = Board.objects.create(name="Shared", owner=self.importer)
        for u in (self.importer, self.seen):
            BoardMembership.objects.create(board=board, user=u, role=BoardMembership.Role.MEMBER)
        self.client = APIClient()
        self.client.force_authenticate(self.importer)

    def _import(self, data, **extra):
        cache.clear()
        resp = self.client.post(URL, {"file": _file(data), **extra}, format="multipart")
        self.assertEqual(resp.status_code, 201, resp.content)
        return Board.objects.get(pk=resp.data["id"])

    def test_visible_user_is_linked_everywhere(self):
        board = self._import(_payload())
        card = Card.objects.get(board=board)
        self.assertEqual(card.assignee, self.seen)
        self.assertEqual(CardMovement.objects.get(card=card).moved_by, self.seen)
        self.assertEqual(CardActivity.objects.get(card=card).actor, self.seen)

    def test_unseen_user_is_not_linked_as_assignee_or_actor(self):
        board = self._import(_payload(assignee="hidden", mover="hidden", actor="hidden"))
        card = Card.objects.get(board=board)
        self.assertIsNone(card.assignee)
        self.assertEqual(CardMovement.objects.get(card=card).moved_by, self.importer)
        self.assertEqual(CardActivity.objects.get(card=card).actor, self.importer)

    def test_unseen_user_and_nonexistent_user_are_indistinguishable(self):
        a = Card.objects.get(board=self._import(_payload(assignee="hidden")))
        b = Card.objects.get(board=self._import(_payload(assignee="no-such-user")))
        self.assertIsNone(a.assignee)
        self.assertIsNone(b.assignee)

    def test_inactive_user_sharing_a_board_is_not_linked(self):
        self.seen.is_active = False
        self.seen.save(update_fields=["is_active"])
        card = Card.objects.get(board=self._import(_payload()))
        self.assertIsNone(card.assignee)
        self.assertEqual(CardMovement.objects.get(card=card).moved_by, self.importer)
        self.assertEqual(CardActivity.objects.get(card=card).actor, self.importer)

    def test_group_peer_is_visible_and_target_group_owner_is_visible(self):
        group = Group.objects.create(name="G", owner=self.hidden)
        GroupMembership.objects.create(group=group, user=self.importer)
        board = self._import(_payload(assignee="hidden"), group_id=group.pk)
        self.assertEqual(Card.objects.get(board=board).assignee, self.hidden)

    def test_csv_assignee_is_scoped_too(self):
        csv_text = "Title,Column,Swimlane,Assignee\nA,To Do,General,hidden\nB,To Do,General,seen\n"
        f = io.BytesIO(csv_text.encode("utf-8"))
        f.name = "b.csv"
        resp = self.client.post(URL, {"file": f, "name": "C"}, format="multipart")
        self.assertEqual(resp.status_code, 201, resp.content)
        got = {c.title: c.assignee for c in Card.objects.filter(board_id=resp.data["id"])}
        self.assertIsNone(got["A"])
        self.assertEqual(got["B"], self.seen)

    def test_lookup_query_count_does_not_grow_with_cards(self):
        def count_user_selects(n):
            cache.clear()
            with CaptureQueriesContext(connection) as ctx:
                resp = self.client.post(
                    URL, {"file": _file(_payload(card_count=n))}, format="multipart"
                )
            self.assertEqual(resp.status_code, 201, resp.content)
            return sum(
                1 for q in ctx.captured_queries
                if q["sql"].lstrip().upper().startswith("SELECT")
                and 'FROM "users"' in q["sql"] and "LOWER(" in q["sql"].upper()
            )

        self.assertEqual(count_user_selects(1), count_user_selects(8))
        self.assertEqual(count_user_selects(8), 1)

    def test_csv_lookup_query_count_does_not_grow_with_rows(self):
        def count_user_selects(n):
            rows = "".join(f"Card {i},To Do,General,seen\n" for i in range(n))
            f = io.BytesIO(("Title,Column,Swimlane,Assignee\n" + rows).encode("utf-8"))
            f.name = "b.csv"
            cache.clear()
            with CaptureQueriesContext(connection) as ctx:
                resp = self.client.post(URL, {"file": f, "name": "C"}, format="multipart")
            self.assertEqual(resp.status_code, 201, resp.content)
            return sum(
                1 for q in ctx.captured_queries
                if q["sql"].lstrip().upper().startswith("SELECT")
                and 'FROM "users"' in q["sql"] and "LOWER(" in q["sql"].upper()
            )

        self.assertEqual(count_user_selects(1), count_user_selects(8))
        self.assertEqual(count_user_selects(8), 1)
