"""Verify the OSS extension points stay structurally intact (#1009).

These tests do not exercise enterprise code (which is not present in the OSS
repo); they verify that the extension *seams* exist in the OSS source so a
future enterprise add-on can plug in without modifying OSS files.
"""

from django.test import TestCase


class WebSocketExtensionPointTests(TestCase):
    """``visiban.asgi.websocket_urlpatterns`` must remain extensible (#1009)."""

    def test_websocket_urlpatterns_is_a_list(self):
        """The pattern collection is a *list* so enterprise can append to it.

        If a future refactor switches it to a tuple, ``enterprise.routing``
        cannot extend it without a fork. Pin the type contract here.
        """
        from visiban import asgi
        self.assertIsInstance(asgi.websocket_urlpatterns, list)

    def test_oss_websocket_urlpatterns_includes_board_and_group_routes(self):
        """The OSS WS surface still includes the board and group consumers.

        A regression that drops one of these would silently break real-time
        updates; the test confirms both apps' patterns are present.
        """
        from visiban import asgi
        joined = "".join(repr(p) for p in asgi.websocket_urlpatterns)
        self.assertIn("boards/", joined)
        self.assertIn("groups/", joined)

    def test_asgi_module_silently_skips_missing_enterprise_routing(self):
        """When ``enterprise.routing`` is not importable (the OSS-only case),
        ``asgi`` must still load cleanly. If the try/except around the
        ``enterprise.routing`` import is accidentally removed, the OSS
        deployment would fail to start with an ``ImportError`` here.
        """
        # Reaching this assertion means importing ``visiban.asgi`` did not
        # raise — exactly the contract the extension point promises.
        from visiban import asgi
        self.assertTrue(hasattr(asgi, "application"))


class URLConfExtensionPointTests(TestCase):
    """``visiban.urls`` must load without the enterprise package (#1047).

    The URLConf ends with a ``try: from enterprise.urls import ... except
    ImportError: pass`` block. In the OSS repo ``enterprise`` is absent, so the
    except branch is taken; if that guard is ever removed, importing the module
    here would raise ``ImportError`` and fail this test. (The same module loads
    cleanly in the enterprise mirror, where the try branch succeeds — so this
    assertion is safe in both repos.)
    """

    def test_urlconf_loads_and_has_oss_patterns(self):
        from visiban import urls
        self.assertTrue(hasattr(urls, "urlpatterns"))
        # The OSS URL set is non-empty regardless of the enterprise include.
        self.assertGreater(len(urls.urlpatterns), 0)


class SettingsExtensionPointTests(TestCase):
    """``visiban.settings`` must load without the enterprise package (#1047).

    Settings ends with a ``try: from enterprise.settings import * except
    ImportError: pass`` block. Mirrors the URLConf guard above: removing the
    try/except would break OSS startup, which this test surfaces.
    """

    def test_settings_loads_and_has_core_settings(self):
        from visiban import settings
        self.assertTrue(hasattr(settings, "INSTALLED_APPS"))
        self.assertIn("boards", settings.INSTALLED_APPS)
