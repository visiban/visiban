"""Schema-vs-response contract tests for ``GET /boards/{id}/saved-filters/`` (#1359).

Same technique as ``test_board_schema_contract.py`` (#1123): generate the real
OpenAPI document and validate live responses against it.

The drift schemathesis reported as ``x-bundled/schema1/type`` was not a field
inside ``SavedFilter`` — every field already matched. It was the envelope: the
``saved_filters`` action inherits BoardViewSet's default paginator, so
drf-spectacular published the GET response as ``PaginatedSavedFilterList``
(``{count, offset, page_size, results}``, an *object*) while the action has
always returned a bare JSON *array*. Fixed with ``pagination_class=None`` on the
action, the same fix #1142 applied to the reorder actions.
"""

import jsonschema
from django.test import TestCase
from drf_spectacular.generators import SchemaGenerator
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, SavedFilter
from boards.tests.test_move_schema_contract import _openapi3_nullable_to_jsonschema

_PATH = "/api/v1/boards/{id}/saved-filters/"


class SavedFilterSchemaContractTests(TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.schema = SchemaGenerator().get_schema(request=None, public=True)

    def setUp(self):
        self.user = User.objects.create_user(username="alice", password="pass")
        self.board = Board.objects.create(name="Board", owner=self.user)
        BoardMembership.objects.create(
            board=self.board, user=self.user, role=BoardMembership.Role.ADMIN
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.url = f"/api/v1/boards/{self.board.pk}/saved-filters/"

    def _response_schema(self, method="get", status_code="200"):
        op = self.schema["paths"][_PATH][method]
        return op["responses"][status_code]["content"]["application/json"]["schema"]

    def _assert_valid(self, body, schema_fragment):
        combined = {**schema_fragment, "components": self.schema["components"]}
        jsonschema.validate(instance=body, schema=_openapi3_nullable_to_jsonschema(combined))

    def test_list_is_documented_as_a_bare_array(self):
        """Was `$ref: PaginatedSavedFilterList` — the action never paginates."""
        schema = self._response_schema()
        self.assertEqual(schema.get("type"), "array")
        self.assertEqual(schema["items"]["$ref"], "#/components/schemas/SavedFilter")
        params = {p["name"] for p in self.schema["paths"][_PATH]["get"].get("parameters", [])}
        # Pagination params were published but never honored by the action.
        self.assertNotIn("offset", params)
        self.assertNotIn("page_size", params)

    def test_empty_list_matches_schema(self):
        resp = self.client.get(self.url)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.json(), [])
        self._assert_valid(resp.json(), self._response_schema())

    def test_populated_list_matches_schema(self):
        """Realistic and edge-case state_json payloads, written via the real POST path."""
        payloads = [
            {
                "name": "Full",
                "state_json": {
                    "search": "bug",
                    "assigneeIds": [1, 2],
                    "labelIds": [3],
                    "priorities": ["urgent", "high"],
                    "dueDate": "this_week",
                },
            },
            {"name": "Empty", "state_json": {}},
            {"name": "Null due date", "state_json": {"dueDate": None, "labelIds": []}},
            {"name": "Future version", "state_json": {"search": ""}, "state_version": 7},
        ]
        for payload in payloads:
            r = self.client.post(self.url, payload, format="json")
            self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.content)
            self._assert_valid(r.json(), self._response_schema("post", "201"))

        # A legacy row written before state_json was shape-validated on write.
        SavedFilter.objects.create(user=self.user, board=self.board, name="Legacy")

        resp = self.client.get(self.url)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        body = resp.json()
        self.assertIsInstance(body, list)
        self.assertEqual(len(body), 5)
        self._assert_valid(body, self._response_schema())
