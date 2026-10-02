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

import csv
import io
import json
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

    def test_nul_byte_in_name_is_a_400_not_a_500(self):
        """Postgres refuses NUL in text/JSON columns (#1184: backend-schema-fuzz

        found this on the swimlane twin of this serializer as an embedded NUL
        in a dropdown choice surfacing as an unhandled 500 DataError; the two
        serializers share the same validation gap).
        """
        r = self.client.post(
            self._fields_url(), {"name": "Arr\x00ay"}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("name", r.data)

    def test_nul_byte_in_help_text_is_a_400_not_a_500(self):
        r = self.client.post(
            self._fields_url(),
            {"name": "Array Type", "help_text": "us\x00e it"},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("help_text", r.data)

    def test_nul_byte_in_a_dropdown_choice_is_a_400_not_a_500(self):
        r = self.client.post(
            self._fields_url(),
            {
                "name": "Array Type",
                "field_type": "dropdown",
                "choices": ["raid", "ra\x00id10"],
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("choices", r.data)

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

    def test_field_type_change_is_rejected_once_a_value_exists(self):
        """#1121: a stale CustomFieldValue must not survive a type change.

        Nothing revalidates or migrates a value against its definition's new
        type, so once a card holds one, the type is frozen — a PATCH that
        would have silently succeeded (and left the value type-mismatched)
        must 400 instead.
        """
        definition = _definition(self.board, name="Notes", field_type=T.TEXT)
        CustomFieldValue.objects.create(
            card=self.card, field_definition=definition,
            value="waiting on legal, see thread",
        )
        r = self.client.patch(
            self._field_url(definition), {"field_type": "number"}, format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)
        self.assertIn("field_type", r.data)
        definition.refresh_from_db()
        self.assertEqual(definition.field_type, T.TEXT)

    def test_field_type_change_succeeds_with_zero_values(self):
        definition = _definition(self.board, name="Notes", field_type=T.TEXT)
        r = self.client.patch(
            self._field_url(definition), {"field_type": "number"}, format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        definition.refresh_from_db()
        self.assertEqual(definition.field_type, T.NUMBER)

    def test_field_type_resubmitted_unchanged_is_not_blocked_by_existing_values(self):
        """A PATCH that happens to echo the current field_type (e.g. a form
        that always sends the full object) is not a type change and must not
        be rejected just because values already exist.
        """
        definition = _definition(self.board, name="Notes", field_type=T.TEXT)
        CustomFieldValue.objects.create(
            card=self.card, field_definition=definition, value="hello",
        )
        r = self.client.patch(
            self._field_url(definition),
            {"field_type": "text", "help_text": "unchanged type"},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)

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

    def test_nul_byte_in_a_text_value_is_a_400_not_a_500(self):
        """The value-write twin of #1184's definition-side fix.

        `_normalize_custom_field_value`'s TEXT branch (the bare `return text`
        fallback) had no NUL guard, so a NUL byte submitted through
        `CardSerializer`'s writable `custom_field_values` reached Postgres as
        an unhandled `DataError` 500 instead of the 400 every other invalid
        value on this field returns (#1188).
        """
        r = self._set_values(
            [{"field_definition": self.text.id, "value": "two\x00shelves"}]
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)
        self.assertIn("custom_field_values", r.data)
        self.assertFalse(CustomFieldValue.objects.exists())

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


    def _patch_cost(self, definition, value):
        with CaptureQueriesContext(connection) as ctx:
            r = self._set_values([{"field_definition": definition.id, "value": value}])
            self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        return len(ctx.captured_queries)

    def test_a_multi_select_write_costs_exactly_one_extra_query(self):
        """#1391: the orphan check reads the stored value once, and only for a
        multi-select field — a text write pays nothing for it."""
        text = _definition(self.board, name="Notes", position=0)
        multi = _definition(
            self.board, name="Platforms", field_type=T.MULTI_SELECT, position=1,
            choices_json=["web", "ios"],
        )
        CustomFieldValue.objects.create(card=self.card, field_definition=text, value="a")
        CustomFieldValue.objects.create(
            card=self.card, field_definition=multi, value='["web"]'
        )
        # Warm any per-process caches so the two measurements compare like
        # with like.
        self._patch_cost(text, "warm")
        text_cost = self._patch_cost(text, "b")
        multi_cost = self._patch_cost(multi, ["ios"])
        self.assertEqual(multi_cost, text_cost + 1)


# ---------------------------------------------------------------------------
# URL field type (#1390)
# ---------------------------------------------------------------------------

#: Values every URL write path must refuse. Each one is either an XSS vector
#: once rendered as an ``href`` or a URL whose host a browser would read
#: differently from Python (see ``validate_external_ref_url``).
INVALID_URL_VALUES = (
    "javascript:alert(1)",
    "JaVaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "ftp://files.example.com/a",
    "example.com",              # no scheme: the frontend normalizes, the API does not
    "https://",                 # no host
    "http://a\\b",              # backslash: browsers read it as "/"
    "https://user:pass@example.com/",
    "\x01https://example.com",  # leading control character (not stripped)
    "https://exa mple.com/",    # embedded whitespace
    "https://ex%61mple.com/",   # percent-encoded host
    "https://example.com:99999/",
)


class CustomFieldUrlTypeTests(CustomFieldTestBase):
    def setUp(self):
        super().setUp()
        self.url_field = _definition(
            self.board, name="Runbook", field_type=T.URL, position=0
        )

    def test_a_url_definition_can_be_created(self):
        r = self.client.post(
            self._fields_url(), {"name": "Docs", "field_type": "url"}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        self.assertEqual(r.data["field_type"], "url")
        self.assertEqual(r.data["choices"], [])

    def test_choices_on_a_url_definition_are_rejected(self):
        r = self.client.post(
            self._fields_url(),
            {"name": "Docs", "field_type": "url", "choices": ["https://a.example"]},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("choices", r.data)

    def test_http_and_https_values_are_accepted_and_stored_as_typed(self):
        for raw in (
            "https://wiki.example.com/runbooks/raid?x=1#top",
            "http://10.0.0.5:8080/status",
            "HTTPS://Example.COM/Path",
        ):
            with self.subTest(raw=raw):
                r = self._set_values([{"field_definition": self.url_field.id, "value": raw}])
                self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
                # Stored exactly as typed — no scheme lower-casing, no rewrite.
                self.assertEqual(
                    CustomFieldValue.objects.get(field_definition=self.url_field).value,
                    raw,
                )

    def test_surrounding_whitespace_is_trimmed_like_every_other_type(self):
        r = self._set_values(
            [{"field_definition": self.url_field.id, "value": "  https://example.com/  "}]
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        self.assertEqual(
            CustomFieldValue.objects.get(field_definition=self.url_field).value,
            "https://example.com/",
        )

    def test_unsafe_and_malformed_values_are_a_400_not_a_500(self):
        for raw in INVALID_URL_VALUES:
            with self.subTest(raw=raw):
                r = self._set_values([{"field_definition": self.url_field.id, "value": raw}])
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)
                self.assertIn("custom_field_values", r.data)
                self.assertFalse(CustomFieldValue.objects.exists())

    def test_the_error_names_the_field_and_the_scheme_rule(self):
        r = self._set_values(
            [{"field_definition": self.url_field.id, "value": "javascript:alert(1)"}]
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("Runbook", str(r.data))
        self.assertIn("Only http and https URLs are allowed.", str(r.data))

    def test_a_nul_byte_is_a_400_not_a_500(self):
        r = self._set_values(
            [{"field_definition": self.url_field.id, "value": "https://exa\x00mple.com/"}]
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)
        self.assertFalse(CustomFieldValue.objects.exists())

    def test_a_url_over_the_length_cap_is_refused(self):
        base = "https://example.com/"
        too_long = base + "a" * (CustomFieldDefinition.MAX_VALUE_LENGTH + 1 - len(base))
        self.assertEqual(len(too_long), CustomFieldDefinition.MAX_VALUE_LENGTH + 1)
        r = self._set_values([{"field_definition": self.url_field.id, "value": too_long}])
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(CustomFieldValue.objects.exists())

        at_cap = too_long[:-1]
        r = self._set_values([{"field_definition": self.url_field.id, "value": at_cap}])
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)

    def test_an_empty_string_clears_the_value(self):
        self._set_values(
            [{"field_definition": self.url_field.id, "value": "https://example.com"}]
        )
        r = self._set_values([{"field_definition": self.url_field.id, "value": ""}])
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        self.assertFalse(CustomFieldValue.objects.exists())

    def test_a_viewer_cannot_write_a_url_value(self):
        own_card = _make_card(
            self.column, self.lane, title="Member's card",
            created_by=self.member, position=1,
        )
        r = self._set_values(
            [{"field_definition": self.url_field.id, "value": "https://example.com"}],
            user=self.member, card=own_card,
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        r = self._set_values(
            [{"field_definition": self.url_field.id, "value": "https://evil.example"}],
            user=self.viewer, card=own_card,
        )
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(
            CustomFieldValue.objects.get(card=own_card).value, "https://example.com"
        )

    def test_a_non_member_cannot_write_a_url_value(self):
        outsider = _make_user("cf_url_outsider")
        r = self._set_values(
            [{"field_definition": self.url_field.id, "value": "https://example.com"}],
            user=outsider,
        )
        self.assertIn(
            r.status_code, (status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND)
        )
        self.assertFalse(CustomFieldValue.objects.exists())

    def test_url_type_is_frozen_once_a_value_exists(self):
        CustomFieldValue.objects.create(
            card=self.card, field_definition=self.url_field, value="https://example.com"
        )
        r = self.client.patch(
            self._field_url(self.url_field), {"field_type": "text"}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)
        self.assertIn("field_type", r.data)

        text_field = _definition(self.board, name="Notes", field_type=T.TEXT, position=1)
        CustomFieldValue.objects.create(
            card=self.card, field_definition=text_field, value="not a url"
        )
        r = self.client.patch(
            self._field_url(text_field), {"field_type": "url"}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)
        text_field.refresh_from_db()
        self.assertEqual(text_field.field_type, T.TEXT)


# ---------------------------------------------------------------------------
# Multi-select type (#1391)
# ---------------------------------------------------------------------------

class CustomFieldMultiSelectTypeTests(CustomFieldTestBase):
    """``multi_select``: several of a definition's choices, stored as one
    canonical JSON array string in the existing text column (#1391)."""

    def setUp(self):
        super().setUp()
        self.field = _definition(
            self.board, name="Platforms", field_type=T.MULTI_SELECT,
            choices_json=["web", "ios", "android"],
        )

    def _write(self, value, **kwargs):
        return self._set_values(
            [{"field_definition": self.field.id, "value": value}], **kwargs
        )

    def _stored(self, card=None):
        row = CustomFieldValue.objects.filter(
            card=card or self.card, field_definition=self.field
        ).first()
        return row.value if row else None

    # -- definitions --------------------------------------------------------

    def test_a_multi_select_definition_can_be_created(self):
        r = self.client.post(
            self._fields_url(),
            {"name": "Teams", "field_type": "multi_select", "choices": [" a ", "b"]},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        self.assertEqual(r.data["field_type"], "multi_select")
        self.assertEqual(r.data["choices"], ["a", "b"])

    def test_a_multi_select_definition_needs_choices(self):
        r = self.client.post(
            self._fields_url(), {"name": "Teams", "field_type": "multi_select"},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(
            str(r.data["choices"][0]), "A multi-select field needs at least one choice."
        )

    def test_multi_select_choices_follow_the_dropdown_rules(self):
        for choices in (["a", "a"], ["a", ""], ["a\x00"], [1], [f"c{i}" for i in range(101)]):
            with self.subTest(choices=choices):
                r = self.client.post(
                    self._fields_url(),
                    {"name": "Teams", "field_type": "multi_select", "choices": choices},
                    format="json",
                )
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)
                self.assertIn("choices", r.data)

    def test_the_dropdown_messages_are_unchanged(self):
        r = self.client.post(
            self._fields_url(), {"name": "Tier", "field_type": "dropdown"},
            format="json",
        )
        self.assertEqual(
            str(r.data["choices"][0]), "A dropdown field needs at least one choice."
        )

    def test_choices_on_a_non_choice_type_name_both_choice_types(self):
        r = self.client.post(
            self._fields_url(),
            {"name": "Notes", "field_type": "text", "choices": ["a"]},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(
            str(r.data["choices"][0]),
            "Only a dropdown or multi-select field can have choices.",
        )

    def test_type_is_frozen_once_a_value_exists(self):
        CustomFieldValue.objects.create(
            card=self.card, field_definition=self.field, value='["web"]'
        )
        r = self.client.patch(
            self._field_url(self.field), {"field_type": "dropdown"}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("field_type", r.data)

    # -- values -------------------------------------------------------------

    def test_a_list_is_stored_canonically_and_read_back_as_a_string(self):
        r = self._write(["android", "web", "android", " ios "])
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        # Deduplicated, trimmed, in choice order, compact separators.
        self.assertEqual(self._stored(), '["web","ios","android"]')
        self.assertEqual(
            r.data["custom_field_values"],
            [{"field_definition": self.field.id, "value": '["web","ios","android"]'}],
        )

    def test_the_read_value_can_be_echoed_back(self):
        self._write(["ios", "web"])
        r = self._write('[ "web" , "ios" ]')
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        self.assertEqual(self._stored(), '["web","ios"]')

    def test_a_plain_string_is_one_entry(self):
        r = self._write("ios")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        self.assertEqual(self._stored(), '["ios"]')

    def test_non_ascii_choices_are_stored_unescaped(self):
        self.field.choices_json = ["Zürich", "東京"]
        self.field.save()
        self._write(["東京", "Zürich"])
        self.assertEqual(self._stored(), '["Zürich","東京"]')

    def test_a_value_outside_the_choices_is_a_400(self):
        for value in (["web", "blackberry"], "blackberry", '["blackberry"]'):
            with self.subTest(value=value):
                r = self._write(value)
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)
        self.assertIsNone(self._stored())

    def test_malformed_entries_are_a_400_not_a_500(self):
        for value in ([1], [None], [["web"]], [{"a": 1}], {"web": True}, True, '["web", 1]'):
            with self.subTest(value=value):
                r = self._write(value)
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)
        self.assertIsNone(self._stored())

    def test_a_nul_byte_is_a_400_not_a_500(self):
        r = self._write(["web\x00"])
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)
        self.assertIn("NUL", str(r.data))

    def test_an_encoded_value_over_the_length_cap_is_a_400(self):
        choices = [f"{i:02d}" + "x" * 20 for i in range(30)]
        self.field.choices_json = choices
        self.field.save()
        # 30 entries x 24 encoded chars = well over 500 once encoded.
        r = self._write(choices)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)
        self.assertIn("500 characters", str(r.data))
        # Under the cap still works.
        r = self._write(choices[:5])
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)

    def test_an_absurdly_long_list_is_refused_on_length(self):
        r = self._write(["web"] * 10_000)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)

    def test_empty_values_clear_the_field(self):
        for empty in ([], "", None, "[]", ["", "  "]):
            with self.subTest(empty=empty):
                self._write(["web"])
                r = self._write(empty)
                self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
                self.assertIsNone(self._stored())

    def test_an_orphaned_entry_is_kept_on_edit_but_cannot_be_added(self):
        self._write(["web", "ios"])
        # Rename a choice: the stored value is not rewritten.
        r = self.client.patch(
            self._field_url(self.field), {"choices": ["web", "iOS", "android"]},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        self.assertEqual(self._stored(), '["web","ios"]')

        # Editing the card while keeping the orphan works; it sorts after the
        # current choices.
        r = self._write(["ios", "android", "web"])
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        self.assertEqual(self._stored(), '["web","android","ios"]')

        # The orphan can be dropped ...
        r = self._write(["web"])
        self.assertEqual(self._stored(), '["web"]')
        # ... and once dropped it cannot come back, nor be added to another card.
        r = self._write(["web", "ios"])
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)
        other = _make_card(self.column, self.lane, title="Other", position=1)
        r = self._write(["ios"], card=other)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)

    def test_a_reordered_resubmission_is_not_a_change(self):
        received = []

        def handler(sender, **kwargs):
            received.append((kwargs["old_value"], kwargs["new_value"]))

        custom_field_value_changed.connect(handler)
        try:
            self._write(["ios", "web"])
            self._write(["web", "ios", "web"])
            self._write('["ios","web"]')
            self._write(["web"])
        finally:
            custom_field_value_changed.disconnect(handler)
        self.assertEqual(received, [
            ("", '["web","ios"]'),
            ('["web","ios"]', '["web"]'),
        ])

    def test_a_validator_hook_sees_the_canonical_string(self):
        seen = []

        def record(definition, value):
            seen.append(value)

        hooks.CUSTOM_FIELD_VALIDATORS.append(record)
        try:
            self._write(["android", "web"])
        finally:
            hooks.CUSTOM_FIELD_VALIDATORS.remove(record)
        self.assertEqual(seen, ['["web","android"]'])

    def test_a_deeply_nested_array_string_is_a_400_not_a_500(self):
        r = self._write("[" * 1000 + "]" * 1000)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)
        self.assertIsNone(self._stored())

    def test_an_oversize_array_string_is_refused_before_parsing(self):
        text = json.dumps(["web"] * 1000)  # > 2,000 characters
        real_loads = json.loads
        with patch("boards.serializers.json.loads", side_effect=real_loads) as loads:
            r = self._write(text)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)
        self.assertIn("500 characters", str(r.data))
        # The request body itself is parsed with json.loads; the value never is.
        self.assertNotIn(text, [c.args[0] for c in loads.call_args_list if c.args])

    def test_a_hook_replacement_is_recanonicalized(self):
        def rewrite(definition, value):
            return '[ "android" , "web", "web" ]'

        hooks.CUSTOM_FIELD_VALIDATORS.append(rewrite)
        try:
            r = self._write(["ios"])
        finally:
            hooks.CUSTOM_FIELD_VALIDATORS.remove(rewrite)
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        self.assertEqual(self._stored(), '["web","android"]')

    def test_a_hook_returning_a_non_array_is_a_400(self):
        def broken(definition, value):
            return "web, ios"

        hooks.CUSTOM_FIELD_VALIDATORS.append(broken)
        try:
            r = self._write(["ios"])
        finally:
            hooks.CUSTOM_FIELD_VALIDATORS.remove(broken)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)
        self.assertIsNone(self._stored())

    def test_values_can_be_set_when_creating_a_card(self):
        r = self.client.post(
            f"/api/v1/boards/{self.board.id}/cards/",
            {
                "title": "New", "column": self.column.id, "swimlane": self.lane.id,
                "custom_field_values": [
                    {"field_definition": self.field.id, "value": ["ios"]}
                ],
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        self.assertEqual(
            CustomFieldValue.objects.get(card_id=r.data["id"]).value, '["ios"]'
        )

    # -- permission boundary --------------------------------------------------

    def test_a_member_may_write_their_own_card(self):
        own = _make_card(
            self.column, self.lane, title="Mine", created_by=self.member, position=1
        )
        r = self._write(["web"], user=self.member, card=own)
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        self.assertEqual(self._stored(own), '["web"]')

    def test_a_member_cannot_write_someone_elses_card(self):
        r = self._write(["web"], user=self.member)
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN, r.data)
        self.assertIsNone(self._stored())

    def test_a_viewer_cannot_write(self):
        own = _make_card(
            self.column, self.lane, title="Mine", created_by=self.viewer, position=1
        )
        r = self._write(["web"], user=self.viewer, card=own)
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertIsNone(self._stored(own))

    def test_a_non_member_cannot_write(self):
        outsider = _make_user("cf_ms_outsider")
        r = self._write(["web"], user=outsider)
        self.assertIn(
            r.status_code, (status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND)
        )
        self.assertIsNone(self._stored())

    def test_a_definition_from_another_board_is_rejected(self):
        other_board = _make_board(self.admin, name="Elsewhere")
        foreign = _definition(
            other_board, name="Platforms", field_type=T.MULTI_SELECT,
            choices_json=["web"],
        )
        r = self._set_values([{"field_definition": foreign.id, "value": ["web"]}])
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(CustomFieldValue.objects.exists())

    # -- broadcast and export -----------------------------------------------

    def test_the_card_updated_broadcast_carries_the_string_value(self):
        self.broadcast.reset_mock()
        with self.captureOnCommitCallbacks(execute=True) as callbacks:
            self._write(["android", "web"])
            # Deferred with transaction.on_commit, never sent inline.
            self.assertEqual(self.broadcast.call_count, 0)
        self.assertTrue(callbacks)
        payload = next(
            call.args[2] for call in self.broadcast.call_args_list
            if call.args[1] == "card.updated"
        )
        self.assertEqual(
            payload["custom_field_values"],
            [{"field_definition": self.field.id, "value": '["web","android"]'}],
        )

    def test_the_definition_broadcast_carries_type_and_choices(self):
        self.broadcast.reset_mock()
        with self.captureOnCommitCallbacks(execute=True):
            r = self.client.post(
                self._fields_url(),
                {"name": "Teams", "field_type": "multi_select", "choices": ["a", "b"]},
                format="json",
            )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        payload = next(
            call.args[2] for call in self.broadcast.call_args_list
            if call.args[1] == "custom_field.created"
        )
        self.assertEqual(payload["field_type"], "multi_select")
        self.assertEqual(payload["choices"], ["a", "b"])

    def test_csv_export_joins_entries_and_sanitizes_each(self):
        self.field.choices_json = ["web", "=cmd|'/c calc'!A1", "-1"]
        self.field.save()
        CustomFieldValue.objects.create(
            card=self.card, field_definition=self.field,
            value=json.dumps(["=cmd|'/c calc'!A1", "web", "-1"]),
        )
        r = self.client.get(f"/api/v1/boards/{self.board.id}/export/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        rows = list(csv.reader(io.StringIO(r.content.decode())))
        col = rows[0].index("Custom: Platforms")
        self.assertEqual(rows[1][col], "cmd|'/c calc'!A1; web; 1")

    def test_csv_export_of_an_unparseable_value_is_empty_not_a_500(self):
        CustomFieldValue.objects.create(
            card=self.card, field_definition=self.field, value="not json"
        )
        r = self.client.get(f"/api/v1/boards/{self.board.id}/export/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        rows = list(csv.reader(io.StringIO(r.content.decode())))
        self.assertEqual(rows[1][rows[0].index("Custom: Platforms")], "")

    def test_json_export_keeps_the_stored_string_and_the_schema(self):
        CustomFieldValue.objects.create(
            card=self.card, field_definition=self.field, value='["web","ios"]'
        )
        r = self.client.get(f"/api/v1/boards/{self.board.id}/export/?format=json")
        payload = json.loads(r.content.decode())
        schema = next(f for f in payload["custom_fields"] if f["name"] == "Platforms")
        self.assertEqual(schema["field_type"], "multi_select")
        self.assertEqual(schema["choices"], ["web", "ios", "android"])
        self.assertEqual(
            payload["cards"][0]["custom_field_values"], {"Platforms": '["web","ios"]'}
        )
