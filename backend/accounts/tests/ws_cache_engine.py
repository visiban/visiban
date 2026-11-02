"""Session engine whose store reads a cache other than SESSION_CACHE_ALIAS (#2014).

Proves the WebSocket liveness check reads the cache the store itself uses, as
``load()`` did, and not the alias from settings.
"""

from django.contrib.sessions.backends.cache import SessionStore as CacheSessionStore
from django.core.cache.backends.locmem import LocMemCache

OWN_CACHE = LocMemCache("ws-own-session-cache", {})


class SessionStore(CacheSessionStore):
    def __init__(self, session_key=None):
        super().__init__(session_key)
        self._cache = OWN_CACHE
