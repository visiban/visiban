"""OpenAPI accuracy for hand-written GETs (#1793) and the ``ordering`` param (#1757).

#1793: several ``APIView.get`` handlers build their body by hand and declared
no ``extend_schema``, so drf-spectacular published a bodiless 200 (and logged
"unable to guess serializer"). ``GET /groups/join/{token}/`` also left its 410
undocumented while its board sibling documented both. The lens board (#1647)
is covered in ``git_lens/tests/test_board_schema_1647.py``.

#1757: ``OrderingFilter`` is a default filter backend, so the stock schema
listed ``?ordering=`` on every operation drf-spectacular treats as a list,
including custom ``@action``s and ``POST .../reorder/`` that never apply it
to the rows they return (a detail action's ``get_object()`` runs it only on
the single-row lookup). ``ListOnlyOrderingFilterExtension`` keeps it on the
``list`` action only. Runtime is unchanged: the filter still runs on every
``list``, including those that honor ``?ordering=`` through DRF's fallback to
the serializer's fields, which the tests below pin as well.
"""

import contextlib
import io
from unittest import mock

import jsonschema
from django.test import SimpleTestCase, TestCase
from django.utils import timezone
from drf_spectacular.generators import SchemaGenerator
from rest_framework.filters import OrderingFilter
from rest_framework.test import APIClient

from boards.models import CardParentLink, Label, SwimlaneTeamMember
from boards.tests.conftest import (
    _make_board, _make_card, _make_column, _make_membership, _make_swimlane, _make_user,
)

_JSON = "application/json"


def _schema():
    stderr = io.StringIO()
    with contextlib.redirect_stderr(stderr):
        schema = SchemaGenerator().get_schema(request=None, public=True)
    return schema, stderr.getvalue()


class HandWrittenGetResponseSchemaTests(SimpleTestCase):
    # path -> (component, required properties)
    CASES = {
        "/api/v1/version/": ("VersionResponse", {"version"}),
        "/api/health/liveness/": ("LivenessResponse", {"status"}),
        "/api/health/readiness/": ("ReadinessResponse", {"status"}),
        "/api/v1/auth/providers/": (
            "AuthProviders", {"google", "github", "gitlab", "oidc", "oidc_name"},
        ),
        "/api/v1/notifications/unread-count/": ("NotificationUnreadCount", {"count"}),
        "/api/v1/groups/join/{token}/": (
            "GroupJoinPreview", {"group_id", "group_name", "role", "can_register"},
        ),
    }

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.schema, cls.stderr = _schema()
        cls.components = cls.schema["components"]["schemas"]

    def _response(self, path, status, method="get"):
        return self.schema["paths"][path][method]["responses"][status]

    def _component(self, path, status):
        ref = self._response(path, status)["content"][_JSON]["schema"]["$ref"]
        return self.components[ref.rsplit("/", 1)[-1]]

    def test_200_carries_a_typed_body(self):
        # Before #1793 each of these 200s had no ``content`` at all.
        for path, (name, required) in self.CASES.items():
            with self.subTest(path=path):
                ref = self._response(path, "200")["content"][_JSON]["schema"]["$ref"]
                self.assertEqual(ref, f"#/components/schemas/{name}")
                self.assertEqual(set(self.components[name]["required"]), required)

    def test_schema_generation_no_longer_guesses_these_views(self):
        guessed = [
            line for line in self.stderr.splitlines()
            if "unable to guess serializer" in line
            and any(
                f"[{view}]" in line
                for view in (
                    "VersionView", "LivenessView", "ReadinessView", "AuthProvidersView",
                    "NotificationUnreadCountView", "JoinGroupView",
                )
            )
        ]
        self.assertEqual(guessed, [])

    def test_body_field_types(self):
        props = self.components["AuthProviders"]["properties"]
        for name in ("google", "github", "gitlab", "oidc"):
            self.assertEqual(props[name]["type"], "boolean", name)
        # null exactly when oidc is false.
        self.assertTrue(props["oidc_name"]["nullable"])
        self.assertEqual(self.components["NotificationUnreadCount"]["properties"]["count"]["type"], "integer")
        preview = self.components["GroupJoinPreview"]["properties"]
        self.assertEqual(preview["group_id"]["type"], "integer")
        self.assertEqual(preview["can_register"]["type"], "boolean")

    def test_health_status_values(self):
        def enum(component):
            ref = self.components[component]["properties"]["status"]["$ref"]
            return self.components[ref.rsplit("/", 1)[-1]]["enum"]

        self.assertEqual(enum("LivenessResponse"), ["ok"])
        self.assertEqual(sorted(enum("ReadinessResponse")), ["degraded", "error", "ok"])

    def test_readiness_documents_its_503(self):
        # The 503 carries ``status: error`` plus the deprecated ``errors`` map;
        # a 200 never carries ``errors``, so it is not required.
        body = self._component("/api/health/readiness/", "503")
        self.assertIn("errors", body["properties"])
        self.assertNotIn("errors", body["required"])

    def test_group_join_preview_documents_404_and_410(self):
        # Same pair JoinBoardView.get already documents.
        path = "/api/v1/groups/join/{token}/"
        for status in ("404", "410"):
            with self.subTest(status=status):
                self.assertIn("detail", self._component(path, status)["properties"])
        board = self.schema["paths"]["/api/v1/boards/join/{token}/"]["get"]["responses"]
        self.assertIn("410", board)


def _as_json_schema(node):
    """OpenAPI 3.0 ``nullable`` rewritten so ``jsonschema`` honors it."""
    if isinstance(node, list):
        return [_as_json_schema(item) for item in node]
    if not isinstance(node, dict):
        return node
    out = {k: _as_json_schema(v) for k, v in node.items() if k != "nullable"}
    return {"anyOf": [out, {"type": "null"}]} if node.get("nullable") is True else out


class ParentChildReadSchemaTests(TestCase):
    """The five parent/child reads publish the bodies they serve (#1793)."""

    CASES = {
        "/api/v1/boards/{board_pk}/cards/{id}/child-board-options/": "ChildBoardOptions",
        "/api/v1/boards/{board_pk}/cards/{id}/children/": "CardChildrenRead",
        "/api/v1/boards/{id}/children-setting-blockers/": "ChildrenSettingBlockers",
        "/api/v1/boards/{id}/default-child-board-options/": "DefaultChildBoardOptions",
        "/api/v1/boards/{id}/delete-impact/": "BoardDeleteImpact",
    }

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.schema, _ = _schema()
        cls.components = _as_json_schema(cls.schema["components"])

    def setUp(self):
        self.owner = _make_user()
        self.parents = _make_board(self.owner, name="Pipeline", cards_can_have_children=True)
        self.delivery = _make_board(self.owner, name="Delivery")
        self.column = _make_column(self.parents)
        self.lane = _make_swimlane(self.parents)
        self.child_column = _make_column(self.delivery, allow_card_creation=True)
        self.child_lane = _make_swimlane(self.delivery)
        self.parent = _make_card(self.column, self.lane)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def _link(self):
        child = _make_card(self.child_column, self.child_lane, assignee=self.owner, due_date="2026-12-01")
        child.labels.add(Label.objects.create(board=self.delivery, name="bug", color="#ff0000"))
        CardParentLink.objects.create(parent=self.parent, child=child, created_by=self.owner)
        return child

    def _read(self, path, board, client=None):
        """GET ``path``, check the 200 against its published schema, return the body."""
        url = path.replace("{board_pk}", str(board.pk)).replace(
            "{id}", str(self.parent.pk if "{board_pk}" in path else board.pk),
        )
        response = (client or self.client).get(url)
        self.assertEqual(response.status_code, 200, response.content)
        body = response.json()
        name = self.CASES[path]
        declared = self.schema["paths"][path]["get"]["responses"]["200"]["content"][_JSON]["schema"]
        self.assertEqual(declared, {"$ref": f"#/components/schemas/{name}"})
        jsonschema.validate(body, {**declared, "components": self.components})
        self._assert_no_undeclared_keys(body, declared)
        return body

    def _assert_no_undeclared_keys(self, value, node):
        if isinstance(node, dict) and "$ref" in node:
            node = self.components["schemas"][node["$ref"].rsplit("/", 1)[-1]]
        for key in ("allOf", "anyOf", "oneOf"):
            if key in node:
                if value is not None:
                    self._assert_no_undeclared_keys(value, node[key][0])
                return
        if isinstance(value, list):
            for item in value:
                self._assert_no_undeclared_keys(item, node["items"])
        elif isinstance(value, dict) and "properties" in node:
            self.assertEqual(set(value) - set(node["properties"]), set())
            for key, item in value.items():
                self._assert_no_undeclared_keys(item, node["properties"][key])

    def test_children_empty_visible_and_hidden(self):
        path = "/api/v1/boards/{board_pk}/cards/{id}/children/"
        self.assertNotIn("board", self._read(path, self.parents))
        self._link()
        body = self._read(path, self.parents)
        self.assertEqual(len(body["results"]), 1)
        self.assertIn("board", body)
        outsider = _make_user()
        _make_membership(self.parents, outsider, "viewer")
        client = APIClient()
        client.force_authenticate(outsider)
        hidden = self._read(path, self.parents, client)
        self.assertFalse(hidden["visible"])

    def test_child_board_options_without_and_with_a_fixed_board_and_team(self):
        path = "/api/v1/boards/{board_pk}/cards/{id}/child-board-options/"
        body = self._read(path, self.parents)
        self.assertIsNone(body["fixed_board"])
        self.assertIsNone(body["default_team"])
        self.assertEqual(len(body["boards"]), 1)
        self.parents.default_child_board = self.delivery
        self.parents.save(update_fields=["default_child_board"])
        SwimlaneTeamMember.objects.create(swimlane=self.lane, user=self.owner)
        self._link()
        self.parent.archived_at = timezone.now()
        self.parent.save(update_fields=["archived_at"])
        body = self._read(path, self.parents)
        self.assertEqual(body["fixed_board"]["default_assignee_id"], self.owner.pk)
        self.assertEqual(body["default"]["id"], self.delivery.pk)
        self.assertEqual(body["default_team"]["member_ids"], [self.owner.pk])
        self.assertEqual(body["disabled_reason"], "parent_archived")

    def test_board_level_reads(self):
        self._link()
        self.parents.default_child_board = self.delivery
        self.parents.save(update_fields=["default_child_board"])
        blockers = self._read("/api/v1/boards/{id}/children-setting-blockers/", self.delivery)
        self.assertEqual(len(blockers["default_of"]), 1)
        options = self._read("/api/v1/boards/{id}/default-child-board-options/", self.parents)
        self.assertEqual(options["boards_total"], 1)
        impact = self._read("/api/v1/boards/{id}/delete-impact/", self.delivery)
        self.assertEqual(len(impact["parent_boards"]), 1)


class OrderingParamSchemaTests(SimpleTestCase):
    """``?ordering=`` is published only where ``OrderingFilter`` actually runs (#1757)."""

    # Every ``list`` action backed by OrderingFilter honors ?ordering= at
    # runtime (explicit ``ordering_fields`` on the card list, DRF's serializer
    # fallback elsewhere); /cards/ reads it in its cursor paginator.
    HONORED = (
        "/api/v1/boards/",
        "/api/v1/boards/{board_pk}/cards/",
        "/api/v1/boards/{board_pk}/columns/",
        "/api/v1/boards/{board_pk}/custom-fields/",
        "/api/v1/boards/{board_pk}/field-sets/",
        "/api/v1/boards/{board_pk}/labels/",
        "/api/v1/boards/{board_pk}/swimlane-custom-fields/",
        "/api/v1/boards/{board_pk}/swimlanes/",
        "/api/v1/cards/",
        "/api/v1/groups/",
    )
    IGNORED_GET = (
        "/api/v1/boards/{board_pk}/cards/{id}/activities/",
        "/api/v1/boards/{board_pk}/cards/{id}/attachments/",
        "/api/v1/boards/{board_pk}/cards/{id}/blocks/",
        "/api/v1/boards/{board_pk}/cards/{id}/checklist/",
        "/api/v1/boards/{board_pk}/cards/{id}/comments/",
        "/api/v1/boards/{board_pk}/cards/{id}/movements/",
        "/api/v1/boards/{board_pk}/cards/{id}/relations/",
        "/api/v1/boards/{id}/export-history/",
        "/api/v1/boards/{id}/invite-links/",
        "/api/v1/boards/{id}/saved-filters/",
        "/api/v1/groups/{id}/boards/",
        "/api/v1/groups/{id}/descendant-boards/",
        "/api/v1/groups/{id}/invite-links/",
        "/api/v1/groups/{id}/labels/",
        "/api/v1/groups/{id}/members/",
        "/api/v1/groups/{id}/subgroups/",
    )
    IGNORED_POST = (
        "/api/v1/boards/{board_pk}/cards/{id}/checklist/reorder/",
        "/api/v1/boards/{board_pk}/columns/reorder/",
        "/api/v1/boards/{board_pk}/custom-fields/reorder/",
        "/api/v1/boards/{board_pk}/field-sets/reorder/",
        "/api/v1/boards/{board_pk}/swimlane-custom-fields/reorder/",
        "/api/v1/boards/{board_pk}/swimlanes/reorder/",
    )

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.schema, _ = _schema()

    def _params(self, path, method):
        return {p["name"] for p in self.schema["paths"][path][method].get("parameters", [])}

    def test_ordering_published_on_list_actions(self):
        for path in self.HONORED:
            with self.subTest(path=path):
                self.assertIn("ordering", self._params(path, "get"))

    def test_ordering_not_published_where_ignored(self):
        for method, paths in (("get", self.IGNORED_GET), ("post", self.IGNORED_POST)):
            for path in paths:
                with self.subTest(method=method, path=path):
                    self.assertNotIn("ordering", self._params(path, method))

    def test_no_non_list_operation_publishes_ordering(self):
        # The whole class, not just the operations listed above: any operation
        # outside HONORED that publishes ``ordering`` needs a look.
        stray = [
            f"{method.upper()} {path}"
            for path, ops in self.schema["paths"].items()
            for method, op in ops.items()
            if path not in self.HONORED
            and any(p.get("name") == "ordering" for p in op.get("parameters", []))
        ]
        self.assertEqual(stray, [])


class OrderingRuntimeUnchangedTests(TestCase):
    """The schema change is documentation only: the filter runs where it ran."""

    def setUp(self):
        self.owner = _make_user()
        self.board = _make_board(self.owner)
        self.a = _make_column(self.board, name="A", order=0)
        self.b = _make_column(self.board, name="B", order=1)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    @staticmethod
    def _rows(response):
        body = response.json()
        return body["results"] if isinstance(body, dict) else body

    def test_list_still_honors_ordering_through_the_serializer_fallback(self):
        # ColumnViewSet sets no ordering_fields; DRF falls back to the
        # serializer's readable fields. A 1.x client may rely on this, which is
        # why OrderingFilter stays in DEFAULT_FILTER_BACKENDS.
        url = f"/api/v1/boards/{self.board.id}/columns/"
        asc = [c["id"] for c in self._rows(self.client.get(url, {"ordering": "position"}))]
        desc = [c["id"] for c in self._rows(self.client.get(url, {"ordering": "-position"}))]
        self.assertEqual(asc, [self.a.id, self.b.id])
        self.assertEqual(desc, [self.b.id, self.a.id])

    def test_filter_runs_on_list_and_not_on_a_custom_action(self):
        calls = []
        real = OrderingFilter.filter_queryset

        def spy(self_, request, queryset, view):
            calls.append(getattr(view, "action", None))
            return real(self_, request, queryset, view)

        with mock.patch.object(OrderingFilter, "filter_queryset", spy):
            r = self.client.get(f"/api/v1/boards/{self.board.id}/saved-filters/", {"ordering": "-id"})
            self.assertEqual(r.status_code, 200)
            # saved-filters resolves its board without get_object(), so the
            # filter does not run at all. Detail actions that do call
            # get_object() run it on the one-row lookup only, which cannot
            # reorder their response.
            self.assertEqual(calls, [], "saved-filters must not run OrderingFilter")
            r = self.client.get(f"/api/v1/boards/{self.board.id}/columns/", {"ordering": "-id"})
            self.assertEqual(r.status_code, 200)
        self.assertEqual(calls, ["list"])
