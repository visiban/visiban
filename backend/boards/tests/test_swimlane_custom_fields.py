"""Per-board typed swimlane (row) custom fields (#1140).

The row-level counterpart to ``test_custom_fields.py``, grouped the same way by
the thing that can break:

* ``SwimlaneCustomFieldDefinitionCrudTests`` — the schema endpoint's happy paths.
* ``SwimlaneCustomFieldDefinitionRbacTests`` — who may read vs. write the
  schema, and the cross-board isolation that keeps a board admin out of another
  board's fields.
* ``SwimlaneCustomFieldValueWriteTests`` — per-type validation and the value
  write path through the swimlane endpoint.
* ``SwimlaneCustomFieldImmutabilityTests`` — the #1121 trap: ``field_type`` is
  frozen once any row holds a value. Enforced, not documented.
* ``SwimlaneCustomFieldCapTests`` — the two per-board caps, re-derived for
  swimlane cardinality rather than copied from the card model.
* ``SwimlaneCustomFieldVisibilityTests`` — ``is_admin_only``, which is the
  whole security surface of this feature. Covers the REST read paths, the
  WebSocket payload, and the anonymous share endpoint.
* ``SwimlaneCustomFieldExportTests``, ``SwimlaneCustomFieldBroadcastTests``,
  ``SwimlaneCustomFieldExtensionPointTests``, ``SwimlaneCustomFieldQueryCountTests``.
* ``SwimlaneCustomFieldReorderSchemaTests`` — the documented ``reorder`` response
  shape matches what the endpoint sends.
"""

import json
from unittest.mock import patch

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from drf_spectacular.generators import SchemaGenerator
from rest_framework import status
from rest_framework.test import APIClient

from boards import hooks
from boards.models import (
    BoardMembership, Swimlane, SwimlaneCustomFieldDefinition,
    SwimlaneCustomFieldValue,
)
from boards.serializers import (
    PublicSwimlaneSerializer, SwimlaneAdminSerializer, SwimlaneSerializer,
)
from boards.signals import swimlane_custom_field_value_changed
from boards.tests.conftest import (
    _make_board, _make_card, _make_column, _make_membership, _make_swimlane,
    _make_user,
)

T = SwimlaneCustomFieldDefinition.FieldType


def _definition(board, name="Region", field_type=T.TEXT, position=0, **kwargs):
    kwargs.setdefault("is_admin_only", False)
    return SwimlaneCustomFieldDefinition.objects.create(
        board=board, name=name, field_type=field_type, position=position, **kwargs
    )


class SwimlaneCustomFieldTestBase(TestCase):
    """A board with an admin, a member and a viewer, plus one swimlane."""

    def setUp(self):
        self._broadcast_patcher = patch("boards.broadcast.broadcast_board_event")
        self.broadcast = self._broadcast_patcher.start()

        self.admin = _make_user("scf_admin")
        self.board = _make_board(self.admin, name="SCF Board")
        self.column = _make_column(self.board, "Todo", 0, allow_card_creation=True)
        self.lane = _make_swimlane(self.board, "Acme Corp", 0)
        self.card = _make_card(self.column, self.lane, title="Renew the contract")

        self.member = _make_user("scf_member")
        _make_membership(self.board, self.member, role=BoardMembership.Role.MEMBER)
        self.viewer = _make_user("scf_viewer")
        _make_membership(self.board, self.viewer, role=BoardMembership.Role.VIEWER)

        self.client = APIClient()
        self.client.force_authenticate(self.admin)

        self.url = f"/api/v1/boards/{self.board.id}/swimlane-custom-fields/"
        self.lane_url = f"/api/v1/boards/{self.board.id}/swimlanes/{self.lane.id}/"

    def tearDown(self):
        self._broadcast_patcher.stop()

    def _client_for(self, user):
        client = APIClient()
        client.force_authenticate(user)
        return client


class SwimlaneCustomFieldDefinitionCrudTests(SwimlaneCustomFieldTestBase):
    def test_create_assigns_position_and_returns_the_definition(self):
        r = self.client.post(self.url, {"name": "Region", "field_type": "text"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertEqual(r.data["name"], "Region")
        self.assertEqual(r.data["position"], 0)
        # Ships closed: a caller that does not mention is_admin_only gets the
        # protective default, not the permissive one.
        self.assertTrue(r.data["is_admin_only"])

    def test_positions_append(self):
        self.client.post(self.url, {"name": "Region"}, format="json")
        r = self.client.post(self.url, {"name": "Tier"}, format="json")
        self.assertEqual(r.data["position"], 1)

    def test_dropdown_requires_choices(self):
        r = self.client.post(
            self.url, {"name": "Tier", "field_type": "dropdown"}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("choices", r.data)

    def test_choices_on_a_non_dropdown_are_rejected_not_discarded(self):
        r = self.client.post(
            self.url,
            {"name": "Region", "field_type": "text", "choices": ["EMEA"]},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_duplicate_name_is_a_400_not_a_500(self):
        self.client.post(self.url, {"name": "Region"}, format="json")
        r = self.client.post(self.url, {"name": "Region"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("name", r.data)

    def test_a_row_field_may_share_a_name_with_a_card_field(self):
        """The two sets are independent, so "Owner" on both is legal.

        This is the reason the CSV export cannot reuse the ``Custom: `` prefix
        for row fields — the two columns would collide.
        """
        from boards.models import CustomFieldDefinition

        CustomFieldDefinition.objects.create(board=self.board, name="Owner")
        r = self.client.post(self.url, {"name": "Owner"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)

    def test_reorder_rewrites_positions(self):
        a = _definition(self.board, name="A", position=0)
        b = _definition(self.board, name="B", position=1)
        c = _definition(self.board, name="C", position=2)
        r = self.client.post(
            f"{self.url}reorder/", {"order": [c.id, a.id, b.id]}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual([d["name"] for d in r.data], ["C", "A", "B"])

    def test_delete_cascades_to_values(self):
        definition = _definition(self.board)
        SwimlaneCustomFieldValue.objects.create(
            swimlane=self.lane, field_definition=definition, value="EMEA"
        )
        r = self.client.delete(f"{self.url}{definition.id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(SwimlaneCustomFieldValue.objects.exists())

    def test_deleting_a_swimlane_cascades_to_its_values(self):
        definition = _definition(self.board)
        SwimlaneCustomFieldValue.objects.create(
            swimlane=self.lane, field_definition=definition, value="EMEA"
        )
        self.lane.cards.all().delete()
        self.lane.delete()
        self.assertFalse(SwimlaneCustomFieldValue.objects.exists())

    def test_a_non_numeric_id_is_a_404_not_a_500(self):
        r = self.client.get(f"{self.url}not-a-number/")
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)


class SwimlaneCustomFieldDefinitionRbacTests(SwimlaneCustomFieldTestBase):
    def setUp(self):
        super().setUp()
        self.definition = _definition(self.board, name="Region")

    def test_viewer_may_read_the_schema(self):
        """A viewer must be able to see the schema behind values they can read.

        This is the *schema*, not the values — which values a role may read is
        decided per definition by is_admin_only, tested separately.
        """
        r = self._client_for(self.viewer).get(self.url)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual([d["name"] for d in r.data["results"]], ["Region"])

    def test_member_may_read_the_schema(self):
        r = self._client_for(self.member).get(self.url)
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_member_may_not_create(self):
        r = self._client_for(self.member).post(self.url, {"name": "Tier"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_viewer_may_not_create(self):
        r = self._client_for(self.viewer).post(self.url, {"name": "Tier"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_member_may_not_update_or_delete(self):
        client = self._client_for(self.member)
        detail = f"{self.url}{self.definition.id}/"
        self.assertEqual(
            client.patch(detail, {"name": "X"}, format="json").status_code,
            status.HTTP_403_FORBIDDEN,
        )
        self.assertEqual(client.delete(detail).status_code, status.HTTP_403_FORBIDDEN)

    def test_member_may_not_reorder(self):
        r = self._client_for(self.member).post(
            f"{self.url}reorder/", {"order": [self.definition.id]}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_anonymous_is_rejected(self):
        self.assertEqual(
            APIClient().get(self.url).status_code, status.HTTP_401_UNAUTHORIZED
        )

    def test_a_non_member_cannot_reach_the_board(self):
        outsider = _make_user("scf_outsider")
        r = self._client_for(outsider).get(self.url)
        self.assertIn(
            r.status_code, (status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND)
        )

    def test_a_definition_from_another_board_is_a_404(self):
        """IDOR: the queryset is board-scoped, so a foreign id is not found.

        A 404 rather than a 403 deliberately: a 403 would confirm the id exists
        on some board the caller cannot see.
        """
        other_board = _make_board(self.admin, name="Other")
        foreign = _definition(other_board, name="Foreign")
        r = self.client.get(f"{self.url}{foreign.id}/")
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)

    def test_reorder_silently_ignores_a_foreign_id(self):
        other_board = _make_board(self.admin, name="Other")
        foreign = _definition(other_board, name="Foreign", position=0)
        r = self.client.post(
            f"{self.url}reorder/",
            {"order": [self.definition.id, foreign.id]},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        foreign.refresh_from_db()
        self.assertEqual(foreign.position, 0)


class SwimlaneCustomFieldValueWriteTests(SwimlaneCustomFieldTestBase):
    """Per-type validation, written through the swimlane endpoint."""

    def _patch_value(self, definition, value, client=None):
        return (client or self.client).patch(
            self.lane_url,
            {"custom_field_values": [
                {"field_definition": definition.id, "value": value}
            ]},
            format="json",
        )

    def test_text_value_round_trips(self):
        definition = _definition(self.board, name="Region")
        r = self._patch_value(definition, "EMEA")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(
            r.data["custom_field_values"],
            [{"field_definition": definition.id, "value": "EMEA"}],
        )

    def test_number_rejects_non_numeric(self):
        definition = _definition(self.board, name="ARR", field_type=T.NUMBER)
        self.assertEqual(
            self._patch_value(definition, "lots").status_code,
            status.HTTP_400_BAD_REQUEST,
        )

    def test_number_rejects_infinity(self):
        definition = _definition(self.board, name="ARR", field_type=T.NUMBER)
        self.assertEqual(
            self._patch_value(definition, "Infinity").status_code,
            status.HTTP_400_BAD_REQUEST,
        )

    def test_date_requires_iso_format(self):
        definition = _definition(self.board, name="Renewal", field_type=T.DATE)
        self.assertEqual(
            self._patch_value(definition, "01/02/2026").status_code,
            status.HTTP_400_BAD_REQUEST,
        )
        self.assertEqual(
            self._patch_value(definition, "2026-02-01").status_code,
            status.HTTP_200_OK,
        )

    def test_date_rejects_an_impossible_date(self):
        definition = _definition(self.board, name="Renewal", field_type=T.DATE)
        self.assertEqual(
            self._patch_value(definition, "2026-13-01").status_code,
            status.HTTP_400_BAD_REQUEST,
        )

    def test_checkbox_normalizes_to_true_false(self):
        definition = _definition(self.board, name="Active", field_type=T.CHECKBOX)
        r = self._patch_value(definition, True)
        self.assertEqual(r.data["custom_field_values"][0]["value"], "true")

    def test_dropdown_rejects_a_value_outside_its_choices(self):
        definition = _definition(
            self.board, name="Tier", field_type=T.DROPDOWN,
            choices_json=["Gold", "Silver"],
        )
        self.assertEqual(
            self._patch_value(definition, "Bronze").status_code,
            status.HTTP_400_BAD_REQUEST,
        )
        self.assertEqual(
            self._patch_value(definition, "Gold").status_code, status.HTTP_200_OK
        )

    def test_a_value_over_the_length_cap_is_rejected(self):
        definition = _definition(self.board, name="Notes")
        over = "x" * (SwimlaneCustomFieldDefinition.MAX_VALUE_LENGTH + 1)
        self.assertEqual(
            self._patch_value(definition, over).status_code,
            status.HTTP_400_BAD_REQUEST,
        )

    def test_clearing_a_value_deletes_the_row(self):
        """"Unset" must have exactly one representation: no row."""
        definition = _definition(self.board, name="Region")
        self._patch_value(definition, "EMEA")
        self.assertEqual(SwimlaneCustomFieldValue.objects.count(), 1)
        self._patch_value(definition, "")
        self.assertEqual(SwimlaneCustomFieldValue.objects.count(), 0)

    def test_a_partial_update_does_not_clear_unnamed_fields(self):
        region = _definition(self.board, name="Region", position=0)
        tier = _definition(self.board, name="Tier", position=1)
        self._patch_value(region, "EMEA")
        self._patch_value(tier, "Gold")
        r = self._patch_value(region, "APAC")
        values = {v["field_definition"]: v["value"] for v in r.data["custom_field_values"]}
        self.assertEqual(values[region.id], "APAC")
        self.assertEqual(values[tier.id], "Gold")

    def test_a_definition_from_another_board_is_rejected(self):
        """IDOR on the value write path, not just the schema read path."""
        other_board = _make_board(self.admin, name="Other")
        foreign = _definition(other_board, name="Foreign")
        r = self._patch_value(foreign, "x")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_a_duplicate_field_in_one_payload_is_rejected(self):
        definition = _definition(self.board, name="Region")
        r = self.client.patch(
            self.lane_url,
            {"custom_field_values": [
                {"field_definition": definition.id, "value": "EMEA"},
                {"field_definition": definition.id, "value": "APAC"},
            ]},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_an_oversized_payload_is_rejected_on_length(self):
        definition = _definition(self.board, name="Region")
        payload = [
            {"field_definition": definition.id, "value": "x"}
            for _ in range(SwimlaneCustomFieldDefinition.MAX_PER_BOARD + 1)
        ]
        r = self.client.patch(
            self.lane_url, {"custom_field_values": payload}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_a_member_cannot_write_values(self):
        """Values ride the swimlane write path, which is already admin-gated."""
        definition = _definition(self.board, name="Region")
        r = self._patch_value(definition, "EMEA", client=self._client_for(self.member))
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_values_can_be_set_when_creating_a_swimlane(self):
        definition = _definition(self.board, name="Region")
        r = self.client.post(
            f"/api/v1/boards/{self.board.id}/swimlanes/",
            {
                "name": "Globex",
                "custom_field_values": [
                    {"field_definition": definition.id, "value": "APAC"}
                ],
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        lane = Swimlane.objects.get(name="Globex")
        self.assertEqual(lane.custom_field_values.get().value, "APAC")


class SwimlaneCustomFieldImmutabilityTests(SwimlaneCustomFieldTestBase):
    """#1121's trap, enforced rather than assumed."""

    def setUp(self):
        super().setUp()
        self.definition = _definition(self.board, name="Region", field_type=T.TEXT)
        self.detail = f"{self.url}{self.definition.id}/"

    def test_type_is_editable_while_no_row_holds_a_value(self):
        r = self.client.patch(self.detail, {"field_type": "number"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_type_is_frozen_once_a_row_holds_a_value(self):
        SwimlaneCustomFieldValue.objects.create(
            swimlane=self.lane, field_definition=self.definition, value="EMEA"
        )
        r = self.client.patch(self.detail, {"field_type": "number"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("field_type", r.data)

    def test_resubmitting_the_same_type_is_not_a_change(self):
        """An echo of the current representation must not be a 400."""
        SwimlaneCustomFieldValue.objects.create(
            swimlane=self.lane, field_definition=self.definition, value="EMEA"
        )
        r = self.client.patch(
            self.detail, {"field_type": "text", "name": "Region 2"}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_other_attributes_stay_editable_once_values_exist(self):
        SwimlaneCustomFieldValue.objects.create(
            swimlane=self.lane, field_definition=self.definition, value="EMEA"
        )
        r = self.client.patch(self.detail, {"help_text": "Sales region"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)


class SwimlaneCustomFieldCapTests(SwimlaneCustomFieldTestBase):
    def test_the_field_cap_is_enforced(self):
        for i in range(SwimlaneCustomFieldDefinition.MAX_PER_BOARD):
            _definition(self.board, name=f"F{i}", position=i)
        r = self.client.post(self.url, {"name": "OneTooMany"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_the_cap_is_lower_than_the_card_cap_and_deliberately_so(self):
        """Guards the re-derivation, not the literal.

        The issue explicitly required this cap to be re-derived for swimlane
        cardinality rather than copied from the card model; a later edit that
        "aligns" the two would silently undo that.
        """
        from boards.models import CustomFieldDefinition

        self.assertLess(
            SwimlaneCustomFieldDefinition.MAX_PER_BOARD,
            CustomFieldDefinition.MAX_PER_BOARD,
        )

    def test_the_pin_cap_is_enforced(self):
        for i in range(SwimlaneCustomFieldDefinition.MAX_PINNED_PER_BOARD):
            _definition(self.board, name=f"P{i}", position=i, show_on_row=True)
        r = self.client.post(
            self.url, {"name": "Extra", "show_on_row": True}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("show_on_row", r.data)

    def test_resaving_an_already_pinned_field_does_not_count_itself(self):
        pinned = [
            _definition(self.board, name=f"P{i}", position=i, show_on_row=True)
            for i in range(SwimlaneCustomFieldDefinition.MAX_PINNED_PER_BOARD)
        ]
        r = self.client.patch(
            f"{self.url}{pinned[0].id}/",
            {"show_on_row": True, "help_text": "still pinned"},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_the_card_cap_message_is_unchanged(self):
        """The cap helper was parameterized; its card-level output must not move."""
        from boards.models import CustomFieldDefinition
        from boards.serializers import assert_definition_caps
        from rest_framework import serializers as drf

        for i in range(CustomFieldDefinition.MAX_PER_BOARD):
            CustomFieldDefinition.objects.create(
                board=self.board, name=f"C{i}", position=i
            )
        with self.assertRaises(drf.ValidationError) as ctx:
            assert_definition_caps(self.board)
        self.assertIn("30 custom fields", str(ctx.exception))


class SwimlaneCustomFieldVisibilityTests(SwimlaneCustomFieldTestBase):
    """``is_admin_only`` — the security surface of this feature."""

    def setUp(self):
        super().setUp()
        self.open_field = _definition(
            self.board, name="Region", position=0, is_admin_only=False
        )
        self.secret_field = _definition(
            self.board, name="ARR", position=1, is_admin_only=True
        )
        SwimlaneCustomFieldValue.objects.create(
            swimlane=self.lane, field_definition=self.open_field, value="EMEA"
        )
        SwimlaneCustomFieldValue.objects.create(
            swimlane=self.lane, field_definition=self.secret_field, value="250000"
        )

    def test_is_admin_only_defaults_to_true_on_the_model(self):
        """The protective default is not symmetrically reversible — pin it."""
        definition = SwimlaneCustomFieldDefinition.objects.create(
            board=self.board, name="Unspecified", position=9
        )
        self.assertTrue(definition.is_admin_only)

    def test_admin_sees_every_value(self):
        r = self.client.get(self.lane_url)
        values = {v["field_definition"] for v in r.data["custom_field_values"]}
        self.assertEqual(values, {self.open_field.id, self.secret_field.id})

    def test_viewer_sees_only_the_open_field(self):
        r = self._client_for(self.viewer).get(self.lane_url)
        values = {v["field_definition"] for v in r.data["custom_field_values"]}
        self.assertEqual(values, {self.open_field.id})
        self.assertNotIn("250000", str(r.data))

    def test_member_sees_only_the_open_field(self):
        r = self._client_for(self.member).get(self.lane_url)
        self.assertNotIn("250000", str(r.data))

    def test_board_full_respects_the_flag_for_a_viewer(self):
        r = self._client_for(self.viewer).get(f"/api/v1/boards/{self.board.id}/full/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertNotIn("250000", str(r.data["swimlanes"]))
        self.assertIn("EMEA", str(r.data["swimlanes"]))

    def test_board_full_carries_the_row_field_schema(self):
        r = self.client.get(f"/api/v1/boards/{self.board.id}/full/")
        self.assertEqual(
            [d["name"] for d in r.data["swimlane_custom_field_definitions"]],
            ["Region", "ARR"],
        )

    def test_the_public_swimlane_serializer_omits_values_entirely(self):
        """Structural omission, not a flag — no flag can be set wrong."""
        self.assertNotIn("custom_field_values", PublicSwimlaneSerializer().fields)

    def test_the_public_share_endpoint_returns_no_row_field_data(self):
        r = self.client.post(f"/api/v1/boards/{self.board.id}/share/")
        token = r.data["share_token"]
        anon = APIClient()
        r = anon.get(f"/api/share/{token}/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        body = str(r.data)
        self.assertNotIn("custom_field_values", body)
        self.assertNotIn("EMEA", body)
        self.assertNotIn("250000", body)

    def test_both_swimlane_serializers_expose_the_field(self):
        self.assertIn("custom_field_values", SwimlaneSerializer().fields)
        self.assertIn("custom_field_values", SwimlaneAdminSerializer().fields)


class SwimlaneCustomFieldBroadcastTests(SwimlaneCustomFieldTestBase):
    """The WS payload must never carry an admin-only value."""

    def setUp(self):
        super().setUp()
        self.open_field = _definition(
            self.board, name="Region", position=0, is_admin_only=False
        )
        self.secret_field = _definition(
            self.board, name="ARR", position=1, is_admin_only=True
        )

    def _last_payload(self):
        """The payload of the most recent publish.

        ``record_board_event`` defers the publish with ``transaction.on_commit``,
        which never runs inside a ``TestCase``'s wrapping transaction — callers
        must drive it with ``captureOnCommitCallbacks(execute=True)`` first.
        """
        self.assertTrue(self.broadcast.called)
        return self.broadcast.call_args[0][2]

    def test_an_admin_only_value_is_not_broadcast(self):
        """Every swimlane broadcast is built from the public serializer.

        The board channel is shared by every role, so a payload built from the
        admin serializer would hand an admin-only value straight to a connected
        viewer. Same rule contact_email and notes have always followed.
        """
        with self.captureOnCommitCallbacks(execute=True):
            self.client.patch(
                self.lane_url,
                {"custom_field_values": [
                    {"field_definition": self.secret_field.id, "value": "250000"},
                    {"field_definition": self.open_field.id, "value": "EMEA"},
                ]},
                format="json",
            )
        payload = json.dumps(self._last_payload())
        self.assertIn("EMEA", payload)
        self.assertNotIn("250000", payload)

    def test_an_admin_only_value_is_not_broadcast_on_create_either(self):
        """The create path builds its payload the same way — prove it.

        Both paths go through _refetch_swimlane + SwimlaneSerializer, so this
        is coverage parity rather than a second mechanism: without it, a future
        change to perform_create alone could start leaking and only the update
        path would be guarded.
        """
        with self.captureOnCommitCallbacks(execute=True):
            r = self.client.post(
                f"/api/v1/boards/{self.board.id}/swimlanes/",
                {
                    "name": "Globex",
                    "custom_field_values": [
                        {"field_definition": self.secret_field.id, "value": "250000"},
                        {"field_definition": self.open_field.id, "value": "EMEA"},
                    ],
                },
                format="json",
            )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        payload = json.dumps(self._last_payload())
        self.assertIn("EMEA", payload)
        self.assertNotIn("250000", payload)

    def test_the_swimlane_payload_keeps_omitting_pii(self):
        """Regression guard: the payload still must not carry contact_email."""
        with self.captureOnCommitCallbacks(execute=True):
            self.client.patch(
                self.lane_url, {"contact_email": "ops@acme.test"}, format="json"
            )
        payload = json.dumps(self._last_payload())
        self.assertNotIn("ops@acme.test", payload)

    def test_definition_crud_broadcasts_are_recorded_as_board_events(self):
        """record_board_event, not the bare on_commit idiom.

        The difference is observable: record_board_event persists a BoardEvent
        row, which is what makes the event resumable through the events feed.
        """
        from boards.models import BoardEvent

        before = BoardEvent.objects.count()
        r = self.client.post(self.url, {"name": "Tier"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertEqual(BoardEvent.objects.count(), before + 1)
        self.assertEqual(
            BoardEvent.objects.latest("id").event, "swimlane_custom_field.created"
        )

    def test_every_new_event_name_is_on_the_board_channel_contract(self):
        from boards import broadcast

        for name in (
            broadcast.EVT_SWIMLANE_CUSTOM_FIELD_CREATED,
            broadcast.EVT_SWIMLANE_CUSTOM_FIELD_UPDATED,
            broadcast.EVT_SWIMLANE_CUSTOM_FIELD_DELETED,
            broadcast.EVT_SWIMLANE_CUSTOM_FIELD_REORDERED,
        ):
            self.assertIn(name, broadcast.BOARD_CHANNEL_EVENTS)


class SwimlaneCustomFieldExtensionPointTests(SwimlaneCustomFieldTestBase):
    """The signal and the validator hooks — both consumed by enterprise."""

    def setUp(self):
        super().setUp()
        self.definition = _definition(self.board, name="Region")

    def _patch_value(self, value):
        return self.client.patch(
            self.lane_url,
            {"custom_field_values": [
                {"field_definition": self.definition.id, "value": value}
            ]},
            format="json",
        )

    def test_the_signal_fires_on_a_real_change(self):
        received = []

        def receiver(sender, **kwargs):
            received.append(kwargs)

        swimlane_custom_field_value_changed.connect(receiver)
        try:
            self._patch_value("EMEA")
        finally:
            swimlane_custom_field_value_changed.disconnect(receiver)

        self.assertEqual(len(received), 1)
        self.assertEqual(received[0]["swimlane"], self.lane)
        self.assertEqual(received[0]["field_definition"], self.definition)
        self.assertEqual(received[0]["old_value"], "")
        self.assertEqual(received[0]["new_value"], "EMEA")
        self.assertEqual(received[0]["actor"], self.admin)

    def test_the_signal_does_not_fire_on_an_echo(self):
        """A client echoing the representation it was given is not an edit."""
        self._patch_value("EMEA")
        received = []

        def receiver(sender, **kwargs):
            received.append(kwargs)

        swimlane_custom_field_value_changed.connect(receiver)
        try:
            self._patch_value("EMEA")
        finally:
            swimlane_custom_field_value_changed.disconnect(receiver)
        self.assertEqual(received, [])

    def test_the_card_signal_does_not_fire_for_a_row_change(self):
        """The two signals are separate so enterprise receivers cannot be
        handed a row event with card=None."""
        from boards.signals import custom_field_value_changed

        received = []

        def receiver(sender, **kwargs):
            received.append(kwargs)

        custom_field_value_changed.connect(receiver)
        try:
            self._patch_value("EMEA")
        finally:
            custom_field_value_changed.disconnect(receiver)
        self.assertEqual(received, [])

    def test_a_validator_hook_can_reject_a_row_value(self):
        def reject(definition, value):
            if value == "MARS":
                raise DjangoValidationError("Off-world regions are not supported.")
            return None

        with patch.object(hooks, "SWIMLANE_CUSTOM_FIELD_VALIDATORS", [reject]):
            r = self._patch_value("MARS")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_a_validator_hook_can_rewrite_a_row_value(self):
        def upper(definition, value):
            return value.upper() or None

        with patch.object(hooks, "SWIMLANE_CUSTOM_FIELD_VALIDATORS", [upper]):
            r = self._patch_value("emea")
        self.assertEqual(r.data["custom_field_values"][0]["value"], "EMEA")


class SwimlaneCustomFieldExportTests(SwimlaneCustomFieldTestBase):
    def setUp(self):
        super().setUp()
        self.open_field = _definition(
            self.board, name="Region", position=0, is_admin_only=False
        )
        self.secret_field = _definition(
            self.board, name="ARR", position=1, is_admin_only=True
        )
        SwimlaneCustomFieldValue.objects.create(
            swimlane=self.lane, field_definition=self.open_field, value="EMEA"
        )
        SwimlaneCustomFieldValue.objects.create(
            swimlane=self.lane, field_definition=self.secret_field, value="250000"
        )
        self.export_url = f"/api/v1/boards/{self.board.id}/export/"

    def test_csv_uses_a_distinct_header_prefix(self):
        r = self.client.get(self.export_url)
        header = r.content.decode().splitlines()[0]
        self.assertIn("Swimlane Custom: Region", header)
        # The card-field namespace must not be reused — a board may define a
        # card field and a row field with the same name.
        self.assertNotIn("Custom: Region,", header.replace("Swimlane Custom: Region", ""))

    def test_csv_denormalizes_the_value_onto_the_card_row(self):
        r = self.client.get(self.export_url)
        body = r.content.decode()
        self.assertIn("EMEA", body)

    def test_csv_withholds_an_admin_only_column_from_a_member(self):
        r = self._client_for(self.member).get(self.export_url)
        if r.status_code != status.HTTP_200_OK:
            self.skipTest("board export is admin-restricted in this configuration")
        body = r.content.decode()
        self.assertNotIn("Swimlane Custom: ARR", body)
        self.assertNotIn("250000", body)

    def test_json_export_carries_the_schema_and_the_values(self):
        r = self.client.get(f"{self.export_url}?format=json")
        payload = json.loads(r.content.decode())
        self.assertEqual(
            [f["name"] for f in payload["swimlane_custom_fields"]], ["Region", "ARR"]
        )
        self.assertEqual(
            payload["swimlanes"][0]["custom_field_values"],
            {"Region": "EMEA", "ARR": "250000"},
        )

    def test_json_export_keys_values_by_name_not_id(self):
        """An export is read by people and other tools; PKs mean nothing there."""
        r = self.client.get(f"{self.export_url}?format=json")
        payload = json.loads(r.content.decode())
        self.assertIn("Region", payload["swimlanes"][0]["custom_field_values"])


class SwimlaneCustomFieldQueryCountTests(SwimlaneCustomFieldTestBase):
    """The serializer reads is_admin_only off each value's definition, so an
    unprefetched read path is 1 + 2N in swimlane count."""

    def setUp(self):
        super().setUp()
        definitions = [
            _definition(self.board, name=f"F{i}", position=i, is_admin_only=False)
            for i in range(3)
        ]
        for i in range(6):
            lane = _make_swimlane(self.board, f"Lane {i}", i + 1)
            for definition in definitions:
                SwimlaneCustomFieldValue.objects.create(
                    swimlane=lane, field_definition=definition, value=f"v{i}"
                )

    def test_listing_swimlanes_does_not_scale_queries_with_row_count(self):
        url = f"/api/v1/boards/{self.board.id}/swimlanes/"
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(url)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        baseline = len(ctx.captured_queries)

        for i in range(6):
            lane = _make_swimlane(self.board, f"Extra {i}", 100 + i)
            SwimlaneCustomFieldValue.objects.create(
                swimlane=lane,
                field_definition=self.board.swimlane_custom_field_definitions.first(),
                value="x",
            )
        with CaptureQueriesContext(connection) as ctx:
            self.client.get(url)
        self.assertEqual(len(ctx.captured_queries), baseline)

    def test_csv_export_does_not_scale_queries_with_card_count(self):
        """The export denormalizes row values onto every card row.

        That makes it the one loop in this feature where a dropped prefetch
        costs a query *per card* rather than per swimlane, so it gets its own
        guard rather than relying on the two read-path tests above — those
        would stay green while the export regressed.
        """
        url = f"/api/v1/boards/{self.board.id}/export/"
        column = self.board.columns.first()
        lane = self.board.swimlanes.first()
        for i in range(3):
            _make_card(column, lane, title=f"Export card {i}")
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(url)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        baseline = len(ctx.captured_queries)

        for i in range(8):
            _make_card(column, lane, title=f"Extra export card {i}")
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(url)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(len(ctx.captured_queries), baseline)

    def test_board_full_does_not_scale_queries_with_row_count(self):
        url = f"/api/v1/boards/{self.board.id}/full/"
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(url)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        baseline = len(ctx.captured_queries)

        for i in range(6):
            lane = _make_swimlane(self.board, f"Extra {i}", 100 + i)
            SwimlaneCustomFieldValue.objects.create(
                swimlane=lane,
                field_definition=self.board.swimlane_custom_field_definitions.first(),
                value="x",
            )
        with CaptureQueriesContext(connection) as ctx:
            self.client.get(url)
        self.assertEqual(len(ctx.captured_queries), baseline)


class SwimlaneCustomFieldReorderSchemaTests(SwimlaneCustomFieldTestBase):
    """`reorder` returns a bare array, so the schema must not promise a paginated envelope.

    The global paginator wraps any ``many=True`` response in
    ``{count, results, ...}`` in the generated schema. ``reorder`` never
    paginates, so without ``pagination_class=None`` a client generated from the
    schema expects an object and chokes on the array the endpoint sends —
    caught by the ``backend-schema-fuzz`` job.
    """

    PATH = "/api/v1/boards/{board_pk}/swimlane-custom-fields/reorder/"

    def test_documented_response_is_an_array_for_put_and_post(self):
        paths = SchemaGenerator().get_schema(request=None, public=True)["paths"]
        for method in ("put", "post"):
            schema = paths[self.PATH][method]["responses"]["200"]["content"][
                "application/json"
            ]["schema"]
            self.assertEqual(schema["type"], "array", method)
            self.assertEqual(
                schema["items"]["$ref"],
                "#/components/schemas/SwimlaneCustomFieldDefinition",
                method,
            )

    def test_empty_body_returns_a_bare_array_over_both_methods(self):
        _definition(self.board, name="A", position=0)
        for method in (self.client.put, self.client.post):
            r = method(f"{self.url}reorder/", {}, format="json")
            self.assertEqual(r.status_code, status.HTTP_200_OK)
            self.assertIsInstance(r.json(), list)
            self.assertEqual([d["name"] for d in r.json()], ["A"])

