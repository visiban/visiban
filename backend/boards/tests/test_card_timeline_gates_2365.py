"""#2365: the card timeline returns gate transitions as ``kind: "gate"`` entries.

The History tab reads only ``/timeline/``, so a move between sub-columns inside
a stage (which writes a CardGateTransition but no CardMovement) and a
stage-settings remap were invisible there. These pin: the new entry kind and
its ``data`` shape (the CardGateTransition REST shape, security invariant
Rule 10); that a gate crossed by a column move stays on the move entry and is
not listed twice; the ``gate`` filter and count group; that 1.x requests
naming their groups get the response they got before; object-level scoping;
and a constant query count.
"""
import datetime

from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, CardActivity, CardGateTransition, Column, Swimlane
from boards.serializers import CardGateTransitionSerializer
from boards.tests.test_stages import _StageBase


class _GateTimelineBase(_StageBase):
    def setUp(self):
        super().setUp()
        self.url = f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/timeline/"

    def get(self, params=None, client=None):
        resp = (client or self.client).get(self.url, params or {})
        self.assertEqual(resp.status_code, 200, getattr(resp, "data", None))
        return resp.json()

    _UNSET = object()

    def gate(self, kind="pass", from_index=0, to_index=1, cause="move", card=None, minutes_ago=0,
             actor=_UNSET, **extra):
        row = CardGateTransition(
            card=card or self.card, column=self.stage, kind=kind, from_index=from_index,
            to_index=to_index, cause=cause, actor=self.user if actor is self._UNSET else actor,
            sub_column_name=self.subs[to_index].name, sub_column_uid=self.subs[to_index].uid,
            **extra,
        )
        row.created_at = timezone.now() - datetime.timedelta(minutes=minutes_ago)
        row.save()
        return row


class GateEntryShapeTests(_GateTimelineBase):
    def test_a_move_inside_a_stage_is_a_gate_entry(self):
        self.move(self.stage)
        self.move(self.stage, gates_passed=1)
        results = self.get()["results"]
        gates = [e for e in results if e["kind"] == "gate"]
        self.assertEqual(len(gates), 1)
        entry = gates[0]
        row = CardGateTransition.objects.get()
        self.assertEqual(entry["id"], row.pk)
        self.assertEqual(entry["event_type"], "gate_passed")
        self.assertEqual(entry["actor"]["username"], self.user.username)
        self.assertIsNone(entry["imported_from_username"])
        # The one REST shape for a gate row (Rule 10).
        self.assertEqual(entry["data"], dict(CardGateTransitionSerializer(row).data))
        self.assertEqual(entry["data"]["sub_column_name"], "Review")
        self.assertIsNone(entry["data"]["movement"])
        # Newest first: the in-stage pass follows the move into the stage.
        self.assertEqual([e["kind"] for e in results][:2], ["gate", "move"])

    def test_moving_back_inside_a_stage_is_one_reopened_entry_per_gate(self):
        self.move(self.stage)
        self.move(self.stage, gates_passed=2)
        self.move(self.stage, gates_passed=0)
        gates = [e for e in self.get()["results"] if e["kind"] == "gate"]
        self.assertEqual(
            [(e["event_type"], e["data"]["from_index"], e["data"]["to_index"]) for e in gates][:2],
            [("gate_reopened", 1, 0), ("gate_reopened", 2, 1)],
        )

    def test_a_stage_settings_remap_is_a_gate_entry(self):
        self.gate(kind="reopen", from_index=2, to_index=1, cause="stage_edited")
        (entry,) = self.get()["results"]
        self.assertEqual((entry["kind"], entry["event_type"]), ("gate", "gate_reopened"))
        self.assertEqual(entry["data"]["cause"], "stage_edited")

    def test_an_imported_gate_keeps_its_source_username(self):
        self.gate(cause="import", imported_from_username="jordan")
        (entry,) = self.get()["results"]
        self.assertEqual(entry["imported_from_username"], "jordan")

    def test_a_gate_whose_actor_was_deleted_has_a_null_actor(self):
        self.gate(actor=None)
        (entry,) = self.get()["results"]
        self.assertIsNone(entry["actor"])
        self.assertIsNone(entry["data"]["actor"])


class GateMovedWithAColumnTests(_GateTimelineBase):
    def test_gates_crossed_by_a_column_move_stay_on_the_move_entry(self):
        self.move(self.stage, gates_passed=2)
        self.assertEqual(CardGateTransition.objects.count(), 2)
        body = self.get({"include_counts": "true"})
        self.assertEqual([e["kind"] for e in body["results"]], ["move"])
        self.assertEqual(body["count"], 1)
        self.assertEqual(body["counts"]["gate"], 0)
        data = body["results"][0]["data"]
        # Additive move keys (#2365) the History gate note reads.
        self.assertEqual(data["to_gates_passed"], 2)
        self.assertIsNone(data["from_gates_passed"])
        self.assertIsNone(data["from_gates_open"])

    def test_counts_gate_excludes_movement_linked_rows_when_gate_is_filtered_out(self):
        # With `gate` absent from event_types the count comes from its own query,
        # not the page's total, so it must itself skip movement-linked rows.
        self.move(self.stage, gates_passed=2)
        body = self.get({"include_counts": "true", "event_types": "field"})
        self.assertEqual(body["counts"]["gate"], 0)
        unfiltered = self.get({"include_counts": "true"})
        self.assertEqual(sum(body["counts"].values()), unfiltered["count"])

    def test_leaving_a_stage_early_is_on_the_move_entry(self):
        self.move(self.stage)
        self.move(self.stage, gates_passed=1)
        self.move(self.done)
        move = self.get({"event_types": "move"})["results"][0]["data"]
        self.assertEqual((move["from_gates_passed"], move["from_gates_open"]), (1, 1))


class GateFilterAndCountTests(_GateTimelineBase):
    def setUp(self):
        super().setUp()
        self.move(self.stage)
        self.move(self.stage, gates_passed=1)
        CardActivity.objects.create(
            card=self.card, event_type=CardActivity.EventType.PRIORITY_CHANGE,
            from_value="low", to_value="high", actor=self.user,
        )

    def test_gate_filter_returns_only_gates(self):
        body = self.get({"event_types": "gate"})
        self.assertEqual({e["kind"] for e in body["results"]}, {"gate"})
        self.assertEqual(body["count"], 1)

    def test_naming_the_pre_1_3_groups_returns_no_gate_entries(self):
        # A 1.x client that names its groups gets the response it got before.
        body = self.get({"event_types": "move,comment,field,checklist,attachment,system"})
        self.assertNotIn("gate", {e["kind"] for e in body["results"]})
        self.assertEqual(body["count"], 2)

    def test_omitting_event_types_includes_gates(self):
        body = self.get()
        self.assertEqual({e["kind"] for e in body["results"]}, {"move", "gate", "activity"})
        self.assertEqual(body["count"], 3)

    def test_gate_is_a_counted_group_and_the_sum_is_the_unfiltered_count(self):
        body = self.get({"include_counts": "true"})
        self.assertEqual(body["counts"]["gate"], 1)
        self.assertEqual(sum(body["counts"].values()), body["count"])
        # Independent of the filter, as every other group is (#967).
        self.assertEqual(self.get({"include_counts": "true", "event_types": "field"})["counts"]["gate"], 1)

    def test_gates_page_with_the_other_sources(self):
        for i in range(3):
            self.gate(minutes_ago=10 + i)
        first = self.get({"limit": 2})
        second = self.get({"limit": 2, "offset": 2})
        third = self.get({"limit": 2, "offset": 4})
        self.assertEqual(first["count"], 6)
        seen = [(e["kind"], e["id"]) for page in (first, second, third) for e in page["results"]]
        self.assertEqual(len(seen), 6)
        self.assertEqual(len(set(seen)), 6)
        ts = [e["ts"] for page in (first, second, third) for e in page["results"]]
        self.assertEqual(ts, sorted(ts, reverse=True))

    def test_unknown_group_is_still_a_400(self):
        resp = self.client.get(self.url, {"event_types": "gates"})
        self.assertEqual(resp.status_code, 400)


class GateScopingTests(_GateTimelineBase):
    def test_another_cards_gates_are_not_listed(self):
        other = Card.objects.create(
            board=self.board, column=self.stage, swimlane=self.lane, title="Other",
            created_by=self.user, position=1,
        )
        self.gate(card=other)
        body = self.get({"include_counts": "true"})
        self.assertEqual(body["results"], [])
        self.assertEqual(body["counts"]["gate"], 0)

    def test_a_deleted_cards_orphaned_gate_rows_are_not_listed(self):
        # card is SET_NULL on delete; the snapshot row must not surface on a
        # card that is not its own (the card filter is the scope, not card_uid).
        doomed = Card.objects.create(
            board=self.board, column=self.stage, swimlane=self.lane, title="Gone",
            created_by=self.user, position=1,
        )
        self.gate(card=doomed)
        doomed.delete()
        self.assertEqual(CardGateTransition.objects.filter(card__isnull=True).count(), 1)
        self.assertEqual(self.get({"include_counts": "true"})["counts"]["gate"], 0)

    def test_viewer_role_member_sees_the_gate_entry(self):
        # Read-only members read the History tab like everyone else.
        self.gate()
        viewer = User.objects.create_user(username="viewer2365", password="pass")
        BoardMembership.objects.create(board=self.board, user=viewer, role=BoardMembership.Role.VIEWER)
        client = APIClient()
        client.force_authenticate(viewer)
        resp = client.get(self.url, {"event_types": "gate"})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual([e["kind"] for e in resp.json()["results"]], ["gate"])

    def test_non_member_gets_404_not_gates(self):
        self.gate()
        outsider = User.objects.create_user(username="outsider2365", password="pass")
        client = APIClient()
        client.force_authenticate(outsider)
        resp = client.get(self.url, {"event_types": "gate", "include_counts": "true"})
        self.assertEqual(resp.status_code, 404)
        self.assertNotIn("results", resp.json())

    def test_card_requested_under_a_board_it_is_not_on_is_404(self):
        # The reader is a member of the other board, but the card is not on it:
        # the board in the URL is the access check, so nothing leaks across.
        self.gate()
        other_board = Board.objects.create(name="Other", owner=self.user)
        BoardMembership.objects.create(board=other_board, user=self.user, role=BoardMembership.Role.ADMIN)
        Column.objects.create(board=other_board, name="X", position=0)
        Swimlane.objects.create(board=other_board, name="L", position=0)
        resp = self.client.get(
            f"/api/v1/boards/{other_board.pk}/cards/{self.card.pk}/timeline/", {"event_types": "gate"},
        )
        self.assertEqual(resp.status_code, 404)

    def test_unauthenticated_gets_401(self):
        self.gate()
        self.client.logout()
        self.assertEqual(self.client.get(self.url).status_code, 401)


class GateQueryCountTests(_GateTimelineBase):
    def _query_count(self, params=None):
        with CaptureQueriesContext(connection) as ctx:
            self.get(params)
        return len(ctx.captured_queries)

    def test_gate_rows_add_no_per_row_query(self):
        self.gate(minutes_ago=1)
        one = self._query_count()
        for i in range(10):
            self.gate(minutes_ago=2 + i, actor=User.objects.create_user(username=f"actor2365_{i}"))
        self.assertEqual(self._query_count(), one)

    def test_counts_reuse_the_gate_total_the_page_read(self):
        self.gate()
        base = self._query_count()
        # Only the grouped activity aggregate is new: moves and gates reuse
        # the totals the page already read.
        self.assertEqual(self._query_count({"include_counts": "true"}), base + 1)

    def test_naming_other_groups_reads_no_gate_rows(self):
        self.gate()
        with CaptureQueriesContext(connection) as ctx:
            self.get({"event_types": "field"})
        self.assertFalse([q for q in ctx.captured_queries if "card_gate_transitions" in q["sql"]])
