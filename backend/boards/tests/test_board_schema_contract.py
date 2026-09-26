"""Schema-vs-response contract tests for Board and CurrentUser (#1123).

Same technique as ``test_move_schema_contract.py`` (#1108): generate the real
OpenAPI document and validate live responses against it, so a serializer field
whose declared type drifts from what it actually returns (an un-hinted
``SerializerMethodField`` defaults to ``string``; a null-returning
``CharField`` needs ``allow_null``) fails a test instead of shipping a wrong
contract to schema-generated clients.
"""

from typing import get_type_hints

import jsonschema
from django.test import TestCase
from drf_spectacular.generators import SchemaGenerator
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.serializers import BoardFullSerializer, BoardSerializer
from boards.tests.conftest import _make_board
from boards.tests.test_move_schema_contract import _openapi3_nullable_to_jsonschema
from groups.models import Group


class BoardSchemaContractTests(TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.schema = SchemaGenerator().get_schema(request=None, public=True)

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="tester", password="pass")
        self.client.force_authenticate(self.user)

    def _assert_valid(self, body, schema_fragment):
        combined = {**schema_fragment, "components": self.schema["components"]}
        combined = _openapi3_nullable_to_jsonschema(combined)
        jsonschema.validate(instance=body, schema=combined)

    def _response_schema(self, path, method="get", status_code="200"):
        op = self.schema["paths"][path][method]
        return op["responses"][status_code]["content"]["application/json"]["schema"]

    def test_board_detail_without_group_matches_schema(self):
        """group_name/group_detail are null (not absent) for an ungrouped board."""
        board = _make_board(self.user)
        resp = self.client.get(f"/api/v1/boards/{board.pk}/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        body = resp.json()
        self.assertIsNone(body["group_name"])
        self.assertIsNone(body["group_detail"])
        self.assertIsInstance(body["is_starred"], bool)
        self.assertIsInstance(body["member_count"], int)
        self.assertIsInstance(body["card_count"], int)
        self._assert_valid(body, self._response_schema("/api/v1/boards/{id}/"))

    def test_board_detail_with_group_matches_schema(self):
        board = _make_board(self.user)
        board.group = Group.objects.create(name="Team", owner=self.user)
        board.save(update_fields=["group"])
        resp = self.client.get(f"/api/v1/boards/{board.pk}/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.json()["group_name"], "Team")
        self._assert_valid(resp.json(), self._response_schema("/api/v1/boards/{id}/"))

    def test_board_list_matches_schema(self):
        _make_board(self.user)
        resp = self.client.get("/api/v1/boards/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self._assert_valid(resp.json(), self._response_schema("/api/v1/boards/"))

    def test_board_full_redeclared_fields_are_typed(self):
        """BoardFull redeclares Board's fields; they must be typed there too.

        `/full/` is documented against `Board` today, so `BoardFull` never
        reaches the generated schema and cannot be checked through it. Assert
        on the serializer's own declarations (what drf-spectacular reads) and
        on the live value's type instead.
        """
        board = _make_board(self.user)
        resp = self.client.get(f"/api/v1/boards/{board.pk}/full/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertIsInstance(resp.json()["is_starred"], bool)
        self.assertIsNone(resp.json()["group_name"])

        self.assertIs(get_type_hints(BoardFullSerializer.get_is_starred)["return"], bool)
        fields = BoardFullSerializer().fields
        self.assertTrue(fields["group_name"].allow_null)
        self.assertTrue(BoardSerializer().fields["group_name"].allow_null)
        # extend_schema_field stores its override on the decorated method.
        self.assertTrue(hasattr(BoardFullSerializer.get_group_detail, "_spectacular_annotation"))

    def test_current_user_matches_schema(self):
        resp = self.client.get("/api/v1/auth/user/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        body = resp.json()
        for key in ("git_lens_enabled", "has_usable_password", "uploads_enabled"):
            self.assertIsInstance(body[key], bool, key)
        self._assert_valid(body, self._response_schema("/api/v1/auth/user/"))

    def test_board_create_response_matches_schema(self):
        """POST /boards/ was baselined for the same Board field drift."""
        resp = self.client.post("/api/v1/boards/", {"name": "Fresh"}, format="json")
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self._assert_valid(
            resp.json(), self._response_schema("/api/v1/boards/", "post", "201")
        )

    def test_board_star_toggle_response_matches_schema(self):
        """POST /boards/{id}/star/ was baselined for the same Board field drift."""
        board = _make_board(self.user)
        resp = self.client.post(f"/api/v1/boards/{board.pk}/star/")
        self.assertIn(resp.status_code, (status.HTTP_200_OK, status.HTTP_201_CREATED))
        code = str(resp.status_code)
        op = self.schema["paths"]["/api/v1/boards/{id}/star/"]["post"]
        self.assertIn(code, op["responses"])
        self._assert_valid(
            resp.json(), self._response_schema("/api/v1/boards/{id}/star/", "post", code)
        )

    def test_current_user_patch_matches_schema(self):
        resp = self.client.patch("/api/v1/auth/user/", {"first_name": "Ada"}, format="json")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self._assert_valid(
            resp.json(), self._response_schema("/api/v1/auth/user/", "patch")
        )
