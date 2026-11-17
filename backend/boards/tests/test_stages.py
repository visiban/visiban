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
        # Only the card whose own sub-column was removed falls back and is
        # recorded; the one past it is merely re-indexed (no phantom pass).
        rows = CardGateTransition.objects.filter(cause="stage_edited")
        self.assertEqual([(r.card_id, r.kind) for r in rows], [(cards[1].pk, "reopen")])

    def test_inserting_a_sub_column_reindexes_cards_without_history(self):
        card = Card.objects.create(
            board=self.board, column=self.stage, swimlane=self.lane, title="S",
            created_by=self.user, position=1, gates_passed=1, version=3,
        )
        resp = self.client.put(
            self.stage_url(),
            {"sub_columns": [
                {"id": self.subs[0].pk, "name": "Doing"}, {"name": "New"},
                {"id": self.subs[1].pk, "name": "Review"}, {"id": self.subs[2].pk, "name": "Ready to pull"},
            ]},
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.data)
        card.refresh_from_db()
        self.assertEqual((card.gates_passed, card.version), (2, 4))
        self.assertEqual(resp.data["remapped"], [{"id": card.pk, "gates_passed": 2, "version": 4}])
        self.assertFalse(CardGateTransition.objects.filter(card=card).exists())

    def test_out_of_range_ids_are_400_not_500(self):
        big = 2 ** 70
        for body in (
            {"tracks": [big]},
            {"not_applicable": [{"swimlane_id": big, "field_id": big}]},
            {"sub_columns": [{"id": big, "name": "X"}, {"name": "Y"}]},
        ):
            resp = self.client.put(self.stage_url(), body, format="json")
            self.assertEqual(resp.status_code, 400, (body, resp.data))
        dim = CustomFieldDefinition.objects.create(
            board=self.board, name="Docs", field_type="dropdown",
            choices_json=["Done"], is_dimension=True, choice_resolutions={"Done": "satisfied"},
        )
        resp = self.client.put(
            self.stage_url(),
            {"tracks": [dim.pk], "not_applicable": [{"swimlane_id": big, "field_id": dim.pk}]},
            format="json",
        )
        self.assertEqual(resp.status_code, 400, resp.data)

    def test_tracks_and_exceptions_from_another_board_are_rejected(self):
        from boards.models import Board

        other = Board.objects.create(name="Other1921", owner=self.user)
        foreign_field = CustomFieldDefinition.objects.create(
            board=other, name="Docs", field_type="dropdown", choices_json=["Done"],
            is_dimension=True, choice_resolutions={"Done": "satisfied"},
        )
        foreign_lane = Swimlane.objects.create(board=other, name="Theirs", position=0)
        own_field = CustomFieldDefinition.objects.create(
            board=self.board, name="Mine", field_type="dropdown", choices_json=["Done"],
            is_dimension=True, choice_resolutions={"Done": "satisfied"},
        )
        resp = self.client.put(self.stage_url(), {"tracks": [foreign_field.pk]}, format="json")
        self.assertEqual(resp.status_code, 400, resp.data)
        self.assertFalse(StageTrack.objects.filter(column=self.stage).exists())
        resp = self.client.put(
            self.stage_url(),
            {"tracks": [own_field.pk],
             "not_applicable": [{"swimlane_id": foreign_lane.pk, "field_id": own_field.pk}]},
            format="json",
        )
        self.assertEqual(resp.status_code, 400, resp.data)
        self.assertFalse(SwimlaneTrackException.objects.filter(swimlane=foreign_lane).exists())
        # The 400 rolled the whole save back, including the valid track.
        self.assertFalse(StageTrack.objects.filter(column=self.stage).exists())

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

    def test_cannot_turn_off_dimension_while_used_as_a_track(self):
        field = CustomFieldDefinition.objects.create(
            board=self.board, name="Docs", field_type="dropdown", choices_json=["Done"],
            is_dimension=True,
        )
        StageTrack.objects.create(column=self.stage, field_definition=field, position=0)
        url = f"{self.url()}{field.pk}/"
        resp = self.client.patch(url, {"is_dimension": False}, format="json")
        self.assertEqual(resp.status_code, 400, resp.data)
        self.assertIn("is_dimension", resp.data)
        field.refresh_from_db()
        self.assertTrue(field.is_dimension)
        StageTrack.objects.all().delete()
        resp = self.client.patch(url, {"is_dimension": False}, format="json")
        self.assertEqual(resp.status_code, 200, resp.data)

    def test_cannot_turn_off_dimension_while_a_lane_exception_uses_it(self):
        field = CustomFieldDefinition.objects.create(
            board=self.board, name="Docs", field_type="dropdown", choices_json=["Done"],
            is_dimension=True,
        )
        SwimlaneTrackException.objects.create(swimlane=self.lane, field_definition=field)
        resp = self.client.patch(
            f"{self.url()}{field.pk}/", {"is_dimension": False}, format="json",
        )
        self.assertEqual(resp.status_code, 400, resp.data)

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


class HistoryCoverageTests(_StageBase):
    def test_purge_dry_run_counts_gate_rows(self):
        self.assertEqual(self.move(self.stage, gates_passed=2).status_code, 200)
        User.objects.create_user(
            username="su1921", password="pass", is_superuser=True, is_staff=True,
        )
        out = StringIO()
        call_command(
            "purge_card_history", "--board", str(self.board.pk), "--include-live-cards",
            "--actor", "su1921", stdout=out,
        )
        self.assertIn("and 2 gate transition row(s)", out.getvalue())
        self.assertEqual(CardGateTransition.objects.count(), 2)

    def test_user_delete_locks_cards_with_that_users_gate_rows(self):
        from accounts.admin import VisibanUserAdmin

        other = User.objects.create_user(username="actor1921", password="pass")
        CardGateTransition.objects.create(
            card=self.card, kind="pass", from_index=0, to_index=1, actor=other,
        )
        locked = VisibanUserAdmin._cards_to_lock([other.pk]).values_list("pk", flat=True)
        self.assertIn(self.card.pk, set(locked))


class AdminBoardMoveGateRowsTests(_StageBase):
    def test_gate_transitions_follow_a_card_moved_to_another_board(self):
        from django.contrib import admin as django_admin
        from django.test import RequestFactory

        from boards.models import Board

        CardGateTransition.objects.create(
            card=self.card, board=self.board, kind="pass", from_index=0, to_index=1,
            actor=self.user,
        )
        other = Board.objects.create(name="Other", owner=self.user)
        col = Column.objects.create(board=other, name="C", position=0)
        lane = Swimlane.objects.create(board=other, name="L", position=0)
        root = User.objects.create_superuser(username="root1921b", password="pass")
        request = RequestFactory().post("/")
        request.user = root
        obj = Card.objects.get(pk=self.card.pk)
        obj.board, obj.column, obj.swimlane = other, col, lane
        model_admin = django_admin.site._registry[Card]
        model_admin.save_model(request, obj, form=None, change=True)
        self.assertEqual(
            list(CardGateTransition.objects.filter(card=self.card).values_list("board_id", flat=True)),
            [other.pk],
        )


    def test_admin_column_change_resets_gates_passed_and_field_is_read_only(self):
        from django.contrib import admin as django_admin
        from django.test import RequestFactory

        model_admin = django_admin.site._registry[Card]
        self.assertIn("gates_passed", model_admin.readonly_fields)
        other_col = Column.objects.create(board=self.board, name="Elsewhere", position=9)
        Card.objects.filter(pk=self.card.pk).update(gates_passed=2)
        root = User.objects.create_superuser(username="root1921c", password="pass")
        request = RequestFactory().post("/")
        request.user = root
        # Same column: the stored value is kept, whatever ``obj`` carried.
        obj = Card.objects.get(pk=self.card.pk)
        obj.gates_passed = 0
        model_admin.save_model(request, obj, form=None, change=True)
        self.assertEqual(Card.objects.get(pk=self.card.pk).gates_passed, 2)
        # Column change: reset to 0, as move_card does.
        obj = Card.objects.get(pk=self.card.pk)
        obj.column = other_col
        model_admin.save_model(request, obj, form=None, change=True)
        self.assertEqual(Card.objects.get(pk=self.card.pk).gates_passed, 0)


class DateShiftHistoryTests(TestCase):
    def test_gate_transitions_and_date_field_changes_shift_with_the_board(self):
        from boards.services.date_shift import shift_board_dates

        data = {
            "custom_fields": [
                {"name": "Review by", "field_type": "date"},
                {"name": "Stage", "field_type": "dropdown"},
            ],
            "cards": [{
                "title": "C",
                "gate_transitions": [{"created_at": "2026-01-01T00:00:00+00:00"}],
                "activities": [
                    {"event_type": "custom_field_changed", "item_text": "Review by",
                     "from_value": "2026-01-05", "to_value": "2026-01-09",
                     "created_at": "2026-01-01T00:00:00+00:00"},
                    {"event_type": "custom_field_changed", "item_text": "Stage",
                     "from_value": "Open", "to_value": "Done",
                     "created_at": "2026-01-01T00:00:00+00:00"},
                    {"event_type": "custom_field_changed", "item_text": ["x"],
                     "from_value": "2026-01-05", "to_value": "2026-01-09",
                     "created_at": "2026-01-01T00:00:00+00:00"},
                ],
            }],
        }
        card = shift_board_dates(data, 10)["cards"][0]
        self.assertTrue(card["gate_transitions"][0]["created_at"].startswith("2026-01-11"))
        date_row, dropdown_row, odd_row = card["activities"]
        self.assertEqual((date_row["from_value"], date_row["to_value"]), ("2026-01-15", "2026-01-19"))
        self.assertTrue(date_row["created_at"].startswith("2026-01-11"))
        self.assertEqual((dropdown_row["from_value"], dropdown_row["to_value"]), ("Open", "Done"))
        self.assertEqual(odd_row["from_value"], "2026-01-05")
