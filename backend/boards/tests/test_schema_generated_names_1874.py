"""Generated OpenAPI names that a client generator would freeze (#1874).

``inline_serializer(name="XRequest")`` combined with ``COMPONENT_SPLIT_REQUEST``
yields ``XRequestRequest``, and a list endpoint with no explicit operationId is
named ``*_retrieve``. Neither is gated by api-compat, but generated clients turn
both into public type and method names, so they are pinned here before the
baseline roll.
"""

import json
from pathlib import Path

from django.test import SimpleTestCase
from drf_spectacular.generators import SchemaGenerator


class GeneratedSchemaNamesTests(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.schema = SchemaGenerator().get_schema(request=None, public=True)

    def _operation_ids(self):
        return {
            op["operationId"]
            for item in self.schema["paths"].values()
            for op in item.values()
            if isinstance(op, dict) and "operationId" in op
        }

    def test_no_double_request_component_names(self):
        bad = [n for n in self.schema["components"]["schemas"] if n.endswith("RequestRequest")]
        self.assertEqual(bad, [])

    def test_renamed_request_components_exist(self):
        components = self.schema["components"]["schemas"]
        for name in (
            "ChecklistReorderRequest",
            "CardMoveRequest",
            "ColumnReorderRequest",
            "CustomFieldReorderRequest",
            "SwimlaneReorderRequest",
            "SwimlaneCustomFieldReorderRequest",
            "ShareBoardRequest",
            "AddOrUpdateMemberRequest",
            "PersonalAccessTokenCreateRequest",
        ):
            self.assertIn(name, components)

    def test_list_endpoints_use_list_operation_ids(self):
        ids = self._operation_ids()
        for new, old in (
            ("api_v1_admin_action_log_list", "api_v1_admin_action_log_retrieve"),
            ("api_v1_admin_board_invite_links_list", "api_v1_admin_board_invite_links_retrieve"),
            ("api_v1_boards_events_list", "api_v1_boards_events_retrieve"),
        ):
            self.assertIn(new, ids)
            self.assertNotIn(old, ids)

    def test_new_list_operations_are_not_named_retrieve(self):
        """Generic guard: a GET new since the GA baseline that returns a collection must
        not be ``*_retrieve``. The baseline is the one ``api-compat-check`` diffs
        against (v1.2.0 since #2101), so names that already shipped are exempt."""
        baseline_path = (
            Path(__file__).resolve().parents[3]
            / "scripts" / "compat-baseline" / "v1.2.0" / "openapi.json"
        )
        baseline = json.loads(baseline_path.read_text())
        shipped = {
            op["operationId"]
            for item in baseline["paths"].values()
            for op in item.values()
            if isinstance(op, dict) and "operationId" in op
        }
        components = self.schema["components"]["schemas"]

        def resolve(schema):
            ref = schema.get("$ref")
            return components.get(ref.rsplit("/", 1)[-1], {}) if ref else schema

        offenders = []
        for path, item in self.schema["paths"].items():
            op = item.get("get")
            if not op or not op["operationId"].endswith("_retrieve"):
                continue
            if op["operationId"] in shipped:
                continue
            body = (
                op.get("responses", {}).get("200", {}).get("content", {})
                .get("application/json", {}).get("schema", {})
            )
            body = resolve(body)
            if body.get("type") == "array" or "results" in body.get("properties", {}):
                offenders.append(f"{op['operationId']} ({path})")
        self.assertEqual(offenders, [])
