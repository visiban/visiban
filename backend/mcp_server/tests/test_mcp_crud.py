"""Integration tests for the MCP CRUD tools (#512).

Same MCP_SERVER_ENABLED skip-guard as test_mcp.py, and the harness classes
below (McpTestCase/McpRequest/_parse_sse) are imported from there rather than
duplicated, so the two files cannot drift apart on how a request is driven.
"""
import pytest
from django.conf import settings

if not settings.MCP_SERVER_ENABLED:  # pragma: no cover - exercised only in the flagged CI job
    pytest.skip(
        "MCP server disabled; set MCP_SERVER_ENABLED=true to run these.",
        allow_module_level=True,
    )

from django.utils import timezone

from accounts.models import (
    SCOPE_MCP_READ,
    SCOPE_MCP_WRITE,
    PersonalAccessToken,
    SiteSetting,
    invalidate_maintenance_mode_cache,
)
from boards.models import (
    BoardMembership, Card, CardActivity, CardMovement,
)
from boards.tests.conftest import (
    _make_board, _make_card, _make_column, _make_membership, _make_swimlane,
    _make_user,
)

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
        self.assertFalse(result["isError"], result)
        return result["structuredContent"]["result"]

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
        self.assertEqual(row["assignee"], self.user.email)
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

    def test_filters_by_assignee_email(self):
        other = _make_user("assignee-user", email="assignee@example.com")
        _make_membership(self.board, other, role=BoardMembership.Role.MEMBER)
        _make_card(self.column, self.swimlane, title="Mine", assignee=self.user)
        _make_card(self.column, self.swimlane, title="Theirs", position=1, assignee=other)

        result = self._call(
            "list_cards", self.raw_token, board_id=self.board.id, assignee="assignee@example.com",
        )
        self.assertEqual([c["title"] for c in result], ["Theirs"])


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

    def test_assignee_email_and_labels_resolve(self):
        from boards.models import Label

        # _make_user() leaves email blank by default, and an empty string is
        # deliberately the "unassign" sentinel (see _translate_card_fields) —
        # a real, non-blank email is needed to exercise assignment.
        assignee = _make_user("assignee-for-create", email="assignee@example.com")
        _make_membership(self.board, assignee, role=BoardMembership.Role.MEMBER)
        Label.objects.create(board=self.board, name="urgent")

        result = self._call(
            "create_card", self.write_token, board_id=self.board.id,
            column_id=self.column.id, swimlane_id=self.swimlane.id, title="Assigned",
            assignee_email="assignee@example.com", labels=["urgent"],
        )
        self.assertEqual(result["assignee"], "assignee@example.com")
        self.assertEqual(result["labels"], ["urgent"])

    def test_unknown_assignee_email_is_a_validation_error(self):
        result = self._call(
            "create_card", self.write_token, board_id=self.board.id,
            column_id=self.column.id, swimlane_id=self.swimlane.id, title="Bad assignee",
            assignee_email="nobody@example.com",
        )
        self.assertEqual(result["error"]["code"], "validation_error")
        self.assertIn("assignee_email", result["error"]["errors"])
        self.assertFalse(Card.objects.filter(title="Bad assignee").exists())

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

    def test_empty_assignee_email_unassigns(self):
        card = _make_card(self.column, self.swimlane, title="Assigned", assignee=self.user)
        result = self._call("update_card", self.write_token, card_id=card.id, assignee_email="")
        self.assertIsNone(result["assignee"])

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


class ArchiveCardTests(CrudToolsTestCase):
    def test_archives_card(self):
        card = _make_card(self.column, self.swimlane, title="To archive")
        result = self._call("archive_card", self.write_token, card_id=card.id)
        self.assertEqual(result["card_id"], card.id)
        self.assertIsNotNone(result["archived_at"])
        card.refresh_from_db()
        self.assertIsNotNone(card.archived_at)

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
