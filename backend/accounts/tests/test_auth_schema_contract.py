"""Schema-vs-response contract tests for dj-rest-auth-derived auth endpoints
(#1408).

``backend-schema-fuzz-deep`` failed on ``POST /api/v1/auth/password/change/``:
the generated OpenAPI 200 response documented the *request* body's required
fields (``new_password1``/``new_password2``) instead of the real
``{"detail": "..."}`` response. Root cause: drf-spectacular's dj-rest-auth
integration (``drf_spectacular/contrib/rest_auth.py``) matches each stock
dj-rest-auth view by exact class identity
(``OpenApiGeneratorExtension.match_subclasses`` defaults ``False``), not by
subclass, so none of it ever applied to Visiban's own subclasses
(``TokenRevokingPasswordChangeView``, ``ThrottledPasswordResetView``,
``ThrottledPasswordResetConfirmView``, ``ThrottledLoginView``,
``InviteRegisterView``) — each fell back to introspecting its *request*
serializer for the response too.

Same technique as ``boards/tests/test_move_schema_contract.py`` (#1108):
generate the real OpenAPI document and validate live responses against it, so
a future edit that drops one of these views' ``@extend_schema`` override (or
otherwise drifts the documented response from the real one) fails a test
instead of silently shipping a wrong contract to a schema-generated client.
"""

import jsonschema
from allauth.account.forms import default_token_generator
from allauth.account.models import EmailAddress
from allauth.account.utils import user_pk_to_url_str
from django.test import TestCase
from drf_spectacular.generators import SchemaGenerator
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.tests.test_move_schema_contract import _openapi3_nullable_to_jsonschema


class AuthSchemaContractTests(TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # Generate once per class: walking every registered view is not cheap
        # enough to repeat per test method.
        cls.schema = SchemaGenerator().get_schema(request=None, public=True)

    def setUp(self):
        self.client = APIClient()

    def _assert_valid(self, body, path, method="post", status_code="200"):
        schema_fragment = self.schema["paths"][path][method]["responses"][status_code][
            "content"
        ]["application/json"]["schema"]
        combined = {**schema_fragment, "components": self.schema["components"]}
        combined = _openapi3_nullable_to_jsonschema(combined)
        jsonschema.validate(instance=body, schema=combined)

    def test_password_change_response_matches_documented_schema(self):
        """The real response is {"detail": "..."}, never new_password1/2."""
        user = User.objects.create_user(username="pwchanger", password="OldPassword123!")
        self.client.force_authenticate(user)

        resp = self.client.post(
            "/api/v1/auth/password/change/",
            {
                "old_password": "OldPassword123!",
                "new_password1": "BrandNewPassword456!",
                "new_password2": "BrandNewPassword456!",
            },
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        body = resp.json()
        self.assertEqual(set(body), {"detail"})
        self._assert_valid(body, "/api/v1/auth/password/change/")

    def test_change_password_documents_optional_key(self):
        """Both password-change routes document `key` as optional (#1562)."""
        for path in ("/api/v1/auth/change-password/", "/api/v1/auth/password/change/"):
            with self.subTest(path=path):
                schema = self.schema["paths"][path]["post"]["responses"]["200"]["content"][
                    "application/json"
                ]["schema"]
                ref = schema["$ref"].rsplit("/", 1)[-1]
                component = self.schema["components"]["schemas"][ref]
                self.assertIn("key", component["properties"])
                self.assertNotIn("key", component.get("required", []))
                self.assertIn("detail", component.get("required", []))

    def test_change_password_token_caller_response_matches_documented_schema(self):
        """A Token caller's {"detail", "key"} body validates against the schema."""
        from rest_framework.authtoken.models import Token

        user = User.objects.create_user(username="tokchanger", password="OldPassword123!")
        token = Token.objects.create(user=user)
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {token.key}")

        resp = self.client.post(
            "/api/v1/auth/change-password/",
            {"current_password": "OldPassword123!", "new_password": "BrandNewPassword456!"},
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        body = resp.json()
        self.assertEqual(set(body), {"detail", "key"})
        self._assert_valid(body, "/api/v1/auth/change-password/")

    def test_password_reset_response_matches_documented_schema(self):
        """The real response is {"detail": "..."}, never the request's `email`."""
        user = User.objects.create_user(username="pwresetter", email="reset@example.com")
        EmailAddress.objects.create(
            user=user, email="reset@example.com", verified=True, primary=True
        )

        resp = self.client.post("/api/v1/auth/password/reset/", {"email": "reset@example.com"})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        body = resp.json()
        self.assertEqual(set(body), {"detail"})
        self._assert_valid(body, "/api/v1/auth/password/reset/")

    def test_password_reset_confirm_response_matches_documented_schema(self):
        """The real response is {"detail": "..."}, never uid/token/new_password1/2."""
        user = User.objects.create_user(username="pwconfirmer", email="confirm@example.com")
        EmailAddress.objects.create(
            user=user, email="confirm@example.com", verified=True, primary=True
        )
        uid = user_pk_to_url_str(user)
        token = default_token_generator.make_token(user)

        resp = self.client.post(
            "/api/v1/auth/password/reset/confirm/",
            {
                "uid": uid,
                "token": token,
                "new_password1": "AnotherNewPassword789!",
                "new_password2": "AnotherNewPassword789!",
            },
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        body = resp.json()
        self.assertEqual(set(body), {"detail"})
        self._assert_valid(body, "/api/v1/auth/password/reset/confirm/")

    def test_login_response_matches_documented_schema(self):
        """The real response is {"key": "<token>"}, never username/password."""
        User.objects.create_user(username="loginuser", password="LoginPassword123!")

        resp = self.client.post(
            "/api/v1/auth/login/",
            {"username": "loginuser", "password": "LoginPassword123!"},
            format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        body = resp.json()
        self.assertEqual(set(body), {"key"})
        self._assert_valid(body, "/api/v1/auth/login/")

    def test_registration_response_matches_documented_schema(self):
        """The real response is {"key": "<token>"}, never email/password1/2.

        Default SiteSetting.registration_mode is "open" (no invite_token
        needed) and default EMAIL_VERIFICATION is "optional" — the branch
        documented in docs/api/authentication.md's "Open mode" section.
        """
        resp = self.client.post(
            "/api/v1/auth/registration/",
            {
                "email": "newregistrant@example.com",
                "password1": "Sup3rS3cr3t!xyz",
                "password2": "Sup3rS3cr3t!xyz",
            },
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        body = resp.json()
        self.assertEqual(set(body), {"key"})
        self._assert_valid(body, "/api/v1/auth/registration/", status_code="201")
