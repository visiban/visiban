"""Swimlane field tiers: Band / Details / Hidden and the lane details cap (#2439)."""

import json
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest import skipUnless
from unittest.mock import patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection, connections, transaction
from django.test import TestCase, TransactionTestCase
from rest_framework import serializers
from rest_framework.test import APIClient

from boards.models import Board, BoardMembership, SwimlaneCustomFieldDefinition, SwimlaneCustomFieldValue
from boards.serializers import SwimlaneCustomFieldDefinitionSerializer, SwimlaneSerializer
from boards.services import lane_field_tiers as tiers
from boards.tests.conftest import _make_board, _make_column, _make_membership, _make_swimlane, _make_user
from boards.tests.lock_wait import assert_blocked_on_lock

FIXTURE = Path(__file__).parent / "fixtures" / "lane_field_tiers.json"


def _defn(board, name, position, band_visibility=None, **kwargs):
    kwargs.setdefault("is_admin_only", False)
    return SwimlaneCustomFieldDefinition.objects.create(
        board=board, name=name, position=position, band_visibility=band_visibility, **kwargs
    )


class ResolveTiersFixtureTests(TestCase):
    """The shared fixture pins this and the frontend ``resolveLaneTiers`` together."""

    def test_resolve_tiers_matches_the_shared_fixture(self):
        cases = json.loads(FIXTURE.read_text())["cases"]
        self.assertGreaterEqual(len(cases), 4)
        for case in cases:
            defs = [SimpleNamespace(id=i, position=p, band_visibility=bv) for i, p, bv in case["defs"]]
            got = {str(k): v for k, v in tiers.resolve_tiers(defs, case["cap"]).items()}
            self.assertEqual(got, case["expected"], case["name"])

    def test_materialized_tiers_caps_a_legacy_board(self):
        defs = [{"id": i, "position": i, "band_visibility": None} for i in range(9)]
        out = tiers.materialized_tiers(defs, 4)
        self.assertEqual([out[i] for i in range(9)], ["band"] * 2 + ["details"] * 4 + ["hidden"] * 3)


class _Base(TestCase):
    def setUp(self):
        self._p = patch("boards.broadcast.broadcast_board_event")
        self.broadcast = self._p.start()
        self.admin = _make_user("tier_admin")
        self.board = _make_board(self.admin, name="Tier board")
        _make_column(self.board, "Todo", 0, allow_card_creation=True)
        self.lane = _make_swimlane(self.board, "Acme", 0)
        self.client = APIClient()
        self.client.force_authenticate(self.admin)
        self.url = f"/api/v1/boards/{self.board.id}/swimlane-custom-fields/"
        self.board_url = f"/api/v1/boards/{self.board.id}/"

    def tearDown(self):
        self._p.stop()

    def _patch(self, d, **body):
        return self.client.patch(f"{self.url}{d.id}/", body, format="json")

    def _tiers(self):
        return list(
            SwimlaneCustomFieldDefinition.objects.filter(board=self.board)
            .order_by("position").values_list("band_visibility", flat=True)
        )


class ValidationAndMaterializationTests(_Base):
    def test_a_legacy_board_reads_null_and_the_board_cap_defaults_to_6(self):
        d = _defn(self.board, "A", 0)
        r = self.client.get(self.url)
        rows = r.data["results"] if isinstance(r.data, dict) else r.data
        self.assertIsNone(rows[0]["band_visibility"])
        self.assertEqual(self.client.get(self.board_url).data["lane_details_cap"], 6)
        full = self.client.get(f"{self.board_url}full/").data
        self.assertEqual(full["lane_details_cap"], 6)
        self.assertIsNone(d.band_visibility)

    def test_first_tier_patch_materializes_every_null_row(self):
        defs = [_defn(self.board, f"F{i}", i) for i in range(10)]
        r = self._patch(defs[9], band_visibility="details")
        # The 10th field was Hidden after materializing (2 band + 6 details);
        # moving it to Details now would put 7 in details: a 400.
        self.assertEqual(r.status_code, 400, r.data)
        self.assertEqual(r.data["band_visibility"][0], tiers.details_full_message(6))
        # The failed request rolled the materialization back with it.
        self.assertEqual(self._tiers(), [None] * 10)
        r = self._patch(defs[2], band_visibility="hidden")
        self.assertEqual(r.status_code, 200, r.data)
        self.assertEqual(
            self._tiers(),
            ["band", "band", "hidden", "details", "details", "details", "details", "details", "hidden", "hidden"],
        )

    def test_a_third_band_field_is_rejected(self):
        defs = [_defn(self.board, f"F{i}", i, "band" if i < 2 else "details") for i in range(3)]
        r = self._patch(defs[2], band_visibility="band")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.data["band_visibility"][0], tiers.BAND_FULL_MESSAGE)

    def test_reorder_never_moves_a_field_between_tiers(self):
        a = _defn(self.board, "A", 0, "band")
        b = _defn(self.board, "B", 1, "hidden")
        r = self.client.post(f"{self.url}reorder/", {"order": [b.id, a.id]}, format="json")
        self.assertEqual(r.status_code, 200)
        a.refresh_from_db()
        b.refresh_from_db()
        self.assertEqual((a.band_visibility, b.band_visibility), ("band", "hidden"))

    def test_create_without_a_tier_stays_null_on_a_legacy_board(self):
        _defn(self.board, "A", 0)
        r = self.client.post(self.url, {"name": "B", "field_type": "text"}, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        self.assertIsNone(r.data["band_visibility"])

    def test_create_without_a_tier_on_a_materialized_board_is_details_then_hidden(self):
        self.board.lane_details_cap = 4
        self.board.save(update_fields=["lane_details_cap"])
        for i in range(5):
            _defn(self.board, f"F{i}", i, "band" if i < 2 else "details")
        r = self.client.post(self.url, {"name": "New1", "field_type": "text"}, format="json")
        self.assertEqual(r.data["band_visibility"], "details")
        r = self.client.post(self.url, {"name": "New2", "field_type": "text"}, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(r.data["band_visibility"], "hidden")

    def test_create_with_an_explicit_tier_that_breaks_the_rule_is_a_400(self):
        _defn(self.board, "A", 0, "band")
        _defn(self.board, "B", 1, "band")
        r = self.client.post(self.url, {"name": "C", "field_type": "text", "band_visibility": "band"}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_an_invalid_tier_is_a_400(self):
        d = _defn(self.board, "A", 0)
        self.assertEqual(self._patch(d, band_visibility="sideways").status_code, 400)

    def test_lowering_the_cap_below_the_details_count_is_a_400(self):
        for i in range(6):
            _defn(self.board, f"F{i}", i, "band" if i < 2 else "details")
        r = self.client.patch(self.board_url, {"lane_details_cap": 4}, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        _defn(self.board, "F6", 6, "details")
        r = self.client.patch(self.board_url, {"lane_details_cap": 4}, format="json")
        self.assertEqual(r.status_code, 200)
        self.board.lane_details_cap = 6
        self.board.save(update_fields=["lane_details_cap"])
        r = self.client.patch(self.board_url, {"lane_details_cap": 4}, format="json")
        self.assertEqual(r.status_code, 400, r.data)
        self.assertIn("lane_details_cap", r.data)
        self.assertEqual(self.client.patch(self.board_url, {"lane_details_cap": 5}, format="json").status_code, 400)

    def test_a_cap_change_materializes_a_legacy_board(self):
        for i in range(8):
            _defn(self.board, f"F{i}", i)
        r = self.client.patch(self.board_url, {"lane_details_cap": 4}, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        self.assertEqual(self._tiers(), ["band"] * 2 + ["details"] * 4 + ["hidden"] * 2)

    def test_mixed_board_null_row_is_never_band(self):
        _defn(self.board, "A", 0)  # left NULL by an older pod
        b = _defn(self.board, "B", 1, "band")
        _defn(self.board, "C", 2, "band")
        r = self._patch(b, band_visibility="band")
        self.assertEqual(r.status_code, 200, r.data)
        self.assertEqual(self._tiers(), ["details", "band", "band"])

    def test_a_non_member_gets_404_on_the_tier_writes(self):
        d = _defn(self.board, "Region", 0, "hidden")
        outsider = _make_user("tier_outsider")
        c = APIClient()
        c.force_authenticate(outsider)
        self.assertEqual(c.patch(f"{self.url}{d.id}/", {"band_visibility": "band"}, format="json").status_code, 404)
        self.assertEqual(c.patch(self.board_url, {"lane_details_cap": 4}, format="json").status_code, 404)

    def test_patching_null_on_a_materialized_board_leaves_a_details_or_hidden_row(self):
        a = _defn(self.board, "A", 0, "band")
        b = _defn(self.board, "B", 1, "band")
        _defn(self.board, "C", 2, "details")
        r = self._patch(b, band_visibility=None)
        self.assertEqual(r.status_code, 200, r.data)
        self.assertIsNone(r.data["band_visibility"])
        self.assertEqual(self._tiers(), ["band", None, "details"])
        full = self.client.get(f"{self.board_url}full/").data
        self.assertEqual(full["swimlane_custom_field_definitions"][1]["band_visibility"], None)
        self.assertIsNotNone(a)
        # The resolver never promotes a NULL row to the band.
        resolved = tiers.resolve_tiers(
            list(SwimlaneCustomFieldDefinition.objects.filter(board=self.board).order_by("position")),
            self.board.lane_details_cap,
        )
        self.assertEqual(resolved[b.id], "details")

    def test_a_tier_patch_broadcasts_on_commit(self):
        d = _defn(self.board, "A", 0, "band")
        with self.captureOnCommitCallbacks(execute=True):
            r = self._patch(d, band_visibility="hidden")
        self.assertEqual(r.status_code, 200)
        sent = [(c.args[1], c.args[2]) for c in self.broadcast.call_args_list]
        self.assertIn(("swimlane_custom_field.updated", "hidden"), [(e, p.get("band_visibility")) for e, p in sent])

    def test_a_cap_change_broadcasts_board_updated_with_the_cap(self):
        with self.captureOnCommitCallbacks(execute=True):
            r = self.client.patch(self.board_url, {"lane_details_cap": 9}, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        sent = [(c.args[1], c.args[2]) for c in self.broadcast.call_args_list]
        self.assertTrue(any(e == "board.updated" and p.get("lane_details_cap") == 9 for e, p in sent), sent)

    def test_a_non_admin_reads_a_hidden_non_admin_only_value(self):
        d = _defn(self.board, "Region", 0, "hidden", is_admin_only=False)
        SwimlaneCustomFieldValue.objects.create(swimlane=self.lane, field_definition=d, value="EMEA")
        member = _make_user("tier_member")
        _make_membership(self.board, member, role=BoardMembership.Role.MEMBER)
        c = APIClient()
        c.force_authenticate(member)
        full = c.get(f"{self.board_url}full/").data
        lane = next(s for s in full["swimlanes"] if s["id"] == self.lane.id)
        self.assertIn("EMEA", [v["value"] for v in lane["custom_field_values"]])
        self.assertEqual(full["swimlane_custom_field_definitions"][0]["band_visibility"], "hidden")
        # Writes stay admin-only.
        self.assertEqual(c.patch(f"{self.url}{d.id}/", {"band_visibility": "band"}, format="json").status_code, 403)
        self.assertEqual(c.patch(self.board_url, {"lane_details_cap": 4}, format="json").status_code, 403)
        self.assertIsNotNone(SwimlaneSerializer)


class AbsentInputGuardTests(TestCase):
    """#1075: the tier rule needs a board and raises without one."""

    def test_serializer_without_a_board_raises_for_a_submitted_tier(self):
        ser = SwimlaneCustomFieldDefinitionSerializer(data={"name": "X", "field_type": "text", "band_visibility": "band"})
        self.assertFalse(ser.is_valid())
        self.assertIn("band_visibility", ser.errors)

    def test_serializer_without_a_board_and_without_a_tier_still_validates(self):
        ser = SwimlaneCustomFieldDefinitionSerializer(data={"name": "X", "field_type": "text"})
        self.assertTrue(ser.is_valid(), ser.errors)

    def test_the_explicit_import_marker_opts_out(self):
        ser = SwimlaneCustomFieldDefinitionSerializer(
            data={"name": "X", "field_type": "text", "band_visibility": "band"},
            context={"tiers_checked_by_caller": True},
        )
        self.assertTrue(ser.is_valid(), ser.errors)

    def test_assert_band_tiers_without_a_board_raises(self):
        with self.assertRaises(serializers.ValidationError):
            tiers.assert_band_tiers(None, instance=None, band_visibility="details")


class ImportExportTests(_Base):
    def _import(self, payload):
        f = SimpleUploadedFile("board.json", json.dumps(payload).encode(), content_type="application/json")
        return self.client.post("/api/v1/boards/import/", {"file": f}, format="multipart")

    def test_round_trip_carries_tiers_and_the_cap(self):
        self.board.lane_details_cap = 9
        self.board.save(update_fields=["lane_details_cap"])
        _defn(self.board, "A", 0, "hidden")
        _defn(self.board, "B", 1, "band")
        payload = json.loads(self.client.get(f"{self.board_url}export/?format=json").content.decode())
        self.assertEqual(payload["lane_details_cap"], 9)
        self.assertEqual([f["band_visibility"] for f in payload["swimlane_custom_fields"]], ["hidden", "band"])
        payload["name"] = "Copy"
        r = self._import(payload)
        self.assertEqual(r.status_code, 201, r.data)
        copy = Board.objects.get(pk=r.data["id"])
        self.assertEqual(copy.lane_details_cap, 9)
        self.assertEqual(
            list(copy.swimlane_custom_field_definitions.order_by("position").values_list("band_visibility", flat=True)),
            ["hidden", "band"],
        )

    def test_an_old_export_without_the_keys_imports_as_legacy(self):
        _defn(self.board, "A", 0)
        payload = json.loads(self.client.get(f"{self.board_url}export/?format=json").content.decode())
        payload.pop("lane_details_cap")
        for f in payload["swimlane_custom_fields"]:
            f.pop("band_visibility")
        payload["name"] = "Old"
        r = self._import(payload)
        self.assertEqual(r.status_code, 201, r.data)
        copy = Board.objects.get(pk=r.data["id"])
        self.assertEqual(copy.lane_details_cap, 6)
        self.assertIsNone(copy.swimlane_custom_field_definitions.get().band_visibility)

    def test_an_import_over_the_band_limit_is_a_400(self):
        payload = json.loads(self.client.get(f"{self.board_url}export/?format=json").content.decode())
        payload["name"] = "Bad"
        payload["swimlane_custom_fields"] = [
            {"name": f"F{i}", "field_type": "text", "band_visibility": "band"} for i in range(3)
        ]
        r = self._import(payload)
        self.assertEqual(r.status_code, 400)
        self.assertIn("band", str(r.data["detail"]))
        payload["swimlane_custom_fields"] = []
        payload["lane_details_cap"] = 7
        self.assertEqual(self._import(payload).status_code, 400)


@skipUnless(connection.vendor == "postgresql", "row locks are only observable on PostgreSQL")
class ConcurrentTierPatchTests(TransactionTestCase):
    """Two PATCHes moving different fields onto a one-slot-left band: one wins."""

    def test_two_concurrent_band_patches_yield_one_success(self):
        admin = _make_user("tier_conc_admin")
        board = _make_board(admin, name="Conc")
        _defn(board, "A", 0, "band")
        b = _defn(board, "B", 1, "details")
        c = _defn(board, "C", 2, "details")
        release = threading.Event()
        holding = threading.Event()
        results = {}
        errors = []

        def holder():
            try:
                with transaction.atomic():
                    list(Board.objects.filter(pk=board.pk).select_for_update().values_list("pk", flat=True))
                    holding.set()
                    release.wait(10)
            except BaseException as exc:  # noqa: BLE001 - surfaced after join
                errors.append(exc)
            finally:
                connections.close_all()

        def patcher(name, d):
            try:
                holding.wait(10)
                client = APIClient()
                client.force_authenticate(admin)
                with patch("boards.broadcast.broadcast_board_event"):
                    results[name] = client.patch(
                        f"/api/v1/boards/{board.id}/swimlane-custom-fields/{d.id}/",
                        {"band_visibility": "band"}, format="json",
                    ).status_code
            except BaseException as exc:  # noqa: BLE001 - surfaced after join
                errors.append(exc)
            finally:
                connections.close_all()

        t_hold = threading.Thread(target=holder, name="hold-2439")
        t_b = threading.Thread(target=patcher, args=("b", b), name="patch-b-2439")
        t_c = threading.Thread(target=patcher, args=("c", c), name="patch-c-2439")
        t_hold.start()
        t_b.start()
        t_c.start()
        try:
            assert_blocked_on_lock(self, t_b, "the PATCH should queue on the board row lock")
        finally:
            release.set()
            for t in (t_hold, t_b, t_c):
                t.join(30)
        self.assertEqual(errors, [])
        self.assertEqual(sorted(results.values()), [200, 400])
        self.assertEqual(
            SwimlaneCustomFieldDefinition.objects.filter(board=board, band_visibility="band").count(), 2
        )
