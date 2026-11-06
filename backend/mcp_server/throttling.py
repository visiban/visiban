"""Per-token rate limiting for the MCP tool/resource surface (#1177).

DRF's ``DEFAULT_THROTTLE_CLASSES`` never run for ``/mcp``: the MCP server is
mounted in-process at the ASGI ``ProtocolTypeRouter`` level and calls tool
functions directly, never through a DRF view (see ``mcp_server.asgi_mount``'s
module docstring). This module is the throttle's own home. It reuses the same
cache backend and fixed-window algorithm as
``rest_framework.throttling.SimpleRateThrottle`` (a per-key list of call
timestamps, trimmed to the window on each check — see
:meth:`McpTokenBucket.check`) so an operator reasons about one rate-limiting
model for the whole product, without depending on DRF's ``(request, view)``
shaped API, which MCP tools do not have.

Two stacked buckets (the #511 design comment, carried over from a TruePPM
precedent — ``McpTokenReadThrottle`` + ``McpTokenComputeThrottle``):

- ``read_bucket`` — a generous per-token cap applied to EVERY tool and
  resource call. ``server.py``'s ``_throttled()`` wraps every registration
  with it.
- ``compute_bucket`` — an ADDITIONAL, tighter cap opted into per-tool via
  ``_throttled(compute=True)``, for the calls #1177 names as expensive
  (``list_cards``, ``board_snapshot``, and the flow-metrics tools
  ``board_flow_metrics`` and ``aging_cards`` from #1151). A compute-bucket call spends a unit from BOTH buckets —
  they stack, they are not alternatives.

Both are keyed on the presented PAT's primary key
(:func:`mcp_server.context.get_current_token_id`), never on IP and never on
the raw token value, so a fleet of agents sharing one egress IP are limited
per credential rather than collectively, and so the limit survives a token
being used from a different network.

Fail-closed posture (#1075 — a guard must never silently degrade to "no
check" when its input is absent or malformed):

- **Missing rate setting** (attribute absent or explicitly ``None``) falls
  back to the built-in default rate below. A fresh install that never touches
  ``MCP_THROTTLE_READ_RATE``/``MCP_THROTTLE_COMPUTE_RATE`` still gets a real,
  finite limit — never an unlimited one.
- **Unparseable rate setting** raises :class:`~django.core.exceptions.
  ImproperlyConfigured` rather than falling back or silently allowing
  everything through. The buckets below are constructed as module-level
  singletons, and this module is imported by ``mcp_server.server`` at its own
  top level — which, for every real deployment, is imported once at ASGI
  application construction in ``visiban/asgi.py`` (process startup), not on
  the first request. A typo in the rate string is caught before the process
  ever accepts traffic. (The rate is re-parsed on every :meth:`McpTokenBucket.
  check` call rather than cached at construction time, purely so
  ``override_settings`` in tests can change it mid-process — see
  ``test_mcp_throttle.py``; this has no cost in production, where the setting
  never changes after startup, and it means a bad value introduced later by a
  settings reload would still fail loud on the very next call rather than
  being silently adopted.)
- **No token identity bound in the calling context** (:func:`mcp_server.
  context.get_current_token_id` returns ``None``) makes :meth:`McpTokenBucket.
  check` deny. This is reachable only if some future call path invokes a tool
  function without going through :class:`mcp_server.auth.BearerAuthMiddleware`
  (which is what binds the identity) — treating "I don't know who this is" as
  "unlimited" is exactly the silent degradation #1075 was about.
"""
import logging
import time

from asgiref.sync import sync_to_async
from django.conf import settings
from django.core.cache import cache
from django.core.exceptions import ImproperlyConfigured

from .context import get_current_token_id

logger = logging.getLogger(__name__)

_PERIODS = {"s": 1, "m": 60, "h": 3600, "d": 86400}

# Used only when the corresponding setting is absent/None (see module
# docstring) — kept in sync by convention with the ``env()`` defaults in
# ``visiban/settings.py``, which is where an operator actually sees and
# overrides these. Duplicated rather than imported from settings on purpose:
# this module must not depend on ``visiban.settings`` defining these names at
# all, since the whole point of the fallback is to survive their absence.
DEFAULT_MCP_THROTTLE_READ_RATE = "300/min"
DEFAULT_MCP_THROTTLE_COMPUTE_RATE = "30/min"
# Failed credential lookups per client IP (#1679); see PreAuthFailureLimiter.
DEFAULT_MCP_THROTTLE_PREAUTH_RATE = "30/min"

ERROR_CODE_THROTTLED = "throttled"


def _parse_rate(rate, setting_name):
    """Parse a DRF-style ``'<count>/<period>'`` rate string.

    Mirrors ``rest_framework.throttling.SimpleRateThrottle.parse_rate``'s
    syntax exactly (period is keyed off its first letter: s/m/h/d) so the two
    rate-limiting surfaces in this product read the same way.

    Raises :class:`ImproperlyConfigured` — never returns a "no limit" sentinel
    — on anything unparseable or non-positive. A typo must fail loudly, once,
    rather than be silently treated as "unlimited" for the life of the process
    (#1075's fail-closed-on-bad-input rule applies to malformed config, not
    only absent config).
    """
    try:
        num, period = rate.split("/")
        num_requests = int(num)
        duration = _PERIODS[period[0]]
    except (AttributeError, ValueError, KeyError, IndexError) as exc:
        raise ImproperlyConfigured(
            f"{setting_name}={rate!r} is not a valid throttle rate string "
            "(expected '<positive int>/<s|m|h|d...>', e.g. '300/min')."
        ) from exc
    if num_requests <= 0:
        raise ImproperlyConfigured(
            f"{setting_name}={rate!r} must allow at least one request per window."
        )
    return num_requests, duration


class McpTokenBucket:
    """Fixed-window, cache-backed rate limiter keyed on MCP token identity.

    Same window algorithm as ``rest_framework.throttling.SimpleRateThrottle``
    but deliberately NOT a subclass of it: that class's public API takes a DRF
    ``(request, view)`` pair to build its cache key, and MCP tools have
    neither — they run as plain functions with the caller's identity carried
    by :mod:`mcp_server.context` instead. Re-implementing the small amount of
    window logic here is simpler than adapting a base class built around an
    API shape this surface doesn't have.
    """

    def __init__(self, *, bucket_name, setting_name, default_rate):
        self.bucket_name = bucket_name
        self.setting_name = setting_name
        self.default_rate = default_rate
        # Validate once at construction too — for every real deployment this
        # IS the startup check described in the module docstring, since these
        # are built as module-level singletons below. Not cached onto self:
        # `_current_rate()` re-validates on every `check()` call regardless
        # (see module docstring for why).
        self._current_rate()

    def _current_rate(self):
        rate = getattr(settings, self.setting_name, None)
        if rate is None:
            rate = self.default_rate
        return _parse_rate(rate, self.setting_name)

    def _cache_key(self, token_id):
        return f"mcp_throttle:{self.bucket_name}:{token_id}"

    def check(self):
        """Return a structured ``{"error": {...}}`` denial, or ``None`` to allow.

        Synchronous and cache-only — callers on the event loop must run this
        via ``sync_to_async(..., thread_sensitive=True)`` (see
        :func:`check_read`/:func:`check_compute` below), matching
        ``server._require_maintenance_off``'s existing pattern for blocking
        cache access from an async tool.

        Not atomic across concurrent daphne workers hitting the same key in
        the same instant — read-modify-write against the cache has the same
        narrow race DRF's own ``SimpleRateThrottle`` accepts. Acceptable here
        for the same reason: the bound this exists to enforce is "roughly
        this many calls per window," not an exact ceiling, and the alternative
        (a cache backend transaction) is not something ``django.core.cache``
        exposes portably across the locmem/Redis backends this project runs.
        """
        token_id = get_current_token_id()
        if token_id is None:
            # Fail closed (#1075): every real call path binds an identity in
            # BearerAuthMiddleware before a tool can run at all, so reaching
            # here with none means some other call path invoked a tool
            # function directly — "no limit" is the one answer that must
            # never be given to "I don't know who this is."
            logger.warning(
                "MCP throttle bucket=%s denied a call with no bound token "
                "identity in context.",
                self.bucket_name,
            )
            _, duration = self._current_rate()
            return self._denial(duration)

        num_requests, duration = self._current_rate()
        key = self._cache_key(token_id)
        now = time.time()
        # Oldest-first: entries are appended in call order below, so a simple
        # age filter keeps the list sorted without needing to re-sort it.
        history = [ts for ts in cache.get(key, []) if ts > now - duration]

        if len(history) >= num_requests:
            oldest = history[0]
            retry_after = max(1, round(duration - (now - oldest)))
            return self._denial(retry_after)

        history.append(now)
        cache.set(key, history, duration)
        return None

    def _denial(self, retry_after):
        return {"error": {
            "code": ERROR_CODE_THROTTLED,
            "detail": (
                f"Rate limit exceeded for this token ({self.bucket_name}). "
                f"Retry after {retry_after} second(s)."
            ),
            "retry_after": retry_after,
        }}


# Module-level singletons. Built when this module is first imported, which
# `mcp_server.server` (imported by `mcp_server.asgi_mount.build_mcp_asgi_app`,
# in turn called from `visiban/asgi.py` at process startup) does at its own
# top level — see the module docstring's "unparseable rate setting" bullet.
read_bucket = McpTokenBucket(
    bucket_name="mcp_read",
    setting_name="MCP_THROTTLE_READ_RATE",
    default_rate=DEFAULT_MCP_THROTTLE_READ_RATE,
)
compute_bucket = McpTokenBucket(
    bucket_name="mcp_compute",
    setting_name="MCP_THROTTLE_COMPUTE_RATE",
    default_rate=DEFAULT_MCP_THROTTLE_COMPUTE_RATE,
)


async def check_read():
    """Run the baseline bucket's check off the event loop.

    See :meth:`McpTokenBucket.check` for the algorithm and fail-closed rules.
    """
    return await sync_to_async(read_bucket.check, thread_sensitive=True)()


async def check_compute():
    """Run the compute bucket's check off the event loop.

    See :meth:`McpTokenBucket.check` for the algorithm and fail-closed rules.
    """
    return await sync_to_async(compute_bucket.check, thread_sensitive=True)()


class PreAuthFailureLimiter:
    """Per-client-IP cap on FAILED token lookups, checked before the lookup (#1679).

    The buckets above key on a resolved PAT id, so they cannot see a caller who
    never presents a valid token: every guess costs a database lookup and no
    bucket ever fills. Only FAILED lookups spend budget (``record_failure``),
    but the check itself (``blocked``) runs before the lookup for EVERY request,
    so once an IP has burned its budget, valid requests from that IP are also
    refused until the window slides. Agents sharing an egress IP with a client
    that keeps failing (a looping agent on a revoked token, a hostile host
    behind the same NAT) are therefore affected too; that is the accepted cost
    of rejecting before the lookup.

    The IP is resolved with ``visiban.utils.get_client_ip`` so it honors the
    same ``NUM_PROXIES`` as the DRF throttles and never trusts raw
    client-supplied ``X-Forwarded-For`` entries. Same sliding-window cache
    algorithm and fail-loud rate parsing as :class:`McpTokenBucket`; unlike the
    token buckets there is no "unknown identity" case, because the IP resolver
    always returns a non-empty fallback.

    Cache outage: ``cache.get``/``cache.set`` are deliberately NOT guarded,
    exactly like :class:`McpTokenBucket`. A backend error propagates and the
    request fails (fail closed) rather than silently disabling the limiter.
    The budget is approximate: the read-modify-write is not atomic, so
    concurrent failures (or failures spread across replicas) can exceed it or
    lose counts.
    """

    def __init__(self, setting_name, default_rate):
        self.setting_name = setting_name
        self.default_rate = default_rate
        # Fail at import/boot on a typo, like McpTokenBucket.__init__.
        self._rate()

    def _rate(self):
        raw = getattr(settings, self.setting_name, None)
        if raw is None:
            raw = self.default_rate
        return _parse_rate(raw, self.setting_name)

    @staticmethod
    def client_ip(scope):
        """Resolve the client IP from an ASGI scope via the shared resolver."""
        from types import SimpleNamespace

        from visiban.utils import get_client_ip

        meta = {}
        client = scope.get("client")
        if client:
            meta["REMOTE_ADDR"] = client[0]
        # Join EVERY x-forwarded-for line with "," exactly as Django's
        # ASGIRequest does, so get_client_ip's rightmost-by-NUM_PROXIES pick
        # sees the same list as the REST throttles. Reading only the first
        # line would let a client prepend its own header line and choose its
        # bucket.
        xff = [
            value.decode("latin-1")
            for name, value in scope.get("headers", [])
            if name == b"x-forwarded-for"
        ]
        if xff:
            meta["HTTP_X_FORWARDED_FOR"] = ",".join(xff)
        return get_client_ip(SimpleNamespace(META=meta))

    @staticmethod
    def _key(ip):
        return f"mcp_preauth_fail:{ip}"

    def blocked(self, ip):
        """Return seconds to retry after if ``ip`` is over budget, else None."""
        num_requests, duration = self._rate()
        now = time.time()
        history = [ts for ts in cache.get(self._key(ip), []) if ts > now - duration]
        if len(history) >= num_requests:
            return max(1, round(duration - (now - history[0])))
        return None

    def record_failure(self, ip):
        _, duration = self._rate()
        key = self._key(ip)
        now = time.time()
        history = [ts for ts in cache.get(key, []) if ts > now - duration]
        history.append(now)
        cache.set(key, history, duration)


preauth_limiter = PreAuthFailureLimiter(
    setting_name="MCP_THROTTLE_PREAUTH_RATE",
    default_rate=DEFAULT_MCP_THROTTLE_PREAUTH_RATE,
)
