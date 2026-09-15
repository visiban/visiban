"""Schema-vs-response contract test for the card `move` action (#1108).

`@extend_schema` on ``CardViewSet.move`` is hand-written — nothing forces it
to stay in sync with what the view actually returns. This test generates the
real OpenAPI schema via drf-spectacular and validates live API responses
against the documented request/response shapes, so a future edit to `move`
that drifts from its schema (or vice versa) fails a test instead of shipping
a wrong contract to schema-generated clients (Second Chair, the MCP REST
client — see #1108, #511).
"""

import jsonschema
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient
from unittest.mock import patch

from drf_spectacular.generators import SchemaGenerator

from accounts.models import User
from boards.models import Card, Column, Swimlane
from boards.tests.conftest import _make_board

_MOVE_PATH = "/api/v1/boards/{board_pk}/cards/{id}/move/"


def _openapi3_nullable_to_jsonschema(node):
    """Rewrite OpenAPI 3.0's `nullable: true` into vanilla JSON Schema.

    drf-spectacular emits OpenAPI 3.0, which marks a nullable field with a
    sibling `nullable: true` key. The `jsonschema` package only understands
    JSON Schema's own union-type spelling (`type: [<type>, "null"]`) — it has
    no idea what `nullable` means and rejects every `None` value even when
    the schema is correct. Without this rewrite, every nullable field in the
    real API response (e.g. `due_date`, `assignee`) would fail validation
    for being "wrong" when the schema actually documents it correctly.
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


class MoveSchemaContractTests(TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # Generate once per class: walking every registered view is not cheap
        # enough to repeat per test method.
        cls.schema = SchemaGenerator().get_schema(request=None, public=True)
        cls.move_operation = cls.schema["paths"][_MOVE_PATH]["post"]

    def setUp(self):
        self._broadcast_patcher = patch("boards.broadcast.broadcast_board_event")
        self._broadcast_patcher.start()

        self.client = APIClient()
        self.user = User.objects.create_user(username="tester", password="pass")
        self.client.force_authenticate(self.user)

        self.board = _make_board(self.user)
        self.col_a = Column.objects.create(board=self.board, name="Backlog", position=0)
        self.col_b = Column.objects.create(board=self.board, name="In Progress", position=1)
        self.swim_x = Swimlane.objects.create(board=self.board, name="Acme", position=0)

        self.card = Card.objects.create(
            board=self.board,
            column=self.col_a,
            swimlane=self.swim_x,
            title="Test Card",
            created_by=self.user,
            position=0,
        )

    def tearDown(self):
        self._broadcast_patcher.stop()

    def _move_url(self):
        return f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/move/"

    def _assert_matches_documented_response(self, body, status_code):
        """Validate `body` against the schema documented for `status_code`.

        $ref targets (e.g. `#/components/schemas/CardMoveResponse`) live
        under `components/schemas` in the *full* document, not the per-
        response fragment, so `components` is embedded alongside the
        fragment before validating — same-document JSON-pointer refs then
        resolve against it without needing an external resolver/registry.
        """
        responses = self.move_operation["responses"]
        self.assertIn(
            str(status_code), responses,
            f"move's @extend_schema does not document a {status_code} response at all",
        )
        fragment = responses[str(status_code)]["content"]["application/json"]["schema"]
        combined = {**fragment, "components": self.schema["components"]}
        combined = _openapi3_nullable_to_jsonschema(combined)
        jsonschema.validate(instance=body, schema=combined)

    def test_move_to_new_column_response_matches_documented_schema(self):
        """A column change returns {card, movement} — both keys must validate."""
        resp = self.client.post(self._move_url(), {
            "column_id": self.col_b.pk,
            "swimlane_id": self.swim_x.pk,
            "position": 0,
        })
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        body = resp.json()
        self.assertIn("card", body)
        self.assertIn("movement", body)
        self._assert_matches_documented_response(body, 200)

    def test_reorder_without_column_change_response_matches_documented_schema(self):
        """A pure position reorder omits `movement` — schema marks it optional."""
        Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.swim_x,
            title="Card 2", created_by=self.user, position=1,
        )
        resp = self.client.post(self._move_url(), {
            "column_id": self.col_a.pk,
            "swimlane_id": self.swim_x.pk,
            "position": 1,
        })
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        body = resp.json()
        self.assertNotIn("movement", body)
        self._assert_matches_documented_response(body, 200)

    def test_version_conflict_response_matches_documented_409_schema(self):
        stale_version = self.card.version + 1
        resp = self.client.post(self._move_url(), {
            "column_id": self.col_b.pk,
            "swimlane_id": self.swim_x.pk,
            "position": 0,
            "version": stale_version,
        })
        self.assertEqual(resp.status_code, status.HTTP_409_CONFLICT)
        body = resp.json()
        self.assertEqual(body["code"], "version_conflict")
        self._assert_matches_documented_response(body, 409)

    def test_non_integer_version_response_matches_documented_400_schema(self):
        resp = self.client.post(self._move_url(), {
            "column_id": self.col_b.pk,
            "swimlane_id": self.swim_x.pk,
            "position": 0,
            "version": "not-a-number",
        })
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self._assert_matches_documented_response(resp.json(), 400)

    def test_wip_limit_exceeded_response_matches_documented_409_schema(self):
        self.col_b.wip_limit = 0
        self.col_b.save(update_fields=["wip_limit"])
        self.board.enforce_wip_limits = True
        self.board.save(update_fields=["enforce_wip_limits"])

        resp = self.client.post(self._move_url(), {
            "column_id": self.col_b.pk,
            "swimlane_id": self.swim_x.pk,
            "position": 0,
        })
        self.assertEqual(resp.status_code, status.HTTP_409_CONFLICT)
        body = resp.json()
        self.assertEqual(body["code"], "wip_limit_exceeded")
        self._assert_matches_documented_response(body, 409)
