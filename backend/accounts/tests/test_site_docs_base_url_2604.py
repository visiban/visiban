"""Runtime docs base URL for the in-app help links (#2604).

``SiteSetting.docs_base_url`` lets an operator on the stock release image point
the help links at an internal docs mirror, which the build-time
``VITE_DOCS_BASE_URL`` cannot do. It is written by site admins through
``PATCH /api/v1/admin/settings/`` and read by everyone, signed in or not,
through ``GET /api/v1/auth/site-config/``, where it ends up in an ``href``. So
the validator is the security boundary: http(s) only, no embedded credentials.
"""
from django.core.exceptions import ValidationError
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.admin_views import SiteSettingSerializer
from accounts.models import (
    DOCS_BASE_URL_MAX_LENGTH,
    SiteSetting,
    User,
    validate_docs_base_url,
)

SETTINGS = "/api/v1/admin/settings/"
SITE_CONFIG = "/api/v1/auth/site-config/"
MIRROR = "https://docs.example.internal/visiban"
# Split from the URLs below so secret detection does not read them as credentials.
_AT = "@"

GOOD = (
    MIRROR,
    "http://docs.example.internal",
    "https://docs.example.internal/visiban/",
    "http://docs:8080/visiban",  # single-label host: the air-gapped case
    "http://10.0.0.5:8000",
    "HTTPS://Docs.Example.Internal",
)

BAD = (
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "ftp://docs.example.internal",
    "//docs.example.internal",
    "docs.example.internal",
    "https://",
    "https:///path",
    "https://docs.example .internal",
    "https://docs.example.internal/\tx",
    f"https://user:secret{_AT}docs.example.internal",
    f"https://user{_AT}docs.example.internal",
    "https://docs.example.internal/?q=1",
    "https://docs.example.internal/#top",
    "https://docs.example.internal/?",
    "https://docs.example.internal:99999",
    "https://docs.example.internal:port",
)


def make_admin(username="admin-2604"):
    admin = User.objects.create_user(username=username, password="pw-2604-Abcdef!")
    admin.is_site_admin = True
    admin.save(update_fields=["is_site_admin"])
    return admin


class ValidatorTests(TestCase):
    def test_accepts_http_and_https(self):
        for value in GOOD:
            with self.subTest(value=value):
                validate_docs_base_url(value)

    def test_rejects_other_schemes_credentials_query_and_malformed(self):
        for value in BAD:
            with self.subTest(value=value):
                with self.assertRaises(ValidationError):
                    validate_docs_base_url(value)

    def test_empty_is_allowed(self):
        validate_docs_base_url(None)
        validate_docs_base_url("")

    def test_model_full_clean_runs_it(self):
        # The Django admin form path: the model field carries the same validator.
        setting = SiteSetting.get()
        setting.docs_base_url = "javascript:alert(1)"
        with self.assertRaises(ValidationError) as ctx:
            setting.full_clean()
        self.assertIn("docs_base_url", ctx.exception.message_dict)


class SerializerTests(TestCase):
    def serializer(self, value):
        return SiteSettingSerializer(
            data={"docs_base_url": value}, partial=True, current=SiteSetting.get(),
        )

    def test_good_url_passes_and_is_trimmed(self):
        s = self.serializer(f"  {MIRROR}  ")
        self.assertTrue(s.is_valid(), s.errors)
        self.assertEqual(s.validated_data["docs_base_url"], MIRROR)

    def test_bad_scheme_is_refused_keyed_by_field(self):
        for value in ("javascript:alert(1)", "data:text/html,x", "ftp://docs.example.internal"):
            with self.subTest(value=value):
                s = self.serializer(value)
                self.assertFalse(s.is_valid())
                self.assertIn("docs_base_url", s.errors)

    def test_blank_and_null_both_clear_to_null(self):
        for value in ("", "   ", None):
            with self.subTest(value=value):
                s = self.serializer(value)
                self.assertTrue(s.is_valid(), s.errors)
                self.assertIsNone(s.validated_data["docs_base_url"])

    def test_too_long_is_refused(self):
        s = self.serializer("https://d.example/" + "a" * DOCS_BASE_URL_MAX_LENGTH)
        self.assertFalse(s.is_valid())
        self.assertIn("docs_base_url", s.errors)

    def test_read_includes_the_field(self):
        self.assertIn("docs_base_url", SiteSettingSerializer(SiteSetting.get()).data)

    def test_write_without_stored_row_fails_closed(self):
        # #1075: built without ``current``, validate() cannot judge the merged
        # state and must refuse rather than pass.
        s = SiteSettingSerializer(data={"docs_base_url": MIRROR}, partial=True)
        self.assertFalse(s.is_valid())


class AdminSettingsApiTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.client.force_authenticate(make_admin())

    def test_default_is_null(self):
        r = self.client.get(SETTINGS)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIsNone(r.json()["docs_base_url"])

    def test_patch_sets_then_blank_clears(self):
        r = self.client.patch(SETTINGS, {"docs_base_url": MIRROR}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assertEqual(r.json()["docs_base_url"], MIRROR)
        self.assertEqual(SiteSetting.get().docs_base_url, MIRROR)

        r = self.client.patch(SETTINGS, {"docs_base_url": ""}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assertIsNone(r.json()["docs_base_url"])
        self.assertIsNone(SiteSetting.get().docs_base_url)

    def test_patch_rejects_javascript_and_keeps_stored_value(self):
        self.client.patch(SETTINGS, {"docs_base_url": MIRROR}, format="json")
        r = self.client.patch(SETTINGS, {"docs_base_url": "javascript:alert(1)"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("docs_base_url", r.json())
        self.assertEqual(SiteSetting.get().docs_base_url, MIRROR)

    def test_absent_key_leaves_stored_value(self):
        self.client.patch(SETTINGS, {"docs_base_url": MIRROR}, format="json")
        r = self.client.patch(SETTINGS, {"uploads_enabled": False}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(SiteSetting.get().docs_base_url, MIRROR)

    def test_non_admin_cannot_set_it(self):
        member = User.objects.create_user(username="member-2604", password="pw-2604-Abcdef!")
        client = APIClient()
        client.force_authenticate(member)
        r = client.patch(SETTINGS, {"docs_base_url": MIRROR}, format="json")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertIsNone(SiteSetting.get().docs_base_url)

    def test_anonymous_cannot_set_it(self):
        r = APIClient().patch(SETTINGS, {"docs_base_url": MIRROR}, format="json")
        self.assertIn(r.status_code, (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN))
        self.assertIsNone(SiteSetting.get().docs_base_url)


class SiteConfigPayloadTests(TestCase):
    def bodies(self):
        anonymous = APIClient().get(SITE_CONFIG)
        client = APIClient()
        client.force_authenticate(User.objects.create_user(username="reader-2604", password="pw-2604-Abcdef!"))
        authenticated = client.get(SITE_CONFIG)
        self.assertEqual(anonymous.status_code, status.HTTP_200_OK)
        self.assertEqual(authenticated.status_code, status.HTTP_200_OK)
        return anonymous.json(), authenticated.json()

    def test_null_when_unset_for_anonymous_and_authenticated(self):
        anonymous, authenticated = self.bodies()
        self.assertIn("docs_base_url", anonymous)
        self.assertIsNone(anonymous["docs_base_url"])
        self.assertIsNone(authenticated["docs_base_url"])

    def test_set_value_for_anonymous_and_authenticated(self):
        setting = SiteSetting.get()
        setting.docs_base_url = MIRROR
        setting.save()
        anonymous, authenticated = self.bodies()
        self.assertEqual(anonymous["docs_base_url"], MIRROR)
        self.assertEqual(authenticated["docs_base_url"], MIRROR)

    def test_blank_written_outside_the_api_is_served_as_null(self):
        # A shell or Django admin write can store "" rather than null; the SPA
        # gets one empty state either way.
        setting = SiteSetting.get()
        setting.docs_base_url = ""
        setting.save()
        anonymous, _ = self.bodies()
        self.assertIsNone(anonymous["docs_base_url"])
