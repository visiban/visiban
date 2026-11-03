"""OpenAPI declarations for hand-written actions and APIViews (#1783).

These actions inherited the viewset's serializer (or, for the APIViews, had no
schema at all), so the published document described request bodies the views
never read and responses they never return. The v1.2.0 compat baseline is
regenerated from the GA tag, which would have frozen that drift into it.

Each test checks the declared request (or its absence) and, where a fixture
can reach the success path cheaply, validates a live response against the
documented schema, so a later edit that drifts either side fails here. The
declarations are schema only: no test here expects a runtime change.
"""

import datetime

import jsonschema
from django.test import TestCase
from django.utils import timezone
from drf_spectacular.generators import SchemaGenerator
from rest_framework.authtoken.models import Token
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardFavorite, BoardMembership, Card, CardMovement, Column, Notification, Swimlane,
)
from boards.tests.test_move_schema_contract import _openapi3_nullable_to_jsonschema
from groups.models import Group, GroupFavorite, GroupMembership

_JSON = "application/json"
_BODY_MEDIA_TYPES = {_JSON, "application/x-www-form-urlencoded", "multipart/form-data"}


class ActionSchemaDeclarationTests(TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # Generate once per class: walking every registered view is not cheap
        # enough to repeat per test method.
        cls.schema = SchemaGenerator().get_schema(request=None, public=True)

    def setUp(self):
        self.owner = User.objects.create_user(username="owner1783", password="pass-1783-Old!")
        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        self.board = Board.objects.create(name="Board 1783", owner=self.owner)
        BoardMembership.objects.create(board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN)
        self.todo = Column.objects.create(board=self.board, name="To Do", position=0)
        self.done = Column.objects.create(board=self.board, name="Done", position=1, is_done=True)
        self.lane = Swimlane.objects.create(board=self.board, name="Lane", position=0)
        self.card = Card.objects.create(
            board=self.board, column=self.todo, swimlane=self.lane,
            title="Card", created_by=self.owner, position=0,
        )

    # -- helpers -------------------------------------------------------------

    def _op(self, method, path):
        return self.schema["paths"][path][method]

    def _component(self, ref):
        return self.schema["components"]["schemas"][ref.rsplit("/", 1)[-1]]

    def _request_schema(self, method, path, media_type=_JSON):
        return self._op(method, path)["requestBody"]["content"][media_type]["schema"]

    def _assert_no_request_body(self, method, path):
        self.assertNotIn("requestBody", self._op(method, path))

    def _success_statuses(self, method, path):
        return sorted(c for c in self._op(method, path)["responses"] if c.startswith("2"))

    def _assert_matches(self, method, path, status_code, body, media_type=_JSON):
        fragment = self._op(method, path)["responses"][str(status_code)]["content"][media_type]["schema"]
        combined = _openapi3_nullable_to_jsonschema({**fragment, "components": self.schema["components"]})
        jsonschema.validate(instance=body, schema=combined)

    # -- boards ----------------------------------------------------------------

    def test_board_star_has_no_body_and_both_methods_answer_200_board(self):
        path = "/api/v1/boards/{id}/star/"
        for method in ("post", "delete"):
            with self.subTest(method=method):
                self._assert_no_request_body(method, path)
                # DELETE used to document a bodiless 204; the view answers 200.
                self.assertEqual(self._success_statuses(method, path), ["200"])
                ref = self._op(method, path)["responses"]["200"]["content"][_JSON]["schema"]["$ref"]
                self.assertTrue(ref.endswith("/Board"))
        url = f"/api/v1/boards/{self.board.pk}/star/"
        resp = self.client.post(url)
        self.assertEqual(resp.status_code, 200)
        self._assert_matches("post", path, 200, resp.json())
        resp = self.client.delete(url)
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(resp.json()["is_starred"])
        self._assert_matches("delete", path, 200, resp.json())
        self.assertFalse(BoardFavorite.objects.filter(board=self.board, user=self.owner).exists())

    def test_move_group_documents_only_group_id(self):
        path = "/api/v1/boards/{id}/move-group/"
        component = self._component(self._request_schema("post", path)["$ref"])
        self.assertEqual(set(component["properties"]), {"group_id"})
        self.assertTrue(component["properties"]["group_id"]["nullable"])
        self.assertNotIn("required", component)
        resp = self.client.post(f"/api/v1/boards/{self.board.pk}/move-group/", {"group_id": None}, format="json")
        self.assertEqual(resp.status_code, 200)
        self._assert_matches("post", path, 200, resp.json())

    def test_saved_filter_create_documents_the_preset_request(self):
        path = "/api/v1/boards/{id}/saved-filters/"
        schema = self._request_schema("post", path)
        self.assertTrue(schema["$ref"].endswith("/SavedFilterRequest"))
        component = self._component(schema["$ref"])
        self.assertEqual(set(component["properties"]), {"name", "state_json", "state_version"})
        self.assertEqual(sorted(component["required"]), ["name", "state_json"])
        resp = self.client.post(
            f"/api/v1/boards/{self.board.pk}/saved-filters/",
            {"name": "Mine", "state_json": {"search": "x"}}, format="json",
        )
        self.assertEqual(resp.status_code, 201)
        self._assert_matches("post", path, 201, resp.json())

    def test_summary_documents_its_real_shape(self):
        path = "/api/v1/boards/{id}/summary/"
        ref = self._op("get", path)["responses"]["200"]["content"][_JSON]["schema"]["$ref"]
        self.assertTrue(ref.endswith("/BoardSummary"))
        self.assertEqual(set(self._component(ref)["properties"]), {"swimlanes", "extension_panels"})
        self._add_history()
        resp = self.client.get(f"/api/v1/boards/{self.board.pk}/summary/")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertIsNotNone(body["swimlanes"][0]["avg_cycle_days"])
        self._assert_matches("get", path, 200, body)

    def test_analytics_documents_its_real_shape_and_query_params(self):
        path = "/api/v1/boards/{id}/analytics/"
        op = self._op("get", path)
        params = {p["name"]: p["schema"] for p in op["parameters"] if p["in"] == "query"}
        self.assertEqual(params["days"], {"type": "integer", "minimum": 1, "maximum": 365})
        self.assertEqual(params["stalled_days"], {"type": "integer", "minimum": 1, "maximum": 90})
        self.assertIn("400", op["responses"])
        self._add_history()
        resp = self.client.get(f"/api/v1/boards/{self.board.pk}/analytics/", {"stalled_days": 1})
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        # The fixture reaches the nullable and nested branches being validated.
        self.assertTrue(body["swimlanes"][0]["stalled_cards"])
        self._assert_matches("get", path, 200, body)
        resp = self.client.get(f"/api/v1/boards/{self.board.pk}/analytics/", {"days": 0})
        self.assertEqual(resp.status_code, 400)
        self._assert_matches("get", path, 400, resp.json())
        # The one 400 shape for a bad query parameter (#1825): code is required.
        ref = op["responses"]["400"]["content"][_JSON]["schema"]["$ref"]
        self.assertTrue(ref.endswith("/BoardAnalyticsBadRequest"))
        self.assertEqual(sorted(self._component(ref)["required"]), ["code", "detail"])

    def test_export_documents_csv_and_json_downloads(self):
        path = "/api/v1/boards/{id}/export/"
        op = self._op("get", path)
        content = op["responses"]["200"]["content"]
        self.assertEqual(set(content), {"text/csv", _JSON})
        self.assertEqual(content["text/csv"]["schema"], {"type": "string"})
        self.assertTrue(content[_JSON]["schema"]["$ref"].endswith("/BoardExport"))
        fmt = next(p for p in op["parameters"] if p["name"] == "format")
        self.assertEqual(fmt["schema"]["enum"], ["csv", "json"])
        url = f"/api/v1/boards/{self.board.pk}/export/"
        resp = self.client.get(url)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp["Content-Type"], "text/csv")
        resp = self.client.get(url, {"format": "json"})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp["Content-Type"], _JSON)
        self._assert_matches("get", path, 200, resp.json())
        # ``format=csv`` is a documented value and must not 404 (#1790).
        resp = self.client.get(url, {"format": "csv"})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp["Content-Type"], "text/csv")

    # -- cards -----------------------------------------------------------------

    def test_archive_and_unarchive_have_no_request_body(self):
        base = "/api/v1/boards/{board_pk}/cards/{id}/"
        for action in ("archive", "unarchive"):
            with self.subTest(action=action):
                self._assert_no_request_body("post", f"{base}{action}/")
        url = f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/"
        resp = self.client.post(f"{url}archive/")
        self.assertEqual(resp.status_code, 200)
        self._assert_matches("post", f"{base}archive/", 200, resp.json())
        resp = self.client.post(f"{url}unarchive/")
        self.assertEqual(resp.status_code, 200)
        self._assert_matches("post", f"{base}unarchive/", 200, resp.json())

    # -- groups ----------------------------------------------------------------

    def _group(self):
        group = Group.objects.create(name="Group 1783", owner=self.owner)
        GroupMembership.objects.create(group=group, user=self.owner, role=GroupMembership.Role.ADMIN)
        return group

    def test_group_star_statuses_are_per_method_with_no_body(self):
        path = "/api/v1/groups/{id}/star/"
        self._assert_no_request_body("post", path)
        self.assertEqual(self._success_statuses("post", path), ["200", "201"])
        self.assertEqual(self._success_statuses("delete", path), ["204"])
        group = self._group()
        url = f"/api/v1/groups/{group.pk}/star/"
        resp = self.client.post(url)
        self.assertEqual(resp.status_code, 201)
        self._assert_matches("post", path, 201, resp.json())
        resp = self.client.post(url)
        self.assertEqual(resp.status_code, 200)
        self._assert_matches("post", path, 200, resp.json())
        resp = self.client.delete(url)
        self.assertEqual(resp.status_code, 204)
        self.assertFalse(GroupFavorite.objects.filter(group=group, user=self.owner).exists())

    def test_member_role_update_requires_only_role(self):
        path = "/api/v1/groups/{id}/members/{user_id}/"
        # The body itself is required too (a PATCH without `role` is a 400);
        # set by visiban.schema_hooks.require_declared_request_bodies.
        self.assertIs(self._op("patch", path)["requestBody"].get("required"), True)
        group = self._group()
        resp = self.client.patch(f"/api/v1/groups/{group.pk}/members/{self.owner.pk}/", {}, format="json")
        self.assertEqual(resp.status_code, 400)
        for media_type in _BODY_MEDIA_TYPES:
            with self.subTest(media_type=media_type):
                schema = self._request_schema("patch", path, media_type)
                self.assertEqual(set(schema["properties"]), {"role"})
                self.assertEqual(schema["required"], ["role"])
                self.assertEqual(
                    sorted(schema["properties"]["role"]["enum"]),
                    sorted(GroupMembership.Role.values),
                )
        # A real membership row has no is_inherited/inherited_from (those are
        # list-only), so PATCH documents its own component without them.
        ref = self._op("patch", path)["responses"]["200"]["content"][_JSON]["schema"]["$ref"]
        self.assertEqual(set(self._component(ref)["properties"]), {"id", "user", "role", "joined_at"})
        other =User.objects.create_user(username="member1783", password="pw")
        GroupMembership.objects.create(group=group, user=other, role=GroupMembership.Role.MEMBER)
        resp = self.client.patch(
            f"/api/v1/groups/{group.pk}/members/{other.pk}/", {"role": "viewer"}, format="json",
        )
        self.assertEqual(resp.status_code, 200)
        self._assert_matches("patch", path, 200, resp.json())

    def test_member_refusals_document_their_code(self):
        # #1825: the owner and last-active-admin refusals carry a string code.
        path = "/api/v1/groups/{id}/members/{user_id}/"
        delete_ref = self._op("delete", path)["responses"]["400"]["content"][_JSON]["schema"]["$ref"]
        self.assertTrue(delete_ref.endswith("/GroupMemberRemoveRefused"))
        self.assertEqual(sorted(self._component(delete_ref)["required"]), ["code", "detail"])
        patch_ref = self._op("patch", path)["responses"]["400"]["content"][_JSON]["schema"]["$ref"]
        self.assertTrue(patch_ref.endswith("/GroupMemberRoleUpdateRefused"))
        # PATCH also answers 400 for a bad role, with detail only.
        self.assertEqual(self._component(patch_ref)["required"], ["detail"])
        group = self._group()  # self.owner owns it and is its only admin
        url = f"/api/v1/groups/{group.pk}/members/{self.owner.pk}/"
        resp = self.client.patch(url, {"role": "member"}, format="json")
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json()["code"], "group_owner_protected")
        self._assert_matches("patch", path, 400, resp.json())
        resp = self.client.patch(url, {"role": "bogus"}, format="json")
        self.assertEqual(resp.status_code, 400)
        self.assertNotIn("code", resp.json())
        self._assert_matches("patch", path, 400, resp.json())
        resp = self.client.delete(url)
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json()["code"], "group_owner_protected")
        self._assert_matches("delete", path, 400, resp.json())

    def test_transfer_ownership_documents_both_required_keys(self):
        path = "/api/v1/groups/{id}/transfer-ownership/"
        op = self._op("post", path)
        self.assertTrue(op["requestBody"]["required"])
        component = self._component(self._request_schema("post", path)["$ref"])
        self.assertEqual(set(component["properties"]), {"new_owner_id", "confirmation"})
        self.assertEqual(sorted(component["required"]), ["confirmation", "new_owner_id"])
        group = self._group()
        heir = User.objects.create_user(username="heir1783", password="pw")
        GroupMembership.objects.create(group=group, user=heir, role=GroupMembership.Role.ADMIN)
        resp = self.client.post(
            f"/api/v1/groups/{group.pk}/transfer-ownership/",
            {"new_owner_id": heir.pk, "confirmation": group.name}, format="json",
        )
        self.assertEqual(resp.status_code, 200)
        self._assert_matches("post", path, 200, resp.json())

    def test_board_defaults_documents_only_its_two_fields(self):
        path = "/api/v1/groups/{id}/board-defaults/"
        component = self._component(self._request_schema("patch", path)["$ref"])
        self.assertEqual(set(component["properties"]), {"default_board_member_role", "allowed_priorities"})
        self.assertTrue(component["properties"]["default_board_member_role"].get("deprecated"))
        group = self._group()
        resp = self.client.patch(
            f"/api/v1/groups/{group.pk}/board-defaults/", {"allowed_priorities": ["low", "high"]}, format="json",
        )
        self.assertEqual(resp.status_code, 200)
        self._assert_matches("patch", path, 200, resp.json())

    # -- APIViews that published no body ---------------------------------------

    def test_change_password_documents_its_body(self):
        path = "/api/v1/auth/change-password/"
        self.assertTrue(self._op("post", path)["requestBody"]["required"])
        ref = self._request_schema("post", path)["$ref"]
        # Named for its route (#1825), apart from dj-rest-auth's
        # /auth/password/change/ body (old_password, new_password1/2).
        self.assertTrue(ref.endswith("/AuthChangePasswordRequest"), ref)
        self.assertNotIn("ChangePasswordRequest", self.schema["components"]["schemas"])
        component = self._component(ref)
        self.assertEqual(set(component["properties"]), {"current_password", "new_password"})
        self.assertEqual(component["required"], ["new_password"])
        other = self._request_schema("post", "/api/v1/auth/password/change/")["$ref"]
        self.assertIn("old_password", self._component(other)["properties"])

    def test_dj_rest_auth_password_bodies_keep_their_1_1_component_names(self):
        # #1825: the Visiban* serializer subclasses are pinned to the names 1.1
        # published, so generated clients see no type rename.
        schemas = self.schema["components"]["schemas"]
        for path, name in (
            ("/api/v1/auth/password/change/", "PasswordChangeRequest"),
            ("/api/v1/auth/password/reset/confirm/", "PasswordResetConfirmRequest"),
        ):
            with self.subTest(path=path):
                self.assertTrue(self._request_schema("post", path)["$ref"].endswith(f"/{name}"))
        self.assertNotIn("VisibanPasswordChangeRequest", schemas)
        self.assertNotIn("VisibanPasswordResetConfirmRequest", schemas)
        # The Visiban-owned /auth/change-password/ body stays a separate component.
        self.assertNotEqual(
            self._request_schema("post", "/api/v1/auth/change-password/")["$ref"],
            self._request_schema("post", "/api/v1/auth/password/change/")["$ref"],
        )

    def test_choose_username_documents_its_body_and_user_response(self):
        path = "/api/v1/auth/choose-username/"
        self.assertTrue(self._op("post", path)["requestBody"]["required"])
        component = self._component(self._request_schema("post", path)["$ref"])
        self.assertEqual(component["required"], ["username"])
        # A username change needs an interactive session (#1839), so sign in for real.
        session_client = APIClient()
        session_client.force_login(self.owner)
        resp = session_client.post("/api/v1/auth/choose-username/", {"username": "renamed1783"}, format="json")
        self.assertEqual(resp.status_code, 200)
        self._assert_matches("post", path, 200, resp.json())

    def test_current_user_documents_patch_body_and_responses(self):
        path = "/api/v1/auth/me/"
        self.assertTrue(self._request_schema("patch", path)["$ref"].endswith("/PatchedCurrentUserRequest"))
        resp = self.client.get(path)
        self.assertEqual(resp.status_code, 200)
        self._assert_matches("get", path, 200, resp.json())
        resp = self.client.patch(path, {"display_name": "Owner 1783"}, format="json")
        self.assertEqual(resp.status_code, 200)
        self._assert_matches("patch", path, 200, resp.json())

    def test_ws_ticket_documents_201_ticket_and_no_body(self):
        path = "/api/v1/auth/ws-ticket/"
        self._assert_no_request_body("post", path)
        # Was a bodiless 200; the view has always answered 201 with the ticket.
        self.assertEqual(self._success_statuses("post", path), ["201"])
        token = Token.objects.create(user=self.owner)
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION=f"Token {token.key}")
        resp = client.post(path)
        self.assertEqual(resp.status_code, 201)
        self._assert_matches("post", path, 201, resp.json())

    def test_resend_email_documents_200_detail(self):
        path = "/api/v1/auth/registration/resend-email/"
        # dj-rest-auth's view answers 200; the bundled extension left the
        # CreateAPIView default of 201 in the schema.
        self.assertEqual(self._success_statuses("post", path), ["200"])
        self.assertTrue(self._request_schema("post", path)["$ref"].endswith("/ResendEmailVerificationRequest"))
        resp = APIClient().post(path, {"email": "nobody-1783@example.com"}, format="json")
        self.assertEqual(resp.status_code, 200)
        self._assert_matches("post", path, 200, resp.json())

    def test_notification_mark_read_documents_optional_body(self):
        path = "/api/v1/notifications/mark-read/"
        op = self._op("post", path)
        self.assertNotIn("required", op["requestBody"])
        component = self._component(self._request_schema("post", path)["$ref"])
        self.assertEqual(set(component["properties"]), {"all", "ids"})
        self.assertNotIn("required", component)
        Notification.objects.create(recipient=self.owner, verb="v", board=self.board, card=self.card)
        self.assertTrue(Notification.objects.filter(recipient=self.owner, read=False).exists())
        resp = self.client.post(path, {"all": True}, format="json")
        self.assertEqual(resp.status_code, 200)
        self._assert_matches("post", path, 200, resp.json())
        self.assertFalse(Notification.objects.filter(recipient=self.owner, read=False).exists())

    # -- fixtures --------------------------------------------------------------

    def _add_history(self):
        """One card stalled in To Do, one completed: reaches every nullable branch."""
        now = timezone.now()

        def move(card, to, days_ago, source=None):
            mv = CardMovement.objects.create(
                card=card, from_column=source, to_column=to, to_column_name=to.name,
                to_swimlane=self.lane, to_swimlane_name=self.lane.name,
                moved_by=self.owner, movement_type=CardMovement.MovementType.MOVE,
            )
            CardMovement.objects.filter(pk=mv.pk).update(moved_at=now - datetime.timedelta(days=days_ago))

        move(self.card, self.todo, 5)
        finished = Card.objects.create(
            board=self.board, column=self.done, swimlane=self.lane,
            title="Finished", created_by=self.owner, position=1,
        )
        doing = Column.objects.create(board=self.board, name="Doing", position=2)
        move(finished, self.todo, 4)
        move(finished, doing, 3, source=self.todo)
        move(finished, self.done, 1, source=doing)
