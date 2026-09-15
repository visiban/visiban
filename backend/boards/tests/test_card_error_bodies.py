"""Byte-for-byte pins on every card-mutation error response body.

Written as the safety net for #1107, which moves the card invariants out of
``CardViewSet`` into ``boards.services.cards``. The existing suites assert only
``response.json()["code"]`` or the status code, so a refactor could add a
``detail`` key, drop ``card_weight``, or normalize the five mutually
incompatible 409/403 shapes into one — and every existing test would still
pass while the frontend broke.

``frontend/src/components/Board/MoveBlockedToast.tsx`` branches on ``code`` and
renders ``column_name`` / ``wip_limit`` / ``current_count`` / ``card_weight``
directly, so these dicts are a live 1.x contract, not backend-internal detail.
Each assertion here is an **exact dict equality** check for that reason.

These shapes are inconsistent on purpose-of-history, not by design:
``wip_limit_exceeded`` and ``weight_limit_exceeded`` carry no ``detail`` key at
all; ``wip_hard_blocked`` carries both ``detail`` and ``code``; the two
force-override denials carry only ``detail``; and the move assignee gate is the
only 403 in the module with a ``code``. Converging them needs a major version
bump — until then, this file is what keeps them frozen.
"""
from unittest.mock import patch

from django.test import TestCase
from rest_framework.test import APIClient

from boards.models import BoardMembership
from boards.tests.conftest import (
    _make_board, _make_card, _make_column, _make_membership, _make_swimlane,
    _make_user,
)

# DRF's default ``PermissionDenied`` detail. Four of the six card actions raise
# a bare ``PermissionDenied`` for the role allow-list, so they all render this.
_DRF_DEFAULT_403 = "You do not have permission to perform this action."


class CardErrorBodyTests(TestCase):
    def setUp(self):
        self._broadcast_patcher = patch("boards.broadcast.broadcast_board_event")
        self._broadcast_patcher.start()

        self.owner = _make_user("bodyowner")
        self.board = _make_board(self.owner)
        self.col_a = _make_column(self.board, "A", 0)
        self.col_b = _make_column(self.board, "B", 1)
        self.lane = _make_swimlane(self.board, "L", 0)
        self.card = _make_card(self.col_a, self.lane, title="Target")

        # A viewer — fails every card-mutation role allow-list.
        self.viewer = _make_user("bodyviewer")
        _make_membership(self.board, self.viewer, BoardMembership.Role.VIEWER)

        # A plain member who did not create self.card — fails every ownership
        # gate but passes the role allow-list.
        self.member = _make_user("bodymember")
        _make_membership(self.board, self.member, BoardMembership.Role.MEMBER)

        self.client = APIClient()

    def tearDown(self):
        self._broadcast_patcher.stop()

    # ── helpers ───────────────────────────────────────────────────────────

    def _as(self, user):
        self.client.force_authenticate(user)
        return self.client

    def _card_url(self, suffix=""):
        return f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/{suffix}"

    def _assert_body(self, resp, status_code, body):
        self.assertEqual(resp.status_code, status_code)
        self.assertEqual(resp.json(), body)

    def _move(self, user, **payload):
        payload.setdefault("column_id", self.col_b.pk)
        payload.setdefault("swimlane_id", self.lane.pk)
        payload.setdefault("position", 0)
        qs = payload.pop("_qs", "")
        return self._as(user).post(self._card_url("move/") + qs, payload, format="json")

    # ── create ────────────────────────────────────────────────────────────

    def test_create_role_denied_body(self):
        resp = self._as(self.viewer).post(
            f"/api/v1/boards/{self.board.pk}/cards/",
            {"title": "x", "column": self.col_a.pk, "swimlane": self.lane.pk},
            format="json",
        )
        self._assert_body(resp, 403, {"detail": _DRF_DEFAULT_403})

    def test_create_in_disallowed_column_body(self):
        # allow_card_creation defaults to False on a bare Column.
        self.assertFalse(self.col_a.allow_card_creation)
        resp = self._as(self.owner).post(
            f"/api/v1/boards/{self.board.pk}/cards/",
            {"title": "x", "column": self.col_a.pk, "swimlane": self.lane.pk},
            format="json",
        )
        self._assert_body(
            resp, 400, {"column": "Card creation is not allowed in this column."}
        )

    # ── destroy ───────────────────────────────────────────────────────────

    def test_destroy_role_denied_body(self):
        resp = self._as(self.viewer).delete(self._card_url())
        self._assert_body(resp, 403, {"detail": _DRF_DEFAULT_403})

    def test_destroy_ownership_denied_body(self):
        resp = self._as(self.member).delete(self._card_url())
        self._assert_body(resp, 403, {"detail": "You can only delete cards you created."})

    # ── archive / unarchive ───────────────────────────────────────────────

    def test_archive_role_denied_body(self):
        resp = self._as(self.viewer).post(self._card_url("archive/"))
        self._assert_body(resp, 403, {"detail": _DRF_DEFAULT_403})

    def test_archive_ownership_denied_body(self):
        resp = self._as(self.member).post(self._card_url("archive/"))
        self._assert_body(resp, 403, {"detail": "You can only archive cards you created."})

    def test_unarchive_role_denied_body(self):
        resp = self._as(self.viewer).post(self._card_url("unarchive/"))
        self._assert_body(resp, 403, {"detail": _DRF_DEFAULT_403})

    def test_unarchive_ownership_denied_body(self):
        resp = self._as(self.member).post(self._card_url("unarchive/"))
        self._assert_body(resp, 403, {"detail": "You can only restore cards you created."})

    # ── update ────────────────────────────────────────────────────────────

    def test_update_role_denied_body(self):
        resp = self._as(self.viewer).patch(self._card_url(), {"title": "x"}, format="json")
        self._assert_body(resp, 403, {"detail": _DRF_DEFAULT_403})

    def test_update_ownership_denied_body(self):
        resp = self._as(self.member).patch(self._card_url(), {"title": "x"}, format="json")
        self._assert_body(resp, 403, {"detail": "You can only edit cards you created."})

    def test_update_ownership_denied_assignee_variant_body(self):
        """The ownership gate returns a *different* message when the body
        carries ``assignee_id`` — assignment is the common case and gets a
        message naming the entitlement needed."""
        resp = self._as(self.member).patch(
            self._card_url(), {"assignee_id": self.member.pk}, format="json"
        )
        self._assert_body(
            resp,
            403,
            {"detail": "Assigning cards requires Moderator or Admin access — ask a board admin."},
        )

    def test_update_column_change_rejected_body(self):
        """#1106: PATCHing ``column`` is rejected with a ``use_move_endpoint``
        body whose detail embeds the move URL the client should use instead."""
        resp = self._as(self.owner).patch(
            self._card_url(), {"column": self.col_b.pk}, format="json"
        )
        self._assert_body(
            resp,
            400,
            {
                "code": "use_move_endpoint",
                "detail": (
                    "Changing a card's column via PATCH/PUT is not allowed — "
                    "it bypasses WIP/weight limits and the movement audit trail. "
                    f"Use POST /api/v1/boards/{self.board.pk}/cards/{self.card.pk}/move/ instead."
                ),
            },
        )

    def test_update_swimlane_change_rejected_body(self):
        other_lane = _make_swimlane(self.board, "L2", 1)
        resp = self._as(self.owner).patch(
            self._card_url(), {"swimlane": other_lane.pk}, format="json"
        )
        self._assert_body(
            resp,
            400,
            {
                "code": "use_move_endpoint",
                "detail": (
                    "Changing a card's swimlane via PATCH/PUT is not allowed — "
                    "it bypasses WIP/weight limits and the movement audit trail. "
                    f"Use POST /api/v1/boards/{self.board.pk}/cards/{self.card.pk}/move/ instead."
                ),
            },
        )

    # ── move: permission and concurrency ──────────────────────────────────

    def test_move_role_denied_body(self):
        resp = self._move(self.viewer)
        self._assert_body(resp, 403, {"detail": _DRF_DEFAULT_403})

    def test_move_assignee_gate_body(self):
        """The only 403 in the module that carries a ``code`` key."""
        self.card.assignee = self.owner
        self.card.created_by = self.owner
        self.card.save(update_fields=["assignee", "created_by"])
        resp = self._move(self.member)
        self._assert_body(
            resp,
            403,
            {
                "code": "permission_denied",
                "detail": (
                    "Moving a card assigned to another member requires "
                    "Moderator or Admin access — ask a board admin."
                ),
            },
        )

    def test_move_non_integer_version_body(self):
        resp = self._move(self.owner, version="not-a-number")
        self._assert_body(resp, 400, {"detail": "version must be an integer."})

    def test_a_malformed_version_does_not_mask_a_403_or_404(self):
        """The version 400 is reported only after the role, lookup and
        assignment checks pass.

        A caller who sends a bad version *and* lacks permission must see the
        permission answer. Pinned because the obvious refactor — parsing the
        version in the view before calling the service — silently reorders
        these and turns a 403 into a 400.
        """
        resp = self._move(self.viewer, version="not-a-number")
        self._assert_body(resp, 403, {"detail": _DRF_DEFAULT_403})

        resp = self._as(self.owner).post(
            f"/api/v1/boards/{self.board.pk}/cards/999999/move/",
            {"column_id": self.col_b.pk, "swimlane_id": self.lane.pk,
             "position": 0, "version": "not-a-number"},
            format="json",
        )
        self._assert_body(resp, 404, {"detail": "No Card matches the given query."})

        self.card.assignee = self.owner
        self.card.created_by = self.owner
        self.card.save(update_fields=["assignee", "created_by"])
        resp = self._move(self.member, version="not-a-number")
        self.assertEqual(resp.status_code, 403)
        self.assertEqual(resp.json()["code"], "permission_denied")

    def test_a_numeric_string_version_is_still_accepted(self):
        """Coercion is `int()`, so a client sending the version as a JSON string
        keeps working — required by the 1.0 compatibility contract."""
        self.card.refresh_from_db()
        resp = self._move(self.owner, version=str(self.card.version))
        self.assertEqual(resp.status_code, 200)

    def test_move_version_conflict_body(self):
        self.card.refresh_from_db()
        stale = self.card.version + 5
        resp = self._move(self.owner, version=stale)
        self._assert_body(
            resp,
            409,
            {
                "code": "version_conflict",
                "detail": "This card was modified by another user. Please refresh and try again.",
                "current_version": self.card.version,
            },
        )

    # ── move: cross-board and missing rows ────────────────────────────────

    def test_move_to_another_boards_column_body(self):
        other_board = _make_board(self.owner, name="Other")
        foreign_col = _make_column(other_board, "Foreign", 0)
        resp = self._move(self.owner, column_id=foreign_col.pk)
        self._assert_body(resp, 404, {"detail": "No Column matches the given query."})

    def test_move_to_another_boards_swimlane_body(self):
        other_board = _make_board(self.owner, name="Other2")
        foreign_lane = _make_swimlane(other_board, "Foreign", 0)
        resp = self._move(self.owner, swimlane_id=foreign_lane.pk)
        self._assert_body(resp, 404, {"detail": "No Swimlane matches the given query."})

    def test_move_card_from_another_board_body(self):
        other_board = _make_board(self.owner, name="Other3")
        other_col = _make_column(other_board, "C", 0)
        other_lane = _make_swimlane(other_board, "L", 0)
        foreign_card = _make_card(other_col, other_lane, title="Foreign")
        resp = self._as(self.owner).post(
            f"/api/v1/boards/{self.board.pk}/cards/{foreign_card.pk}/move/",
            {"column_id": self.col_b.pk, "swimlane_id": self.lane.pk, "position": 0},
            format="json",
        )
        self._assert_body(resp, 404, {"detail": "No Card matches the given query."})

    # ── move: WIP enforcement ─────────────────────────────────────────────

    def _fill_target_to_limit(self, limit=1):
        self.col_b.wip_limit = limit
        self.col_b.save(update_fields=["wip_limit"])
        for i in range(limit):
            _make_card(self.col_b, self.lane, title=f"filler{i}", position=i)

    def test_move_wip_hard_blocked_body(self):
        self.board.enforce_wip_hard = True
        self.board.save(update_fields=["enforce_wip_hard"])
        self._fill_target_to_limit(1)
        resp = self._move(self.owner)
        self._assert_body(
            resp,
            409,
            {
                "detail": "WIP limit enforced — move blocked.",
                "code": "wip_hard_blocked",
                "column_name": self.col_b.name,
                "current_count": 1,
                "wip_limit": 1,
            },
        )

    def test_move_wip_limit_exceeded_body_has_no_detail_key(self):
        self.board.enforce_wip_limits = True
        self.board.save(update_fields=["enforce_wip_limits"])
        self._fill_target_to_limit(1)
        resp = self._move(self.owner)
        self._assert_body(
            resp,
            409,
            {
                "code": "wip_limit_exceeded",
                "column_name": self.col_b.name,
                "current_count": 1,
                "wip_limit": 1,
            },
        )

    def test_move_wip_force_denied_for_non_admin_body(self):
        self.board.enforce_wip_limits = True
        self.board.save(update_fields=["enforce_wip_limits"])
        self._fill_target_to_limit(1)
        # The member must be allowed past the ownership gate to reach the
        # force check, so make them the card's creator.
        self.card.created_by = self.member
        self.card.save(update_fields=["created_by"])
        resp = self._move(self.member, _qs="?force=true")
        self._assert_body(resp, 403, {"detail": "Only board admins can override a WIP limit."})

    # ── move: weight enforcement ──────────────────────────────────────────

    def _set_weight_limit(self, limit, filler_weight):
        self.col_b.weight_limit = limit
        self.col_b.save(update_fields=["weight_limit"])
        _make_card(self.col_b, self.lane, title="heavy", position=0, weight=filler_weight)

    def test_move_weight_limit_exceeded_body(self):
        self.board.enforce_weight_limits = True
        self.board.save(update_fields=["enforce_weight_limits"])
        self._set_weight_limit(limit=3, filler_weight=3)
        self.card.weight = 2
        self.card.save(update_fields=["weight"])
        resp = self._move(self.owner)
        self._assert_body(
            resp,
            409,
            {
                "code": "weight_limit_exceeded",
                "column_name": self.col_b.name,
                "current_weight": 3,
                "weight_limit": 3,
                "card_weight": 2,
            },
        )

    def test_move_weight_force_denied_for_non_admin_body(self):
        self.board.enforce_weight_limits = True
        self.board.save(update_fields=["enforce_weight_limits"])
        self._set_weight_limit(limit=3, filler_weight=3)
        self.card.created_by = self.member
        self.card.weight = 2
        self.card.save(update_fields=["created_by", "weight"])
        resp = self._move(self.member, _qs="?force=true")
        self._assert_body(resp, 403, {"detail": "Only board admins can override a weight limit."})
