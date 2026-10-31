"""A NUL in a free-text query parameter is a 400, not a 500 (#1887, #1975).

Covers ``search`` on the board card list (and card detail routes), ``GET /cards/``,
``GET /admin/users/`` and ``GET /users/``, and ``exclude_type`` on board movements.

PostgreSQL cannot compare a text value containing NUL (0x00), so
``?search=a%00b`` reached ``title__icontains`` and raised ``DataError``: an
unhandled 500. #1887/#1975 published ``search`` and ``exclude_type`` in the
OpenAPI schema, which puts them in front of ``backend-schema-fuzz`` (it
generates NUL by default). ``query_text()`` refuses the value with the
bad-query-param shape before it reaches the ORM.

The 400 is asserted on any database. SQLite would not 500 on the NUL, so the
refusal itself is what is pinned, plus the declared 400 schema of each
operation.
"""

import jsonschema
from django.test import RequestFactory, SimpleTestCase, TestCase
from drf_spectacular.generators import SchemaGenerator
from rest_framework.request import Request
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, CardMovement, Column, Swimlane
from visiban.exceptions import CodedValidationError
from visiban.request_shape import query_text

CODE = "invalid_query_param"
NUL = "a\x00b"


class QueryTextUnitTests(SimpleTestCase):
    def _request(self, **params):
        return Request(RequestFactory().get("/", params))

    def test_absent_is_empty_string(self):
        self.assertEqual(query_text(self._request(), "search"), "")

    def test_value_is_returned_unstripped(self):
        self.assertEqual(query_text(self._request(search="  hi "), "search"), "  hi ")

    def test_nul_is_refused_with_the_coded_shape(self):
        with self.assertRaises(CodedValidationError) as ctx:
            query_text(self._request(search=NUL), "search")
        self.assertEqual(
            ctx.exception.detail,
            {"code": CODE, "detail": "search must not contain NUL (0x00) characters."},
        )


class NulQueryParamEndpointTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = User.objects.create_user(username="nul-owner", password="pass")
        cls.admin = User.objects.create_user(
            username="nul-admin", password="pass", is_staff=True, is_superuser=True,
        )
        cls.board = Board.objects.create(name="B", owner=cls.user)
        BoardMembership.objects.create(board=cls.board, user=cls.user, role=BoardMembership.Role.ADMIN)
        col = Column.objects.create(board=cls.board, name="C", position=0)
        swim = Swimlane.objects.create(board=cls.board, name="S", position=0)
        cls.card = Card.objects.create(board=cls.board, column=col, swimlane=swim, title="findme")
        CardMovement.objects.create(card=cls.card, to_column=col, to_swimlane=swim, moved_by=cls.user)
        b = cls.board.id
        # (schema path, url, param, user)
        cls.cases = [
            ("/api/v1/boards/{board_pk}/cards/", f"/api/v1/boards/{b}/cards/", "search", cls.user),
            ("/api/v1/cards/", "/api/v1/cards/", "search", cls.user),
            ("/api/v1/admin/users/", "/api/v1/admin/users/", "search", cls.admin),
            ("/api/v1/boards/{id}/movements/", f"/api/v1/boards/{b}/movements/", "exclude_type", cls.user),
            ("/api/v1/users/", "/api/v1/users/", "search", cls.user),
        ]

    def _get(self, url, params, user):
        client = APIClient(raise_request_exception=False)
        client.force_authenticate(user)
        return client.get(url, params)

    def test_nul_is_a_coded_400_matching_the_declared_schema(self):
        schema = SchemaGenerator().get_schema(request=None, public=True)
        for path, url, param, user in self.cases:
            with self.subTest(url=url, param=param):
                r = self._get(url, {param: NUL}, user)
                self.assertEqual(r.status_code, 400, r.content)
                self.assertEqual(
                    r.json(),
                    {"code": CODE, "detail": f"{param} must not contain NUL (0x00) characters."},
                )
                declared = schema["paths"][path]["get"]["responses"]["400"]
                body_schema = declared["content"]["application/json"]["schema"]
                if "$ref" in body_schema:
                    body_schema = schema["components"]["schemas"][body_schema["$ref"].rsplit("/", 1)[-1]]
                jsonschema.validate(r.json(), body_schema)

    def test_non_member_still_gets_404_before_the_search_check(self):
        # The board card list resolves access first, so the query string never
        # tells a non-member anything about a board they cannot see.
        outsider = User.objects.create_user(username="nul-outsider", password="pass")
        r = self._get(f"/api/v1/boards/{self.board.id}/cards/", {"search": NUL}, outsider)
        self.assertEqual(r.status_code, 404)

    def test_detail_route_refuses_nul_search_too(self):
        # CardViewSet.get_queryset() serves retrieve as well as list.
        r = self._get(f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/", {"search": NUL}, self.user)
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["code"], CODE)

    def test_ordinary_values_behave_as_before(self):
        b = self.board.id
        r = self._get(f"/api/v1/boards/{b}/cards/", {"search": " findme "}, self.user)
        self.assertEqual([c["id"] for c in r.json()], [self.card.id])
        r = self._get("/api/v1/cards/", {"search": "findme"}, self.user)
        self.assertEqual([c["id"] for c in r.json()["results"]], [self.card.id])
        r = self._get("/api/v1/admin/users/", {"search": "nul-own"}, self.admin)
        self.assertEqual([u["username"] for u in r.json()["results"]], ["nul-owner"])
        r = self._get(f"/api/v1/boards/{b}/movements/", {"exclude_type": "move"}, self.user)
        self.assertEqual(r.json()["count"], 0)
        r = self._get(f"/api/v1/boards/{b}/movements/", {"exclude_type": " "}, self.user)
        self.assertEqual(r.json()["count"], 1)
        r = self._get("/api/v1/users/", {"search": " nul-ad "}, self.user)
        self.assertEqual([u["username"] for u in r.json()], ["nul-admin"])
        r = self._get("/api/v1/users/", {"search": "n"}, self.user)
        self.assertEqual(r.json(), [])

    def test_user_search_declares_search_and_its_real_200(self):
        # UserSearchView (#1887 follow-through): search was parsed by hand and
        # never published, and the 200 read "No response body".
        schema = SchemaGenerator().get_schema(request=None, public=True)
        op = schema["paths"]["/api/v1/users/"]["get"]
        # The operationId shipped in 1.1; a list response must not rename it.
        self.assertEqual(op["operationId"], "api_v1_users_retrieve")
        params = {p["name"]: p for p in op["parameters"] if p["in"] == "query"}
        self.assertEqual(params["search"]["schema"], {"type": "string"})
        self.assertFalse(params["search"].get("required", False))
        body_schema = op["responses"]["200"]["content"]["application/json"]["schema"]
        body_schema = {**body_schema, "components": schema["components"]}
        r = self._get("/api/v1/users/", {"search": "nul-ad"}, self.user)
        self.assertEqual(len(r.json()), 1)
        jsonschema.validate(r.json(), body_schema)
