"""Constraint-shaped fields say in the schema how far they bind (#1077).

Two halves, and they guard each other:

* ``FieldEnforcementSchemaTests`` pins that every field classified in
  ``docs/architecture/field-enforcement.md`` as anything short of "binding on
  every write path" publishes its ``Enforcement: <class>`` description on every
  OpenAPI component that carries it — request and response, list and detail.
  An agent reading the MCP-era schema has no other way to learn that
  ``wip_limit`` does not stop a card *create*.

* ``WipEnforcementBehaviorTests`` pins what the descriptions now claim, on each
  write path they name (#1428): card create and restore from archive are
  refused at the WIP limit even in hard mode, a PATCH that raises ``weight``
  past ``weight_limit`` is refused, and JSON board import is exempt by design.
  Before #1428 the same class pinned the *gap* and was inverted when the gap
  closed; if one of these paths changes again, update
  ``visiban/field_enforcement.py`` and the doc in the same change. CSV and
  Trello import share the JSON path's ``bulk_create`` shape and carry no column
  limits of their own. The full per-path matrix is in
  ``test_limit_enforcement_paths.py``.
"""

import io
import json

from django.test import SimpleTestCase, TestCase
from django.utils import timezone
from drf_spectacular.generators import SchemaGenerator
from rest_framework.test import APIClient

from boards.models import Card, Column
from factories import BoardFactory, CardFactory, ColumnFactory, SwimlaneFactory
from visiban import field_enforcement as fe

# component -> {field: expected description}
EXPECTED = {
    "Column": {"wip_limit": fe.COLUMN_WIP_LIMIT, "weight_limit": fe.COLUMN_WEIGHT_LIMIT},
    "ColumnRequest": {"wip_limit": fe.COLUMN_WIP_LIMIT, "weight_limit": fe.COLUMN_WEIGHT_LIMIT},
    "PatchedColumnRequest": {"wip_limit": fe.COLUMN_WIP_LIMIT, "weight_limit": fe.COLUMN_WEIGHT_LIMIT},
    "Card": {"version": fe.CARD_VERSION},
    "Group": {
        "allowed_priorities": fe.GROUP_ALLOWED_PRIORITIES,
        "default_board_member_role": fe.GROUP_DEFAULT_BOARD_MEMBER_ROLE,
    },
    "GroupDetail": {
        "allowed_priorities": fe.GROUP_ALLOWED_PRIORITIES,
        "default_board_member_role": fe.GROUP_DEFAULT_BOARD_MEMBER_ROLE,
    },
    "GroupRequest": {
        "allowed_priorities": fe.GROUP_ALLOWED_PRIORITIES,
        "default_board_member_role": fe.GROUP_DEFAULT_BOARD_MEMBER_ROLE,
    },
    "PatchedGroupRequest": {
        "allowed_priorities": fe.GROUP_ALLOWED_PRIORITIES,
        "default_board_member_role": fe.GROUP_DEFAULT_BOARD_MEMBER_ROLE,
    },
}
_BOARD_FIELDS = {
    "allowed_priorities": fe.BOARD_ALLOWED_PRIORITIES,
    "enforce_wip_limits": fe.BOARD_ENFORCE_WIP_LIMITS,
    "enforce_wip_hard": fe.BOARD_ENFORCE_WIP_HARD,
    "enforce_weight_limits": fe.BOARD_ENFORCE_WEIGHT_LIMITS,
}
for _component in ("Board", "BoardFull", "BoardRequest", "PatchedBoardRequest"):
    EXPECTED[_component] = _BOARD_FIELDS
for _component in (
    "CustomFieldDefinition", "CustomFieldDefinitionRequest", "PatchedCustomFieldDefinitionRequest",
):
    EXPECTED[_component] = {"is_required": fe.CUSTOM_FIELD_IS_REQUIRED}
for _component in (
    "SwimlaneCustomFieldDefinition", "SwimlaneCustomFieldDefinitionRequest",
    "PatchedSwimlaneCustomFieldDefinitionRequest",
):
    EXPECTED[_component] = {"is_required": fe.SWIMLANE_CUSTOM_FIELD_IS_REQUIRED}


class FieldEnforcementSchemaTests(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.components = SchemaGenerator().get_schema(request=None, public=True)["components"]["schemas"]

    def test_every_classified_field_publishes_its_enforcement_description(self):
        for component, fields in EXPECTED.items():
            props = self.components.get(component, {}).get("properties", {})
            for field, expected in fields.items():
                with self.subTest(component=component, field=field):
                    self.assertIn(field, props, f"`{component}` has no `{field}` property")
                    # startswith, not equality: drf-spectacular appends the
                    # choice list to an enum field's description.
                    self.assertTrue(
                        (props[field].get("description") or "").startswith(expected),
                        f"`{component}.{field}` description: {props[field].get('description')!r}",
                    )

    def test_group_default_board_member_role_is_marked_deprecated(self):
        # #1430: the field stays (1.0 contract) but the schema flags it so
        # generated clients and MCP agents see it as deprecated.
        for component in ("Group", "GroupDetail", "GroupRequest", "PatchedGroupRequest"):
            with self.subTest(component=component):
                prop = self.components[component]["properties"]["default_board_member_role"]
                self.assertIs(prop.get("deprecated"), True)

    def test_every_description_starts_with_its_class(self):
        # The `Enforcement: <class>` token is the machine-readable half of the
        # contract and must LEAD the description, so a client can classify a
        # field from a prefix match; prose after it may change.
        tokens = tuple(f"Enforcement: {c} " for c in ("binding", "advisory", "scaffold"))
        for name in dir(fe):
            if name.isupper():
                with self.subTest(constant=name):
                    self.assertTrue(
                        getattr(fe, name).startswith(tokens),
                        f"{name} does not start with an Enforcement token",
                    )


class WipEnforcementBehaviorTests(TestCase):
    """The non-move paths the descriptions name are checked; import is exempt."""

    def setUp(self):
        self.board = BoardFactory(enforce_wip_limits=True, enforce_wip_hard=True)
        self.column = ColumnFactory(board=self.board, wip_limit=1)
        self.swimlane = SwimlaneFactory(board=self.board)
        CardFactory(column=self.column, swimlane=self.swimlane)  # column is now full
        self.client = APIClient()
        self.client.force_authenticate(user=self.board.owner)

    def test_create_into_full_column_is_blocked_in_hard_mode(self):
        r = self.client.post(
            f"/api/v1/boards/{self.board.pk}/cards/?force=true",
            {"title": "over limit", "column": self.column.pk, "swimlane": self.swimlane.pk},
            format="json",
        )
        self.assertEqual(r.status_code, 409, r.content)
        self.assertEqual(r.json()["code"], "wip_hard_blocked")
        self.assertEqual(
            Card.objects.filter(column=self.column, archived_at__isnull=True).count(), 1,
        )

    def test_patch_weight_past_weight_limit_is_blocked(self):
        self.board.enforce_weight_limits = True
        self.board.save(update_fields=["enforce_weight_limits"])
        self.column.weight_limit = 2
        self.column.save(update_fields=["weight_limit"])
        card = Card.objects.get(column=self.column)
        r = self.client.patch(
            f"/api/v1/boards/{self.board.pk}/cards/{card.pk}/", {"weight": 5}, format="json",
        )
        self.assertEqual(r.status_code, 409, r.content)
        self.assertEqual(r.json()["code"], "weight_limit_exceeded")
        card.refresh_from_db()
        self.assertEqual(card.weight, 1)

    def test_json_import_over_limit_is_not_blocked(self):
        # Exempt by design (#1428 decision): import restores a board as exported.
        data = {
            "name": "Imported",
            "columns": [{"name": "Doing", "position": 0, "wip_limit": 1, "weight_limit": 1,
                         "allow_card_creation": True}],
            "swimlanes": [{"name": "General", "position": 0}],
            "cards": [
                {"title": f"c{i}", "column": "Doing", "swimlane": "General", "weight": 3,
                 "position": i}
                for i in range(3)
            ],
        }
        upload = io.BytesIO(json.dumps(data).encode("utf-8"))
        upload.name = "board.json"
        r = self.client.post("/api/v1/boards/import/", {"file": upload}, format="multipart")
        self.assertEqual(r.status_code, 201, r.content)
        column = Column.objects.get(board_id=r.data["id"], name="Doing")
        self.assertEqual(column.wip_limit, 1)
        self.assertEqual(Card.objects.filter(column=column).count(), 3)

    def test_restore_into_full_column_is_blocked_in_hard_mode(self):
        archived = CardFactory(
            column=self.column, swimlane=self.swimlane, archived_at=timezone.now(),
        )
        r = self.client.post(
            f"/api/v1/boards/{self.board.pk}/cards/{archived.pk}/unarchive/?force=true",
        )
        self.assertEqual(r.status_code, 409, r.content)
        self.assertEqual(r.json()["code"], "wip_hard_blocked")
        self.assertEqual(
            Card.objects.filter(column=self.column, archived_at__isnull=True).count(), 1,
        )
