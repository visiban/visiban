"""The send endpoints' declared 400 must admit DRF's field-error shape (#731).

``backend-schema-fuzz`` failed on ``POST /groups/{id}/invite-links/send/``: the
400 was declared as ``{detail, code?}`` with ``detail`` required, but a
validation failure returns ``{"email": ["..."]}``. Same technique as
``accounts/tests/test_auth_schema_contract.py``.
"""
import jsonschema
from django.test import TestCase
from drf_spectacular.generators import SchemaGenerator

from boards.tests.test_move_schema_contract import _openapi3_nullable_to_jsonschema

SEND_PATHS = (
    "/api/v1/groups/{id}/invite-links/send/",
    "/api/v1/admin/invite-links/send/",
    "/api/v1/boards/{id}/invite-links/send/",  # #1444
)


class InviteEmailSchemaContractTests(TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.schema = SchemaGenerator().get_schema(request=None, public=True)

    def _assert_valid_400(self, path, body):
        fragment = self.schema["paths"][path]["post"]["responses"]["400"]["content"][
            "application/json"
        ]["schema"]
        combined = {**fragment, "components": self.schema["components"]}
        jsonschema.validate(
            instance=body, schema=_openapi3_nullable_to_jsonschema(combined)
        )

    def test_400_admits_field_validation_shape(self):
        for path in SEND_PATHS:
            with self.subTest(path=path):
                self._assert_valid_400(path, {"email": ["Enter a valid email address."]})

    def test_400_admits_cap_reached_shape(self):
        for path in SEND_PATHS:
            with self.subTest(path=path):
                self._assert_valid_400(
                    path,
                    {"detail": "Too many pending.", "code": "invite_email_cap_reached"},
                )

    def test_board_400_admits_expiry_and_role_field_errors(self):
        self._assert_valid_400(
            "/api/v1/boards/{id}/invite-links/send/",
            {"expiry_days": ['"14" is not a valid choice.'], "role": ['"admin" is not a valid choice.']},
        )

    def test_board_join_declares_410_with_code(self):
        for method in ("get", "post"):
            with self.subTest(method=method):
                responses = self.schema["paths"]["/api/v1/boards/join/{token}/"][method]["responses"]
                self.assertIn("410", responses)
                self.assertIn("404", responses)


class BoardInviteLinkCreateSchemaContractTests(TestCase):
    """``POST /boards/{id}/invite-links/`` (#439): the 400 admits both the
    cap-reached ``{detail}`` and DRF's field-error shape, with no ``detail``."""

    PATH = "/api/v1/boards/{id}/invite-links/"

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.schema = SchemaGenerator().get_schema(request=None, public=True)

    _assert_valid_400 = InviteEmailSchemaContractTests._assert_valid_400

    def test_create_400_does_not_require_detail(self):
        self._assert_valid_400(self.PATH, {"expiry_days": ["This field is required."]})
        self._assert_valid_400(
            self.PATH,
            {"role": ['"admin" is not a valid choice.'], "single_use": ["Must be a valid boolean."]},
        )

    def test_create_400_admits_cap_reached(self):
        self._assert_valid_400(
            self.PATH,
            {"detail": "Maximum of 5 active invite links reached. Revoke a link to create a new one."},
        )


class BoardInviteSuccessBodySchemaContractTests(TestCase):
    """Real success bodies of the #439 endpoints validate against the published
    schema: the create 201 (with the one-time ``token``), and the site-admin
    list 200 and revoke 200. Same technique as the 400 checks above."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.schema = SchemaGenerator().get_schema(request=None, public=True)

    def setUp(self):
        from datetime import timedelta

        from django.core.cache import cache
        from django.utils import timezone
        from rest_framework.test import APIClient

        from accounts.models import User
        from boards.models import Board, BoardInviteLink

        cache.clear()
        self.addCleanup(cache.clear)
        self.site_admin = User.objects.create_user(username="sa", password="p", is_site_admin=True)
        self.owner = User.objects.create_user(username="owner", password="p")
        self.board = Board.objects.create(name="Launch Plan", owner=self.owner)
        self.owner_client = APIClient()
        self.owner_client.force_authenticate(self.owner)
        self.admin_client = APIClient()
        self.admin_client.force_authenticate(self.site_admin)
        # One emailed invite whose sender was deleted (nullable fields exercised).
        emailed, _ = BoardInviteLink.generate(
            board=self.board, created_by=self.owner, single_use=True, delivery="email",
            expires_at=timezone.now() + timedelta(days=7),
        )
        BoardInviteLink.objects.filter(pk=emailed.pk).update(created_by=None)

    def _assert_valid(self, path, method, code, body):
        fragment = self.schema["paths"][path][method]["responses"][str(code)]["content"][
            "application/json"
        ]["schema"]
        combined = {**fragment, "components": self.schema["components"]}
        jsonschema.validate(instance=body, schema=_openapi3_nullable_to_jsonschema(combined))

    def test_create_201_body(self):
        r = self.owner_client.post(
            f"/api/v1/boards/{self.board.pk}/invite-links/",
            {"expiry_days": 7, "role": "viewer", "name": "x"}, format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertIn("token", r.json())
        self._assert_valid("/api/v1/boards/{id}/invite-links/", "post", 201, r.json())

    def test_board_list_200_body(self):
        self.owner_client.post(f"/api/v1/boards/{self.board.pk}/invite-links/", {"expiry_days": 1}, format="json")
        r = self.owner_client.get(f"/api/v1/boards/{self.board.pk}/invite-links/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.json()), 2)
        self._assert_valid("/api/v1/boards/{id}/invite-links/", "get", 200, r.json())

    def test_admin_list_200_and_revoke_200_bodies(self):
        self.owner_client.post(f"/api/v1/boards/{self.board.pk}/invite-links/", {"expiry_days": 30}, format="json")
        r = self.admin_client.get("/api/v1/admin/board-invite-links/?status=all")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["count"], 2)
        self._assert_valid("/api/v1/admin/board-invite-links/", "get", 200, r.json())

        link_id = r.json()["results"][0]["id"]
        r = self.admin_client.delete(f"/api/v1/admin/board-invite-links/{link_id}/")
        self.assertEqual(r.status_code, 200)
        self._assert_valid("/api/v1/admin/board-invite-links/{id}/", "delete", 200, r.json())

