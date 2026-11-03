"""Board default preset (#1146).

``Board.default_preset`` stores the id of a code-defined preset (``classic`` /
``default``) or null. Covers validation, the admin-only write gate on every
board-writing route, presence on every read surface, the ``board.updated``
payload, and the migration's zero-downtime shape.
"""
import importlib
from unittest.mock import patch

from django.db import connection
from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, BoardPresetId
from groups.models import Group, GroupMembership

PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"

_migration = importlib.import_module("boards.migrations.0097_board_default_preset")


class BoardDefaultPresetTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="preset_owner", password="pass")
        self.board = Board.objects.create(name="Preset board", owner=self.owner)
        BoardMembership.objects.create(board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def _patch(self, body, client=None):
        with patch(PATCH_BROADCAST):
            return (client or self.client).patch(f"/api/v1/boards/{self.board.pk}/", body, format="json")

    def _client_for(self, role):
        user = User.objects.create_user(username=f"preset_{role}", password="pass")
        BoardMembership.objects.create(board=self.board, user=user, role=role)
        client = APIClient()
        client.force_authenticate(user)
        return client

    # ── validation ──────────────────────────────────────────────────────────

    def test_defaults_to_null(self):
        self.assertIsNone(self.board.default_preset)
        r = self.client.get(f"/api/v1/boards/{self.board.pk}/")
        self.assertEqual(r.status_code, 200)
        self.assertIn("default_preset", r.json())
        self.assertIsNone(r.json()["default_preset"])

    def test_shipped_ids_are_exactly_classic_and_default(self):
        # Pinned: an id is a public contract (stored on boards, carried in
        # ?preset= links). Adding one is additive; renaming or removing one
        # must fail this test first.
        self.assertEqual(sorted(BoardPresetId.values), ["classic", "default"])

    def test_each_id_round_trips_and_null_clears(self):
        for value in BoardPresetId.values:
            with self.subTest(value=value):
                r = self._patch({"default_preset": value})
                self.assertEqual(r.status_code, 200, r.content)
                self.assertEqual(r.json()["default_preset"], value)
                self.board.refresh_from_db()
                self.assertEqual(self.board.default_preset, value)
        r = self._patch({"default_preset": None})
        self.assertEqual(r.status_code, 200)
        self.assertIsNone(r.json()["default_preset"])
        self.board.refresh_from_db()
        self.assertIsNone(self.board.default_preset)

    def test_invalid_values_are_400_and_not_stored(self):
        self._patch({"default_preset": "classic"})
        for bad in ("", "Classic", "standup", "none", 1, ["classic"], {"id": "classic"}):
            with self.subTest(bad=bad):
                r = self._patch({"default_preset": bad})
                self.assertEqual(r.status_code, 400, r.content)
                self.assertIn("default_preset", r.json())
        self.board.refresh_from_db()
        self.assertEqual(self.board.default_preset, "classic")

    def test_invalid_value_message_names_the_accepted_ids(self):
        r = self._patch({"default_preset": "standup"})
        self.assertIn("classic", str(r.json()["default_preset"]))
        self.assertIn("default", str(r.json()["default_preset"]))

    def test_omitting_the_field_leaves_it_alone(self):
        self._patch({"default_preset": "default"})
        r = self._patch({"name": "Renamed"})
        self.assertEqual(r.status_code, 200)
        self.board.refresh_from_db()
        self.assertEqual(self.board.default_preset, "default")

    def test_create_accepts_default_preset(self):
        with patch(PATCH_BROADCAST) as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                r = self.client.post("/api/v1/boards/", {"name": "New", "default_preset": "default"}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(Board.objects.get(pk=r.json()["id"]).default_preset, "default")
        created = [c[0][2] for c in mock_broadcast.call_args_list if c[0][1] == "board.created"]
        self.assertTrue(created)
        self.assertEqual(created[0]["default_preset"], "default")

    def test_group_nested_create_validates_and_stores_it(self):
        # POST /groups/{id}/boards/ builds BoardSerializer itself (groups/views.py).
        group = Group.objects.create(name="Nested", owner=self.owner)
        GroupMembership.objects.create(group=group, user=self.owner, role=GroupMembership.Role.ADMIN)
        url = f"/api/v1/groups/{group.pk}/boards/"
        with patch(PATCH_BROADCAST):
            bad = self.client.post(url, {"name": "Bad", "default_preset": "standup"}, format="json")
            ok = self.client.post(
                url, {"name": "Good", "default_preset": "classic", "health_status": "at_risk"}, format="json",
            )
        self.assertEqual(bad.status_code, 400, bad.content)
        self.assertIn("default_preset", bad.json())
        self.assertFalse(Board.objects.filter(name="Bad").exists())
        self.assertEqual(ok.status_code, 201, ok.content)
        good = Board.objects.get(name="Good")
        self.assertEqual(good.default_preset, "classic")
        # docs/api/groups.md lists both as accepted on this route.
        self.assertEqual(good.health_status, "at_risk")

    def test_create_without_it_is_null(self):
        with patch(PATCH_BROADCAST):
            r = self.client.post("/api/v1/boards/", {"name": "Plain"}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertIsNone(r.json()["default_preset"])

    # ── read surfaces ───────────────────────────────────────────────────────

    def test_full_endpoint_carries_field_read_only(self):
        Board.objects.filter(pk=self.board.pk).update(default_preset="classic")
        body = self.client.get(f"/api/v1/boards/{self.board.pk}/full/").json()
        self.assertEqual(body["default_preset"], "classic")

    def test_list_endpoint_carries_field(self):
        Board.objects.filter(pk=self.board.pk).update(default_preset="default")
        body = self.client.get("/api/v1/boards/").json()
        rows = body["results"] if isinstance(body, dict) else body
        row = next(r for r in rows if r["id"] == self.board.pk)
        self.assertEqual(row["default_preset"], "default")

    def test_any_member_can_read_it(self):
        Board.objects.filter(pk=self.board.pk).update(default_preset="default")
        viewer = self._client_for(BoardMembership.Role.VIEWER)
        self.assertEqual(viewer.get(f"/api/v1/boards/{self.board.pk}/full/").json()["default_preset"], "default")

    # ── permissions ─────────────────────────────────────────────────────────

    def test_only_board_admins_may_write(self):
        for role in (BoardMembership.Role.MEMBER, BoardMembership.Role.COLLABORATOR, BoardMembership.Role.VIEWER):
            client = self._client_for(role)
            with self.subTest(role=role):
                r = self._patch({"default_preset": "default"}, client=client)
                self.assertEqual(r.status_code, 403)
                self.board.refresh_from_db()
                self.assertIsNone(self.board.default_preset)

    def test_put_from_a_member_is_403(self):
        client = self._client_for(BoardMembership.Role.MEMBER)
        with patch(PATCH_BROADCAST):
            r = client.put(
                f"/api/v1/boards/{self.board.pk}/", {"name": self.board.name, "default_preset": "default"}, format="json",
            )
        self.assertEqual(r.status_code, 403)
        self.board.refresh_from_db()
        self.assertIsNone(self.board.default_preset)

    def test_group_admin_inherits_board_admin_and_may_write(self):
        group = Group.objects.create(name="G", owner=self.owner)
        Board.objects.filter(pk=self.board.pk).update(group=group)
        admin = User.objects.create_user(username="preset_group_admin", password="pass")
        GroupMembership.objects.create(group=group, user=admin, role=GroupMembership.Role.ADMIN)
        client = APIClient()
        client.force_authenticate(admin)
        self.assertEqual(self._patch({"default_preset": "default"}, client=client).status_code, 200)

    def test_all_content_site_admin_may_write(self):
        site_admin = User.objects.create_user(username="preset_sa", password="pass", can_access_all_content=True)
        client = APIClient()
        client.force_authenticate(site_admin)
        self.assertEqual(self._patch({"default_preset": "classic"}, client=client).status_code, 200)
        self.board.refresh_from_db()
        self.assertEqual(self.board.default_preset, "classic")

    def test_outsider_gets_404(self):
        outsider = User.objects.create_user(username="preset_outsider", password="pass")
        client = APIClient()
        client.force_authenticate(outsider)
        self.assertEqual(self._patch({"default_preset": "default"}, client=client).status_code, 404)

    def test_anonymous_is_refused(self):
        r = APIClient().patch(f"/api/v1/boards/{self.board.pk}/", {"default_preset": "default"}, format="json")
        self.assertIn(r.status_code, (401, 403))
        self.board.refresh_from_db()
        self.assertIsNone(self.board.default_preset)

    # ── broadcast ───────────────────────────────────────────────────────────

    def test_board_updated_carries_field_and_is_deferred_to_commit(self):
        with patch(PATCH_BROADCAST) as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=False) as callbacks:
                r = self.client.patch(
                    f"/api/v1/boards/{self.board.pk}/", {"default_preset": "default"}, format="json",
                )
            self.assertEqual(r.status_code, 200)
            mock_broadcast.assert_not_called()
            for callback in callbacks:
                callback()
        payloads = [c[0][2] for c in mock_broadcast.call_args_list if c[0][1] == "board.updated"]
        self.assertEqual(len(payloads), 1)
        self.assertEqual(payloads[0]["default_preset"], "default")

        with patch(PATCH_BROADCAST) as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.client.patch(f"/api/v1/boards/{self.board.pk}/", {"default_preset": None}, format="json")
        payload = [c[0][2] for c in mock_broadcast.call_args_list if c[0][1] == "board.updated"][0]
        self.assertIn("default_preset", payload)
        self.assertIsNone(payload["default_preset"])


class BoardDefaultPresetMigrationTests(TestCase):
    """0097 must stay a catalog-only ADD COLUMN: nullable, no DB default, no index."""

    def test_migration_is_a_single_nullable_add_field(self):
        ops = _migration.Migration.operations
        self.assertEqual(len(ops), 1)
        op = ops[0]
        self.assertEqual(op.__class__.__name__, "AddField")
        self.assertEqual((op.model_name, op.name), ("board", "default_preset"))
        self.assertTrue(op.field.null)
        self.assertIsNone(op.field.default)
        self.assertFalse(op.field.db_index)
        self.assertFalse(op.field.unique)

    def test_column_is_nullable_in_the_database(self):
        with connection.cursor() as cursor:
            columns = connection.introspection.get_table_description(cursor, Board._meta.db_table)
        column = next(c for c in columns if c.name == "default_preset")
        self.assertTrue(column.null_ok)
