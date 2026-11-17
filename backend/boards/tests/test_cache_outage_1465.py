"""REST traffic keeps working while Valkey/Redis is unreachable (#1465).

The test suite normally runs on LocMemCache. These tests point the default
cache at a real ``RedisCache`` on a port nothing listens on, so every cache
call raises ``redis.exceptions.ConnectionError`` exactly as it would during a
production outage. See ``visiban/cache_outage.py`` for the per-consumer
fail-open / fail-closed decision these tests pin.
"""

from unittest import mock

import redis
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import RequestFactory, TestCase, override_settings
from rest_framework.request import Request
from rest_framework.test import APIClient

from accounts.models import (
    SiteSetting,
    get_maintenance_state,
    get_registration_mode,
    get_uploads_enabled,
)
from visiban import cache_outage
from visiban.cache_outage import FailOpenAnonRateThrottle, FailOpenUserRateThrottle

User = get_user_model()

# Port 1 (tcpmux) is closed on any sane host, so the connect is refused at
# once; the short timeouts only bound the test if something does answer.
UNREACHABLE_REDIS_CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.redis.RedisCache",
        "LOCATION": "redis://127.0.0.1:1/1",
        "OPTIONS": {"socket_connect_timeout": 0.5, "socket_timeout": 0.5},
    }
}


def _reset_outage_log():
    cache_outage._last_warned.clear()


@override_settings(CACHES=UNREACHABLE_REDIS_CACHES)
class RestTrafficDuringCacheOutageTests(TestCase):
    def setUp(self):
        _reset_outage_log()
        self.addCleanup(_reset_outage_log)

    def test_fixture_really_is_an_outage(self):
        # Guard: if this ever stops raising, every test below proves nothing.
        with self.assertRaises(redis.exceptions.ConnectionError):
            cache.get("anything")

    def test_authenticated_get_of_a_throttled_endpoint_is_served(self):
        # UserRateThrottle (history read + write) and MaintenanceModeMiddleware
        # (maintenance state read) both touch the cache on this request.
        user = User.objects.create_user(username="outage-user", password="x" * 20)
        client = APIClient()
        client.force_authenticate(user=user)
        with self.assertLogs("visiban.cache_outage", level="WARNING"):
            response = client.get("/api/v1/auth/me/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["username"], "outage-user")

    def test_anonymous_get_of_a_throttled_endpoint_is_served(self):
        response = APIClient().get("/api/v1/auth/site-config/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("registration_mode", response.data)

    def test_site_setting_reads_fall_through_to_the_database(self):
        setting = SiteSetting.get()
        setting.registration_mode = SiteSetting.RegistrationMode.INVITE_ONLY
        setting.maintenance_mode = True
        setting.maintenance_message = "Back soon"
        setting.uploads_enabled = False
        setting.save()  # its cache eviction already tolerates the outage (#1126)

        self.assertEqual(get_registration_mode(), SiteSetting.RegistrationMode.INVITE_ONLY)
        self.assertEqual(get_maintenance_state(), (True, "Back soon"))
        self.assertIs(get_uploads_enabled(), False)

    def test_maintenance_mode_still_blocks_writes_during_the_outage(self):
        # Falling through to the database must not weaken maintenance mode.
        setting = SiteSetting.get()
        setting.maintenance_mode = True
        setting.save()
        user = User.objects.create_user(username="outage-writer", password="x" * 20)
        client = APIClient()
        client.force_authenticate(user=user)
        response = client.post("/api/v1/boards/", {"name": "x"}, format="json")
        self.assertEqual(response.status_code, 503)

    def test_named_security_throttles_still_fail_closed(self):
        # The login/user-search/... throttles subclass DRF's classes directly,
        # not the fail-open ones, so an outage must still raise rather than
        # silently lift a brute-force or enumeration limit.
        from accounts.views import PasswordChangeThrottle, UserSearchRateThrottle

        user = User.objects.create_user(username="outage-search", password="x" * 20)
        django_request = RequestFactory().get("/api/v1/users/search/")
        django_request.user = user
        request = Request(django_request)
        request.user = user
        for throttle_cls in (UserSearchRateThrottle, PasswordChangeThrottle):
            with self.subTest(throttle=throttle_cls.__name__):
                self.assertFalse(issubclass(throttle_cls, FailOpenUserRateThrottle))
                with self.assertRaises(redis.exceptions.ConnectionError):
                    throttle_cls().allow_request(request, view=None)


class FailOpenThrottleUnitTests(TestCase):
    def setUp(self):
        _reset_outage_log()
        self.addCleanup(_reset_outage_log)

    def _request(self):
        django_request = RequestFactory().get("/", REMOTE_ADDR="203.0.113.9")
        return Request(django_request)

    def test_connection_and_timeout_errors_allow_the_request(self):
        for exc in (redis.exceptions.ConnectionError("down"), redis.exceptions.TimeoutError("slow")):
            with self.subTest(exc=type(exc).__name__):
                _reset_outage_log()
                with mock.patch.object(cache_outage.AnonRateThrottle, "allow_request", side_effect=exc):
                    with self.assertLogs("visiban.cache_outage", level="WARNING"):
                        self.assertTrue(FailOpenAnonRateThrottle().allow_request(self._request(), None))

    def test_other_redis_errors_still_propagate(self):
        # A ResponseError is a real fault, not an unreachable cache.
        with mock.patch.object(
            cache_outage.UserRateThrottle,
            "allow_request",
            side_effect=redis.exceptions.ResponseError("WRONGTYPE"),
        ):
            with self.assertRaises(redis.exceptions.ResponseError):
                FailOpenUserRateThrottle().allow_request(self._request(), None)

    def test_warning_is_rate_limited_and_omits_the_error_message(self):
        exc = redis.exceptions.ConnectionError("Error 111 connecting to valkey.internal:6379")
        with self.assertLogs("visiban.cache_outage", level="WARNING") as logs:
            cache_outage.log_cache_outage("the global 'anon' throttle", exc)
            cache_outage.log_cache_outage("the global 'anon' throttle", exc)
            cache_outage.log_cache_outage("the SiteSetting cache", exc)
        self.assertEqual(len(logs.records), 2)
        joined = "\n".join(logs.output)
        self.assertIn("ConnectionError", joined)
        self.assertNotIn("valkey.internal", joined)
        self.assertNotIn("6379", joined)

    def test_throttling_still_applies_when_the_cache_is_healthy(self):
        # The wrapper must not change the normal path.
        throttle = FailOpenAnonRateThrottle()
        throttle.rate = "1/hour"
        throttle.num_requests, throttle.duration = throttle.parse_rate("1/hour")
        cache.clear()
        self.assertTrue(throttle.allow_request(self._request(), None))
        self.assertFalse(throttle.allow_request(self._request(), None))
