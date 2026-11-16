"""Board swimlane rollup field (#2275).

``Board.swimlane_rollup_field`` names the card number field each swimlane band
sums over the lane's open cards. The sum itself is computed by clients from the
/full/ card values; the server stores and validates the choice. Covers the
admin-only write gate, board scoping (no cross-board existence oracle), the
number-only rule, the null default, SET_NULL on definition delete, the
retype-away behavior, read surfaces, the deferred ``board.updated`` payload, and
the migration's zero-downtime shape.
"""
import importlib
from unittest.mock import patch

from django.db import connection
from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, CustomFieldDefinition
from boards.serializers import PublicBoardSerializer

PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"

_migration = importlib.import_module("boards.migrations.0108_board_swimlane_rollup_field")

NUMBER = CustomFieldDefinition.FieldType.NUMBER


class BoardSwimlaneRollupFieldTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="rollup_owner", password="pass")
        self.board = Board.objects.create(name="Rollup board", owner=self.owner)
        BoardMembership.objects.create(board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN)
        self.amount = CustomFieldDefinition.objects.create(
            board=self.board, name="Amount", field_type=NUMBER, number_prefix="$", position=0,
        )
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def _patch(self, body, client=None):
        with patch(PATCH_BROADCAST):
            return (client or self.client).patch(f"/api/v1/boards/{self.board.pk}/", body, format="json")

    def _client_for(self, role):
        user = User.objects.create_user(username=f"rollup_{role}", password="pass")
        BoardMembership.objects.create(board=self.board, user=user, role=role)
        client = APIClient()
        client.force_authenticate(user)
        return client

    # ── default and round trip ─────────────────────────────────────────────

    def test_defaults_to_null_on_every_read_surface(self):
        self.assertIsNone(self.board.swimlane_rollup_field)
        for url in (f"/api/v1/boards/{self.board.pk}/", f"/api/v1/boards/{self.board.pk}/full/"):
            with self.subTest(url=url):
                body = self.client.get(url).json()
                self.assertIn("swimlane_rollup_field", body)
                self.assertIsNone(body["swimlane_rollup_field"])
        listed = self.client.get("/api/v1/boards/").json()
        rows = listed["results"] if isinstance(listed, dict) else listed
        row = next(b for b in rows if b["id"] == self.board.pk)
        self.assertIsNone(row["swimlane_rollup_field"])

    def test_number_field_round_trips_and_null_clears(self):
        r = self._patch({"swimlane_rollup_field": self.amount.pk})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["swimlane_rollup_field"], self.amount.pk)
        self.board.refresh_from_db()
        self.assertEqual(self.board.swimlane_rollup_field_id, self.amount.pk)
        full = self.client.get(f"/api/v1/boards/{self.board.pk}/full/").json()
        self.assertEqual(full["swimlane_rollup_field"], self.amount.pk)

        r = self._patch({"swimlane_rollup_field": None})
        self.assertEqual(r.status_code, 200)
        self.assertIsNone(r.json()["swimlane_rollup_field"])
        self.board.refresh_from_db()
        self.assertIsNone(self.board.swimlane_rollup_field_id)

    def test_other_patches_leave_it_alone(self):
        self._patch({"swimlane_rollup_field": self.amount.pk})
        r = self._patch({"name": "Renamed"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["swimlane_rollup_field"], self.amount.pk)

    # ── validation ──────────────────────────────────────────────────────────

    def test_non_number_field_is_400_and_not_stored(self):
        self._patch({"swimlane_rollup_field": self.amount.pk})
        for position, field_type in enumerate(("text", "date", "dropdown", "checkbox", "url", "multi_select"), 1):
            with self.subTest(field_type=field_type):
                d = CustomFieldDefinition.objects.create(
                    board=self.board, name=f"F {field_type}", field_type=field_type, position=position,
                )
                r = self._patch({"swimlane_rollup_field": d.pk})
                self.assertEqual(r.status_code, 400, r.content)
                self.assertEqual(r.json()["swimlane_rollup_field"], ["swimlane_rollup_field must be a number field."])
        self.board.refresh_from_db()
        self.assertEqual(self.board.swimlane_rollup_field_id, self.amount.pk)

    def test_other_boards_field_answers_exactly_like_an_unknown_id(self):
        other = Board.objects.create(name="Other", owner=self.owner)
        foreign = CustomFieldDefinition.objects.create(board=other, name="Amount", field_type=NUMBER)
        missing_id = CustomFieldDefinition.objects.order_by("-pk").first().pk + 1000
        foreign_r = self._patch({"swimlane_rollup_field": foreign.pk})
        missing_r = self._patch({"swimlane_rollup_field": missing_id})
        self.assertEqual(foreign_r.status_code, 400)
        self.assertEqual(missing_r.status_code, 400)
        # Same body apart from the id itself: no oracle for another board's ids.
        self.assertEqual(
            foreign_r.json()["swimlane_rollup_field"][0].replace(str(foreign.pk), "N"),
            missing_r.json()["swimlane_rollup_field"][0].replace(str(missing_id), "N"),
        )
        self.board.refresh_from_db()
        self.assertIsNone(self.board.swimlane_rollup_field_id)

    def test_malformed_values_are_400_never_500(self):
        # 99999999999999999999 is past the id column's range (no OverflowError 500).
        for bad in ("", "abc", -1, 0, 1.5, ["1"], {"id": 1}, True, 99999999999999999999, "99999999999999999999"):
            with self.subTest(bad=bad):
                r = self._patch({"swimlane_rollup_field": bad})
                self.assertEqual(r.status_code, 400, r.content)

    def test_create_rejects_a_non_null_value(self):
        with patch(PATCH_BROADCAST):
            r = self.client.post(
                "/api/v1/boards/", {"name": "New", "swimlane_rollup_field": self.amount.pk}, format="json",
            )
            ok = self.client.post("/api/v1/boards/", {"name": "New 2", "swimlane_rollup_field": None}, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("swimlane_rollup_field", r.json())
        self.assertEqual(ok.status_code, 201, ok.content)
        self.assertIsNone(ok.json()["swimlane_rollup_field"])

    # ── permissions ─────────────────────────────────────────────────────────

    def test_only_board_admins_can_write(self):
        for role in (BoardMembership.Role.VIEWER, BoardMembership.Role.COLLABORATOR, BoardMembership.Role.MEMBER):
            with self.subTest(role=role):
                client = self._client_for(role)
                r = self._patch({"swimlane_rollup_field": self.amount.pk}, client=client)
                self.assertEqual(r.status_code, 403, r.content)
                # Every member still reads it.
                self.assertIn("swimlane_rollup_field", client.get(f"/api/v1/boards/{self.board.pk}/full/").json())
        self.board.refresh_from_db()
        self.assertIsNone(self.board.swimlane_rollup_field_id)

    def test_non_member_cannot_write(self):
        stranger = User.objects.create_user(username="rollup_stranger", password="pass")
        client = APIClient()
        client.force_authenticate(stranger)
        r = self._patch({"swimlane_rollup_field": self.amount.pk}, client=client)
        # The board is outside the caller's queryset: 404, never 403 (no IDOR oracle).
        self.assertEqual(r.status_code, 404, r.content)
        self.board.refresh_from_db()
        self.assertIsNone(self.board.swimlane_rollup_field_id)

    # ── lifecycle of the chosen field ──────────────────────────────────────

    def test_deleting_the_field_clears_the_setting(self):
        self._patch({"swimlane_rollup_field": self.amount.pk})
        with patch(PATCH_BROADCAST):
            r = self.client.delete(f"/api/v1/boards/{self.board.pk}/custom-fields/{self.amount.pk}/")
        self.assertIn(r.status_code, (200, 204), r.content)
        self.board.refresh_from_db()
        self.assertIsNone(self.board.swimlane_rollup_field_id)
        self.assertEqual(self.client.get(f"/api/v1/boards/{self.board.pk}/").status_code, 200)

    def test_deleting_the_rollup_field_broadcasts_board_updated_on_commit(self):
        # Without this frame every open client keeps the stale id, and the
        # settings dialog reads it as a field retyped away from number.
        self._patch({"swimlane_rollup_field": self.amount.pk})
        with patch(PATCH_BROADCAST) as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=False) as callbacks:
                r = self.client.delete(f"/api/v1/boards/{self.board.pk}/custom-fields/{self.amount.pk}/")
            self.assertEqual(r.status_code, 204, r.content)
            mock_broadcast.assert_not_called()
            for callback in callbacks:
                callback()
        events = [c[0][1] for c in mock_broadcast.call_args_list]
        self.assertEqual(events, ["custom_field.deleted", "board.updated"])
        board_updated = mock_broadcast.call_args_list[1][0][2]
        self.assertIsNone(board_updated["swimlane_rollup_field"])
        self.assertEqual(board_updated["id"], self.board.pk)
        # The same keys a board edit's board.updated carries.
        edit_keys = set(self.client.get(f"/api/v1/boards/{self.board.pk}/").json())
        self.assertEqual(set(board_updated), edit_keys)
        # Persisted, so a client replaying /events/?after= learns of it too.
        from boards.models import BoardEvent
        self.assertTrue(
            BoardEvent.objects.filter(board_id=self.board.pk, event="board.updated").exists()
        )

    def test_deleting_another_field_sends_no_board_updated(self):
        self._patch({"swimlane_rollup_field": self.amount.pk})
        other = CustomFieldDefinition.objects.create(board=self.board, name="Other", field_type=NUMBER, position=1)
        with patch(PATCH_BROADCAST) as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                r = self.client.delete(f"/api/v1/boards/{self.board.pk}/custom-fields/{other.pk}/")
        self.assertEqual(r.status_code, 204, r.content)
        self.assertEqual([c[0][1] for c in mock_broadcast.call_args_list], ["custom_field.deleted"])

    def test_field_deleted_after_validation_is_400_not_integrity_error(self):
        # The race: PATCH validates the id, a concurrent delete of the field
        # commits, then the PATCH takes the board lock. Simulated
        # deterministically by deleting the field as the PATCH takes the lock
        # (the delete holds that same board row first, so under real
        # concurrency it is either fully before this point or fully after the
        # PATCH commits). The re-check under the lock answers 400.
        from boards.views import boards as board_views

        real_lock = board_views.lock_board_row_or_404

        def delete_then_lock(board, **kwargs):
            CustomFieldDefinition.objects.filter(pk=self.amount.pk).delete()
            return real_lock(board, **kwargs)

        with patch.object(board_views, "lock_board_row_or_404", side_effect=delete_then_lock):
            r = self._patch({"swimlane_rollup_field": self.amount.pk})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("swimlane_rollup_field", r.json())
        self.board.refresh_from_db()
        self.assertIsNone(self.board.swimlane_rollup_field_id)

    def test_field_retyped_after_validation_is_400(self):
        from boards.views import boards as board_views

        real_lock = board_views.lock_board_row_or_404

        def retype_then_lock(board, **kwargs):
            CustomFieldDefinition.objects.filter(pk=self.amount.pk).update(field_type="text")
            return real_lock(board, **kwargs)

        with patch.object(board_views, "lock_board_row_or_404", side_effect=retype_then_lock):
            r = self._patch({"swimlane_rollup_field": self.amount.pk})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json()["swimlane_rollup_field"], ["swimlane_rollup_field must be a number field."])
        self.board.refresh_from_db()
        self.assertIsNone(self.board.swimlane_rollup_field_id)

    def test_retype_away_from_number_keeps_the_id_and_reads_still_succeed(self):
        # Option B (architect review): the server keeps the id and clients hide
        # the rollup while the field is not a number, so undoing the retype
        # restores it with no extra write or broadcast.
        self._patch({"swimlane_rollup_field": self.amount.pk})
        CustomFieldDefinition.objects.filter(pk=self.amount.pk).update(field_type="text")
        full = self.client.get(f"/api/v1/boards/{self.board.pk}/full/")
        self.assertEqual(full.status_code, 200)
        self.assertEqual(full.json()["swimlane_rollup_field"], self.amount.pk)
        # An unrelated PATCH is not blocked by the stale choice (field absent from body).
        self.assertEqual(self._patch({"name": "Still fine"}).status_code, 200)

    def test_echoing_the_stored_id_after_retype_is_accepted(self):
        # The id is deliberately kept when the field is retyped away from
        # number, so a PUT of the GET body or a PATCH echoing it must not 400
        # on a value the request does not change (same rule as `group`).
        self._patch({"swimlane_rollup_field": self.amount.pk})
        CustomFieldDefinition.objects.filter(pk=self.amount.pk).update(field_type="text")
        url = f"/api/v1/boards/{self.board.pk}/"
        body = self.client.get(url).json()
        with patch(PATCH_BROADCAST):
            put = self.client.put(url, body, format="json")
        self.assertEqual(put.status_code, 200, put.content)
        self.assertEqual(put.json()["swimlane_rollup_field"], self.amount.pk)
        patch_r = self._patch({"swimlane_rollup_field": self.amount.pk})
        self.assertEqual(patch_r.status_code, 200, patch_r.content)
        self.board.refresh_from_db()
        self.assertEqual(self.board.swimlane_rollup_field_id, self.amount.pk)

    def test_a_different_non_number_id_is_still_400_after_retype(self):
        self._patch({"swimlane_rollup_field": self.amount.pk})
        CustomFieldDefinition.objects.filter(pk=self.amount.pk).update(field_type="text")
        other = CustomFieldDefinition.objects.create(
            board=self.board, name="Notes", field_type="text", position=1,
        )
        r = self._patch({"swimlane_rollup_field": other.pk})
        self.assertEqual(r.status_code, 400, r.content)
        self.board.refresh_from_db()
        self.assertEqual(self.board.swimlane_rollup_field_id, self.amount.pk)

    def test_deleting_the_rollup_field_also_broadcasts_to_the_group_channel(self):
        from groups.models import Group

        group = Group.objects.create(name="Rollup group", owner=self.owner)
        self.board.group = group
        self.board.save(update_fields=["group"])
        self._patch({"swimlane_rollup_field": self.amount.pk})
        with patch(PATCH_BROADCAST), patch("groups.broadcast.broadcast_group_event") as group_send:
            with self.captureOnCommitCallbacks(execute=False) as callbacks:
                r = self.client.delete(f"/api/v1/boards/{self.board.pk}/custom-fields/{self.amount.pk}/")
            self.assertEqual(r.status_code, 204, r.content)
            group_send.assert_not_called()
            for callback in callbacks:
                callback()
        group_send.assert_called_once()
        args = group_send.call_args[0]
        self.assertEqual(args[0], group.pk)
        self.assertEqual(args[1], "board.updated")
        self.assertIsNone(args[2]["swimlane_rollup_field"])

    def test_public_share_payload_does_not_carry_it(self):
        self._patch({"swimlane_rollup_field": self.amount.pk})
        self.board.refresh_from_db()
        self.assertNotIn("swimlane_rollup_field", PublicBoardSerializer(self.board).data)

    # ── broadcast ───────────────────────────────────────────────────────────

    def test_board_updated_carries_field_and_is_deferred_to_commit(self):
        with patch(PATCH_BROADCAST) as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=False) as callbacks:
                r = self.client.patch(
                    f"/api/v1/boards/{self.board.pk}/", {"swimlane_rollup_field": self.amount.pk}, format="json",
                )
            self.assertEqual(r.status_code, 200)
            mock_broadcast.assert_not_called()
            for callback in callbacks:
                callback()
        payloads = [c[0][2] for c in mock_broadcast.call_args_list if c[0][1] == "board.updated"]
        self.assertEqual(len(payloads), 1)
        self.assertEqual(payloads[0]["swimlane_rollup_field"], self.amount.pk)


class BoardSwimlaneRollupFieldMigrationTests(TestCase):
    """0108 must stay a catalog-only ADD COLUMN: nullable, no DB default, no index."""

    def test_migration_is_a_single_nullable_add_field(self):
        ops = _migration.Migration.operations
        self.assertEqual(len(ops), 1)
        op = ops[0]
        self.assertEqual(op.__class__.__name__, "AddField")
        self.assertEqual((op.model_name, op.name), ("board", "swimlane_rollup_field"))
        self.assertTrue(op.field.null)
        self.assertFalse(op.field.db_index)
        self.assertFalse(op.field.unique)
        self.assertEqual(op.field.remote_field.on_delete.__name__, "SET_NULL")

    def test_column_is_nullable_in_the_database(self):
        with connection.cursor() as cursor:
            columns = connection.introspection.get_table_description(cursor, Board._meta.db_table)
        column = next(c for c in columns if c.name == "swimlane_rollup_field_id")
        self.assertTrue(column.null_ok)
