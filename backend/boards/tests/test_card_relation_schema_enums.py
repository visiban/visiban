"""CardRelation response fields are published as OpenAPI enums (#1976).

Wire values are unchanged; only the schema gains ``enum`` so the TS parity
gate can see drift. ``direction`` must reuse the request side's
``DirectionEnum`` rather than spawning a hash-suffixed duplicate.
"""

from drf_spectacular.generators import SchemaGenerator
from rest_framework import status
from rest_framework.test import APIClient

from boards.models import CardRelation
from boards.tests.conftest import _make_board, _make_card, _make_column, _make_swimlane, _make_user
from django.test import TestCase


class CardRelationSchemaEnumTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.schemas = SchemaGenerator().get_schema(request=None, public=True)["components"]["schemas"]

    def _ref(self, prop):
        node = self.schemas["CardRelation"]["properties"][prop]
        return (node.get("allOf") or [node])[0]["$ref"].rsplit("/", 1)[-1]

    def test_relation_type_published_as_enum(self):
        name = self._ref("relation_type")
        self.assertEqual(self.schemas[name]["enum"], ["blocks", "relates_to"])

    def test_direction_reuses_request_side_direction_enum(self):
        self.assertEqual(self._ref("direction"), "DirectionEnum")
        # No hash-suffixed twin (e.g. Direction1Enum) from a name collision.
        self.assertEqual([n for n in self.schemas if n.startswith("Direction")], ["DirectionEnum"])
        self.assertEqual(self.schemas["DirectionEnum"]["enum"], ["blocks", "blocked_by", "relates_to"])

    def test_response_values_unchanged(self):
        user = _make_user("rel1976")
        board = _make_board(user)
        col = _make_column(board)
        lane = _make_swimlane(board)
        a = _make_card(col, lane)
        b = _make_card(col, lane, title="B")
        CardRelation.objects.create(from_card=a, to_card=b, relation_type=CardRelation.Type.BLOCKS)
        client = APIClient()
        client.force_authenticate(user)
        res = client.get(f"/api/v1/boards/{board.id}/cards/{b.id}/relations/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        row = res.json()[0]
        self.assertEqual((row["relation_type"], row["direction"]), ("blocks", "blocked_by"))
