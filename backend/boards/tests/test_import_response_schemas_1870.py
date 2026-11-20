"""Schema-vs-response contract for the board-import success bodies (#1870).

The JSON/CSV import returns the board at the top level plus ``import_summary``;
the Trello import returns ``{board, summary}`` (201) or the preview (200). They
used to be documented as untyped objects. These tests validate live responses
against the generated OpenAPI components. Since #1903 both carry all four
envelope keys (``board``, ``summary``, ``import_summary`` and the board's fields
at the top level); ``test_import_envelope_1903`` pins that alignment.
"""

import json

import jsonschema
from django.core.cache import cache
from django.test import TestCase
from drf_spectacular.generators import SchemaGenerator
from rest_framework.test import APIClient

from accounts.models import User
from boards.tests.test_import_options import _board_data, _csv_file, _json_file
from boards.tests.test_move_schema_contract import _openapi3_nullable_to_jsonschema
from boards.tests.test_trello_import import as_file, load_fixture

def strict_schema(node):
    """Set ``additionalProperties: false`` on every object schema, recursively.

    Without it, jsonschema accepts a key the response carries but the component
    does not declare, so a payload that grows a field would never fail here.
    """
    if isinstance(node, dict):
        out = {k: strict_schema(v) for k, v in node.items()}
        if out.get("type") == "object" and "properties" in out and "additionalProperties" not in out:
            out["additionalProperties"] = False
        return out
    if isinstance(node, list):
        return [strict_schema(v) for v in node]
    return node


_IMPORT = "/api/v1/boards/import/"
_TRELLO = "/api/v1/boards/import/trello/"


class ImportResponseSchemaTests(TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.schema = SchemaGenerator().get_schema(request=None, public=True)

    def setUp(self):
        cache.clear()
        self.client = APIClient()
        self.user = User.objects.create_user(username="importer1870", password="pass")
        self.alice = User.objects.create_user(username="alice", password="pass")
        self.client.force_authenticate(self.user)

    def _response_schema(self, path, status_code):
        op = self.schema["paths"][path]["post"]
        return op["responses"][status_code]["content"]["application/json"]["schema"]

    def _assert_valid(self, body, path, status_code):
        fragment = self._response_schema(path, status_code)
        combined = strict_schema(
            _openapi3_nullable_to_jsonschema({**fragment, "components": self.schema["components"]})
        )
        jsonschema.validate(instance=body, schema=combined)

    def test_components_are_named_not_inline(self):
        for path, code, name in (
            (_IMPORT, "201", "BoardImportResponse"),
            (_TRELLO, "200", "TrelloImportPreview"),
            (_TRELLO, "201", "TrelloImportConfirm"),
        ):
            with self.subTest(path=path, code=code):
                self.assertEqual(self._response_schema(path, code), {"$ref": f"#/components/schemas/{name}"})

    def test_json_import_matches_schema(self):
        resp = self.client.post(_IMPORT, {"file": _json_file(_board_data())}, format="multipart")
        self.assertEqual(resp.status_code, 201)
        body = resp.json()
        self.assertIn("id", body)  # board fields stay at the top level
        self.assertEqual(body["board"]["id"], body["id"])  # and under `board` (#1903)
        self.assertNotIn("warnings", body["import_summary"])
        self._assert_valid(body, _IMPORT, "201")

    def test_json_import_with_options_and_date_shift_matches_schema(self):
        resp = self.client.post(
            _IMPORT,
            {
                "file": _json_file(_board_data()),
                "options": json.dumps({"comments": False, "shift_dates_from": "2024-01-01"}),
            },
            format="multipart",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        body = resp.json()
        self.assertEqual(body["import_summary"]["options_applied"]["shift_dates_from"], "2024-01-01")
        self._assert_valid(body, _IMPORT, "201")

    def test_csv_import_matches_schema(self):
        csv_text = "Title,Column,Swimlane\nA,To Do,General\n"
        resp = self.client.post(_IMPORT, {"file": _csv_file(csv_text)}, format="multipart")
        self.assertEqual(resp.status_code, 201, resp.content)
        body = resp.json()
        self.assertIsInstance(body["import_summary"]["warnings"], list)
        self._assert_valid(body, _IMPORT, "201")

    def test_trello_preview_matches_schema(self):
        resp = self.client.post(_TRELLO + "?dry_run=true", {"file": as_file(load_fixture())}, format="multipart")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertNotIn("board_id", body)
        self._assert_valid(body, _TRELLO, "200")

    def test_trello_confirm_matches_schema(self):
        resp = self.client.post(_TRELLO + "?confirm=true", {"file": as_file(load_fixture())}, format="multipart")
        self.assertEqual(resp.status_code, 201, resp.content)
        body = resp.json()
        self.assertLessEqual({"board", "summary", "import_summary", "id"}, set(body))
        self.assertEqual(set(body["summary"]), {"counts", "result", "warnings", "unmappable"})
        self._assert_valid(body, _TRELLO, "201")
