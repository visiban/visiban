"""A cache-only session outage is a retryable 503 on HTTP, not a sign-out (#2143).

With ``SESSION_ENGINE=django.contrib.sessions.backends.cache`` the session
store's ``load()`` swallows every cache exception and returns an empty
session, clearing the key. During a cache outage that does two wrong things on
the HTTP path:

1. the request is anonymous, so DRF answers ``401``/``403``, and the web app
   reads that as an expired session and signs the user out;
2. ``SessionMiddleware.process_response`` sees a cookie whose session is now
   empty and deletes the cookie, so the browser loses a session that is still
   valid on the server, and even a reload after the cache recovers lands on
   the sign-in page.

The WebSocket side already tells the two apart (#2014, #2086): one direct
cache read after an empty ``load()``, because the read raises during an outage
and returns ``None`` for a genuine miss. ``outage_aware_store_class`` applies
the same probe to the HTTP session store. When the probe raises, the store
keeps its key (so ``is_empty()`` is false and the cookie is not deleted) and
``load()`` raises ``SessionUnavailable`` instead of answering "no session".

Why raise rather than flag and return ``{}``: a store that kept its key but
handed out an empty dict could be written to (``request.session[k] = v``) and
saved once the cache recovered, overwriting the real session with partial
data and signing the user out anyway. Raising from ``load()`` means every
access to the session re-raises until the cache answers, so nothing can be
written on top of an unread session.

``SessionUnavailable`` is a DRF ``APIException``, so a REST request that
reaches authentication answers ``503`` with ``Retry-After`` through the normal
exception handler (DRF's ``Request._authenticate`` re-raises an
``APIException`` from an authenticator, and ``SessionAuthentication`` reads the
session through ``request._request.user``). Non-DRF views and the middleware
that read the session are handled by
``visiban.middleware.SessionOutageMiddleware``.

Scope, deliberately narrow:

- only the cache-only engine (or a subclass). ``cached_db`` falls back to the
  database on a cache error and never conflates an outage with an absent
  session; ``db`` and ``signed_cookies`` are unchanged.
- only reads. A write during an outage (sign-in, sign-out) raises from the
  cache backend as it always has.
- ``InvalidCacheKey`` is a miss, not an outage: the memcached backends raise it
  for a key they refuse (Django ticket #17810, the reason ``load()`` swallows
  exceptions at all), and a malformed cookie must stay a plain ``401``.
  Every other exception from the probe is an outage, the same classification
  the WebSocket handshake uses (``accounts.ws_auth._cookie_session_unreadable``).
- the probe runs only when ``load()`` came back empty for a cookie that named
  a key, so a healthy request with a live session pays nothing extra; a stale
  cookie pays one extra read, once (its cookie is then deleted as before).

Logging names only the exception class, never its message (which can include
a cache host) or the session key.
"""

import logging

from django.contrib.sessions.backends.cache import SessionStore as CacheSessionStore
from django.core.cache.backends.base import InvalidCacheKey
from rest_framework import status
from rest_framework.exceptions import APIException

logger = logging.getLogger(__name__)

SESSION_UNAVAILABLE_CODE = "session_unavailable"
SESSION_UNAVAILABLE_DETAIL = (
    "Your session can't be checked right now. Try again in a moment."
)
# Seconds a client should wait before retrying. Short: a cache blip is the
# common case, and the web app retries on its own while it waits.
SESSION_UNAVAILABLE_RETRY_AFTER_SECONDS = 10


class SessionUnavailable(APIException):
    """The session store could not be read; retry, the session may be fine.

    Body ``{"code": "session_unavailable", "detail": "..."}`` (the
    ``maintenance_mode`` 503 shape). ``wait`` makes DRF's exception handler
    emit ``Retry-After``.
    """

    status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    default_detail = SESSION_UNAVAILABLE_DETAIL
    default_code = SESSION_UNAVAILABLE_CODE
    wait = SESSION_UNAVAILABLE_RETRY_AFTER_SECONDS

    def __init__(self):
        super().__init__(
            detail={"code": SESSION_UNAVAILABLE_CODE, "detail": SESSION_UNAVAILABLE_DETAIL},
            code=SESSION_UNAVAILABLE_CODE,
        )


def _log_outage(exc: Exception) -> None:
    # Class name only: the message can carry a cache host, and the session
    # key is a bearer secret.
    logger.warning("session store unavailable: error=%s", type(exc).__name__)


class _OutageAwareCacheStoreMixin:
    """Mixed in ahead of a cache-only ``SessionStore`` by ``outage_aware_store_class``.

    Calls the engine's own ``load()`` first, so a custom subclass that
    overrides it (or points ``_cache`` elsewhere) is still the one that reads
    the session; the probe only decides what an empty result means. Its raw
    value is never handed out.

    The sequence, at most two probes and two engine reads, never a loop:

    1. engine ``load()``. A non-empty result, or no cookie key, is final.
    2. probe. Raises: outage. ``None``: a miss (the key stays cleared, as
       Django leaves it). A value: the cache recovered between the reads, so
       go on.
    3. engine ``load()`` again, so a subclass that decodes or validates the
       stored value still does. A non-empty result is final.
    4. the re-read was empty, which the engine's ``load()`` cannot explain
       (it swallows a cache error too), so probe once more. Raises: the cache
       failed again, an outage. Otherwise (``None``, or a value the engine
       rejected): a miss, with the key as the engine left it. Treating every
       empty re-read as an outage instead would answer 503 for as long as an
       engine rejects a stored value.
    """

    _visiban_outage_aware = True
    # Set when a read hit an outage (see SessionOutageMiddleware).
    session_unavailable = False

    def _outage(self, exc):
        _log_outage(exc)
        # The caller restored the key before probing, so it is kept:
        # is_empty() is false and the cookie is not deleted. The flag lets
        # SessionOutageMiddleware recognize a 500 that a middleware layer made
        # of this exception.
        self.session_unavailable = True
        return SessionUnavailable()

    def _probe(self, key):
        """One direct read of *key*'s entry: its value, or ``None`` on a miss.

        Restores *key* first (``cache_key`` would mint a new key without one)
        and leaves it set. Raises ``SessionUnavailable`` on an outage.
        """
        self._session_key = key
        try:
            return self._cache.get(self.cache_key)
        except InvalidCacheKey:
            return None
        except Exception as exc:  # noqa: BLE001 — any backend error is an outage, see module docstring
            raise self._outage(exc) from None

    async def _aprobe(self, key):
        self._session_key = key
        try:
            return await self._cache.aget(await self.acache_key())
        except InvalidCacheKey:
            return None
        except Exception as exc:  # noqa: BLE001 — see _probe()
            raise self._outage(exc) from None

    def load(self):
        key = self._session_key
        data = super().load()
        if data or key is None:
            return data
        cleared = self._session_key
        if self._probe(key) is None:
            self._session_key = cleared
            return data
        data = super().load()
        if data:
            return data
        cleared = self._session_key
        self._probe(key)
        self._session_key = cleared
        return data

    async def aload(self):
        key = self._session_key
        data = await super().aload()
        if data or key is None:
            return data
        cleared = self._session_key
        if await self._aprobe(key) is None:
            self._session_key = cleared
            return data
        data = await super().aload()
        if data:
            return data
        cleared = self._session_key
        await self._aprobe(key)
        self._session_key = cleared
        return data


_OUTAGE_AWARE_CLASSES: dict[type, type] = {}


def outage_aware_store_class(store_class: type) -> type:
    """*store_class* with the outage probe, or *store_class* itself.

    Only a cache-only store (``django.contrib.sessions.backends.cache`` or a
    subclass) is wrapped; every other engine is returned unchanged. The
    wrapped class is built once per engine class and reused.
    """
    if not issubclass(store_class, CacheSessionStore):
        return store_class
    if getattr(store_class, "_visiban_outage_aware", False):
        return store_class
    wrapped = _OUTAGE_AWARE_CLASSES.get(store_class)
    if wrapped is None:
        wrapped = type(
            f"OutageAware{store_class.__name__}",
            (_OutageAwareCacheStoreMixin, store_class),
            {"__module__": store_class.__module__},
        )
        _OUTAGE_AWARE_CLASSES[store_class] = wrapped
    return wrapped
