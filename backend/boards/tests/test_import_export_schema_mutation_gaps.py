"""The export action's OpenAPI declaration, pinned value by value (#1930).

``export`` carries a hand-written ``@extend_schema`` (#1783): the ``format``
query parameter and one ``200`` response with a CSV and a JSON media type.
``test_action_schema_1783.py`` checks its shape but is not in the
``import_export`` mutation target's test list, and it does not pin the field
names, the parameter's optionality or the descriptions, so the weekly run of
2026-10-25 found every mutant of the declaration surviving. A client generated
from the published document sees each of these values.

This file is last in the target's test list (``backend/mutmut_config.py``):
generating the schema is the slowest step here, and only a mutant that every
other file let through needs to pay for it.
"""

from django.test import TestCase
from drf_spectacular.generators import SchemaGenerator
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership

_EXPORT = "/api/v1/boards/{id}/export/"
_EXPORT_KEYS = [
    "schema_version", "name", "description", "lane_details_cap",
    "parent_name_singular", "parent_name_plural", "cards_can_have_children", "columns", "swimlanes", "labels",
    "custom_fields", "swimlane_custom_fields", "field_sets", "cards", "deleted_card_history", "relations",
]


class ExportSchemaDeclarationTests(TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.schema = SchemaGenerator().get_schema(request=None, public=True)
        cls.op = cls.schema["paths"][_EXPORT]["get"]

    def test_format_parameter(self):
        fmt = [p for p in self.op["parameters"] if p["in"] == "query"]
        self.assertEqual(fmt, [{
            "in": "query",
            "name": "format",
            "schema": {"type": "string", "enum": ["csv", "json"]},
            "description": "`json` for the JSON export; `csv` or omitted for CSV (the default).",
        }])

    def test_ok_response_is_csv_text_or_the_json_export(self):
        self.assertNotIn("201", self.op["responses"])
        ok = self.op["responses"]["200"]
        self.assertEqual(ok["description"], "CSV export, one row per card (the default).")
        self.assertEqual(list(ok["content"]), ["text/csv", "application/json"])
        self.assertEqual(ok["content"]["text/csv"]["schema"], {"type": "string"})
        self.assertEqual(
            ok["content"]["application/json"]["schema"], {"$ref": "#/components/schemas/BoardExport"},
        )

    def test_board_export_component_lists_the_export_keys(self):
        component = self.schema["components"]["schemas"]["BoardExport"]
        self.assertEqual(list(component["properties"]), _EXPORT_KEYS)
        self.assertEqual(sorted(component["required"]), sorted(_EXPORT_KEYS))
        self.assertEqual(component["properties"]["schema_version"], {"type": "integer"})
        self.assertEqual(component["properties"]["name"], {"type": "string"})
        self.assertEqual(component["properties"]["description"], {"type": "string"})
        self.assertEqual(component["properties"]["lane_details_cap"], {"type": "integer"})
        self.assertEqual(component["properties"]["parent_name_singular"], {"type": "string"})
        self.assertEqual(component["properties"]["parent_name_plural"], {"type": "string"})
        self.assertEqual(component["properties"]["cards_can_have_children"], {"type": "boolean"})
        for key in _EXPORT_KEYS[7:]:
            self.assertEqual(
                component["properties"][key],
                {"type": "array", "items": {"type": "object", "additionalProperties": {}}},
                key,
            )

    def test_component_matches_the_live_json_export(self):
        owner = User.objects.create_user(username="schema1930", password="pass-1930-Old!")
        board = Board.objects.create(name="Schema 1930", owner=owner)
        BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
        client = APIClient()
        client.force_authenticate(owner)
        resp = client.get(f"/api/v1/boards/{board.pk}/export/", {"format": "json"})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(list(resp.json()), _EXPORT_KEYS)
