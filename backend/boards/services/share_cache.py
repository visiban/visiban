"""Short-lived cache of the public share-link board body (#1965).

The body of ``GET /api/share/<token>/`` is rebuilt from the database on every
anonymous hit. This module holds it for a few seconds, under two rules the
view depends on:

* **The cache never decides access.** The view resolves the token, checks the
  enabler's standing and the expiry on every request *before* it reads the
  cache, so a revoked, rotated, lapsed or expired link answers 404/410 at once
  with a warm cache. A cached body is only ever returned to a request that
  already passed those checks.
* **Content freshness is bounded two ways.** ``Board.updated_at`` is not a
  usable version: card, column and swimlane writes do not touch the board row.
  Instead every board-channel broadcast (``broadcast_board_event``, which each
  write path on a board-scoped resource calls) bumps a per-board version that
  is part of the cache key, so the next hit after a change rebuilds. A write
  path that does not broadcast, or a time-based field such as ``is_stale``, is
  still bounded by the TTL.

The key holds the token's hash, never the token (#1880).
"""

import logging
import time

from django.conf import settings
from django.core.cache import cache

logger = logging.getLogger(__name__)

DEFAULT_TTL_SECONDS = 15


def _ttl() -> int:
    try:
        return int(getattr(settings, "SHARE_BOARD_CACHE_TTL_SECONDS", DEFAULT_TTL_SECONDS))
    except (TypeError, ValueError):
        return DEFAULT_TTL_SECONDS


def _version_key(board_id: int) -> str:
    return f"share_board_version:{board_id}"


def _body_key(token_hash: str, version) -> str:
    return f"share_board_body:{token_hash}:{version}"


def bump_board_version(board_id: int) -> None:
    """Invalidate every cached public body of ``board_id``.

    The version is a nanosecond timestamp, not a counter, so an evicted version
    key restarts at a value no earlier body was stored under.
    """
    try:
        cache.set(_version_key(board_id), time.time_ns(), timeout=None)
    except Exception:  # noqa: BLE001 — a cache outage must not fail a committed write
        logger.warning("share cache version bump failed: board_id=%s", board_id)


def _current_version(board_id: int):
    key = _version_key(board_id)
    version = cache.get(key)
    if version is None:
        cache.add(key, time.time_ns(), timeout=None)
        version = cache.get(key)
    return version


def get_or_build(board, token_hash: str, build):
    """The cached public body for this link, or ``build()`` stored for the TTL.

    Fails open: a cache outage serves a fresh build rather than an error.
    """
    ttl = _ttl()
    if ttl <= 0:
        return build()
    try:
        version = _current_version(board.pk)
        key = _body_key(token_hash, version)
        body = cache.get(key)
    except Exception:  # noqa: BLE001
        logger.warning("share cache read failed: board_id=%s", board.pk)
        return build()
    if body is not None:
        return body
    body = build()
    try:
        cache.set(key, body, timeout=ttl)
    except Exception:  # noqa: BLE001
        logger.warning("share cache write failed: board_id=%s", board.pk)
    return body
