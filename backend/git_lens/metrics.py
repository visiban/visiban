"""Operational counters and structured logging for the lens's outbound API usage (#1061).

Why this exists: the lens reads GitHub/GitLab on behalf of board viewers, and GitLab
reads are anonymous — charged to the *instance's* IP. An IT admin needs to see how
much upstream traffic the feature actually generates, not just trust that the
budgets in ``views.py`` bound it. Two surfaces answer that:

* a structured log line per outbound HTTP call (logger ``git_lens.outbound``), and
* hourly counters in the Django cache, read back by the admin-only
  ``GET /api/v1/admin/git-lens/usage/`` endpoint.

Design constraints, each deliberate:

* **Cache-only, no model.** Same tool the fetch budgets use: ephemeral,
  approximate, reset by a cache flush. These are operational health numbers, not
  an audit trail (audit logs are an enterprise concern), so 24 hours of hourly
  buckets is the whole retention contract.
* **Never on the failure path.** A counter is a side channel. Every cache error is
  swallowed here — a Valkey blip must never turn a board read into a 500, which is
  the opposite of how the load-bearing budget counters in ``views.py`` behave.
* **Fixed, small label sets.** Provider, kind and outcome are closed enums, so the
  key space is a constant (no ``maxmemory-policy`` is configured, so unbounded key
  growth would mean Valkey OOM rather than silent eviction). Unknown labels are
  coerced to ``"other"`` rather than minting new keys.
* **No secrets or PII in the log line.** Only provider, kind, outcome, HTTP status,
  duration and the repo slug (a public path a board admin configured). Never the
  token, the Authorization header, query params (filter values carry usernames)
  or the full URL.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone as dt_timezone

from django.core.cache import cache

outbound_logger = logging.getLogger("git_lens.outbound")
_internal_logger = logging.getLogger(__name__)

PROVIDERS = ("github", "gitlab")
# What kind of upstream resource an outbound call read. Provider-neutral: GitHub
# "pulls" are counted as merge_requests.
KINDS = ("issues", "branches", "merge_requests", "milestones")
OUTBOUND_OUTCOMES = (
    "ok",
    "not_found",
    "auth_error",
    "rate_limited",
    "http_error",
    "network_error",
)
# One per return path of ``views.LensBoardView._serve_board``. Together they show
# how many board reads the cache absorbed versus how many reached the provider —
# the observable half of the "bounded" claim.
BOARD_OUTCOMES = (
    "cache_fresh",             # served from a fresh cache entry, no upstream call
    "cache_stale_locked",      # another request was revalidating; stale copy served
    "budget_exhausted_stale",  # viewer's fetch budget spent; stale copy served
    "budget_exhausted_429",    # viewer's fetch budget spent and nothing cached → 429
    "fetched",                 # provider fetch succeeded
    "error_stale",             # provider fetch failed; stale copy served
    "error",                   # provider fetch failed and nothing cached → error response
)
_OTHER = "other"

# Hourly buckets, 24 of them reported. The TTL carries an hour of slack so the
# oldest reported bucket is never evicted while it is still inside the window.
BUCKET_SECONDS = 3600
RETENTION_HOURS = 24
_BUCKET_TTL = (RETENTION_HOURS + 1) * BUCKET_SECONDS
_KEY_PREFIX = "git_lens:metrics:v1"


def _bucket(now: datetime) -> str:
    return now.astimezone(dt_timezone.utc).strftime("%Y%m%d%H")


def _now() -> datetime:
    return datetime.now(dt_timezone.utc)


def _label(value, allowed) -> str:
    return value if value in allowed else _OTHER


def _outbound_key(bucket: str, provider: str, kind: str, outcome: str) -> str:
    return f"{_KEY_PREFIX}:{bucket}:out:{provider}:{kind}:{outcome}"


def _board_key(bucket: str, provider: str, outcome: str) -> str:
    return f"{_KEY_PREFIX}:{bucket}:board:{provider}:{outcome}"


def _incr(key: str) -> None:
    """Best-effort atomic increment. Swallows every cache error (see module docstring)."""
    # incr-first, add on miss: the key exists for all but the first call in each
    # hour, and ``cache_fresh`` runs on every warm board read, so the steady state
    # must be the cheap path (#1061 perf-check). Losing an add() race to a
    # concurrent first writer drops at most one count, which is within the
    # "approximate" contract.
    try:
        try:
            cache.incr(key)
        except ValueError:
            # First count in this bucket (or the bucket just expired).
            if not cache.add(key, 1, _BUCKET_TTL):
                cache.incr(key)
    except Exception:  # noqa: BLE001 — a metrics side channel must never break a request
        # WARNING, not DEBUG: a sustained run of these means the usage report is
        # under-counting, and an admin relying on it must be able to see that at
        # default log levels (#1061 security-review).
        _internal_logger.warning("git_lens: metrics increment failed", exc_info=True)


def record_outbound(
    provider: str,
    kind: str,
    outcome: str,
    *,
    status_code: int | None,
    duration_ms: int,
    repo: str,
) -> None:
    """Count one outbound HTTP call and emit its structured log line."""
    provider = _label(provider, PROVIDERS)
    kind = _label(kind, KINDS)
    outcome = _label(outcome, OUTBOUND_OUTCOMES)
    _incr(_outbound_key(_bucket(_now()), provider, kind, outcome))
    # key=value message for plain-text log pipelines, plus the same fields as
    # ``extra`` attributes for JSON formatters. The field list is the contract:
    # adding a field here must never add a credential, a query param or a URL.
    outbound_logger.info(
        "git_lens outbound provider=%s kind=%s outcome=%s status=%s duration_ms=%d repo=%s",
        provider, kind, outcome,
        status_code if status_code is not None else "-",
        duration_ms, repo,
        extra={
            "lens_provider": provider,
            "lens_kind": kind,
            "lens_outcome": outcome,
            "lens_status": status_code,
            "lens_duration_ms": duration_ms,
            "lens_repo": repo,
        },
    )


def record_board(provider: str, outcome: str) -> None:
    """Count one board read by how ``_serve_board`` answered it."""
    _incr(_board_key(_bucket(_now()), _label(provider, PROVIDERS), _label(outcome, BOARD_OUTCOMES)))


def snapshot(now: datetime | None = None) -> dict:
    """Read every counter in the retention window with a single ``get_many``.

    The key set is a fixed product of the enums × 24 buckets, so the read cost is
    constant (one MGET on Valkey) regardless of traffic.
    """
    now = now or _now()
    buckets = [_bucket(now - timedelta(hours=h)) for h in range(RETENTION_HOURS)]
    out_labels = [
        (p, k, o) for p in PROVIDERS for k in KINDS for o in OUTBOUND_OUTCOMES
    ]
    board_labels = [(p, o) for p in PROVIDERS for o in BOARD_OUTCOMES]
    keys = [_outbound_key(b, *lbl) for b in buckets for lbl in out_labels]
    keys += [_board_key(b, *lbl) for b in buckets for lbl in board_labels]
    try:
        values = cache.get_many(keys)
    except Exception:  # noqa: BLE001 — degrade to zeros rather than 500 the admin page
        _internal_logger.warning("git_lens: metrics snapshot read failed", exc_info=True)
        values = {}

    def _v(key):
        try:
            return int(values.get(key) or 0)
        except (TypeError, ValueError):
            return 0

    def _provider_block(bucket_list):
        block = {}
        for p in PROVIDERS:
            by_kind = {
                k: {o: sum(_v(_outbound_key(b, p, k, o)) for b in bucket_list) for o in OUTBOUND_OUTCOMES}
                for k in KINDS
            }
            board = {
                o: sum(_v(_board_key(b, p, o)) for b in bucket_list) for o in BOARD_OUTCOMES
            }
            block[p] = {
                "outbound_calls": sum(sum(v.values()) for v in by_kind.values()),
                "outbound_by_kind": by_kind,
                "board_requests": board,
            }
        return block

    hourly = []
    for b in buckets:
        per = _provider_block([b])
        hourly.append(
            {
                "hour": datetime.strptime(b, "%Y%m%d%H")
                .replace(tzinfo=dt_timezone.utc)
                .isoformat(),
                "outbound_calls": {p: per[p]["outbound_calls"] for p in PROVIDERS},
            }
        )

    return {
        "generated_at": now.isoformat(),
        "window_hours": RETENTION_HOURS,
        "bucket_seconds": BUCKET_SECONDS,
        "current_hour": _provider_block(buckets[:1]),
        "last_24h": _provider_block(buckets),
        # Oldest first, so it reads as a time series.
        "hourly": list(reversed(hourly)),
    }
