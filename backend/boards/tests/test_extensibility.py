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


class NotificationDeliveryExtensionPointTests(TestCase):
    """``post_notification_created`` must stay attachable from outside OSS (#356).

    Enterprise #34 adds Slack/Teams/webhook delivery by connecting to this
    signal. Its name and kwargs are a 1.0+ commitment, and the receivers live in
    a repo this one cannot grep — so the shape is pinned here rather than
    discovered by a customer.
    """

    def test_signal_exists_and_is_a_django_signal(self):
        from django.dispatch import Signal
        from boards import signals

        self.assertIsInstance(signals.post_notification_created, Signal)

    def test_every_notification_creation_path_goes_through_the_funnel(self):
        """No creation site may bypass ``create_notifications``.

        ``bulk_create`` sends no ``post_save``, so a site that calls the manager
        directly is invisible to every delivery backend. That hole is not
        detectable from the enterprise side, which is why it is asserted here:
        ``Notification.objects.create``/``bulk_create`` must appear only in the
        funnel itself, in migrations, and in seed/test fixtures.
        """
        import pathlib

        root = pathlib.Path(__file__).resolve().parents[2]
        allowed = {
            # The funnel.
            "boards/services/notifications.py",
            # Seeded fixture data is not an event anybody asked to be told about.
            "boards/management/commands/seed_demo_data.py",
        }
        offenders = []
        for path in sorted(root.glob("**/*.py")):
            rel = path.relative_to(root).as_posix()
            if (
                rel in allowed
                or "/migrations/" in rel
                or "/tests/" in rel
                or rel.startswith(".venv/")
                or "/seed_data/" in rel
            ):
                continue
            text = path.read_text()
            if "Notification.objects.create(" in text or "Notification.objects.bulk_create(" in text:
                offenders.append(rel)
        self.assertEqual(
            offenders,
            [],
            "These modules create Notification rows without going through "
            "boards.services.notifications.create_notifications, so "
            "post_notification_created never fires for them: "
            f"{offenders}",
        )


class StringNamedHookListTests(TestCase):
    """Hook lists looked up by *name string* must keep those names (#1897).

    ``_run_custom_field_validator_hooks`` resolves its list with
    ``getattr(boards.hooks, hook_name)``, and the card/swimlane import paths
    pass the names as string literals. A rename of the list in ``boards/hooks.py``
    would not fail an import or a type check: the lookup would raise (or an
    enterprise registration would land on a list nothing reads). The names are
    a 1.0+ commitment, so they are pinned here.
    """

    HOOK_NAMES = ("CUSTOM_FIELD_VALIDATORS", "SWIMLANE_CUSTOM_FIELD_VALIDATORS")

    def test_named_lists_exist_and_are_lists(self):
        from boards import hooks

        for name in self.HOOK_NAMES:
            with self.subTest(hook=name):
                self.assertIsInstance(getattr(hooks, name, None), list)

    def test_every_literal_hook_name_in_source_is_pinned(self):
        """Any ``*_VALIDATORS`` string literal in non-test backend source is a pinned name.

        Scans every non-test, non-migration ``.py`` file (single or double
        quotes), so a new string-named lookup in a third file is caught too.
        """
        import re
        from pathlib import Path

        import boards

        backend = Path(boards.__file__).parent.parent
        pattern = re.compile(r"""["']([A-Z][A-Z_]*_VALIDATORS)["']""")
        found = set()
        for path in backend.rglob("*.py"):
            parts = path.relative_to(backend).parts
            if "tests" in parts or "migrations" in parts or path.name.startswith("test_"):
                continue
            if parts[0] in {".venv", "venv", "node_modules"}:
                continue
            found |= set(pattern.findall(path.read_text(encoding="utf-8")))
        self.assertTrue(found, "expected string-named hook lookups in the source")
        self.assertLessEqual(found, set(self.HOOK_NAMES))

    def test_validator_registered_on_each_list_is_run(self):
        from unittest import mock

        from boards import hooks
        from boards.serializers import _run_custom_field_validator_hooks

        definition = mock.Mock(field_type="text")
        for name in self.HOOK_NAMES:
            with self.subTest(hook=name):
                calls = []
                registered = getattr(hooks, name)
                validator = lambda d, v: calls.append(v) or v  # noqa: E731
                registered.append(validator)
                try:
                    if name == "CUSTOM_FIELD_VALIDATORS":
                        _run_custom_field_validator_hooks(definition, "x")
                    else:
                        _run_custom_field_validator_hooks(definition, "x", hook_name=name)
                finally:
                    registered.remove(validator)
                self.assertEqual(calls, ["x"])


class BoardCapabilitiesContractTests(TestCase):
    """``capabilities`` on the board payload is an additive-only contract (#1897).

    Adding a key means updating ``docs/api/boards.md`` and this test.
    """

    def test_capabilities_keys_are_pinned(self):
        """``capabilities`` exposes exactly ``movement_export`` in OSS (#1897)."""
        from boards.serializers import BoardFullSerializer

        self.assertEqual(
            BoardFullSerializer().get_capabilities(None), {"movement_export": False},
        )
