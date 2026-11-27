"""Per-dimension changed-at on the card payload (#2651).

``dimension_states`` reports, per dimension field with a value, when that
value last really changed. It is read from ``CustomFieldValue.value_changed_at``
(no query of its own), stamped only on a real change, backfilled from
``CardActivity`` by migration 0152, and carried by JSON export and import.
"""

import datetime
import importlib
import io
import json
from unittest import mock

from django.apps import apps as django_apps
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Card, CardActivity, Column, CustomFieldDefinition, CustomFieldValue, Swimlane
from boards.serializers import ParkedDimensionStateListSerializer
from boards.tests.conftest import _make_board
from boards.views.import_export import BoardExportThrottle, BoardImportThrottle, _imported_value_changed_at

_OLD = timezone.make_aware(datetime.datetime(2026, 1, 5, 9, 0))


class _Base(TestCase):
    def setUp(self):
        patcher = mock.patch("boards.broadcast.broadcast_board_event")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = APIClient()
        self.admin = User.objects.create_user(username="admin2651", password="pass")
        self.client.force_authenticate(self.admin)
        self.board = _make_board(self.admin)
        self.col = Column.objects.create(board=self.board, name="Backlog", position=0)
        self.lane = Swimlane.objects.create(board=self.board, name="Lane", position=0)
        self.card = self._card("C")
        self.dim = CustomFieldDefinition.objects.create(
            board=self.board, name="Security", field_type="dropdown",
            choices_json=["Pending", "Approved"], is_dimension=True,
            choice_resolutions={"Approved": "satisfied"}, position=0,
        )
        self.plain = CustomFieldDefinition.objects.create(
            board=self.board, name="Notes", field_type="text", position=1,
        )

    def _card(self, title):
        return Card.objects.create(
            board=self.board, column=self.col, swimlane=self.lane, title=title,
            created_by=self.admin, position=0,
        )

    def patch_values(self, *pairs, card=None):
        card = card or self.card
        body = {"custom_field_values": [{"field_definition": d.pk, "value": v} for d, v in pairs]}
        resp = self.client.patch(f"/api/v1/boards/{self.board.pk}/cards/{card.pk}/", body, format="json")
        self.assertEqual(resp.status_code, 200, resp.data)
        return resp.data


class DimensionStatesPayloadTests(_Base):
    def test_setting_a_dimension_stamps_changed_at_and_only_dimensions_are_listed(self):
        before = timezone.now()
        data = self.patch_values((self.dim, "Pending"), (self.plain, "hello"))
        self.assertEqual([s["field_id"] for s in data["dimension_states"]], [self.dim.pk])
        row = CustomFieldValue.objects.get(card=self.card, field_definition=self.dim)
        self.assertGreaterEqual(row.value_changed_at, before)
        self.assertEqual(
            datetime.datetime.fromisoformat(data["dimension_states"][0]["changed_at"].replace("Z", "+00:00")),
            row.value_changed_at,
        )

    def test_resaving_the_same_value_keeps_the_clock(self):
        self.patch_values((self.dim, "Pending"))
        CustomFieldValue.objects.filter(field_definition=self.dim).update(value_changed_at=_OLD)
        self.patch_values((self.dim, "Pending"))
        self.assertEqual(CustomFieldValue.objects.get(field_definition=self.dim).value_changed_at, _OLD)

    def test_a_real_change_moves_the_clock(self):
        self.patch_values((self.dim, "Pending"))
        CustomFieldValue.objects.filter(field_definition=self.dim).update(value_changed_at=_OLD)
        self.patch_values((self.dim, "Approved"))
        self.assertGreater(CustomFieldValue.objects.get(field_definition=self.dim).value_changed_at, _OLD)

    def test_clearing_removes_the_entry(self):
        self.patch_values((self.dim, "Pending"))
        data = self.patch_values((self.dim, ""))
        self.assertEqual(data["dimension_states"], [])

    def test_unknown_time_reads_null(self):
        CustomFieldValue.objects.create(card=self.card, field_definition=self.dim, value="Pending")
        resp = self.client.get(f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/")
        self.assertEqual(resp.data["dimension_states"], [{"field_id": self.dim.pk, "changed_at": None}])

    def test_swimlane_values_are_never_stamped(self):
        """The shared writer stamps card values only; lane values have no column."""
        from boards.services.custom_fields import apply_swimlane_custom_field_values  # noqa: PLC0415
        from boards.models import SwimlaneCustomFieldDefinition  # noqa: PLC0415
        lane_def = SwimlaneCustomFieldDefinition.objects.create(
            board=self.board, name="Region", field_type="text", position=0,
        )
        changed = apply_swimlane_custom_field_values(swimlane=self.lane, pairs=[(lane_def, "EU")])
        self.assertEqual(changed, [lane_def])

    def test_cold_read_without_the_prefetch_still_filters_to_dimensions(self):
        CustomFieldValue.objects.create(card=self.card, field_definition=self.dim, value="Pending", value_changed_at=_OLD)
        CustomFieldValue.objects.create(card=self.card, field_definition=self.plain, value="x")
        card = Card.objects.get(pk=self.card.pk)
        rows = ParkedDimensionStateListSerializer(child=mock.Mock()).get_attribute(card)
        self.assertEqual([r.field_definition_id for r in rows], [self.dim.pk])

    def test_board_full_adds_no_query_per_card(self):
        """The field rides the custom_field_values prefetch: more cards, same queries."""
        url = f"/api/v1/boards/{self.board.pk}/full/"
        self.patch_values((self.dim, "Pending"))
        with CaptureQueriesContext(connection) as one:
            first = self.client.get(url)
        for i in range(4):
            self.patch_values((self.dim, "Approved"), card=self._card(f"more {i}"))
        with CaptureQueriesContext(connection) as five:
            resp = self.client.get(url)
        self.assertEqual(len(five), len(one))
        self.assertEqual(first.status_code, 200)
        cards = [c for col in resp.data["columns"] for c in col.get("cards", [])] or resp.data.get("cards", [])
        self.assertTrue(cards)
        for c in cards:
            self.assertEqual([s["field_id"] for s in c["dimension_states"]], [self.dim.pk])

    def test_not_on_the_public_share_payload(self):
        from boards.serializers import PublicCardSerializer  # noqa: PLC0415
        self.assertNotIn("dimension_states", PublicCardSerializer.Meta.fields)


class BackfillMigrationTests(_Base):
    """Migration 0152: newest activity whose field name and new value match."""

    def _activity(self, to_value, at, name="Security", card=None):
        act = CardActivity.objects.create(
            card=card or self.card, event_type=CardActivity.EventType.CUSTOM_FIELD_CHANGED,
            from_value="", to_value=to_value, item_text=name,
        )
        CardActivity.objects.filter(pk=act.pk).update(created_at=at)

    def _run(self):
        module = importlib.import_module("boards.migrations.0152_backfill_value_changed_at")
        module.backfill(django_apps, None)

    def test_picks_the_newest_matching_change_and_leaves_no_history_null(self):
        row = CustomFieldValue.objects.create(card=self.card, field_definition=self.dim, value="Approved")
        other = self._card("No history")
        bare = CustomFieldValue.objects.create(card=other, field_definition=self.dim, value="Approved")
        t1, t2, t3 = (_OLD + datetime.timedelta(days=d) for d in (1, 2, 3))
        self._activity("Approved", t1)
        self._activity("Approved", t2)
        self._activity("Pending", t3)          # newer, but not the stored value
        self._activity("Approved", t3, name="Renamed")  # newer, other field name
        self._run()
        row.refresh_from_db()
        bare.refresh_from_db()
        self.assertEqual(row.value_changed_at, t2)
        self.assertIsNone(bare.value_changed_at)

    def test_never_overwrites_a_stamped_row(self):
        row = CustomFieldValue.objects.create(
            card=self.card, field_definition=self.dim, value="Approved", value_changed_at=_OLD,
        )
        self._activity("Approved", _OLD + datetime.timedelta(days=9))
        self._run()
        row.refresh_from_db()
        self.assertEqual(row.value_changed_at, _OLD)


@mock.patch.object(BoardImportThrottle, "allow_request", return_value=True)
@mock.patch.object(BoardExportThrottle, "allow_request", return_value=True)
class ExportImportChangedAtTests(_Base):
    def test_json_round_trip_keeps_changed_at(self, *_):
        CustomFieldValue.objects.create(
            card=self.card, field_definition=self.dim, value="Pending", value_changed_at=_OLD,
        )
        exported = self.client.get(f"/api/v1/boards/{self.board.pk}/export/?format=json")
        self.assertEqual(exported.status_code, 200)
        data = json.loads(b"".join(exported.streaming_content) if exported.streaming else exported.content)
        card = data["cards"][0]
        self.assertEqual(card["custom_field_values_changed_at"], {"Security": _OLD.isoformat()})
        f = io.BytesIO(json.dumps(data).encode())
        f.name = "board.json"
        resp = self.client.post("/api/v1/boards/import/", {"file": f}, format="multipart")
        self.assertEqual(resp.status_code, 201, resp.data)
        imported = CustomFieldValue.objects.get(card__board_id=resp.data["id"], field_definition__name="Security")
        self.assertEqual(imported.value_changed_at, _OLD)

    def test_future_or_malformed_time_imports_as_unknown(self, *_):
        now = timezone.now()
        self.assertIsNone(_imported_value_changed_at((now + datetime.timedelta(days=1)).isoformat(), now))
        self.assertIsNone(_imported_value_changed_at("not a date", now))
        self.assertIsNone(_imported_value_changed_at(None, now))
        self.assertEqual(_imported_value_changed_at(_OLD.isoformat(), now), _OLD)


@mock.patch.object(BoardImportThrottle, "allow_request", return_value=True)
@mock.patch.object(BoardExportThrottle, "allow_request", return_value=True)
class DimensionPlanExportImportTests2704(_Base):
    """Plans ride JSON export and import; owners resolve like assignees (#2704)."""

    def _export(self):
        exported = self.client.get(f"/api/v1/boards/{self.board.pk}/export/?format=json")
        self.assertEqual(exported.status_code, 200)
        return json.loads(b"".join(exported.streaming_content) if exported.streaming else exported.content)

    def _import(self, data, user=None):
        if user is not None:
            self.client.force_authenticate(user)
        f = io.BytesIO(json.dumps(data).encode())
        f.name = "board.json"
        resp = self.client.post("/api/v1/boards/import/", {"file": f}, format="multipart")
        self.assertEqual(resp.status_code, 201, resp.data)
        from boards.models import CardDimensionPlan  # noqa: PLC0415
        return list(CardDimensionPlan.objects.filter(card__board_id=resp.data["id"]).select_related("owner"))

    def _plan(self, **kw):
        from boards.models import CardDimensionPlan  # noqa: PLC0415
        defaults = {"owner": self.admin, "next_action": "Book review", "target_date": datetime.date(2026, 12, 1)}
        defaults.update(kw)
        return CardDimensionPlan.objects.create(card=self.card, field_definition=self.dim, **defaults)

    def test_export_carries_plans_and_import_restores_them(self, *_):
        self._plan()
        data = self._export()
        self.assertEqual(data["cards"][0]["dimension_plans"], {
            "Security": {"owner": "admin2651", "next_action": "Book review", "target_date": "2026-12-01"},
        })
        (plan,) = self._import(data)
        self.assertEqual((plan.owner, plan.next_action, plan.target_date),
                         (self.admin, "Book review", datetime.date(2026, 12, 1)))
        self.assertEqual(plan.updated_by, self.admin)

    def test_owner_outside_the_importers_pool_imports_unassigned(self, *_):
        self._plan()
        data = self._export()
        outsider = User.objects.create_user(username="outsider2651", password="pass")
        (plan,) = self._import(data, user=outsider)
        self.assertIsNone(plan.owner)
        self.assertEqual(plan.next_action, "Book review")

    def test_malformed_entries_are_dropped(self, *_):
        self._plan()
        data = self._export()
        data["cards"][0]["dimension_plans"] = {
            "Security": {"owner": None, "next_action": "x" * 201, "target_date": None},
            "Notes": {"next_action": "not a dimension"},
            "Nope": {"next_action": "no such field"},
        }
        self.assertEqual(self._import(data), [])
        data["cards"][0]["dimension_plans"] = {"Security": {"next_action": 7, "target_date": "2026-13-45"}}
        self.assertEqual(self._import(data), [])
        data["cards"][0]["dimension_plans"] = {"Security": {"next_action": "", "target_date": "bad"}}
        self.assertEqual(self._import(data), [])
        data["cards"][0]["dimension_plans"] = "junk"
        self.assertEqual(self._import(data), [])
