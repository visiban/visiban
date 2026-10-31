"""info.version in the generated OpenAPI schema tracks APP_VERSION (#1977)."""
from django.conf import settings
from django.test import TestCase
from drf_spectacular.generators import SchemaGenerator


class SchemaVersionTests(TestCase):
    def test_info_version_matches_app_version(self):
        schema = SchemaGenerator().get_schema(request=None, public=True)
        self.assertEqual(schema["info"]["version"], settings.APP_VERSION)

    def test_spectacular_version_not_hardcoded(self):
        self.assertEqual(settings.SPECTACULAR_SETTINGS["VERSION"], settings.APP_VERSION)
