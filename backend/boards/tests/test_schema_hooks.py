"""Tests for visiban.schema_hooks (#1080).

The hook documents the standard DRF error envelope ({"detail": <string>}) on
every operation so schemathesis's response_schema_conformance check has
something to validate a 401/403/404/429 against instead of silently ignoring
an undocumented error response.
"""
from django.test import TestCase

from visiban.schema_hooks import add_standard_error_responses


class AddStandardErrorResponsesTests(TestCase):
    def test_adds_envelope_for_undeclared_status_codes(self):
        result = {
            "paths": {
                "/api/v1/boards/{id}/": {
                    "get": {"responses": {"200": {"description": "OK"}}},
                },
            },
        }

        add_standard_error_responses(result, generator=None, request=None, public=True)

        responses = result["paths"]["/api/v1/boards/{id}/"]["get"]["responses"]
        self.assertIn("200", responses)  # untouched
        for status_code in ("401", "403", "404", "429"):
            self.assertIn(status_code, responses)
            schema = responses[status_code]["content"]["application/json"]["schema"]
            self.assertEqual(schema["properties"]["detail"]["type"], "string")
            self.assertEqual(schema["required"], ["detail"])

    def test_does_not_overwrite_an_already_declared_response(self):
        """A view's own @extend_schema (e.g. CardViewSet.move's 409s) must win."""
        custom_403 = {
            "description": "Moving a card assigned to another member requires Moderator or Admin access.",
            "content": {
                "application/json": {
                    "schema": {
                        "type": "object",
                        "properties": {"code": {"type": "string"}, "detail": {"type": "string"}},
                    }
                }
            },
        }
        result = {
            "paths": {
                "/api/v1/boards/{board_pk}/cards/{id}/move/": {
                    "post": {"responses": {"200": {"description": "OK"}, "403": custom_403}},
                },
            },
        }

        add_standard_error_responses(result, generator=None, request=None, public=True)

        responses = result["paths"]["/api/v1/boards/{board_pk}/cards/{id}/move/"]["post"]["responses"]
        self.assertIs(responses["403"], custom_403)
        # 401/404/429 still get filled in since only 403 was already declared.
        self.assertIn("401", responses)
        self.assertIn("404", responses)
        self.assertIn("429", responses)

    def test_ignores_non_http_method_keys(self):
        """Path items can carry non-method keys (parameters, summary, etc.) — skip them."""
        result = {
            "paths": {
                "/api/v1/boards/": {
                    "parameters": [{"name": "search", "in": "query"}],
                    "get": {"responses": {"200": {"description": "OK"}}},
                },
            },
        }

        # Must not raise despite "parameters" not being a dict with .setdefault
        # in the same shape as an operation.
        add_standard_error_responses(result, generator=None, request=None, public=True)

        self.assertNotIn("401", result["paths"]["/api/v1/boards/"])
        self.assertIn("401", result["paths"]["/api/v1/boards/"]["get"]["responses"])

    def test_real_schema_generation_includes_the_hook(self):
        """End-to-end: the live drf-spectacular generator applies this hook."""
        from drf_spectacular.generators import SchemaGenerator

        generator = SchemaGenerator()
        schema = generator.get_schema(request=None, public=True)

        board_list = schema["paths"]["/api/v1/boards/"]["get"]["responses"]
        self.assertIn("401", board_list)
        self.assertEqual(
            board_list["401"]["content"]["application/json"]["schema"]["properties"]["detail"]["type"],
            "string",
        )


class ValidationErrorResponseTests(TestCase):
    """The generic 400 envelope (#1165, #1124)."""

    def _run(self, path_item):
        result = {"paths": {"/x/": path_item}}
        add_standard_error_responses(result, generator=None, request=None, public=True)
        return result["paths"]["/x/"]

    def test_documents_400_on_body_methods_even_without_a_declared_request_body(self):
        """Views with no serializer have no requestBody, but DRF still parses one."""
        paths = self._run({
            method: {"responses": {"200": {"description": "OK"}}}
            for method in ("post", "put", "patch")
        })
        for method in ("post", "put", "patch"):
            schema = paths[method]["responses"]["400"]["content"]["application/json"]["schema"]
            self.assertEqual(
                [branch["type"] for branch in schema["oneOf"]], ["object", "array"]
            )

    def test_documents_400_on_operations_with_query_parameters(self):
        paths = self._run({
            "get": {
                "parameters": [{"name": "state", "in": "query"}],
                "responses": {"200": {"description": "OK"}},
            },
        })
        self.assertIn("400", paths["get"]["responses"])

    def test_does_not_document_400_where_the_server_cannot_return_one(self):
        """A path-parameter-only lookup either resolves or 404s."""
        paths = self._run({
            "get": {
                "parameters": [{"name": "id", "in": "path"}, {"name": "X", "in": "header"}],
                "responses": {"200": {"description": "OK"}},
            },
            "delete": {"responses": {"204": {"description": "No content"}}},
        })
        self.assertNotIn("400", paths["get"]["responses"])
        self.assertNotIn("400", paths["delete"]["responses"])

    def test_does_not_overwrite_a_declared_400(self):
        custom_400 = {"description": "Specific body", "content": {}}
        paths = self._run({
            "post": {
                "requestBody": {"content": {}},
                "responses": {"200": {"description": "OK"}, "400": custom_400},
            },
        })
        self.assertIs(paths["post"]["responses"]["400"], custom_400)


class GeneratedSchemaDocuments400Tests(TestCase):
    """End-to-end against the real generated schema, not a hand-built dict.

    The fuzz job's baseline used to carry a per-operation entry for every write
    endpoint whose 400 was undocumented, so any seed that reached a new one went
    red. Assert the class is closed at the source.
    """

    def test_every_write_operation_documents_400(self):
        from drf_spectacular.generators import SchemaGenerator

        schema = SchemaGenerator().get_schema(request=None, public=True)
        missing = [
            f"{method.upper()} {path}"
            for path, item in schema["paths"].items()
            for method, op in item.items()
            if method in ("post", "put", "patch")
            and "400" not in op["responses"]
        ]
        self.assertEqual(missing, [])
