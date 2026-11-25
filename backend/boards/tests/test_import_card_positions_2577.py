"""Imported cards get unique, ordered positions inside each cell (#2577).

CSV rows carry no position and used to be written with position 0, so a whole
cell shared one position. JSON files can repeat positions, omit them, or carry
one near 2**31-1 that overflows the max(position)+1 append (#2562).
"""

import io
import json

from django.core.cache import cache
from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Card

URL = "/api/v1/boards/import/"


def _positions(board_id):
    cells = {}
    for c in Card.objects.filter(board_id=board_id).order_by("position", "id").select_related("column", "swimlane"):
        cells.setdefault((c.column.name, c.swimlane.name), []).append((c.title, c.position))
    return cells


class ImportCardPositionTests(TestCase):
    def setUp(self):
        cache.clear()
        self.client = APIClient()
        self.client.force_authenticate(User.objects.create_user(username="importer", password="x"))

    def _post(self, content, name):
        cache.clear()
        f = io.BytesIO(content.encode("utf-8"))
        f.name = name
        resp = self.client.post(URL, {"file": f}, format="multipart")
        self.assertEqual(resp.status_code, 201, resp.content)
        return resp.data["id"]

    def _json(self, cards):
        data = {
            "name": "P",
            "columns": [{"name": "To Do", "position": 0}, {"name": "Done", "position": 1}],
            "swimlanes": [{"name": "General", "position": 0}],
            "labels": [],
            "cards": [{"swimlane": "General", **c} for c in cards],
        }
        return self._post(json.dumps(data), "board.json")

    def test_csv_rows_in_one_cell_get_distinct_row_ordered_positions(self):
        board = self._post(
            "Title,Column,Swimlane\nA,To Do,General\nB,To Do,General\nC,Done,General\nD,To Do,General\n",
            "board.csv",
        )
        cells = _positions(board)
        self.assertEqual(cells[("To Do", "General")], [("A", 0), ("B", 1), ("D", 2)])
        self.assertEqual(cells[("Done", "General")], [("C", 0)])

    def test_json_without_positions_is_numbered_in_file_order(self):
        board = self._json([{"title": t, "column": "To Do"} for t in "ABC"])
        self.assertEqual(_positions(board)[("To Do", "General")], [("A", 0), ("B", 1), ("C", 2)])

    def test_json_duplicate_positions_are_made_unique_keeping_order(self):
        board = self._json([
            {"title": "A", "column": "To Do", "position": 5},
            {"title": "B", "column": "To Do", "position": 2},
            {"title": "C", "column": "To Do", "position": 2},
        ])
        self.assertEqual(_positions(board)[("To Do", "General")], [("B", 0), ("C", 1), ("A", 2)])

    def test_json_huge_position_is_renumbered_so_a_later_create_cannot_overflow(self):
        board = self._json([
            {"title": "A", "column": "To Do", "position": 2**31 - 1},
            {"title": "B", "column": "To Do", "position": 0},
        ])
        self.assertEqual(_positions(board)[("To Do", "General")], [("B", 0), ("A", 1)])
