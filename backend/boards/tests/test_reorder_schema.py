"""Schema regression tests for the board-scoped ``reorder`` actions (#1142).

Each ``reorder`` returns the plain reordered array and never paginates. The
global paginator wraps any ``many=True`` response in ``{count, results, ...}``
in the generated schema, so without ``pagination_class=None`` on the action a
client generated from the schema expects an object and fails to parse the
array the endpoint actually sends (caught by ``backend-schema-fuzz``).
"""

from django.test import SimpleTestCase
from drf_spectacular.generators import SchemaGenerator

BASE = "/api/v1/boards/{board_pk}"


class ReorderActionsDocumentBareArrayTests(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.paths = SchemaGenerator().get_schema(request=None, public=True)["paths"]

    def _assert_bare_array(self, path, methods, item_ref):
        for method in methods:
            schema = self.paths[path][method]["responses"]["200"]["content"][
                "application/json"
            ]["schema"]
            self.assertEqual(schema["type"], "array", f"{method} {path}")
            self.assertEqual(
                schema["items"]["$ref"], f"#/components/schemas/{item_ref}", f"{method} {path}"
            )

    def test_columns_reorder(self):
        self._assert_bare_array(f"{BASE}/columns/reorder/", ["post"], "Column")

    def test_swimlanes_reorder(self):
        self._assert_bare_array(f"{BASE}/swimlanes/reorder/", ["post"], "Swimlane")

    def test_custom_fields_reorder_put_and_post(self):
        self._assert_bare_array(
            f"{BASE}/custom-fields/reorder/", ["put", "post"], "CustomFieldDefinition"
        )
