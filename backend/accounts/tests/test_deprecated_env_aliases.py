"""Tests for the deprecated env-var alias warning helper (#819).

The helper must:
- Emit a DeprecationWarning *only* when the legacy env var is set.
- Stay silent when the legacy env var is absent (worker startup must not
  log a spurious warning on every restart).
"""
import os
import warnings
from unittest.mock import patch

from django.test import TestCase

from visiban.settings import _warn_deprecated_env_alias


class WarnDeprecatedEnvAliasTests(TestCase):

    def test_no_warning_when_alias_absent(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("OIDC_SECRET", None)
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                _warn_deprecated_env_alias("OIDC_SECRET", "OIDC_CLIENT_SECRET")
            relevant = [w for w in caught if issubclass(w.category, DeprecationWarning)]
            self.assertEqual(relevant, [])

    def test_warning_emitted_when_alias_set(self):
        with patch.dict(os.environ, {"OIDC_SECRET": "legacy-secret"}, clear=False):
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                _warn_deprecated_env_alias("OIDC_SECRET", "OIDC_CLIENT_SECRET")
            relevant = [w for w in caught if issubclass(w.category, DeprecationWarning)]
            self.assertEqual(len(relevant), 1)
            message = str(relevant[0].message)
            self.assertIn("OIDC_SECRET", message)
            self.assertIn("OIDC_CLIENT_SECRET", message)

    def test_no_warning_when_alias_set_to_empty_string(self):
        # Empty value means the operator did not actually set the alias.
        with patch.dict(os.environ, {"OIDC_SECRET": ""}, clear=False):
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                _warn_deprecated_env_alias("OIDC_SECRET", "OIDC_CLIENT_SECRET")
            relevant = [w for w in caught if issubclass(w.category, DeprecationWarning)]
            self.assertEqual(relevant, [])
