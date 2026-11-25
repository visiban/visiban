"""Instance flags on ``/auth/site-config/`` (#1872).

``git_lens_enabled``, ``maintenance_mode``, ``maintenance_message``, ``demo_mode`` and
``demo_next_reset_at`` are served on the anonymous ``site-config`` endpoint and stay on
``/auth/user/`` (frozen there by #1664). Both read ``accounts.instance_flags``. These
tests pin three things:

* ``site-config`` reports each flag in each state, with the same values as ``/auth/user/``.
* The anonymous response contains nothing about the caller. An authenticated site admin
  gets a byte-identical body, and no identity field is present.
* The OpenAPI schema marks the four non-git-lens ``CurrentUser`` copies deprecated, and
  leaves ``git_lens_enabled`` undeprecated (#1666).
"""
from __future__ import annotations

from unittest import mock

from django.db import connection
from django.test import TestCase, override_settings
from django.test.utils import CaptureQueriesContext
from drf_spectacular.generators import SchemaGenerator
from rest_framework.test import APIClient

from accounts.models import (
    DEFAULT_MAINTENANCE_MESSAGE,
    SiteSetting,
    User,
    invalidate_maintenance_mode_cache,
)

SITE_CONFIG_URL = "/api/v1/auth/site-config/"
AUTH_USER_URL = "/api/v1/auth/user/"
PASSWORD = "pw-1872-Abcdef!"

INSTANCE_FLAGS = (
    "git_lens_enabled",
    "maintenance_mode",
    "maintenance_message",
    "demo_mode",
    "demo_next_reset_at",
)
DEPRECATED_ON_CURRENT_USER = {
    "maintenance_mode",
    "maintenance_message",
    "demo_mode",
    "demo_next_reset_at",
}

# The whole anonymous response, pinned. A new key here is a deliberate decision about
# what an unauthenticated caller may read.
SITE_CONFIG_KEYS = {
    "registration_open",
    "registration_mode",
    "demo_mode",
    "demo_login",
    "demo_reset_schedule",
    "demo_next_reset_at",
    "invite_email_available",
    "git_lens_enabled",
    "maintenance_mode",
    "maintenance_message",
    # #2313: the zone the overdue rule counts "today" in. A deployment locale,
    # not caller-dependent and not a secret.
    "instance_timezone",
    # #2604: the help-link docs base URL from Site settings. An instance
    # setting, not caller-dependent; the validator refuses embedded credentials.
    "docs_base_url",
}


def _set_maintenance(active: bool, message: str = "") -> None:
    setting = SiteSetting.get()
    setting.maintenance_mode = active
    setting.maintenance_message = message
    setting.save(update_fields=["maintenance_mode", "maintenance_message"])


class SiteConfigInstanceFlagsTests(TestCase):
    def setUp(self):
        # The maintenance tuple is cached across requests; never inherit a value.
        invalidate_maintenance_mode_cache()
        self.addCleanup(invalidate_maintenance_mode_cache)
        self.user = User.objects.create_user(username="flags-1872", password=PASSWORD)

    def _site_config(self) -> dict:
        response = APIClient().get(SITE_CONFIG_URL)
        self.assertEqual(response.status_code, 200)
        return response.json()

    def _auth_user(self) -> dict:
        client = APIClient()
        client.force_authenticate(self.user)
        response = client.get(AUTH_USER_URL)
        self.assertEqual(response.status_code, 200)
        return response.json()

    def _assert_same_on_both(self) -> dict:
        cfg, me = self._site_config(), self._auth_user()
        for key in INSTANCE_FLAGS:
            self.assertEqual(cfg[key], me[key], key)
            self.assertIs(type(cfg[key]), type(me[key]), key)
        return cfg

    # --- defaults -------------------------------------------------------------

    @override_settings(GIT_LENS_ENABLED=False, DEMO_MODE=False)
    def test_defaults_on_an_untouched_install(self):
        cfg = self._assert_same_on_both()
        self.assertIs(cfg["git_lens_enabled"], False)
        self.assertIs(cfg["maintenance_mode"], False)
        self.assertEqual(cfg["maintenance_message"], "")
        self.assertIs(cfg["demo_mode"], False)
        self.assertIsNone(cfg["demo_next_reset_at"])

    # --- maintenance ----------------------------------------------------------

    def test_maintenance_on_reports_the_operator_notice(self):
        _set_maintenance(True, "Upgrading - back by 14:00 UTC.")
        cfg = self._assert_same_on_both()
        self.assertIs(cfg["maintenance_mode"], True)
        self.assertEqual(cfg["maintenance_message"], "Upgrading - back by 14:00 UTC.")

    def test_maintenance_on_with_blank_notice_substitutes_the_default(self):
        _set_maintenance(True, "   ")
        cfg = self._assert_same_on_both()
        self.assertIs(cfg["maintenance_mode"], True)
        self.assertEqual(cfg["maintenance_message"], DEFAULT_MAINTENANCE_MESSAGE)

    def test_maintenance_off_hides_a_stale_notice(self):
        _set_maintenance(True, "old window")
        _set_maintenance(False, "old window")
        cfg = self._assert_same_on_both()
        self.assertIs(cfg["maintenance_mode"], False)
        self.assertEqual(cfg["maintenance_message"], "")

    # --- demo -----------------------------------------------------------------

    @override_settings(DEMO_MODE=True, DEMO_RESET_SCHEDULE="0 * * * *")
    def test_demo_on(self):
        cfg = self._assert_same_on_both()
        self.assertIs(cfg["demo_mode"], True)
        self.assertIsInstance(cfg["demo_next_reset_at"], str)

    @override_settings(DEMO_MODE=False, DEMO_RESET_SCHEDULE="0 * * * *")
    def test_demo_off_ignores_a_stray_schedule(self):
        cfg = self._assert_same_on_both()
        self.assertIs(cfg["demo_mode"], False)
        self.assertIsNone(cfg["demo_next_reset_at"])

    # --- git lens -------------------------------------------------------------

    @override_settings(GIT_LENS_ENABLED=True)
    def test_git_lens_on(self):
        self.assertIs(self._assert_same_on_both()["git_lens_enabled"], True)

    @override_settings(GIT_LENS_ENABLED=False)
    def test_git_lens_off(self):
        self.assertIs(self._assert_same_on_both()["git_lens_enabled"], False)


class SharedHelperWiringTests(TestCase):
    """Both endpoints must read accounts.instance_flags, not their own copy of the logic.

    Each helper is patched to a sentinel no real configuration produces (the settings
    say the opposite), so a view or serializer that bypasses the helper fails here
    even though its real values would still agree with the other endpoint.
    """

    SENTINELS = {
        "git_lens_enabled": True,
        "maintenance_mode": True,
        "maintenance_message": "sentinel-1872 notice",
        "demo_mode": True,
        "demo_next_reset_at": "2099-01-01T00:00:00Z",
    }

    @override_settings(GIT_LENS_ENABLED=False, DEMO_MODE=False)
    def test_both_endpoints_return_the_helper_values(self):
        invalidate_maintenance_mode_cache()
        self.addCleanup(invalidate_maintenance_mode_cache)
        user = User.objects.create_user(username="wiring-1872", password=PASSWORD)
        with mock.patch("accounts.instance_flags.git_lens_enabled", return_value=True), \
                mock.patch("accounts.instance_flags.demo_mode", return_value=True), \
                mock.patch(
                    "accounts.instance_flags.demo_next_reset_at",
                    return_value=self.SENTINELS["demo_next_reset_at"],
                ), \
                mock.patch(
                    "accounts.instance_flags.maintenance_notice",
                    return_value=(True, self.SENTINELS["maintenance_message"]),
                ):
            cfg = APIClient().get(SITE_CONFIG_URL).json()
            client = APIClient()
            client.force_authenticate(user)
            me = client.get(AUTH_USER_URL).json()
        for key, expected in self.SENTINELS.items():
            self.assertEqual(cfg[key], expected, f"site-config {key}")
            self.assertEqual(me[key], expected, f"auth/user {key}")


class SiteConfigCarriesNoCallerDataTests(TestCase):
    """``site-config`` is AllowAny: nothing in it may depend on who is asking."""

    def setUp(self):
        invalidate_maintenance_mode_cache()
        self.addCleanup(invalidate_maintenance_mode_cache)

    def _bodies(self):
        anonymous = APIClient().get(SITE_CONFIG_URL)
        admin = User.objects.create_user(username="admin-1872", password=PASSWORD)
        admin.is_site_admin = True
        admin.save(update_fields=["is_site_admin"])
        client = APIClient()
        client.force_authenticate(admin)
        authenticated = client.get(SITE_CONFIG_URL)
        self.assertEqual(anonymous.status_code, 200)
        self.assertEqual(authenticated.status_code, 200)
        return anonymous, authenticated

    def test_anonymous_key_set_is_pinned(self):
        anonymous, _ = self._bodies()
        self.assertEqual(set(anonymous.json()), SITE_CONFIG_KEYS)

    def test_no_identity_fields(self):
        anonymous, _ = self._bodies()
        body = anonymous.json()
        for key in (
            "id", "username", "email", "is_site_admin", "can_access_all_content",
            "pending_email", "pending_connect_provider", "pending_connect_identity",
        ):
            self.assertNotIn(key, body)

    @override_settings(GIT_LENS_ENABLED=True, DEMO_MODE=True, DEMO_RESET_SCHEDULE="0 * * * *")
    def test_site_admin_sees_exactly_what_anonymous_sees(self):
        _set_maintenance(True, "admin-only detail would be a leak")
        anonymous, authenticated = self._bodies()
        self.assertEqual(anonymous.content, authenticated.content)


class SiteConfigQueryCostTests(TestCase):
    """The new flags ride the maintenance cache: no extra SiteSetting read once warm."""

    def setUp(self):
        invalidate_maintenance_mode_cache()
        self.addCleanup(invalidate_maintenance_mode_cache)

    def _site_setting_selects(self) -> int:
        with CaptureQueriesContext(connection) as ctx:
            self.assertEqual(APIClient().get(SITE_CONFIG_URL).status_code, 200)
        return sum(
            1 for q in ctx.captured_queries
            if q["sql"].lstrip().upper().startswith("SELECT") and '"site_settings"' in q["sql"]
        )

    def test_warm_cache_reads_site_setting_once(self):
        self._site_setting_selects()  # cold: populates the maintenance cache
        # Only the view's own SiteSetting.get(); maintenance state comes from cache.
        self.assertEqual(self._site_setting_selects(), 1)


class InstanceFlagSchemaTests(TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.components = SchemaGenerator().get_schema(request=None, public=True)["components"]["schemas"]

    def test_site_config_component_carries_all_five(self):
        props = self.components["SiteConfig"]["properties"]
        required = set(self.components["SiteConfig"]["required"])
        for key in INSTANCE_FLAGS:
            self.assertIn(key, props, key)
        for key in ("git_lens_enabled", "maintenance_mode", "maintenance_message", "demo_mode"):
            self.assertIn(key, required, key)
        self.assertEqual(props["git_lens_enabled"]["type"], "boolean")
        self.assertEqual(props["maintenance_mode"]["type"], "boolean")
        self.assertEqual(props["maintenance_message"]["type"], "string")

    def test_current_user_copies_are_deprecated_except_git_lens(self):
        props = self.components["CurrentUser"]["properties"]
        for key in DEPRECATED_ON_CURRENT_USER:
            self.assertIs(props[key].get("deprecated"), True, key)
            self.assertIn("site-config", props[key].get("description", ""), key)
        # #1666: frozen on CurrentUser as a normal field, not deprecated.
        self.assertNotIn("deprecated", props["git_lens_enabled"])

    def test_deprecated_fields_are_still_in_the_response_schema(self):
        # Deprecated is not removed: all five stay required read-only properties.
        component = self.components["CurrentUser"]
        for key in INSTANCE_FLAGS:
            self.assertIn(key, component["properties"], key)
            self.assertIn(key, component["required"], key)
