"""A cache-only session outage on HTTP is a retryable 503, not a sign-out (#2143).

With ``SESSION_ENGINE=django.contrib.sessions.backends.cache`` the store's
``load()`` swallows a cache outage and returns an empty session, so REST
answered 401 (the web app signs the user out on it) and ``SessionMiddleware``
deleted the session cookie. ``visiban.sessions`` and
``visiban.middleware.SessionOutageMiddleware`` tell an outage from a genuinely
absent session with one direct cache read, as the WebSocket handshake does
(#2014, #2086). These pin:

- an outage answers 503 with ``Retry-After`` and the ``session_unavailable``
  code, and leaves the session cookie alone, on REST and on the HTML views;
- never fail open: an absent session is still a 401 that deletes the cookie,
  and a malformed key (``InvalidCacheKey``) is a miss, not an outage;
- the session is intact once the cache recovers;
- nothing can be written on top of a session the store could not read;
- engines other than cache-only are untouched.
"""

import asyncio
import json
from importlib import import_module
from unittest.mock import patch

from django.conf import settings
from django.contrib.sessions.backends.cache import SessionStore as CacheSessionStore
from django.contrib.sessions.backends.cached_db import SessionStore as CachedDBSessionStore
from django.contrib.sessions.backends.db import SessionStore as DBSessionStore
from django.contrib.sessions.backends.signed_cookies import SessionStore as SignedCookieStore
from django.core.cache import cache
from django.core.cache.backends.base import InvalidCacheKey
from django.core.cache.backends.locmem import LocMemCache
from django.http import HttpResponse
from django.test import RequestFactory, SimpleTestCase, TestCase, override_settings

from accounts.middleware import _STASHABLE_PREFIXES
from accounts.models import (
    PersonalAccessToken,
    SiteSetting,
    User,
    invalidate_maintenance_mode_cache,
)
from django.contrib.sessions.backends.cache import KEY_PREFIX as SESSION_CACHE_KEY_PREFIX
from accounts.tests.ws_cache_engine import OWN_CACHE
from accounts.tests.ws_cache_engine import SessionStore as OwnCacheSessionStore
from accounts.tests.ws_helpers import login_session
from visiban.middleware import SessionOutageMiddleware, session_unavailable_response
from visiban.sessions import (
    SESSION_UNAVAILABLE_CODE,
    SESSION_UNAVAILABLE_RETRY_AFTER_SECONDS,
    SessionUnavailable,
    outage_aware_store_class,
)

CACHE_ENGINE = "django.contrib.sessions.backends.cache"
OWN_CACHE_ENGINE = "accounts.tests.ws_cache_engine"
LOCMEM_GET = "django.core.cache.backends.locmem.LocMemCache.get"
LOCMEM_AGET = "django.core.cache.backends.locmem.LocMemCache.aget"
USER_URL = "/api/v1/auth/user/"
SECRET_HOST = "redis://secret-host:6379"


def _outage(*args, **kwargs):
    raise ConnectionError(f"Error 111 connecting to {SECRET_HOST}")


def _session_only_outage():
    """Fail only the session reads, so other cache users (maintenance state,
    throttles) keep working and the session path is what is under test."""
    real_get = LocMemCache.get

    def get(self_cache, key, *args, **kwargs):
        if str(key).startswith(SESSION_CACHE_KEY_PREFIX):
            _outage()
        return real_get(self_cache, key, *args, **kwargs)

    return patch(LOCMEM_GET, get)


def _deletes_session_cookie(response) -> bool:
    morsel = response.cookies.get(settings.SESSION_COOKIE_NAME)
    return morsel is not None and morsel.value == "" and str(morsel["max-age"]) == "0"


class _CacheSessionBase(TestCase):
    def setUp(self):
        cache.clear()
        OWN_CACHE.clear()
        self.user = User.objects.create_user(username="outage_rest", password="pass")

    def _with_cookie(self):
        key = login_session(self.user)
        self.client.cookies[settings.SESSION_COOKIE_NAME] = key
        return key


@override_settings(SESSION_ENGINE=CACHE_ENGINE)
class RestSessionOutageTests(_CacheSessionBase):
    def test_live_cache_session_authenticates(self):
        self._with_cookie()
        response = self.client.get(USER_URL)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["username"], "outage_rest")

    def test_outage_answers_503_not_401(self):
        key = self._with_cookie()
        with patch(LOCMEM_GET, side_effect=_outage):
            with self.assertLogs("visiban.sessions", level="WARNING") as logs:
                response = self.client.get(USER_URL)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["code"], SESSION_UNAVAILABLE_CODE)
        self.assertTrue(response.json()["detail"])
        self.assertEqual(response["Retry-After"], str(SESSION_UNAVAILABLE_RETRY_AFTER_SECONDS))
        # Class name only: no cache host, no session key.
        joined = "\n".join(logs.output)
        self.assertIn("ConnectionError", joined)
        self.assertNotIn("secret-host", joined)
        self.assertNotIn(key, joined)

    def test_outage_keeps_the_session_cookie(self):
        """The 2026-11-07 probe: the 401 used to carry ``sessionid=""; Max-Age=0``."""
        self._with_cookie()
        with patch(LOCMEM_GET, side_effect=_outage), self.assertLogs("visiban.sessions", "WARNING"):
            response = self.client.get(USER_URL)
        self.assertNotIn(settings.SESSION_COOKIE_NAME, response.cookies)

    def test_session_survives_the_outage(self):
        self._with_cookie()
        with patch(LOCMEM_GET, side_effect=_outage), self.assertLogs("visiban.sessions", "WARNING"):
            self.assertEqual(self.client.get(USER_URL).status_code, 503)
        response = self.client.get(USER_URL)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["username"], "outage_rest")

    def test_outage_on_an_allow_any_view_is_also_503(self):
        """DRF authenticates every request, so an AllowAny view cannot read the
        caller as anonymous either."""
        self._with_cookie()
        with patch(LOCMEM_GET, side_effect=_outage), self.assertLogs("visiban.sessions", "WARNING"):
            response = self.client.get("/api/v1/auth/providers/")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["code"], SESSION_UNAVAILABLE_CODE)

    def test_absent_session_is_still_401_and_deletes_the_cookie(self):
        """Never fail open: a session the healthy cache does not have is a 401."""
        key = self._with_cookie()
        import_module(CACHE_ENGINE).SessionStore(session_key=key).delete()
        response = self.client.get(USER_URL)
        self.assertEqual(response.status_code, 401)
        self.assertTrue(_deletes_session_cookie(response))

    def test_no_cookie_is_401_and_reads_nothing(self):
        with patch(LOCMEM_GET, side_effect=_outage):
            response = self.client.get(USER_URL)
        self.assertEqual(response.status_code, 401)

    def test_invalid_cache_key_is_a_miss_not_an_outage(self):
        """memcached refuses some keys (Django #17810); that must stay a 401,
        or a malformed cookie would answer 503 until it expired."""
        self._with_cookie()
        with patch(LOCMEM_GET, side_effect=InvalidCacheKey("bad key")):
            response = self.client.get(USER_URL)
        self.assertEqual(response.status_code, 401)
        self.assertTrue(_deletes_session_cookie(response))

    def test_cache_recovering_between_the_two_reads_authenticates(self):
        self._with_cookie()
        real_get = LocMemCache.get
        calls = {"n": 0}

        def flaky(self_cache, *args, **kwargs):
            calls["n"] += 1
            if calls["n"] == 1:
                _outage()
            return real_get(self_cache, *args, **kwargs)

        with patch(LOCMEM_GET, flaky):
            response = self.client.get(USER_URL)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(settings.SESSION_COOKIE_NAME, response.cookies)

    def test_outage_on_an_allauth_page_is_503(self):
        """An HTML view: the forced-change gate reads request.user in a
        middleware, so Django makes a 500 of it at that layer, which
        SessionOutageMiddleware replaces. The logged 500 carries no host."""
        self._with_cookie()
        # The test client re-raises any exception Django logged as a 500;
        # a real server returns the response, which is what is under test.
        self.client.raise_request_exception = False
        with patch(LOCMEM_GET, side_effect=_outage):
            with self.assertLogs("visiban.sessions", "WARNING"), self.assertLogs(
                "django.request", "ERROR"
            ) as request_logs:
                response = self.client.get("/accounts/login/")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["code"], SESSION_UNAVAILABLE_CODE)
        self.assertEqual(response["Retry-After"], str(SESSION_UNAVAILABLE_RETRY_AFTER_SECONDS))
        self.assertNotIn(settings.SESSION_COOKIE_NAME, response.cookies)
        self.assertNotIn("secret-host", "\n".join(request_logs.output))


@override_settings(SESSION_ENGINE=CACHE_ENGINE)
class OutageWithOtherGatesTests(_CacheSessionBase):
    """The outage path next to the other credentials and middleware gates."""

    def setUp(self):
        super().setUp()
        invalidate_maintenance_mode_cache()
        self.addCleanup(invalidate_maintenance_mode_cache)

    def _pat_header(self, user):
        _, raw = PersonalAccessToken.generate(user, "outage-test")
        return {"HTTP_AUTHORIZATION": f"Token {raw}"}

    def _maintenance_on(self):
        setting = SiteSetting.get()
        setting.maintenance_mode = True
        setting.save(update_fields=["maintenance_mode"])
        invalidate_maintenance_mode_cache()

    def test_pat_with_a_session_cookie_still_authenticates(self):
        """PATAuthentication runs first, so the session is never read."""
        self._with_cookie()
        with _session_only_outage():
            response = self.client.get(USER_URL, **self._pat_header(self.user))
        self.assertEqual(response.status_code, 200)

    def test_site_admin_pat_write_passes_maintenance_during_an_outage(self):
        """The maintenance exemption falls back to the PAT, as it did when
        the outage read as no session."""
        self.user.is_site_admin = True
        self.user.save(update_fields=["is_site_admin"])
        self._with_cookie()
        self._maintenance_on()
        with _session_only_outage(), self.assertLogs("visiban.sessions", "WARNING"):
            response = self.client.post(
                "/api/v1/boards/",
                {"name": "Outage board"},
                content_type="application/json",
                **self._pat_header(self.user),
            )
        self.assertEqual(response.status_code, 201)

    def test_non_admin_pat_write_is_still_refused_by_maintenance(self):
        self._with_cookie()
        self._maintenance_on()
        with _session_only_outage(), self.assertLogs("visiban.sessions", "WARNING"):
            response = self.client.post(
                "/api/v1/boards/",
                {"name": "Outage board"},
                content_type="application/json",
                **self._pat_header(self.user),
            )
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["code"], "maintenance_mode")

    def test_cookie_write_during_maintenance_is_session_unavailable(self):
        """The session might be an admin's, so the answer is retry, not
        maintenance_mode."""
        self._with_cookie()
        self._maintenance_on()
        self.client.raise_request_exception = False
        with _session_only_outage(), self.assertLogs("visiban.sessions", "WARNING"), self.assertLogs(
            "django.request", "ERROR"
        ):
            response = self.client.post(
                "/api/v1/boards/", {"name": "x"}, content_type="application/json"
            )
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["code"], SESSION_UNAVAILABLE_CODE)
        self.assertNotIn(settings.SESSION_COOKIE_NAME, response.cookies)

    def test_pending_forced_change_on_admin_is_refused_not_passed(self):
        """The forced-change gate cannot read the user, so it refuses (503)
        instead of redirecting or letting the request through."""
        self.user.must_change_password = True
        self.user.save(update_fields=["must_change_password"])
        self._with_cookie()
        self.client.raise_request_exception = False
        with _session_only_outage(), self.assertLogs("visiban.sessions", "WARNING"), self.assertLogs(
            "django.request", "ERROR"
        ):
            response = self.client.get("/admin/")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["code"], SESSION_UNAVAILABLE_CODE)

    def test_oauth_invite_stash_during_an_outage_is_503(self):
        self._with_cookie()
        self.client.raise_request_exception = False
        with _session_only_outage(), self.assertLogs("visiban.sessions", "WARNING"), self.assertLogs(
            "django.request", "ERROR"
        ):
            response = self.client.get(
                f"/accounts/github/login/?invite_token={_STASHABLE_PREFIXES[0]}abc"
            )
        self.assertEqual(response.status_code, 503)
        self.assertNotIn(settings.SESSION_COOKIE_NAME, response.cookies)


@override_settings(SESSION_ENGINE=OWN_CACHE_ENGINE)
class SubclassedCacheEngineTests(_CacheSessionBase):
    """A cache-engine subclass reading its own cache is covered through its own
    ``load()`` and ``_cache``."""

    def test_live_session_authenticates(self):
        self._with_cookie()
        self.assertEqual(self.client.get(USER_URL).status_code, 200)

    def test_outage_answers_503(self):
        self._with_cookie()
        with patch.object(OWN_CACHE, "get", side_effect=_outage), self.assertLogs(
            "visiban.sessions", "WARNING"
        ):
            response = self.client.get(USER_URL)
        self.assertEqual(response.status_code, 503)
        self.assertNotIn(settings.SESSION_COOKIE_NAME, response.cookies)


class OutageAwareStoreTests(SimpleTestCase):
    """The store wrapper itself, without a request."""

    def setUp(self):
        cache.clear()

    def _stored_key(self):
        store = outage_aware_store_class(CacheSessionStore)()
        store["k"] = "v"
        store.create()
        return store.session_key

    def test_only_cache_only_engines_are_wrapped(self):
        for store_class in (DBSessionStore, CachedDBSessionStore, SignedCookieStore):
            with self.subTest(store=store_class):
                self.assertIs(outage_aware_store_class(store_class), store_class)
        wrapped = outage_aware_store_class(CacheSessionStore)
        self.assertTrue(issubclass(wrapped, CacheSessionStore))
        self.assertIs(outage_aware_store_class(CacheSessionStore), wrapped)
        self.assertIs(outage_aware_store_class(wrapped), wrapped)
        self.assertTrue(issubclass(outage_aware_store_class(OwnCacheSessionStore), OwnCacheSessionStore))

    def test_outage_raises_and_keeps_the_key(self):
        key = self._stored_key()
        store = outage_aware_store_class(CacheSessionStore)(key)
        with patch(LOCMEM_GET, side_effect=_outage), self.assertLogs("visiban.sessions", "WARNING"):
            with self.assertRaises(SessionUnavailable):
                store.load()
        self.assertEqual(store.session_key, key)
        self.assertFalse(store.is_empty())
        self.assertTrue(store.session_unavailable)

    def test_nothing_can_be_written_on_an_unread_session(self):
        """A write would be saved over the real session once the cache recovered."""
        key = self._stored_key()
        store = outage_aware_store_class(CacheSessionStore)(key)
        with patch(LOCMEM_GET, side_effect=_outage), self.assertLogs("visiban.sessions", "WARNING"):
            with self.assertRaises(SessionUnavailable):
                store["other"] = "partial"
        self.assertEqual(outage_aware_store_class(CacheSessionStore)(key).load(), {"k": "v"})

    def test_miss_clears_the_key_as_django_does(self):
        store = outage_aware_store_class(CacheSessionStore)("a" * 32)
        self.assertEqual(store.load(), {})
        self.assertIsNone(store.session_key)
        self.assertFalse(store.session_unavailable)

    def test_live_session_loads_without_a_probe(self):
        key = self._stored_key()
        with patch(LOCMEM_GET, wraps=cache.get) as spy:
            data = outage_aware_store_class(CacheSessionStore)(key).load()
        self.assertEqual(data, {"k": "v"})
        self.assertEqual(spy.call_count, 1)

    def test_aload_outage_raises_and_keeps_the_key(self):
        key = self._stored_key()
        store = outage_aware_store_class(CacheSessionStore)(key)

        async def failing_aget(*args, **kwargs):
            _outage()

        with patch(LOCMEM_AGET, side_effect=failing_aget), self.assertLogs(
            "visiban.sessions", "WARNING"
        ):
            with self.assertRaises(SessionUnavailable):
                asyncio.run(store.aload())
        self.assertEqual(store.session_key, key)
        self.assertTrue(store.session_unavailable)

    def test_aload_live_and_miss(self):
        key = self._stored_key()
        self.assertEqual(
            asyncio.run(outage_aware_store_class(CacheSessionStore)(key).aload()), {"k": "v"}
        )
        missing = outage_aware_store_class(CacheSessionStore)("b" * 32)
        self.assertEqual(asyncio.run(missing.aload()), {})
        self.assertIsNone(missing.session_key)

    def test_aload_recovering_between_reads_and_invalid_key(self):
        key = self._stored_key()
        real_aget = LocMemCache.aget
        calls = {"n": 0}

        async def flaky(self_cache, *args, **kwargs):
            calls["n"] += 1
            if calls["n"] == 1:
                _outage()
            return await real_aget(self_cache, *args, **kwargs)

        with patch(LOCMEM_AGET, flaky):
            data = asyncio.run(outage_aware_store_class(CacheSessionStore)(key).aload())
        self.assertEqual(data, {"k": "v"})

        async def invalid(*args, **kwargs):
            raise InvalidCacheKey("bad key")

        store = outage_aware_store_class(CacheSessionStore)(key)
        with patch(LOCMEM_AGET, side_effect=invalid):
            self.assertEqual(asyncio.run(store.aload()), {})
        self.assertIsNone(store.session_key)


class SessionOutageMiddlewareUnitTests(SimpleTestCase):
    def setUp(self):
        self.factory = RequestFactory()

    def test_db_engine_session_is_left_alone(self):
        request = self.factory.get("/")
        original = DBSessionStore("c" * 32)
        request.session = original
        SessionOutageMiddleware(lambda r: HttpResponse())(request)
        self.assertIs(request.session, original)

    def test_cache_engine_session_is_swapped_for_the_same_key(self):
        request = self.factory.get("/")
        request.session = CacheSessionStore("d" * 32)
        SessionOutageMiddleware(lambda r: HttpResponse())(request)
        self.assertIsInstance(request.session, outage_aware_store_class(CacheSessionStore))
        self.assertEqual(request.session.session_key, "d" * 32)

    def test_request_without_a_session_passes(self):
        request = self.factory.get("/")
        response = SessionOutageMiddleware(lambda r: HttpResponse(status=500))(request)
        self.assertEqual(response.status_code, 500)

    def test_a_500_without_an_outage_is_kept(self):
        request = self.factory.get("/")
        request.session = CacheSessionStore("e" * 32)
        response = SessionOutageMiddleware(lambda r: HttpResponse(status=500))(request)
        self.assertEqual(response.status_code, 500)

    def test_process_exception_answers_only_session_unavailable(self):
        middleware = SessionOutageMiddleware(lambda r: HttpResponse())
        request = self.factory.get("/")
        response = middleware.process_exception(request, SessionUnavailable())
        self.assertEqual(response.status_code, 503)
        self.assertIsNone(middleware.process_exception(request, ValueError("other")))

    def test_response_shape(self):
        response = session_unavailable_response()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response["Retry-After"], str(SESSION_UNAVAILABLE_RETRY_AFTER_SECONDS))
        self.assertEqual(json.loads(response.content)["code"], SESSION_UNAVAILABLE_CODE)

    def test_middleware_sits_right_after_session_middleware(self):
        middleware = list(settings.MIDDLEWARE)
        index = middleware.index("django.contrib.sessions.middleware.SessionMiddleware")
        self.assertEqual(middleware[index + 1], "visiban.middleware.SessionOutageMiddleware")
