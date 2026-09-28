"""Client-IP resolution behind N proxies, and the demo deploy settings (#1180).

The hosted demo sits behind Cloudflare -> cloudflared -> the frontend nginx ->
the backend. With the old hardcoded ``NUM_PROXIES = 1`` DRF took the tunnel
pod's address for every visitor, so the per-IP login throttle (#924) and the
``anon`` scope were one global bucket and a single client could lock everyone
out. These tests pin the fix from both sides: the setting parses strictly, and
two visitors behind the same proxy chain land in separate buckets for DRF AND
for allauth, which resolves the client IP on its own unless told otherwise.
"""

import json
import os
import subprocess
import sys
from unittest import mock

from allauth.core import ratelimit as allauth_ratelimit
from django.conf import settings
from django.contrib.auth.models import AnonymousUser
from django.core.cache import cache
from django.core.exceptions import ImproperlyConfigured
from django.test import RequestFactory, SimpleTestCase, TestCase, override_settings
from rest_framework.test import APIClient
from rest_framework.throttling import AnonRateThrottle

from accounts.adapter import RegistrationAdapter
from accounts.views import LoginRateThrottle
from visiban.demo import parse_demo_user_throttle_rate
from visiban.utils import get_client_ip, parse_num_proxies

TUNNEL_POD = "10.42.0.17"  # cloudflared, as nginx sees it
VISITOR_A = "203.0.113.10"
VISITOR_B = "198.51.100.20"


def _rf(num_proxies):
    """REST_FRAMEWORK with a different NUM_PROXIES (DRF reloads api_settings on change)."""
    return {**settings.REST_FRAMEWORK, "NUM_PROXIES": num_proxies}


def _behind_tunnel(client_ip):
    """X-Forwarded-For as the backend sees it behind Cloudflare -> cloudflared -> nginx.

    Cloudflare appends the visitor; nginx ($proxy_add_x_forwarded_for) then
    appends its peer, the cloudflared pod.
    """
    return f"{client_ip}, {TUNNEL_POD}"


class ParseNumProxiesTests(SimpleTestCase):
    def test_unset_and_blank_keep_the_pre_1180_default(self):
        self.assertEqual(parse_num_proxies(None), 1)
        self.assertEqual(parse_num_proxies(""), 1)
        self.assertEqual(parse_num_proxies("  "), 1)

    def test_non_negative_integers(self):
        self.assertEqual(parse_num_proxies("0"), 0)
        self.assertEqual(parse_num_proxies("2"), 2)
        self.assertEqual(parse_num_proxies(" 3 "), 3)

    def test_anything_else_refuses_to_boot(self):
        for raw in ["-1", "two", "1.5", "2x", "0x2"]:
            with self.subTest(raw=raw), self.assertRaises(ImproperlyConfigured):
                parse_num_proxies(raw)


class GetClientIpTests(SimpleTestCase):
    """visiban.utils.get_client_ip mirrors DRF's get_ident for every NUM_PROXIES."""

    def setUp(self):
        self.factory = RequestFactory()

    def _req(self, xff=None, remote="10.42.0.99"):
        extra = {"REMOTE_ADDR": remote}
        if xff is not None:
            extra["HTTP_X_FORWARDED_FOR"] = xff
        return self.factory.get("/", **extra)

    def test_matches_drf_get_ident(self):
        cases = [
            (1, "1.2.3.4, 10.0.0.1, 192.168.1.1"),
            (2, "1.2.3.4, 10.0.0.1, 192.168.1.1"),
            (3, "1.2.3.4, 10.0.0.1, 192.168.1.1"),
            (5, "1.2.3.4, 10.0.0.1"),  # fewer entries than proxies: leftmost, like DRF
            (0, "1.2.3.4, 10.0.0.1"),
            (2, None),
        ]
        for n, xff in cases:
            with self.subTest(n=n, xff=xff), override_settings(REST_FRAMEWORK=_rf(n)):
                req = self._req(xff)
                self.assertEqual(get_client_ip(req), AnonRateThrottle().get_ident(req))

    @override_settings(REST_FRAMEWORK=_rf(2))
    def test_two_proxies_picks_the_visitor_not_the_tunnel(self):
        self.assertEqual(get_client_ip(self._req(_behind_tunnel(VISITOR_A))), VISITOR_A)

    @override_settings(REST_FRAMEWORK=_rf(2))
    def test_two_proxies_ignores_a_spoofed_leftmost_entry(self):
        # The visitor sends its own X-Forwarded-For; Cloudflare appends the real address.
        xff = f"127.0.0.1, {VISITOR_A}, {TUNNEL_POD}"
        self.assertEqual(get_client_ip(self._req(xff)), VISITOR_A)

    @override_settings(REST_FRAMEWORK=_rf(0))
    def test_zero_proxies_uses_remote_addr(self):
        self.assertEqual(get_client_ip(self._req("1.2.3.4", remote="10.9.9.9")), "10.9.9.9")


class SeparateThrottleBucketsTests(TestCase):
    """Two visitors behind the same proxy chain get independent throttle buckets."""

    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)
        self.factory = RequestFactory()

    def _login(self, client_ip):
        return APIClient().post(
            "/api/v1/auth/login/",
            {"username": "nobody", "password": "wrong-password"},
            format="json",
            HTTP_X_FORWARDED_FOR=_behind_tunnel(client_ip),
            REMOTE_ADDR="10.42.0.5",  # the frontend nginx pod
        )

    @override_settings(REST_FRAMEWORK=_rf(2))
    def test_login_throttle_is_per_visitor_behind_the_tunnel(self):
        with mock.patch.object(LoginRateThrottle, "rate", "2/hour", create=True):
            self.assertNotEqual(self._login(VISITOR_A).status_code, 429)
            self.assertNotEqual(self._login(VISITOR_A).status_code, 429)
            self.assertEqual(self._login(VISITOR_A).status_code, 429)
            # Visitor A exhausting its bucket must not lock visitor B out.
            self.assertNotEqual(self._login(VISITOR_B).status_code, 429)

    @override_settings(REST_FRAMEWORK=_rf(1))
    def test_one_proxy_behind_the_tunnel_is_one_shared_bucket(self):
        """The #1180 defect, pinned: at 1 every visitor is the tunnel pod."""
        with mock.patch.object(LoginRateThrottle, "rate", "2/hour", create=True):
            self._login(VISITOR_A)
            self._login(VISITOR_A)
            self.assertEqual(self._login(VISITOR_B).status_code, 429)

    @override_settings(REST_FRAMEWORK=_rf(2))
    def test_anon_scope_keys_differ_per_visitor(self):
        def anon(client_ip):
            req = self.factory.get("/", HTTP_X_FORWARDED_FOR=_behind_tunnel(client_ip))
            req.user = AnonymousUser()
            return req

        throttle = AnonRateThrottle()
        key_a = throttle.get_cache_key(anon(VISITOR_A), None)
        key_b = throttle.get_cache_key(anon(VISITOR_B), None)
        self.assertNotEqual(key_a, key_b)
        self.assertIn(VISITOR_A, key_a)


class AllauthKeysOnTheSameAddressTests(TestCase):
    """allauth's per-IP rate limits agree with DRF about who the client is.

    Left to itself allauth trusts no proxy (ALLAUTH_TRUSTED_PROXY_COUNT=0) and
    keys on REMOTE_ADDR — the nginx pod — so every allauth ``ip`` bucket was
    shared by all clients on any nginx-fronted install.
    """

    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)
        self.factory = RequestFactory()

    def _req(self, client_ip):
        return self.factory.post(
            "/accounts/login/",
            HTTP_X_FORWARDED_FOR=_behind_tunnel(client_ip),
            REMOTE_ADDR="10.42.0.5",
        )

    @override_settings(REST_FRAMEWORK=_rf(2))
    def test_adapter_resolves_like_drf(self):
        req = self._req(VISITOR_A)
        self.assertEqual(RegistrationAdapter().get_client_ip(req), VISITOR_A)
        self.assertEqual(RegistrationAdapter().get_client_ip(req), AnonRateThrottle().get_ident(req))

    @override_settings(REST_FRAMEWORK=_rf(2), ACCOUNT_RATE_LIMITS={"login_failed": "2/300s"})
    def test_login_failed_buckets_are_per_visitor(self):
        for _ in range(2):
            self.assertTrue(allauth_ratelimit.consume(self._req(VISITOR_A), action="login_failed"))
        self.assertFalse(allauth_ratelimit.consume(self._req(VISITOR_A), action="login_failed"))
        self.assertTrue(allauth_ratelimit.consume(self._req(VISITOR_B), action="login_failed"))


# ── Settings evaluated in a subprocess ──────────────────────────────────────
# Same pattern as boards/tests/test_force_insecure_cookies.py: reloading
# settings in-process would re-evaluate DATABASES and break later tests.

_BASE_ENV = {
    "DEBUG": "true",
    "DJANGO_SECRET_KEY": "test-secret-key-not-change-me-in-production",
    "DATABASE_URL": "sqlite:///dev.db",
}

_SCRIPT = """\
import json, os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "visiban.settings")
import django
django.setup()
from django.conf import settings
print(json.dumps({
    "NUM_PROXIES": settings.REST_FRAMEWORK["NUM_PROXIES"],
    "DEMO_RESET_SCHEDULE": settings.DEMO_RESET_SCHEDULE,
    "USER_RATE": settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]["user"],
}))
"""


class DeploySettingsTests(SimpleTestCase):
    databases = []

    def _eval(self, overrides):
        env = {
            **_BASE_ENV,
            **overrides,
            "PATH": os.environ.get("PATH", ""),
            "PYTHONPATH": os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
        }
        result = subprocess.run(
            [sys.executable, "-c", _SCRIPT], env=env, capture_output=True, text=True, timeout=60
        )
        if result.returncode != 0:
            return None, result.stderr
        return json.loads(result.stdout.strip().splitlines()[-1]), None

    def test_num_proxies_default_is_unchanged(self):
        values, err = self._eval({})
        self.assertIsNone(err, err)
        self.assertEqual(values["NUM_PROXIES"], 1)

    def test_num_proxies_from_env(self):
        values, err = self._eval({"NUM_PROXIES": "2"})
        self.assertIsNone(err, err)
        self.assertEqual(values["NUM_PROXIES"], 2)

    def test_num_proxies_typo_refuses_to_boot(self):
        values, err = self._eval({"NUM_PROXIES": "two"})
        self.assertIsNone(values)
        self.assertIn("NUM_PROXIES", err)

    def test_demo_reset_schedule_unset_is_hourly(self):
        values, err = self._eval({"DEMO_MODE": "true"})
        self.assertIsNone(err, err)
        self.assertEqual(values["DEMO_RESET_SCHEDULE"], "0 * * * *")

    def test_demo_reset_schedule_empty_boots_with_no_reset(self):
        """The chart's reset-disabled render must boot, not crash on an empty cron."""
        values, err = self._eval({"DEMO_MODE": "true", "DEMO_RESET_SCHEDULE": ""})
        self.assertIsNone(err, err)
        self.assertEqual(values["DEMO_RESET_SCHEDULE"], "")

    def test_demo_reset_schedule_invalid_still_refuses_to_boot(self):
        values, err = self._eval({"DEMO_MODE": "true", "DEMO_RESET_SCHEDULE": "0 0 1 * *"})
        self.assertIsNone(values)
        self.assertIn("DEMO_RESET_SCHEDULE", err)

    def test_demo_user_throttle_rate_applies_only_in_demo_mode(self):
        values, err = self._eval({"DEMO_MODE": "true", "DEMO_USER_THROTTLE_RATE": "60000/hour"})
        self.assertIsNone(err, err)
        self.assertEqual(values["USER_RATE"], "60000/hour")
        values, err = self._eval({"DEMO_USER_THROTTLE_RATE": "60000/hour"})
        self.assertIsNone(err, err)
        self.assertNotEqual(values["USER_RATE"], "60000/hour")

    def test_demo_user_throttle_rate_typo_refuses_to_boot(self):
        values, err = self._eval({"DEMO_MODE": "true", "DEMO_USER_THROTTLE_RATE": "lots"})
        self.assertIsNone(values)
        self.assertIn("DEMO_USER_THROTTLE_RATE", err)


class ParseDemoUserThrottleRateTests(SimpleTestCase):
    def test_accepts_drf_rates(self):
        for raw in ["60000/hour", "100/min", "5/s", " 10/day "]:
            with self.subTest(raw=raw):
                self.assertEqual(parse_demo_user_throttle_rate(raw), raw.strip())

    def test_unset_is_none(self):
        self.assertIsNone(parse_demo_user_throttle_rate(None))
        self.assertIsNone(parse_demo_user_throttle_rate(""))

    def test_rejects_malformed(self):
        for raw in ["lots", "0/hour", "10/fortnight", "10 / hour", "-5/min"]:
            with self.subTest(raw=raw), self.assertRaises(ImproperlyConfigured):
                parse_demo_user_throttle_rate(raw)
