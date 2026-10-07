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

