"""Integration tests for the MCP server (#511).

These require MCP_SERVER_ENABLED, which gates both the app registration and the
/mcp ASGI mount. They skip cleanly otherwise so a plain local `pytest` run never
errors on collection; CI runs them with the flag enabled.
"""
import pytest
from django.conf import settings

if not settings.MCP_SERVER_ENABLED:  # pragma: no cover - exercised only in the flagged CI job
    pytest.skip(
        "MCP server disabled; set MCP_SERVER_ENABLED=true to run these.",
        allow_module_level=True,
    )

import datetime
import json

import httpx
from asgiref.sync import async_to_sync
from django.test import TestCase
from django.utils import timezone

from accounts.models import PersonalAccessToken
from boards.models import BoardMembership
from boards.tests.conftest import (
    _make_board, _make_card, _make_column, _make_membership, _make_swimlane,
    _make_user,
)
from mcp_server.asgi_mount import McpPathRouter, build_mcp_asgi_app

PROTOCOL_VERSION = "2025-03-26"


async def _unreachable_django(scope, receive, send):  # pragma: no cover
    """Stand-in Django app: reaching it means /mcp dispatch was wrong."""
    raise AssertionError(f"request for {scope['path']} fell through to Django")


def _parse_sse(body):
    """Pull the JSON payload out of a Streamable-HTTP SSE response body."""
    for line in body.decode().splitlines():
        if line.startswith("data: "):
            return json.loads(line[len("data: "):])
    raise AssertionError(f"no SSE data frame in response: {body!r}")


class McpRequest:
    """Minimal ASGI caller so tests exercise the real mounted app.

    Deliberately drives the ASGI app directly rather than through Django's test
    client: /mcp is mounted outside Django's HTTP handler, so the test client
    would never reach it and the transport would go untested.
    """

    def __init__(self, app):
        self.app = app

    async def _call(self, payload, token=None, path="/mcp", raw_authorization=None):
        headers = {
            "content-type": "application/json",
            "accept": "application/json, text/event-stream",
        }
        if raw_authorization is not None:
            headers["authorization"] = raw_authorization
        elif token is not None:
            headers["authorization"] = f"Bearer {token}"

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app),
            # Must be a host in ALLOWED_HOSTS: the transport binds MCP's
            # DNS-rebinding protection to Django's own host allowlist.
            base_url="http://localhost",
        ) as client:
            response = await client.post(path, json=payload, headers=headers)
        return response.status_code, response.content

    def post(self, payload, token=None, path="/mcp", raw_authorization=None):
        return async_to_sync(self._call)(
            payload, token=token, path=path, raw_authorization=raw_authorization
        )


class McpTestCase(TestCase):
    """Shared setup: a user, a PAT, and a mounted MCP app."""

    def setUp(self):
        super().setUp()
        self.user = _make_user("mcp-owner")
        self.pat, self.raw_token = PersonalAccessToken.generate(self.user, "mcp")
        # Exercise the real mount (path dispatch + re-rooting + auth), not the
        # bare inner app — the routing is part of what #511 ships.
        self.client_ = McpRequest(
            McpPathRouter(_unreachable_django, build_mcp_asgi_app())
        )

    def _tools_call(self, name, token, arguments=None):
        return self.client_.post(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments or {}},
            },
            token=token,
        )


class BearerAuthTests(McpTestCase):
    """The transport must reject unauthenticated callers before any MCP parsing."""

    def _initialize(self, token, raw_authorization=None):
        return self.client_.post(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name": "test", "version": "1"},
                },
            },
            token=token,
            raw_authorization=raw_authorization,
        )

    def test_missing_authorization_header_is_401(self):
        status, body = self._initialize(token=None)
        self.assertEqual(status, 401)
        self.assertIn("Bearer", body.decode())

    def test_unknown_token_is_401(self):
        status, _ = self._initialize(token="vbn_" + "0" * 40)
        self.assertEqual(status, 401)

    def test_malformed_token_is_401(self):
        status, _ = self._initialize(token="not-a-visiban-token")
        self.assertEqual(status, 401)

    def test_token_scheme_is_rejected_on_mcp(self):
        """/mcp accepts Bearer only.

        The REST API's `Token ` scheme is intentionally NOT honored here, and
        conversely PATAuthentication still refuses `Bearer` — the two schemes
        stay scoped to their own transports even though both resolve the same
        PersonalAccessToken records.
        """
        status, _ = self._initialize(
            token=None,
            raw_authorization=f"Token {self.raw_token}".encode(),
        )
        self.assertEqual(status, 401)

    def test_expired_token_is_401(self):
        _, raw = PersonalAccessToken.generate(
            self.user, "expired",
            expires_at=timezone.now() - datetime.timedelta(days=1),
        )
        status, _ = self._initialize(token=raw)
        self.assertEqual(status, 401)

    def test_inactive_user_token_is_401(self):
        self.user.is_active = False
        self.user.save(update_fields=["is_active"])
        status, _ = self._initialize(token=self.raw_token)
        self.assertEqual(status, 401)

    def test_valid_token_completes_initialize_handshake(self):
        status, body = self._initialize(token=self.raw_token)
        self.assertEqual(status, 200)
        payload = _parse_sse(body)
        self.assertEqual(payload["jsonrpc"], "2.0")
        self.assertIn("result", payload)
        self.assertEqual(payload["result"]["serverInfo"]["name"], "visiban")

    def test_valid_token_stamps_last_used_at(self):
        self.assertIsNone(self.pat.last_used_at)
        self._initialize(token=self.raw_token)
        self.pat.refresh_from_db()
        self.assertIsNotNone(self.pat.last_used_at)

    def test_revoked_token_is_401(self):
        """Deleting the PAT (the product's revocation path) locks MCP out too."""
        self.pat.delete()
        status, _ = self._initialize(token=self.raw_token)
        self.assertEqual(status, 401)


class ToolDiscoveryTests(McpTestCase):
    def test_tools_list_exposes_list_boards(self):
        status, body = self.client_.post(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
            token=self.raw_token,
        )
        self.assertEqual(status, 200)
        tools = _parse_sse(body)["result"]["tools"]
        self.assertEqual([t["name"] for t in tools], ["list_boards"])

    def test_tools_list_requires_auth(self):
        status, _ = self.client_.post(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, token=None
        )
        self.assertEqual(status, 401)


class ListBoardsTests(McpTestCase):
    """End-to-end: auth -> handshake -> tools/call -> RBAC-filtered result."""

    def _call_list_boards(self, token):
        status, body = self._tools_call("list_boards", token)
        self.assertEqual(status, 200)
        payload = _parse_sse(body)
        self.assertNotIn("error", payload, payload)
        result = payload["result"]
        self.assertFalse(result["isError"], result)
        # FastMCP returns the tool's return value under structuredContent, with
        # the human-readable JSON mirrored per-item in `content`.
        return result["structuredContent"]["result"]

    def test_returns_only_boards_the_caller_can_access(self):
        mine = _make_board(self.user, name="Mine")
        stranger = _make_user("stranger")
        _make_board(stranger, name="Not mine")

        boards = self._call_list_boards(self.raw_token)
        self.assertEqual([b["name"] for b in boards], ["Mine"])
        self.assertEqual(boards[0]["id"], mine.id)

    def test_reports_the_callers_effective_role(self):
        other = _make_user("other-owner")
        board = _make_board(other, name="Shared")
        _make_membership(board, self.user, role=BoardMembership.Role.VIEWER)

        boards = self._call_list_boards(self.raw_token)
        self.assertEqual([(b["name"], b["role"]) for b in boards], [("Shared", "viewer")])

    def test_all_membership_roles_may_call_the_tool(self):
        other = _make_user("role-owner")
        for role in BoardMembership.Role.values:
            board = _make_board(other, name=f"Board {role}")
            _make_membership(board, self.user, role=role)

        boards = self._call_list_boards(self.raw_token)
        self.assertEqual(
            {b["role"] for b in boards}, set(BoardMembership.Role.values)
        )

    def test_counts_are_not_inflated_by_join_fan_out(self):
        """Three independent reverse relations must not cross-multiply.

        Without distinct=True on each Count, the three LEFT OUTER JOINs
        multiply and every count reports 2*3*4 = 24.
        """
        board = _make_board(self.user, name="Counted")
        columns = [_make_column(board, name=f"C{i}", order=i) for i in range(2)]
        swimlanes = [_make_swimlane(board, name=f"S{i}", order=i) for i in range(3)]
        for i in range(4):
            _make_card(columns[0], swimlanes[0], title=f"Card {i}", position=i)

        boards = self._call_list_boards(self.raw_token)
        self.assertEqual(len(boards), 1)
        self.assertEqual(boards[0]["column_count"], 2)
        self.assertEqual(boards[0]["swimlane_count"], 3)
        self.assertEqual(boards[0]["card_count"], 4)

    def test_card_count_excludes_archived_cards(self):
        board = _make_board(self.user, name="Archived")
        column = _make_column(board)
        swimlane = _make_swimlane(board)
        _make_card(column, swimlane, title="Live", position=0)
        _make_card(
            column, swimlane, title="Gone", position=1,
            archived_at=timezone.now(),
        )

        boards = self._call_list_boards(self.raw_token)
        self.assertEqual(boards[0]["card_count"], 1)

    def test_response_shape_matches_the_documented_contract(self):
        _make_board(self.user, name="Shape")
        board = self._call_list_boards(self.raw_token)[0]
        self.assertEqual(
            set(board),
            {
                "id", "uid", "name", "description", "role", "column_count",
                "swimlane_count", "card_count", "created_at", "updated_at",
            },
        )

    def test_owner_without_membership_row_is_reported_as_admin(self):
        """Ownership grants access even with no BoardMembership row."""
        from boards.models import Board

        board = Board.objects.create(name="Orphan", owner=self.user)
        boards = self._call_list_boards(self.raw_token)
        self.assertEqual([(b["name"], b["role"]) for b in boards], [("Orphan", "admin")])
        self.assertFalse(board.memberships.exists())

    def test_the_authenticated_user_reaches_the_tool(self):
        """The contextvar must survive the SDK's tool dispatch and sync_to_async.

        Two users with different boards must each see only their own — which
        can only hold if the per-request identity actually reaches the tool
        rather than leaking or defaulting.
        """
        _make_board(self.user, name="First user board")
        second = _make_user("second")
        _, second_token = PersonalAccessToken.generate(second, "mcp")
        _make_board(second, name="Second user board")

        self.assertEqual(
            [b["name"] for b in self._call_list_boards(self.raw_token)],
            ["First user board"],
        )
        self.assertEqual(
            [b["name"] for b in self._call_list_boards(second_token)],
            ["Second user board"],
        )


class AsgiRoutingTests(McpTestCase):
    """The mount must not disturb the rest of the ASGI application."""

    def test_non_mcp_paths_fall_through_to_django(self):
        from mcp_server.asgi_mount import McpPathRouter

        seen = {}

        async def fake_django(scope, receive, send):
            seen["path"] = scope["path"]
            seen["root_path"] = scope.get("root_path", "")
            await send({
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"content-type", b"application/json")],
            })
            await send({"type": "http.response.body", "body": b"{}"})

        router = McpPathRouter(fake_django, self.client_.app)
        status, _ = McpRequest(router).post(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
            token=self.raw_token, path="/api/v1/boards/",
        )
        self.assertEqual(status, 200)
        # Reaches Django with the path untouched — no MCP re-rooting applied.
        self.assertEqual(seen["path"], "/api/v1/boards/")
        self.assertEqual(seen["root_path"], "")

    def test_websocket_scope_is_not_intercepted(self):
        """Only http scopes reach the Bearer middleware; ws routing is untouched."""
        from mcp_server.auth import BearerAuthMiddleware

        seen = {}

        async def inner(scope, receive, send):
            seen["type"] = scope["type"]

        async def drive():
            await BearerAuthMiddleware(inner)(
                {"type": "websocket", "path": "/ws/boards/1/", "headers": []},
                None, None,
            )

        async_to_sync(drive)()
        self.assertEqual(seen["type"], "websocket")
