"""Cross-board card links on MCP and export: none in v1 (#2383, Rule 10).

``docs/development/security-invariants.md`` Rule 10: a second transport is no
broader than REST for the same role. A parent's children cross an
authorization boundary, so REST computes them per viewer in exactly one place
(``boards/services/card_links.py`` ``children_for_viewer``). In v1 links are
absent from MCP and export, and are not imported (Rule 5). These tests pin
that from both sides, so a later change that gives either transport a
"children" of its own fails here instead of shipping:

* no key in the output names a parent or child link, and
* the transport issues no query against the link table at all (a transport
  that reads links has to go through ``children_for_viewer``, and its tests
  then replace this file's assertion with a REST-parity one).

Importing an export that carries link-shaped keys creates no link.
"""

import csv
import io
import json
import re
from unittest import mock, skipUnless

from django.conf import settings
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext

from boards.models import Board, CardParentLink
from boards.tests.test_card_parent_links import _LinkFixture

LINK_TABLE = CardParentLink._meta.db_table
# A key that names a link end: parent, parent_id, children, child_ids, ...
LINK_KEY = re.compile(r"(^|_)(parent|parents|child|children)(_|$)", re.IGNORECASE)


def _keys(value):
    """Every dict key anywhere in ``value``."""
    if isinstance(value, dict):
        for key, item in value.items():
            yield str(key)
            yield from _keys(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _keys(item)


def _body(res):
    return b"".join(res.streaming_content) if getattr(res, "streaming", False) else res.content


def _link_queries(ctx):
    return [q["sql"] for q in ctx.captured_queries if LINK_TABLE in q["sql"]]


class _LinkedBoards(_LinkFixture):
    def _setup_linked(self):
        self._setup_boards()
        CardParentLink.objects.create(parent=self.parent, child=self.child, created_by=self.owner)

    def _assert_no_link_keys(self, payload, where):
        found = sorted({k for k in _keys(payload) if LINK_KEY.search(k)})
        self.assertEqual(found, [], f"{where} names a card link; route it through children_for_viewer")


class ExportLinkParityTests(_LinkedBoards, TestCase):
    def setUp(self):
        self._setup_linked()
        self.client = self._client(self.owner)

    def _export(self, board, fmt):
        with CaptureQueriesContext(connection) as ctx:
            res = self.client.get(f"/api/v1/boards/{board.pk}/export/?format={fmt}")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(_link_queries(ctx), [], f"{fmt} export of {board.name} read the link table")
        return res

    def test_json_export_of_either_board_carries_no_link(self):
        for board in (self.pboard, self.cboard):
            data = json.loads(_body(self._export(board, "json")))
            self._assert_no_link_keys(data, f"JSON export of {board.name}")

    def test_csv_export_of_either_board_carries_no_link(self):
        for board in (self.pboard, self.cboard):
            body = _body(self._export(board, "csv"))
            header = next(csv.reader(io.StringIO(body.decode("utf-8-sig"))))
            self.assertEqual([h for h in header if LINK_KEY.search(h)], [], header)

    def test_import_of_an_export_with_link_keys_creates_no_link(self):
        exported = json.loads(_body(self._export(self.cboard, "json")))
        for card in exported["cards"]:
            card["parent_id"] = self.parent.pk
            card["parent"] = {"id": self.parent.pk}
        exported["name"] = "Re-imported 2383"
        f = io.BytesIO(json.dumps(exported).encode("utf-8"))
        f.name = "board.json"
        res = self.client.post("/api/v1/boards/import/", {"file": f}, format="multipart")
        self.assertEqual(res.status_code, 201, res.content)
        new_board = Board.objects.get(pk=res.data["id"])
        self.assertTrue(new_board.cards.exists())
        self.assertEqual(
            list(CardParentLink.objects.values_list("parent_id", "child_id")),
            [(self.parent.pk, self.child.pk)],
        )
        self.assertFalse(CardParentLink.objects.filter(child__board=new_board).exists())


@skipUnless(settings.MCP_SERVER_ENABLED, "MCP server disabled; set MCP_SERVER_ENABLED=true to run these.")
class McpLinkParityTests(_LinkedBoards, TestCase):
    def setUp(self):
        self._setup_linked()

    def _call(self, fn, **kwargs):
        with mock.patch("mcp_server.tools.get_current_user", return_value=self.owner):
            with CaptureQueriesContext(connection) as ctx:
                result = fn(**kwargs)
        self.assertEqual(_link_queries(ctx), [], f"MCP {fn.__name__} read the link table")
        return result

    def test_card_shapes_carry_no_link(self):
        from mcp_server import tools

        for card in (self.parent, self.child):
            self._assert_no_link_keys(tools._serialize_card(card), "MCP _serialize_card")
            detail = self._call(tools.card_detail, card_id=card.pk)
            self._assert_no_link_keys(detail, "MCP card_detail")
        for board in (self.pboard, self.cboard):
            listed = self._call(tools.list_cards, board_id=board.pk, include_meta=True)
            self.assertTrue(listed)
            self._assert_no_link_keys(listed, "MCP list_cards")
