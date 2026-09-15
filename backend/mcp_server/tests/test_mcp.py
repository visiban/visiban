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
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from accounts.models import (
    SCOPE_MCP_READ,
    SCOPE_MCP_WRITE,
    SCOPE_READ,
    SCOPE_WRITE,
    PersonalAccessToken,
)
from boards.models import (
    BoardMembership, CardActivity, CardChecklist, CardComment, Label,
)
from boards.tests.conftest import (
    _make_board, _make_card, _make_column, _make_membership, _make_swimlane,
    _make_user,
)
from mcp_server import tools
from mcp_server.asgi_mount import McpPathRouter, build_mcp_asgi_app
from mcp_server.context import (
    get_current_user, reset_current_user, set_current_user,
)

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
        # MCP requires the mcp:read scope (#1110) — an unscoped/legacy token is
        # rejected at the transport, so every MCP fixture must opt in explicitly.
        self.pat, self.raw_token = PersonalAccessToken.generate(
            self.user, "mcp", scopes=[SCOPE_MCP_READ]
        )
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

    def _read_resource(self, uri, token):
        return self.client_.post(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "resources/read",
                "params": {"uri": uri},
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
            scopes=[SCOPE_MCP_READ],
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

    # ── Scope enforcement (#1110) ────────────────────────────────────────

    def test_legacy_unscoped_token_is_rejected(self):
        """The one place a legacy token's full REST authority does NOT carry.

        A token issued before scopes existed was never consented to be used as
        an agent credential, so it cannot reach MCP no matter how much it can
        do over REST.
        """
        _, raw = PersonalAccessToken.generate(self.user, "legacy")
        status, _ = self._initialize(token=raw)
        self.assertEqual(status, 401)

    def test_rest_read_scope_does_not_satisfy_mcp(self):
        """Non-hierarchical: `read` is a REST grant, not an agent grant."""
        _, raw = PersonalAccessToken.generate(
            self.user, "rest", scopes=[SCOPE_READ, SCOPE_WRITE]
        )
        status, _ = self._initialize(token=raw)
        self.assertEqual(status, 401)

    def test_mcp_write_alone_does_not_satisfy_mcp_read(self):
        """No implication inside the mcp namespace either."""
        _, raw = PersonalAccessToken.generate(
            self.user, "writer", scopes=[SCOPE_MCP_WRITE]
        )
        status, _ = self._initialize(token=raw)
        self.assertEqual(status, 401)

    def test_empty_scope_list_is_rejected(self):
        _, raw = PersonalAccessToken.generate(self.user, "none", scopes=[])
        status, _ = self._initialize(token=raw)
        self.assertEqual(status, 401)

    def test_scope_denial_does_not_stamp_usage(self):
        """A denied request must not record authority it never exercised."""
        pat, raw = PersonalAccessToken.generate(
            self.user, "rest-only", scopes=[SCOPE_READ]
        )
        self._initialize(token=raw)
        pat.refresh_from_db()
        self.assertIsNone(pat.last_used_at)
        self.assertIsNone(pat.last_used_scope)

    def test_valid_token_stamps_the_mcp_scope_it_presented(self):
        self._initialize(token=self.raw_token)
        self.pat.refresh_from_db()
        self.assertEqual(self.pat.last_used_scope, SCOPE_MCP_READ)


class ToolDiscoveryTests(McpTestCase):
    def test_tools_list_exposes_every_registered_tool(self):
        status, body = self.client_.post(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
            token=self.raw_token,
        )
        self.assertEqual(status, 200)
        tools = _parse_sse(body)["result"]["tools"]
        # #512 added the six CRUD tools alongside #511's list_boards. Order is
        # registration order (server.py), not asserted — only the full set is.
        self.assertEqual(
            {t["name"] for t in tools},
            {
                "list_boards", "list_columns", "list_swimlanes", "list_cards",
                "create_card", "move_card", "update_card", "archive_card",
            },
        )

    def test_tools_list_requires_auth(self):
        status, _ = self.client_.post(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, token=None
        )
        self.assertEqual(status, 401)

    def test_resource_templates_list_exposes_both_resources(self):
        """#513: board:// and card:// must be discoverable, not just callable."""
        status, body = self.client_.post(
            {"jsonrpc": "2.0", "id": 1, "method": "resources/templates/list"},
            token=self.raw_token,
        )
        self.assertEqual(status, 200)
        templates = _parse_sse(body)["result"]["resourceTemplates"]
        self.assertEqual(
            {(t["uriTemplate"], t["mimeType"]) for t in templates},
            {("board://{board_id}", "application/json"), ("card://{card_id}", "application/json")},
        )

    def test_resources_read_requires_auth(self):
        status, _ = self.client_.post(
            {
                "jsonrpc": "2.0", "id": 1, "method": "resources/read",
                "params": {"uri": "board://1"},
            },
            token=None,
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

    def test_group_inherited_access_is_visible(self):
        """A board reached only through group membership must be returned.

        This is the branch of get_board_role() that walks the group ancestor
        chain — the user has no BoardMembership row at all, so a tool that
        queried memberships directly would silently omit the board.
        """
        from groups.models import Group, GroupMembership

        other = _make_user("group-board-owner")
        group = Group.objects.create(name="Eng", owner=other)
        GroupMembership.objects.create(
            group=group, user=self.user, role=GroupMembership.Role.MEMBER
        )
        board = _make_board(other, name="Group board")
        board.group = group
        board.save(update_fields=["group"])

        boards = self._call_list_boards(self.raw_token)
        self.assertEqual(
            [(b["name"], b["role"]) for b in boards], [("Group board", "member")]
        )
        self.assertFalse(board.memberships.filter(user=self.user).exists())

    def test_site_admin_sees_every_board_with_the_site_admin_role(self):
        """can_access_all_content bypasses per-board access entirely.

        The reported role is the `site_admin` sentinel, which is deliberately
        not a BoardMembership.Role value — it is documented as a distinct value
        because it is not a revocable per-board membership.
        """
        self.user.can_access_all_content = True
        self.user.save(update_fields=["can_access_all_content"])
        other = _make_user("unrelated-owner")
        _make_board(other, name="Someone else's board")

        boards = self._call_list_boards(self.raw_token)
        self.assertIn("Someone else's board", [b["name"] for b in boards])
        self.assertTrue(all(b["role"] == "site_admin" for b in boards), boards)

    def test_the_authenticated_user_reaches_the_tool(self):
        """The contextvar must survive the SDK's tool dispatch and sync_to_async.

        Two users with different boards must each see only their own — which
        can only hold if the per-request identity actually reaches the tool
        rather than leaking or defaulting.
        """
        _make_board(self.user, name="First user board")
        second = _make_user("second")
        _, second_token = PersonalAccessToken.generate(
            second, "mcp", scopes=[SCOPE_MCP_READ]
        )
        _make_board(second, name="Second user board")

        self.assertEqual(
            [b["name"] for b in self._call_list_boards(self.raw_token)],
            ["First user board"],
        )
        self.assertEqual(
            [b["name"] for b in self._call_list_boards(second_token)],
            ["Second user board"],
        )


class BoardResourceTests(McpTestCase):
    """`board://{board_id}` — full snapshot, content + RBAC (#513)."""

    def _read_board(self, board_id, token=None):
        status, body = self._read_resource(f"board://{board_id}", token or self.raw_token)
        self.assertEqual(status, 200)
        payload = _parse_sse(body)
        self.assertNotIn("error", payload, payload)
        contents = payload["result"]["contents"]
        self.assertEqual(len(contents), 1)
        return json.loads(contents[0]["text"])

    def _read_board_error(self, board_id, token=None):
        status, body = self._read_resource(f"board://{board_id}", token or self.raw_token)
        self.assertEqual(status, 200)
        payload = _parse_sse(body)
        self.assertIn("error", payload, payload)
        return payload["error"]["message"]

    def test_snapshot_shape_and_content(self):
        board = _make_board(self.user, name="Snapshot", description="d")
        column = _make_column(board, name="Doing", order=0)
        swimlane = _make_swimlane(board, name="Lane", order=0)
        Label.objects.create(board=board, name="bug", color="#FF0000")
        _make_card(column, swimlane, title="Card A", position=0)
        _make_card(
            column, swimlane, title="Archived", position=1,
            archived_at=timezone.now(),
        )

        data = self._read_board(board.id)
        self.assertEqual(
            set(data),
            {"id", "name", "description", "created_at", "updated_at",
             "columns", "swimlanes", "cards", "labels"},
        )
        self.assertEqual(data["id"], board.id)
        self.assertEqual(data["name"], "Snapshot")
        self.assertEqual([c["name"] for c in data["columns"]], ["Doing"])
        self.assertEqual([s["name"] for s in data["swimlanes"]], ["Lane"])
        # Archived cards are excluded — an agent reasoning about "the board"
        # wants the active board state, matching list_cards' default.
        self.assertEqual([c["title"] for c in data["cards"]], ["Card A"])
        self.assertEqual([label["name"] for label in data["labels"]], ["bug"])

    def test_web_only_fields_are_never_exposed(self):
        """share_token and friends must never reach an AI agent (#513 architect finding)."""
        board = _make_board(self.user, name="NoLeak")
        data = self._read_board(board.id)
        for leaky_field in (
            "share_token", "share_token_expires_at", "capabilities",
            "is_starred", "current_user_role", "members", "uid",
        ):
            self.assertNotIn(leaky_field, data)

    def test_swimlane_contact_email_is_admin_only(self):
        board = _make_board(self.user, name="Contact")
        _make_swimlane(board, name="Lane", order=0, contact_email="a@example.com")
        viewer = _make_user("viewer-board")
        _make_membership(board, viewer, role=BoardMembership.Role.VIEWER)
        _, viewer_token = PersonalAccessToken.generate(
            viewer, "mcp", scopes=[SCOPE_MCP_READ]
        )

        admin_data = self._read_board(board.id)
        self.assertEqual(admin_data["swimlanes"][0]["contact_email"], "a@example.com")

        viewer_data = self._read_board(board.id, token=viewer_token)
        self.assertNotIn("contact_email", viewer_data["swimlanes"][0])

    def test_nonexistent_and_forbidden_board_return_the_identical_error(self):
        """IDOR: a non-member must not be able to tell "no access" from "doesn't exist"."""
        stranger = _make_user("stranger-board")
        board = _make_board(stranger, name="Not yours")

        nonexistent_message = self._read_board_error(999999)
        forbidden_message = self._read_board_error(board.id)
        self.assertIn("No Board matches the given query.", nonexistent_message)
        self.assertIn("No Board matches the given query.", forbidden_message)

    def test_all_board_roles_may_read_the_snapshot(self):
        other = _make_user("role-owner-snap")
        for role in BoardMembership.Role.values:
            board = _make_board(other, name=f"Board {role}")
            _make_membership(board, self.user, role=role)
            data = self._read_board(board.id)
            self.assertEqual(data["name"], f"Board {role}")


class CardResourceTests(McpTestCase):
    """`card://{card_id}` — detail + full audit history, content + RBAC (#513)."""

    def _read_card(self, card_id, token=None):
        status, body = self._read_resource(f"card://{card_id}", token or self.raw_token)
        self.assertEqual(status, 200)
        payload = _parse_sse(body)
        self.assertNotIn("error", payload, payload)
        contents = payload["result"]["contents"]
        return json.loads(contents[0]["text"])

    def _read_card_error(self, card_id, token=None):
        status, body = self._read_resource(f"card://{card_id}", token or self.raw_token)
        self.assertEqual(status, 200)
        payload = _parse_sse(body)
        self.assertIn("error", payload, payload)
        return payload["error"]["message"]

    def _setup_card(self):
        board = _make_board(self.user, name="CardRes")
        column = _make_column(board, name="Doing", order=0)
        swimlane = _make_swimlane(board, name="Lane", order=0)
        return _make_card(column, swimlane, title="Detailed", position=0)

    def test_detail_shape_and_content(self):
        card = self._setup_card()
        CardChecklist.objects.create(card=card, text="Write tests", position=0)
        CardComment.objects.create(card=card, author=self.user, body="hello")
        CardActivity.objects.create(
            card=card, event_type=CardActivity.EventType.TITLE_CHANGE,
            from_value="Old", to_value="Detailed", actor=self.user,
        )

        data = self._read_card(card.id)
        self.assertEqual(
            set(data),
            {
                "id", "title", "description", "priority", "assignee", "labels",
                "column", "swimlane", "due_date", "position", "created_at",
                "updated_at", "archived_at", "movements", "checklist_items",
                "activities", "comments",
            },
        )
        self.assertEqual(data["title"], "Detailed")
        self.assertIsNone(data["archived_at"])
        self.assertEqual([i["text"] for i in data["checklist_items"]], ["Write tests"])
        self.assertEqual([c["body"] for c in data["comments"]], ["hello"])
        self.assertEqual(data["comments"][0]["author"], self.user.email)
        self.assertEqual(
            [a["event_type"] for a in data["activities"]],
            [CardActivity.EventType.TITLE_CHANGE],
        )

    def test_movement_history_is_included(self):
        card = self._setup_card()
        board = card.board
        second_column = _make_column(board, name="Done", order=1)
        # move_card resolves the actor internally via the same contextvar the
        # transport binds per-request; reset in `finally` so this leftover
        # binding cannot leak into a later test in the same OS thread — this
        # test calls tools.move_card() directly, bypassing the transport's
        # own set/reset-in-finally in mcp_server/auth.py.
        token = set_current_user(self.user)
        try:
            result = tools.move_card(card_id=card.id, to_column_id=second_column.id)
        finally:
            reset_current_user(token)
        self.assertNotIn("error", result, result)

        data = self._read_card(card.id)
        self.assertEqual(len(data["movements"]), 1)
        movement = data["movements"][0]
        self.assertEqual(movement["to_column"], "Done")
        self.assertEqual(movement["moved_by"], self.user.email)

    def test_nonexistent_and_forbidden_card_return_the_identical_error(self):
        """IDOR: mirrors the board:// guarantee for a card on a board the caller cannot see."""
        stranger = _make_user("stranger-card")
        board = _make_board(stranger, name="Not yours")
        column = _make_column(board)
        swimlane = _make_swimlane(board)
        card = _make_card(column, swimlane, title="Hidden")

        nonexistent_message = self._read_card_error(999999)
        forbidden_message = self._read_card_error(card.id)
        self.assertIn("No Card matches the given query.", nonexistent_message)
        self.assertIn("No Card matches the given query.", forbidden_message)

    def test_all_board_roles_may_read_the_card(self):
        other = _make_user("role-owner-card")
        board = _make_board(other, name="RoleCard")
        column = _make_column(board)
        swimlane = _make_swimlane(board)
        card = _make_card(column, swimlane, title="Shared card")
        for role in BoardMembership.Role.values:
            user = _make_user(f"reader-{role}")
            _make_membership(board, user, role=role)
            _, token = PersonalAccessToken.generate(user, "mcp", scopes=[SCOPE_MCP_READ])
            data = self._read_card(card.id, token=token)
            self.assertEqual(data["title"], "Shared card")


class McpCorsTests(McpTestCase):
    """CORS headers on /mcp so a browser-based MCP client can reach it (#513).

    Drives httpx directly against the mounted app rather than through
    ``McpRequest`` (which always issues an authenticated POST): a CORS
    preflight is a real, unauthenticated ``OPTIONS`` request, and asserting
    on raw response headers needs the underlying httpx.Response rather than
    ``McpRequest``'s ``(status, body)`` tuple.
    """

    def _options(self, origin, request_headers="authorization,content-type"):
        import httpx
        from asgiref.sync import async_to_sync

        async def _call():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=self.client_.app),
                base_url="http://localhost",
            ) as client:
                return await client.options(
                    "/mcp",
                    headers={
                        "origin": origin,
                        "access-control-request-method": "POST",
                        "access-control-request-headers": request_headers,
                    },
                )

        return async_to_sync(_call)()

    def _post_raw(self, origin, token):
        import httpx
        from asgiref.sync import async_to_sync

        async def _call():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=self.client_.app),
                base_url="http://localhost",
            ) as client:
                return await client.post(
                    "/mcp",
                    json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                    headers={
                        "origin": origin,
                        "authorization": f"Bearer {token}",
                        "content-type": "application/json",
                        "accept": "application/json, text/event-stream",
                    },
                )

        return async_to_sync(_call)()

    def test_preflight_from_allowed_origin_gets_cors_headers(self):
        response = self._options("http://localhost:5173")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["access-control-allow-origin"], "http://localhost:5173")
        self.assertIn("POST", response.headers["access-control-allow-methods"])
        self.assertIn("authorization", response.headers["access-control-allow-headers"].lower())
        self.assertEqual(response.headers["access-control-allow-credentials"], "true")
        # Exactly one Vary header, not two — _response_headers() and
        # _send_preflight() must not each add their own copy.
        self.assertEqual(response.headers.get_list("vary"), ["Origin"])

    def test_preflight_from_disallowed_origin_gets_no_cors_headers(self):
        """An origin absent from CORS_ALLOWED_ORIGINS gets a plain 200, no headers.

        Not a 403/error — an error response would confirm to a probing
        browser that /mcp exists and specifically rejected this origin.
        """
        response = self._options("http://evil.example.com")
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("access-control-allow-origin", response.headers)
        # Still sent on the disallowed branch: a shared cache keying only on
        # method+path (ignoring Vary: Origin) could otherwise store this
        # "no CORS headers" response and replay it for a later, legitimate
        # allowed origin whose browser needs the real headers to read it.
        self.assertEqual(response.headers.get("vary"), "Origin")

    def test_preflight_does_not_require_authentication(self):
        """A CORS preflight carries no Authorization header by design.

        If MCPCorsMiddleware ran inside BearerAuthMiddleware instead of
        outside it, this would 401 and no browser could ever complete the
        handshake to send the real, authenticated request.
        """
        response = self._options("http://localhost:5173")
        self.assertEqual(response.status_code, 200)

    def test_real_response_carries_cors_headers_for_allowed_origin(self):
        """The real (non-preflight) response must also carry CORS headers."""
        response = self._post_raw("http://localhost:5173", self.raw_token)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["access-control-allow-origin"], "http://localhost:5173")
        self.assertEqual(response.headers.get("access-control-expose-headers"), "mcp-session-id")
        self.assertEqual(response.headers.get_list("vary"), ["Origin"])

    def test_real_response_omits_cors_headers_for_disallowed_origin(self):
        """A disallowed Origin never gets an Allow-Origin header.

        This actually never reaches MCPCorsMiddleware's own branch either
        way: the SDK's pre-existing DNS-rebinding protection
        (mcp_server/server.py::_build_transport_security, derived from the
        same CORS_ALLOWED_ORIGINS) already refuses a non-preflight request
        from an origin outside that allowlist with 403 before this request
        gets anywhere near a resource or tool. The two checks share one
        source of truth for what counts as "trusted", so this is belt and
        suspenders, not redundant: assert neither layer leaks the header.
        """
        response = self._post_raw("http://evil.example.com", self.raw_token)
        self.assertEqual(response.status_code, 403)
        self.assertNotIn("access-control-allow-origin", response.headers)
        self.assertEqual(response.headers.get("vary"), "Origin")

    def test_auth_failure_is_unaffected_by_origin(self):
        """CORS wrapping must not weaken or bypass Bearer authentication."""
        response = self._post_raw("http://localhost:5173", "not-a-real-token")
        self.assertEqual(response.status_code, 401)


class ConcurrentIdentityTests(TestCase):
    """Interleaved requests must never observe each other's identity.

    The end-to-end tests drive one caller at a time, so they would still pass
    if the identity carrier were a module-level global instead of a
    context-local. This drives many callers concurrently on one event loop,
    with a forced suspension point between setting the identity and reading it
    back, which is exactly the interleaving a shared global would fail.

    It exercises the carrier rather than the full HTTP stack on purpose: the
    real stack's ORM access runs under ``sync_to_async(thread_sensitive=True)``,
    which serializes onto the single thread blocked by ``async_to_sync`` in a
    test, so a gather over full requests deadlocks in the harness even though
    it is fine under a real ASGI server.
    """

    def test_interleaved_tasks_do_not_share_identity(self):
        import asyncio

        users = [_make_user(f"concurrent-{i}") for i in range(8)]

        async def handle(user):
            token = set_current_user(user)
            try:
                # Yield control so every other task runs between the set and
                # the read — a global carrier would be overwritten here.
                await asyncio.sleep(0)
                observed = get_current_user()
                await asyncio.sleep(0)
                self.assertIs(get_current_user(), observed)
                return observed.pk
            finally:
                reset_current_user(token)

        async def drive():
            return await asyncio.gather(*(handle(u) for u in users))

        self.assertEqual(async_to_sync(drive)(), [u.pk for u in users])

    def test_identity_is_cleared_after_a_failing_request(self):
        """A tool raising must not leave the caller bound to the context."""
        user = _make_user("concurrent-failer")
        token = set_current_user(user)
        try:
            self.assertIs(get_current_user(), user)
        finally:
            reset_current_user(token)
        with self.assertRaises(RuntimeError):
            get_current_user()


class ListBoardsQueryCountTests(TestCase):
    """list_boards must issue a constant number of queries.

    Role resolution is the trap: resolving each board separately costs a
    membership query per board, and for group-derived access an ancestor walk
    on top of that. Both membership sources are batched instead, so adding
    boards must not add queries.
    """

    def _query_count(self, board_count, via_group):
        """Build a fresh user owning *board_count* boards; count list_boards queries.

        A new user per call keeps the two measurements independent — reusing
        one would accumulate boards and make the comparison meaningless.
        """
        from groups.models import Group, GroupMembership

        suffix = f"{'group' if via_group else 'direct'}-{board_count}"
        user = _make_user(f"counter-{suffix}")
        owner = _make_user(f"counter-owner-{suffix}")

        group = None
        if via_group:
            # Three levels deep, with the user's membership only on the ROOT, so
            # role resolution must actually walk the ancestor chain. A flat
            # single-level group would never exercise the walk.
            root = Group.objects.create(name=f"root-{suffix}", owner=owner)
            mid = Group.objects.create(name=f"mid-{suffix}", owner=owner, parent=root)
            group = Group.objects.create(name=f"leaf-{suffix}", owner=owner, parent=mid)
            GroupMembership.objects.create(
                group=root, user=user, role=GroupMembership.Role.MEMBER
            )

        for i in range(board_count):
            board = _make_board(owner, name=f"board-{suffix}-{i}")
            if via_group:
                board.group = group
                board.save(update_fields=["group"])
            else:
                _make_membership(board, user, role=BoardMembership.Role.MEMBER)

        token = set_current_user(user)
        try:
            with CaptureQueriesContext(connection) as ctx:
                boards = tools.list_boards()
        finally:
            reset_current_user(token)
        self.assertEqual(len(boards), board_count)
        return len(ctx.captured_queries)

    def test_direct_membership_boards_do_not_scale_queries(self):
        few = self._query_count(2, via_group=False)
        many = self._query_count(8, via_group=False)
        self.assertEqual(few, many, f"query count grew: {few} -> {many}")

    def test_group_derived_boards_do_not_scale_queries(self):
        few = self._query_count(2, via_group=True)
        many = self._query_count(8, via_group=True)
        self.assertEqual(few, many, f"query count grew: {few} -> {many}")


class BoardSnapshotQueryCountTests(TestCase):
    """board_snapshot must issue a constant number of queries per section (#513).

    Mirrors ListBoardsQueryCountTests' shape, but scales the number of
    columns/swimlanes/cards on ONE board rather than the number of boards —
    the trap here is different: board_snapshot composes three payload
    builders, and calling the public list_columns/list_swimlanes/list_cards
    tools instead of the private *_payload(board) helpers would silently
    reintroduce the 3x _resolve_board() queries the refactor exists to avoid.
    """

    def _query_count(self, row_count):
        user = _make_user(f"snap-counter-{row_count}")
        board = _make_board(user, name=f"Snap {row_count}")
        for i in range(row_count):
            column = _make_column(board, name=f"C{i}", order=i)
            swimlane = _make_swimlane(board, name=f"S{i}", order=i)
            _make_card(column, swimlane, title=f"Card {i}", position=i)
            Label.objects.create(board=board, name=f"L{i}", color="#000000")

        token = set_current_user(user)
        try:
            with CaptureQueriesContext(connection) as ctx:
                data = tools.board_snapshot(board_id=board.id)
        finally:
            reset_current_user(token)
        self.assertEqual(len(data["columns"]), row_count)
        self.assertEqual(len(data["cards"]), row_count)
        return len(ctx.captured_queries)

    def test_snapshot_sections_do_not_scale_queries(self):
        few = self._query_count(2)
        many = self._query_count(8)
        self.assertEqual(few, many, f"query count grew: {few} -> {many}")


class CardDetailQueryCountTests(TestCase):
    """card_detail must issue a constant number of queries regardless of history size (#513).

    The trap: activities/comments are fetched with two queries NOT covered by
    _card_queryset's shared prefetch chain — scaling their row count must not
    turn either into a per-row query.
    """

    def _query_count(self, row_count):
        user = _make_user(f"card-counter-{row_count}")
        board = _make_board(user, name=f"CardCount {row_count}")
        column = _make_column(board)
        swimlane = _make_swimlane(board)
        card = _make_card(column, swimlane, title="Counted")
        for i in range(row_count):
            CardComment.objects.create(card=card, author=user, body=f"c{i}")
            CardActivity.objects.create(
                card=card, event_type=CardActivity.EventType.TITLE_CHANGE,
                from_value="a", to_value="b", actor=user,
            )
            CardChecklist.objects.create(card=card, text=f"item {i}", position=i)

        token = set_current_user(user)
        try:
            with CaptureQueriesContext(connection) as ctx:
                data = tools.card_detail(card_id=card.id)
        finally:
            reset_current_user(token)
        self.assertEqual(len(data["comments"]), row_count)
        self.assertEqual(len(data["activities"]), row_count)
        self.assertEqual(len(data["checklist_items"]), row_count)
        return len(ctx.captured_queries)

    def test_detail_history_does_not_scale_queries(self):
        few = self._query_count(2)
        many = self._query_count(8)
        self.assertEqual(few, many, f"query count grew: {few} -> {many}")


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
