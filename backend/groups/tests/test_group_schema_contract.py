"""Schema-vs-response contract test for the group retrieve/list endpoints (#1119).

`GroupSerializer` / `GroupDetailSerializer` have several `SerializerMethodField`s with no
return-type hint, which makes drf-spectacular default their declared schema type to
`string` — a mismatch caught by `backend-schema-fuzz` against a real `GET
/api/v1/groups/{id}/` response (`subgroup_count`, `board_count`, `member_count`, and
`is_starred` are actually int/int/int/bool; `parent_name` is nullable, not just a plain
string). This test generates the real OpenAPI schema via drf-spectacular and validates a
live response against the documented shape, so a future edit that reintroduces the drift
fails locally instead of shipping a wrong contract to schema-generated clients (e.g. the
MCP REST client). Mirrors the pattern in `boards/tests/test_move_schema_contract.py` (#1108).
"""

import jsonschema
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from drf_spectacular.generators import SchemaGenerator

from accounts.models import User
from groups.models import Group, GroupMembership

_GROUP_DETAIL_PATH = "/api/v1/groups/{id}/"
_GROUP_LIST_PATH = "/api/v1/groups/"


def _make_group(owner, name="Group", parent=None):
    group = Group.objects.create(name=name, owner=owner, parent=parent)
    GroupMembership.objects.create(group=group, user=owner, role=GroupMembership.Role.ADMIN)
    return group


def _openapi3_nullable_to_jsonschema(node):
    """Rewrite OpenAPI 3.0's `nullable: true` into vanilla JSON Schema.

    drf-spectacular emits OpenAPI 3.0, which marks a nullable field with a sibling
    `nullable: true` key. The `jsonschema` package only understands JSON Schema's own
    union-type spelling (`type: [<type>, "null"]`) — without this rewrite, a correctly
    nullable field like `parent_name` would fail validation the moment a real response
    returns `null` for a root group.
    """
    if isinstance(node, dict):
        node = {k: _openapi3_nullable_to_jsonschema(v) for k, v in node.items()}
        if node.pop("nullable", False):
            if any(k in node for k in ("$ref", "allOf", "oneOf", "anyOf")):
                return {"anyOf": [node, {"type": "null"}]}
            existing_type = node.get("type")
            if isinstance(existing_type, list):
                if "null" not in existing_type:
                    existing_type = [*existing_type, "null"]
                node["type"] = existing_type
            elif existing_type is not None:
                node["type"] = [existing_type, "null"]
            else:
                node["type"] = "null"
        return node
    if isinstance(node, list):
        return [_openapi3_nullable_to_jsonschema(v) for v in node]
    return node


class GroupSchemaContractTests(TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # Generate once per class: walking every registered view is not cheap enough
        # to repeat per test method.
        cls.schema = SchemaGenerator().get_schema(request=None, public=True)
        cls.detail_operation = cls.schema["paths"][_GROUP_DETAIL_PATH]["get"]
        cls.list_operation = cls.schema["paths"][_GROUP_LIST_PATH]["get"]

    def setUp(self):
        self.client = APIClient()
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.client.force_authenticate(self.owner)

    def _assert_matches_documented_response(self, operation, body, status_code):
        """Validate `body` against the schema documented for `status_code`.

        $ref targets (e.g. `#/components/schemas/GroupDetail`) live under
        `components/schemas` in the *full* document, not the per-response fragment, so
        `components` is embedded alongside the fragment before validating — same-document
        JSON-pointer refs then resolve against it without needing an external resolver.
        """
        responses = operation["responses"]
        self.assertIn(
            str(status_code), responses,
            f"operation does not document a {status_code} response at all",
        )
        fragment = responses[str(status_code)]["content"]["application/json"]["schema"]
        combined = {**fragment, "components": self.schema["components"]}
        combined = _openapi3_nullable_to_jsonschema(combined)
        jsonschema.validate(instance=body, schema=combined)

    def test_retrieve_root_group_response_matches_documented_schema(self):
        """A root group (no parent) exercises `parent_name`'s null case."""
        group = _make_group(self.owner, name="Root Group")

        resp = self.client.get(f"/api/v1/groups/{group.id}/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        body = resp.json()
        self.assertIsNone(body["parent_name"])
        self._assert_matches_documented_response(self.detail_operation, body, 200)

    def test_retrieve_subgroup_response_matches_documented_schema(self):
        """A subgroup exercises `parent_name`'s non-null string case, plus the int/bool
        counts (`board_count`, `member_count`, `subgroup_count`, `is_starred`)."""
        parent = _make_group(self.owner, name="Parent Group")
        child = _make_group(self.owner, name="Child Group", parent=parent)

        resp = self.client.get(f"/api/v1/groups/{child.id}/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        body = resp.json()
        self.assertEqual(body["parent_name"], "Parent Group")
        self.assertIsInstance(body["board_count"], int)
        self.assertIsInstance(body["member_count"], int)
        self.assertIsInstance(body["subgroup_count"], int)
        self.assertIsInstance(body["is_starred"], bool)
        self._assert_matches_documented_response(self.detail_operation, body, 200)

    def test_list_groups_response_matches_documented_schema(self):
        """The list endpoint uses the plain `GroupSerializer`, not `GroupDetailSerializer`
        — cover it separately since it's a different schema/response path."""
        _make_group(self.owner, name="Listed Group")

        resp = self.client.get("/api/v1/groups/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        body = resp.json()
        self.assertTrue(body["results"])
        self._assert_matches_documented_response(self.list_operation, body, 200)
