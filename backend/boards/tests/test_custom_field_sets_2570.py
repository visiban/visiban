"""Custom field sets (#2570): CRUD, RBAC, caps, broadcast, export/import, copy."""

import io
import json
from unittest import mock

from rest_framework import serializers as drf_serializers, status
from rest_framework.test import APIClient

from boards.models import (
    Board, BoardMembership, CustomFieldDefinition, CustomFieldSet, CustomFieldValue,
    Swimlane,
)
from boards.views import field_sets as views_field_sets
from boards.serializers import BoardFullSerializer, CustomFieldSetSerializer, PublicBoardSerializer
from boards.tests.conftest import _make_board, _make_membership, _make_swimlane, _make_user
from boards.tests.test_custom_fields import CustomFieldTestBase, T, _definition


class FieldSetTestBase(CustomFieldTestBase):
    def setUp(self):
        super().setUp()
        self.f1 = _definition(self.board, "Metrics", position=0)
        self.f2 = _definition(self.board, "Champion", position=1)
        self.f3 = _definition(self.board, "Budget", field_type=T.NUMBER, position=2)

    def _sets_url(self, board=None):
        return f"/api/v1/boards/{(board or self.board).id}/field-sets/"

    def _set_url(self, fs):
        return f"{self._sets_url(fs.board)}{fs.id}/"

    def _create(self, client=None, **body):
        body.setdefault("name", "MEDDIC")
        return (client or self.client).post(self._sets_url(), body, format="json")

    def _events(self):
        return [call.args[1] for call in self.broadcast.call_args_list]


class FieldSetCrudTests(FieldSetTestBase):
    def test_create_assigns_fields_and_position(self):
        r = self._create(field_ids=[self.f2.id, self.f1.id], description="  Qualify  ")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        self.assertEqual(r.data["field_ids"], [self.f1.id, self.f2.id])  # board field order
        self.assertEqual(r.data["default_size"], "summary")
        self.assertEqual(r.data["scope"], "all")
        self.assertEqual(r.data["description"], "Qualify")
        self.assertEqual(r.data["position"], 0)
        self.f1.refresh_from_db()
        self.assertEqual(self.f1.field_set_id, r.data["id"])
        r2 = self._create(name="Second")
        self.assertEqual(r2.data["position"], 1)

    def test_blank_description_is_null_and_long_one_is_refused(self):
        self.assertIsNone(self._create(description="").data["description"])
        r = self._create(name="Other", description="x" * 121)
        self.assertEqual(r.status_code, 400)
        self.assertIn("description", r.data)

    def test_duplicate_name_is_a_400(self):
        self._create()
        r = self._create()
        self.assertEqual(r.status_code, 400)
        self.assertIn("name", r.data)

    def test_moving_a_field_takes_it_out_of_its_old_set(self):
        a = self._create(name="A", field_ids=[self.f1.id, self.f2.id]).data
        self.broadcast.reset_mock()
        with self.captureOnCommitCallbacks(execute=True):
            b = self._create(name="B", field_ids=[self.f2.id]).data
        self.f2.refresh_from_db()
        self.assertEqual(self.f2.field_set_id, b["id"])
        a_now = self.client.get(f"{self._sets_url()}{a['id']}/").data
        self.assertEqual(a_now["field_ids"], [self.f1.id])
        # The set that lost a field is broadcast too.
        self.assertEqual(self._events(), ["field_set.created", "field_set.updated"])

    def test_update_replaces_membership_and_omitted_keeps_it(self):
        fs = self._create(field_ids=[self.f1.id]).data
        url = f"{self._sets_url()}{fs['id']}/"
        r = self.client.patch(url, {"name": "Renamed"}, format="json")
        self.assertEqual(r.data["field_ids"], [self.f1.id])
        r = self.client.patch(url, {"field_ids": [self.f3.id]}, format="json")
        self.assertEqual(r.data["field_ids"], [self.f3.id])
        self.f1.refresh_from_db()
        self.assertIsNone(self.f1.field_set_id)

    def test_delete_ungroups_and_keeps_values(self):
        fs = self._create(field_ids=[self.f1.id]).data
        CustomFieldValue.objects.create(card=self.card, field_definition=self.f1, value="42")
        with self.captureOnCommitCallbacks(execute=True):
            r = self.client.delete(f"{self._sets_url()}{fs['id']}/")
        self.assertEqual(r.status_code, 204)
        self.f1.refresh_from_db()
        self.assertIsNone(self.f1.field_set_id)
        self.assertTrue(CustomFieldValue.objects.filter(field_definition=self.f1).exists())
        self.assertIn("field_set.deleted", self._events())
        payload = self.broadcast.call_args_list[-1].args[2]
        self.assertEqual(payload, {"field_set_uid": fs["uid"]})

    def test_out_of_range_and_non_integer_ids_are_400(self):
        fs = self._create().data
        for body in (
            {"name": "a", "field_ids": [10**30]},
            {"name": "b", "scope": "swimlanes", "swimlanes": [10**30]},
        ):
            self.assertEqual(self._create(**body).status_code, 400, body)
        for url, raw in (
            ("reorder/", '{"order": [1e400]}'),
            ("reorder/", '{"order": [true]}'),
            ("reorder/", f'{{"order": [{fs["id"]}.9]}}'),
            ("copy/", '{"source_board": 1e400, "source_set": 1}'),
            ("copy/", f'{{"source_board": {self.board.id}, "source_set": 1e400}}'),
        ):
            r = self.client.post(f"{self._sets_url()}{url}", raw, content_type="application/json")
            self.assertEqual(r.status_code, 400, raw)

    def test_name_or_lane_changed_after_validation_is_a_400(self):
        # The race window: validation passed, then another write landed before the lock.
        real = views_field_sets.lock_board_row_or_404

        def racing(board):
            real(board)
            CustomFieldSet.objects.get_or_create(board=board, name="Raced")

        with mock.patch.object(views_field_sets, "lock_board_row_or_404", racing):
            r = self._create(name="Raced")
        self.assertEqual(r.status_code, 400, r.data)
        self.assertIn("name", r.data)
        lane = _make_swimlane(self.board, "Doomed", 5)

        def lane_goes(board):
            real(board)
            Swimlane.objects.filter(pk=lane.pk).delete()

        with mock.patch.object(views_field_sets, "lock_board_row_or_404", lane_goes):
            r = self._create(name="Lanes", scope="swimlanes", swimlanes=[lane.id])
        self.assertEqual(r.status_code, 400, r.data)
        self.assertIn("swimlanes", r.data)

    def test_rename_validated_under_a_stale_scope_keeps_lanes(self):
        fs = CustomFieldSet.objects.create(board=self.board, name="A")
        ser = CustomFieldSetSerializer(fs, data={"name": "B"}, partial=True, context={"board": self.board})
        self.assertTrue(ser.is_valid(), ser.errors)
        self.assertNotIn("swimlanes", ser.validated_data)

    def test_lane_scoped_set_that_lost_every_lane_can_be_renamed(self):
        fs = self._create(scope="swimlanes", swimlanes=[self.lane.id]).data
        self.lane.delete()
        url = f"{self._sets_url()}{fs['id']}/"
        r = self.client.patch(url, {"name": "Renamed"}, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        r = self.client.patch(url, {"scope": "swimlanes"}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_field_from_another_board_is_refused(self):
        other = _make_board(self.admin, name="Other")
        foreign = _definition(other, "Foreign")
        r = self._create(field_ids=[foreign.id])
        self.assertEqual(r.status_code, 400)
        self.assertIn("field_ids", r.data)

    def test_lane_scope_needs_board_lanes(self):
        r = self._create(scope="swimlanes")
        self.assertEqual(r.status_code, 400)
        other_lane = _make_swimlane(_make_board(self.admin, name="O"), "X", 0)
        r = self._create(scope="swimlanes", swimlanes=[other_lane.id])
        self.assertEqual(r.status_code, 400)
        r = self._create(scope="swimlanes", swimlanes=[self.lane.id])
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(r.data["swimlanes"], [self.lane.id])
        # Back to every card clears the lanes.
        r = self.client.patch(f"{self._sets_url()}{r.data['id']}/", {"scope": "all"}, format="json")
        self.assertEqual(r.data["swimlanes"], [])

    def test_swimlane_delete_cascades_out_of_the_set(self):
        fs = self._create(scope="swimlanes", swimlanes=[self.lane.id]).data
        self.lane.delete()
        self.assertFalse(CustomFieldSet.objects.get(pk=fs["id"]).swimlanes.exists())

    def test_reorder(self):
        a = self._create(name="A").data
        b = self._create(name="B").data
        with self.captureOnCommitCallbacks(execute=True):
            r = self.client.post(f"{self._sets_url()}reorder/", {"order": [b["id"], a["id"]]}, format="json")
        self.assertEqual([s["id"] for s in r.data], [b["id"], a["id"]])
        self.assertIn("field_set.reordered", self._events())
        r = self.client.post(f"{self._sets_url()}reorder/", {"order": ["x"]}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_set_cap(self):
        for i in range(CustomFieldSet.SET_CAP):
            self.assertEqual(self._create(name=f"S{i}").status_code, 201)
        r = self._create(name="One too many")
        self.assertEqual(r.status_code, 400)
        self.assertIn("10-set limit", str(r.data))

    def test_definition_serializer_exposes_field_set_read_only(self):
        fs = self._create(field_ids=[self.f1.id]).data
        r = self.client.patch(f"{self._fields_url()}{self.f2.id}/", {"field_set": fs["id"]}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertIsNone(r.data["field_set"])
        self.assertEqual(self.client.get(f"{self._fields_url()}{self.f1.id}/").data["field_set"], fs["id"])


class FieldSetRbacTests(FieldSetTestBase):
    def test_every_role_reads(self):
        self._create()
        for user in (self.member, self.viewer):
            r = self._as(user).get(self._sets_url())
            self.assertEqual(r.status_code, 200)
            self.assertEqual(len(r.data), 1)

    def test_writes_are_admin_only_even_with_an_invalid_body(self):
        fs = self._create().data
        url = f"{self._sets_url()}{fs['id']}/"
        for user in (self.member, self.viewer):
            c = self._as(user)
            self.assertEqual(c.post(self._sets_url(), {"name": ""}, format="json").status_code, 403)
            self.assertEqual(c.patch(url, {"name": "x"}, format="json").status_code, 403)
            self.assertEqual(c.put(url, {"name": "x"}, format="json").status_code, 403)
            self.assertEqual(c.get(url).status_code, 200)
            self.assertEqual(c.delete(url).status_code, 403)
            self.assertEqual(c.post(f"{self._sets_url()}reorder/", {"order": []}, format="json").status_code, 403)
            self.assertEqual(c.post(f"{self._sets_url()}copy/", {}, format="json").status_code, 403)

    def _every_verb(self, client, url):
        return [
            client.get(self._sets_url()), client.get(url),
            client.post(self._sets_url(), {"name": "x"}, format="json"),
            client.put(url, {"name": "x"}, format="json"),
            client.patch(url, {"name": "x"}, format="json"), client.delete(url),
            client.post(f"{self._sets_url()}reorder/", {"order": []}, format="json"),
            client.post(f"{self._sets_url()}copy/", {}, format="json"),
        ]

    def test_outsider_and_anonymous_are_refused_on_every_verb(self):
        url = f"{self._sets_url()}{self._create().data['id']}/"
        outsider = _make_user("cfs_outsider2")
        self.assertEqual({r.status_code for r in self._every_verb(self._as(outsider), url)}, {404})
        codes = {r.status_code for r in self._every_verb(APIClient(), url)}
        self.assertTrue(codes <= {401, 403}, codes)

    def test_site_admin_without_membership_may_write(self):
        site_admin = _make_user("cfs_site_admin")
        site_admin.is_staff = True
        site_admin.is_superuser = True
        site_admin.save()
        r = self._create(client=self._as(site_admin), name="By site admin")
        self.assertEqual(r.status_code, 201, r.data)

    def test_cross_board_set_delete_is_404(self):
        other = _make_board(self.admin, name="Elsewhere")
        foreign = CustomFieldSet.objects.create(board=other, name="Foreign")
        self.assertEqual(self.client.delete(f"{self._sets_url()}{foreign.id}/").status_code, 404)
        self.assertTrue(CustomFieldSet.objects.filter(pk=foreign.pk).exists())

    def test_outsider_gets_404_and_cross_board_set_is_404(self):
        outsider = _make_user("cfs_outsider")
        self.assertEqual(self._as(outsider).get(self._sets_url()).status_code, 404)
        other = _make_board(self.admin, name="Other")
        foreign = CustomFieldSet.objects.create(board=other, name="Foreign")
        r = self.client.patch(f"{self._sets_url()}{foreign.id}/", {"name": "x"}, format="json")
        self.assertEqual(r.status_code, 404)

    def test_serializer_without_board_context_refuses(self):
        # Absent-input guard (#1075): no board means no id validation, so refuse.
        ser = CustomFieldSetSerializer(data={"name": "A", "field_ids": [self.f1.id]}, context={})
        self.assertFalse(ser.is_valid())
        self.assertIn("detail", ser.errors)
        with self.assertRaises(drf_serializers.ValidationError):
            CustomFieldSetSerializer(data={"name": "A"}).is_valid(raise_exception=True)


class FieldSetExposureTests(FieldSetTestBase):
    def test_full_carries_sets(self):
        self._create(field_ids=[self.f1.id])
        r = self.client.get(f"/api/v1/boards/{self.board.id}/full/")
        self.assertEqual(len(r.data["custom_field_sets"]), 1)
        self.assertEqual(r.data["custom_field_sets"][0]["field_ids"], [self.f1.id])
        self.assertIn("custom_field_sets", BoardFullSerializer.Meta.fields)

    def test_public_board_payload_has_no_sets(self):
        # The public board exposes no custom fields, so it exposes no sets.
        self._create(field_ids=[self.f1.id])
        self.assertNotIn("custom_field_sets", PublicBoardSerializer.Meta.fields)
        self.assertNotIn("field_sets", PublicBoardSerializer.Meta.fields)


class FieldSetExportImportTests(FieldSetTestBase):
    def test_round_trip(self):
        lane2 = _make_swimlane(self.board, "Enterprise", 1)
        self._create(name="MEDDIC", field_ids=[self.f1.id, self.f2.id], description="Qualify",
                     default_size="expanded", scope="swimlanes", swimlanes=[lane2.id])
        self._create(name="Money", field_ids=[self.f3.id])
        r = self.client.get(f"/api/v1/boards/{self.board.id}/export/?format=json")
        data = json.loads(r.content)
        self.assertEqual(data["schema_version"], 2)
        self.assertEqual(data["field_sets"][0], {
            "name": "MEDDIC", "description": "Qualify", "position": 0, "default_size": "expanded",
            "scope": "swimlanes", "fields": ["Metrics", "Champion"], "swimlanes": ["Enterprise"],
        })
        f = io.BytesIO(json.dumps(data).encode())
        f.name = "board.json"
        r = self.client.post("/api/v1/boards/import/", {"file": f}, format="multipart")
        self.assertEqual(r.status_code, 201, r.data)
        board = Board.objects.get(pk=r.data["id"])
        sets = list(board.custom_field_sets.order_by("position"))
        self.assertEqual([s.name for s in sets], ["MEDDIC", "Money"])
        self.assertEqual(sorted(f.name for f in sets[0].fields.all()), ["Champion", "Metrics"])
        self.assertEqual([s.name for s in sets[0].swimlanes.all()], ["Enterprise"])
        self.assertEqual(sets[0].description, "Qualify")

    def test_round_trip_keeps_lane_scope_after_the_last_lane_is_deleted(self):
        lane2 = _make_swimlane(self.board, "Enterprise", 1)
        self._create(name="MEDDIC", field_ids=[self.f1.id], scope="swimlanes", swimlanes=[lane2.id])
        lane2.delete()
        data = json.loads(self.client.get(f"/api/v1/boards/{self.board.id}/export/?format=json").content)
        self.assertEqual((data["field_sets"][0]["scope"], data["field_sets"][0]["swimlanes"]), ("swimlanes", []))
        f = io.BytesIO(json.dumps(data).encode())
        f.name = "board.json"
        r = self.client.post("/api/v1/boards/import/", {"file": f}, format="multipart")
        self.assertEqual(r.status_code, 201, r.data)
        field_set = Board.objects.get(pk=r.data["id"]).custom_field_sets.get()
        self.assertEqual(field_set.scope, "swimlanes")
        self.assertEqual(list(field_set.swimlanes.all()), [])

    def test_import_refuses_unhashable_values_with_a_400(self):
        r = self.client.get(f"/api/v1/boards/{self.board.id}/export/?format=json")
        data = json.loads(r.content)
        for bad in (
            [{"name": "A", "default_size": []}],
            [{"name": "A", "scope": {}}],
            [{"name": "A", "fields": [[1]]}],
            [{"name": "A", "swimlanes": [{}]}],
        ):
            data["field_sets"] = bad
            f = io.BytesIO(json.dumps(data).encode())
            f.name = "board.json"
            r = self.client.post("/api/v1/boards/import/", {"file": f}, format="multipart")
            self.assertEqual(r.status_code, 400, bad)

    def test_import_refuses_unknown_field_and_double_membership(self):
        r = self.client.get(f"/api/v1/boards/{self.board.id}/export/?format=json")
        data = json.loads(r.content)
        for bad in (
            [{"name": "A", "fields": ["Nope"]}],
            [{"name": "A", "fields": ["Metrics"]}, {"name": "B", "fields": ["Metrics"]}],
            [{"name": "A", "default_size": "huge"}],
            "not a list",
        ):
            data["field_sets"] = bad
            f = io.BytesIO(json.dumps(data).encode())
            f.name = "board.json"
            r = self.client.post("/api/v1/boards/import/", {"file": f}, format="multipart")
            self.assertEqual(r.status_code, 400, bad)


class FieldSetCopyTests(FieldSetTestBase):
    def setUp(self):
        super().setUp()
        self.source = _make_board(self.admin, name="Source")
        self.s_metrics = _definition(self.source, "Metrics", position=0)  # reuse (same type, ungrouped)
        self.s_budget = _definition(self.source, "Budget", field_type=T.TEXT, position=1)  # type differs
        self.s_new = _definition(self.source, "Decision", field_type=T.DATE, position=2, help_text="When")
        self.src_set = CustomFieldSet.objects.create(board=self.source, name="MEDDIC", description="Q")
        CustomFieldDefinition.objects.filter(board=self.source).update(field_set=self.src_set)

    def _copy(self, client=None, **body):
        body.setdefault("source_board", self.source.id)
        body.setdefault("source_set", self.src_set.id)
        return (client or self.client).post(f"{self._sets_url()}copy/", body, format="json")

    def test_copy_reuses_creates_and_suffixes(self):
        with self.captureOnCommitCallbacks(execute=True):
            r = self._copy()
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(r.data["name"], "MEDDIC")
        self.assertEqual(r.data["description"], "Q")
        names = set(CustomFieldDefinition.objects.filter(pk__in=r.data["field_ids"]).values_list("name", flat=True))
        self.assertEqual(names, {"Metrics", "Budget (copied)", "Decision"})
        self.assertIn(self.f1.id, r.data["field_ids"])
        decision = CustomFieldDefinition.objects.get(board=self.board, name="Decision")
        self.assertEqual((decision.field_type, decision.help_text), (T.DATE, "When"))
        self.assertEqual(self._events().count("custom_field.created"), 2)
        created = [c.args[2] for c in self.broadcast.call_args_list if c.args[1] == "custom_field.created"]
        self.assertEqual([p["has_values"] for p in created], [False, False])
        self.assertIn("field_set.created", self._events())
        # A second copy collides on the set name and on the now-grouped field.
        r = self._copy()
        self.assertEqual(r.data["name"], "MEDDIC (copy)")

    def test_copy_needs_read_access_to_the_source(self):
        stranger = _make_user("cfs_stranger")
        hidden = _make_board(stranger, name="Hidden")
        hidden_set = CustomFieldSet.objects.create(board=hidden, name="Secret")
        r = self._copy(source_board=hidden.id, source_set=hidden_set.id)
        self.assertEqual(r.status_code, 404)
        # A set id that is not on the named source board is a 404 too.
        r = self._copy(source_set=hidden_set.id)
        self.assertEqual(r.status_code, 404)

    def test_copy_refuses_past_the_field_cap(self):
        for i in range(CustomFieldDefinition.MAX_PER_BOARD - 4):
            _definition(self.board, f"Pad {i}", position=10 + i)
        r = self._copy()
        self.assertEqual(r.status_code, 400)
        self.assertIn("Copying adds 2 fields; this board has room for 1", str(r.data))
        self.assertFalse(CustomFieldSet.objects.filter(board=self.board).exists())

    def test_copy_viewer_of_source_may_copy(self):
        reader_admin = _make_user("cfs_reader")
        _make_membership(self.board, reader_admin, BoardMembership.Role.ADMIN)
        _make_membership(self.source, reader_admin, BoardMembership.Role.VIEWER)
        r = self._copy(client=self._as(reader_admin))
        self.assertEqual(r.status_code, 201, r.data)

    def test_copy_bad_ids(self):
        self.assertEqual(self._copy(source_board="x").status_code, 400)
