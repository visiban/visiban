"""Per-board typed custom fields — schema CRUD, values, RBAC, export (#371).

Phase 1 (backend) of #371. The tests are grouped by the thing that can break:

* ``CustomFieldDefinitionCrudTests`` — the schema endpoint's happy paths.
* ``CustomFieldDefinitionRbacTests`` — who may read vs. write the schema, and
  the cross-board isolation that keeps a board admin out of another board's
  fields.
* ``CustomFieldValueWriteTests`` — per-type validation and the value write path
  through ``boards.services.cards.update_card``.
* ``CustomFieldCapTests`` — the two per-board caps.
* ``CustomFieldExposureTests`` — what each serializer does and does **not**
  emit. ``PublicCardSerializer`` excluding values is a security requirement,
  not a preference, and has its own test at both the serializer and the
  endpoint level.
* ``CustomFieldExportTests``, ``CustomFieldBroadcastTests``,
  ``CustomFieldExtensionPointTests``, ``CustomFieldQueryCountTests``.
"""

from unittest.mock import patch

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from rest_framework import status
from rest_framework.test import APIClient

from boards import hooks
from boards.models import (
    BoardMembership, Card, CustomFieldDefinition, CustomFieldValue,
)
from boards.serializers import CardSerializer, PublicCardSerializer
from boards.signals import custom_field_value_changed
from boards.tests.conftest import (
    _make_board, _make_card, _make_column, _make_membership, _make_swimlane,
    _make_user,
)

T = CustomFieldDefinition.FieldType


def _definition(board, name="Array Type", field_type=T.TEXT, position=0, **kwargs):
    return CustomFieldDefinition.objects.create(
        board=board, name=name, field_type=field_type, position=position, **kwargs
    )


class CustomFieldTestBase(TestCase):
    """A board with an admin, a member and a viewer, plus one card."""

    def setUp(self):
        self._broadcast_patcher = patch("boards.broadcast.broadcast_board_event")
        self.broadcast = self._broadcast_patcher.start()

        self.admin = _make_user("cf_admin")
        self.board = _make_board(self.admin, name="CF Board")
        self.column = _make_column(self.board, "Todo", 0, allow_card_creation=True)
        self.lane = _make_swimlane(self.board, "General", 0)
        self.card = _make_card(self.column, self.lane, title="Rack the hypervisors")

        self.member = _make_user("cf_member")
        _make_membership(self.board, self.member, BoardMembership.Role.MEMBER)
        self.viewer = _make_user("cf_viewer")
        _make_membership(self.board, self.viewer, BoardMembership.Role.VIEWER)

        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def tearDown(self):
        self._broadcast_patcher.stop()

    # -- helpers ------------------------------------------------------------

    def _fields_url(self, board=None):
        return f"/api/v1/boards/{(board or self.board).id}/custom-fields/"

    def _field_url(self, definition):
        return f"{self._fields_url(definition.board)}{definition.id}/"

    def _card_url(self, card=None):
        card = card or self.card
        return f"/api/v1/boards/{card.board_id}/cards/{card.id}/"

    def _as(self, user):
        client = APIClient()
        client.force_authenticate(user)
        return client

    def _set_values(self, values, *, user=None, card=None):
        client = self._as(user) if user else self.client
        return client.patch(
            self._card_url(card), {"custom_field_values": values}, format="json"
        )


# ---------------------------------------------------------------------------
# Definition CRUD
# ---------------------------------------------------------------------------

class CustomFieldDefinitionCrudTests(CustomFieldTestBase):
    def test_create_appends_at_the_end_and_returns_the_definition(self):
        _definition(self.board, name="First", position=0)
        r = self.client.post(
            self._fields_url(),
            {"name": "Hypervisors", "field_type": "number", "help_text": "How many?"},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        self.assertEqual(r.data["name"], "Hypervisors")
        self.assertEqual(r.data["field_type"], "number")
        # Position is server-assigned, never client-supplied.
        self.assertEqual(r.data["position"], 1)
        self.assertEqual(r.data["choices"], [])
        self.assertFalse(r.data["show_on_card"])

    def test_position_is_read_only_on_create(self):
        r = self.client.post(
            self._fields_url(),
            {"name": "Ignored position", "field_type": "text", "position": 99},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        self.assertEqual(r.data["position"], 0)

    def test_dropdown_requires_choices(self):
        r = self.client.post(
            self._fields_url(),
            {"name": "Array Type", "field_type": "dropdown"},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("choices", r.data)

    def test_dropdown_choices_must_be_unique_non_empty_strings(self):
        for choices in ([" ", "raid"], ["raid", "raid"], [1, 2]):
            with self.subTest(choices=choices):
                r = self.client.post(
                    self._fields_url(),
                    {"name": f"D{choices}", "field_type": "dropdown", "choices": choices},
                    format="json",
                )
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_non_dropdown_rejects_choices(self):
        r = self.client.post(
            self._fields_url(),
            {"name": "Nope", "field_type": "checkbox", "choices": ["a"]},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("choices", r.data)

    def test_blank_name_is_rejected(self):
        r = self.client.post(
            self._fields_url(), {"name": "   ", "field_type": "text"}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_duplicate_name_on_the_same_board_is_rejected(self):
        _definition(self.board, name="Array Type")
        r = self.client.post(
            self._fields_url(), {"name": "Array Type", "field_type": "text"},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_update_changes_name_and_help_text(self):
        definition = _definition(self.board, name="Old")
        r = self.client.patch(
            self._field_url(definition), {"name": "New", "help_text": "hi"},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        definition.refresh_from_db()
        self.assertEqual(definition.name, "New")
        self.assertEqual(definition.help_text, "hi")

    def test_list_returns_definitions_in_position_order(self):
        _definition(self.board, name="B", position=1)
        _definition(self.board, name="A", position=0)
        r = self.client.get(self._fields_url())
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        # The list endpoint uses the project-wide offset pagination, same as
        # every other ModelViewSet here.
        self.assertEqual([d["name"] for d in r.data["results"]], ["A", "B"])

    def test_reorder_rewrites_positions_without_colliding(self):
        a = _definition(self.board, name="A", position=0)
        b = _definition(self.board, name="B", position=1)
        c = _definition(self.board, name="C", position=2)
        r = self.client.put(
            f"{self._fields_url()}reorder/", {"order": [c.id, a.id, b.id]},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        self.assertEqual([d["name"] for d in r.data], ["C", "A", "B"])
        for row in (a, b, c):
            row.refresh_from_db()
        self.assertEqual((c.position, a.position, b.position), (0, 1, 2))

    def test_reorder_also_accepts_post(self):
        a = _definition(self.board, name="A", position=0)
        b = _definition(self.board, name="B", position=1)
        r = self.client.post(
            f"{self._fields_url()}reorder/", {"order": [b.id, a.id]}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)

    def test_reorder_rejects_a_non_list_order(self):
        r = self.client.put(
            f"{self._fields_url()}reorder/", {"order": "nope"}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_delete_definition_cascades_its_values(self):
        definition = _definition(self.board, name="Array Type")
        CustomFieldValue.objects.create(
            card=self.card, field_definition=definition, value="raid10"
        )
        r = self.client.delete(self._field_url(definition))
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(CustomFieldValue.objects.filter(card=self.card).exists())


# ---------------------------------------------------------------------------
# RBAC and cross-board isolation
# ---------------------------------------------------------------------------

class CustomFieldDefinitionRbacTests(CustomFieldTestBase):
    def test_member_and_viewer_may_read_the_schema(self):
        _definition(self.board, name="Array Type")
        for user in (self.member, self.viewer):
            with self.subTest(user=user.username):
                r = self._as(user).get(self._fields_url())
                self.assertEqual(r.status_code, status.HTTP_200_OK)
                self.assertEqual(len(r.data["results"]), 1)

    def test_non_admin_roles_cannot_create_update_delete_or_reorder(self):
        definition = _definition(self.board, name="Array Type")
        for user in (self.member, self.viewer):
            with self.subTest(user=user.username):
                client = self._as(user)
                self.assertEqual(
                    client.post(
                        self._fields_url(), {"name": "X", "field_type": "text"},
                        format="json",
                    ).status_code,
                    status.HTTP_403_FORBIDDEN,
                )
                self.assertEqual(
                    client.patch(
                        self._field_url(definition), {"name": "Y"}, format="json"
                    ).status_code,
                    status.HTTP_403_FORBIDDEN,
                )
                self.assertEqual(
                    client.put(
                        f"{self._fields_url()}reorder/", {"order": [definition.id]},
                        format="json",
                    ).status_code,
                    status.HTTP_403_FORBIDDEN,
                )
                self.assertEqual(
                    client.delete(self._field_url(definition)).status_code,
                    status.HTTP_403_FORBIDDEN,
                )
        self.assertTrue(
            CustomFieldDefinition.objects.filter(pk=definition.pk).exists()
        )

    def test_a_non_member_cannot_see_the_schema_at_all(self):
        _definition(self.board, name="Array Type")
        outsider = _make_user("cf_outsider")
        r = self._as(outsider).get(self._fields_url())
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_admin_of_another_board_cannot_reach_this_boards_definition(self):
        """IDOR: the definition id is real, the URL's board is not theirs."""
        other_owner = _make_user("cf_other_owner")
        other_board = _make_board(other_owner, name="Other")
        mine = _definition(self.board, name="Array Type")

        client = self._as(other_owner)
        # Addressed through their own board: board-scoped queryset -> 404.
        url = f"/api/v1/boards/{other_board.id}/custom-fields/{mine.id}/"
        self.assertEqual(
            client.patch(url, {"name": "Hijacked"}, format="json").status_code,
            status.HTTP_404_NOT_FOUND,
        )
        self.assertEqual(client.delete(url).status_code, status.HTTP_404_NOT_FOUND)
        # Addressed through the owning board: no access to that board -> 403.
        self.assertEqual(
            client.patch(
                self._field_url(mine), {"name": "Hijacked"}, format="json"
            ).status_code,
            status.HTTP_403_FORBIDDEN,
        )
        mine.refresh_from_db()
        self.assertEqual(mine.name, "Array Type")

    def test_reorder_ignores_ids_from_another_board(self):
        other_owner = _make_user("cf_reorder_other")
        other_board = _make_board(other_owner, name="Other")
        theirs = _definition(other_board, name="Theirs", position=0)
        mine = _definition(self.board, name="Mine", position=0)

        r = self.client.put(
            f"{self._fields_url()}reorder/", {"order": [theirs.id, mine.id]},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        theirs.refresh_from_db()
        self.assertEqual(theirs.position, 0)
        self.assertEqual([d["name"] for d in r.data], ["Mine"])

    def test_member_may_set_values_but_a_viewer_may_not(self):
        definition = _definition(self.board, name="Array Type")
        # The card is created by the member: setting a value is a card edit, so
        # it goes through update_card's ownership gate like any other field.
        # What is being pinned here is the role boundary, not the gate.
        own_card = _make_card(
            self.column, self.lane, title="Member's card",
            created_by=self.member, position=1,
        )
        r = self._set_values(
            [{"field_definition": definition.id, "value": "raid10"}],
            user=self.member, card=own_card,
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)

        r = self._set_values(
            [{"field_definition": definition.id, "value": "raid6"}],
            user=self.viewer, card=own_card,
        )
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(
            CustomFieldValue.objects.get(card=own_card).value, "raid10"
        )

    def test_a_value_cannot_reference_another_boards_definition(self):
        other_owner = _make_user("cf_value_other")
        other_board = _make_board(other_owner, name="Other")
        theirs = _definition(other_board, name="Theirs")

        r = self._set_values([{"field_definition": theirs.id, "value": "x"}])
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(CustomFieldValue.objects.exists())


# ---------------------------------------------------------------------------
# Value writes and per-type validation
# ---------------------------------------------------------------------------

class CustomFieldValueWriteTests(CustomFieldTestBase):
    def setUp(self):
        super().setUp()
        self.text = _definition(self.board, name="Notes", field_type=T.TEXT, position=0)
        self.number = _definition(
            self.board, name="Hypervisors", field_type=T.NUMBER, position=1
        )
        self.date = _definition(
            self.board, name="Installed", field_type=T.DATE, position=2
        )
        self.dropdown = _definition(
            self.board, name="Array Type", field_type=T.DROPDOWN, position=3,
            choices_json=["raid6", "raid10"],
        )
        self.checkbox = _definition(
            self.board, name="Racked", field_type=T.CHECKBOX, position=4
        )

    def test_values_round_trip_on_the_card_body(self):
        r = self._set_values([
            {"field_definition": self.text.id, "value": "two shelves"},
            {"field_definition": self.number.id, "value": "4"},
            {"field_definition": self.date.id, "value": "2026-09-01"},
            {"field_definition": self.dropdown.id, "value": "raid10"},
            {"field_definition": self.checkbox.id, "value": True},
        ])
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        returned = {
            entry["field_definition"]: entry["value"]
            for entry in r.data["custom_field_values"]
        }
        self.assertEqual(returned, {
            self.text.id: "two shelves",
            self.number.id: "4",
            self.date.id: "2026-09-01",
            self.dropdown.id: "raid10",
            self.checkbox.id: "true",
        })

    def test_values_are_ordered_by_definition_position(self):
        self._set_values([
            {"field_definition": self.checkbox.id, "value": "false"},
            {"field_definition": self.text.id, "value": "a"},
        ])
        r = self.client.get(self._card_url())
        self.assertEqual(
            [e["field_definition"] for e in r.data["custom_field_values"]],
            [self.text.id, self.checkbox.id],
        )

    def test_a_partial_write_leaves_the_other_fields_alone(self):
        self._set_values([
            {"field_definition": self.text.id, "value": "keep me"},
            {"field_definition": self.number.id, "value": "4"},
        ])
        self._set_values([{"field_definition": self.number.id, "value": "8"}])
        stored = {
            v.field_definition_id: v.value
            for v in CustomFieldValue.objects.filter(card=self.card)
        }
        self.assertEqual(stored, {self.text.id: "keep me", self.number.id: "8"})

    def test_clearing_a_value_deletes_the_row_rather_than_storing_blank(self):
        self._set_values([{"field_definition": self.text.id, "value": "gone soon"}])
        for blank in ("", None):
            with self.subTest(blank=blank):
                self._set_values(
                    [{"field_definition": self.text.id, "value": "here"}]
                )
                r = self._set_values(
                    [{"field_definition": self.text.id, "value": blank}]
                )
                self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
                self.assertFalse(
                    CustomFieldValue.objects.filter(
                        card=self.card, field_definition=self.text
                    ).exists()
                )
                self.assertEqual(r.data["custom_field_values"], [])

    def test_a_card_with_no_values_reports_an_empty_list(self):
        r = self.client.get(self._card_url())
        self.assertEqual(r.data["custom_field_values"], [])

    def test_values_can_be_set_when_the_card_is_created(self):
        r = self.client.post(
            f"/api/v1/boards/{self.board.id}/cards/",
            {
                "title": "New card",
                "column": self.column.id,
                "swimlane": self.lane.id,
                "custom_field_values": [
                    {"field_definition": self.number.id, "value": "16"}
                ],
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        card = Card.objects.get(title="New card")
        self.assertEqual(
            CustomFieldValue.objects.get(card=card).value, "16"
        )

    def test_number_rejects_non_numeric_and_non_finite_input(self):
        for bad in ("four", "NaN", "Infinity", "1,5"):
            with self.subTest(bad=bad):
                r = self._set_values(
                    [{"field_definition": self.number.id, "value": bad}]
                )
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, bad)
        self.assertFalse(CustomFieldValue.objects.exists())

    def test_number_accepts_negatives_and_decimals(self):
        for good in ("-2", "3.5", "0"):
            with self.subTest(good=good):
                r = self._set_values(
                    [{"field_definition": self.number.id, "value": good}]
                )
                self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
                self.assertEqual(
                    CustomFieldValue.objects.get(field_definition=self.number).value,
                    good,
                )

    def test_date_requires_iso_format(self):
        r = self._set_values([{"field_definition": self.date.id, "value": "01/09/2026"}])
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        r = self._set_values([{"field_definition": self.date.id, "value": "2026-13-01"}])
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_dropdown_rejects_a_value_outside_its_choices(self):
        r = self._set_values(
            [{"field_definition": self.dropdown.id, "value": "raid0"}]
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_a_value_referencing_a_removed_choice_still_reads_but_cannot_be_rewritten(self):
        """Removing a choice does not rewrite history, but does close the door."""
        self._set_values([{"field_definition": self.dropdown.id, "value": "raid6"}])
        self.client.patch(
            self._field_url(self.dropdown), {"choices": ["raid10"]}, format="json"
        )
        r = self.client.get(self._card_url())
        self.assertEqual(
            r.data["custom_field_values"],
            [{"field_definition": self.dropdown.id, "value": "raid6"}],
        )
        # Re-submitting the now-invalid value is refused.
        r = self._set_values(
            [{"field_definition": self.dropdown.id, "value": "raid6"}]
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_checkbox_normalizes_truthy_and_falsy_forms(self):
        for raw, expected in (
            (True, "true"), (False, "false"), ("true", "true"),
            ("False", "false"), ("1", "true"), ("no", "false"),
        ):
            with self.subTest(raw=raw):
                r = self._set_values(
                    [{"field_definition": self.checkbox.id, "value": raw}]
                )
                self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
                self.assertEqual(
                    CustomFieldValue.objects.get(field_definition=self.checkbox).value,
                    expected,
                )

    def test_checkbox_rejects_anything_else(self):
        r = self._set_values([{"field_definition": self.checkbox.id, "value": "maybe"}])
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_a_boolean_is_refused_for_a_non_checkbox_field(self):
        r = self._set_values([{"field_definition": self.text.id, "value": True}])
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_a_value_longer_than_the_cap_is_refused(self):
        too_long = "x" * (CustomFieldDefinition.MAX_VALUE_LENGTH + 1)
        r = self._set_values([{"field_definition": self.text.id, "value": too_long}])
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_malformed_payloads_are_refused(self):
        for payload in ("nope", [{"value": "x"}], [{"field_definition": "abc"}], {}):
            with self.subTest(payload=payload):
                r = self.client.patch(
                    self._card_url(), {"custom_field_values": payload}, format="json"
                )
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_the_same_field_twice_in_one_payload_is_refused(self):
        r = self._set_values([
            {"field_definition": self.text.id, "value": "a"},
            {"field_definition": self.text.id, "value": "b"},
        ])
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_an_unknown_definition_id_is_refused(self):
        r = self._set_values([{"field_definition": 999999, "value": "x"}])
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_a_rejected_value_rolls_the_whole_card_update_back(self):
        """The write runs inside the card service's transaction."""
        r = self.client.patch(
            self._card_url(),
            {
                "title": "Renamed",
                "custom_field_values": [
                    {"field_definition": self.number.id, "value": "not a number"}
                ],
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.card.refresh_from_db()
        self.assertEqual(self.card.title, "Rack the hypervisors")

    def test_setting_a_value_bumps_the_card_version(self):
        before = self.card.version
        self._set_values([{"field_definition": self.text.id, "value": "v"}])
        self.card.refresh_from_db()
        self.assertEqual(self.card.version, before + 1)


# ---------------------------------------------------------------------------
# Caps
# ---------------------------------------------------------------------------

class CustomFieldCapTests(CustomFieldTestBase):
    def test_a_board_cannot_exceed_the_definition_cap(self):
        for i in range(CustomFieldDefinition.MAX_PER_BOARD):
            _definition(self.board, name=f"F{i}", position=i)
        r = self.client.post(
            self._fields_url(), {"name": "One too many", "field_type": "text"},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(
            CustomFieldDefinition.objects.filter(board=self.board).count(),
            CustomFieldDefinition.MAX_PER_BOARD,
        )

    def test_a_board_cannot_pin_more_than_two_fields_to_the_card_face(self):
        for i in range(CustomFieldDefinition.MAX_PINNED_PER_BOARD):
            _definition(self.board, name=f"P{i}", position=i, show_on_card=True)
        r = self.client.post(
            self._fields_url(),
            {"name": "Third pin", "field_type": "text", "show_on_card": True},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("show_on_card", r.data)

    def test_pinning_via_update_is_capped_too(self):
        for i in range(CustomFieldDefinition.MAX_PINNED_PER_BOARD):
            _definition(self.board, name=f"P{i}", position=i, show_on_card=True)
        unpinned = _definition(self.board, name="Later", position=5)
        r = self.client.patch(
            self._field_url(unpinned), {"show_on_card": True}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_resaving_an_already_pinned_field_does_not_count_itself(self):
        pinned = _definition(self.board, name="P0", position=0, show_on_card=True)
        _definition(self.board, name="P1", position=1, show_on_card=True)
        r = self.client.patch(
            self._field_url(pinned),
            {"show_on_card": True, "help_text": "still pinned"},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)

    def test_the_cap_is_per_board_not_global(self):
        for i in range(CustomFieldDefinition.MAX_PER_BOARD):
            _definition(self.board, name=f"F{i}", position=i)
        other_board = _make_board(self.admin, name="Roomy")
        r = self.client.post(
            self._fields_url(other_board), {"name": "Fine", "field_type": "text"},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)


# ---------------------------------------------------------------------------
# Serializer exposure
# ---------------------------------------------------------------------------

class CustomFieldExposureTests(CustomFieldTestBase):
    def setUp(self):
        super().setUp()
        self.definition = _definition(self.board, name="Array Type")
        CustomFieldValue.objects.create(
            card=self.card, field_definition=self.definition, value="raid10"
        )

    def test_card_serializer_exposes_values(self):
        self.assertIn("custom_field_values", CardSerializer().fields)

    def test_public_card_serializer_does_not_expose_values(self):
        """Security requirement: share links are anonymous.

        A custom field is user-defined free-form metadata — it can hold a
        customer name, an internal ticket reference, a price. None of that may
        reach an unauthenticated share-link visitor, and the kill switch for it
        is that the field is simply not on the public serializer.
        """
        self.assertNotIn("custom_field_values", PublicCardSerializer().fields)

    def test_the_public_share_endpoint_returns_no_custom_field_data(self):
        r = self.client.post(f"/api/v1/boards/{self.board.id}/share/")
        token = r.data["share_token"]
        anon = APIClient()
        r = anon.get(f"/api/share/{token}/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        body = str(r.data)
        self.assertNotIn("custom_field", body)
        self.assertNotIn("raid10", body)
        for card in r.data["cards"]:
            self.assertNotIn("custom_field_values", card)

    def test_board_full_carries_the_definition_schema(self):
        r = self.client.get(f"/api/v1/boards/{self.board.id}/full/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(
            [d["name"] for d in r.data["custom_field_definitions"]], ["Array Type"]
        )
        self.assertEqual(
            r.data["cards"][0]["custom_field_values"],
            [{"field_definition": self.definition.id, "value": "raid10"}],
        )

    def test_a_viewer_sees_values_on_the_board(self):
        r = self._as(self.viewer).get(f"/api/v1/boards/{self.board.id}/full/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(
            r.data["cards"][0]["custom_field_values"],
            [{"field_definition": self.definition.id, "value": "raid10"}],
        )

    def test_the_cross_board_card_query_carries_values(self):
        r = self.client.get("/api/v1/cards/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        row = next(c for c in r.data["results"] if c["id"] == self.card.id)
        self.assertEqual(
            row["custom_field_values"],
            [{"field_definition": self.definition.id, "value": "raid10"}],
        )


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

class CustomFieldExportTests(CustomFieldTestBase):
    def setUp(self):
        super().setUp()
        self.array = _definition(
            self.board, name="Array Type", field_type=T.DROPDOWN, position=0,
            choices_json=["raid6", "raid10"],
        )
        self.count = _definition(
            self.board, name="Hypervisors", field_type=T.NUMBER, position=1
        )
        CustomFieldValue.objects.create(
            card=self.card, field_definition=self.array, value="raid10"
        )

    def test_csv_export_appends_one_column_per_definition(self):
        r = self.client.get(f"/api/v1/boards/{self.board.id}/export/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        lines = r.content.decode().splitlines()
        header = lines[0]
        # Appended after the fixed columns, so existing positions are unchanged.
        self.assertTrue(header.endswith("Custom: Array Type,Custom: Hypervisors"))
        self.assertIn("Movement History", header)
        # The card has a value for one field and none for the other.
        self.assertTrue(lines[1].endswith("raid10,"))

    def test_csv_export_sanitizes_a_formula_value(self):
        CustomFieldValue.objects.update_or_create(
            card=self.card, field_definition=self.array,
            defaults={"value": "=cmd|'/c calc'!A1"},
        )
        r = self.client.get(f"/api/v1/boards/{self.board.id}/export/")
        body = r.content.decode()
        # _sanitize_csv_field strips the leading formula characters.
        self.assertNotIn("=cmd", body)
        self.assertIn("cmd|", body)

    def test_json_export_carries_the_schema_and_the_values(self):
        import json

        r = self.client.get(f"/api/v1/boards/{self.board.id}/export/?format=json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        payload = json.loads(r.content.decode())
        self.assertEqual(
            [f["name"] for f in payload["custom_fields"]],
            ["Array Type", "Hypervisors"],
        )
        self.assertEqual(payload["custom_fields"][0]["choices"], ["raid6", "raid10"])
        self.assertEqual(
            payload["cards"][0]["custom_field_values"], {"Array Type": "raid10"}
        )
        # Additive: the schema version is unchanged, so an existing importer
        # keeps working.
        self.assertEqual(payload["schema_version"], 2)


# ---------------------------------------------------------------------------
# Broadcast
# ---------------------------------------------------------------------------

class CustomFieldBroadcastTests(CustomFieldTestBase):
    def _events(self):
        return [call.args[1] for call in self.broadcast.call_args_list]

    def _payload_for(self, event):
        for call in self.broadcast.call_args_list:
            if call.args[1] == event:
                return call.args[2]
        self.fail(f"no {event} broadcast; saw {self._events()}")

    def test_definition_crud_broadcasts_board_events(self):
        with self.captureOnCommitCallbacks(execute=True):
            r = self.client.post(
                self._fields_url(), {"name": "Array Type", "field_type": "text"},
                format="json",
            )
        definition_id = r.data["id"]
        self.assertIn("custom_field.created", self._events())

        with self.captureOnCommitCallbacks(execute=True):
            self.client.patch(
                f"{self._fields_url()}{definition_id}/", {"name": "Renamed"},
                format="json",
            )
        self.assertIn("custom_field.updated", self._events())

        with self.captureOnCommitCallbacks(execute=True):
            self.client.put(
                f"{self._fields_url()}reorder/", {"order": [definition_id]},
                format="json",
            )
        self.assertIn("custom_field.reordered", self._events())

        with self.captureOnCommitCallbacks(execute=True):
            self.client.delete(f"{self._fields_url()}{definition_id}/")
        self.assertEqual(
            set(self._payload_for("custom_field.deleted")), {"custom_field_uid"}
        )

    def test_the_card_updated_broadcast_carries_the_new_values(self):
        definition = _definition(self.board, name="Array Type")
        self.broadcast.reset_mock()
        with self.captureOnCommitCallbacks(execute=True):
            self._set_values([{"field_definition": definition.id, "value": "raid10"}])
        payload = self._payload_for("card.updated")
        self.assertEqual(
            payload["custom_field_values"],
            [{"field_definition": definition.id, "value": "raid10"}],
        )

    def test_broadcasts_are_deferred_until_the_transaction_commits(self):
        """Nothing is broadcast before the transaction commits.

        ``captureOnCommitCallbacks`` collects only callbacks registered with
        ``transaction.on_commit``; a broadcast issued inline would already have
        reached the mock before the block exits. Asserting on the mock both
        before and after the callbacks run is what distinguishes the two.
        """
        definition = _definition(self.board, name="Array Type")
        self.broadcast.reset_mock()
        with self.captureOnCommitCallbacks(execute=True) as callbacks:
            self._set_values([{"field_definition": definition.id, "value": "raid6"}])
            self.assertEqual(self.broadcast.call_count, 0)
        self.assertTrue(callbacks)
        self.assertIn("card.updated", self._events())


# ---------------------------------------------------------------------------
# Extension points
# ---------------------------------------------------------------------------

class CustomFieldExtensionPointTests(CustomFieldTestBase):
    def setUp(self):
        super().setUp()
        self.definition = _definition(self.board, name="Array Type")

    def test_the_change_signal_reports_the_old_and_new_value(self):
        received = []

        def handler(sender, **kwargs):
            received.append(
                (kwargs["field_definition"].pk, kwargs["old_value"],
                 kwargs["new_value"], kwargs["actor"], kwargs["card"].pk)
            )

        custom_field_value_changed.connect(handler)
        try:
            self._set_values(
                [{"field_definition": self.definition.id, "value": "raid6"}]
            )
            self._set_values(
                [{"field_definition": self.definition.id, "value": "raid10"}]
            )
            # An echo of the current value changes nothing and sends nothing.
            self._set_values(
                [{"field_definition": self.definition.id, "value": "raid10"}]
            )
        finally:
            custom_field_value_changed.disconnect(handler)

        self.assertEqual(received, [
            (self.definition.pk, "", "raid6", self.admin, self.card.pk),
            (self.definition.pk, "raid6", "raid10", self.admin, self.card.pk),
        ])

    def test_clearing_a_value_sends_the_change_signal(self):
        received = []
        CustomFieldValue.objects.create(
            card=self.card, field_definition=self.definition, value="raid6"
        )

        def handler(sender, **kwargs):
            received.append((kwargs["old_value"], kwargs["new_value"]))

        custom_field_value_changed.connect(handler)
        try:
            self._set_values([{"field_definition": self.definition.id, "value": ""}])
        finally:
            custom_field_value_changed.disconnect(handler)
        self.assertEqual(received, [("raid6", "")])

    def test_a_registered_validator_can_reject_a_value(self):
        def no_shouting(definition, value):
            if value.isupper():
                raise DjangoValidationError("No shouting.")
            return None

        hooks.CUSTOM_FIELD_VALIDATORS.append(no_shouting)
        try:
            r = self._set_values(
                [{"field_definition": self.definition.id, "value": "RAID10"}]
            )
            self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
            r = self._set_values(
                [{"field_definition": self.definition.id, "value": "raid10"}]
            )
            self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        finally:
            hooks.CUSTOM_FIELD_VALIDATORS.remove(no_shouting)

    def test_a_registered_validator_can_normalize_a_value(self):
        def lowercase(definition, value):
            return value.lower()

        hooks.CUSTOM_FIELD_VALIDATORS.append(lowercase)
        try:
            self._set_values(
                [{"field_definition": self.definition.id, "value": "RAID10"}]
            )
        finally:
            hooks.CUSTOM_FIELD_VALIDATORS.remove(lowercase)
        self.assertEqual(CustomFieldValue.objects.get(card=self.card).value, "raid10")

    def test_oss_behavior_is_unchanged_with_no_validators_registered(self):
        self.assertEqual(hooks.CUSTOM_FIELD_VALIDATORS, [])


# ---------------------------------------------------------------------------
# Query counts
# ---------------------------------------------------------------------------

class CustomFieldQueryCountTests(CustomFieldTestBase):
    """EAV is the N+1 risk the issue itself names. These pin that the read path
    costs a fixed number of queries regardless of how many cards or fields the
    board has."""

    def _full_query_count(self):
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(f"/api/v1/boards/{self.board.id}/full/")
            self.assertEqual(r.status_code, status.HTTP_200_OK)
        return len(ctx.captured_queries)

    def test_board_full_query_count_does_not_grow_with_cards_or_fields(self):
        definitions = [
            _definition(self.board, name=f"F{i}", position=i) for i in range(3)
        ]
        for d in definitions:
            CustomFieldValue.objects.create(
                card=self.card, field_definition=d, value=f"v{d.position}"
            )
        baseline = self._full_query_count()

        for n in range(5):
            card = _make_card(self.column, self.lane, title=f"extra {n}", position=n + 1)
            for d in definitions:
                CustomFieldValue.objects.create(
                    card=card, field_definition=d, value="x"
                )
        self.assertEqual(self._full_query_count(), baseline)
