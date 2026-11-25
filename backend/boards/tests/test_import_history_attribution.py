"""Imported history rows are the importer's and keep the source name (#1675).

A JSON import with ``history`` on writes the file's movements and activities.
Each row is attributed to the importing user, keeps the source file's
username as text in ``imported_from_username``, and keeps the file's
timestamp. The API, the card timeline and both export formats surface it.
"""

import csv
import io
import json

from django.core.cache import cache
from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, CardActivity, CardMovement

URL = "/api/v1/boards/import/"


def _file(data):
    f = io.BytesIO(json.dumps(data).encode("utf-8"))
    f.name = "board.json"
    return f


def _payload(movement=None, activity=None, **card):
    return {
        "name": "History",
        "columns": [{"name": "To Do", "position": 0}, {"name": "Done", "position": 1}],
        "swimlanes": [{"name": "General", "position": 0}],
        "labels": [],
        "cards": [
            {
                "title": "Card",
                "column": "Done",
                "swimlane": "General",
                "position": 0,
                "movements": [
                    movement
                    if movement is not None
                    else {
                        "from_column": "To Do",
                        "to_column": "Done",
                        "moved_by": "alice",
                        "moved_at": "2024-03-04T05:06:07Z",
                    }
                ],
                "activities": [
                    activity
                    if activity is not None
                    else {
                        "event_type": "priority_change",
                        "from_value": "low",
                        "to_value": "high",
                        "actor": "alice",
                        "created_at": "2024-03-04T06:00:00Z",
                    }
                ],
                **card,
            }
        ],
    }


class ImportedHistoryAttributionTests(TestCase):
    def setUp(self):
        cache.clear()
        self.importer = User.objects.create_user(username="importer", password="x")
        # alice shares a board with the importer, so she is a name the
        # assignee lookup can match. History rows must still not link to her.
        self.alice = User.objects.create_user(username="alice", password="x")
        shared = Board.objects.create(name="Shared", owner=self.importer)
        for u in (self.importer, self.alice):
            BoardMembership.objects.create(
                board=shared, user=u, role=BoardMembership.Role.MEMBER
            )
        self.client = APIClient()
        self.client.force_authenticate(self.importer)

    def _post(self, data, **extra):
        cache.clear()
        return self.client.post(URL, {"file": _file(data), **extra}, format="multipart")

    def _import(self, data, **extra):
        resp = self._post(data, **extra)
        self.assertEqual(resp.status_code, 201, resp.content)
        return Board.objects.get(pk=resp.data["id"])

    def test_rows_are_attributed_to_importer_with_source_name_and_time(self):
        board = self._import(_payload(assignee="alice"))
        card = Card.objects.get(board=board)
        # Assignee resolution is unchanged.
        self.assertEqual(card.assignee, self.alice)
        mv = CardMovement.objects.get(card=card)
        act = CardActivity.objects.get(card=card, event_type="priority_change")
        self.assertEqual(
            (mv.moved_by, mv.imported_from_username), (self.importer, "alice")
        )
        self.assertEqual(
            (act.actor, act.imported_from_username), (self.importer, "alice")
        )
        self.assertEqual(mv.moved_at.isoformat(), "2024-03-04T05:06:07+00:00")
        self.assertEqual(act.created_at.isoformat(), "2024-03-04T06:00:00+00:00")

    def test_explicit_imported_from_username_wins_over_moved_by(self):
        board = self._import(
            _payload(
                movement={
                    "from_column": "To Do",
                    "to_column": "Done",
                    "moved_by": "importer",
                    "imported_from_username": "carol",
                },
                activity={
                    "event_type": "title_change",
                    "actor": "importer",
                    "imported_from_username": "carol",
                },
            )
        )
        self.assertEqual(
            CardMovement.objects.get(card__board=board).imported_from_username, "carol"
        )
        self.assertEqual(
            CardActivity.objects.get(
                card__board=board, event_type="title_change"
            ).imported_from_username,
            "carol",
        )

    def test_null_imported_from_username_falls_back_to_moved_by(self):
        board = self._import(
            _payload(
                movement={
                    "from_column": "To Do",
                    "to_column": "Done",
                    "moved_by": "alice",
                    "imported_from_username": None,
                },
            )
        )
        self.assertEqual(
            CardMovement.objects.get(card__board=board).imported_from_username, "alice"
        )

    def test_row_without_a_name_is_still_marked_imported(self):
        board = self._import(
            _payload(
                movement={
                    "from_column": "To Do",
                    "to_column": "Done",
                    "moved_by": None,
                },
                activity={"event_type": "title_change"},
            )
        )
        self.assertEqual(
            CardMovement.objects.get(card__board=board).imported_from_username, ""
        )
        self.assertEqual(
            CardActivity.objects.get(
                card__board=board, event_type="title_change"
            ).imported_from_username,
            "",
        )

    def test_nul_in_moved_by_is_dropped_from_the_kept_name(self):
        board = self._import(
            _payload(
                movement={
                    "from_column": "To Do",
                    "to_column": "Done",
                    "moved_by": "al\x00ice",
                },
            )
        )
        self.assertEqual(
            CardMovement.objects.get(card__board=board).imported_from_username, "alice"
        )

    def test_importer_generated_entries_are_not_marked_imported(self):
        board = self._import(
            _payload(weight=3, activity={"event_type": "title_change"})
        )
        generated = CardActivity.objects.get(
            card__board=board, event_type="weight_change"
        )
        self.assertEqual(generated.actor, self.importer)
        self.assertIsNone(generated.imported_from_username)

    def test_history_off_writes_no_imported_rows(self):
        board = self._import(_payload(), options=json.dumps({"history": False}))
        self.assertFalse(CardMovement.objects.filter(card__board=board).exists())
        self.assertFalse(
            CardActivity.objects.filter(
                card__board=board, imported_from_username__isnull=False
            ).exists()
        )

    def test_invalid_imported_from_username_is_refused(self):
        cases = [
            (
                "movement",
                {
                    "from_column": "To Do",
                    "to_column": "Done",
                    "imported_from_username": ["x"],
                },
                "must be a string",
            ),
            (
                "movement",
                {
                    "from_column": "To Do",
                    "to_column": "Done",
                    "imported_from_username": "x" * 151,
                },
                "at most 150 characters",
            ),
            (
                "activity",
                {"event_type": "title_change", "imported_from_username": "a\x00b"},
                "NUL",
            ),
            (
                "activity",
                {"event_type": "title_change", "imported_from_username": {"a": 1}},
                "must be a string",
            ),
        ]
        for kind, entry, fragment in cases:
            with self.subTest(kind=kind, entry=str(entry)[:40]):
                resp = self._post(_payload(**{kind: entry}))
                self.assertEqual(resp.status_code, 400, resp.content)
                self.assertIn("imported_from_username", resp.data["detail"])
                self.assertIn(fragment, resp.data["detail"])


class ImportedHistorySurfacingTests(TestCase):
    """The API and both exports surface the kept name."""

    def setUp(self):
        cache.clear()
        self.importer = User.objects.create_user(username="importer", password="x")
        self.client = APIClient()
        self.client.force_authenticate(self.importer)
        resp = self.client.post(URL, {"file": _file(_payload())}, format="multipart")
        self.assertEqual(resp.status_code, 201, resp.content)
        self.board = Board.objects.get(pk=resp.data["id"])
        self.card = Card.objects.get(board=self.board)
        # A row recorded on the board afterwards, not imported.
        CardMovement.objects.create(
            card=self.card,
            from_column_name="Done",
            to_column_name="To Do",
            moved_by=self.importer,
        )

    def _card_url(self, suffix):
        return f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/{suffix}/"

    def test_card_movements_and_activities_endpoints(self):
        movements = self.client.get(self._card_url("movements")).json()
        self.assertEqual(
            sorted((m["imported_from_username"] or "-") for m in movements),
            ["-", "alice"],
        )
        activities = self.client.get(self._card_url("activities")).json()
        [imported] = [a for a in activities if a["event_type"] == "priority_change"]
        self.assertEqual(imported["imported_from_username"], "alice")
        self.assertEqual(imported["actor"]["username"], "importer")

    def test_board_movement_history_endpoint(self):
        results = self.client.get(f"/api/v1/boards/{self.board.id}/movements/").json()[
            "results"
        ]
        self.assertEqual(
            sorted((m["imported_from_username"] or "-") for m in results),
            ["-", "alice"],
        )

    def test_card_timeline_entries(self):
        results = self.client.get(self._card_url("timeline")).json()["results"]
        by_kind = {}
        for entry in results:
            by_kind.setdefault(entry["kind"], []).append(
                entry["imported_from_username"]
            )
        self.assertEqual(sorted(x or "-" for x in by_kind["move"]), ["-", "alice"])
        self.assertIn("alice", by_kind["activity"])

    def test_json_export_carries_the_field(self):
        cache.clear()
        out = json.loads(
            self.client.get(
                f"/api/v1/boards/{self.board.id}/export/?format=json"
            ).content
        )
        card = out["cards"][0]
        self.assertEqual(
            sorted((m["imported_from_username"] or "-") for m in card["movements"]),
            ["-", "alice"],
        )
        [act] = [a for a in card["activities"] if a["event_type"] == "priority_change"]
        self.assertEqual(
            (act["actor"], act["imported_from_username"]), ("importer", "alice")
        )

    def test_csv_export_annotates_imported_movements(self):
        CardMovement.objects.create(
            card=self.card,
            from_column_name="To Do",
            to_column_name="Done",
            moved_by=self.importer,
            imported_from_username="",
        )
        cache.clear()
        body = self.client.get(
            f"/api/v1/boards/{self.board.id}/export/"
        ).getvalue().decode()
        [row] = list(csv.DictReader(io.StringIO(body)))
        records = row["Movement History"].split("; ")
        self.assertEqual(len(records), 3, records)
        # Every record keeps its four pipe-delimited parts.
        self.assertTrue(all(len(r.split("|")) == 4 for r in records), records)
        movers = sorted(r.split("|")[3] for r in records)
        self.assertEqual(
            movers,
            [
                "importer",
                "importer (imported)",
                "importer (imported, originally alice)",
            ],
        )


class ImportedHistoryMcpShapeTests(TestCase):
    """The MCP card resource carries the field like the REST API does."""

    def test_movement_and_activity_serializers(self):
        from mcp_server.tools import _serialize_activity, _serialize_movement

        user = User.objects.create_user(username="importer", password="x")
        board = Board.objects.create(name="B", owner=user)
        col = board.columns.create(name="To Do", position=0)
        lane = board.swimlanes.create(name="General", position=0)
        card = Card.objects.create(
            board=board, column=col, swimlane=lane, title="T", created_by=user
        )
        mv = CardMovement.objects.create(
            card=card, moved_by=user, imported_from_username="alice"
        )
        act = CardActivity.objects.create(
            card=card, event_type="title_change", actor=user
        )
        self.assertEqual(_serialize_movement(mv)["imported_from_username"], "alice")
        self.assertIsNone(_serialize_activity(act)["imported_from_username"])


class ImportedHistoryCsvSeparatorTests(TestCase):
    def test_source_name_with_separators_keeps_four_parts(self):
        user = User.objects.create_user(username="importer", password="x")
        board = Board.objects.create(name="B", owner=user)
        BoardMembership.objects.create(
            board=board, user=user, role=BoardMembership.Role.ADMIN
        )
        col = board.columns.create(name="To Do", position=0)
        lane = board.swimlanes.create(name="General", position=0)
        card = Card.objects.create(
            board=board, column=col, swimlane=lane, title="T", created_by=user
        )
        CardMovement.objects.create(
            card=card,
            from_column=col,
            to_column=col,
            moved_by=user,
            imported_from_username="a|b; c\nd",
        )
        CardMovement.objects.create(
            card=card, from_column=col, to_column=col, moved_by=user
        )
        client = APIClient()
        client.force_authenticate(user)
        cache.clear()
        body = client.get(f"/api/v1/boards/{board.id}/export/").getvalue().decode()
        [row] = list(csv.DictReader(io.StringIO(body)))
        records = row["Movement History"].split("; ")
        self.assertEqual(len(records), 2, records)
        parts = [r.split("|") for r in records]
        self.assertTrue(all(len(p) == 4 for p in parts), records)
        self.assertIn("importer (imported, originally a b c d)", [p[3] for p in parts])


class ImportedHistoryCsvFormulaPrefixTests(TestCase):
    def test_name_of_only_formula_prefixes_exports_as_imported(self):
        user = User.objects.create_user(username="importer", password="x")
        board = Board.objects.create(name="B", owner=user)
        BoardMembership.objects.create(
            board=board, user=user, role=BoardMembership.Role.ADMIN
        )
        col = board.columns.create(name="To Do", position=0)
        lane = board.swimlanes.create(name="General", position=0)
        card = Card.objects.create(
            board=board, column=col, swimlane=lane, title="T", created_by=user
        )
        CardMovement.objects.create(
            card=card,
            from_column=col,
            to_column=col,
            moved_by=user,
            imported_from_username="==",
        )
        client = APIClient()
        client.force_authenticate(user)
        cache.clear()
        body = client.get(f"/api/v1/boards/{board.id}/export/").getvalue().decode()
        [row] = list(csv.DictReader(io.StringIO(body)))
        [record] = row["Movement History"].split("; ")
        self.assertEqual(record.split("|")[3], "importer (imported)")
