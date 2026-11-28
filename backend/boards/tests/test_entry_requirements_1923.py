"""#1923 MR B: column entry requirements, and the shared case table (#2582).

* The pure evaluator against every row of the shared fixture table.
* Enforcement in ``enforce_column_limits`` on every checked caller (forward
  move, create, restore, the admin form) and the exempt ones (backward move,
  lane-only move, weight update), in each mode (warn, block, hard).
* The 409 ``entry_requirements_unmet`` body, ``also``, and the WIP-only body
  staying unchanged; the Warn record and the additive 200 ``entry_unmet``.
* The override: reason required, ``CardOverride`` row, no override for hard.
* Lane scope derived from the field set, and lane N/A as satisfied.
* The replace-all PUT: RBAC, validation, cap, ``column.updated``.
* ``PublicColumnSerializer`` excludes the new fields.
* The query budget: 0 extra when ``entry_enforcement`` is NULL, <= 4 otherwise.
* Cascades and the dry-run ``affected_requirements`` (owner Q3).
"""

import json
import re
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from accounts.models import SiteSetting, User
from boards.admin import _limit_error_message
from boards.models import (
    Board, BoardMembership, Card, CardMovement, CardOverride, Column, ColumnEntryRequirement,
    CustomFieldDefinition, CustomFieldSet, CustomFieldValue, SubColumn, Swimlane,
    SwimlaneTrackException,
)
from boards.permissions import SITE_ADMIN
from boards.serializers import ColumnSerializer, PublicColumnSerializer
from boards.services import cards as card_services
from boards.services.entry_requirements import applies_in_lane, condition_met
from boards.services.errors import EntryRequirementsUnmet, ForceNotPermitted

R = BoardMembership.Role
PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"
FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "frontend" / "src" / "test" / "fixtures" / "entry-requirements-cases.json"
)


class SharedFixtureCiTriggerTests(TestCase):
    """The fixture lives under frontend/, outside ``backend/**``: a change to
    only that file must still run the pytest jobs that read it."""

    def test_fixture_is_in_the_backend_job_triggers(self):
        ci = Path(__file__).resolve().parents[3] / ".gitlab-ci.yml"
        if not ci.exists():
            self.skipTest("no repository root in this checkout")
        text = ci.read_text()
        rel = FIXTURE.relative_to(ci.parent).as_posix()
        for job in ("backend-test", "backend-test-migrations", "backend-test-coverage"):
            body = re.search(rf"^{job}:\n((?:[ \t].*\n|\n)*)", text, re.M).group(1)
            self.assertIn(f"- {rel}", body, f"{job} must run when {rel} changes")


class SharedCaseTableTests(TestCase):
    """#2582: one table, asserted here and (MR C) by the client's vitest."""

    def test_every_case_matches_the_server_evaluator(self):
        cases = json.loads(FIXTURE.read_text())["cases"]
        # Pinned, not a floor: dropping a case from the shared table fails here
        # (and in the client's vitest, which reads the same file). Adding one
        # means bumping this number on purpose.
        self.assertEqual(len(cases), 53)  # 44 + nine lt/lte cases (#2718)
        for case in cases:
            with self.subTest(case["name"]):
                lane = case.get("lane_id", "lane")
                if not applies_in_lane(
                    set_scope=case.get("set_scope"), set_lane_ids=set(case.get("set_lane_ids", [])),
                    lane_id=lane,
                ):
                    self.assertEqual(case["expected"], "not_applicable")
                    continue
                met = condition_met(
                    operator=case["operator"], operand=case.get("operand"),
                    field_type=case.get("field_type"), value=case.get("value"),
                    choice_resolutions=case.get("choice_resolutions") or {},
                    lane_not_applicable=case.get("lane_not_applicable", False),
                    set_values=[tuple(v) for v in case.get("set_values", [])],
                )
                self.assertEqual("met" if met else "unmet", case["expected"])


class _Fixture(TestCase):
    def setUp(self):
        SiteSetting.get()  # warm the cache so query counts are exact
        self.admin = User.objects.create_user(username="er_admin", password="pass")
        self.member = User.objects.create_user(username="er_member", password="pass")
        self.viewer = User.objects.create_user(username="er_viewer", password="pass")
        self.board = Board.objects.create(name="Entry", owner=self.admin)
        for user, role in ((self.admin, R.ADMIN), (self.member, R.MEMBER), (self.viewer, R.VIEWER)):
            BoardMembership.objects.create(board=self.board, user=user, role=role)
        self.src = Column.objects.create(board=self.board, name="Discovery", position=0, allow_card_creation=True)
        self.dst = Column.objects.create(board=self.board, name="Proposal", position=1, allow_card_creation=True)
        self.lane = Swimlane.objects.create(board=self.board, name="Enterprise", position=0)
        self.other_lane = Swimlane.objects.create(board=self.board, name="SMB", position=1)
        self.amount = CustomFieldDefinition.objects.create(
            board=self.board, name="Amount", field_type="number", position=0,
        )
        self.card = Card.objects.create(
            board=self.board, column=self.src, swimlane=self.lane, title="Deal",
            created_by=self.admin, position=0,
        )

    def _client(self, user):
        client = APIClient()
        client.force_authenticate(user)
        return client

    def _require(self, mode="block", column=None, **kw):
        column = column or self.dst
        kw.setdefault("field_definition", self.amount)
        kw.setdefault("operator", "gt")
        kw.setdefault("operand", 50000)
        req = ColumnEntryRequirement.objects.create(column=column, **kw)
        column.entry_enforcement = mode
        column.save(update_fields=["entry_enforcement"])
        return req

    def _move(self, user, *, column=None, lane=None, force=False, reason=None, card=None):
        card = card or self.card
        body = {"column_id": (column or self.dst).pk, "swimlane_id": (lane or self.lane).pk, "position": 0}
        if reason is not None:
            body["override_reason"] = reason
        url = f"/api/v1/boards/{self.board.pk}/cards/{card.pk}/move/" + ("?force=true" if force else "")
        with patch(PATCH_BROADCAST):
            return self._client(user).post(url, body, format="json")


class EnforcementTests(_Fixture):
    def test_block_refuses_a_member_with_the_documented_body(self):
        req = self._require("block")
        resp = self._move(self.member)
        self.assertEqual(resp.status_code, 409)
        body = resp.json()
        self.assertEqual(body["code"], "entry_requirements_unmet")
        self.assertEqual(body["mode"], "block")
        self.assertEqual(body["column_name"], "Proposal")
        self.assertEqual(body["also"], [])
        self.assertEqual(body["unmet"], [{
            "requirement_uid": req.uid, "operator": "gt", "operand": "50000",
            "field_uid": self.amount.uid, "field_name": "Amount",
            "field_set_uid": None, "field_set_name": None,
        }])
        self.card.refresh_from_db()
        self.assertEqual(self.card.column_id, self.src.pk)

    def test_met_requirement_lets_the_move_through_unchanged(self):
        self._require("block")
        CustomFieldValue.objects.create(card=self.card, field_definition=self.amount, value="60000")
        resp = self._move(self.member)
        self.assertEqual(resp.status_code, 200)
        self.assertNotIn("entry_unmet", resp.json())

    def test_block_admin_override_needs_a_reason_then_records_it(self):
        self._require("block")
        self.assertEqual(self._move(self.admin, force=True).status_code, 400)
        resp = self._move(self.admin, force=True, reason="Customer signed")
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["override"]["kinds"], ["entry_requirements"])
        row = CardOverride.objects.get(card=self.card)
        self.assertEqual(row.kind, "entry_requirements")
        self.assertEqual(row.reason, "Customer signed")
        self.assertEqual(row.actor_basis, "admin")
        # Ids and operators only, never the card's values.
        self.assertEqual(set(row.unmet[0]), {"kind", "requirement_uid", "operator", "field_uid", "field_set_uid"})

    def test_member_force_is_refused_with_the_entry_wording(self):
        self._require("block")
        resp = self._move(self.member, force=True, reason="please")
        self.assertEqual(resp.status_code, 403)
        self.assertEqual(resp.json()["detail"], ForceNotPermitted._DETAIL["entry_requirements"])

    def test_hard_refuses_even_an_admin_force(self):
        self._require("hard")
        resp = self._move(self.admin, force=True, reason="x")
        self.assertEqual(resp.status_code, 409)
        self.assertEqual(resp.json()["mode"], "hard")

    def test_warn_moves_records_and_returns_entry_unmet(self):
        req = self._require("warn")
        resp = self._move(self.member)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual([u["requirement_uid"] for u in resp.json()["entry_unmet"]], [req.uid])
        movement = CardMovement.objects.filter(card=self.card).latest("id")
        self.assertEqual(movement.entry_unmet[0]["requirement_uid"], req.uid)
        self.assertFalse(CardOverride.objects.exists())

    def test_backward_and_lane_only_moves_are_not_checked(self):
        self._require("hard", column=self.src)
        self.card.column = self.dst
        self.card.save(update_fields=["column"])
        self.assertEqual(self._move(self.member, column=self.src).status_code, 200)  # backward
        self._require("hard")
        self.card.refresh_from_db()
        # Lane-only move inside the column with requirements.
        self.card.column = self.dst
        self.card.save(update_fields=["column"])
        self.assertEqual(self._move(self.member, column=self.dst, lane=self.other_lane).status_code, 200)

    def test_off_with_rows_kept_is_not_checked(self):
        self._require("hard")
        Column.objects.filter(pk=self.dst.pk).update(entry_enforcement=None)
        self.assertEqual(self._move(self.member).status_code, 200)

    def test_wip_and_entry_both_trip_entry_body_carries_also(self):
        self._require("block")
        Board.objects.filter(pk=self.board.pk).update(enforce_wip_limits=True)
        Column.objects.filter(pk=self.dst.pk).update(wip_limit=1)
        Card.objects.create(board=self.board, column=self.dst, swimlane=self.lane, title="F", created_by=self.admin)
        body = self._move(self.member).json()
        self.assertEqual(body["code"], "entry_requirements_unmet")
        self.assertEqual([a["code"] for a in body["also"]], ["wip_limit_exceeded"])
        # One force + reason covers both, recorded as two rows.
        resp = self._move(self.admin, force=True, reason="ok")
        self.assertEqual(resp.json()["override"]["kinds"], ["wip", "entry_requirements"])
        self.assertEqual(CardOverride.objects.filter(card=self.card).count(), 2)

    def test_hard_wip_wins_and_lists_entry_in_also(self):
        self._require("block")
        Board.objects.filter(pk=self.board.pk).update(enforce_wip_hard=True)
        Column.objects.filter(pk=self.dst.pk).update(wip_limit=1)
        Card.objects.create(board=self.board, column=self.dst, swimlane=self.lane, title="F", created_by=self.admin)
        body = self._move(self.admin, force=True, reason="x").json()
        self.assertEqual(body["code"], "wip_hard_blocked")
        self.assertEqual([a["code"] for a in body["also"]], ["entry_requirements_unmet"])

    def test_wip_only_body_has_no_also(self):
        Board.objects.filter(pk=self.board.pk).update(enforce_wip_limits=True)
        Column.objects.filter(pk=self.dst.pk).update(wip_limit=1)
        Card.objects.create(board=self.board, column=self.dst, swimlane=self.lane, title="F", created_by=self.admin)
        self.assertNotIn("also", self._move(self.member).json())

    def test_create_is_checked_and_values_written_first_count(self):
        self._require("block")
        url = f"/api/v1/boards/{self.board.pk}/cards/"
        base = {"title": "New", "column": self.dst.pk, "swimlane": self.lane.pk}
        with patch(PATCH_BROADCAST):
            refused = self._client(self.member).post(url, base, format="json")
            ok = self._client(self.member).post(url, {**base, "custom_field_values": [
                {"field_definition": self.amount.pk, "value": "70000"},
            ]}, format="json")
        self.assertEqual(refused.status_code, 409)
        self.assertEqual(ok.status_code, 201, ok.content)

    def test_create_in_warn_column_returns_entry_unmet(self):
        self._require("warn")
        with patch(PATCH_BROADCAST):
            resp = self._client(self.member).post(
                f"/api/v1/boards/{self.board.pk}/cards/",
                {"title": "New", "column": self.dst.pk, "swimlane": self.lane.pk}, format="json",
            )
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(len(resp.json()["entry_unmet"]), 1)

    def test_restore_is_checked(self):
        self.card.column = self.dst
        self.card.archived_at = self.card.created_at
        self.card.save(update_fields=["column", "archived_at"])
        self._require("block")
        with patch(PATCH_BROADCAST):
            resp = self._client(self.admin).post(
                f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/unarchive/", {}, format="json",
            )
        self.assertEqual(resp.status_code, 409)
        self._require("warn")  # a second row, mode now warn
        with patch(PATCH_BROADCAST):
            resp = self._client(self.admin).post(
                f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/unarchive/", {}, format="json",
            )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.json()["entry_unmet"]), 2)
        movement = CardMovement.objects.filter(card=self.card).latest("id")
        self.assertEqual(len(movement.entry_unmet), 2)

    def test_weight_update_never_checks_entry(self):
        self.card.column = self.dst
        self.card.save(update_fields=["column"])
        self._require("hard")
        with patch(PATCH_BROADCAST):
            resp = self._client(self.admin).patch(
                f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/", {"weight": 5}, format="json",
            )
        self.assertEqual(resp.status_code, 200, resp.content)

    def test_admin_form_message_and_limit_errors(self):
        exc = EntryRequirementsUnmet(column_name="Proposal", mode="block", unmet=[{
            "requirement_uid": "r", "field_name": "Amount", "field_set_name": None,
        }])
        self.assertIn("Amount", _limit_error_message(exc))
        self._require("block")
        placed = SimpleNamespace(pk=self.card.pk, weight=0, swimlane_id=self.lane.pk)
        with self.assertRaises(EntryRequirementsUnmet):
            card_services.enforce_column_limits(
                board=self.board, column=self.dst, card=placed, role=SITE_ADMIN,
                swimlane=self.lane, check_entry=True,
            )
        from boards.services.errors import LIMIT_ERRORS

        self.assertIn(EntryRequirementsUnmet, LIMIT_ERRORS)

    def test_admin_change_form_blocks_a_forward_move(self):
        from boards.admin import _is_forward

        self.assertTrue(_is_forward(self.src.pk, self.dst))
        self.assertFalse(_is_forward(self.dst.pk, self.src))
        self.assertFalse(_is_forward(self.dst.pk, self.dst))
        self.assertFalse(_is_forward(None, self.dst))


class LaneScopeTests(_Fixture):
    def test_lane_scoped_set_applies_only_in_its_lanes(self):
        field_set = CustomFieldSet.objects.create(board=self.board, name="MEDDIC", scope="swimlanes")
        field_set.swimlanes.add(self.lane)
        CustomFieldDefinition.objects.filter(pk=self.amount.pk).update(field_set=field_set)
        self._require("hard")
        self.assertEqual(self._move(self.member).status_code, 409)
        other = Card.objects.create(
            board=self.board, column=self.src, swimlane=self.other_lane, title="SMB deal",
            created_by=self.admin, position=0,
        )
        self.assertEqual(self._move(self.member, lane=self.other_lane, card=other).status_code, 200)

    def test_set_complete_and_dimension_lane_na(self):
        field_set = CustomFieldSet.objects.create(board=self.board, name="Qual")
        name = CustomFieldDefinition.objects.create(
            board=self.board, name="Champion", field_type="text", position=1, field_set=field_set,
        )
        dim = CustomFieldDefinition.objects.create(
            board=self.board, name="Legal", field_type="dropdown", position=2, is_dimension=True,
            choices_json=["Open", "Done"], choice_resolutions={"Done": "satisfied"},
        )
        self._require("hard", field_definition=None, field_set=field_set, operator="set_complete", operand=None)
        ColumnEntryRequirement.objects.create(column=self.dst, field_definition=dim, operator="satisfied", position=1)
        body = self._move(self.member).json()
        self.assertEqual([u["operator"] for u in body["unmet"]], ["set_complete", "satisfied"])
        self.assertEqual(body["unmet"][0]["field_set_name"], "Qual")
        CustomFieldValue.objects.create(card=self.card, field_definition=name, value="Pat")
        SwimlaneTrackException.objects.create(swimlane=self.lane, field_definition=dim)
        self.assertEqual(self._move(self.member).status_code, 200)


class CallerBehaviorTests(_Fixture):
    """Callers-table rows that had no behavior test (#1923)."""

    def test_sub_column_move_inside_a_stage_is_not_checked(self):
        # A move between sub-columns keeps the card in the same column: it is
        # not an entry, so a Block requirement it does not meet never applies.
        for position, name in enumerate(("Doing", "Review")):
            SubColumn.objects.create(column=self.dst, position=position, name=name)
        Card.objects.filter(pk=self.card.pk).update(column=self.dst)
        self._require("block")
        body = {"column_id": self.dst.pk, "swimlane_id": self.lane.pk, "position": 0, "gates_passed": 1}
        with patch(PATCH_BROADCAST):
            resp = self._client(self.member).post(
                f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/move/", body, format="json",
            )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertNotIn("entry_unmet", resp.json())
        self.card.refresh_from_db()
        self.assertEqual(self.card.gates_passed, 1)

    def test_eligible_assignee_overrides_end_to_end_and_others_are_refused(self):
        self._require("block")
        self.card.assignee = self.member
        self.card.assigned_by = self.admin
        self.card.save(update_fields=["assignee", "assigned_by"])
        self.board.allow_assignee_override = True
        self.board.save(update_fields=["allow_assignee_override"])
        # A member who is not the assignee is still refused.
        other = User.objects.create_user(username="er_other", password="pass")
        BoardMembership.objects.create(board=self.board, user=other, role=R.MEMBER)
        self.assertEqual(self._move(other, force=True, reason="please").status_code, 403)
        # The assignee must give a reason.
        resp = self._move(self.member, force=True)
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json()["code"], "override_reason_required")
        resp = self._move(self.member, force=True, reason="I own this deal")
        self.assertEqual(resp.status_code, 200, resp.content)
        row = CardOverride.objects.get(card=self.card)
        self.assertEqual(row.kind, "entry_requirements")
        self.assertEqual(row.actor_basis, "assignee")
        self.assertEqual(row.reason, "I own this deal")

    def test_assignee_without_a_distinct_assigner_is_refused(self):
        self._require("block")
        self.card.assignee = self.member
        self.card.assigned_by = self.member  # self-assigned: not eligible
        self.card.save(update_fields=["assignee", "assigned_by"])
        self.board.allow_assignee_override = True
        self.board.save(update_fields=["allow_assignee_override"])
        self.assertEqual(self._move(self.member, force=True, reason="mine").status_code, 403)


class QueryBudgetTests(_Fixture):
    def _count_move(self, card):
        with CaptureQueriesContext(connection) as ctx:
            self.assertIn(self._move(self.member, card=card).status_code, (200, 409))
        return len(ctx.captured_queries)

    def _fresh_card(self, title):
        return Card.objects.create(
            board=self.board, column=self.src, swimlane=self.lane, title=title,
            created_by=self.admin, position=1,
        )

    def test_null_mode_costs_nothing_and_warn_at_most_four(self):
        # The baseline is a column with NO requirement rows, so the NULL-mode
        # comparison below cannot compare NULL with itself.
        warm = self._fresh_card("warm")
        self._count_move(warm)
        warm.delete()
        baseline = self._count_move(self._fresh_card("a"))
        # Rows present but the mode NULL: evaluated never, so no extra query.
        ColumnEntryRequirement.objects.create(column=self.dst, field_definition=self.amount, operator="filled")
        # The worst case: a set_complete row adds the field-set lookup on top of
        # the plain field row, so the budget is measured with both.
        field_set = CustomFieldSet.objects.create(board=self.board, name="Budget set")
        CustomFieldDefinition.objects.create(
            board=self.board, name="Owner", field_type="text", position=1, field_set=field_set,
        )
        ColumnEntryRequirement.objects.create(
            column=self.dst, field_set=field_set, operator="set_complete", position=1,
        )
        self.dst.refresh_from_db()
        self.assertIsNone(self.dst.entry_enforcement)
        self.assertEqual(self._count_move(self._fresh_card("null")), baseline)
        self.assertFalse(CardMovement.objects.filter(card__board=self.board).exclude(entry_unmet=None).exists())
        Column.objects.filter(pk=self.dst.pk).update(entry_enforcement="warn")
        with_entry = self._count_move(self._fresh_card("b"))
        self.assertLessEqual(with_entry - baseline, 4)


class ReplaceAllWriteTests(_Fixture):
    def _put(self, user, data, column=None):
        url = f"/api/v1/boards/{self.board.pk}/columns/{(column or self.dst).pk}/entry-requirements/"
        with patch(PATCH_BROADCAST) as sent, self.captureOnCommitCallbacks(execute=True):
            resp = self._client(user).put(url, data, format="json")
        return resp, sent

    def test_admin_saves_first_rows_in_warn_and_broadcasts(self):
        resp, sent = self._put(self.admin, {"requirements": [
            {"field_uid": self.amount.uid, "operator": "gte", "operand": "1000"},
        ]})
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["entry_enforcement"], "warn")
        self.assertEqual(resp.json()["entry_requirements"][0]["operand"], "1000")
        events = [c.args[1] for c in sent.call_args_list]
        self.assertIn("column.updated", events)
        # Null keeps the rows (owner ruling); an empty list clears both.
        resp, _ = self._put(self.admin, {"entry_enforcement": None, "requirements": [
            {"field_uid": self.amount.uid, "operator": "gte", "operand": "1000"},
        ]})
        self.assertIsNone(resp.json()["entry_enforcement"])
        self.assertEqual(len(resp.json()["entry_requirements"]), 1)
        resp, _ = self._put(self.admin, {"entry_enforcement": "block", "requirements": []})
        self.assertIsNone(resp.json()["entry_enforcement"])
        self.assertFalse(ColumnEntryRequirement.objects.exists())

    def test_omitting_the_mode_keeps_a_switched_off_column_off(self):
        rows = [{"field_uid": self.amount.uid, "operator": "gte", "operand": "1000"}]
        resp, _ = self._put(self.admin, {"entry_enforcement": None, "requirements": rows})
        self.assertIsNone(resp.json()["entry_enforcement"])
        # Only the FIRST save starts in warn; a later PUT without the key must
        # not silently switch an off column back on.
        resp, _ = self._put(self.admin, {"requirements": rows})
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertIsNone(resp.json()["entry_enforcement"])
        self.dst.refresh_from_db()
        self.assertIsNone(self.dst.entry_enforcement)
        # A column already in block keeps block when the key is omitted.
        self._put(self.admin, {"entry_enforcement": "block", "requirements": rows})
        resp, _ = self._put(self.admin, {"requirements": rows})
        self.assertEqual(resp.json()["entry_enforcement"], "block")

    def test_member_and_viewer_are_refused(self):
        for user in (self.member, self.viewer):
            resp, sent = self._put(user, {"requirements": []})
            self.assertEqual(resp.status_code, 403)
            sent.assert_not_called()

    def test_non_member_is_404_and_anonymous_is_401(self):
        outsider = User.objects.create_user(username="er_outsider", password="pass")
        resp, sent = self._put(outsider, {"requirements": []})
        self.assertEqual(resp.status_code, 404)
        sent.assert_not_called()
        url = f"/api/v1/boards/{self.board.pk}/columns/{self.dst.pk}/entry-requirements/"
        self.assertEqual(APIClient().put(url, {"requirements": []}, format="json").status_code, 401)
        # A missing board answers like a board the caller can't see.
        missing = f"/api/v1/boards/999999/columns/{self.dst.pk}/entry-requirements/"
        self.assertEqual(self._client(outsider).put(missing, {"requirements": []}, format="json").status_code, 404)

    def test_field_set_dry_run_is_admin_only(self):
        field_set = CustomFieldSet.objects.create(board=self.board, name="Gate", scope="swimlanes")
        url = f"/api/v1/boards/{self.board.pk}/field-sets/{field_set.pk}/?dry_run=true"
        for user in (self.viewer, self.member):
            self.assertEqual(self._client(user).patch(url, {"field_ids": []}, format="json").status_code, 403)
            self.assertEqual(self._client(user).delete(url).status_code, 403)
        self.assertTrue(CustomFieldSet.objects.filter(pk=field_set.pk).exists())

    def test_malformed_values_are_a_400_never_a_500(self):
        set_row = CustomFieldSet.objects.create(board=self.board, name="Gate", position=0)
        for bad in ([], ["warn"], {"a": 1}, 7):
            for data in (
                {"entry_enforcement": bad, "requirements": []},
                {"requirements": [{"field_uid": bad, "operator": "filled"}]},
                {"requirements": [{"field_set_uid": bad, "operator": "set_complete"}]},
                {"requirements": [{"field_uid": self.amount.uid, "operator": bad}]},
                {"requirements": [{"field_set_uid": set_row.uid, "operator": bad}]},
            ):
                with self.subTest(data=str(data)[:80]):
                    resp, _ = self._put(self.admin, data)
                    self.assertEqual(resp.status_code, 400, resp.content)

    def test_validation(self):
        checkbox = CustomFieldDefinition.objects.create(
            board=self.board, name="Signed", field_type="checkbox", position=3,
        )
        other_board = Board.objects.create(name="Other", owner=self.admin)
        foreign = CustomFieldDefinition.objects.create(board=other_board, name="Amount", field_type="number")
        bad = [
            {"requirements": "nope"},
            {"entry_enforcement": "loud", "requirements": []},
            {"requirements": [{"field_uid": checkbox.uid, "operator": "filled"}]},
            {"requirements": [{"field_uid": foreign.uid, "operator": "filled"}]},
            {"requirements": [{"field_uid": self.amount.uid, "operator": "satisfied"}]},
            {"requirements": [{"field_uid": self.amount.uid, "operator": "gt"}]},
            {"requirements": [{"field_uid": self.amount.uid, "operator": "filled", "operand": 3}]},
            {"requirements": [{"field_uid": self.amount.uid, "operator": "gt", "operand": "1e20"}]},
            {"requirements": [{"operator": "filled"}]},
            {"requirements": [{"field_uid": self.amount.uid, "operator": "filled"}] * 11},
        ]
        for data in bad:
            with self.subTest(data=str(data)[:60]):
                resp, _ = self._put(self.admin, data)
                self.assertEqual(resp.status_code, 400)
        multi = CustomFieldDefinition.objects.create(
            board=self.board, name="Tags", field_type="multi_select", position=4, choices_json=["a", "b"],
        )
        resp, _ = self._put(self.admin, {"requirements": [
            {"field_uid": multi.uid, "operator": "min_count", "operand": 1.5},
        ]})
        self.assertEqual(resp.status_code, 400)
        resp, _ = self._put(self.admin, {"requirements": [
            {"field_uid": multi.uid, "operator": "min_count", "operand": 2},
        ] * 10})
        self.assertEqual(resp.status_code, 200)

    def test_column_patch_cannot_write_the_mode(self):
        with patch(PATCH_BROADCAST):
            self._client(self.admin).patch(
                f"/api/v1/boards/{self.board.pk}/columns/{self.dst.pk}/",
                {"entry_enforcement": "hard"}, format="json",
            )
        self.dst.refresh_from_db()
        self.assertIsNone(self.dst.entry_enforcement)


class ExposureAndCascadeTests(_Fixture):
    def test_public_column_serializer_excludes_the_new_fields(self):
        self._require("block")
        self.assertIn("entry_requirements", ColumnSerializer(self.dst).data)
        public = PublicColumnSerializer(self.dst).data
        self.assertNotIn("entry_enforcement", public)
        self.assertNotIn("entry_requirements", public)

    def test_check_constraints(self):
        from django.db import IntegrityError, transaction

        for kw in (
            {"operator": "filled"},  # no target
            {"field_definition": self.amount, "operator": "gt"},  # operand missing
            {"field_definition": self.amount, "operator": "filled", "operand": 1},
            {"field_definition": self.amount, "operator": "set_complete"},
        ):
            with self.subTest(kw=str(kw)), self.assertRaises((IntegrityError, DjangoValidationError)):
                with transaction.atomic():
                    ColumnEntryRequirement.objects.create(column=self.dst, **kw)

    def test_field_delete_cascades_and_broadcasts_column_updated(self):
        self._require("block")
        with patch(PATCH_BROADCAST) as sent, self.captureOnCommitCallbacks(execute=True):
            resp = self._client(self.admin).delete(
                f"/api/v1/boards/{self.board.pk}/custom-fields/{self.amount.pk}/",
            )
        self.assertEqual(resp.status_code, 204)
        self.assertFalse(ColumnEntryRequirement.objects.exists())
        self.assertIn("column.updated", [c.args[1] for c in sent.call_args_list])

    def test_set_delete_dry_run_lists_widened_and_delete_broadcasts(self):
        field_set = CustomFieldSet.objects.create(board=self.board, name="MEDDIC", scope="swimlanes")
        field_set.swimlanes.add(self.lane)
        CustomFieldDefinition.objects.filter(pk=self.amount.pk).update(field_set=field_set)
        req = self._require("block")
        set_req = ColumnEntryRequirement.objects.create(
            column=self.src, field_set=field_set, operator="set_complete", position=0,
        )
        url = f"/api/v1/boards/{self.board.pk}/field-sets/{field_set.pk}/"
        resp = self._client(self.admin).delete(url + "?dry_run=true")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual([a["requirement_uid"] for a in resp.json()["affected_requirements"]], [req.uid])
        self.assertTrue(CustomFieldSet.objects.filter(pk=field_set.pk).exists())
        # Membership dry-run: moving Amount out of the set widens the same row.
        resp = self._client(self.admin).patch(url + "?dry_run=true", {"field_ids": []}, format="json")
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual([a["requirement_uid"] for a in resp.json()["affected_requirements"]], [req.uid])
        # Scope dry-run: lane-scoped -> all widens it; an unchanged scope does not.
        resp = self._client(self.admin).patch(url + "?dry_run=true", {"scope": "all"}, format="json")
        self.assertEqual(resp.status_code, 200, resp.content)
        # The set's own set_complete row widens too (the set survives a scope change).
        self.assertEqual(
            [a["requirement_uid"] for a in resp.json()["affected_requirements"]], [req.uid, set_req.uid],
        )
        set_item = resp.json()["affected_requirements"][1]
        self.assertIsNone(set_item["field_uid"])
        self.assertIsNone(set_item["field_name"])
        self.assertEqual(set_item["field_set_name"], "MEDDIC")
        resp = self._client(self.admin).patch(url + "?dry_run=true", {"scope": "swimlanes"}, format="json")
        self.assertEqual(resp.json()["affected_requirements"], [])
        # Both at once do not list the requirement twice.
        resp = self._client(self.admin).patch(
            url + "?dry_run=true", {"scope": "all", "field_ids": []}, format="json",
        )
        self.assertEqual([a["requirement_uid"] for a in resp.json()["affected_requirements"]], [req.uid, set_req.uid])
        self.assertEqual(self._client(self.member).delete(url + "?dry_run=true").status_code, 403)
        with patch(PATCH_BROADCAST) as sent, self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(self._client(self.admin).delete(url).status_code, 204)
        self.assertIn("column.updated", [c.args[1] for c in sent.call_args_list])
        self.assertEqual(ColumnEntryRequirement.objects.count(), 1)  # the field row survives


class RequireForceAbsentInputTests(_Fixture):
    """Absent-input guards (#1075): an unresolved input denies, never grants."""

    def test_missing_board_actor_or_card_denies(self):
        from boards.models import BoardMembership as BM
        member = BM.Role.MEMBER
        self.card.assignee = self.member
        self.card.assigned_by = self.admin
        self.card.save(update_fields=["assignee", "assigned_by"])
        self.board.allow_assignee_override = True
        self.board.save(update_fields=["allow_assignee_override"])
        # Populated case grants, so each absent case below is a real denial.
        self.assertEqual(
            card_services._require_force(
                role=member, card=self.card, actor=self.member, board=self.board, kinds=["entry_requirements"],
            ), "assignee",
        )
        for kwargs in ({"board": None}, {"actor": None}, {"card": None}):
            args = dict(role=member, card=self.card, actor=self.member, board=self.board, kinds=["wip"])
            args.update(kwargs)
            with self.subTest(absent=next(iter(kwargs))), self.assertRaises(ForceNotPermitted):
                card_services._require_force(**args)
