"""OpenAPI contract for the hand-parsed ``expand`` and ``starred`` query params (#2031).

``BoardViewSet`` and ``GroupViewSet`` read both with ``request.query_params.get()``,
so no filter backend or paginator publishes them and the generated schema left
them out. Generated clients and ``backend-schema-fuzz`` read only what the schema
declares, so each one is asserted by name, with the type the view parses.

``expand`` is asserted on every operation that renders a serializer gated by
``_expand_requested`` (``BoardSerializer`` / ``BoardFullSerializer``), which is the
set ``docs/api/index.md`` documents, not only the three the issue lists.
"""

import contextlib
import io

from django.test import TestCase
from drf_spectacular.generators import SchemaGenerator

_BOARDS = "/api/v1/boards/"
_BOARD = "/api/v1/boards/{id}/"
_BOARD_FULL = "/api/v1/boards/{id}/full/"
_GROUPS = "/api/v1/groups/"
_GROUP_BOARDS = "/api/v1/groups/{id}/boards/"

_STR = {"type": "string"}
_BOOL = {"type": "boolean"}


class HandParsedQueryParameterSchemaTests(TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # drf-spectacular reports its warnings on stderr, not via logging.
        with contextlib.redirect_stderr(io.StringIO()):
            cls.schema = SchemaGenerator().get_schema(request=None, public=True)

    def _query_params(self, path, method="get"):
        operation = self.schema["paths"][path][method]
        return {p["name"]: p for p in operation.get("parameters", []) if p["in"] == "query"}

    def _assert_schemas(self, path, expected, method="get"):
        params = self._query_params(path, method)
        for name, schema in expected.items():
            with self.subTest(path=path, method=method, param=name):
                self.assertIn(name, params)
                self.assertEqual(params[name]["schema"], schema)
                self.assertFalse(params[name].get("required", False))
                self.assertTrue(params[name].get("description"), f"{name} has no description")

    def test_boards_list_declares_expand_and_starred(self):
        self._assert_schemas(_BOARDS, {"expand": _STR, "starred": _BOOL})

    def test_board_retrieve_declares_expand(self):
        self._assert_schemas(_BOARD, {"expand": _STR})

    def test_board_full_declares_expand(self):
        self._assert_schemas(_BOARD_FULL, {"expand": _STR})

    def test_groups_list_declares_starred(self):
        self._assert_schemas(_GROUPS, {"starred": _BOOL})

    def test_group_boards_get_declares_expand(self):
        self._assert_schemas(_GROUP_BOARDS, {"expand": _STR})

    def test_params_are_scoped_to_the_operations_that_parse_them(self):
        # The list-only declarations must not leak onto writes or other
        # operations: board create, board update and group retrieve do not
        # filter on ``starred``, and POST /groups/{id}/boards/ is not a read.
        self.assertNotIn("starred", self._query_params(_BOARD))
        self.assertNotIn("starred", self._query_params(_GROUPS + "{id}/"))
        self.assertNotIn("expand", self._query_params(_BOARDS, "post"))
        self.assertNotIn("expand", self._query_params(_GROUP_BOARDS, "post"))
