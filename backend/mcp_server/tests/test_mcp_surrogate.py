"""Lone UTF-16 surrogates in MCP string arguments (#2085).

The MCP SDK parses the JSON-RPC body strictly and refuses a lone surrogate at
the transport (JSON-RPC -32700, HTTP 400) before any tool runs, so no tool
argument can carry one to PostgreSQL. These tests pin that: if an SDK upgrade
starts accepting the escape, the tool call would reach ``assignee`` lookups
and ``Card`` writes as a 500, and this fails first.
"""
from boards.models import Card

from .test_mcp import _parse_sse
from .test_mcp_crud import CrudToolsTestCase

BAD = "a\ud800b"


class SurrogateArgumentTests(CrudToolsTestCase):
    def _create(self, **overrides):
        arguments = {
            "board_id": self.board.id, "column_id": self.column.id,
            "swimlane_id": self.swimlane.id, "title": "Sur card",
        }
        arguments.update(overrides)
        return self._tools_call("create_card", self.write_token, arguments)

    def test_lone_surrogate_in_any_string_argument_is_refused_not_a_500(self):
        for argument, value in (
            ("assignee", BAD), ("title", BAD), ("description", BAD),
            ("priority", BAD), ("labels", ["ok", BAD]),
        ):
            with self.subTest(argument=argument):
                status, body = self._create(**{argument: value})
                self.assertEqual(status, 400, body)
                self.assertIn(b'"error"', body)
                self.assertNotIn(b"Internal", body)
        self.assertFalse(Card.objects.filter(title__startswith="Sur card").exists())

    def test_lone_surrogate_in_update_card_reason_arguments_is_refused(self):
        card = Card.objects.create(
            board=self.board, column=self.column, swimlane=self.swimlane,
            title="Untouched", created_by=self.user, position=0,
        )
        status, body = self._tools_call(
            "update_card", self.write_token, {"card_id": card.id, "assignee": BAD},
        )
        self.assertEqual(status, 400, body)
        card.refresh_from_db()
        self.assertEqual(card.title, "Untouched")

    def test_valid_surrogate_pair_in_title_is_created(self):
        status, body = self._create(title="Party \U0001F600")
        self.assertEqual(status, 200, body)
        result = _parse_sse(body)["result"]["structuredContent"]["result"]
        self.assertEqual(result["title"], "Party \U0001F600")
        self.assertTrue(Card.objects.filter(title="Party \U0001F600").exists())
