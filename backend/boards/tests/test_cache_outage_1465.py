"""REST traffic keeps working while Valkey/Redis is unreachable (#1465).

The test suite normally runs on LocMemCache. These tests point the default
cache at a real ``RedisCache`` on a port nothing listens on, so every cache
call raises ``redis.exceptions.ConnectionError`` exactly as it would during a
production outage. See ``visiban/cache_outage.py`` for the per-consumer
fail-open / fail-closed decision these tests pin.
"""

import socket
import time
import unittest
from unittest import mock

import redis
from django.core.exceptions import ImproperlyConfigured
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
from visiban import settings as settings_module
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


class CacheSocketTimeoutOptionsTests(unittest.TestCase):
    """The production cache must carry bounded socket timeouts (#1465).

    Without them redis-py blocks on a black-holed Valkey for as long as the
    kernel allows, so no CACHE_OUTAGE_ERRORS is ever raised and nothing in
    visiban/cache_outage.py gets to degrade.
    """

    def test_defaults_are_bounded_and_under_the_probe_timeout(self):
        options = settings_module._redis_cache_options(
            settings_module.REDIS_CACHE_SOCKET_CONNECT_TIMEOUT_DEFAULT,
            settings_module.REDIS_CACHE_SOCKET_TIMEOUT_DEFAULT,
        )
        self.assertEqual(set(options), {"socket_connect_timeout", "socket_timeout"})
        for value in options.values():
            self.assertIsNotNone(value)
            # Readiness makes one cache call and Kubernetes' default probe
            # timeout is 1 second.
            self.assertGreater(value, 0)
            self.assertLess(value, 1)

    def test_operator_values_pass_through(self):
        self.assertEqual(
            settings_module._redis_cache_options(2.0, 3.5),
            {"socket_connect_timeout": 2.0, "socket_timeout": 3.5},
        )

    def test_non_positive_values_are_refused(self):
        for bad in ((0, 0.5), (0.5, 0), (-1, 0.5)):
            with self.subTest(bad=bad), self.assertRaises(ImproperlyConfigured):
                settings_module._redis_cache_options(*bad)

    def test_production_caches_setting_uses_the_builder(self):
        # The production branch of settings.py is not executed under the test
        # runner (it substitutes LocMemCache), so pin the wiring by source.
        import inspect

        source = inspect.getsource(settings_module)
        self.assertIn('"OPTIONS": _redis_cache_options(', source)
        self.assertIn('env.float("REDIS_CACHE_SOCKET_CONNECT_TIMEOUT"', source)
        self.assertIn('env.float("REDIS_CACHE_SOCKET_TIMEOUT"', source)


# A non-routable address in TEST-NET-1 (RFC 5737): SYNs to it are normally
# dropped, never refused, which is exactly a black-holed Valkey.
_BLACKHOLE_HOST = "192.0.2.1"


def _network_drops_blackhole_traffic() -> bool:
    """True when a connect to _BLACKHOLE_HOST hangs (dropped) rather than fails.

    Some sandboxes and CI networks reject the route at once (ENETUNREACH,
    EHOSTUNREACH) instead of dropping packets. There a fast ConnectionError
    would make the timing test below pass without exercising the socket
    timeout at all, so it skips instead.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(0.2)
    try:
        sock.connect((_BLACKHOLE_HOST, 6379))
    except TimeoutError:
        return True
    except OSError:
        return False
    finally:
        sock.close()
    return False  # something answered: not a black hole


@override_settings(
    CACHES={
        "default": {
            "BACKEND": "django.core.cache.backends.redis.RedisCache",
            "LOCATION": f"redis://{_BLACKHOLE_HOST}:6379/1",
            "OPTIONS": settings_module._redis_cache_options(
                settings_module.REDIS_CACHE_SOCKET_CONNECT_TIMEOUT_DEFAULT,
                settings_module.REDIS_CACHE_SOCKET_TIMEOUT_DEFAULT,
            ),
        }
    }
)
class ReadinessAgainstBlackholedValkeyTests(TestCase):
    def setUp(self):
        if not _network_drops_blackhole_traffic():
            self.skipTest(f"this network does not drop traffic to {_BLACKHOLE_HOST}; nothing to time")
        _reset_outage_log()
        self.addCleanup(_reset_outage_log)

    def test_readiness_answers_degraded_inside_the_probe_timeout(self):
        start = time.monotonic()
        with self.assertLogs("boards.views.health", level="WARNING"):
            response = APIClient().get("/api/health/readiness/")
        elapsed = time.monotonic() - start
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "degraded"})
        # Kubernetes' default readiness timeoutSeconds is 1.
        self.assertLess(elapsed, 0.9)

    def test_a_black_holed_cache_read_raises_a_cache_outage_error(self):
        start = time.monotonic()
        with self.assertRaises(cache_outage.CACHE_OUTAGE_ERRORS):
            cache.get("anything")
        self.assertLess(time.monotonic() - start, 0.9)
