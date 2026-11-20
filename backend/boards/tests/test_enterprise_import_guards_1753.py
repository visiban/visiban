"""The enterprise import guards skip only an absent enterprise module (#1753).

``visiban/settings.py``, ``urls.py`` and ``asgi.py`` import an optional
enterprise module each. An OSS-only install (no ``enterprise`` package, or no
such module in it) is skipped; a broken enterprise install (its own dependency
missing, a bad import inside it) must fail startup instead of silently losing
its settings or routes.
"""

import ast
import importlib
import importlib.util
import sys
import tempfile
import textwrap
from unittest import skipIf
from pathlib import Path

from django.test import SimpleTestCase
from django.urls import clear_url_caches

from visiban.enterprise_imports import enterprise_module_missing

BACKEND = Path(__file__).resolve().parents[2]


def _mnfe(name):
    return ModuleNotFoundError(f"No module named {name!r}", name=name)


class EnterpriseModuleMissingTests(SimpleTestCase):
    def test_absent_package_is_missing(self):
        self.assertTrue(enterprise_module_missing(_mnfe("enterprise"), "enterprise.urls"))

    def test_absent_requested_module_is_missing(self):
        self.assertTrue(enterprise_module_missing(_mnfe("enterprise.urls"), "enterprise.urls"))

    def test_absent_intermediate_package_is_missing(self):
        self.assertTrue(enterprise_module_missing(_mnfe("enterprise.ws"), "enterprise.ws.routing"))

    def test_missing_dependency_of_enterprise_is_not(self):
        self.assertFalse(enterprise_module_missing(_mnfe("saml2"), "enterprise.urls"))

    def test_missing_other_enterprise_submodule_is_not(self):
        """``enterprise.urls`` importing a missing ``enterprise.saml.views`` is broken."""
        self.assertFalse(
            enterprise_module_missing(_mnfe("enterprise.saml.views"), "enterprise.urls"),
        )

    def test_lookalike_package_name_is_not(self):
        self.assertFalse(enterprise_module_missing(_mnfe("enterprise_extras"), "enterprise.urls"))

    def test_plain_import_error_is_not(self):
        """``cannot import name ...`` from an installed module is a broken install."""
        exc = ImportError("cannot import name 'enterprise_urlpatterns'", name="enterprise.urls")
        self.assertFalse(enterprise_module_missing(exc, "enterprise.urls"))

    def test_absent_name_is_not(self):
        """A guard that cannot tell which module is missing does not hide it."""
        self.assertFalse(enterprise_module_missing(ModuleNotFoundError("gone"), "enterprise.urls"))


class GuardSitesTests(SimpleTestCase):
    """Each site catches only ``ModuleNotFoundError``, re-raises unless the
    predicate says the enterprise module is absent, and names its own module."""

    SITES = {
        "visiban/settings.py": "enterprise.settings",
        "visiban/urls.py": "enterprise.urls",
        "visiban/asgi.py": "enterprise.routing",
    }

    def _guard(self, path, module):
        tree = ast.parse((BACKEND / path).read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Try) and any(
                isinstance(s, ast.ImportFrom) and s.module == module for s in node.body
            ):
                return node
        self.fail(f"{path}: no try block importing {module}")

    def test_every_site_uses_the_narrow_guard(self):
        for path, module in self.SITES.items():
            with self.subTest(path=path):
                guard = self._guard(path, module)
                self.assertEqual(len(guard.handlers), 1)
                handler = guard.handlers[0]
                self.assertEqual(ast.unparse(handler.type), "ModuleNotFoundError")
                src = ast.unparse(handler)
                self.assertIn(f"enterprise_module_missing({handler.name}, '{module}')", src)
                self.assertIsInstance(handler.body[-1], ast.If)
                self.assertIsInstance(handler.body[-1].body[-1], ast.Raise)


class UrlsGuardBehaviorTests(SimpleTestCase):
    """``visiban/urls.py`` re-executed against a fake enterprise package."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        # The enterprise mirror runs this suite with the real package
        # importable; hide it for the test and put back exactly what was there.
        self._saved_modules = {
            m: sys.modules.pop(m)
            for m in [m for m in sys.modules if m == "enterprise" or m.startswith("enterprise.")]
        }
        self.addCleanup(self._restore)
        sys.path.insert(0, self._tmp.name)

    def _restore(self):
        sys.path.remove(self._tmp.name)
        for name in [m for m in sys.modules if m == "enterprise" or m.startswith("enterprise.")]:
            del sys.modules[name]
        sys.modules.update(self._saved_modules)
        import visiban.urls

        importlib.reload(visiban.urls)
        clear_url_caches()
        self._tmp.cleanup()

    def _fake_enterprise(self, urls_source):
        pkg = Path(self._tmp.name) / "enterprise"
        pkg.mkdir()
        (pkg / "__init__.py").write_text("")
        if urls_source is not None:
            (pkg / "urls.py").write_text(textwrap.dedent(urls_source))
        importlib.invalidate_caches()

    def _reload_urls(self):
        import visiban.urls

        return importlib.reload(visiban.urls)

    @skipIf(importlib.util.find_spec("enterprise") is not None, "real enterprise package installed")
    def test_no_enterprise_package_is_skipped(self):
        self.assertEqual(self._reload_urls().extension_urlpatterns, [])

    def test_enterprise_without_urls_module_is_skipped(self):
        self._fake_enterprise(None)
        self.assertEqual(self._reload_urls().extension_urlpatterns, [])

    def test_working_enterprise_urls_are_mounted(self):
        self._fake_enterprise("""
            from django.urls import path
            from django.http import HttpResponse
            enterprise_urlpatterns = [path("ee-1753/", lambda r: HttpResponse("ok"))]
        """)
        urls = self._reload_urls()
        self.assertEqual(len(urls.extension_urlpatterns), 1)

    def test_enterprise_with_a_missing_dependency_fails_loudly(self):
        self._fake_enterprise("import visiban_missing_dependency_1753\nenterprise_urlpatterns = []\n")
        with self.assertRaises(ModuleNotFoundError) as ctx:
            self._reload_urls()
        self.assertEqual(ctx.exception.name, "visiban_missing_dependency_1753")

    def test_enterprise_with_a_bad_name_import_fails_loudly(self):
        self._fake_enterprise("from django.urls import no_such_name_1753\n")
        with self.assertRaises(ImportError):
            self._reload_urls()
