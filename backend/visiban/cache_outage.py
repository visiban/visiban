"""Keep ordinary REST traffic up while Valkey/Redis is unreachable (#1465).

Since #1465 the readiness probe stays 200 during a Valkey outage, so the
Service keeps routing traffic to the backend. That is only useful if the
requests it routes succeed, and two cache reads sit on the path of nearly
every REST request:

- the global ``anon``/``user`` DRF throttles, which read and write their
  request history in the cache on every request; and
- the ``SiteSetting`` projections in ``accounts.models`` (maintenance mode is
  consulted by middleware on every request; registration mode and the uploads
  toggle on their own paths).

With a plain ``RedisCache`` both raise ``redis.exceptions.ConnectionError``
and the request becomes a 500. This module makes exactly those two consumers
tolerate an outage, and nothing else.

WHY this is NOT a fail-open cache backend. A ``RedisCache`` subclass that
swallowed errors would be simpler, but it would change the outage behavior of
every cache consumer at once, and several of them are fail-closed on purpose:

- allauth's ``login_failed`` lockout and the named DRF security throttles
  (``login``, ``register``, ``password_reset``, ``user_search``,
  ``join_group``, ``share_link_token``, ...) would treat every read as "no
  history" and silently stop limiting brute force for the whole outage;
- ``mcp_server.throttling`` documents that its limiters deliberately let a
  cache error propagate so the limiter is never silently disabled (#1679);
- ``visiban.sessions`` tells a cache outage apart from a missing session by
  the exception (#2143); a backend that returned ``None`` instead would sign
  users out and overwrite live sessions.

So the decision is per consumer: the two global traffic-shaping throttles fail
OPEN (an outage briefly lifts the generous 300/hour anon and 5000/hour user
ceilings), the ``SiteSetting`` reads fall through to the database (the
correct value, merely uncached), and every named security limiter keeps
failing CLOSED (those endpoints error until the cache returns).
"""

import logging
import time

from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import TimeoutError as RedisTimeoutError
from rest_framework.throttling import AnonRateThrottle, UserRateThrottle

logger = logging.getLogger(__name__)

# Only "the cache cannot be reached" counts as an outage. A ResponseError (a
# wrong-type key, an OOM refusal) is a real fault and still propagates.
# redis-py raises its ConnectionError for refused/reset sockets and DNS
# failures, and its TimeoutError for socket timeouts; BusyLoadingError (a
# replica still loading its dataset) subclasses ConnectionError.
CACHE_OUTAGE_ERRORS = (RedisConnectionError, RedisTimeoutError)

# One warning per consumer per interval per process: an outage would otherwise
# log once per request and bury everything else.
_WARN_INTERVAL_SECONDS = 60.0
_last_warned: dict[str, float] = {}


def log_cache_outage(consumer: str, exc: BaseException) -> None:
    """Log a rate-limited warning that ``consumer`` degraded on a cache outage.

    Only the exception class is logged, never its message: a redis-py error
    message can carry the cache host and port, and nothing request-specific
    (keys, client IPs, user ids) belongs in this line either.
    """
    now = time.monotonic()
    last = _last_warned.get(consumer)
    if last is not None and now - last < _WARN_INTERVAL_SECONDS:
        return
    _last_warned[consumer] = now
    logger.warning(
        "Cache unreachable (%s); %s is degrading instead of failing the request. "
        "Further warnings for it are suppressed for %d seconds.",
        type(exc).__name__,
        consumer,
        int(_WARN_INTERVAL_SECONDS),
    )


class _FailOpenOnCacheOutageMixin:
    """Allow the request when the throttle's cache cannot be reached.

    Applied ONLY to the two global default throttles below. Named-scope
    throttles subclass DRF's ``AnonRateThrottle``/``UserRateThrottle`` (or
    ``SimpleRateThrottle``) directly, not these classes, so they keep failing
    closed during an outage. See the module docstring for why.
    """

    def allow_request(self, request, view):
        try:
            return super().allow_request(request, view)
        except CACHE_OUTAGE_ERRORS as exc:
            log_cache_outage(f"the global {self.scope!r} throttle", exc)
            return True


class FailOpenAnonRateThrottle(_FailOpenOnCacheOutageMixin, AnonRateThrottle):
    """DRF's ``AnonRateThrottle`` (scope ``anon``), open during a cache outage."""


class FailOpenUserRateThrottle(_FailOpenOnCacheOutageMixin, UserRateThrottle):
    """DRF's ``UserRateThrottle`` (scope ``user``), open during a cache outage."""
