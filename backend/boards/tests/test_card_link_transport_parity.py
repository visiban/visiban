"""Cross-board card links on MCP and export: none in v1 (#2383, Rule 10).

``docs/development/security-invariants.md`` Rule 10: a second transport is no
broader than REST for the same role. A parent's children cross an
authorization boundary, so REST computes them per viewer in exactly one place
(``boards/services/card_links.py`` ``children_for_viewer``). In v1 links are
absent from MCP and export, and are not imported (Rule 5). These tests pin
that from both sides, so a later change that gives either transport a
"children" of its own fails here instead of shipping:

* no key in the output names a parent or child link, and
* the transport issues no query against the link table (a transport that
  reads links has to go through ``children_for_viewer``, and its tests then
  replace this file's assertion with a REST-parity one), except the
  planned-state predicate of #2371 (``PLANNED_CLOCK_SQL``): a boolean EXISTS
  and the child's own release time, keyed on the card, never a parent id.

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
from rest_framework.test import APIClient

from boards.models import Board, Card, CardParentLink, CardParentUnlink
from boards.tests.test_card_parent_links import _LinkFixture

LINK_TABLE = CardParentLink._meta.db_table
# #2447: the unlinked-pair table is read only by the link write and the Link
# existing picker; no other transport may read or carry it either.
UNLINK_TABLE = CardParentUnlink._meta.db_table
# A key that names a link end: parent, parent_id, children, child_ids,
# card_links, links, linked_cards, ...
LINK_KEY = re.compile(r"(^|_)(parent|parents|child|children|link|links|linked)(_|$)", re.IGNORECASE)
# Board-level settings whose names match LINK_KEY but carry no link: the
# parent-item terminology and the child-cards flag, exported and imported
# since #2454. Exact names only, so a real link key never hides behind this;
# the no-link-table-query assertion still guards what they cannot.
NOT_LINK_KEYS = frozenset({"parent_name_singular", "parent_name_plural", "cards_can_have_children"})


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


# The ONE allowed read of the link table on these transports (#2371, owner
# decision on Stale/Overdue parity): ``card_signals.planned_link_exists`` (a
# boolean EXISTS) and ``planned_released_at`` (the child's own release time),
# both keyed on the outer card's id and filtered only by the planned state.
# Neither selects ``parent_id`` or a ``needed_at_column_id`` value, so neither
# can name, count or locate a parent. The pattern is exact on purpose: any
# other shape of link read (a join, a parent_id, a column id) is not stripped
# and still fails ``_link_queries``.
PLANNED_CLOCK_SQL = re.compile(
    r'\(SELECT (?:1 AS "a"|U\d+\."planned_released_at" AS "planned_released_at") FROM "%s" U\d+ '
    r'WHERE \(U\d+\."child_id" = \("cards"\."id"\) AND U\d+\."needed_at_column_id" IS NOT NULL '
    r'AND U\d+\."planned_released_at" IS (?:NOT )?NULL\) LIMIT 1\)' % re.escape(LINK_TABLE)
)


def _link_queries(ctx):
    """Queries that read the link tables beyond the planned-state predicate."""
    out = []
    for q in ctx.captured_queries:
        sql = PLANNED_CLOCK_SQL.sub("(planned)", q["sql"])
        if LINK_TABLE in sql or UNLINK_TABLE in sql:
            out.append(q["sql"])
    return out


def _planned_reads(ctx):
    return [q["sql"] for q in ctx.captured_queries if PLANNED_CLOCK_SQL.search(q["sql"])]


class _LinkedBoards(_LinkFixture):
    def _setup_linked(self):
        self._setup_boards()
        CardParentLink.objects.create(parent=self.parent, child=self.child, created_by=self.owner)
        # A second child, linked and then unlinked, leaves an unlinked-pair row
        # (#2447) that no transport below may read or name.
        self.former_child = Card.objects.create(
            board=self.cboard, column=self.col_c, swimlane=self.lane_c, title="Former child", position=1,
        )
        CardParentUnlink.objects.create(parent=self.parent, child=self.former_child)

    def _assert_no_link_keys(self, payload, where):
        found = sorted({k for k in _keys(payload) if LINK_KEY.search(k) and k not in NOT_LINK_KEYS})
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
        # Nor an unlinked-pair row (#2447): import never writes that table.
        self.assertEqual(
            list(CardParentUnlink.objects.values_list("parent_id", "child_id")),
            [(self.parent.pk, self.former_child.pk)],
        )


class ShareLinkParityTests(_LinkedBoards, TestCase):
    """The public share view stays link-free while ``/full/`` carries ``parent``."""

    def setUp(self):
        self._setup_linked()
        self.client = self._client(self.owner)

    def test_public_share_cards_carry_no_parent_but_full_does(self):
        res = self.client.post(f"/api/v1/boards/{self.cboard.pk}/share/")
        self.assertEqual(res.status_code, 200, res.content)
        token = res.data["share_token"]
        # The authenticated read carries the parent, so the public assertion
        # below cannot pass only because the fixture has no link to show.
        full = self.client.get(f"/api/v1/boards/{self.cboard.pk}/full/").json()
        linked = [c for c in full["cards"] if c["id"] == self.child.pk]
        self.assertEqual(len(linked), 1)
        self.assertIn("parent", linked[0])
        with CaptureQueriesContext(connection) as ctx:
            public = APIClient().get(f"/api/share/{token}/")
        self.assertEqual(public.status_code, 200, public.content)
        body = public.json()
        self.assertTrue(body["cards"])
        for card in body["cards"]:
            self.assertNotIn("parent", card)
        self._assert_no_link_keys(body["cards"], "public share cards")
        self.assertEqual(_link_queries(ctx), [], "the public share view read the link table")
        # The planned predicate (#2371) is the read that IS allowed: it is
        # present (so the narrowing above is not vacuous) and names no parent.
        planned = _planned_reads(ctx)
        self.assertTrue(planned, "the share view should apply the planned Stale rule")
        for sql in planned:
            self.assertNotIn('"parent_id"', sql)

    def test_planned_clock_pattern_strips_only_the_planned_predicate(self):
        from boards.serializers import _annotate_planned_clock

        sql = str(_annotate_planned_clock(Card.objects.filter(pk=1)).query)
        self.assertEqual(len(PLANNED_CLOCK_SQL.findall(sql)), 2)
        self.assertNotIn(LINK_TABLE, PLANNED_CLOCK_SQL.sub("(planned)", sql))
        # A read that selects the parent is not the allowed shape.
        leak = str(Card.objects.filter(pk=1).values("parent_link__parent_id").query)
        self.assertIn(LINK_TABLE, PLANNED_CLOCK_SQL.sub("(planned)", leak))


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
            snapshot = self._call(tools.board_snapshot, board_id=board.pk)
            self.assertTrue(snapshot["cards"])
            self._assert_no_link_keys(snapshot, "MCP board_snapshot")
            aging = self._call(tools.aging_cards, board_id=board.pk)
            self._assert_no_link_keys(aging, "MCP aging_cards")
