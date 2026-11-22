"""Assertions added from the #2299 mutation baseline for ``services/cards.py`` (#2516).

The weekly run left 163 mutants alive in the card service: the swimlane-limit
helpers, the gate-transition builders, ``block_card`` / ``unblock_card`` and the
gated-stage branch of ``_move_card_attempt``. Each test pins an exact value
(a constant, a boundary, a persisted column, a raised exception's fields) that
fails under the mutant. Most call the helper or service entry point directly,
so the assertion is on the value the mutant changes, not on a status code.
"""

import dataclasses
import datetime
from unittest.mock import patch

from django.test import TestCase
from django.utils import timezone

from boards.models import (
    Card,
    CardActivity,
    CardBlock,
    CardGateTransition,
    CardParentLink,
    Swimlane,
    SubColumn,
)
from boards.services import cards as svc
from boards.services.errors import (
    CardAlreadyBlocked,
    CardNotBlocked,
    CardNotFound,
    ForceNotPermitted,
    InvalidGatesPassed,
    NotPermitted,
    SwimlaneNotFound,
    SwimlaneWeightLimitExceeded,
    SwimlaneWipHardBlocked,
    SwimlaneWipLimitExceeded,
    WipLimitExceeded,
)
from boards.tests.conftest import (
    _make_board,
    _make_card,
    _make_column,
    _make_membership,
    _make_swimlane,
    _make_user,
)

LE = Swimlane.LimitEnforcement


class _Stub:
    """A ``cards`` stand-in with just the two calls a constraint makes."""

    def __init__(self, count=0, total=0):
        self._count, self._total = count, total

    def count(self):
        return self._count

    def aggregate(self, **_kw):
        return {"total": self._total}


class ConstantsAndConstraintTests(TestCase):
    def test_mode_constants_are_the_wire_strings(self):
        self.assertEqual(svc._HARD, "hard")
        self.assertEqual(svc._BLOCK, "block")

    def test_placement_constraint_is_frozen(self):
        pc = svc.PlacementConstraint(kind="wip", mode="block", limit=1, cards=_Stub(), error=None)
        with self.assertRaises(dataclasses.FrozenInstanceError):
            pc.limit = 2

    def test_measure_counts_for_wip_and_sums_weight_otherwise(self):
        cards = _Stub(count=3, total=11)
        wip = svc.PlacementConstraint(kind="wip", mode="block", limit=1, cards=cards, error=None)
        weight = svc.PlacementConstraint(kind="weight", mode="block", limit=1, cards=cards, error=None)
        self.assertEqual(wip.measure(), 3)
        self.assertEqual(weight.measure(), 11)
        empty = svc.PlacementConstraint(kind="weight", mode="block", limit=1, cards=_Stub(total=None), error=None)
        self.assertEqual(empty.measure(), 0)

    def test_is_exceeded_boundaries(self):
        wip = svc.PlacementConstraint(kind="wip", mode="block", limit=3, cards=None, error=None)
        # WIP ignores the placed card's weight and trips *at* the limit.
        self.assertFalse(wip.is_exceeded(2, 99))
        self.assertTrue(wip.is_exceeded(3, 0))
        weight = svc.PlacementConstraint(kind="weight", mode="block", limit=10, cards=None, error=None)
        # Weight trips only when adding the card passes the limit.
        self.assertFalse(weight.is_exceeded(7, 3))
        self.assertTrue(weight.is_exceeded(7, 4))
        self.assertFalse(weight.is_exceeded(10, 0))


class _LaneBase(TestCase):
    def setUp(self):
        self.owner = _make_user("g2516_owner")
        # Both flags default to on; start from "no board-level enforcement".
        self.board = _make_board(
            self.owner, enforce_wip_limits=False, enforce_weight_limits=False,
        )
        self.todo = _make_column(self.board, "Todo", 0)
        self.doing = _make_column(self.board, "Doing", 1)
        self.done = _make_column(self.board, "Done", 2, is_done=True)
        self.lane = _make_swimlane(self.board, "Row", 0)
        self.card = _make_card(self.todo, self.lane, title="Placed", weight=2)

    def lane_with(self, **kw):
        for k, v in kw.items():
            setattr(self.lane, k, v)
        self.lane.save()
        self.lane.refresh_from_db()
        return self.lane

    def constraints(self, **kw):
        kw.setdefault("check_wip", True)
        kw.setdefault("check_weight", True)
        return svc._swimlane_constraints(self.board, self.lane, self.doing, self.card, **kw)


class SwimlaneLimitModesTests(_LaneBase):
    def test_null_choice_inherits_the_board_flags(self):
        self.assertEqual(svc._swimlane_limit_modes(self.board, self.lane), (None, None))
        self.board.enforce_wip_limits = True
        self.board.enforce_weight_limits = True
        self.assertEqual(svc._swimlane_limit_modes(self.board, self.lane), ("block", "block"))
        self.board.enforce_wip_hard = True
        self.assertEqual(svc._swimlane_limit_modes(self.board, self.lane), ("hard", "block"))

    def test_chosen_mode_beats_the_board_flags(self):
        self.assertEqual(
            svc._swimlane_limit_modes(self.board, self.lane_with(limit_enforcement=LE.BLOCK)),
            ("block", "block"),
        )
        self.assertEqual(
            svc._swimlane_limit_modes(self.board, self.lane_with(limit_enforcement=LE.HARD)),
            ("hard", "block"),
        )


class SourceCountsTests(_LaneBase):
    def test_no_source_counts_nowhere(self):
        self.assertIs(svc._source_counts_for_swimlane(self.lane, None), False)

    def test_other_row_does_not_count(self):
        other = _make_swimlane(self.board, "Other", 1)
        self.assertIs(svc._source_counts_for_swimlane(self.lane, (self.todo, other.pk)), False)
        self.assertIs(svc._source_counts_for_swimlane(self.lane, (self.todo.pk, other.pk)), False)

    def test_column_instance_defers_to_counts_column(self):
        self.assertIs(svc._source_counts_for_swimlane(self.lane, (self.todo, self.lane.pk)), True)
        self.assertIs(svc._source_counts_for_swimlane(self.lane, (self.done, self.lane.pk)), False)

    def test_list_of_ids_is_membership(self):
        lane = self.lane_with(limit_column_ids=[self.doing.pk])
        self.assertIs(svc._source_counts_for_swimlane(lane, (self.doing.pk, lane.pk)), True)
        self.assertIs(svc._source_counts_for_swimlane(lane, (self.todo.pk, lane.pk)), False)

    def test_non_list_value_counts_every_column(self):
        self.lane.limit_column_ids = {"raw": "orm write"}  # in memory: only a raw write stores it
        self.assertIs(svc._source_counts_for_swimlane(self.lane, (self.done.pk, self.lane.pk)), True)

    def test_null_means_every_column_not_done_looked_up_by_id(self):
        self.assertIsNone(self.lane.limit_column_ids)
        self.assertIs(svc._source_counts_for_swimlane(self.lane, (self.todo.pk, self.lane.pk)), True)
        self.assertIs(svc._source_counts_for_swimlane(self.lane, (self.done.pk, self.lane.pk)), False)
        # An id with no row (deleted under a concurrent write) does not count.
        self.assertIs(svc._source_counts_for_swimlane(self.lane, (10**9, self.lane.pk)), False)


class SwimlaneConstraintsTests(_LaneBase):
    def test_wip_only(self):
        self.board.enforce_wip_limits = True
        self.board.enforce_weight_limits = True
        self.lane_with(wip_limit=2)
        built = self.constraints()
        self.assertEqual([c.kind for c in built], ["wip"])
        self.assertEqual((built[0].mode, built[0].limit), ("block", 2))

    def test_weight_only(self):
        self.board.enforce_wip_limits = True
        self.board.enforce_weight_limits = True
        self.lane_with(weight_limit=9)
        built = self.constraints()
        self.assertEqual([c.kind for c in built], ["weight"])
        self.assertEqual((built[0].mode, built[0].limit), ("block", 9))

    def test_both_in_wip_then_weight_order(self):
        self.lane_with(wip_limit=2, weight_limit=9, limit_enforcement=LE.BLOCK)
        self.assertEqual([c.kind for c in self.constraints()], ["wip", "weight"])

    def test_check_flags_switch_each_kind_off(self):
        self.lane_with(wip_limit=2, weight_limit=9, limit_enforcement=LE.BLOCK)
        self.assertEqual([c.kind for c in self.constraints(check_wip=False)], ["weight"])
        self.assertEqual([c.kind for c in self.constraints(check_weight=False)], ["wip"])
        self.assertEqual(self.constraints(check_wip=False, check_weight=False), [])

    def test_unenforced_or_unlimited_builds_nothing(self):
        # Limits set, but no mode from the lane or the board.
        self.lane_with(wip_limit=2, weight_limit=9)
        self.assertEqual(self.constraints(), [])
        # Mode set, but no limit.
        self.lane_with(wip_limit=None, weight_limit=None, limit_enforcement=LE.BLOCK)
        self.assertEqual(self.constraints(), [])

    def test_wip_mode_without_weight_mode_does_not_build_weight(self):
        self.board.enforce_wip_limits = True  # weight flag stays off
        self.lane_with(wip_limit=2, weight_limit=9)
        self.assertEqual([c.kind for c in self.constraints()], ["wip"])

    def test_counted_cards_exclude_archived_the_placed_card_and_done_by_default(self):
        self.lane_with(wip_limit=5, limit_enforcement=LE.BLOCK)
        live = _make_card(self.doing, self.lane, title="live", position=1)
        _make_card(self.doing, self.lane, title="archived", position=2, archived_at=timezone.now())
        in_done = _make_card(self.done, self.lane, title="done", position=3)
        elsewhere = _make_card(self.doing, _make_swimlane(self.board, "Elsewhere", 1), title="x")
        counted = set(self.constraints()[0].cards.values_list("pk", flat=True))
        self.assertEqual(counted, {live.pk, self.card.pk} - {self.card.pk})
        self.assertNotIn(in_done.pk, counted)
        self.assertNotIn(elsewhere.pk, counted)

    def test_listed_columns_count_even_when_done(self):
        self.lane_with(wip_limit=5, limit_enforcement=LE.BLOCK, limit_column_ids=[self.done.pk])
        in_done = _make_card(self.done, self.lane, title="done", position=1)
        in_doing = _make_card(self.doing, self.lane, title="doing", position=2)
        counted = set(self.constraints()[0].cards.values_list("pk", flat=True))
        self.assertEqual(counted, {in_done.pk})
        self.assertNotIn(in_doing.pk, counted)

    def test_non_list_counts_every_column(self):
        self.lane.wip_limit = 5
        self.lane.limit_enforcement = LE.BLOCK
        self.lane.limit_column_ids = "raw"  # in memory only
        in_done = _make_card(self.done, self.lane, title="done", position=1)
        counted = set(svc._swimlane_constraints(
            self.board, self.lane, self.doing, self.card, check_wip=True, check_weight=True,
        )[0].cards.values_list("pk", flat=True))
        self.assertIn(in_done.pk, counted)

    def test_wip_error_is_soft_or_hard_with_the_cell_named(self):
        self.lane_with(wip_limit=2, limit_enforcement=LE.BLOCK)
        soft = self.constraints()[0].error(2)
        self.assertIsInstance(soft, SwimlaneWipLimitExceeded)
        self.assertEqual(
            (soft.swimlane_name, soft.column_name, soft.current_count, soft.wip_limit),
            ("Row", "Doing", 2, 2),
        )
        self.lane_with(limit_enforcement=LE.HARD)
        hard = self.constraints()[0]
        self.assertEqual(hard.mode, "hard")
        err = hard.error(3)
        self.assertIsInstance(err, SwimlaneWipHardBlocked)
        self.assertEqual((err.swimlane_name, err.column_name, err.current_count, err.wip_limit), ("Row", "Doing", 3, 2))

    def test_weight_error_names_the_totals(self):
        self.lane_with(weight_limit=9, limit_enforcement=LE.BLOCK)
        err = self.constraints()[0].error(8)
        self.assertIsInstance(err, SwimlaneWeightLimitExceeded)
        self.assertEqual(
            (err.swimlane_name, err.column_name, err.current_weight, err.weight_limit, err.card_weight),
            ("Row", "Doing", 8, 9, 2),
        )


class SwimlaneCheckAppliesTests(_LaneBase):
    def applies(self, column=None, source=None, **kw):
        kw.setdefault("check_wip", True)
        kw.setdefault("check_weight", True)
        return svc._swimlane_check_applies(
            self.board, self.lane, column or self.doing, source=source, **kw,
        )

    def test_one_limit_is_enough(self):
        self.lane_with(wip_limit=2, limit_enforcement=LE.BLOCK)
        self.assertIs(self.applies(), True)
        self.lane_with(wip_limit=None, weight_limit=5)
        self.assertIs(self.applies(), True)

    def test_no_limit_or_no_matching_check_does_not_apply(self):
        self.lane_with(limit_enforcement=LE.BLOCK)
        self.assertIs(self.applies(), False)
        self.lane_with(wip_limit=2)
        self.assertIs(self.applies(check_wip=False), False)

    def test_uncounted_target_column_does_not_apply(self):
        self.lane_with(wip_limit=2, limit_enforcement=LE.BLOCK)
        self.assertIs(self.applies(column=self.done), False)

    def test_growing_in_place_applies_without_a_source_check(self):
        self.lane_with(weight_limit=5, limit_enforcement=LE.BLOCK)
        # The card already counts in its source cell; a weight increase still applies.
        self.assertIs(
            self.applies(check_wip=False, source=(self.doing, self.lane.pk)), True,
        )

    def test_entering_applies_only_when_the_card_does_not_already_count(self):
        self.lane_with(wip_limit=2, limit_enforcement=LE.BLOCK)
        self.assertIs(self.applies(source=None), True)
        self.assertIs(self.applies(source=(self.done, self.lane.pk)), True)
        self.assertIs(self.applies(source=(self.todo, self.lane.pk)), False)


class EvaluateConstraintsTests(TestCase):
    def pc(self, mode, label, count=5):
        return svc.PlacementConstraint(
            kind="wip", mode=mode, limit=1, cards=_Stub(count=count),
            error=lambda n, label=label: RuntimeError(label),
        )

    def run_eval(self, constraints, force=False, role="admin"):
        card = type("C", (), {"weight": 1})()
        svc._evaluate_constraints(constraints, card=card, role=role, force=force)

    def test_hard_is_reported_ahead_of_an_earlier_soft(self):
        with self.assertRaisesMessage(RuntimeError, "hard"):
            self.run_eval([self.pc("block", "soft"), self.pc("hard", "hard")])

    def test_a_constraint_under_its_limit_does_not_stop_the_scan(self):
        with self.assertRaisesMessage(RuntimeError, "later"):
            self.run_eval([self.pc("block", "first", count=0), self.pc("block", "later")])

    def test_force_overrides_soft_for_an_admin_only(self):
        self.run_eval([self.pc("block", "soft")], force=True, role="admin")
        with self.assertRaises(ForceNotPermitted):
            self.run_eval([self.pc("block", "soft")], force=True, role="member")
        with self.assertRaisesMessage(RuntimeError, "hard"):
            self.run_eval([self.pc("hard", "hard")], force=True, role="admin")


class EnforceColumnLimitsLaneTests(_LaneBase):
    def enforce(self, **kw):
        kw.setdefault("source", None)
        svc.enforce_column_limits(
            board=self.board, column=self.doing, card=self.card, role="member",
            swimlane=self.lane, **kw,
        )

    def test_lane_limit_is_enforced_without_a_column_check(self):
        self.lane_with(wip_limit=1, limit_enforcement=LE.BLOCK)
        _make_card(self.doing, self.lane, title="full", position=1)
        with self.assertRaises(SwimlaneWipLimitExceeded):
            self.enforce(check_column=False)

    def test_lane_row_is_locked_no_key(self):
        self.lane_with(wip_limit=5, limit_enforcement=LE.BLOCK)
        from django.db.models import QuerySet
        real = QuerySet.select_for_update
        seen = []

        def spy(qs, *a, **kw):
            seen.append((qs.model, kw))
            return real(qs, *a, **kw)

        with patch.object(QuerySet, "select_for_update", spy):
            self.enforce(check_column=False)
        self.assertIn((Swimlane, {"no_key": True}), seen)

    def test_lane_deleted_while_waiting_is_a_404(self):
        self.lane_with(wip_limit=5, limit_enforcement=LE.BLOCK)
        stale = Swimlane.objects.get(pk=self.lane.pk)
        Swimlane.objects.filter(pk=self.lane.pk).update(position=9)  # row still there
        Card.objects.all().delete()
        Swimlane.objects.filter(pk=self.lane.pk).delete()
        with self.assertRaises(SwimlaneNotFound):
            svc.enforce_column_limits(
                board=self.board, column=self.doing, card=self.card, role="member",
                swimlane=stale, source=None, check_column=False,
            )

    def test_column_and_lane_constraints_both_run(self):
        self.board.enforce_wip_limits = True
        self.doing.wip_limit = 1
        self.doing.save()
        self.lane_with(wip_limit=9, limit_enforcement=LE.BLOCK)
        _make_card(self.doing, self.lane, title="full", position=1)
        # The column is full; the (roomy) row must not replace its constraint.
        with self.assertRaises(WipLimitExceeded):
            self.enforce()


class PlacementConflictDetailTests(TestCase):
    def test_detail_text(self):
        self.assertEqual(
            svc._PLACEMENT_CONFLICT_DETAIL,
            "Cards kept being added to this column and swimlane while the card was "
            "being placed. Nothing was created. Please try again.",
        )


class GateTransitionBuildTests(TestCase):
    def setUp(self):
        self.owner = _make_user("g2516_gate")
        self.board = _make_board(self.owner)
        self.col = _make_column(self.board, "Stage", 0)
        self.lane = _make_swimlane(self.board, "L", 0)
        self.card = _make_card(self.col, self.lane, title="Gated")
        self.subs = [
            SubColumn.objects.create(column=self.col, position=i, name=n)
            for i, n in enumerate(["Doing", "Review", "Ready"])
        ]

    def build(self, a, b, **kw):
        return svc.build_gate_transitions(
            card=self.card, column=self.col, sub_columns=self.subs, from_index=a, to_index=b,
            actor=self.owner, cause=CardGateTransition.Cause.MOVE, **kw,
        )

    def test_same_index_builds_nothing(self):
        self.assertEqual(self.build(1, 1), [])

    def test_forward_builds_one_pass_row_per_gate(self):
        rows = self.build(0, 2)
        self.assertEqual(
            [(r.kind, r.from_index, r.to_index, r.sub_column_name, r.sub_column_uid) for r in rows],
            [
                ("pass", 0, 1, "Review", self.subs[1].uid),
                ("pass", 1, 2, "Ready", self.subs[2].uid),
            ],
        )

    def test_backward_builds_reopen_rows_down_to_the_first_sub_column(self):
        rows = self.build(2, 0)
        self.assertEqual(
            [(r.kind, r.from_index, r.to_index, r.sub_column_name) for r in rows],
            [("reopen", 2, 1, "Review"), ("reopen", 1, 0, "Doing")],
        )

    def test_row_carries_the_snapshots_and_defaults(self):
        movement = None
        row = self.build(0, 1)[0]
        self.assertEqual(row.card_id, self.card.pk)
        self.assertEqual(row.board_id, self.board.pk)
        self.assertEqual((row.card_uid, row.card_title), (self.card.uid, "Gated"))
        self.assertEqual((row.column_id, row.column_name, row.column_uid), (self.col.pk, "Stage", self.col.uid))
        self.assertEqual((row.reason, row.cause, row.movement, row.actor), ("", "move", movement, self.owner))
        self.assertIsNone(row.imported_from_username)

    def test_explicit_reason_import_name_and_timestamp_are_kept(self):
        stamp = datetime.datetime(2026, 1, 2, 3, 4, tzinfo=datetime.timezone.utc)
        row = self.build(0, 1, reason="why", imported_from_username="ann", created_at=stamp)[0]
        self.assertEqual((row.reason, row.imported_from_username, row.created_at), ("why", "ann", stamp))

    def test_destination_outside_the_sub_columns_has_blank_names(self):
        # 2 -> 3 steps onto index len(subs): no sub-column there.
        row = self.build(2, 3)[0]
        self.assertEqual((row.sub_column_name, row.sub_column_uid), ("", ""))
        # Index 0 is a real sub-column, not "outside".
        self.assertEqual(self.build(1, 0)[0].sub_column_name, "Doing")

    def test_write_saves_every_row_in_order_and_returns_them(self):
        rows = svc.write_gate_transitions(
            card=self.card, column=self.col, sub_columns=self.subs, from_index=0, to_index=2,
            actor=self.owner, cause=CardGateTransition.Cause.MOVE,
        )
        self.assertEqual(len(rows), 2)
        self.assertEqual(
            list(CardGateTransition.objects.filter(card=self.card).order_by("id").values_list("from_index", "to_index")),
            [(0, 1), (1, 2)],
        )
        self.assertEqual(svc.write_gate_transitions(
            card=self.card, column=self.col, sub_columns=self.subs, from_index=1, to_index=1,
            actor=self.owner, cause=CardGateTransition.Cause.MOVE,
        ), [])

    def test_serialize_is_a_list_with_one_dict_per_row(self):
        rows = svc.write_gate_transitions(
            card=self.card, column=self.col, sub_columns=self.subs, from_index=0, to_index=2,
            actor=self.owner, cause=CardGateTransition.Cause.MOVE,
        )
        data = svc.serialize_gate_transitions(rows)
        self.assertEqual([d["to_index"] for d in data], [1, 2])
        self.assertEqual(data[0]["actor"], "g2516_gate")


class CoerceGatesPassedTests(TestCase):
    def test_values(self):
        self.assertIsNone(svc._coerce_gates_passed(None))
        self.assertEqual(svc._coerce_gates_passed("2"), 2)
        self.assertEqual(svc._coerce_gates_passed(0), 0)
        for bad in (True, "x", -1, 2**100 if False else float("inf")):
            with self.assertRaises(InvalidGatesPassed):
                svc._coerce_gates_passed(bad)


def _render_move(card, movement=None):
    return {"id": card.pk, "version": card.version}


class MoveGateTests(TestCase):
    """The gated-stage branch of ``_move_card_attempt`` (#1102, #1921)."""

    def setUp(self):
        patcher = patch("boards.broadcast.broadcast_board_event")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.owner = _make_user("g2516_mv")
        self.board = _make_board(self.owner)
        self.plain = _make_column(self.board, "Plain", 0)
        self.stage = _make_column(self.board, "Stage", 1)
        for i, name in enumerate(["A", "B", "C"]):
            SubColumn.objects.create(column=self.stage, position=i, name=name)
        self.lane = _make_swimlane(self.board, "L1", 0)
        self.lane2 = _make_swimlane(self.board, "L2", 1)
        self.card = _make_card(self.plain, self.lane, title="Mover")

    def move(self, column=None, lane=None, **kw):
        with self.captureOnCommitCallbacks(execute=True):
            return svc.move_card(
                actor=self.owner, board=self.board, card_id=self.card.pk,
                target_column_id=(column or self.stage).pk,
                target_swimlane_id=(lane or self.lane).pk,
                position=0, render=_render_move, **kw,
            )

    def reload(self):
        self.card.refresh_from_db()
        return self.card

    def test_entering_with_a_string_gate_count_records_each_gate_from_zero(self):
        result = self.move(gates_passed="2")
        self.assertEqual(self.reload().gates_passed, 2)
        rows = list(CardGateTransition.objects.filter(card=self.card).order_by("id"))
        self.assertEqual([(r.from_index, r.to_index, r.kind) for r in rows], [(0, 1, "pass"), (1, 2, "pass")])
        self.assertEqual(result.movement.to_gates_passed, 2)
        # The REST body and WebSocket payload carry the crossed gates, as a list.
        self.assertEqual([t["to_index"] for t in result.payload["gate_transitions"]], [1, 2])

    def test_entering_with_one_gate_records_one_row(self):
        self.move(gates_passed=1)
        rows = list(CardGateTransition.objects.filter(card=self.card))
        self.assertEqual([(r.from_index, r.to_index) for r in rows], [(0, 1)])

    def test_entering_without_a_count_starts_at_zero_and_has_no_gate_payload(self):
        result = self.move()
        self.assertEqual(self.reload().gates_passed, 0)
        self.assertEqual(result.movement.to_gates_passed, 0)
        self.assertNotIn("gate_transitions", result.payload)

    def test_the_last_gate_is_allowed_and_one_past_it_is_not(self):
        self.move(gates_passed=2)
        self.assertEqual(self.reload().gates_passed, 2)
        with self.assertRaises(InvalidGatesPassed) as ctx:
            self.move(gates_passed=3)
        self.assertEqual(ctx.exception.max_gates, 2)

    def test_a_plain_column_allows_only_zero(self):
        self.move(column=self.plain, gates_passed=0)
        with self.assertRaises(InvalidGatesPassed) as ctx:
            self.move(column=self.plain, gates_passed=1)
        self.assertEqual(ctx.exception.max_gates, 0)

    def test_changing_the_gate_inside_one_cell_is_applied(self):
        self.move(gates_passed=0)
        self.move(gates_passed=2)  # same cell: a pure gate edit
        self.assertEqual(self.reload().gates_passed, 2)
        self.assertEqual(
            list(CardGateTransition.objects.filter(card=self.card).order_by("id").values_list("from_index", "to_index")),
            [(0, 1), (1, 2)],
        )
        self.move(gates_passed=1)
        self.assertEqual(self.reload().gates_passed, 1)
        last = CardGateTransition.objects.filter(card=self.card).order_by("id").last()
        self.assertEqual((last.kind, last.from_index, last.to_index), ("reopen", 2, 1))

    def test_a_lane_change_inside_the_stage_keeps_the_gate_and_records_it(self):
        self.move(gates_passed=1)
        before = CardGateTransition.objects.filter(card=self.card).count()
        result = self.move(lane=self.lane2)
        self.assertEqual(self.reload().gates_passed, 1)
        self.assertEqual(result.movement.from_gates_passed, 1)
        self.assertEqual(result.movement.to_gates_passed, 1)
        # Only a column change leaves gates open; a lane change inside the stage does not.
        self.assertIsNone(result.movement.from_gates_open)
        self.assertEqual(CardGateTransition.objects.filter(card=self.card).count(), before)

    def test_leaving_a_stage_records_the_gates_still_open(self):
        self.move(gates_passed=1)
        result = self.move(column=self.plain)
        self.assertEqual(result.movement.from_gates_passed, 1)
        self.assertEqual(result.movement.from_gates_open, 1)
        self.assertIsNone(result.movement.to_gates_passed)
        self.assertEqual(self.reload().gates_passed, 0)

    def test_leaving_a_plain_column_records_no_gate_state(self):
        result = self.move()
        self.assertIsNone(result.movement.from_gates_passed)
        self.assertIsNone(result.movement.from_gates_open)

    def test_a_column_move_announces_the_parent_and_its_children(self):
        with patch("boards.services.card_links.announce_parent_changed") as parent, \
                patch("boards.services.card_links.announce_children_changed") as children:
            self.move()
        parent.assert_called_once()
        children.assert_called_once()

    def test_a_lane_only_move_announces_the_parent_but_not_the_children(self):
        self.move()
        with patch("boards.services.card_links.announce_parent_changed") as parent, \
                patch("boards.services.card_links.announce_children_changed") as children:
            self.move(lane=self.lane2)
        parent.assert_called_once()
        children.assert_not_called()

    def test_a_reorder_announces_nothing(self):
        self.move()
        with patch("boards.services.card_links.announce_parent_changed") as parent, \
                patch("boards.services.card_links.announce_children_changed") as children:
            self.move()
        parent.assert_not_called()
        children.assert_not_called()


class BlockUnblockGapTests(TestCase):
    def setUp(self):
        patcher = patch("boards.broadcast.broadcast_board_event")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.owner = _make_user("g2516_blk")
        self.board = _make_board(self.owner)
        self.col = _make_column(self.board, "Doing", 0)
        self.lane = _make_swimlane(self.board, "L", 0)
        self.card = _make_card(self.col, self.lane, title="Blocker target")

    def render(self, card):
        return {"id": card.pk, "marker": "rendered", "version": card.version}

    def block(self, reason="waiting on infra", actor=None, **kw):
        with self.captureOnCommitCallbacks(execute=True):
            return svc.block_card(
                actor=actor or self.owner, board=self.board, card_id=self.card.pk,
                reason=reason, render=self.render, **kw,
            )

    def unblock(self, actor=None, **kw):
        with self.captureOnCommitCallbacks(execute=True):
            return svc.unblock_card(
                actor=actor or self.owner, board=self.board, card_id=self.card.pk,
                render=self.render, **kw,
            )

    def fresh(self):
        return Card.objects.get(pk=self.card.pk)

    def test_block_persists_state_snapshot_activity_and_one_version_bump(self):
        v0, u0 = self.fresh().version, self.fresh().updated_at
        before = timezone.now()
        result = self.block()
        card = self.fresh()
        self.assertEqual(card.blocked_reason, "waiting on infra")
        self.assertGreaterEqual(card.blocked_at, before)
        self.assertEqual(card.version, v0 + 1)
        self.assertGreater(card.updated_at, u0)
        self.assertEqual(result.payload["marker"], "rendered")
        self.assertEqual(result.payload["version"], v0 + 1)
        row = CardBlock.objects.get(card=self.card)
        self.assertEqual(
            (row.reason, row.blocked_by_id, row.column_id, row.column_name, row.column_uid,
             row.card_uid, row.card_title, row.board_id),
            ("waiting on infra", self.owner.pk, self.col.pk, "Doing", self.col.uid,
             self.card.uid, "Blocker target", self.board.pk),
        )
        self.assertEqual(row.blocked_at, card.blocked_at)
        self.assertIsNone(row.unblocked_at)
        act = CardActivity.objects.get(card=self.card, event_type=CardActivity.EventType.BLOCKED)
        self.assertEqual((act.from_value, act.to_value, act.actor_id), ("", "waiting on infra", self.owner.pk))

    def test_block_fires_the_card_updated_hook_with_the_actor(self):
        with patch.object(svc, "_fire_hooks") as hook:
            self.block()
        hook.assert_called_once_with("card.updated", self.card.pk, self.board.pk, self.owner.pk)

    def test_block_twice_is_a_conflict_and_changes_nothing(self):
        self.block()
        v = self.fresh().version
        with self.assertRaises(CardAlreadyBlocked):
            self.block("again")
        self.assertEqual(self.fresh().version, v)
        self.assertEqual(self.fresh().blocked_reason, "waiting on infra")
        self.assertEqual(CardBlock.objects.filter(card=self.card).count(), 1)

    def test_block_reads_archived_state_under_the_lock(self):
        stale = Card.objects.select_related("column").get(pk=self.card.pk)
        Card.objects.filter(pk=self.card.pk).update(archived_at=timezone.now())
        with patch.object(svc, "_fetch_for_block", return_value=stale):
            with self.assertRaises(CardNotFound):
                self.block()
        self.assertFalse(CardBlock.objects.filter(card=self.card).exists())

    def test_archived_or_missing_cards_are_not_found(self):
        Card.objects.filter(pk=self.card.pk).update(archived_at=timezone.now())
        with self.assertRaises(CardNotFound):
            self.block()
        with self.assertRaises(CardNotFound):
            svc._fetch_for_block(10**9, self.board)

    def test_fetch_for_block_returns_the_live_card_with_its_column_loaded(self):
        with self.assertNumQueries(1):
            card = svc._fetch_for_block(self.card.pk, self.board)
            self.assertEqual(card.column.name, "Doing")

    def test_ownership_and_role_denials_carry_their_text(self):
        member = _make_user("g2516_member")
        _make_membership(self.board, member, "member")
        with self.assertRaises(NotPermitted) as ctx:
            self.block(actor=member)
        self.assertEqual(ctx.exception.detail, "You can only block cards you created.")
        self.block()
        with self.assertRaises(NotPermitted) as ctx:
            self.unblock(actor=member)
        self.assertEqual(ctx.exception.detail, "You can only unblock cards you created.")
        viewer = _make_user("g2516_viewer")
        _make_membership(self.board, viewer, "viewer")
        with self.assertRaises(NotPermitted):
            self.block(actor=viewer)
        with self.assertRaises(NotPermitted):
            self.unblock(actor=viewer)

    def test_unblock_closes_the_open_row_clears_the_card_and_bumps_once(self):
        self.block("first")
        self.unblock(resolution="fixed")
        self.block("second")
        v0 = self.fresh().version
        before = timezone.now()
        result = self.unblock(resolution="rolled back")
        card = self.fresh()
        self.assertIsNone(card.blocked_at)
        self.assertEqual(card.blocked_reason, "")
        self.assertEqual(card.version, v0 + 1)
        self.assertEqual(result.payload["marker"], "rendered")
        first = CardBlock.objects.get(card=self.card, reason="first")
        second = CardBlock.objects.get(card=self.card, reason="second")
        # Only the open row is rewritten; the earlier closed one keeps its resolution.
        self.assertEqual((first.reason, first.resolution), ("first", "fixed"))
        self.assertLess(first.unblocked_at, before)
        self.assertEqual((second.reason, second.resolution, second.unblocked_by_id), ("second", "rolled back", self.owner.pk))
        self.assertGreaterEqual(second.unblocked_at, before)
        act = CardActivity.objects.filter(card=self.card, event_type=CardActivity.EventType.UNBLOCKED, to_value="rolled back").get()
        self.assertEqual((act.from_value, act.to_value, act.actor_id), ("second", "rolled back", self.owner.pk))

    def test_unblock_without_a_resolution_stores_blank(self):
        self.block()
        u0 = self.fresh().updated_at
        self.unblock()
        self.assertEqual(CardBlock.objects.get(card=self.card).resolution, "")
        self.assertGreater(self.fresh().updated_at, u0)
        act = CardActivity.objects.filter(card=self.card, event_type=CardActivity.EventType.UNBLOCKED).get()
        self.assertEqual(act.to_value, "")

    def test_unblock_hook_and_not_blocked_conflict(self):
        with self.assertRaises(CardNotBlocked):
            self.unblock()
        self.block()
        with patch.object(svc, "_fire_hooks") as hook:
            self.unblock()
        hook.assert_called_once_with("card.updated", self.card.pk, self.board.pk, self.owner.pk)

    def test_unblock_reads_archived_state_under_the_lock(self):
        self.block()
        stale = Card.objects.select_related("column").get(pk=self.card.pk)
        Card.objects.filter(pk=self.card.pk).update(archived_at=timezone.now())
        with patch.object(svc, "_fetch_for_block", return_value=stale):
            with self.assertRaises(CardNotFound):
                self.unblock()

    def test_bump_version_adds_exactly_one_in_the_database_and_in_memory(self):
        card = self.fresh()
        v = card.version
        svc._bump_version(card)
        self.assertEqual(card.version, v + 1)
        self.assertEqual(self.fresh().version, v + 1)

    def test_bump_version_refreshes_only_the_version(self):
        card = self.fresh()
        card.title = "unsaved in-memory edit"
        svc._bump_version(card)
        # A refresh of every field would have reverted the unsaved edit.
        self.assertEqual(card.title, "unsaved in-memory edit")


class SmallPathTests(TestCase):
    def setUp(self):
        patcher = patch("boards.broadcast.broadcast_board_event")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.owner = _make_user("g2516_small")
        self.board = _make_board(self.owner)
        self.col = _make_column(self.board, "A", 0)
        self.lane = _make_swimlane(self.board, "L", 0)
        self.card = _make_card(self.col, self.lane, title="One")
        self.peer = _make_card(_make_column(_make_board(self.owner, name="Other"), "X", 0),
                               _make_swimlane(Card.objects.none().model.board.field.related_model.objects.get(name="Other"), "Y", 0),
                               title="Peer")

    def test_cascade_lock_includes_link_peers_outside_the_container(self):
        CardParentLink.objects.create(parent=self.peer, child=self.card)
        locked = svc._lock_cascade_cards(Card.objects.filter(pk=self.card.pk))
        self.assertEqual(locked, frozenset({self.card.pk, self.peer.pk}))

    def test_cascade_lock_without_links_is_just_the_container(self):
        locked = svc._lock_cascade_cards(Card.objects.filter(pk=self.card.pk))
        self.assertEqual(locked, frozenset({self.card.pk}))

    def test_blocked_peers_ping_parents_as_the_acting_user(self):
        with patch("boards.services.card_links.announce_children_changed") as ping:
            svc._broadcast_blocked_peers(self.board.pk, [self.peer.pk], self.owner, None, None)
        ping.assert_called_once_with([self.peer.pk], actor_id=self.owner.pk)

    def test_delete_locks_the_card_and_its_link_peers_by_id(self):
        from boards.services import card_links
        pk = self.card.pk  # the instance loses its pk when it is deleted
        with patch.object(card_links, "lock_card_and_link_peers", wraps=card_links.lock_card_and_link_peers) as lock:
            svc.delete_card(actor=self.owner, board=self.board, card=self.card)
        lock.assert_called_once_with(pk)

    def test_update_card_announces_the_parent_only_when_the_title_changed(self):
        def run(**changes):
            card = Card.objects.select_related("assignee", "board", "column").get(pk=self.card.pk)

            def apply():
                for k, v in changes.items():
                    setattr(card, k, v)
                card.save()

            with self.captureOnCommitCallbacks(execute=True):
                svc.update_card(
                    actor=self.owner, board=self.board, card=card,
                    submitted=dict(changes), apply=apply, render=_render_move,
                )

        with patch("boards.services.card_links.announce_parent_changed") as parent:
            run(priority="high")
            parent.assert_not_called()
            run(title="Renamed")
            parent.assert_called_once()

    def test_delete_broadcasts_the_deleted_cards_uid(self):
        uid = self.card.uid
        with patch.object(svc, "_broadcast_after_commit") as broadcast:
            svc.delete_card(actor=self.owner, board=self.board, card=self.card)
        payloads = [c.args[2] for c in broadcast.call_args_list if c.args[1] == svc._broadcast.EVT_CARD_DELETED]
        self.assertEqual(payloads, [{"card_uid": uid}])
