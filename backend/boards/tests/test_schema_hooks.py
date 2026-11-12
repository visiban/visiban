"""Tests for visiban.schema_hooks (#1080).

The hook documents the standard DRF error envelope ({"detail": <string>}) on
every operation so schemathesis's response_schema_conformance check has
something to validate a 401/403/404/429 against instead of silently ignoring
an undocumented error response.
"""
from django.test import TestCase

from visiban.schema_hooks import (
    _ERROR_ENVELOPE_SCHEMA,
    _PRE_VIEW_DETAIL_400_SCHEMA,
    _PRE_VIEW_FIELD_400_SCHEMA,
    _VALIDATION_ERROR_DESCRIPTION,
    _VALIDATION_ERROR_SCHEMA,
    add_standard_error_responses,
    mark_deprecated_fields,
)


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

    def test_documents_400_on_a_path_only_lookup(self):
        """A query string over the field limit is a JSON 400 on any operation (#2140)."""
        paths = self._run({
            "get": {
                "parameters": [{"name": "id", "in": "path"}, {"name": "X", "in": "header"}],
                "responses": {"200": {"description": "OK"}},
            },
            "delete": {"responses": {"204": {"description": "No content"}}},
        })
        self.assertIn("400", paths["get"]["responses"])
        self.assertIn("400", paths["delete"]["responses"])

    def test_keeps_a_declared_400_and_fills_in_missing_content(self):
        """A description-only 400 keeps its description and gains the body (#2178)."""
        custom_400 = {"description": "Specific body"}
        paths = self._run({
            "post": {"responses": {"200": {"description": "OK"}, "400": custom_400}},
        })
        self.assertIs(paths["post"]["responses"]["400"], custom_400)
        self.assertEqual(custom_400["description"], "Specific body")
        self.assertEqual(
            custom_400["content"]["application/json"]["schema"], _VALIDATION_ERROR_SCHEMA
        )

    def test_fills_in_an_empty_json_media_type(self):
        custom_400 = {"description": "x", "content": {"application/json": {}}}
        self._run({"delete": {"responses": {"400": custom_400}}})
        self.assertEqual(
            custom_400["content"]["application/json"]["schema"], _VALIDATION_ERROR_SCHEMA
        )


class WidenDeclared400Tests(TestCase):
    """A declared 400 also admits the 400s raised before the view runs (#2178)."""

    BOTH = [_PRE_VIEW_DETAIL_400_SCHEMA, _PRE_VIEW_FIELD_400_SCHEMA]

    def _widen(self, schema, method="post", **operation):
        response = {"description": "Declared", "content": {"application/json": {"schema": schema}}}
        result = {"paths": {"/x/": {method: {**operation, "responses": {"400": response}}}}}
        add_standard_error_responses(result, generator=None, request=None, public=True)
        return response["content"]["application/json"]["schema"]

    def test_wraps_a_ref_keeping_it_first(self):
        ref = {"$ref": "#/components/schemas/CardMoveVersionTypeError"}
        self.assertEqual(self._widen(dict(ref)), {"anyOf": [ref, *self.BOTH]})

    def test_wraps_an_inline_schema_on_every_body_method_and_delete(self):
        inline = {"type": "object", "properties": {"detail": {"type": "string"}}, "required": ["detail"]}
        for method in ("post", "put", "patch", "delete"):
            self.assertEqual(self._widen(dict(inline), method), {"anyOf": [inline, *self.BOTH]})

    def test_a_get_gains_only_the_detail_branch(self):
        """No GET view reads a body, so no field-keyed parser 400 (#1832 stays strict)."""
        ref = {"$ref": "#/components/schemas/BoardAnalyticsBadRequest"}
        self.assertEqual(self._widen(dict(ref), "get"), {"anyOf": [ref, _PRE_VIEW_DETAIL_400_SCHEMA]})

    def test_a_get_with_a_request_body_gains_both(self):
        ref = {"$ref": "#/components/schemas/X"}
        self.assertEqual(
            self._widen(dict(ref), "get", requestBody={"content": {}}), {"anyOf": [ref, *self.BOTH]}
        )

    def test_wraps_a_declared_one_of_rather_than_merging_into_it(self):
        one_of = {"oneOf": [{"type": "string"}, {"type": "integer"}]}
        self.assertEqual(self._widen(dict(one_of)), {"anyOf": [one_of, *self.BOTH]})

    def test_extends_a_declared_any_of_without_nesting(self):
        any_of = {"anyOf": [{"type": "string"}, _PRE_VIEW_DETAIL_400_SCHEMA]}
        self.assertEqual(self._widen(any_of), {"anyOf": [{"type": "string"}, *self.BOTH]})

    def test_is_idempotent(self):
        ref = {"$ref": "#/components/schemas/X"}
        response = {"description": "d", "content": {"application/json": {"schema": ref}}}
        result = {"paths": {"/x/": {"post": {"responses": {"400": response}}}}}
        for _ in range(2):
            add_standard_error_responses(result, generator=None, request=None, public=True)
        self.assertEqual(
            response["content"]["application/json"]["schema"], {"anyOf": [ref, *self.BOTH]}
        )

    def test_leaves_the_validation_error_schema_itself_alone(self):
        self.assertEqual(self._widen(dict(_VALIDATION_ERROR_SCHEMA)), _VALIDATION_ERROR_SCHEMA)

    def test_leaves_other_media_types_alone(self):
        html = {"schema": {"type": "string"}}
        response = {"description": "d", "content": {"text/html": html}}
        result = {"paths": {"/x/": {"post": {"responses": {"400": response}}}}}
        add_standard_error_responses(result, generator=None, request=None, public=True)
        self.assertIs(response["content"]["text/html"], html)
        self.assertEqual(
            response["content"]["application/json"]["schema"], _VALIDATION_ERROR_SCHEMA
        )

    def test_pre_view_branches_stay_constrained(self):
        """The branches admit the parser's bodies and nothing much wider."""
        from jsonschema import Draft7Validator

        detail = Draft7Validator(_PRE_VIEW_DETAIL_400_SCHEMA)
        field = Draft7Validator(_PRE_VIEW_FIELD_400_SCHEMA)
        self.assertTrue(detail.is_valid({"detail": "JSON parse error - x"}))
        self.assertTrue(field.is_valid({"Hgg": ["Surrogate characters are not allowed: U+DBFF."]}))
        for body in ({"detail": "x", "code": "other"}, {"detail": 5}, {}, ["x"]):
            self.assertFalse(detail.is_valid(body), body)
        for body in ({"offset": "x"}, {}, {"detail": "x"}, ["x"]):
            self.assertFalse(field.is_valid(body), body)


class GeneratedSchemaDocuments400Tests(TestCase):
    """End-to-end against the real generated schema, not a hand-built dict.

    The fuzz job's baseline used to carry a per-operation entry for every write
    endpoint whose 400 was undocumented, so any seed that reached a new one went
    red. Assert the class is closed at the source.
    """

    def test_every_operation_documents_400(self):
        from drf_spectacular.generators import SchemaGenerator

        schema = SchemaGenerator().get_schema(request=None, public=True)
        operations = [
            (method, path, op)
            for path, item in schema["paths"].items()
            for method, op in item.items()
            if method in ("get", "post", "put", "patch", "delete")
        ]
        # An empty ``paths`` must not pass vacuously.
        self.assertTrue(operations)
        missing = [
            f"{method.upper()} {path}"
            for method, path, op in operations
            if "400" not in op["responses"]
        ]
        self.assertEqual(missing, [])

    def test_every_400_accepts_the_bodies_raised_before_the_view(self):
        """Each 400, declared or not, admits the parser's and limits' bodies (#2178).

        ``StrictJSONParser`` names a surrogate-bearing field (even one the
        serializer ignores, the fuzzer's random ``Hgg``) on any operation that
        reads a body, and a malformed body, a refused charset or an oversize
        query string answers ``{"detail"}`` on any operation.
        Before #2178 an explicit 400 such as move's ``CardMoveVersionTypeError``
        rejected the first and an ``InviteEmailBadRequest`` rejected the second.
        """
        from drf_spectacular.generators import SchemaGenerator
        from jsonschema import Draft7Validator

        schema = SchemaGenerator().get_schema(request=None, public=True)
        detail = {"detail": "JSON parse error - Expecting value: line 1 column 1 (char 0)"}
        field = {"Hgg": ["Surrogate characters are not allowed: U+DBFF."]}
        rejected, declared = [], 0
        for path, item in schema["paths"].items():
            for method, op in item.items():
                if method not in ("get", "post", "put", "patch", "delete"):
                    continue
                response = op["responses"]["400"]
                if response["description"] != _VALIDATION_ERROR_DESCRIPTION:
                    declared += 1
                body_schema = response.get("content", {}).get("application/json", {}).get("schema")
                if body_schema is None:
                    rejected.append(f"{method.upper()} {path} documents no JSON 400 body")
                    continue
                validator = Draft7Validator(
                    {**body_schema, "components": schema.get("components", {})}
                )
                # A GET reads no body, so only the {"detail"} 400s reach it.
                bodies = (detail,) if method == "get" and "requestBody" not in op else (detail, field)
                rejected += [
                    f"{method.upper()} {path} rejects {body!r}"
                    for body in bodies
                    if not validator.is_valid(body)
                ]
        # The explicit-400 class must be present, or this passes vacuously.
        self.assertGreater(declared, 20)
        self.assertEqual(rejected, [])

    def test_move_keeps_its_declared_400_documented(self):
        from drf_spectacular.generators import SchemaGenerator

        schema = SchemaGenerator().get_schema(request=None, public=True)
        op = schema["paths"]["/api/v1/boards/{board_pk}/cards/{id}/move/"]["post"]
        body_schema = op["responses"]["400"]["content"]["application/json"]["schema"]
        self.assertEqual(
            body_schema,
            {
                "anyOf": [
                    {"$ref": "#/components/schemas/CardMoveVersionTypeError"},
                    _PRE_VIEW_DETAIL_400_SCHEMA,
                    _PRE_VIEW_FIELD_400_SCHEMA,
                ]
            },
        )


class WidenDeclaredAuthErrorTests(TestCase):
    """A declared 401/403 also admits DRF's ``{"detail"}`` refusal (#2181)."""

    def _widen(self, status, schema):
        response = {"description": "Declared", "content": {"application/json": {"schema": schema}}}
        result = {"paths": {"/x/": {"post": {"responses": {status: response}}}}}
        add_standard_error_responses(result, generator=None, request=None, public=True)
        return response["content"]["application/json"]["schema"]

    def test_wraps_a_declared_403_keeping_it_first(self):
        ref = {"$ref": "#/components/schemas/BoardJoinRecipientMismatch"}
        for status in ("401", "403"):
            self.assertEqual(
                self._widen(status, dict(ref)),
                {"anyOf": [ref, _PRE_VIEW_DETAIL_400_SCHEMA]},
            )

    def test_extends_an_any_of_once_and_is_idempotent(self):
        schema = self._widen("403", {"anyOf": [{"type": "string"}]})
        self.assertEqual(schema, {"anyOf": [{"type": "string"}, _PRE_VIEW_DETAIL_400_SCHEMA]})
        response = {"content": {"application/json": {"schema": schema}}}
        result = {"paths": {"/x/": {"post": {"responses": {"403": response}}}}}
        add_standard_error_responses(result, generator=None, request=None, public=True)
        self.assertEqual(len(schema["anyOf"]), 2)

    def test_leaves_the_plain_envelope_and_other_statuses_alone(self):
        self.assertEqual(self._widen("403", dict(_ERROR_ENVELOPE_SCHEMA)), _ERROR_ENVELOPE_SCHEMA)
        self.assertEqual(self._widen("404", {"type": "string"}), {"type": "string"})


class GeneratedSchemaAuthErrorsTests(TestCase):
    def test_every_401_and_403_accepts_a_detail_body(self):
        """Every operation's 401/403 admits ``{"detail": "x"}`` (#2181)."""
        from drf_spectacular.generators import SchemaGenerator
        from jsonschema import Draft7Validator

        schema = SchemaGenerator().get_schema(request=None, public=True)
        rejected, declared = [], 0
        for path, item in schema["paths"].items():
            for method, op in item.items():
                if method not in ("get", "post", "put", "patch", "delete"):
                    continue
                for status in ("401", "403"):
                    response = op["responses"].get(status)
                    if response is None:
                        continue
                    body_schema = response.get("content", {}).get("application/json", {}).get("schema")
                    if body_schema is None:
                        continue
                    if body_schema != _ERROR_ENVELOPE_SCHEMA:
                        declared += 1
                    validator = Draft7Validator(
                        {**body_schema, "components": schema.get("components", {})}
                    )
                    if not validator.is_valid({"detail": "x"}):
                        rejected.append(f"{method.upper()} {path} {status}")
        self.assertGreater(declared, 0)  # the coded join 403s must be present
        self.assertEqual(rejected, [])

    def test_join_keeps_its_coded_403_documented(self):
        from drf_spectacular.generators import SchemaGenerator

        schema = SchemaGenerator().get_schema(request=None, public=True)
        for path, name in (
            ("/api/v1/boards/join/{token}/", "BoardJoinRecipientMismatch"),
            ("/api/v1/groups/join/{token}/", "GroupJoinRecipientMismatch"),
        ):
            body = schema["paths"][path]["post"]["responses"]["403"]["content"]["application/json"]["schema"]
            self.assertEqual(
                body,
                {"anyOf": [{"$ref": f"#/components/schemas/{name}"}, _PRE_VIEW_DETAIL_400_SCHEMA]},
            )


class PinNamedEnumsTests(TestCase):
    """visiban.schema_hooks.pin_named_enums (#1137)."""

    def _generator(self):
        from types import SimpleNamespace

        from drf_spectacular.plumbing import ComponentRegistry
        return SimpleNamespace(registry=ComponentRegistry())

    def _result(self, role_prop, current_prop=None):
        schemas = {"EffectiveBoardMember": {"type": "object", "properties": {"role": role_prop}}}
        if current_prop is not None:
            schemas["BoardFull"] = {"type": "object", "properties": {"current_user_role": current_prop}}
        return {"components": {"schemas": schemas}}

    def test_lifts_inline_enum_into_named_component(self):
        from visiban.schema_hooks import pin_named_enums
        gen = self._generator()
        result = self._result({"type": "string", "enum": ["admin", "site_admin"], "readOnly": True})
        pin_named_enums(result, gen, None, True)
        prop = result["components"]["schemas"]["EffectiveBoardMember"]["properties"]["role"]
        self.assertEqual(prop, {
            "readOnly": True, "allOf": [{"$ref": "#/components/schemas/EffectiveBoardRoleEnum"}],
        })
        built = gen.registry.build({})
        self.assertEqual(built["schemas"]["EffectiveBoardRoleEnum"], {"enum": ["admin", "site_admin"], "type": "string"})

    def test_nullable_enum_gets_null_branch(self):
        from visiban.schema_hooks import pin_named_enums
        gen = self._generator()
        enum = {"type": "string", "enum": ["admin", "site_admin"]}
        result = self._result(dict(enum), {**enum, "enum": ["admin", "site_admin", None], "nullable": True})
        pin_named_enums(result, gen, None, True)
        prop = result["components"]["schemas"]["BoardFull"]["properties"]["current_user_role"]
        self.assertTrue(prop["nullable"])
        self.assertEqual(prop["oneOf"], [
            {"$ref": "#/components/schemas/EffectiveBoardRoleEnum"},
            {"$ref": "#/components/schemas/NullEnum"},
        ])

    def test_conflicting_choice_sets_for_one_name_raise(self):
        from visiban.schema_hooks import pin_named_enums
        result = self._result({"type": "string", "enum": ["admin"]}, {"type": "string", "enum": ["viewer"]})
        with self.assertRaises(ValueError):
            pin_named_enums(result, self._generator(), None, True)

    def test_missing_or_already_referenced_property_is_left_alone(self):
        from visiban.schema_hooks import pin_named_enums
        ref = {"allOf": [{"$ref": "#/components/schemas/Whatever"}]}
        result = self._result(dict(ref))
        pin_named_enums(result, self._generator(), None, True)
        self.assertEqual(result["components"]["schemas"]["EffectiveBoardMember"]["properties"]["role"], ref)


class MarkDeprecatedFieldsTests(TestCase):
    """#1869: only the feed's superseded ``next`` is flagged deprecated."""

    def test_flags_only_the_feed_next_property(self):
        result = {
            "components": {"schemas": {
                "BoardEventFeedPage": {"properties": {"next": {"type": "integer"}, "next_cursor": {"type": "integer"}}},
                "CardTimelinePage": {"properties": {"next": {"type": "string"}}},
            }},
        }

        mark_deprecated_fields(result, generator=None, request=None, public=True)

        schemas = result["components"]["schemas"]
        self.assertTrue(schemas["BoardEventFeedPage"]["properties"]["next"]["deprecated"])
        self.assertNotIn("deprecated", schemas["BoardEventFeedPage"]["properties"]["next_cursor"])
        self.assertNotIn("deprecated", schemas["CardTimelinePage"]["properties"]["next"])

    def test_missing_component_or_property_is_a_no_op(self):
        for result in (
            {},
            {"components": {"schemas": {}}},
            {"components": {"schemas": {"BoardEventFeedPage": {"properties": {}}}}},
        ):
            before = repr(result)
            self.assertIs(mark_deprecated_fields(result, None, None, True), result)
            self.assertEqual(repr(result), before)
