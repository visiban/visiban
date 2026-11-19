"""Per-destination-host delivery limits (#2055).

The subscription caps (per board, per user, per server) and the per-run event
cap bound how much one webhook sends, not how much one *receiver* gets: ten
boards' webhooks that all point at one host multiply the requests it sees. The
dispatcher therefore asks this module before every delivery POST whether the
destination host has room, on two limits:

* **Rate** (``WEBHOOK_HOST_MAX_PER_MINUTE``): deliveries to one host per
  fixed one-minute window, summed over every dispatcher process.
* **Concurrency** (``WEBHOOK_HOST_MAX_CONCURRENCY``): deliveries to one host in
  flight at once. One run delivers one request at a time, so this only binds
  when several dispatchers run (two Helm replicas, a loop beside a host cron).

A setting of 0 turns that limit off.

Why the shared cache and not the database
-----------------------------------------
Both counters live in the Django cache (Valkey in Compose and Helm), which every
dispatcher process already shares. They are short-lived (one minute; one
request timeout), so they need no table, no migration and no cleanup. A
concurrency slot is a key with a TTL of one request's longest possible life
(connect plus total timeout, plus a margin), so a dispatcher that dies
mid-request frees its slot when the key expires instead of leaking it.

Fail-soft, never fail-open
--------------------------
If the cache raises (Valkey down), the rate limit falls back to a counter that
lives in this process, not in the run: it is keyed by host and minute window
and survives from one run to the next, so a ``--loop`` dispatcher that starts a
new run every few seconds still delivers at most the per-minute limit to a host
while the cache is down. The concurrency limit is then 1 per process (the
dispatcher delivers one request at a time, so it needs no counter). On a
``LocMemCache`` (tests, or a deployment with no shared cache) the counters are
per process too. Either way the limit holds per dispatcher process; it is
summed across dispatchers only with a shared cache. The fallback counter is
per process, so several dispatcher processes each get the full limit while the
cache is down.

The key is the stored ``url_host``, lower cased and without a trailing dot
(``example.com.`` is ``example.com``). Two different names that resolve to one
address are two hosts here: grouping by address would need a DNS answer per
delivery before the limit could even be checked.

Shared fate, by design
----------------------
The budget is per receiver, not per board: it protects the receiver, which
sees one stream whoever sent it. So a board whose webhooks use a host's whole
budget delays other boards' webhooks to that host too, never by a failure.
The delay lasts until the host's minute window has room again.
Runs take subscriptions least recently scanned first, and a delivery stamps the
subscription to the back of that order. A subscription the limit stopped before
it delivered anything keeps its previous stamp (``dispatch._deliver``), so it
moves up one place each time a subscription ahead of it takes a turn: the
subscriptions sharing a busy host take turns, and each waits for at most one
turn from each subscription ahead of it in that order. A turn is not an equal
share: one subscription's turn can use the whole minute, bounded by the
per-board, per-user and server caps and ``WEBHOOK_MAX_EVENTS_PER_RUN``. Operators who
need more headroom for a shared receiver raise ``WEBHOOK_HOST_MAX_PER_MINUTE``. The host is
hashed in the cache key so the key never carries the destination in plain text
(Valkey ``MONITOR``, a key dump).

A host that is at its limit is not a failed delivery: the subscription stops for
this run with its cursor where it is, no failure is counted and no backoff is
set. If it sent nothing this run it keeps its place in the run order (see
above). Order holds because nothing after the row that waited is sent before it.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
import threading
import time

from django.conf import settings
from django.core.cache import cache

logger = logging.getLogger(__name__)

WINDOW_SECONDS = 60
_KEY_PREFIX = "webhook:host"
#: Margin over a request's own timeouts before a crashed dispatcher's slot frees.
_SLOT_MARGIN_SECONDS = 5


#: The cache-outage fallback rate counter, process-wide on purpose: a limiter is
#: created per run, and a counter that restarted with it would let a looping
#: dispatcher send the full limit again every run. Keyed by (host key, window).
_local_rate: dict[tuple[str, int], int] = {}
_local_rate_lock = threading.Lock()


def reset_local_state():
    """Clear the fallback counters (tests)."""
    with _local_rate_lock:
        _local_rate.clear()


def _setting(name, default):
    return getattr(settings, name, default)


def rate_limit() -> int:
    return max(int(_setting("WEBHOOK_HOST_MAX_PER_MINUTE", 120) or 0), 0)


def concurrency_limit() -> int:
    return max(int(_setting("WEBHOOK_HOST_MAX_CONCURRENCY", 2) or 0), 0)


def host_key(host: str) -> str:
    """A cache-safe, non-revealing key for *host* (case-insensitive)."""
    normalized = (host or "").strip().rstrip(".").lower()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:32]


def _slot_ttl() -> int:
    per_request = float(_setting("WEBHOOK_CONNECT_TIMEOUT_SECONDS", 3.0)) + float(
        _setting("WEBHOOK_TIMEOUT_SECONDS", 10.0)
    )
    return int(per_request) + _SLOT_MARGIN_SECONDS


class HostSlot:
    """A held concurrency slot. ``release()`` is idempotent."""

    def __init__(self, key: str | None = None, token: str | None = None):
        self._key = key
        self._token = token

    def release(self):
        if self._key is None:
            return
        key, token = self._key, self._token
        self._key = None
        try:
            # Only our own slot: if it expired and another dispatcher took it,
            # deleting it would let a third one in over the limit. Not atomic
            # (get, then delete): a slot that expires in between can let one
            # request over the limit once, which the TTL bounds anyway.
            if cache.get(key) == token:
                cache.delete(key)
        except Exception as exc:  # noqa: BLE001 - the key expires on its own
            logger.warning("webhook host slot release failed: error=%s", type(exc).__name__)


class HostLimiter:
    """One per dispatcher run. The fallback counters are module state, not ours."""

    def __init__(self, *, clock=None):
        self._clock = clock if clock is not None else time.time
        #: Set on the first cache error: the rest of the run uses the local
        #: counters without waiting on the cache again. A black-holed Valkey
        #: would otherwise cost a socket timeout per row.
        self._cache_down = False
        #: Host keys refused this run, for the once-per-run log line.
        self.limited_hosts: set[str] = set()

    def acquire(self, host: str) -> HostSlot | None:
        """A slot for one delivery to *host*, or None when the host is at a limit."""
        key = host_key(host)
        # The slot first: a request refused for concurrency must not spend
        # one of the minute's deliveries.
        slot = self._take_slot(key)
        if slot is None:
            self.limited_hosts.add(key)
            return None
        if not self._take_rate(key):
            slot.release()
            self.limited_hosts.add(key)
            return None
        return slot

    # ── rate ─────────────────────────────────────────────────────────────────

    def _take_rate(self, key: str) -> bool:
        limit = rate_limit()
        if not limit:
            return True
        bucket = int(self._clock() // WINDOW_SECONDS)
        cache_key = f"{_KEY_PREFIX}:rate:{key}:{bucket}"
        if self._cache_down:
            return self._take_local_rate(key, bucket, limit)
        try:
            # add() is a no-op when the key exists; incr() is atomic on Valkey.
            # Two windows' worth of TTL: the key is dead once its minute ends.
            cache.add(cache_key, 0, timeout=WINDOW_SECONDS * 2)
            try:
                count = cache.incr(cache_key)
            except ValueError:
                # Evicted between add() and incr(): start the window again.
                cache.set(cache_key, 1, timeout=WINDOW_SECONDS * 2)
                count = 1
        except Exception as exc:  # noqa: BLE001 - see "Fail-soft" above
            self._mark_cache_down(exc)
            return self._take_local_rate(key, bucket, limit)
        return count <= limit

    def _take_local_rate(self, key: str, bucket: int, limit: int) -> bool:
        with _local_rate_lock:
            # Windows before this one can never be counted again: drop them.
            for stale in [k for k in _local_rate if k[1] < bucket]:
                del _local_rate[stale]
            count = _local_rate.get((key, bucket), 0) + 1
            _local_rate[(key, bucket)] = count
        return count <= limit

    def _mark_cache_down(self, exc: BaseException):
        if not self._cache_down:
            self._cache_down = True
            logger.warning("webhook host limits using local counters for this run: error=%s", type(exc).__name__)

    # ── concurrency ──────────────────────────────────────────────────────────

    def _take_slot(self, key: str) -> HostSlot | None:
        limit = concurrency_limit()
        if not limit:
            return HostSlot()
        if self._cache_down:
            return HostSlot()
        token = secrets.token_hex(8)
        ttl = _slot_ttl()
        try:
            for i in range(limit):
                slot_key = f"{_KEY_PREFIX}:slot:{key}:{i}"
                if cache.add(slot_key, token, timeout=ttl):
                    return HostSlot(slot_key, token)
        except Exception as exc:  # noqa: BLE001 - sequential: one in flight per process
            self._mark_cache_down(exc)
            return HostSlot()
        return None
