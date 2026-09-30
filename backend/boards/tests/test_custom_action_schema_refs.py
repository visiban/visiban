"""Pins the real response $ref for custom actions #1227 fixed (gap surviving #1108/#1209).

A plain ``@action`` with no ``serializer_class``/``@extend_schema`` makes
drf-spectacular fall back to the viewset's default serializer, so a client generated
from ``/api/schema/`` gets the wrong type for the response — e.g. ``CardViewSet.movements``
published ``Card`` instead of an array of ``CardMovement``. Same bug class as #1108/#1209;
this file is ``SimpleTestCase`` (schema generation reads serializer/view classes only,
no database) like ``test_reorder_schema.py`` (#1142), and asserts the ``$ref``/shape
directly rather than validating a live response, since every defect here was a
misattributed component, not a wrong field value.
"""

from django.test import SimpleTestCase
from drf_spectacular.generators import SchemaGenerator

_BOARD_BASE = "/api/v1/boards/{id}"
_CARD_BASE = "/api/v1/boards/{board_pk}/cards/{id}"


class CustomActionSchemaRefTests(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.schema = SchemaGenerator().get_schema(request=None, public=True)
        cls.paths = cls.schema["paths"]

    def _response_schema(self, path, method, status_code="200"):
        op = self.paths[path][method]["responses"][status_code]
        return op["content"]["application/json"]["schema"]

    def test_card_movements_returns_movement_array(self):
        """Was `$ref: Card` — CardViewSet has no serializer_class override for this action."""
        schema = self._response_schema(f"{_CARD_BASE}/movements/", "get")
        self.assertEqual(schema.get("type"), "array")
        self.assertEqual(schema["items"]["$ref"], "#/components/schemas/CardMovement")

    def test_card_timeline_returns_the_documented_page_shape(self):
        """Regression pin: fixed by #1294 while #1227 was in flight; was `$ref: Card`."""
        schema = self._response_schema(f"{_CARD_BASE}/timeline/", "get")
        self.assertEqual(schema.get("$ref"), "#/components/schemas/CardTimelinePage")
        page = self.schema["components"]["schemas"]["CardTimelinePage"]
        props = page["properties"]
        self.assertEqual(
            props["results"]["items"]["$ref"], "#/components/schemas/CardTimelineEntry"
        )

    def test_board_movements_returns_the_documented_page_shape(self):
        """Was `$ref: Board` — BoardViewSet has no serializer_class override for this action."""
        schema = self._response_schema(f"{_BOARD_BASE}/movements/", "get")
        self.assertEqual(schema.get("$ref"), "#/components/schemas/BoardMovementsPage")
        page = self.schema["components"]["schemas"]["BoardMovementsPage"]
        props = page["properties"]
        self.assertEqual(props["count"]["type"], "integer")
        self.assertEqual(props["offset"]["type"], "integer")
        self.assertEqual(props["page_size"]["type"], "integer")
        self.assertEqual(
            props["results"]["items"]["$ref"], "#/components/schemas/CardMovement"
        )

    def test_checklist_item_patch_returns_checklist_item(self):
        """Was `$ref: Card` — same missing-annotation gap as the other CardViewSet actions."""
        schema = self._response_schema(f"{_CARD_BASE}/checklist/{{item_pk}}/", "patch")
        self.assertEqual(schema["$ref"], "#/components/schemas/CardChecklist")

    def test_checklist_item_delete_has_no_response_body(self):
        op = self.paths[f"{_CARD_BASE}/checklist/{{item_pk}}/"]["delete"]
        self.assertNotIn("content", op["responses"]["204"])

    def test_group_members_returns_a_bare_membership_array(self):
        """Was wrapped in the default paginated-list envelope (same bug #1142 fixed for
        reorder actions) even though `GroupViewSet.members` never paginates its response —
        it always returns the full direct+inherited member list in one payload."""
        schema = self._response_schema("/api/v1/groups/{id}/members/", "get")
        self.assertEqual(schema.get("type"), "array")
        self.assertEqual(
            schema["items"]["$ref"], "#/components/schemas/GroupMembership"
        )

    # ── further undocumented custom actions found by #1227's repo-wide sweep ──

    def test_card_status_returns_the_documented_shape(self):
        """Was `$ref: Card` — the action returns `{"archived": bool}`, not a card."""
        schema = self._response_schema(f"{_CARD_BASE}/status/", "get")
        self.assertEqual(schema["$ref"], "#/components/schemas/CardStatus")
        props = self.schema["components"]["schemas"]["CardStatus"]["properties"]
        self.assertEqual(props["archived"]["type"], "boolean")

    def test_archived_cards_returns_the_documented_page_shape(self):
        """Was `$ref: Card` — same offset-pagination envelope as board movements."""
        schema = self._response_schema("/api/v1/boards/{board_pk}/cards/archived/", "get")
        self.assertEqual(schema["$ref"], "#/components/schemas/ArchivedCardsPage")
        page = self.schema["components"]["schemas"]["ArchivedCardsPage"]
        props = page["properties"]
        self.assertEqual(props["count"]["type"], "integer")
        self.assertEqual(props["results"]["items"]["$ref"], "#/components/schemas/Card")

    def test_group_subgroups_returns_a_bare_group_array(self):
        """Was `$ref: Group` (single) — GroupViewSet.serializer_class leaked through
        with no `many=True`, and the default paginator would have wrapped it anyway."""
        schema = self._response_schema("/api/v1/groups/{id}/subgroups/", "get")
        self.assertEqual(schema.get("type"), "array")
        self.assertEqual(schema["items"]["$ref"], "#/components/schemas/Group")

    def test_group_boards_get_and_post(self):
        """Was `$ref: Group` for both — the action returns Board data, not Group."""
        get_schema = self._response_schema("/api/v1/groups/{id}/boards/", "get")
        self.assertEqual(get_schema.get("type"), "array")
        self.assertEqual(get_schema["items"]["$ref"], "#/components/schemas/Board")
        post_schema = self._response_schema("/api/v1/groups/{id}/boards/", "post", "201")
        self.assertEqual(post_schema["$ref"], "#/components/schemas/Board")

    def test_group_descendant_boards_returns_a_bare_board_array(self):
        schema = self._response_schema("/api/v1/groups/{id}/descendant-boards/", "get")
        self.assertEqual(schema.get("type"), "array")
        self.assertEqual(schema["items"]["$ref"], "#/components/schemas/Board")

    def test_group_labels_get_and_post(self):
        """Was `$ref: Group` for both — the action returns GroupLabel data, not Group."""
        get_schema = self._response_schema("/api/v1/groups/{id}/labels/", "get")
        self.assertEqual(get_schema.get("type"), "array")
        self.assertEqual(get_schema["items"]["$ref"], "#/components/schemas/GroupLabel")
        post_schema = self._response_schema("/api/v1/groups/{id}/labels/", "post", "201")
        self.assertEqual(post_schema["$ref"], "#/components/schemas/GroupLabel")

    def test_update_group_label_patch_and_delete(self):
        path = "/api/v1/groups/{id}/labels/{label_id}/"
        patch_schema = self._response_schema(path, "patch")
        self.assertEqual(patch_schema["$ref"], "#/components/schemas/GroupLabel")
        op = self.paths[path]["delete"]
        self.assertNotIn("content", op["responses"]["204"])
