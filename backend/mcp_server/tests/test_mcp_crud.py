"""Integration tests for the MCP CRUD tools (#512).

Same MCP_SERVER_ENABLED skip-guard as test_mcp.py, and the harness classes
below (McpTestCase/McpRequest/_parse_sse) are imported from there rather than
duplicated, so the two files cannot drift apart on how a request is driven.
"""
import json

import pytest
from django.conf import settings

if not settings.MCP_SERVER_ENABLED:  # pragma: no cover - exercised only in the flagged CI job
    pytest.skip(
        "MCP server disabled; set MCP_SERVER_ENABLED=true to run these.",
        allow_module_level=True,
    )

from django.utils import timezone
from rest_framework.utils.encoders import JSONEncoder

from accounts.models import (
    SCOPE_MCP_READ,
    SCOPE_MCP_WRITE,
    PersonalAccessToken,
    SiteSetting,
    invalidate_maintenance_mode_cache,
)
from boards.models import (
    BoardEvent, BoardMembership, Card, CardActivity, CardMovement, CardRelation,
)
from boards.tests.conftest import (
    _make_board, _make_card, _make_column, _make_membership, _make_swimlane,
    _make_user,
)
from boards.views._helpers import render_card_payloads

from .test_mcp import McpTestCase, _parse_sse


class CrudToolsTestCase(McpTestCase):
    """Shared fixture: a board with one column/swimlane, owned by self.user."""

    def setUp(self):
        super().setUp()
        self.board = _make_board(self.user, name="CRUD board")
        # allow_card_creation defaults to False (Column model default) — the
        # create_card tests need at least one column that accepts new cards.
        self.column = _make_column(self.board, name="Backlog", order=0, allow_card_creation=True)
        self.other_column = _make_column(self.board, name="Doing", order=1, allow_card_creation=True)
        self.swimlane = _make_swimlane(self.board, name="General", order=0)
        self.other_swimlane = _make_swimlane(self.board, name="Urgent", order=1)

    def _pat(self, user, scopes=(SCOPE_MCP_READ, SCOPE_MCP_WRITE)):
        _, raw = PersonalAccessToken.generate(user, "mcp", scopes=list(scopes))
        return raw

    @property
    def write_token(self):
        """A PAT for self.user carrying both mcp:read and mcp:write.

        McpTestCase.setUp() mints self.raw_token with mcp:read only (#1110's
        least-privilege default for a fixture); write-tool success-path tests
        need the extra scope, so they use this instead. Tests that
        specifically exercise the missing_scope denial mint their own
        read-only token rather than using self.raw_token, to keep the two
        concerns (RBAC role vs. PAT scope) visibly separate at each call site.
        """
        return self._pat(self.user)

    def _call(self, name, token, **arguments):
        status, body = self._tools_call(name, token, arguments)
        self.assertEqual(status, 200, body)
        payload = _parse_sse(body)
        self.assertNotIn("error", payload, payload)
        result = payload["result"]
        structured = result["structuredContent"]["result"]
        # The envelope contract (#2004), checked on every call any test makes:
        # isError is true exactly when the payload is a tool-domain error.
        is_domain_error = isinstance(structured, dict) and "error" in structured
        self.assertIs(result["isError"], is_domain_error, result)
        return structured

    def _add_member(self, role):
        user = _make_user(f"{role}-user")
        _make_membership(self.board, user, role=role)
        return user


class ListColumnsTests(CrudToolsTestCase):
    def test_returns_columns_ordered_by_position_with_card_counts(self):
        _make_card(self.column, self.swimlane, title="A")
        _make_card(self.column, self.swimlane, title="B", position=1, archived_at=timezone.now())

        result = self._call("list_columns", self.raw_token, board_id=self.board.id)
        self.assertEqual([c["name"] for c in result], ["Backlog", "Doing"])
        backlog = result[0]
        self.assertEqual(
            set(backlog), {"id", "name", "position", "color", "wip_limit", "card_count"},
        )
        self.assertEqual(backlog["card_count"], 1)  # archived card excluded
        self.assertEqual(backlog["id"], self.column.id)

    def test_every_role_may_call_list_columns(self):
        for role in BoardMembership.Role.values:
            user = self._add_member(role)
            token = self._pat(user)
            result = self._call("list_columns", token, board_id=self.board.id)
            self.assertEqual(len(result), 2)

    def test_no_access_board_returns_board_not_found(self):
        stranger = _make_user("stranger")
        token = self._pat(stranger)
        result = self._call("list_columns", token, board_id=self.board.id)
        self.assertEqual(result["error"]["code"], "board_not_found")

    def test_nonexistent_board_returns_identical_error_shape(self):
        missing = self._call("list_columns", self.raw_token, board_id=999999)
        no_access = self._call(
            "list_columns", self._pat(_make_user("stranger2")), board_id=self.board.id,
        )
        self.assertEqual(missing["error"], no_access["error"])


class ListSwimlanesTests(CrudToolsTestCase):
    def test_admin_sees_contact_email(self):
        self.swimlane.contact_email = "customer@example.com"
        self.swimlane.save(update_fields=["contact_email"])

        result = self._call("list_swimlanes", self.raw_token, board_id=self.board.id)
        row = next(r for r in result if r["id"] == self.swimlane.id)
        self.assertEqual(row["contact_email"], "customer@example.com")
        self.assertEqual(
            set(row),
            {"id", "name", "position", "color", "card_count", "is_collapsed", "contact_email"},
        )

    def test_non_admin_roles_do_not_see_contact_email_key(self):
        self.swimlane.contact_email = "customer@example.com"
        self.swimlane.save(update_fields=["contact_email"])

        for role in (BoardMembership.Role.MEMBER, BoardMembership.Role.COLLABORATOR, BoardMembership.Role.VIEWER):
            user = self._add_member(role)
            token = self._pat(user)
            result = self._call("list_swimlanes", token, board_id=self.board.id)
            row = next(r for r in result if r["id"] == self.swimlane.id)
            self.assertNotIn("contact_email", row, f"role={role} leaked contact_email")

    def test_ordered_by_position(self):
        result = self._call("list_swimlanes", self.raw_token, board_id=self.board.id)
        self.assertEqual([s["name"] for s in result], ["General", "Urgent"])


class ListCardsTests(CrudToolsTestCase):
    def test_returns_expected_shape(self):
        card = _make_card(
            self.column, self.swimlane, title="Ship it", priority=Card.Priority.HIGH,
            assignee=self.user, due_date="2026-12-01",
        )
        result = self._call("list_cards", self.raw_token, board_id=self.board.id)
        self.assertEqual(len(result), 1)
        row = result[0]
        self.assertEqual(
            set(row),
            {
                "id", "title", "description", "priority", "assignee", "labels",
                "column", "swimlane", "due_date", "position", "created_at", "updated_at",
            },
        )
        self.assertEqual(row["id"], card.id)
        self.assertEqual(
            row["assignee"],
            {"username": self.user.username, "display_name": self.user.display_name},
        )
        self.assertEqual(row["column"], {"id": self.column.id, "name": "Backlog"})
        self.assertEqual(row["due_date"], "2026-12-01")

    def test_excludes_archived_by_default_and_include_archived_includes_them(self):
        _make_card(self.column, self.swimlane, title="Live")
        _make_card(self.column, self.swimlane, title="Gone", position=1, archived_at=timezone.now())

        default = self._call("list_cards", self.raw_token, board_id=self.board.id)
        self.assertEqual([c["title"] for c in default], ["Live"])

        with_archived = self._call(
            "list_cards", self.raw_token, board_id=self.board.id, include_archived=True,
        )
        self.assertEqual({c["title"] for c in with_archived}, {"Live", "Gone"})

    def test_filters_by_column_swimlane_priority_and_label(self):
        from boards.models import Label

        label = Label.objects.create(board=self.board, name="bug")
        _make_card(self.column, self.swimlane, title="In backlog", priority=Card.Priority.LOW)
        c2 = _make_card(self.other_column, self.swimlane, title="In doing", priority=Card.Priority.URGENT)
        c2.labels.add(label)

        by_column = self._call("list_cards", self.raw_token, board_id=self.board.id, column_id=self.other_column.id)
        self.assertEqual([c["title"] for c in by_column], ["In doing"])

        by_priority = self._call("list_cards", self.raw_token, board_id=self.board.id, priority="urgent")
        self.assertEqual([c["title"] for c in by_priority], ["In doing"])

        by_label = self._call("list_cards", self.raw_token, board_id=self.board.id, label="bug")
        self.assertEqual([c["title"] for c in by_label], ["In doing"])

    def test_filters_by_assignee_username(self):
        other = _make_user("assignee-user", email="assignee@example.com")
        _make_membership(self.board, other, role=BoardMembership.Role.MEMBER)
        _make_card(self.column, self.swimlane, title="Mine", assignee=self.user)
        _make_card(self.column, self.swimlane, title="Theirs", position=1, assignee=other)

        result = self._call(
            "list_cards", self.raw_token, board_id=self.board.id, assignee="Assignee-User",
        )
        self.assertEqual([c["title"] for c in result], ["Theirs"])

    def test_assignee_filter_matches_username_only(self):
        # The filter takes the same identifier the output carries (username),
        # matching the REST user shape, which has no email field.
        other = _make_user("assignee-user", email="assignee@example.com")
        _make_membership(self.board, other, role=BoardMembership.Role.MEMBER)
        _make_card(self.column, self.swimlane, title="Theirs", assignee=other)

        result = self._call(
            "list_cards", self.raw_token, board_id=self.board.id, assignee="assignee@example.com",
        )
        self.assertEqual(result, [])


class ListCardsPagingTests(CrudToolsTestCase):
    """#1762: the 200-row cap is detectable and pageable, mirroring REST's #1724."""

    def _seed(self, n):
        Card.objects.bulk_create([
            Card(board=self.board, column=self.column, swimlane=self.swimlane,
                 title=f"C{i}", position=i, created_by=self.user)
            for i in range(n)
        ])

    def test_truncated_default_call_signals_in_band(self):
        self._seed(205)
        result = self._raw_call()
        self.assertEqual(len(result["structuredContent"]["result"]), 200)
        texts = [c["text"] for c in result["content"]]
        self.assertEqual(len(texts), 201)  # 200 per-card blocks + the notice
        self.assertEqual(texts[-1], "Showing 200 of 205 cards; call again with offset=200")
        self.assertEqual(
            result["_meta"], {"visiban/total": 205, "visiban/truncated": True},
        )
        # The per-card blocks are byte-identical to what the SDK renders for
        # the same rows (the server inlines that formatting).
        from mcp.server.mcpserver.utilities.func_metadata import _convert_to_content
        sdk_blocks = [b.text for b in _convert_to_content(result["structuredContent"]["result"])]
        self.assertEqual(texts[:-1], sdk_blocks)

    def test_untruncated_default_call_has_no_notice_or_meta(self):
        self._seed(3)
        result = self._raw_call()
        self.assertEqual(len(result["content"]), 3)
        self.assertEqual(len(result["structuredContent"]["result"]), 3)
        self.assertNotIn("_meta", result)
        self.assertFalse(any("Showing" in c["text"] for c in result["content"]))

    def test_output_schema_is_unchanged_by_the_calltoolresult_annotation(self):
        status, body = self.client_.post(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, token=self.raw_token,
        )
        self.assertEqual(status, 200)
        tools = {t["name"]: t for t in _parse_sse(body)["result"]["tools"]}
        # list_columns still uses the plain list|dict annotation.
        strip = lambda schema: {k: v for k, v in schema.items() if k != "title"}  # noqa: E731 - title is per-tool
        self.assertEqual(
            strip(tools["list_cards"]["outputSchema"]), strip(tools["list_columns"]["outputSchema"]),
        )

    def test_exactly_cap_is_not_flagged_truncated(self):
        self._seed(200)
        result = self._raw_call()
        self.assertEqual(len(result["content"]), 200)
        self.assertNotIn("_meta", result)

    def test_plain_limit_zero_has_no_looping_continuation_notice(self):
        self._seed(4)
        result = self._raw_call(limit=0)
        self.assertEqual(result["content"], [])
        self.assertEqual(result["structuredContent"]["result"], [])
        self.assertNotIn("_meta", result)

    def test_offset_beyond_total_reports_real_total(self):
        self._seed(4)
        result = self._call("list_cards", self.raw_token, board_id=self.board.id, include_meta=True, offset=99)
        self.assertEqual((result["cards"], result["total"], result["truncated"]), ([], 4, False))

    def test_empty_board_total_is_zero(self):
        result = self._call("list_cards", self.raw_token, board_id=self.board.id, include_meta=True)
        self.assertEqual((result["cards"], result["total"], result["truncated"]), ([], 0, False))

    def test_notice_next_offset_follows_offset_and_limit(self):
        self._seed(30)
        result = self._raw_call(limit=5, offset=10)
        self.assertEqual(
            result["content"][-1]["text"], "Showing 5 of 30 cards; call again with offset=15",
        )
        self.assertEqual(result["_meta"]["visiban/total"], 30)

    def test_include_meta_has_no_in_band_notice(self):
        self._seed(205)
        result = self._raw_call(include_meta=True)
        self.assertNotIn("_meta", result)
        self.assertEqual(result["structuredContent"]["result"]["total"], 205)
        self.assertFalse(any(c["text"].startswith("Showing") for c in result["content"]))

    def test_id_tiebreaker_orders_ties_and_pages_without_gap(self):
        # Identical column/swimlane/position: only `id` makes the order total.
        self._seed_ties = Card.objects.bulk_create([
            Card(board=self.board, column=self.column, swimlane=self.swimlane,
                 title=f"T{i}", position=0, created_by=self.user)
            for i in range(7)
        ])
        expected = sorted(Card.objects.filter(board=self.board).values_list("id", flat=True))
        got = []
        for offset in (0, 3, 6):
            page = self._call(
                "list_cards", self.raw_token, board_id=self.board.id,
                include_meta=True, limit=3, offset=offset,
            )
            got += [c["id"] for c in page["cards"]]
        self.assertEqual(got, expected)

    def test_numeric_string_args_are_coerced_by_the_schema(self):
        self._seed(4)
        result = self._call("list_cards", self.raw_token, board_id=self.board.id, include_meta=True, limit="2")
        self.assertEqual(len(result["cards"]), 2)

    def test_huge_limit_is_clamped_not_rejected(self):
        self._seed(2)
        result = self._call("list_cards", self.raw_token, board_id=self.board.id, include_meta=True, limit=2**63)
        self.assertEqual((result["limit"], len(result["cards"])), (200, 2))

    def _raw_call(self, **arguments):
        status, body = self._tools_call("list_cards", self.raw_token, {"board_id": self.board.id, **arguments})
        self.assertEqual(status, 200, body)
        return _parse_sse(body)["result"]

    def test_default_is_bare_array_capped_at_200(self):
        self._seed(205)
        result = self._call("list_cards", self.raw_token, board_id=self.board.id)
        self.assertIsInstance(result, list)
        self.assertEqual(len(result), 200)

    def test_include_meta_reports_total_and_truncated(self):
        self._seed(205)
        result = self._call("list_cards", self.raw_token, board_id=self.board.id, include_meta=True)
        self.assertEqual(len(result["cards"]), 200)
        self.assertEqual(result["total"], 205)
        self.assertTrue(result["truncated"])
        self.assertEqual((result["limit"], result["offset"]), (200, 0))

    def test_include_meta_not_truncated_when_complete(self):
        self._seed(3)
        result = self._call("list_cards", self.raw_token, board_id=self.board.id, include_meta=True)
        self.assertEqual((result["total"], result["truncated"], len(result["cards"])), (3, False, 3))

    def test_offset_pages_past_the_cap_without_overlap(self):
        self._seed(205)
        first = self._call("list_cards", self.raw_token, board_id=self.board.id, include_meta=True)
        second = self._call(
            "list_cards", self.raw_token, board_id=self.board.id, include_meta=True, offset=200,
        )
        self.assertEqual(len(second["cards"]), 5)
        self.assertFalse(second["truncated"])
        ids = [c["id"] for c in first["cards"]] + [c["id"] for c in second["cards"]]
        self.assertEqual(len(set(ids)), 205)

    def test_limit_is_clamped_to_200(self):
        self._seed(205)
        result = self._call(
            "list_cards", self.raw_token, board_id=self.board.id, include_meta=True, limit=5000,
        )
        self.assertEqual((len(result["cards"]), result["limit"]), (200, 200))

    def test_limit_zero_returns_total_only(self):
        self._seed(4)
        result = self._call("list_cards", self.raw_token, board_id=self.board.id, include_meta=True, limit=0)
        self.assertEqual((result["cards"], result["total"], result["truncated"]), ([], 4, True))

    def test_offset_past_end_is_empty_not_error(self):
        self._seed(2)
        result = self._call("list_cards", self.raw_token, board_id=self.board.id, include_meta=True, offset=50)
        self.assertEqual((result["cards"], result["total"], result["truncated"]), ([], 2, False))

    def test_total_respects_filters(self):
        self._seed(3)
        _make_card(self.other_column, self.swimlane, title="Other")
        result = self._call(
            "list_cards", self.raw_token, board_id=self.board.id, include_meta=True,
            column_id=self.column.id,
        )
        self.assertEqual(result["total"], 3)

    def test_negative_limit_is_a_validation_error(self):
        result = self._call("list_cards", self.raw_token, board_id=self.board.id, limit=-1)
        self.assertEqual(result["error"]["code"], "validation_error")
        self.assertIn("limit", result["error"]["errors"])

    def test_negative_offset_clamps_to_zero(self):
        # #1823: lenient like REST's parse_offset, not a validation_error.
        result = self._call(
            "list_cards", self.raw_token, board_id=self.board.id, include_meta=True, offset=-1,
        )
        self.assertNotIn("error", result)
        self.assertEqual(result["offset"], 0)

    def test_parse_paging_non_int_offset_is_zero(self):
        from mcp_server.tools import _parse_paging
        for bad in ("abc", 1.5, True, -7):
            with self.subTest(offset=bad):
                self.assertEqual(_parse_paging(None, bad)[1], 0)

    def test_oversized_offset_is_a_validation_error(self):
        result = self._call("list_cards", self.raw_token, board_id=self.board.id, offset=2**63)
        self.assertEqual(result["error"]["code"], "validation_error")

    def test_non_integer_paging_is_rejected_cleanly(self):
        result = self._raw_call(limit="abc")
        self.assertTrue(result["isError"])


class CreateCardTests(CrudToolsTestCase):
    def test_admin_can_create_card_with_from_column_null_movement(self):
        result = self._call(
            "create_card", self.write_token, board_id=self.board.id,
            column_id=self.column.id, swimlane_id=self.swimlane.id, title="New card",
        )
        self.assertIn("id", result)
        self.assertIn("created_at", result)
        self.assertEqual(result["priority"], "medium")

        card = Card.objects.get(pk=result["id"])
        movement = CardMovement.objects.get(card=card)
        self.assertIsNone(movement.from_column)
        self.assertEqual(movement.to_column_id, self.column.id)

    def test_member_can_create_collaborator_and_viewer_cannot(self):
        member = self._add_member(BoardMembership.Role.MEMBER)
        result = self._call(
            "create_card", self._pat(member), board_id=self.board.id,
            column_id=self.column.id, swimlane_id=self.swimlane.id, title="By member",
        )
        self.assertIn("id", result)

        for role in (BoardMembership.Role.COLLABORATOR, BoardMembership.Role.VIEWER):
            user = self._add_member(role)
            denied = self._call(
                "create_card", self._pat(user), board_id=self.board.id,
                column_id=self.column.id, swimlane_id=self.swimlane.id, title="Denied",
            )
            self.assertEqual(denied["error"]["code"], "permission_denied", f"role={role}")

    def test_write_tool_denied_without_mcp_write_scope(self):
        read_only_token = self._pat(self.user, scopes=(SCOPE_MCP_READ,))
        result = self._call(
            "create_card", read_only_token, board_id=self.board.id,
            column_id=self.column.id, swimlane_id=self.swimlane.id, title="Should not exist",
        )
        self.assertEqual(result["error"]["code"], "missing_scope")
        self.assertFalse(Card.objects.filter(title="Should not exist").exists())

    def test_assignee_username_and_labels_resolve(self):
        from boards.models import Label

        assignee = _make_user(
            "assignee-for-create", email="assignee@example.com", display_name="Assignee Person",
        )
        _make_membership(self.board, assignee, role=BoardMembership.Role.MEMBER)
        Label.objects.create(board=self.board, name="urgent")

        result = self._call(
            "create_card", self.write_token, board_id=self.board.id,
            column_id=self.column.id, swimlane_id=self.swimlane.id, title="Assigned",
            assignee="ASSIGNEE-for-create", labels=["urgent"],
        )
        self.assertEqual(
            result["assignee"],
            {"username": "assignee-for-create", "display_name": "Assignee Person"},
        )
        self.assertEqual(result["labels"], ["urgent"])

    def test_unknown_assignee_is_a_validation_error(self):
        result = self._call(
            "create_card", self.write_token, board_id=self.board.id,
            column_id=self.column.id, swimlane_id=self.swimlane.id, title="Bad assignee",
            assignee="nobody",
        )
        self.assertEqual(result["error"]["code"], "validation_error")
        self.assertIn("assignee", result["error"]["errors"])
        self.assertFalse(Card.objects.filter(title="Bad assignee").exists())

    def test_assignee_lookup_failures_return_one_uniform_error(self):
        # Every way an assignee can fail to resolve -- no such user, a user with
        # no role on this board, a member whose role cannot be assigned, or an
        # identifier that is not a username at all -- returns the identical
        # error, so the response says only "not an assignable member".
        assignable = _make_user("assignable-member", email="assignable@example.com")
        _make_membership(self.board, assignable, role=BoardMembership.Role.MEMBER)
        viewer = _make_user("viewer-member", email="viewer@example.com")
        _make_membership(self.board, viewer, role=BoardMembership.Role.VIEWER)
        _make_user("not-a-member", email="outsider@example.com")

        errors = []
        for value in ("nobody", "not-a-member", "viewer-member", "assignable@example.com"):
            result = self._call(
                "create_card", self.write_token, board_id=self.board.id,
                column_id=self.column.id, swimlane_id=self.swimlane.id, title=f"Try {value}",
                assignee=value,
            )
            self.assertIn("error", result, value)
            errors.append(result["error"])
            self.assertFalse(Card.objects.filter(title=f"Try {value}").exists(), value)
        self.assertTrue(all(e == errors[0] for e in errors), errors)
        self.assertEqual(errors[0]["code"], "validation_error")

    def test_non_writer_roles_denied_before_assignee_lookup(self):
        # The role check runs before the assignee is resolved, so the result
        # is the same whether or not the username names an assignable member.
        assignable = _make_user("assignable-for-role", email="assignable-role@example.com")
        _make_membership(self.board, assignable, role=BoardMembership.Role.MEMBER)
        for role in (BoardMembership.Role.VIEWER, BoardMembership.Role.COLLABORATOR):
            token = self._pat(self._add_member(role))
            results = [
                self._call(
                    "create_card", token, board_id=self.board.id,
                    column_id=self.column.id, swimlane_id=self.swimlane.id,
                    title=f"Denied {role} {value}", assignee=value,
                )
                for value in ("assignable-for-role", "no-such-user")
            ]
            self.assertEqual(results[0], results[1], role)
            self.assertEqual(results[0]["error"]["code"], "permission_denied", role)
        self.assertFalse(Card.objects.filter(title__startswith="Denied").exists())

    def test_removed_assignee_email_argument_is_rejected(self):
        # #2004: `assignee_email` (a 1.2 pre-release argument) is no longer in
        # the input schema, and mcp 2.3.0 would silently drop it (its argument
        # model ignores undeclared keys). server.py reads the raw arguments
        # and refuses the call instead, so a stale client cannot get an
        # unassigned card it did not ask for. Any non-null value counts.
        member = _make_user("email-arg-member", email="email-arg@example.com")
        _make_membership(self.board, member, role=BoardMembership.Role.MEMBER)
        for value in ("email-arg@example.com", ""):
            with self.subTest(value=value):
                # _call asserts isError is true for an error payload.
                result = self._call(
                    "create_card", self.write_token, board_id=self.board.id,
                    column_id=self.column.id, swimlane_id=self.swimlane.id,
                    title="Old argument", assignee_email=value,
                )
                self.assertEqual(result, {"error": {
                    "code": "validation_error",
                    "errors": {"assignee_email": [
                        "This argument was replaced by `assignee` (a username).",
                    ]},
                }})
        self.assertFalse(Card.objects.filter(title="Old argument").exists())

    def test_removed_assignee_email_null_is_ignored(self):
        # An explicit null asked for nothing and was a no-op in every
        # pre-release that declared the argument; it stays one (#2004), so
        # the call creates exactly what it would without the argument.
        result = self._call(
            "create_card", self.write_token, board_id=self.board.id,
            column_id=self.column.id, swimlane_id=self.swimlane.id,
            title="Null argument", assignee_email=None,
        )
        self.assertNotIn("error", result)
        self.assertIsNone(result["assignee"])
        card = Card.objects.get(title="Null argument")
        self.assertIsNone(card.assignee_id)
        self.assertEqual(card.column_id, self.column.id)

    def test_unknown_label_is_a_validation_error(self):
        result = self._call(
            "create_card", self.write_token, board_id=self.board.id,
            column_id=self.column.id, swimlane_id=self.swimlane.id, title="Bad label",
            labels=["does-not-exist"],
        )
        self.assertEqual(result["error"]["code"], "validation_error")
        self.assertIn("labels", result["error"]["errors"])

    def test_explicit_position_repositions_without_extra_movement_row(self):
        _make_card(self.column, self.swimlane, title="Existing", position=0)
        result = self._call(
            "create_card", self.write_token, board_id=self.board.id,
            column_id=self.column.id, swimlane_id=self.swimlane.id, title="Inserted first",
            position=0,
        )
        card = Card.objects.get(pk=result["id"])
        self.assertEqual(card.position, 0)
        # "Card created" only — the position reorder must not add a second row.
        self.assertEqual(CardMovement.objects.filter(card=card).count(), 1)


    def test_wip_limit_on_create_is_structured_and_writes_nothing(self):
        # #1428: create_card enforces the same limits as move_card, with the
        # same structured error and no force override over MCP.
        self.board.enforce_wip_limits = True
        self.board.save(update_fields=["enforce_wip_limits"])
        self.column.wip_limit = 1
        self.column.save(update_fields=["wip_limit"])
        _make_card(self.column, self.swimlane, title="Already there")

        result = self._call(
            "create_card", self.write_token, board_id=self.board.id,
            column_id=self.column.id, swimlane_id=self.swimlane.id, title="Over",
        )
        self.assertEqual(result["error"], {
            "code": "wip_limit_exceeded", "column_name": "Backlog",
            "current_count": 1, "wip_limit": 1,
        })
        self.assertFalse(Card.objects.filter(title="Over").exists())

    def test_hard_wip_on_create_is_structured(self):
        self.board.enforce_wip_hard = True
        self.board.save(update_fields=["enforce_wip_hard"])
        self.column.wip_limit = 1
        self.column.save(update_fields=["wip_limit"])
        _make_card(self.column, self.swimlane, title="Already there")

        result = self._call(
            "create_card", self.write_token, board_id=self.board.id,
            column_id=self.column.id, swimlane_id=self.swimlane.id, title="Over",
        )
        self.assertEqual(result["error"]["code"], "wip_hard_blocked")
        self.assertFalse(Card.objects.filter(title="Over").exists())


class CreateCardAtomicReorderTests(CrudToolsTestCase):
    """``create_card`` with ``position`` is one transaction (#1992).

    It used to commit the create and then run the reorder on its own, so a
    reorder that failed left the card behind an error with no card id, and the
    documented retry made a duplicate.
    """

    def setUp(self):
        super().setUp()
        # A sibling at 0, so the new card is appended at 1 and position=0
        # needs the follow-up reorder.
        self.sibling = _make_card(self.column, self.swimlane, title="Sibling", position=0)

    def _create(self, **extra):
        return self._call(
            "create_card", self.write_token, board_id=self.board.id,
            column_id=self.column.id, swimlane_id=self.swimlane.id, title="Placed",
            position=0, **extra,
        )

    def _assert_failed_reorder_writes_nothing(self, error, code):
        from unittest.mock import patch

        from boards import hooks

        hook_calls = []
        cards_before = Card.objects.count()
        movements_before = CardMovement.objects.count()
        events_before = BoardEvent.objects.count()
        with patch.object(hooks, "CARD_MUTATION_HOOKS", [lambda *a: hook_calls.append(a)]), \
                patch("boards.services.cards.move_card", side_effect=error), \
                patch("boards.broadcast.broadcast_board_event") as broadcast, \
                self.captureOnCommitCallbacks(execute=True):
            result = self._create()

        self.assertEqual(result["error"]["code"], code)
        # The create rolled back with the reorder: no card, no "Card created"
        # movement, no change-feed row, and nothing left for after the commit,
        # so no card.created frame for a card that does not exist and no hook.
        self.assertEqual(Card.objects.count(), cards_before)
        self.assertFalse(Card.objects.filter(title="Placed").exists())
        self.assertEqual(CardMovement.objects.count(), movements_before)
        self.assertEqual(BoardEvent.objects.count(), events_before)
        # captureOnCommitCallbacks ran whatever was left to run on commit.
        broadcast.assert_not_called()
        self.assertEqual(hook_calls, [])

        # So retrying is safe: exactly one card, at the requested position.
        retried = self._create()
        self.assertEqual(Card.objects.filter(title="Placed").count(), 1)
        self.assertEqual(Card.objects.get(pk=retried["id"]).position, 0)
        self.sibling.refresh_from_db()
        self.assertEqual(self.sibling.position, 1)

    def test_version_conflict_on_reorder_writes_nothing_and_retry_creates_one(self):
        from boards.services.errors import VersionConflict

        self._assert_failed_reorder_writes_nothing(VersionConflict(2), "version_conflict")

    def test_card_not_found_on_reorder_writes_nothing_and_retry_creates_one(self):
        from boards.services.errors import CardNotFound

        self._assert_failed_reorder_writes_nothing(CardNotFound(), "card_not_found")

    def test_success_fires_created_then_moved_after_one_commit(self):
        from unittest.mock import patch

        from boards import hooks

        hook_calls = []
        with patch.object(hooks, "CARD_MUTATION_HOOKS", [lambda *a: hook_calls.append(a)]), \
                patch("boards.broadcast.broadcast_board_event") as broadcast, \
                self.captureOnCommitCallbacks(execute=True):
            result = self._create()

        card = Card.objects.get(pk=result["id"])
        self.assertEqual(result["position"], 0)
        self.assertEqual(card.position, 0)
        self.sibling.refresh_from_db()
        self.assertEqual(self.sibling.position, 1)
        # The frames clients saw before #1992, in the same order: the card
        # appended, then the same-cell reorder ({card}, no movement).
        events = [c.args[1] for c in broadcast.call_args_list]
        self.assertEqual(events, ["card.created", "card.moved"])
        self.assertEqual(set(broadcast.call_args_list[1].args[2]), {"card"})
        self.assertEqual(
            [(event, card_id) for event, card_id, _board, _actor in hook_calls],
            [("card.created", card.id), ("card.moved", card.id)],
        )

    def test_position_already_at_end_skips_the_reorder(self):
        result = self._call(
            "create_card", self.write_token, board_id=self.board.id,
            column_id=self.column.id, swimlane_id=self.swimlane.id, title="Placed",
            position=1,
        )
        self.assertEqual(result["position"], 1)
        self.assertEqual(BoardEvent.objects.filter(event="card.created").count(), 1)
        self.assertFalse(BoardEvent.objects.filter(event="card.moved").exists())

    def _assert_limit_refusal_writes_nothing(self, expected_code):
        cards_before = Card.objects.count()
        movements_before = CardMovement.objects.count()
        events_before = BoardEvent.objects.count()
        result = self._create()
        self.assertEqual(result["error"]["code"], expected_code)
        self.assertFalse(Card.objects.filter(title="Placed").exists())
        self.assertEqual(Card.objects.count(), cards_before)
        self.assertEqual(CardMovement.objects.count(), movements_before)
        self.assertEqual(BoardEvent.objects.count(), events_before)
        self.sibling.refresh_from_db()
        self.assertEqual(self.sibling.position, 0)

    def test_wip_limit_with_position_is_structured_and_writes_nothing(self):
        # The limit is enforced inside create_card on the new path too, and
        # the refusal rolls back the up-front cell locks' transaction whole.
        self.board.enforce_wip_limits = True
        self.board.save(update_fields=["enforce_wip_limits"])
        self.column.wip_limit = 1
        self.column.save(update_fields=["wip_limit"])
        self._assert_limit_refusal_writes_nothing("wip_limit_exceeded")

    def test_hard_wip_with_position_is_structured_and_writes_nothing(self):
        self.board.enforce_wip_hard = True
        self.board.save(update_fields=["enforce_wip_hard"])
        self.column.wip_limit = 1
        self.column.save(update_fields=["wip_limit"])
        self._assert_limit_refusal_writes_nothing("wip_hard_blocked")

    def test_weight_limit_with_position_is_structured_and_writes_nothing(self):
        # Card.weight defaults to 1: the sibling fills a budget of 1.
        self.board.enforce_weight_limits = True
        self.board.save(update_fields=["enforce_weight_limits"])
        self.column.weight_limit = 1
        self.column.save(update_fields=["weight_limit"])
        self._assert_limit_refusal_writes_nothing("weight_limit_exceeded")

    def test_column_creation_closed_is_refused_before_any_lock(self):
        self.column.allow_card_creation = False
        self.column.save(update_fields=["allow_card_creation"])
        result = self._create()
        self.assertEqual(result["error"]["code"], "card_creation_not_allowed")
        self.assertFalse(Card.objects.filter(title="Placed").exists())


class MoveCardTests(CrudToolsTestCase):
    def test_move_to_new_column_creates_movement(self):
        card = _make_card(self.column, self.swimlane, title="Movable")
        result = self._call(
            "move_card", self.write_token, card_id=card.id, to_column_id=self.other_column.id,
        )
        self.assertEqual(result["card"]["column"]["id"], self.other_column.id)
        self.assertIsNotNone(result["movement"])
        self.assertEqual(result["movement"]["to_column"], "Doing")

        card.refresh_from_db()
        self.assertEqual(card.column_id, self.other_column.id)

    def test_neither_target_given_is_a_validation_error(self):
        card = _make_card(self.column, self.swimlane, title="Stuck")
        result = self._call("move_card", self.write_token, card_id=card.id)
        self.assertEqual(result["error"]["code"], "validation_error")

    def test_wip_limit_exceeded_is_structured_not_500(self):
        self.board.enforce_wip_limits = True
        self.board.save(update_fields=["enforce_wip_limits"])
        self.other_column.wip_limit = 1
        self.other_column.save(update_fields=["wip_limit"])
        _make_card(self.other_column, self.swimlane, title="Already there")
        moving = _make_card(self.column, self.swimlane, title="Blocked", position=0)

        result = self._call(
            "move_card", self.write_token, card_id=moving.id, to_column_id=self.other_column.id,
        )
        self.assertEqual(result["error"]["code"], "wip_limit_exceeded")
        self.assertEqual(result["error"]["wip_limit"], 1)
        self.assertEqual(result["error"]["current_count"], 1)

        moving.refresh_from_db()
        self.assertEqual(moving.column_id, self.column.id)  # never moved

    def test_collaborator_and_viewer_denied(self):
        card = _make_card(self.column, self.swimlane, title="Guarded")
        for role in (BoardMembership.Role.COLLABORATOR, BoardMembership.Role.VIEWER):
            user = self._add_member(role)
            result = self._call(
                "move_card", self._pat(user), card_id=card.id, to_column_id=self.other_column.id,
            )
            self.assertEqual(result["error"]["code"], "permission_denied", f"role={role}")

    def test_write_tool_denied_without_mcp_write_scope(self):
        card = _make_card(self.column, self.swimlane, title="Locked")
        read_only_token = self._pat(self.user, scopes=(SCOPE_MCP_READ,))
        result = self._call(
            "move_card", read_only_token, card_id=card.id, to_column_id=self.other_column.id,
        )
        self.assertEqual(result["error"]["code"], "missing_scope")

    def test_card_on_inaccessible_board_returns_card_not_found(self):
        other_owner = _make_user("other-owner")
        other_board = _make_board(other_owner, name="Not mine")
        other_column = _make_column(other_board)
        other_swimlane = _make_swimlane(other_board)
        foreign_card = _make_card(other_column, other_swimlane, title="Foreign")

        result = self._call(
            "move_card", self.write_token, card_id=foreign_card.id, to_column_id=self.column.id,
        )
        self.assertEqual(result["error"]["code"], "card_not_found")


class RefetchVsDeleteTests(CrudToolsTestCase):
    """A card deleted between the service's write and the tool's re-read is a
    clean card_not_found error with no broadcast, never an unhandled
    Card.DoesNotExist (#1585)."""

    def _delete_on_refetch(self, pk):
        from unittest.mock import patch

        from boards.serializers import _card_queryset as real

        def racing(qs):
            Card.objects.filter(pk=pk).delete()
            return real(qs)

        return patch("mcp_server.tools._card_queryset", side_effect=racing)

    def test_create_card_refetch_gone(self):
        from boards.models import BoardEvent

        before = BoardEvent.objects.count()
        from unittest.mock import patch

        from boards.serializers import _card_queryset as real

        def racing(qs):
            Card.objects.all().delete()
            return real(qs)

        with patch("mcp_server.tools._card_queryset", side_effect=racing):
            result = self._call(
                "create_card", self.write_token, board_id=self.board.id,
                column_id=self.column.id, swimlane_id=self.swimlane.id, title="Gone",
            )
        self.assertEqual(result["error"]["code"], "card_not_found")
        self.assertEqual(BoardEvent.objects.count(), before)

    def test_create_card_with_position_refetch_gone(self):
        from unittest.mock import patch

        from boards.models import BoardEvent
        from boards.serializers import _card_queryset as real

        calls = {"n": 0}

        def racing(qs):
            calls["n"] += 1
            if calls["n"] == 2:  # the position-move's render, not create's
                Card.objects.all().delete()
            return real(qs)

        before = BoardEvent.objects.count()
        _make_card(self.column, self.swimlane, title="Sibling")
        with patch("mcp_server.tools._card_queryset", side_effect=racing):
            result = self._call(
                "create_card", self.write_token, board_id=self.board.id,
                column_id=self.column.id, swimlane_id=self.swimlane.id, title="Gone",
                position=0,
            )
        self.assertEqual(result["error"]["code"], "card_not_found")
        self.assertEqual(calls["n"], 2)
        # Create and reorder share one transaction (#1992), so the failed
        # reorder rolls back the create too: no card.created row, no card.moved
        # row, and no "Gone" card. The racing delete ran inside that same
        # transaction, so it rolled back as well and the sibling is still there.
        self.assertEqual(BoardEvent.objects.count(), before)
        self.assertFalse(Card.objects.filter(title="Gone").exists())
        self.assertTrue(Card.objects.filter(title="Sibling").exists())

    def test_move_card_refetch_gone(self):
        from boards.models import BoardEvent

        card = _make_card(self.column, self.swimlane, title="Doomed")
        before = BoardEvent.objects.count()
        with self._delete_on_refetch(card.pk):
            result = self._call(
                "move_card", self.write_token, card_id=card.id,
                to_column_id=self.other_column.id,
            )
        self.assertEqual(result["error"]["code"], "card_not_found")
        self.assertEqual(BoardEvent.objects.count(), before)

    def test_update_card_refetch_gone(self):
        from boards.models import BoardEvent

        card = _make_card(self.column, self.swimlane, title="Doomed")
        before = BoardEvent.objects.count()
        with self._delete_on_refetch(card.pk):
            result = self._call("update_card", self.write_token, card_id=card.id, title="New")
        self.assertEqual(result["error"]["code"], "card_not_found")
        self.assertEqual(BoardEvent.objects.count(), before)

    def test_get_card_refetch_gone_raises_value_error(self):
        from unittest.mock import patch

        from mcp_server import tools

        card = _make_card(self.column, self.swimlane, title="Doomed")
        with patch("mcp_server.tools.get_current_user", return_value=self.user):
            with self._delete_on_refetch(card.pk):
                with self.assertRaises(ValueError):
                    tools.card_detail(card_id=card.id)


class UpdateCardTests(CrudToolsTestCase):
    def test_updates_fields_and_records_activity(self):
        card = _make_card(self.column, self.swimlane, title="Old title", priority=Card.Priority.LOW)
        result = self._call(
            "update_card", self.write_token, card_id=card.id, title="New title", priority="high",
        )
        self.assertEqual(result["title"], "New title")
        self.assertEqual(result["priority"], "high")
        self.assertTrue(
            CardActivity.objects.filter(card=card, event_type=CardActivity.EventType.TITLE_CHANGE).exists()
        )
        self.assertTrue(
            CardActivity.objects.filter(card=card, event_type=CardActivity.EventType.PRIORITY_CHANGE).exists()
        )

    def test_empty_labels_list_clears_labels(self):
        from boards.models import Label

        label = Label.objects.create(board=self.board, name="keep-off")
        card = _make_card(self.column, self.swimlane, title="Has label")
        card.labels.add(label)

        result = self._call("update_card", self.write_token, card_id=card.id, labels=[])
        self.assertEqual(result["labels"], [])

    def test_empty_assignee_unassigns(self):
        card = _make_card(self.column, self.swimlane, title="Assigned", assignee=self.user)
        result = self._call("update_card", self.write_token, card_id=card.id, assignee="")
        self.assertIsNone(result["assignee"])

    def test_removed_assignee_email_argument_is_rejected(self):
        # #2004: see CreateCardTests' test of the same name. Nothing is
        # changed: not the assignee, and not the other fields sent alongside.
        member = _make_user("update-email-arg", email="update-email-arg@example.com")
        _make_membership(self.board, member, role=BoardMembership.Role.MEMBER)
        card = _make_card(self.column, self.swimlane, title="Keep", assignee=self.user)
        activity_before = CardActivity.objects.filter(card=card).count()
        for value in ("update-email-arg@example.com", ""):
            with self.subTest(value=value):
                result = self._call(
                    "update_card", self.write_token, card_id=card.id, title="Changed",
                    assignee_email=value,
                )
                self.assertEqual(result, {"error": {
                    "code": "validation_error",
                    "errors": {"assignee_email": [
                        "This argument was replaced by `assignee` (a username).",
                    ]},
                }})
        card.refresh_from_db()
        self.assertEqual(card.title, "Keep")
        self.assertEqual(card.assignee_id, self.user.id)
        self.assertEqual(CardActivity.objects.filter(card=card).count(), activity_before)

    def test_removed_assignee_email_null_is_ignored(self):
        # See CreateCardTests' test of the same name: the other fields are
        # applied and the assignee is left as it was.
        card = _make_card(self.column, self.swimlane, title="Keep", assignee=self.user)
        result = self._call(
            "update_card", self.write_token, card_id=card.id, title="Changed",
            assignee_email=None,
        )
        self.assertNotIn("error", result)
        self.assertEqual(result["assignee"]["username"], self.user.username)
        card.refresh_from_db()
        self.assertEqual(card.title, "Changed")
        self.assertEqual(card.assignee_id, self.user.id)

    def test_non_writer_roles_denied_before_assignee_lookup(self):
        assignable = _make_user("update-assignable", email="update-assignable@example.com")
        _make_membership(self.board, assignable, role=BoardMembership.Role.MEMBER)
        card = _make_card(self.column, self.swimlane, title="Guarded assignee")
        for role in (BoardMembership.Role.VIEWER, BoardMembership.Role.COLLABORATOR):
            token = self._pat(self._add_member(role))
            results = [
                self._call("update_card", token, card_id=card.id, assignee=value)
                for value in ("update-assignable", "no-such-user")
            ]
            self.assertEqual(results[0], results[1], role)
            self.assertEqual(results[0]["error"]["code"], "permission_denied", role)
        card.refresh_from_db()
        self.assertIsNone(card.assignee_id)

    def test_assignee_by_username_all_content_user_without_membership(self):
        # Intended assignable set (#1716): instance-wide content access keeps
        # a user assignable on any board; a plain non-member is refused.
        all_content = _make_user("update-all-content", email="update-all@example.com")
        all_content.can_access_all_content = True
        all_content.save(update_fields=["can_access_all_content"])
        _make_user("update-outsider", email="update-outsider@example.com")
        card = _make_card(self.column, self.swimlane, title="Scope pin")
        result = self._call(
            "update_card", self.write_token, card_id=card.id, assignee="update-all-content",
        )
        self.assertEqual(result["assignee"]["username"], "update-all-content")
        card.refresh_from_db()
        self.assertEqual(card.assignee_id, all_content.id)
        result = self._call(
            "update_card", self.write_token, card_id=card.id, assignee="update-outsider",
        )
        self.assertEqual(result["error"]["code"], "validation_error")
        card.refresh_from_db()
        self.assertEqual(card.assignee_id, all_content.id)

    def test_assignee_by_username(self):
        member = _make_user("update-assignee", email="update-assignee@example.com")
        _make_membership(self.board, member, role=BoardMembership.Role.MEMBER)
        card = _make_card(self.column, self.swimlane, title="Unassigned")
        result = self._call(
            "update_card", self.write_token, card_id=card.id, assignee="update-assignee",
        )
        self.assertEqual(result["assignee"]["username"], "update-assignee")
        card.refresh_from_db()
        self.assertEqual(card.assignee_id, member.id)

    def test_collaborator_and_viewer_denied(self):
        card = _make_card(self.column, self.swimlane, title="Guarded")
        for role in (BoardMembership.Role.COLLABORATOR, BoardMembership.Role.VIEWER):
            user = self._add_member(role)
            result = self._call(
                "update_card", self._pat(user), card_id=card.id, title="Hacked",
            )
            self.assertEqual(result["error"]["code"], "permission_denied", f"role={role}")

    def test_write_tool_denied_without_mcp_write_scope(self):
        card = _make_card(self.column, self.swimlane, title="Locked")
        read_only_token = self._pat(self.user, scopes=(SCOPE_MCP_READ,))
        result = self._call(
            "update_card", read_only_token, card_id=card.id, title="Nope",
        )
        self.assertEqual(result["error"]["code"], "missing_scope")
        card.refresh_from_db()
        self.assertEqual(card.title, "Locked")

    def test_card_deleted_mid_update_is_not_found_not_reinserted(self):
        """A delete landing between the tool's lookup and the service's write
        must answer card_not_found, not re-create the card via save()'s
        INSERT fallback (#1587)."""
        from unittest.mock import patch

        from boards.services import cards as card_services

        card = _make_card(self.column, self.swimlane, title="Doomed")
        real_update = card_services.update_card

        def delete_then_update(**kwargs):
            Card.objects.filter(pk=kwargs["card"].pk).delete()
            return real_update(**kwargs)

        with patch("mcp_server.tools.card_services.update_card", side_effect=delete_then_update):
            result = self._call("update_card", self.write_token, card_id=card.id, title="Back?")
        self.assertEqual(result["error"]["code"], "card_not_found")
        self.assertFalse(Card.objects.filter(pk=card.pk).exists())


class BroadcastPayloadShapeTests(CrudToolsTestCase):
    """create/move/update broadcast a CardSerializer card, as REST does (#1926).

    The tools passed a render that built their own return shape, and the
    service broadcasts and records whatever render returns: column/swimlane
    as {id, name} objects, label names, no uid/version/blocker_count. A web
    client matches card frames on ``id`` against CardSerializer cards and
    could not apply them. Each test checks the stored BoardEvent row (which
    is exactly what the socket frame carries) against the REST rendering of
    the same card, and that the tool's own return shape is unchanged.
    """

    def _events(self, event):
        return list(
            BoardEvent.objects.filter(board_id=self.board.id, event=event)
            .order_by("id").values_list("data", flat=True)
        )

    def _rest_card(self, card_id):
        (payload,) = render_card_payloads(self.board, [card_id])
        # A plain dict with JSON-native values, as the stored row holds.
        return json.loads(json.dumps(payload, cls=JSONEncoder))

    def _assert_rest_card(self, data, card_id):
        card = Card.objects.get(pk=card_id)
        self.assertEqual(data["id"], card.id)
        self.assertEqual(data["uid"], card.uid)
        self.assertEqual(data["version"], card.version)
        self.assertEqual(data["blocker_count"], 0)
        # Foreign keys are plain ids in the REST shape, not {id, name}.
        self.assertEqual(data["column"], card.column_id)
        self.assertEqual(data["swimlane"], card.swimlane_id)
        self.assertEqual(data, self._rest_card(card_id))

    def test_create_card_broadcasts_a_rest_card(self):
        from boards.models import Label

        Label.objects.create(board=self.board, name="urgent")
        result = self._call(
            "create_card", self.write_token, board_id=self.board.id,
            column_id=self.column.id, swimlane_id=self.swimlane.id, title="Wired",
            labels=["urgent"],
        )
        (data,) = self._events("card.created")
        self._assert_rest_card(data, result["id"])
        # The tool's own return is the documented MCP shape, unchanged.
        self.assertEqual(result["column"], {"id": self.column.id, "name": "Backlog"})
        self.assertEqual(result["labels"], ["urgent"])
        self.assertNotIn("uid", result)

    def test_create_card_with_position_broadcasts_rest_create_and_move(self):
        _make_card(self.column, self.swimlane, title="Sibling", position=0)
        result = self._call(
            "create_card", self.write_token, board_id=self.board.id,
            column_id=self.column.id, swimlane_id=self.swimlane.id, title="First",
            position=0,
        )
        self.assertEqual(result["position"], 0)
        self.assertEqual(result["swimlane"], {"id": self.swimlane.id, "name": "General"})
        (created,) = self._events("card.created")
        self.assertEqual(created["id"], result["id"])
        self.assertIn("uid", created)
        # The follow-up same-cell reorder: {card} with no movement, as the
        # same reorder over REST broadcasts it.
        (moved,) = self._events("card.moved")
        self.assertEqual(set(moved), {"card"})
        self._assert_rest_card(moved["card"], result["id"])
        self.assertEqual(moved["card"]["position"], 0)

    def test_move_card_broadcasts_rest_card_and_movement(self):
        card = _make_card(self.column, self.swimlane, title="Movable")
        result = self._call(
            "move_card", self.write_token, card_id=card.id, to_column_id=self.other_column.id,
        )
        (data,) = self._events("card.moved")
        self.assertEqual(set(data), {"card", "movement"})
        self._assert_rest_card(data["card"], card.id)
        movement = CardMovement.objects.get(card=card, to_column=self.other_column)
        self.assertEqual(data["movement"]["id"], movement.id)
        self.assertEqual(data["movement"]["card_uid"], card.uid)
        self.assertEqual(data["movement"]["to_column"], self.other_column.id)
        self.assertEqual(data["movement"]["to_column_name"], "Doing")
        # The tool returns its own shapes for both.
        self.assertEqual(result["card"]["column"], {"id": self.other_column.id, "name": "Doing"})
        self.assertEqual(result["movement"]["to_column"], "Doing")
        self.assertNotIn("card_uid", result["movement"])

    def test_same_cell_reorder_broadcasts_card_without_movement(self):
        card = _make_card(self.column, self.swimlane, title="A", position=0)
        _make_card(self.column, self.swimlane, title="B", position=1)
        result = self._call(
            "move_card", self.write_token, card_id=card.id,
            to_column_id=self.column.id, position=1,
        )
        self.assertIsNone(result["movement"])
        (data,) = self._events("card.moved")
        self.assertEqual(set(data), {"card"})
        self._assert_rest_card(data["card"], card.id)

    def test_update_card_broadcasts_a_rest_card(self):
        card = _make_card(self.column, self.swimlane, title="Old")
        result = self._call("update_card", self.write_token, card_id=card.id, title="New")
        (data,) = self._events("card.updated")
        self._assert_rest_card(data, card.id)
        self.assertEqual(data["title"], "New")
        self.assertEqual(result["title"], "New")
        self.assertEqual(result["column"], {"id": self.column.id, "name": "Backlog"})
        self.assertNotIn("version", result)


class ArchiveCardTests(CrudToolsTestCase):
    def test_archives_card(self):
        card = _make_card(self.column, self.swimlane, title="To archive")
        result = self._call("archive_card", self.write_token, card_id=card.id)
        self.assertEqual(result["card_id"], card.id)
        self.assertIsNotNone(result["archived_at"])
        card.refresh_from_db()
        self.assertIsNotNone(card.archived_at)

    def test_archiving_a_blocker_sends_its_peer_a_full_card_update(self):
        """The blocked card's card.updated is a full card with the new count (#1634).

        The tool's own `render` returns {card_id, archived_at}; the service
        used it for the peers too, so the feed and the socket got a
        card.updated that no client could apply.
        """
        blocker = _make_card(self.column, self.swimlane, title="Blocker")
        peer = _make_card(self.other_column, self.swimlane, title="Blocked", position=1)
        CardRelation.objects.create(
            from_card=blocker, to_card=peer, relation_type=CardRelation.Type.BLOCKS,
        )
        result = self._call("archive_card", self.write_token, card_id=blocker.id)
        self.assertIsNotNone(result["archived_at"])
        rows = list(
            BoardEvent.objects.filter(board_id=self.board.id, event="card.updated")
            .values_list("data", flat=True)
        )
        self.assertEqual(len(rows), 1, rows)
        data = rows[0]
        self.assertEqual(data["id"], peer.id)
        self.assertEqual(data["uid"], peer.uid)
        self.assertEqual(data["column"], self.other_column.id)
        self.assertEqual(data["blocker_count"], 0)
        self.assertNotIn("card_id", data)

    def test_idempotent_on_already_archived_card(self):
        card = _make_card(self.column, self.swimlane, title="Already gone", archived_at=timezone.now())
        result = self._call("archive_card", self.write_token, card_id=card.id)
        self.assertEqual(result["card_id"], card.id)
        self.assertIsNotNone(result["archived_at"])

    def test_collaborator_and_viewer_denied(self):
        card = _make_card(self.column, self.swimlane, title="Guarded")
        for role in (BoardMembership.Role.COLLABORATOR, BoardMembership.Role.VIEWER):
            user = self._add_member(role)
            result = self._call("archive_card", self._pat(user), card_id=card.id)
            self.assertEqual(result["error"]["code"], "permission_denied", f"role={role}")

    def test_write_tool_denied_without_mcp_write_scope(self):
        card = _make_card(self.column, self.swimlane, title="Locked")
        read_only_token = self._pat(self.user, scopes=(SCOPE_MCP_READ,))
        result = self._call("archive_card", read_only_token, card_id=card.id)
        self.assertEqual(result["error"]["code"], "missing_scope")
        card.refresh_from_db()
        self.assertIsNone(card.archived_at)

    def test_card_not_found_for_nonexistent_card(self):
        result = self._call("archive_card", self.write_token, card_id=999999)
        self.assertEqual(result["error"]["code"], "card_not_found")

    def test_card_deleted_mid_archive_is_not_found(self):
        """A delete landing after the service's read must answer
        card_not_found, not crash on a save that matches no row (#1587).
        Injected at the service's card lock, so the lock is what answers."""
        from unittest.mock import patch

        from boards.services import cards as card_services

        card = _make_card(self.column, self.swimlane, title="Doomed")
        real_lock = card_services.lock_card_for_write

        def delete_then_lock(card_id):
            Card.objects.filter(pk=card_id).delete()
            return real_lock(card_id)

        with patch("boards.services.cards.lock_card_for_write", side_effect=delete_then_lock):
            result = self._call("archive_card", self.write_token, card_id=card.id)
        self.assertEqual(result["error"]["code"], "card_not_found")


class MaintenanceModeTests(CrudToolsTestCase):
    """Maintenance mode must reach MCP writes too (#783).

    ``/mcp`` is mounted outside Django's handler by ``McpPathRouter``, so
    ``MaintenanceModeMiddleware`` never sees these requests — the block is
    enforced in ``mcp_server.server._require_maintenance_off`` instead. Without
    these tests nothing would catch the mount drifting back under, or a new
    write tool being added that forgets the gate.
    """

    def setUp(self):
        super().setUp()
        invalidate_maintenance_mode_cache()
        self.addCleanup(invalidate_maintenance_mode_cache)

    def _set_maintenance(self, active, message=""):
        s = SiteSetting.get()
        s.maintenance_mode = active
        s.maintenance_message = message
        s.save(update_fields=["maintenance_mode", "maintenance_message"])

    def test_create_card_blocked_during_maintenance(self):
        self._set_maintenance(True, "Migrating the database.")
        result = self._call(
            "create_card", self.write_token, board_id=self.board.id,
            column_id=self.column.id, swimlane_id=self.swimlane.id,
            title="Should not exist",
        )
        self.assertEqual(result["error"]["code"], "maintenance_mode")
        self.assertEqual(result["error"]["detail"], "Migrating the database.")
        self.assertFalse(Card.objects.filter(title="Should not exist").exists())

    def test_every_write_tool_is_gated(self):
        """Pins the whole write surface, not just the one tool a test picked."""
        card = _make_card(self.column, self.swimlane, title="Untouched")
        self._set_maintenance(True)
        calls = {
            "create_card": dict(
                board_id=self.board.id, column_id=self.column.id,
                swimlane_id=self.swimlane.id, title="Nope",
            ),
            "move_card": dict(card_id=card.id, to_column_id=self.other_column.id),
            "update_card": dict(card_id=card.id, title="Renamed"),
            "archive_card": dict(card_id=card.id),
        }
        for name, arguments in calls.items():
            with self.subTest(tool=name):
                result = self._call(name, self.write_token, **arguments)
                self.assertEqual(result["error"]["code"], "maintenance_mode")
        card.refresh_from_db()
        self.assertEqual(card.title, "Untouched")
        self.assertIsNone(card.archived_at)
        self.assertEqual(card.column_id, self.column.id)

    def test_read_tools_still_work_during_maintenance(self):
        self._set_maintenance(True)
        result = self._call("list_columns", self.write_token, board_id=self.board.id)
        self.assertNotIn("error", result if isinstance(result, dict) else {})

    def test_site_admin_pat_is_exempt(self):
        """Matches the REST rule exactly — the same admin PAT must not be
        honored over one transport and refused over the other."""
        self.user.is_site_admin = True
        self.user.save(update_fields=["is_site_admin"])
        self._set_maintenance(True)
        result = self._call(
            "create_card", self.write_token, board_id=self.board.id,
            column_id=self.column.id, swimlane_id=self.swimlane.id, title="Admin card",
        )
        self.assertNotIn("error", result)
        self.assertTrue(Card.objects.filter(title="Admin card").exists())

    def test_writes_resume_when_maintenance_is_turned_off(self):
        self._set_maintenance(True)
        self._set_maintenance(False)
        result = self._call(
            "create_card", self.write_token, board_id=self.board.id,
            column_id=self.column.id, swimlane_id=self.swimlane.id, title="After",
        )
        self.assertNotIn("error", result)
        self.assertTrue(Card.objects.filter(title="After").exists())


class DemoModeTests(CrudToolsTestCase):
    """The hosted-demo fence must reach MCP writes too (#1179).

    ``/mcp`` is mounted outside Django's handler, so ``DemoModeMiddleware``
    never sees it; ``_require_demo_off`` inside ``_deny_write`` is the guard.
    Unlike maintenance mode there is no site-admin exemption and no allowlist.
    """

    def test_every_write_tool_is_refused_even_for_a_site_admin(self):
        from django.test import override_settings

        self.user.is_site_admin = True
        self.user.save(update_fields=["is_site_admin"])
        card = _make_card(self.column, self.swimlane, title="Untouched")
        calls = {
            "create_card": dict(
                board_id=self.board.id, column_id=self.column.id,
                swimlane_id=self.swimlane.id, title="Nope",
            ),
            "move_card": dict(card_id=card.id, to_column_id=self.other_column.id),
            "update_card": dict(card_id=card.id, title="Renamed"),
            "archive_card": dict(card_id=card.id),
        }
        with override_settings(DEMO_MODE=True):
            for name, arguments in calls.items():
                with self.subTest(tool=name):
                    result = self._call(name, self.write_token, **arguments)
                    self.assertEqual(result["error"]["code"], "demo_read_only")
            # Reads still work.
            listed = self._call("list_columns", self.write_token, board_id=self.board.id)
            self.assertNotIn("error", listed if isinstance(listed, dict) else {})
        card.refresh_from_db()
        self.assertEqual(card.title, "Untouched")
        self.assertIsNone(card.archived_at)
        self.assertFalse(Card.objects.filter(title="Nope").exists())


class ToolResultEnvelopeTests(CrudToolsTestCase):
    """Pins the wire envelope of a tool result on the pinned SDK (#2004).

    A tool-domain failure is ``isError: true`` with the ``{"error": {...}}``
    payload under ``structuredContent.result`` and as the one JSON text block;
    a success is ``isError: false``. Before #2004 a failure was
    ``isError: false``. An SDK bump that changes any part of this (drops the
    structured payload from an error result, re-renders the text block,
    changes the advertised output schema) must fail here, not in a client.
    """

    def _wire(self, name, token, **arguments):
        status, body = self._tools_call(name, token, arguments)
        self.assertEqual(status, 200, body)
        payload = _parse_sse(body)
        self.assertNotIn("error", payload, payload)
        return payload["result"]

    def _assert_error_envelope(self, result, code):
        from mcp.server.mcpserver.utilities.func_metadata import _convert_to_content

        self.assertIs(result["isError"], True, result)
        error = result["structuredContent"]["result"]
        self.assertEqual(set(result["structuredContent"]), {"result"})
        self.assertEqual(set(error), {"error"})
        self.assertEqual(error["error"]["code"], code)
        # Exactly one text block, byte-identical to what the SDK renders for
        # the same dict returned as a success, so a client parsing the text
        # sees the same JSON it saw before the isError flip.
        self.assertEqual(len(result["content"]), 1, result)
        self.assertEqual(result["content"][0]["type"], "text")
        self.assertEqual(result["content"][0]["text"], _convert_to_content(error)[0].text)
        self.assertEqual(json.loads(result["content"][0]["text"]), error)

    def test_domain_error_is_is_error_true_with_structured_payload(self):
        result = self._wire("list_columns", self.raw_token, board_id=999999)
        self._assert_error_envelope(result, "board_not_found")
        self.assertEqual(
            result["structuredContent"]["result"]["error"],
            {"code": "board_not_found", "detail": "No Board matches the given query."},
        )

    def test_structured_fields_survive_on_a_wip_limit_error(self):
        # The fields an agent acts on (counters, column name) must not be
        # lost to the isError flip: the reason tools return rather than raise.
        self.column.wip_limit = 1
        self.column.save(update_fields=["wip_limit"])
        _make_card(self.column, self.swimlane, title="Fills it")
        result = self._wire(
            "create_card", self.write_token, board_id=self.board.id,
            column_id=self.column.id, swimlane_id=self.swimlane.id, title="Over",
        )
        self._assert_error_envelope(result, "wip_limit_exceeded")
        error = result["structuredContent"]["result"]["error"]
        self.assertEqual(error["wip_limit"], 1)
        self.assertEqual(error["current_count"], 1)
        self.assertEqual(error["column_name"], "Backlog")

    def test_gate_denials_use_the_same_envelope(self):
        # missing_scope comes from server.py's write gate, not tools.py.
        read_only = self._pat(self.user, scopes=(SCOPE_MCP_READ,))
        result = self._wire(
            "create_card", read_only, board_id=self.board.id,
            column_id=self.column.id, swimlane_id=self.swimlane.id, title="No scope",
        )
        self._assert_error_envelope(result, "missing_scope")

    def test_validation_error_uses_the_same_envelope(self):
        result = self._wire(
            "create_card", self.write_token, board_id=self.board.id,
            column_id=self.column.id, swimlane_id=self.swimlane.id, title="Bad label",
            labels=["does-not-exist"],
        )
        self._assert_error_envelope(result, "validation_error")

    def test_list_cards_error_uses_the_same_envelope(self):
        # list_cards builds its own CallToolResult on the truncated path; its
        # error path must still go through the envelope.
        result = self._wire("list_cards", self.raw_token, board_id=999999)
        self._assert_error_envelope(result, "board_not_found")

    def test_success_is_is_error_false(self):
        for name, arguments in (
            ("list_boards", {}),
            ("list_columns", {"board_id": self.board.id}),
            ("list_cards", {"board_id": self.board.id, "include_meta": True}),
        ):
            with self.subTest(tool=name):
                result = self._wire(name, self.raw_token, **arguments)
                self.assertIs(result["isError"], False, result)
                self.assertNotIn(
                    "error",
                    result["structuredContent"]["result"]
                    if isinstance(result["structuredContent"]["result"], dict) else {},
                )

    def test_schema_level_argument_failure_is_unstructured(self):
        # A mistyped argument is rejected by the SDK before any Visiban code
        # runs: isError true, text only, no structuredContent. Documented in
        # docs/api/mcp.md (Tool errors) so clients do not expect a `code`.
        result = self._wire("list_columns", self.raw_token, board_id="not-a-number")
        self.assertIs(result["isError"], True)
        self.assertIsNone(result.get("structuredContent"))
        self.assertIn("board_id", result["content"][0]["text"])

    def test_advertised_output_schema_is_unchanged(self):
        # Registering tools as Annotated[CallToolResult, list[dict] | dict]
        # must advertise exactly the schema a plain `-> list[dict] | dict`
        # tool does, so the #2004 change is invisible in tools/list.
        from mcp.server.mcpserver.utilities.func_metadata import func_metadata

        def plain() -> list[dict] | dict:  # pragma: no cover - never called
            return {}

        expected = {k: v for k, v in func_metadata(plain).output_schema.items() if k != "title"}
        status, body = self.client_.post(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, token=self.raw_token,
        )
        self.assertEqual(status, 200)
        tools_ = _parse_sse(body)["result"]["tools"]
        self.assertTrue(tools_)
        for tool in tools_:
            with self.subTest(tool=tool["name"]):
                schema = dict(tool["outputSchema"])
                # The title is derived from the function name, as before.
                self.assertEqual(schema.pop("title"), f"{tool['name']}Output")
                self.assertEqual(schema, expected)

    def test_removed_assignee_email_is_not_in_the_input_schema(self):
        # create_card/update_card take an SDK-injected `ctx: Context` only
        # to see the raw arguments (server._sent_arguments). It must not
        # leak into any tool's advertised schema, and the declared argument
        # set is pinned so the #2004 change is visible here if it drifts.
        status, body = self.client_.post(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, token=self.raw_token,
        )
        self.assertEqual(status, 200)
        tools_ = _parse_sse(body)["result"]["tools"]
        schemas = {t["name"]: t["inputSchema"] for t in tools_}
        self.assertEqual(set(schemas["create_card"]["properties"]), {
            "board_id", "column_id", "swimlane_id", "title", "description",
            "priority", "assignee", "labels", "due_date", "position",
        })
        self.assertEqual(
            schemas["create_card"]["required"], ["board_id", "column_id", "swimlane_id", "title"],
        )
        self.assertEqual(set(schemas["update_card"]["properties"]), {
            "card_id", "title", "description", "priority", "assignee", "labels", "due_date",
        })
        self.assertEqual(schemas["update_card"]["required"], ["card_id"])
        for tool in tools_:
            with self.subTest(tool=tool["name"]):
                text = json.dumps(tool).lower()
                self.assertNotIn("ctx", text)
                self.assertNotIn("context", text)
                self.assertNotIn("assignee_email", text)
                # No additionalProperties: false; undeclared arguments reach
                # the server and only removed names are refused.
                self.assertNotIn("additionalProperties", tool["inputSchema"])

    def test_sdk_client_sees_is_error_and_structured_content(self):
        """Drive the server with the SDK's own client, as an agent would.

        The raw JSON-RPC tests above pin the wire; this pins what the SDK's
        ``Client`` hands its caller, including that its client-side output
        schema validation does not reject an error result.
        """
        import httpx2
        from asgiref.sync import async_to_sync
        from mcp import Client
        from mcp.client.streamable_http import streamable_http_client

        app = self.client_.app
        token = self.raw_token

        async def run():
            async with httpx2.AsyncClient(
                transport=httpx2.ASGITransport(app=app),
                base_url="http://localhost",
                headers={"authorization": f"Bearer {token}"},
            ) as http:
                async with Client(
                    streamable_http_client("http://localhost/mcp", http_client=http),
                ) as client:
                    failed = await client.call_tool("list_columns", {"board_id": 999999})
                    ok = await client.call_tool("list_columns", {"board_id": self.board.id})
            return failed, ok

        failed, ok = async_to_sync(run)()
        self.assertIs(failed.is_error, True)
        self.assertEqual(failed.structured_content["result"]["error"]["code"], "board_not_found")
        self.assertEqual(json.loads(failed.content[0].text), failed.structured_content["result"])
        self.assertIs(ok.is_error, False)
        self.assertEqual(len(ok.structured_content["result"]), 2)
