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
