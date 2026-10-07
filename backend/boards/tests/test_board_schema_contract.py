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
from boards.models import Board, BoardExportLog, BoardMembership
from boards.serializers import BoardFullSerializer, BoardSerializer
from boards.tests.conftest import _make_board
from boards.tests.test_move_schema_contract import _openapi3_nullable_to_jsonschema
from groups.models import Group, GroupMembership


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

    def test_board_patch_without_group_matches_schema(self):
        """Reproduces #1166: on a partial update, DRF's Field.get_default()
        unconditionally raises SkipField() (see fields.py), so a dotted-source
        CharField resolving a null `group` FK via its `default` silently
        vanished from the PATCH response instead of serializing as null.
        """
        board = _make_board(self.user)
        resp = self.client.patch(f"/api/v1/boards/{board.pk}/", {"name": "Renamed"}, format="json")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        body = resp.json()
        self.assertIn("group_name", body)
        self.assertIsNone(body["group_name"])
        self._assert_valid(
            body, self._response_schema("/api/v1/boards/{id}/", method="patch")
        )

    def test_board_patch_with_group_matches_schema(self):
        """Sibling of the ungrouped case above: on a grouped board, a partial
        update must still resolve `group_name` to the group's actual name (not
        null, not absent) — the SkipField()-under-partial pitfall only bites
        the None-FK traversal, but this proves get_group_name() also does the
        right thing for the non-None path under partial=True.
        """
        board = _make_board(self.user)
        board.group = Group.objects.create(name="Team", owner=self.user)
        board.save(update_fields=["group"])
        resp = self.client.patch(f"/api/v1/boards/{board.pk}/", {"name": "Renamed"}, format="json")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        body = resp.json()
        self.assertEqual(body["group_name"], "Team")
        self._assert_valid(
            body, self._response_schema("/api/v1/boards/{id}/", method="patch")
        )

    def test_export_history_matches_schema(self):
        """Reproduces #1166: with no `@extend_schema(responses=...)` on the
        action, drf-spectacular fell back to the viewset's default
        `BoardSerializer` for the response — but this action actually returns
        a paginated list of `BoardExportLog` rows, an unrelated shape, so every
        real response failed schema conformance.
        """
        board = _make_board(self.user)
        BoardExportLog.objects.create(
            board=board, actor=self.user,
            role_at_export="admin", export_format="json", row_count=1,
        )
        resp = self.client.get(f"/api/v1/boards/{board.pk}/export-history/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self._assert_valid(
            resp.json(), self._response_schema("/api/v1/boards/{id}/export-history/")
        )

    def test_board_full_redeclared_fields_are_typed(self):
        """BoardFull redeclares Board's fields; they must be typed there too.

        Since #1137 `/full/` is documented against its own `BoardFull`
        component, so the live body is validated through the generated schema
        as well as through the serializer's own declarations.
        """
        board = _make_board(self.user)
        resp = self.client.get(f"/api/v1/boards/{board.pk}/full/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertIsInstance(resp.json()["is_starred"], bool)
        self.assertIsNone(resp.json()["group_name"])
        self._assert_valid(resp.json(), self._response_schema("/api/v1/boards/{id}/full/"))

        self.assertIs(get_type_hints(BoardFullSerializer.get_is_starred)["return"], bool)
        fields = BoardFullSerializer().fields
        self.assertTrue(fields["group_name"].allow_null)
        self.assertTrue(BoardSerializer().fields["group_name"].allow_null)
        # extend_schema_field stores its override on the decorated method.
        self.assertTrue(hasattr(BoardFullSerializer.get_group_detail, "_spectacular_annotation"))

    def test_board_full_group_name_survives_partial_bind(self):
        """Defense-in-depth for #1189: BoardFullSerializer.group_name used to be
        a dotted-source `CharField(source="group.name", default=None)` — the same
        shape that caused #1166's `group_name`-absent-on-PATCH bug on
        BoardSerializer. BoardFullSerializer is currently only ever instantiated
        read-only (BoardViewSet.full()), so there is no live endpoint that binds
        it with `partial=True` to reproduce the bug end-to-end. This exercises
        DRF's `Serializer.to_representation()` field loop directly — the same
        `get_attribute()` / `to_representation()` calls a partial-bound
        serializer would make — so a future partial-bound reuse can't silently
        reintroduce it.

        Pre-fix, the `group=None` branch below raised `SkipField` from
        `Field.get_default()`, which unconditionally fires whenever
        `self.root.partial` is True, regardless of whether `default` is set.
        """
        board = _make_board(self.user)
        serializer = BoardFullSerializer(board, partial=True)
        self.assertTrue(serializer.partial)
        field = serializer.fields["group_name"]

        attribute = field.get_attribute(board)
        self.assertIsNone(field.to_representation(attribute))

        board.group = Group.objects.create(name="Team", owner=self.user)
        board.save(update_fields=["group"])
        attribute = field.get_attribute(board)
        self.assertEqual(field.to_representation(attribute), "Team")

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


class BoardFullMembersSchemaTests(TestCase):
    """`/full/`'s `members` is the effective roster, not membership rows (#1137).

    `get_members()` synthesizes rows for group-inherited members, the board
    owner and site admins, with `id: null` and (for site admins)
    `role: "site_admin"`. The schema must admit those on `/full/` while
    `/members/` — real rows only — keeps the strict `BoardMembership` shape.
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.schema = SchemaGenerator().get_schema(request=None, public=True)
        cls.components = cls.schema["components"]["schemas"]

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.direct = User.objects.create_user(username="direct", password="pass")
        self.viewer = User.objects.create_user(username="viewer", password="pass")
        self.inherited = User.objects.create_user(username="inherited", password="pass")
        self.site_admin = User.objects.create_user(
            username="siteadmin", password="pass", can_access_all_content=True,
        )
        group = Group.objects.create(name="Team", owner=self.owner)
        GroupMembership.objects.get_or_create(
            group=group, user=self.inherited, defaults={"role": GroupMembership.Role.MEMBER},
        )
        # Deliberately no membership row for the owner: that is one of the
        # three synthesized-row paths.
        self.board = Board.objects.create(name="Roster", owner=self.owner, group=group)
        BoardMembership.objects.create(
            board=self.board, user=self.direct, role=BoardMembership.Role.ADMIN, is_moderator=True,
        )
        BoardMembership.objects.create(
            board=self.board, user=self.viewer, role=BoardMembership.Role.VIEWER,
        )
        self.client = APIClient()

    def _full(self, user):
        self.client.force_authenticate(user)
        resp = self.client.get(f"/api/v1/boards/{self.board.pk}/full/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        return resp.json()

    def _validate(self, body, schema_fragment):
        combined = _openapi3_nullable_to_jsonschema({**schema_fragment, "components": self.schema["components"]})
        jsonschema.validate(instance=body, schema=combined)

    def _ref(self, schema):
        return schema["$ref"].rsplit("/", 1)[-1]

    def _enum_of(self, prop):
        return self.components[self._ref(prop["allOf"][0])]["enum"]

    # ── schema shape ─────────────────────────────────────────────────────────

    def test_full_is_documented_as_boardfull_with_operation_id_unchanged(self):
        op = self.schema["paths"]["/api/v1/boards/{id}/full/"]["get"]
        self.assertEqual(op["operationId"], "api_v1_boards_full_retrieve")
        body = op["responses"]["200"]["content"]["application/json"]["schema"]
        self.assertEqual(self._ref(body), "BoardFull")
        members = self.components["BoardFull"]["properties"]["members"]
        self.assertEqual(members["type"], "array")
        self.assertEqual(self._ref(members["items"]), "EffectiveBoardMember")

    def test_effective_member_admits_null_id_and_site_admin_role(self):
        props = self.components["EffectiveBoardMember"]["properties"]
        self.assertTrue(props["id"].get("nullable"))
        self.assertEqual(
            sorted(self._enum_of(props["role"])),
            ["admin", "collaborator", "member", "site_admin", "viewer"],
        )
        # Omitted for requesters below admin (#920), so it must not be required.
        self.assertNotIn("is_moderator", self.components["EffectiveBoardMember"]["required"])
        # Likewise omitted for requesters below admin (#1290).
        self.assertIn("is_site_admin", props)
        self.assertNotIn("is_site_admin", self.components["EffectiveBoardMember"]["required"])

    def test_members_endpoint_keeps_the_strict_membership_schema(self):
        op = self.schema["paths"]["/api/v1/boards/{id}/members/"]["post"]
        for code in ("200", "201"):
            body = op["responses"][code]["content"]["application/json"]["schema"]
            self.assertEqual(self._ref(body), "BoardMembership")
        props = self.components["BoardMembership"]["properties"]
        self.assertFalse(props["id"].get("nullable", False))
        self.assertIn("id", self.components["BoardMembership"]["required"])
        self.assertEqual(self._ref(props["role"]), "RoleEnum")
        self.assertNotIn("site_admin", self.components["RoleEnum"]["enum"])

    def test_existing_enum_component_names_are_preserved(self):
        """Adding a second `role` choice set must not rename published enums.

        drf-spectacular's own collision handling would hash-suffix *both*
        `role` enums; `visiban.schema_hooks.pin_named_enums` prevents that.
        """
        self.assertEqual(
            sorted(self.components["RoleEnum"]["enum"]), ["admin", "collaborator", "member", "viewer"],
        )
        self.assertIn("DefaultBoardMemberRoleEnum", self.components)
        self.assertEqual(
            self.components["EffectiveBoardRoleEnum"]["enum"],
            ["admin", "member", "collaborator", "viewer", "site_admin"],
        )
        suffixed = [n for n in self.components if n.startswith("Role") and n != "RoleEnum"]
        self.assertEqual(suffixed, [])

    # ── live response vs schema ──────────────────────────────────────────────

    def test_synthesized_rows_validate_against_full_schema(self):
        body = self._full(self.direct)  # admin requester: is_moderator present
        by_user = {m["user"]["username"]: m for m in body["members"]}
        self.assertIsNone(by_user["owner"]["id"])
        self.assertIsNone(by_user["inherited"]["id"])
        self.assertIsNone(by_user["siteadmin"]["id"])
        self.assertEqual(by_user["siteadmin"]["role"], "site_admin")
        self._validate(body, self._response_schema())

    def test_non_admin_view_without_is_moderator_validates(self):
        """Non-admin viewer's own row keeps is_moderator (#1173 self-row
        exception); every other row still omits it (#920 invariant)."""
        body = self._full(self.viewer)
        own_row = next(m for m in body["members"] if m["user"]["username"] == "viewer")
        self.assertIn("is_moderator", own_row)
        self.assertFalse(own_row["is_moderator"])
        other_rows = [m for m in body["members"] if m["user"]["username"] != "viewer"]
        self.assertTrue(all("is_moderator" not in m for m in other_rows))
        # is_site_admin has no self-row exception (#1290).
        self.assertTrue(all("is_site_admin" not in m for m in body["members"]))
        self._validate(body, self._response_schema())

    def test_synthesized_rows_do_not_fit_the_strict_membership_schema(self):
        """The reason `/full/` needs its own component, pinned as a test."""
        body = self._full(self.direct)
        site_admin_row = next(m for m in body["members"] if m["role"] == "site_admin")
        with self.assertRaises(jsonschema.ValidationError):
            self._validate(site_admin_row, {"$ref": "#/components/schemas/BoardMembership"})

    def test_members_endpoint_response_validates_against_strict_schema(self):
        self.client.force_authenticate(self.direct)
        newcomer = User.objects.create_user(username="newcomer", password="pass")
        resp = self.client.post(
            f"/api/v1/boards/{self.board.pk}/members/",
            {"user_id": newcomer.pk, "role": "member"}, format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertIsNotNone(resp.json()["id"])
        self._validate(resp.json(), {"$ref": "#/components/schemas/BoardMembership"})

    # ── wire format unchanged ────────────────────────────────────────────────

    def test_response_body_is_unchanged(self):
        """#1137 is schema-only: pin the exact wire shape it must not alter."""
        body = self._full(self.direct)
        self.assertEqual(list(body), [
            "id", "uid", "name", "description", "owner", "group", "group_name", "group_detail",
            "columns", "swimlanes", "cards", "labels", "members", "custom_field_definitions",
            "swimlane_custom_field_definitions", "staleness_threshold_days", "stale_warning_pct",
            "allowed_priorities", "enforce_wip_limits", "enforce_wip_hard", "enforce_weight_limits",
            "export_min_role", "card_density", "show_wip_at_limit", "show_row_chip_field_names",
            "created_at", "updated_at",
            "current_user_role", "is_starred", "share_token", "share_token_expires_at", "capabilities",
            # Additive (#1289): archived cards cascade on board delete.
            "archived_card_count",
        ])
        self.assertIsInstance(body["allowed_priorities"], list)
        self.assertEqual(body["current_user_role"], "admin")
        by_user = {m["user"]["username"]: m for m in body["members"]}
        # `is_site_admin` is an additive row field (#1290), present for an
        # admin requester like this one.
        row_keys = ["id", "is_moderator", "is_site_admin", "joined_at", "role", "user"]
        self.assertEqual(
            {name: (row["id"] is None, row["role"], sorted(row)) for name, row in by_user.items()},
            {
                "direct": (False, "admin", row_keys),
                "viewer": (False, "viewer", row_keys),
                "inherited": (True, "member", row_keys),
                "owner": (True, "admin", row_keys),
                "siteadmin": (True, "site_admin", row_keys),
            },
        )
        self.assertIs(by_user["direct"]["is_moderator"], True)
        self.assertIs(by_user["siteadmin"]["is_moderator"], False)

    def _response_schema(self):
        op = self.schema["paths"]["/api/v1/boards/{id}/full/"]["get"]
        return op["responses"]["200"]["content"]["application/json"]["schema"]
