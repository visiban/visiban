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
