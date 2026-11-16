"""Gated stages (#1102) and dimension fields / stage tracks (#1921)."""

from io import StringIO
from unittest.mock import patch

from django.core.management import call_command
from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    BoardMembership, Card, CardActivity, CardGateTransition, CardMovement, Column,
    CustomFieldDefinition, StageTrack, SubColumn, Swimlane, SwimlaneTrackException,
)
from boards.serializers import CardGateTransitionSerializer, PublicColumnSerializer
from boards.tests.conftest import _make_board


class _StageBase(TestCase):
    def setUp(self):
        patcher = patch("boards.broadcast.broadcast_board_event")
        self.broadcast = patcher.start()
        self.addCleanup(patcher.stop)
        self.client = APIClient()
        self.user = User.objects.create_user(username="admin1921", password="pass")
        self.client.force_authenticate(self.user)
        self.board = _make_board(self.user)
        self.plain = Column.objects.create(board=self.board, name="Backlog", position=0)
        self.stage = Column.objects.create(board=self.board, name="Build", position=1)
        self.done = Column.objects.create(board=self.board, name="Done", position=2)
        self.subs = [
            SubColumn.objects.create(column=self.stage, position=i, name=n)
            for i, n in enumerate(["Doing", "Review", "Ready to pull"])
        ]
        self.lane = Swimlane.objects.create(board=self.board, name="Lane", position=0)
        self.card = Card.objects.create(
            board=self.board, column=self.plain, swimlane=self.lane, title="C",
            created_by=self.user, position=0,
        )

    def move(self, column, **extra):
        body = {"column_id": column.pk, "swimlane_id": self.lane.pk, "position": 0, **extra}
        return self.client.post(
            f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/move/", body, format="json",
        )

    def stage_url(self, column=None):
        column = column or self.stage
        return f"/api/v1/boards/{self.board.pk}/columns/{column.pk}/stage/"


class MoveGateTests(_StageBase):
    def test_entering_a_stage_without_gates_passed_starts_at_zero(self):
        resp = self.move(self.stage)
        self.assertEqual(resp.status_code, 200, resp.data)
        self.card.refresh_from_db()
        self.assertEqual(self.card.gates_passed, 0)
        self.assertNotIn("gate_transitions", resp.data)
        movement = CardMovement.objects.get(card=self.card)
        self.assertIsNone(movement.from_gates_passed)
        self.assertIsNone(movement.from_gates_open)
        self.assertEqual(movement.to_gates_passed, 0)
        self.assertFalse(CardGateTransition.objects.exists())

    def test_entering_with_gates_passed_records_one_row_per_gate_linked_to_the_movement(self):
        resp = self.move(self.stage, gates_passed=2)
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertEqual(resp.data["card"]["gates_passed"], 2)
        rows = list(CardGateTransition.objects.order_by("id"))
        self.assertEqual([(r.from_index, r.to_index) for r in rows], [(0, 1), (1, 2)])
        movement = CardMovement.objects.get(card=self.card)
        self.assertTrue(all(r.movement_id == movement.pk for r in rows))
        self.assertTrue(all(r.kind == "pass" and r.cause == "move" for r in rows))
        self.assertEqual(rows[1].sub_column_name, "Ready to pull")
        self.assertEqual(len(resp.data["gate_transitions"]), 2)
        self.assertEqual(resp.data["movement"]["to_gates_passed"], 2)

    def test_pass_within_the_stage_writes_no_movement_and_bumps_version(self):
        self.move(self.stage)
        self.card.refresh_from_db()
        version = self.card.version
        resp = self.move(self.stage, gates_passed=1)
        self.assertEqual(resp.status_code, 200, resp.data)
        self.card.refresh_from_db()
        self.assertEqual(self.card.gates_passed, 1)
        self.assertEqual(self.card.version, version + 1)
        self.assertEqual(CardMovement.objects.filter(card=self.card).count(), 1)
        row = CardGateTransition.objects.get()
        self.assertEqual((row.kind, row.from_index, row.to_index), ("pass", 0, 1))
        self.assertIsNone(row.movement_id)
        self.assertEqual(row.actor, self.user)
        self.assertNotIn("movement", resp.data)

    def test_back_within_the_stage_reopens_each_gate(self):
        self.move(self.stage, gates_passed=2)
        resp = self.move(self.stage, gates_passed=0)
        self.assertEqual(resp.status_code, 200, resp.data)
        reopened = CardGateTransition.objects.filter(kind="reopen").order_by("id")
        self.assertEqual([(r.from_index, r.to_index) for r in reopened], [(2, 1), (1, 0)])

    def test_reorder_and_lane_change_keep_gates_passed(self):
        self.move(self.stage, gates_passed=1)
        other = Swimlane.objects.create(board=self.board, name="Other", position=1)
        resp = self.client.post(
            f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/move/",
            {"column_id": self.stage.pk, "swimlane_id": other.pk, "position": 0}, format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.data)
        self.card.refresh_from_db()
        self.assertEqual(self.card.gates_passed, 1)
        resp = self.client.post(
            f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/move/",
            {"column_id": self.stage.pk, "swimlane_id": other.pk, "position": 3}, format="json",
        )
        self.card.refresh_from_db()
        self.assertEqual(self.card.gates_passed, 1)
        self.assertEqual(CardGateTransition.objects.count(), 1)

    def test_leaving_with_gates_open_is_allowed_and_recorded(self):
        self.move(self.stage, gates_passed=1)
        resp = self.move(self.done)
        self.assertEqual(resp.status_code, 200, resp.data)
        movement = CardMovement.objects.filter(card=self.card).order_by("-id").first()
        self.assertEqual(movement.from_gates_passed, 1)
        self.assertEqual(movement.from_gates_open, 1)
        self.assertIsNone(movement.to_gates_passed)
        self.card.refresh_from_db()
        self.assertEqual(self.card.gates_passed, 0)

    def test_invalid_gates_passed_bodies(self):
        cases = [
            (self.stage, True, {"code": "invalid_gates_passed", "detail": "gates_passed must be an integer."}),
            (self.stage, "x", {"code": "invalid_gates_passed", "detail": "gates_passed must be an integer."}),
            (self.stage, -1, {"code": "invalid_gates_passed", "detail": "gates_passed must be an integer."}),
            (self.stage, 3, {
                "code": "invalid_gates_passed",
                "detail": "gates_passed must be between 0 and 2 for this column.",
                "max_gates_passed": 2,
            }),
            (self.done, 1, {
                "code": "invalid_gates_passed",
                "detail": "gates_passed must be between 0 and 0 for this column.",
                "max_gates_passed": 0,
            }),
        ]
        for column, value, body in cases:
            with self.subTest(value=value, column=column.name):
                resp = self.move(column, gates_passed=value)
                self.assertEqual(resp.status_code, 400)
                self.assertEqual(resp.json(), body)
        self.card.refresh_from_db()
        self.assertEqual(self.card.column, self.plain)
        self.assertFalse(CardGateTransition.objects.exists())

    def test_zero_on_a_plain_column_is_accepted(self):
        resp = self.move(self.done, gates_passed=0)
        self.assertEqual(resp.status_code, 200, resp.data)

    def test_mcp_move_card_returns_rest_shaped_transitions(self):
        from mcp_server import tools

        with patch("mcp_server.tools.get_current_user", return_value=self.user):
            out = tools.move_card(card_id=self.card.pk, to_column_id=self.stage.pk, gates_passed=1)
        self.assertNotIn("error", out)
        self.assertEqual(len(out["gate_transitions"]), 1)
        row = CardGateTransition.objects.get()
        self.assertEqual(
            out["gate_transitions"][0], CardGateTransitionSerializer(row).data,
        )
        self.card.refresh_from_db()
        self.assertEqual(self.card.gates_passed, 1)


class StageActionTests(_StageBase):
    def test_member_cannot_save_stage(self):
        member = User.objects.create_user(username="member1921", password="pass")
        BoardMembership.objects.create(board=self.board, user=member, role="member")
        client = APIClient()
        client.force_authenticate(member)
        resp = client.put(self.stage_url(), {"sub_columns": []}, format="json")
        self.assertEqual(resp.status_code, 403)
        self.assertEqual(SubColumn.objects.filter(column=self.stage).count(), 3)

    def test_non_member_gets_404(self):
        stranger = User.objects.create_user(username="stranger1921", password="pass")
        client = APIClient()
        client.force_authenticate(stranger)
        resp = client.put(self.stage_url(), {"sub_columns": []}, format="json")
        self.assertEqual(resp.status_code, 404)

    def test_one_sub_column_is_refused(self):
        resp = self.client.put(self.stage_url(self.plain), {"sub_columns": [{"name": "A"}]}, format="json")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("sub_columns", resp.data)

    def test_create_a_one_gate_stage_and_rename(self):
        resp = self.client.put(
            self.stage_url(self.plain),
            {"sub_columns": [{"name": "Doing"}, {"name": "Ready to pull"}]}, format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.data)
        subs = resp.data["column"]["sub_columns"]
        self.assertEqual([s["name"] for s in subs], ["Doing", "Ready to pull"])
        resp = self.client.put(
            self.stage_url(self.plain),
            {"sub_columns": [{"id": subs[0]["id"], "name": "Ready to pull"},
                             {"id": subs[1]["id"], "name": "Doing"}]},
            format="json",
        )
        # Swapping names is a rename, not a reorder, and survives the unique pair.
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertEqual([s["name"] for s in resp.data["column"]["sub_columns"]], ["Ready to pull", "Doing"])

    def test_reorder_is_refused(self):
        resp = self.client.put(
            self.stage_url(),
            {"sub_columns": [{"id": self.subs[1].pk, "name": "Review"},
                             {"id": self.subs[0].pk, "name": "Doing"}]},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_removing_a_sub_column_remaps_cards_past_it(self):
        cards = []
        for p in range(3):
            cards.append(Card.objects.create(
                board=self.board, column=self.stage, swimlane=self.lane, title=f"S{p}",
                created_by=self.user, position=p + 1, gates_passed=p,
            ))
        resp = self.client.put(
            self.stage_url(),
            {"sub_columns": [{"id": self.subs[0].pk, "name": "Doing"},
                             {"id": self.subs[2].pk, "name": "Ready to pull"}]},
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.data)
        for c in cards:
            c.refresh_from_db()
        self.assertEqual([c.gates_passed for c in cards], [0, 0, 1])
        remapped = {r["id"]: r for r in resp.data["remapped"]}
        self.assertEqual(set(remapped), {cards[1].pk, cards[2].pk})
        self.assertEqual(remapped[cards[2].pk]["version"], cards[2].version)
        rows = CardGateTransition.objects.filter(cause="stage_edited")
        self.assertEqual(rows.count(), 2)
        self.assertTrue(all(r.kind == "reopen" for r in rows))

    def test_turning_a_stage_back_into_a_column_puts_cards_at_zero(self):
        c = Card.objects.create(
            board=self.board, column=self.stage, swimlane=self.lane, title="S",
            created_by=self.user, position=1, gates_passed=2,
        )
        resp = self.client.put(self.stage_url(), {"sub_columns": []}, format="json")
        self.assertEqual(resp.status_code, 200, resp.data)
        c.refresh_from_db()
        self.assertEqual(c.gates_passed, 0)
        self.assertEqual(resp.data["column"]["sub_columns"], [])

    def test_tracks_and_lane_exceptions(self):
        dim = CustomFieldDefinition.objects.create(
            board=self.board, name="Docs", field_type="dropdown",
            choices_json=["Done", "Not applicable"], is_dimension=True,
            choice_resolutions={"Done": "satisfied", "Not applicable": "not_applicable"},
        )
        text = CustomFieldDefinition.objects.create(
            board=self.board, name="Notes", field_type="text", position=1,
        )
        resp = self.client.put(self.stage_url(), {"tracks": [text.pk]}, format="json")
        self.assertEqual(resp.status_code, 400)
        resp = self.client.put(
            self.stage_url(),
            {"tracks": [dim.pk], "not_applicable": [{"swimlane_id": self.lane.pk, "field_id": dim.pk}]},
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertEqual(resp.data["column"]["tracks"][0]["name"], "Docs")
        self.assertTrue(SwimlaneTrackException.objects.filter(swimlane=self.lane, field_definition=dim).exists())
        lane = self.client.get(f"/api/v1/boards/{self.board.pk}/swimlanes/{self.lane.pk}/").data
        self.assertEqual(lane["not_applicable_field_ids"], [dim.pk])
        # Removing the track unbinds it only.
        resp = self.client.put(self.stage_url(), {"tracks": []}, format="json")
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertFalse(StageTrack.objects.exists())
        self.assertTrue(CustomFieldDefinition.objects.filter(pk=dim.pk).exists())

    def test_column_update_broadcast_carries_remapped(self):
        from boards import broadcast as _broadcast

        with patch("boards.services.stages._broadcast.record_board_event") as record, \
                self.captureOnCommitCallbacks(execute=True):
            self.client.put(self.stage_url(), {"sub_columns": []}, format="json")
        events = [c.args[1] for c in record.call_args_list]
        self.assertIn(_broadcast.EVT_COLUMN_UPDATED, events)
        payload = record.call_args_list[0].args[2]
        self.assertIn("remapped", payload)
        self.assertEqual(payload["sub_columns"], [])

    def test_public_column_serializer_carries_sub_columns_and_tracks(self):
        fields = PublicColumnSerializer.Meta.fields
        self.assertIn("sub_columns", fields)
        self.assertIn("tracks", fields)
        self.assertNotIn("policy", fields)


class DimensionFieldTests(_StageBase):
    def url(self):
        return f"/api/v1/boards/{self.board.pk}/custom-fields/"

    def test_only_a_dropdown_can_be_a_dimension(self):
        resp = self.client.post(self.url(), {"name": "T", "field_type": "text", "is_dimension": True}, format="json")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("is_dimension", resp.data)

    def test_resolutions_are_validated_and_pruned(self):
        resp = self.client.post(self.url(), {
            "name": "QA", "field_type": "dropdown", "choices": ["Done", "N/A"],
            "is_dimension": True, "choice_resolutions": {"Done": "satisfied", "Gone": "satisfied"},
        }, format="json")
        self.assertEqual(resp.status_code, 201, resp.data)
        self.assertEqual(resp.data["choice_resolutions"], {"Done": "satisfied"})
        resp = self.client.post(self.url(), {
            "name": "QA2", "field_type": "dropdown", "choices": ["Done"],
            "is_dimension": True, "choice_resolutions": {"Done": "finished"},
        }, format="json")
        self.assertEqual(resp.status_code, 400)
        resp = self.client.post(self.url(), {
            "name": "QA3", "field_type": "dropdown", "choices": ["Done"],
            "choice_resolutions": {"Done": "satisfied"},
        }, format="json")
        self.assertEqual(resp.status_code, 400)

    def test_every_value_change_writes_an_activity_row(self):
        field = CustomFieldDefinition.objects.create(
            board=self.board, name="Docs", field_type="dropdown", choices_json=["Done"],
            is_dimension=True,
        )
        url = f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/"
        resp = self.client.patch(url, {"custom_field_values": [
            {"field_definition": field.pk, "value": "Done"}]}, format="json")
        self.assertEqual(resp.status_code, 200, resp.data)
        resp = self.client.patch(url, {"custom_field_values": [
            {"field_definition": field.pk, "value": ""}]}, format="json")
        self.assertEqual(resp.status_code, 200, resp.data)
        rows = list(CardActivity.objects.filter(
            card=self.card, event_type="custom_field_changed",
        ).order_by("id"))
        self.assertEqual([(r.from_value, r.to_value) for r in rows], [("", "Done"), ("Done", "")])
        self.assertTrue(all(r.item_text == "Docs" and r.actor == self.user for r in rows))


class PurgeGateTransitionTests(_StageBase):
    def test_purge_removes_a_deleted_cards_gate_transitions(self):
        self.move(self.stage, gates_passed=1)
        self.card.delete()
        self.assertEqual(CardGateTransition.objects.filter(card__isnull=True).count(), 1)
        User.objects.create_superuser(username="root1921", password="pass")
        call_command(
            "purge_card_history", "--actor", "root1921", "--board", str(self.board.pk), "--yes",
            stdout=StringIO(),
        )
        self.assertFalse(CardGateTransition.objects.exists())
