"""OpenAPI contract for the query parameters of six read operations (#1887, #1975).

#1887: the generated schema published only ``cursor``/``page_size`` on
``GET /cards/`` and only ``limit``/``offset``/``ordering`` on
``GET /boards/{id}/cards/``. drf-spectacular's django-filter extension does
match ``CodedDjangoFilterBackend`` (``match_subclasses``); it returned nothing
because it resolves the view's model through ``get_queryset()``, and both
viewsets' ``get_queryset()`` raised without a request (``board_pk`` missing,
``AnonymousUser`` has no ``can_access_all_content``). Neither set ``queryset``.

#1975: four hand-paged views returned a page envelope but declared none of the
parameters they parse.

Generated clients and schemathesis read only what the schema declares, so each
parameter is asserted by name, with the type the view actually parses.
"""

import contextlib
import io

from django.test import TestCase
from drf_spectacular.generators import SchemaGenerator

from boards.views.card_query import CardQueryFilter
from boards.views.cards import CardFilter, CardViewSet
from visiban.pagination import CardQueryCursorPagination
from visiban.request_shape import MAX_OFFSET

_CARD_QUERY = "/api/v1/cards/"
_BOARD_CARDS = "/api/v1/boards/{board_pk}/cards/"
_ADMIN_USERS = "/api/v1/admin/users/"
_TIMELINE = "/api/v1/boards/{board_pk}/cards/{id}/timeline/"
_ARCHIVED = "/api/v1/boards/{board_pk}/cards/archived/"
_MOVEMENTS = "/api/v1/boards/{id}/movements/"

_INT64 = {"type": "integer", "format": "int64"}
_DATE = {"type": "string", "format": "date"}
_OFFSET = {"type": "integer", "minimum": 0, "maximum": MAX_OFFSET}


class QueryParameterSchemaTests(TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # drf-spectacular reports its warnings on stderr, not via logging.
        cls.stderr = io.StringIO()
        with contextlib.redirect_stderr(cls.stderr):
            cls.schema = SchemaGenerator().get_schema(request=None, public=True)

    def _query_params(self, path, method="get"):
        operation = self.schema["paths"][path][method]
        return {p["name"]: p for p in operation.get("parameters", []) if p["in"] == "query"}

    def _assert_schemas(self, path, expected):
        params = self._query_params(path)
        for name, schema in expected.items():
            with self.subTest(path=path, param=name):
                self.assertIn(name, params)
                self.assertEqual(params[name]["schema"], schema)
                self.assertFalse(params[name].get("required", False))
                self.assertTrue(params[name].get("description"), f"{name} has no description")

    # --- #1887: GET /cards/ ----------------------------------------------

    def test_card_query_declares_every_filter(self):
        self._assert_schemas(_CARD_QUERY, {
            "board": _INT64,
            "swimlane": _INT64,
            "column": _INT64,
            "assignee": _INT64,
            "label": _INT64,
            "priority": {"type": "string"},
            "due_before": _DATE,
            "due_after": _DATE,
            "updated_since": {"type": "string", "format": "date-time"},
            "include_archived": {"type": "boolean"},
            "search": {"type": "string"},
            "page_size": {"type": "integer"},
        })
        self.assertIn("cursor", self._query_params(_CARD_QUERY))

    def test_card_query_ordering_enum_is_the_pagination_allowlist(self):
        ordering = self._query_params(_CARD_QUERY)["ordering"]
        self.assertEqual(
            ordering["schema"],
            {"type": "string", "enum": list(CardQueryCursorPagination._ALLOWED_ORDERINGS)},
        )

    def test_card_query_publishes_every_filterset_field(self):
        # A filter added to CardQueryFilter later is published with no edit
        # here; one the schema silently drops again fails this.
        params = self._query_params(_CARD_QUERY)
        for name in CardQueryFilter.base_filters:
            with self.subTest(param=name):
                self.assertIn(name, params)

    # --- #1887: GET /boards/{id}/cards/ ----------------------------------

    def test_board_card_list_declares_every_filter(self):
        self._assert_schemas(_BOARD_CARDS, {
            "assignee": _INT64,
            "unassigned": {"type": "boolean"},
            "column": _INT64,
            "swimlane": _INT64,
            "priority": {"type": "string"},
            "due_before": _DATE,
            "due_after": _DATE,
            "overdue": {"type": "boolean"},
            "search": {"type": "string"},
        })
        # Declared before #1887 and unchanged.
        params = self._query_params(_BOARD_CARDS)
        for name in ("limit", "offset", "ordering"):
            self.assertIn(name, params)

    def test_board_card_list_publishes_every_filterset_field(self):
        params = self._query_params(_BOARD_CARDS)
        for name in CardFilter.base_filters:
            with self.subTest(param=name):
                self.assertIn(name, params)

    def test_card_filters_are_not_published_on_actions_that_ignore_them(self):
        # Only CardViewSet.list runs filter_queryset(). Resolving the model
        # (#1887) made the stock extension publish CardFilter on every action
        # drf-spectacular treats as a list; CodedDjangoFilterExtension keeps
        # them on list only.
        for path in (
            "/api/v1/boards/{board_pk}/cards/{id}/comments/",
            "/api/v1/boards/{board_pk}/cards/{id}/movements/",
            "/api/v1/boards/{board_pk}/cards/{id}/activities/",
        ):
            params = self._query_params(path)
            for name in CardFilter.base_filters:
                with self.subTest(path=path, param=name):
                    self.assertNotIn(name, params)

    def test_card_viewsets_resolve_their_model_during_schema_generation(self):
        # The root cause of #1887: this warning meant the filter extension
        # had no model and published no filter.
        failed = [
            line for line in self.stderr.getvalue().splitlines()
            if "Failed to obtain model through view's queryset" in line
            and ("[CardViewSet]" in line or "[CardQueryViewSet]" in line)
        ]
        self.assertEqual(failed, [])

    # --- #1975 -------------------------------------------------------------

    def test_admin_user_list_declares_search_and_paging(self):
        self._assert_schemas(_ADMIN_USERS, {
            "search": {"type": "string"},
            "offset": {"type": "integer"},
            "page_size": {"type": "integer"},
        })

    def test_timeline_declares_paging_and_event_types(self):
        self._assert_schemas(_TIMELINE, {
            "limit": {"type": "integer"},
            "offset": _OFFSET,
            "event_types": {
                "type": "array",
                "items": {"type": "string", "enum": CardViewSet._TIMELINE_EVENT_GROUPS},
            },
        })
        event_types = self._query_params(_TIMELINE)["event_types"]
        # Comma-separated on the wire, as timeline() splits it.
        self.assertEqual(event_types.get("style", "form"), "form")
        self.assertIs(event_types["explode"], False)

    def test_timeline_event_type_enum_matches_validation(self):
        self.assertEqual(
            set(CardViewSet._TIMELINE_EVENT_GROUPS),
            set(CardViewSet._TIMELINE_ACTIVITY_GROUPS) | {"move"},
        )

    def test_archived_cards_declares_offset_only(self):
        # Fixed page size of 50: page_size is not read, so not published.
        self.assertEqual(set(self._query_params(_ARCHIVED)), {"offset"})
        self._assert_schemas(_ARCHIVED, {"offset": _OFFSET})

    def test_board_movements_declares_every_filter(self):
        self._assert_schemas(_MOVEMENTS, {
            "swimlane_id": _INT64,
            "to_column_id": _INT64,
            "moved_by_id": _INT64,
            "moved_after": _DATE,
            "moved_before": _DATE,
            "exclude_type": {"type": "array", "items": {"type": "string"}},
            "offset": _OFFSET,
        })
        self.assertIs(self._query_params(_MOVEMENTS)["exclude_type"]["explode"], False)

    # --- the bug class -----------------------------------------------------

    def test_every_page_envelope_declares_a_paging_parameter(self):
        """A GET answering a page envelope must say how to reach the next page.

        #1975's four operations returned ``{count, offset, page_size, results}``
        or ``{count, next, previous, results}`` and declared no ``offset``, so
        a generated client could read page one and nothing after it.
        """
        components = self.schema["components"]["schemas"]
        missing = []
        for path, item in self.schema["paths"].items():
            operation = item.get("get")
            if not operation:
                continue
            content = operation["responses"].get("200", {}).get("content", {})
            body = content.get("application/json", {}).get("schema", {})
            if "$ref" in body:
                body = components[body["$ref"].rsplit("/", 1)[-1]]
            if "results" not in body.get("properties", {}):
                continue
            declared = {p["name"] for p in operation.get("parameters", []) if p["in"] == "query"}
            if not declared & {"offset", "cursor", "after"}:
                missing.append(path)
        self.assertEqual(missing, [])
