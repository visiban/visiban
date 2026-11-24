"""Board export and import: relations, deleted cards' blocks and gate history, chunked export.

- #2413: ``deleted_card_history`` entries carry the deleted card's retained
  ``CardBlock`` and ``CardGateTransition`` rows (same shape as a live card's
  ``blocks`` / ``gate_transitions``); the JSON import restores them with the
  ``history`` option (importer as actor, the file's name kept in
  ``imported_from_username``) and counts them in ``skipped`` without it. The
  section stays a fixed number of queries whatever the number of deleted cards.
- #1448: a top-level ``relations`` list, ``{from, kind, to}``, where ``from``
  and ``to`` are indexes into the file's ``cards`` list. Restored after the
  cards are created; a dangling or invalid entry is dropped, not fatal.
- #1962: the export reads cards in keyset chunks, so the model instances and
  their prefetched history are bounded per chunk; the output is the same
  whatever the chunk size.
"""
import datetime as dt
import io
import json
from unittest import mock

from django.core.cache import cache
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, CardActivity, CardBlock, CardChecklist, CardComment,
    BoardExportLog, CardGateTransition, CardMovement, CardRelation, Column, Label, Swimlane,
)
from boards.views import import_export as ie

IMPORT_URL = "/api/v1/boards/import/"
T0 = dt.datetime(2026, 3, 1, 9, 0, tzinfo=dt.timezone.utc)


def _at(minutes):
    return T0 + dt.timedelta(minutes=minutes)


def _file(data):
    f = io.BytesIO(json.dumps(data).encode("utf-8"))
    f.name = "board.json"
    return f


class _Fixture(TestCase):
    """A board with every export shape, every timestamp pinned (so outputs compare)."""

    def setUp(self):
        cache.clear()
        self.owner = User.objects.create_user(username="owner", password="pw-2413-x")
        self.board = Board.objects.create(name="Export 2413", owner=self.owner)
        BoardMembership.objects.create(board=self.board, user=self.owner, role="admin")
        self.todo = Column.objects.create(board=self.board, name="To Do", position=0)
        self.doing = Column.objects.create(board=self.board, name="Doing", position=1)
        self.done = Column.objects.create(board=self.board, name="Done", position=2, is_done=True)
        self.lane_a = Swimlane.objects.create(board=self.board, name="A", position=0)
        self.lane_b = Swimlane.objects.create(board=self.board, name="B", position=1)
        self.bug = Label.objects.create(board=self.board, name="Bug", color="#FF0000")
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def _card(self, title, column, lane, position, **kw):
        card = Card.objects.create(
            board=self.board, column=column, swimlane=lane, title=title,
            created_by=self.owner, position=position, **kw,
        )
        Card.objects.filter(pk=card.pk).update(created_at=_at(card.pk))
        card.refresh_from_db()
        return card

    def _move(self, card, to_column, minutes):
        mv = CardMovement.objects.create(
            card=card, from_column=card.column, to_column=to_column,
            from_swimlane=card.swimlane, to_swimlane=card.swimlane, moved_by=self.owner,
        )
        CardMovement.objects.filter(pk=mv.pk).update(moved_at=_at(minutes))
        return mv

    def _block(self, card, minutes, *, closed=True, reason="Waiting on vendor"):
        return CardBlock.objects.create(
            # The snapshot fields as services.cards.block_card writes them.
            card=card, board=self.board, card_uid=card.uid, card_title=card.title,
            blocked_at=_at(minutes), blocked_by=self.owner,
            reason=reason, column=card.column, column_name=card.column.name,
            unblocked_at=_at(minutes + 5) if closed else None,
            unblocked_by=self.owner if closed else None,
            resolution="Shipped" if closed else "",
        )

    def _gate(self, card, minutes, movement=None):
        return CardGateTransition.objects.create(
            card=card, column=card.column, column_name=card.column.name, sub_column_name="Review",
            kind=CardGateTransition.Kind.PASS, from_index=0, to_index=1, reason="ok",
            movement=movement, actor=self.owner, created_at=_at(minutes),
        )

    def _deleted_card(self, title="Gone", minutes=100, *, open_block=False):
        """A card with every retained row type, then hard-deleted through the API."""
        card = self._card(title, self.todo, self.lane_a, 9)
        mv = self._move(card, self.doing, minutes)
        act = CardActivity.objects.create(
            card=card, actor=self.owner, event_type=CardActivity.EventType.TITLE_CHANGE,
            from_value="x", to_value=title,
        )
        CardActivity.objects.filter(pk=act.pk).update(created_at=_at(minutes + 1))
        self._block(card, minutes + 2)
        if open_block:
            self._block(card, minutes + 20, closed=False, reason="Still stuck")
        self._gate(card, minutes + 3, movement=mv)
        uid = card.uid
        resp = self.client.delete(f"/api/v1/boards/{self.board.pk}/cards/{card.pk}/")
        self.assertEqual(resp.status_code, 204, resp.content)
        return uid

    def build_rich_board(self):
        """Tied positions across columns, archived and blocked cards, relations, a deleted card."""
        a = self._card("Alpha", self.todo, self.lane_a, 0, priority="high")
        b = self._card("Beta", self.doing, self.lane_a, 0, weight=3)
        c = self._card("Gamma", self.done, self.lane_b, 1, description="=SUM(A1)")
        d = self._card("Delta", self.todo, self.lane_b, 0, archived_at=_at(50))
        a.labels.add(self.bug)
        self._move(b, self.doing, 10)
        self._move(c, self.done, 11)
        comment = CardComment.objects.create(card=a, author=self.owner, body="Hello")
        CardComment.objects.filter(pk=comment.pk).update(created_at=_at(12))
        CardChecklist.objects.create(card=a, text="Step", position=0, created_by=self.owner)
        self._block(a, 20)
        Card.objects.filter(pk=b.pk).update(blocked_at=_at(30), blocked_reason="Stuck")
        self._block(b, 30, closed=False, reason="Stuck")
        self._gate(b, 31)
        CardRelation.objects.create(from_card=a, to_card=b, relation_type="blocks", created_by=self.owner)
        low, high = sorted([c, d], key=lambda x: x.pk)
        CardRelation.objects.create(from_card=low, to_card=high, relation_type="relates_to")
        uid = self._deleted_card()
        return {"a": a, "b": b, "c": c, "d": d, "deleted_uid": uid}

    def export(self, fmt="json"):
        resp = self.client.get(f"/api/v1/boards/{self.board.pk}/export/", {"format": fmt})
        self.assertEqual(resp.status_code, 200, resp.content)
        return resp

    def export_json(self):
        return json.loads(self.export("json").content)

    def do_import(self, data, options=None):
        cache.clear()
        payload = {"file": _file(data)}
        if options is not None:
            payload["options"] = json.dumps(options)
        resp = self.client.post(IMPORT_URL, payload, format="multipart")
        return resp


def _relation_set(board):
    """``{(from title, kind, to title)}``, symmetric kinds as a sorted pair."""
    out = set()
    for rel in CardRelation.objects.filter(from_card__board=board).select_related("from_card", "to_card"):
        ends = (rel.from_card.title, rel.to_card.title)
        if rel.relation_type in CardRelation.SYMMETRIC_TYPES:
            ends = tuple(sorted(ends))
        out.add((ends[0], rel.relation_type, ends[1]))
    return out


class DeletedCardBlocksAndGatesExportTests(_Fixture):
    """#2413: the export side."""

    def test_entry_carries_blocks_and_gate_transitions_shaped_like_a_live_card(self):
        refs = self.build_rich_board()
        data = self.export_json()
        [entry] = data["deleted_card_history"]
        self.assertEqual(entry["card_uid"], refs["deleted_uid"])
        self.assertEqual(
            list(entry), ["card_uid", "card_title", "movements", "activities", "blocks", "gate_transitions"],
        )
        live = {c["title"]: c for c in data["cards"]}
        [block] = entry["blocks"]
        self.assertEqual(list(block), list(live["Alpha"]["blocks"][0]))
        self.assertEqual(
            (block["reason"], block["resolution"], block["blocked_by"], block["column"]),
            ("Waiting on vendor", "Shipped", "owner", "To Do"),
        )
        [gate] = entry["gate_transitions"]
        self.assertEqual(list(gate), list(live["Beta"]["gate_transitions"][0]))
        # movement_index points into the entry's own movements.
        self.assertEqual(gate["movement_index"], 0)
        self.assertEqual(entry["movements"][0]["to_column"], "Doing")

    def test_open_block_of_a_deleted_card_is_exported_open(self):
        self._deleted_card(open_block=True)
        [entry] = self.export_json()["deleted_card_history"]
        self.assertEqual([b["unblocked_at"] is None for b in entry["blocks"]], [False, True])

    def test_export_queries_flat_in_the_number_of_deleted_cards(self):
        self.build_rich_board()

        def count():
            cache.clear()
            with CaptureQueriesContext(connection) as ctx:
                self.export("json")
            return len(ctx.captured_queries)

        one = count()
        for i in range(4):
            self._deleted_card(f"Gone {i}", minutes=200 + 30 * i, open_block=True)
        self.assertEqual(count(), one)


class DeletedCardBlocksAndGatesImportTests(_Fixture):
    """#2413: the import side."""

    def test_round_trip_restores_blocks_and_gates_attributed_to_the_importer(self):
        uid = self._deleted_card(open_block=True)
        data = self.export_json()
        importer = User.objects.create_user(username="importer", password="pw-2413-y")
        self.client.force_authenticate(importer)
        resp = self.do_import(data)
        self.assertEqual(resp.status_code, 201, resp.content)
        new_board = Board.objects.get(pk=resp.data["id"])
        blocks = list(CardBlock.objects.filter(board=new_board).order_by("blocked_at"))
        self.assertEqual([b.card_id for b in blocks], [None, None])
        self.assertEqual({b.card_uid for b in blocks}, {uid})
        self.assertEqual({b.card_title for b in blocks}, {"Gone"})
        # Rule 5: the importer is the actor, the file's name is kept as text.
        self.assertEqual({b.blocked_by_id for b in blocks}, {importer.pk})
        self.assertEqual({b.imported_from_username for b in blocks}, {"owner"})
        closed, still_open = blocks
        self.assertEqual((closed.unblocked_by_id, closed.resolution), (importer.pk, "Shipped"))
        self.assertEqual((still_open.unblocked_at, still_open.unblocked_by_id), (None, None))
        self.assertEqual(closed.blocked_at, _at(102))
        self.assertEqual(closed.column.name, "To Do")
        [gate] = CardGateTransition.objects.filter(board=new_board)
        self.assertEqual((gate.card_id, gate.card_uid, gate.actor_id), (None, uid, importer.pk))
        self.assertEqual(gate.imported_from_username, "owner")
        self.assertEqual(gate.created_at, _at(103))
        # Relinked to the restored movement of the same deleted card.
        self.assertEqual(gate.movement.card_uid, uid)
        self.assertIsNone(gate.movement.card_id)
        # And the new board's export carries them again, unchanged.
        again = self.client.get(f"/api/v1/boards/{new_board.pk}/export/", {"format": "json"}).json()
        [entry] = again["deleted_card_history"]
        self.assertEqual(len(entry["blocks"]), 2)
        self.assertEqual(entry["gate_transitions"][0]["movement_index"], 0)
        self.assertEqual({b["imported_from_username"] for b in entry["blocks"]}, {"owner"})

    def test_history_off_counts_live_and_deleted_blocks_and_gates_in_skipped(self):
        self.build_rich_board()
        self._deleted_card("Gone 2", minutes=300, open_block=True)
        data = self.export_json()
        resp = self.do_import(data, {"history": False})
        self.assertEqual(resp.status_code, 201, resp.content)
        new_board = Board.objects.get(pk=resp.data["id"])
        skipped = resp.data["import_summary"]["skipped"]
        # Live: Alpha's closed block (Beta's open block is card state, written
        # either way) and Beta's gate. Deleted: 1 + 2 blocks and 2 gates.
        self.assertEqual((skipped["blocks"], skipped["gate_transitions"]), (1 + 3, 1 + 2))
        self.assertEqual(skipped["relations"], 0)
        self.assertFalse(CardBlock.objects.filter(board=new_board, card__isnull=True).exists())
        self.assertFalse(CardGateTransition.objects.filter(board=new_board).exists())
        # Beta's current block survives (card state).
        self.assertEqual(CardBlock.objects.filter(board=new_board).count(), 1)

    def test_history_on_skips_nothing_and_drops_unusable_rows(self):
        data = self.export_json()
        data["deleted_card_history"] = [{
            "card_uid": "0123456789abcdef", "card_title": "Gone",
            "blocks": [
                {"blocked_at": "2026-01-02T00:00:00Z", "reason": "r", "unblocked_at": "2026-01-01T00:00:00Z"},
                {"reason": "no start"},
                {"blocked_at": "2026-01-01T00:00:00Z", "reason": " kept ", "column": "Nowhere"},
            ],
            "gate_transitions": [{"kind": "bogus"}, {"kind": "reopen", "cause": "??", "movement_index": 7}],
        }]
        resp = self.do_import(data)
        self.assertEqual(resp.status_code, 201, resp.content)
        skipped = resp.data["import_summary"]["skipped"]
        self.assertEqual((skipped["blocks"], skipped["gate_transitions"]), (0, 0))
        [blk] = CardBlock.objects.filter(board_id=resp.data["id"])
        self.assertEqual((blk.reason, blk.column_id, blk.column_name, blk.imported_from_username), ("kept", None, "Nowhere", ""))
        [gate] = CardGateTransition.objects.filter(board_id=resp.data["id"])
        self.assertEqual((gate.kind, gate.cause, gate.movement_id), ("reopen", "import", None))

    def test_entry_without_the_new_keys_imports(self):
        # Absent input (#1075): a file from before #2413.
        data = self.export_json()
        data["deleted_card_history"] = [{"card_uid": "0123456789abcdef", "card_title": "Old", "movements": []}]
        resp = self.do_import(data)
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertFalse(CardBlock.objects.filter(board_id=resp.data["id"]).exists())

    def test_malformed_blocks_or_gates_in_an_entry_are_a_400(self):
        base = self.export_json()
        good = {"card_uid": "0123456789abcdef", "card_title": "t"}
        ok_block = {"blocked_at": "2026-01-01T00:00:00Z", "reason": "r"}
        cases = {
            "blocks not a list": {"blocks": {}},
            "block not an object": {"blocks": ["x"]},
            "bad blocked_at": {"blocks": [{**ok_block, "blocked_at": "soon"}]},
            "bad unblocked_at": {"blocks": [{**ok_block, "unblocked_at": "later"}]},
            "reason missing": {"blocks": [{"blocked_at": "2026-01-01T00:00:00Z"}]},
            "reason blank": {"blocks": [{**ok_block, "reason": "  "}]},
            "reason too long": {"blocks": [{**ok_block, "reason": "r" * 501}]},
            "blocker not a string": {"blocks": [{**ok_block, "blocked_by": ["a"]}]},
            "too many blocks": {"blocks": [ok_block] * 1001},
            "gate not an object": {"gate_transitions": [5]},
            "bad gate timestamp": {"gate_transitions": [{"kind": "pass", "created_at": "x"}]},
            "bad gate index": {"gate_transitions": [{"kind": "pass", "from_index": -1}]},
            "gate actor not a string": {"gate_transitions": [{"kind": "pass", "actor": 5}]},
            "too many gates": {"gate_transitions": [{"kind": "pass"}] * 2001},
        }
        for name, extra in cases.items():
            with self.subTest(name):
                resp = self.do_import({**base, "deleted_card_history": [{**good, **extra}]})
                self.assertEqual(resp.status_code, 400, resp.content)
        self.assertEqual(Board.objects.count(), 1)

    def test_entry_block_usernames_count_toward_the_username_limit(self):
        base = self.export_json()
        entry = {"card_uid": "", "card_title": "t", "blocks": [
            {"blocked_at": "2026-01-01T00:00:00Z", "reason": "r", "blocked_by": f"u{i}"} for i in range(3)
        ]}
        with mock.patch.object(ie, "_IMPORT_MAX_USERNAMES", 2):
            resp = self.do_import({**base, "deleted_card_history": [entry]})
        self.assertEqual(resp.status_code, 400, resp.content)
        self.assertIn("distinct usernames", resp.data["detail"])


class RelationsExportImportTests(_Fixture):
    """#1448."""

    def test_export_lists_relations_by_card_index(self):
        refs = self.build_rich_board()
        data = self.export_json()
        self.assertEqual(list(data)[-2:], ["deleted_card_history", "relations"])
        titles = [c["title"] for c in data["cards"]]
        named = {(titles[r["from"]], r["kind"], titles[r["to"]]) for r in data["relations"]}
        low, high = sorted([refs["c"], refs["d"]], key=lambda x: x.pk)
        self.assertEqual(named, {("Alpha", "blocks", "Beta"), (low.title, "relates_to", high.title)})
        self.assertEqual([list(r) for r in data["relations"]], [["from", "kind", "to"]] * 2)

    def test_board_without_relations_exports_an_empty_list(self):
        self._card("Solo", self.todo, self.lane_a, 0)
        self.assertEqual(self.export_json()["relations"], [])

    def test_round_trip_restores_relations_including_to_an_archived_card(self):
        self.build_rich_board()
        before = _relation_set(self.board)
        resp = self.do_import(self.export_json())
        self.assertEqual(resp.status_code, 201, resp.content)
        new_board = Board.objects.get(pk=resp.data["id"])
        self.assertEqual(_relation_set(new_board), before)
        self.assertTrue(new_board.cards.get(title="Delta").archived_at)
        rels = CardRelation.objects.filter(from_card__board=new_board)
        self.assertEqual({r.created_by_id for r in rels}, {self.owner.pk})
        # Symmetric rows stay in canonical order: lower card id first.
        for rel in rels.filter(relation_type="relates_to"):
            self.assertLess(rel.from_card_id, rel.to_card_id)

    def _three_cards(self):
        base = self.export_json()
        base["cards"] = [
            {"title": t, "column": "To Do", "swimlane": "A", "position": i}
            for i, t in enumerate(["C0", "C1", "C2"])
        ]
        return base

    def test_invalid_and_dangling_entries_are_dropped_not_fatal(self):
        data = self._three_cards()
        data["relations"] = [
            {"from": 0, "kind": "blocks", "to": 1},          # kept
            {"from": 0, "kind": "blocks", "to": 1},          # duplicate
            {"from": 1, "kind": "blocks", "to": 0},          # direct two-cycle
            {"from": 2, "kind": "relates_to", "to": 0},      # kept, normalized
            {"from": 0, "kind": "relates_to", "to": 2},      # same pair reversed
            {"from": 0, "kind": "blocks", "to": 3},          # dangling
            {"from": -1, "kind": "blocks", "to": 0},         # dangling
            {"from": True, "kind": "blocks", "to": 2},       # bool is not an index
            {"from": "0", "kind": "blocks", "to": 2},        # not an int
            {"from": 1.0, "kind": "blocks", "to": 2},        # not an int
            {"from": 2, "kind": "blocks", "to": 2},          # self
            {"from": 1, "kind": "duplicates", "to": 2},      # unknown kind
            {"from": 1, "kind": ["blocks"], "to": 2},        # unhashable kind
            {"from": 1, "to": 2},                            # no kind
            "x", None, 5, [0, "blocks", 1],                  # not objects
        ]
        resp = self.do_import(data)
        self.assertEqual(resp.status_code, 201, resp.content)
        new_board = Board.objects.get(pk=resp.data["id"])
        self.assertEqual(_relation_set(new_board), {("C0", "blocks", "C1"), ("C0", "relates_to", "C2")})
        self.assertEqual(resp.data["import_summary"]["skipped"]["relations"], 0)

    def test_missing_relations_key_imports_without_relations(self):
        # Absent input (#1075): a file from before #1448.
        data = self._three_cards()
        data.pop("relations", None)
        resp = self.do_import(data)
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertFalse(CardRelation.objects.filter(from_card__board_id=resp.data["id"]).exists())

    def test_relations_not_a_list_is_a_400(self):
        for bad in ({}, "x", 5, None):
            with self.subTest(bad):
                data = self._three_cards()
                data["relations"] = bad
                resp = self.do_import(data)
                self.assertEqual(resp.status_code, 400, resp.content)
                self.assertEqual(resp.data["detail"], "'relations' must be a list")

    def test_relations_over_the_cap_is_a_limit_error(self):
        data = self._three_cards()
        data["relations"] = [{"from": 0, "kind": "blocks", "to": 1}] * 3
        with mock.patch.object(ie, "_IMPORT_MAX_RELATIONS", 2):
            resp = self.do_import(data)
        self.assertEqual(resp.status_code, 400, resp.content)
        self.assertEqual(resp.data["code"], "limit_exceeded")
        with mock.patch.object(ie, "_IMPORT_MAX_RELATIONS", 3):
            self.assertEqual(self.do_import(data).status_code, 201)

    def test_relations_count_toward_the_row_limit(self):
        data = self._three_cards()
        data["relations"] = [{"from": 0, "kind": "blocks", "to": 1}] * 5
        rows_without = ie._board_rows(data) + sum(ie._card_rows(c) for c in data["cards"])
        with mock.patch.object(ie, "_IMPORT_MAX_ROWS", rows_without + 4):
            resp = self.do_import(data)
        self.assertEqual(resp.status_code, 400, resp.content)
        self.assertEqual(resp.data["code"], "limit_exceeded")

    def test_cards_off_counts_relations_in_skipped(self):
        self.build_rich_board()
        resp = self.do_import(self.export_json(), {"cards": False})
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(resp.data["import_summary"]["skipped"]["relations"], 2)
        self.assertFalse(CardRelation.objects.filter(from_card__board_id=resp.data["id"]).exists())

    def test_skip_count_matches_what_an_import_would_write(self):
        data = self._three_cards()
        data["relations"] = [
            {"from": 0, "kind": "blocks", "to": 1}, {"from": 1, "kind": "blocks", "to": 0},
            {"from": 0, "kind": "blocks", "to": 9}, "x",
        ]
        opts = {"labels": True, "cards": False, "comments": True, "checklist": True, "history": True}
        self.assertEqual(ie._json_skip_counts(data, opts)["relations"], 1)
        self.assertEqual(ie._json_skip_counts({**data, "relations": "x"}, opts)["relations"], 0)


class ChunkedExportTests(_Fixture):
    """#1962: the output does not depend on the chunk size."""

    def _exports(self):
        cache.clear()
        return self.export("json").content, self.export("csv").content

    def test_output_is_the_same_whatever_the_chunk_size(self):
        self.build_rich_board()
        # More tied positions, so chunk boundaries fall inside a tie.
        for i in range(4):
            self._card(f"Extra {i}", self.doing, self.lane_b, 0)
        expected = self._exports()
        data = json.loads(expected[0])
        self.assertEqual(len(data["cards"]), 8)
        for size in (1, 2, 3, 7, 8, 9):
            with self.subTest(size), mock.patch.object(ie, "_EXPORT_CHUNK_SIZE", size):
                self.assertEqual(self._exports(), expected)

    def test_cards_come_in_position_then_id_order(self):
        refs = self.build_rich_board()
        with mock.patch.object(ie, "_EXPORT_CHUNK_SIZE", 2):
            data = self.export_json()
        # Positions 0 (Alpha, Beta, Delta by id), then 1 (Gamma).
        self.assertEqual([c["title"] for c in data["cards"]], ["Alpha", "Beta", "Delta", "Gamma"])
        self.assertEqual(refs["a"].position, refs["b"].position)

    def test_audit_log_counts_every_card_across_chunks(self):
        self.build_rich_board()
        with mock.patch.object(ie, "_EXPORT_CHUNK_SIZE", 3):
            self.export("json")
            self.export("csv")
        self.assertEqual(
            list(BoardExportLog.objects.order_by("id").values_list("export_format", "row_count")),
            [("json", 4), ("csv", 4)],
        )

    def test_empty_board_exports(self):
        self.assertEqual(self.export_json()["cards"], [])
        self.assertEqual(len(self.export("csv").content.decode().splitlines()), 1)

    def test_chunk_queries_grow_with_chunks_not_cards(self):
        self.build_rich_board()

        def count(size):
            cache.clear()
            with mock.patch.object(ie, "_EXPORT_CHUNK_SIZE", size), CaptureQueriesContext(connection) as ctx:
                self.export("csv")
            return len(ctx.captured_queries)

        # 4 cards: at 5 (or 500) one page, as before chunking.
        self.assertEqual(count(5), count(500))
        # At 4 the page is full, so the remaining ids are read once (none).
        self.assertEqual(count(4), count(5) + 1)
        # At 2: first page, the id list, then one more chunk with its prefetches.
        self.assertGreater(count(2), count(4))

    def test_card_deleted_during_the_export_is_left_out(self):
        refs = self.build_rich_board()
        original = ie._iter_export_cards

        def deleting(queryset):
            for i, card in enumerate(original(queryset)):
                if i == 1:
                    # After the remaining ids were read, before Gamma's chunk is fetched.
                    Card.objects.filter(pk=refs["c"].pk).delete()
                yield card

        with mock.patch.object(ie, "_EXPORT_CHUNK_SIZE", 1), mock.patch.object(ie, "_iter_export_cards", deleting):
            data = self.export_json()
        self.assertEqual([c["title"] for c in data["cards"]], ["Alpha", "Beta", "Delta"])


class ChunkedExportRaceTests(_Fixture):
    """#1962: a card that changes while the export runs is emitted exactly once.

    The export holds no snapshot across its queries. Each test runs a change
    right after the first card page is read (chunk size 2: Alpha, Beta), the
    window in which the earlier position cursor duplicated a moved-up card and
    skipped a moved-down one.
    """

    def _export_with_change_after_first_page(self, change):
        fired = []

        def wrapper(execute, sql, params, many, context):
            result = execute(sql, params, many, context)
            # The first card page: the only card query with a LIMIT.
            if not fired and sql.lstrip().upper().startswith("SELECT") and 'FROM "cards"' in sql and "LIMIT" in sql:
                fired.append(sql)
                change()
            return result

        with mock.patch.object(ie, "_EXPORT_CHUNK_SIZE", 2), connection.execute_wrapper(wrapper):
            data = self.export_json()
        self.assertTrue(fired, "the first card page was never read")
        return data

    def _assert_each_once(self, data, titles):
        self.assertCountEqual([c["title"] for c in data["cards"]], titles)
        names = [c["title"] for c in data["cards"]]
        relations = {(names[r["from"]], r["kind"], names[r["to"]]) for r in data["relations"]}
        self.assertIn(("Alpha", "blocks", "Beta"), relations)
        self.assertEqual(
            {frozenset((f, t)) for f, k, t in relations if k == "relates_to"},
            {frozenset(("Gamma", "Delta"))},
        )

    def test_first_page_card_moved_past_the_rest_is_emitted_once(self):
        refs = self.build_rich_board()
        data = self._export_with_change_after_first_page(
            lambda: Card.objects.filter(pk=refs["a"].pk).update(position=9),
        )
        self._assert_each_once(data, ["Alpha", "Beta", "Gamma", "Delta"])

    def test_unread_card_moved_before_the_first_page_is_not_skipped(self):
        refs = self.build_rich_board()
        data = self._export_with_change_after_first_page(
            lambda: Card.objects.filter(pk=refs["c"].pk).update(position=-1),
        )
        self._assert_each_once(data, ["Alpha", "Beta", "Gamma", "Delta"])

    def test_first_page_card_deleted_before_the_id_list_is_left_out(self):
        refs = self.build_rich_board()
        data = self._export_with_change_after_first_page(
            lambda: Card.objects.filter(pk=refs["b"].pk).delete(),
        )
        names = [c["title"] for c in data["cards"]]
        self.assertEqual(names, ["Alpha", "Delta", "Gamma"])
        relations = {(names[r["from"]], r["kind"], names[r["to"]]) for r in data["relations"]}
        self.assertEqual({frozenset((f, t)) for f, _, t in relations}, {frozenset(("Gamma", "Delta"))})
        # Not emitted as live, so its retained history is carried as deleted.
        self.assertIn(refs["b"].uid, [e["card_uid"] for e in data["deleted_card_history"]])

    def test_card_deleted_after_it_was_emitted_is_not_also_deleted_history(self):
        refs = self.build_rich_board()
        original = ie._iter_export_cards

        def deleting(queryset):
            for i, card in enumerate(original(queryset)):
                yield card
                if i == 0:
                    # Alpha is already in the file; its history is now retained
                    # with card NULL, which deleted_card_history reads.
                    Card.objects.filter(pk=refs["a"].pk).delete()

        with mock.patch.object(ie, "_EXPORT_CHUNK_SIZE", 2), mock.patch.object(ie, "_iter_export_cards", deleting):
            data = self.export_json()
        self.assertEqual([c["title"] for c in data["cards"]], ["Alpha", "Beta", "Delta", "Gamma"])
        uids = [e["card_uid"] for e in data["deleted_card_history"]]
        self.assertNotIn(refs["a"].uid, uids)
        self.assertIn(refs["deleted_uid"], uids)
