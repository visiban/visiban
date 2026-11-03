"""Lone UTF-16 surrogates in MCP tool arguments (#2085).

``"\\ud800"`` is valid JSON but decodes to a ``str`` UTF-8 cannot encode, so
psycopg raised ``UnicodeEncodeError`` on PostgreSQL. The SDK's legacy transport
rejects it while parsing the JSON-RPC body (JSON-RPC -32700), but its modern
transport (``mcp-protocol-version: 2026-07-28``) decodes with stdlib
``json.loads``, and a ``labels`` argument sent as a JSON-encoded string is
decoded only after the transport. So ``server._throttled`` refuses it, before
any tool logic, as the tools' ordinary ``validation_error``. On the legacy
transport a raw surrogate escape in the body is still refused by the SDK
itself (HTTP 400, JSON-RPC -32700), which these tests pin too.

Every test below runs on BOTH transports. The argument matrix is built from the
registered tools' input schemas, so a tool added later is covered without
editing this file.
"""
import asyncio
import json

from django.core.cache import cache

from boards.models import Card, CardActivity
from mcp_server.server import build_mcp_server

from .test_mcp import _parse_sse
from .test_mcp_crud import CrudToolsTestCase

BAD = "a\ud800b"
MODERN_VERSION = "2026-07-28"
# The arguments the issue names must each be exercised by name, whatever the schemas say.
NAMED_ARGUMENTS = {"assignee", "labels", "title", "description", "reason"}


def _string_arguments():
    """``[(tool, argument, is_list)]`` for every string-typed argument of every registered tool."""
    tools = asyncio.run(build_mcp_server().list_tools())
    found = []
    for tool in tools:
        for name, schema in (tool.input_schema.get("properties") or {}).items():
            variants = schema.get("anyOf") or [schema]
            if any(v.get("type") == "string" for v in variants):
                found.append((tool.name, name, False))
            elif any(v.get("type") == "array" and v.get("items", {}).get("type") == "string" for v in variants):
                found.append((tool.name, name, True))
    return found


class SurrogateArgumentTests(CrudToolsTestCase):
    def setUp(self):
        super().setUp()
        self.card = Card.objects.create(
            board=self.board, column=self.column, swimlane=self.swimlane,
            title="Untouched", created_by=self.user, position=0,
        )

    def _base_arguments(self):
        return {
            "board_id": self.board.id, "column_id": self.column.id,
            "swimlane_id": self.swimlane.id, "card_id": self.card.id,
            "title": "Sur card", "reason": "r",
        }

    def _send(self, transport, name, arguments):
        params = {"name": name, "arguments": arguments}
        headers = None
        if transport == "modern":
            params["_meta"] = {
                "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
                "io.modelcontextprotocol/clientCapabilities": {},
            }
            headers = {
                "mcp-protocol-version": MODERN_VERSION,
                "mcp-method": "tools/call",
                "mcp-name": name,
            }
        return self.client_.post(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": params},
            token=self.write_token, extra_headers=headers,
        )

    def _result(self, status, body):
        self.assertEqual(status, 200, body)
        # The modern transport answers plain JSON, the legacy one an SSE frame.
        decoded = json.loads(body) if body.lstrip().startswith(b"{") else _parse_sse(body)
        result = decoded["result"]
        return result["structuredContent"]["result"] if "structuredContent" in result else result

    def _assert_refused(self, transport, tool, argument, value, encoded=False):
        arguments = {k: v for k, v in self._base_arguments().items() if k in self._accepted(tool)}
        arguments[argument] = value
        cards, activities = Card.objects.count(), CardActivity.objects.count()
        status, body = self._send(transport, tool, arguments)
        label = f"{transport}:{tool}.{argument}"
        if transport == "legacy" and not encoded:
            # The legacy transport's JSON parser rejects the escape itself, before
            # any tool is reached: JSON-RPC parse error, HTTP 400, never a 500.
            self.assertEqual(status, 400, (label, body))
            self.assertEqual(json.loads(body)["error"]["code"], -32700, label)
            self.assertEqual((Card.objects.count(), CardActivity.objects.count()), (cards, activities), label)
            return
        payload = self._result(status, body)
        self.assertEqual(payload["error"]["code"], "validation_error", (label, payload))
        self.assertIn(argument, payload["error"]["errors"], label)
        self.assertEqual(
            payload["error"]["errors"][argument], ["Surrogate characters are not allowed: U+D800."], label
        )
        self.assertNotIn(b"Error executing", body, label)
        self.assertEqual((Card.objects.count(), CardActivity.objects.count()), (cards, activities), label)
        self.card.refresh_from_db()
        self.assertEqual(self.card.title, "Untouched", label)

    def _accepted(self, tool):
        schemas = {t.name: t for t in asyncio.run(build_mcp_server().list_tools())}
        return set(schemas[tool].input_schema.get("properties") or {})

    def test_the_matrix_covers_the_arguments_the_issue_names(self):
        self.assertTrue(NAMED_ARGUMENTS <= {name for _, name, _ in _string_arguments()})
        self.assertGreaterEqual(len(_string_arguments()), 12)

    def test_every_string_argument_of_every_tool_is_refused_on_both_transports(self):
        for transport in ("legacy", "modern"):
            cache.clear()  # the per-token throttle must not turn a later call away
            for tool, argument, is_list in _string_arguments():
                with self.subTest(transport=transport, tool=tool, argument=argument):
                    self._assert_refused(transport, tool, argument, [BAD] if is_list else BAD)

    def test_a_surrogate_nested_in_a_list_entry_is_refused(self):
        for transport in ("legacy", "modern"):
            with self.subTest(transport=transport):
                self._assert_refused(transport, "create_card", "labels", ["ok", BAD])

    def test_labels_sent_as_a_json_encoded_string_is_refused(self):
        # The SDK decodes this string into a list after the transport, so the
        # surrogate escape is only a literal backslash sequence on the wire.
        for transport in ("legacy", "modern"):
            for tool in ("create_card", "update_card"):
                with self.subTest(transport=transport, tool=tool):
                    self._assert_refused(transport, tool, "labels", json.dumps([BAD], ensure_ascii=True), encoded=True)

    def test_valid_surrogate_pair_in_title_is_created_on_both_transports(self):
        for transport in ("legacy", "modern"):
            with self.subTest(transport=transport):
                arguments = {
                    "board_id": self.board.id, "column_id": self.column.id,
                    "swimlane_id": self.swimlane.id, "title": f"Party \U0001F600 {transport}",
                }
                status, body = self._send(transport, "create_card", arguments)
                result = self._result(status, body)
                self.assertEqual(result["title"], f"Party \U0001F600 {transport}")
                self.assertTrue(Card.objects.filter(title=f"Party \U0001F600 {transport}").exists())
