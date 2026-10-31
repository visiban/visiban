"""info.version in the generated OpenAPI schema tracks APP_VERSION (#1977)."""
import os
import subprocess
import sys
from pathlib import Path

from django.conf import settings
from django.test import TestCase
from drf_spectacular.generators import SchemaGenerator

BACKEND_DIR = Path(__file__).resolve().parents[2]


def _spectacular_version_with_env(app_version):
    """Load settings in a fresh interpreter, since settings are read once at import."""
    env = {**os.environ, "APP_VERSION": app_version}
    code = (
        "import django; from django.conf import settings; "
        "print(repr((settings.SPECTACULAR_SETTINGS['VERSION'], settings.APP_VERSION)))"
    )
    out = subprocess.run(  # list-form args, no shell
        [sys.executable, "-c", code],
        cwd=BACKEND_DIR,
        env={**env, "DJANGO_SETTINGS_MODULE": os.environ.get("DJANGO_SETTINGS_MODULE", "visiban.settings")},
        capture_output=True,
        text=True,
        check=True,
    )
    return eval(out.stdout.strip().splitlines()[-1])  # noqa: S307 - our own repr of two strings


class SchemaVersionTests(TestCase):
    def test_info_version_matches_app_version(self):
        schema = SchemaGenerator().get_schema(request=None, public=True)
        self.assertEqual(schema["info"]["version"], settings.APP_VERSION or "dev")

    def test_v_prefixed_app_version_is_normalized(self):
        self.assertEqual(_spectacular_version_with_env("v1.2.3"), ("1.2.3", "1.2.3"))

    def test_empty_app_version_falls_back_to_dev_for_schema_only(self):
        self.assertEqual(_spectacular_version_with_env(""), ("dev", ""))
        self.assertEqual(_spectacular_version_with_env("v"), ("dev", ""))
