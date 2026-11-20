"""Aligned import envelopes and stable error codes (#1903).

The JSON/CSV import returned the board at the top level plus
``import_summary``; the Trello import returned ``{board, summary}``. Both now
carry all four keys, with nothing removed. Every import error body is
``{detail, code}``, including the ones DRF builds for a raised exception.
"""

from unittest import mock

from django.core.cache import cache
from django.test import TestCase, override_settings
from drf_spectacular.generators import SchemaGenerator
from rest_framework.exceptions import ErrorDetail
from rest_framework.response import Response
from rest_framework.test import APIClient

import jsonschema

from accounts.models import User
from boards.import_errors import ImportErrorCode, fallback_code
from boards.services import trello_import
from boards.tests.test_import_options import _board_data, _csv_file, _json_file
from boards.tests.test_import_response_schemas_1870 import strict_schema
from boards.tests.test_move_schema_contract import _openapi3_nullable_to_jsonschema
from boards.tests.test_trello_import import as_file, load_fixture
from boards.views.import_export import TrelloImportThrottle, _with_import_error_code

_IMPORT = "/api/v1/boards/import/"
_TRELLO = "/api/v1/boards/import/trello/"
C = ImportErrorCode


class _Base(TestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(username="importer1903", password="pass")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def post(self, path, data):
        return self.client.post(path, data, format="multipart")

    def assert_error(self, resp, status_code, code):
        self.assertEqual(resp.status_code, status_code, resp.content)
        body = resp.json()
        self.assertEqual(set(body), {"detail", "code"}, body)
        self.assertTrue(body["detail"])
        self.assertEqual(body["code"], code, body)


class EnvelopeAlignmentTests(_Base):
    def _assert_aligned(self, body):
        board = body["board"]
        self.assertEqual({k: body[k] for k in board}, board)
        self.assertEqual(body["summary"], body["import_summary"])

    def test_json_import_adds_board_and_summary(self):
        body = self.post(_IMPORT, {"file": _json_file(_board_data())}).json()
        self._assert_aligned(body)
        self.assertEqual(set(body["summary"]), {"options_applied", "skipped"})

    def test_csv_import_adds_board_and_summary(self):
        resp = self.post(_IMPORT, {"file": _csv_file("Title,Column,Swimlane\nA,To Do,General\n")})
        self.assertEqual(resp.status_code, 201, resp.content)
        body = resp.json()
        self._assert_aligned(body)
        self.assertIsInstance(body["summary"]["warnings"], list)

    def test_trello_confirm_adds_top_level_board_and_import_summary(self):
        resp = self.post(_TRELLO + "?confirm=true", {"file": as_file(load_fixture())})
        self.assertEqual(resp.status_code, 201, resp.content)
        body = resp.json()
        self._assert_aligned(body)
        self.assertEqual(set(body["import_summary"]), {"counts", "result", "warnings", "unmappable"})

    def test_trello_preview_is_unchanged(self):
        body = self.post(_TRELLO + "?dry_run=true", {"file": as_file(load_fixture())}).json()
        self.assertNotIn("import_summary", body)
        self.assertNotIn("summary", body)


class NativeImportErrorCodeTests(_Base):
    def test_no_file(self):
        self.assert_error(self.post(_IMPORT, {}), 400, C.NO_FILE)

    @override_settings(MAX_UPLOAD_SIZE=10)
    def test_file_too_large(self):
        self.assert_error(self.post(_IMPORT, {"file": _json_file(_board_data())}), 400, C.FILE_TOO_LARGE)

    def test_unsupported_format(self):
        resp = self.post(_IMPORT, {"file": _csv_file("x", filename="board.txt")})
        self.assert_error(resp, 400, C.UNSUPPORTED_FORMAT)

    def test_invalid_options(self):
        resp = self.post(_IMPORT, {"file": _json_file(_board_data()), "options": "{not json"})
        self.assert_error(resp, 400, C.INVALID_OPTIONS)

    def test_invalid_file(self):
        bad = _json_file({})
        bad.seek(0)
        bad.write(b"{nope")
        bad.truncate()
        bad.seek(0)
        self.assert_error(self.post(_IMPORT, {"file": bad}), 400, C.INVALID_FILE)
        self.assert_error(self.post(_IMPORT, {"file": _json_file([1])}), 400, C.INVALID_FILE)
        self.assert_error(self.post(_IMPORT, {"file": _csv_file("")}), 400, C.INVALID_FILE)

    def test_limit_exceeded_in_the_view_and_in_a_helper(self):
        data = _board_data()
        data["columns"] = [{"name": f"c{i}", "position": i} for i in range(51)]
        self.assert_error(self.post(_IMPORT, {"file": _json_file(data)}), 400, C.LIMIT_EXCEEDED)
        # The label cap is returned from _validate_json_import_values as an ErrorDetail.
        data = _board_data()
        data["labels"] = [{"name": f"l{i}", "color": "#000000"} for i in range(1001)]
        self.assert_error(self.post(_IMPORT, {"file": _json_file(data)}), 400, C.LIMIT_EXCEEDED)

    def test_invalid_name(self):
        resp = self.post(_IMPORT, {"file": _json_file(_board_data()), "name": "x" * 1000})
        self.assert_error(resp, 400, C.INVALID_NAME)

    def test_contents_problem_falls_back_to_invalid_import(self):
        data = _board_data()
        del data["name"]
        self.assert_error(self.post(_IMPORT, {"file": _json_file(data)}), 400, C.INVALID_IMPORT)

    def test_framework_errors_keep_drf_codes(self):
        self.assert_error(
            self.post(_IMPORT, {"file": _json_file(_board_data()), "group_id": 999999}), 404, "not_found",
        )
        self.assert_error(APIClient().post(_IMPORT, {}, format="multipart"), 401, "not_authenticated")


class TrelloErrorCodeTests(_Base):
    def test_invalid_mode(self):
        self.assert_error(self.post(_TRELLO, {"file": as_file(load_fixture())}), 400, C.INVALID_MODE)

    def test_no_file(self):
        self.assert_error(self.post(_TRELLO + "?dry_run=true", {}), 400, C.NO_FILE)

    @override_settings(VISIBAN_IMPORT_MAX_SIZE=10)
    def test_file_too_large_is_413(self):
        resp = self.post(_TRELLO + "?dry_run=true", {"file": as_file(load_fixture())})
        self.assert_error(resp, 413, C.FILE_TOO_LARGE)

    def test_file_mismatch(self):
        resp = self.post(_TRELLO + "?confirm=true", {"file": as_file(load_fixture()), "file_sha256": "0" * 64})
        self.assert_error(resp, 400, C.FILE_MISMATCH)

    def test_service_codes(self):
        self.assert_error(self.post(_TRELLO + "?dry_run=true", {"file": as_file(b"not json")}), 400, C.INVALID_FILE)
        resp = self.post(_TRELLO + "?dry_run=true", {"file": as_file(load_fixture()), "mapping": "[]"})
        self.assert_error(resp, 400, C.INVALID_OPTIONS)
        with mock.patch.object(trello_import, "MAX_LISTS", 0):
            resp = self.post(_TRELLO + "?dry_run=true", {"file": as_file(load_fixture())})
        self.assert_error(resp, 400, C.LIMIT_EXCEEDED)
        raw = load_fixture()
        raw["cards"][0]["name"] = 5
        resp = self.post(_TRELLO + "?dry_run=true", {"file": as_file(raw)})
        self.assert_error(resp, 400, C.INVALID_IMPORT)

    def test_throttled_keeps_drf_code(self):
        rates = {"board_import": "1/hour", "board_import_preview": "1/hour"}
        with mock.patch.object(TrelloImportThrottle, "get_rate", autospec=True,
                               side_effect=lambda self: rates[self.scope]):
            self.post(_TRELLO + "?dry_run=true", {"file": as_file(load_fixture())})
            resp = self.post(_TRELLO + "?dry_run=true", {"file": as_file(load_fixture())})
        self.assert_error(resp, 429, "throttled")


class ErrorCodeBackstopTests(TestCase):
    """The backstop's absent-input branches: it never passes a body through code-less."""

    def test_plain_string_detail(self):
        self.assertEqual(fallback_code("x", 400), C.INVALID_IMPORT)
        self.assertEqual(fallback_code("x", 413), C.FILE_TOO_LARGE)
        self.assertEqual(fallback_code("x", 500), "error")
        self.assertEqual(fallback_code(None, 400), C.INVALID_IMPORT)

    def test_error_detail_code(self):
        self.assertEqual(fallback_code(ErrorDetail("x", code="not_found"), 404), "not_found")
        self.assertEqual(fallback_code(ErrorDetail("x", code=C.LIMIT_EXCEEDED), 400), C.LIMIT_EXCEEDED)
        self.assertEqual(fallback_code(ErrorDetail("x", code="parse_error"), 400), "parse_error")
        # A serializer-internal code never becomes a 400 contract value.
        self.assertEqual(fallback_code(ErrorDetail("x", code="max_length"), 400), C.INVALID_IMPORT)
        self.assertEqual(fallback_code(ErrorDetail("x", code=""), 404), "error")

    def test_backstop_keeps_an_explicit_code_and_skips_other_bodies(self):
        explicit = _with_import_error_code(Response({"detail": "x", "code": C.NO_FILE}, status=400))
        self.assertEqual(explicit.data["code"], C.NO_FILE)
        no_detail = _with_import_error_code(Response({"name": ["bad"]}, status=400))
        self.assertNotIn("code", no_detail.data)
        success = _with_import_error_code(Response({"detail": "fine"}, status=201))
        self.assertNotIn("code", success.data)

    def test_other_board_endpoints_are_untouched(self):
        user = User.objects.create_user(username="other1903", password="pass")
        client = APIClient()
        client.force_authenticate(user)
        resp = client.get("/api/v1/boards/999999/")
        self.assertEqual(resp.status_code, 404)
        self.assertNotIn("code", resp.json())


class ErrorSchemaTests(_Base):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.schema = SchemaGenerator().get_schema(request=None, public=True)

    def _validate(self, body, path, status_code):
        content = self.schema["paths"][path]["post"]["responses"][status_code]["content"]["application/json"]
        fragment = content["schema"]
        combined = strict_schema(
            _openapi3_nullable_to_jsonschema({**fragment, "components": self.schema["components"]})
        )
        jsonschema.validate(instance=body, schema=combined)

    def test_error_bodies_match_the_import_error_component(self):
        self._validate(self.post(_IMPORT, {}).json(), _IMPORT, "400")
        self._validate(self.post(_TRELLO, {}).json(), _TRELLO, "400")
        with override_settings(VISIBAN_IMPORT_MAX_SIZE=10):
            self._validate(self.post(_TRELLO + "?dry_run=true", {"file": as_file(load_fixture())}).json(), _TRELLO, "413")
        self._validate(APIClient().post(_IMPORT, {}, format="multipart").json(), _IMPORT, "401")

    def test_success_components_declare_all_four_keys(self):
        components = self.schema["components"]["schemas"]
        for name in ("BoardImportResponse", "TrelloImportConfirm"):
            with self.subTest(name=name):
                props = components[name]["properties"]
                self.assertLessEqual({"id", "board", "summary", "import_summary"}, set(props))
