"""Change-feed client (EXPERIMENTAL, 0.x).

Covers only the feed contract in docs/api/events.md: page the feed from a
cursor, hand events to the consumer in order, and surface a ``410`` as a typed
``Resync``. Delivery is at-least-once: the cursor advances only after the
consumer's loop body returned for an item, so a crash replays that item.
Handlers must be idempotent; exactly-once is not offered.
"""

from __future__ import annotations

import http.client
import json
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Iterator, Union
from urllib.parse import urlsplit

from .cursor import CursorStore, MemoryCursorStore
from .errors import (
    APIError,
    AuthenticationError,
    BadRequestError,
    NotFoundError,
    ProtocolError,
    RetriesExhausted,
    ResyncUnsupported,
)

Event = dict  # a feed row, passed through verbatim (unknown fields included)

_MAX_CONSECUTIVE_RESYNCS = 3
_LOOPBACK = {"localhost", "127.0.0.1", "::1"}


@dataclass(frozen=True)
class Resync:
    """The consumer's cursor expired (``410 cursor_expired``).

    ``snapshot`` is the ``/full/`` board state fetched after the 410;
    ``cursor`` is the 410's ``next_cursor``, where the feed resumes.
    Events written around the re-sync can arrive both in ``snapshot`` and on
    the resumed feed, so apply them idempotently. The stored cursor moves to
    ``cursor`` only after your loop body returns for this item.
    """

    board_id: int
    snapshot: dict
    cursor: int


Item = Union[Event, Resync]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow a redirect: urllib would re-send the Authorization header."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:  # noqa: D401
        return None


class Client:
    """Read-only client for one Visiban server, authenticated with a scoped PAT.

    The token needs the ``read`` scope. Pass ``sleep`` to replace
    ``time.sleep`` (tests), ``jitter=False`` for deterministic backoff.
    """

    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        timeout: float = 30.0,
        max_retries: int = 5,
        backoff_base: float = 0.5,
        backoff_max: float = 30.0,
        jitter: bool = True,
        allow_insecure: bool = False,
        sleep: Callable[[float], None] = time.sleep,
        user_agent: str = "visiban-client-python/0.1.0",
    ) -> None:
        if not token:
            raise ValueError("token is required (a scoped personal access token)")
        if any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in token):
            # Fixed message: never echo the token. A trailing newline from a
            # token file is the usual cause (strip it).
            raise ValueError("token contains whitespace or control characters")
        parts = urlsplit(base_url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ValueError("base_url must be an http(s) URL")
        if parts.username is not None or parts.password is not None:
            # Fixed message: the credentials must not appear in any error.
            raise ValueError("base_url must not contain credentials; pass the token separately")
        if parts.scheme == "http" and parts.hostname not in _LOOPBACK and not allow_insecure:
            raise ValueError("refusing to send a token over plain http to a non-loopback host; use https or allow_insecure=True")
        self._base = base_url.rstrip("/")
        self._origin = f"{parts.scheme}://{parts.netloc}"
        self._token = token
        self._timeout = timeout
        self._max_retries = max_retries
        self._backoff_base = backoff_base
        self._backoff_max = backoff_max
        self._jitter = jitter
        self._sleep = sleep
        self._ua = user_agent
        self._opener = urllib.request.build_opener(_NoRedirect)

    # -- transport ---------------------------------------------------------

    def _delay(self, attempt: int, retry_after: str | None) -> float:
        if retry_after is not None and retry_after.strip().isascii() and retry_after.strip().isdigit():
            return min(float(retry_after.strip()), self._backoff_max)
        delay = min(self._backoff_base * (2 ** attempt), self._backoff_max)
        if self._jitter:
            # Backoff jitter is not security-sensitive, so the non-crypto PRNG is fine.
            delay *= 0.5 + random.random() / 2  # nosec B311
        return delay

    def _get_json(self, url: str) -> Any:
        """GET ``url`` with retry on 429, 5xx and network errors."""
        last: APIError | None = None
        for attempt in range(self._max_retries + 1):
            retry_after = None
            req = urllib.request.Request(
                url,
                headers={
                    "Authorization": f"Token {self._token}",
                    "Accept": "application/json",
                    "User-Agent": self._ua,
                },
            )
            try:
                # Scheme is restricted to http(s) in __init__.
                with self._opener.open(req, timeout=self._timeout) as resp:  # nosec B310
                    raw = resp.read()
                    status = resp.status
            except urllib.error.HTTPError as exc:
                status = exc.code
                retry_after = exc.headers.get("Retry-After") if exc.headers else None
                try:
                    raw = exc.read()
                except (http.client.HTTPException, OSError) as read_exc:
                    last = RetriesExhausted(status, f"error reading response: {type(read_exc).__name__}")
                    if attempt < self._max_retries:
                        self._sleep(self._delay(attempt, retry_after))
                    continue
            # HTTPException covers IncompleteRead and BadStatusLine (a truncated
            # or garbled response): retriable like any other network failure.
            except (urllib.error.URLError, http.client.HTTPException, OSError) as exc:
                last = RetriesExhausted(0, f"network error: {exc}")
                if attempt < self._max_retries:
                    self._sleep(self._delay(attempt, None))
                continue
            body = _decode(raw)
            if 200 <= status < 300:
                return body
            if status == 429 or status >= 500:
                last = RetriesExhausted(status, _detail(body), _code(body), body)
                if attempt < self._max_retries:
                    self._sleep(self._delay(attempt, retry_after))
                continue
            raise _error_for(status, body)
        assert last is not None
        raise last

    def _same_origin_url(self, resync_url: str) -> str:
        """Resolve the 410's ``resync_url`` against ``base_url``, keeping only its path.

        The server builds that URL from the request's Host header, which behind
        a proxy can be an internal name. Following it verbatim could also send
        the token to an unrelated host, so only the path is trusted.
        """
        parts = urlsplit(resync_url)
        path = parts.path or ""
        if not path.startswith("/"):
            raise ProtocolError("resync_url has no usable path")
        return self._origin + path + (f"?{parts.query}" if parts.query else "")

    # -- the feed ----------------------------------------------------------

    def fetch_page(self, board_id: int, after: int = 0, limit: int = 100) -> Any:
        """One raw ``GET /boards/{id}/events/`` page, as parsed JSON. Prefer ``iter_events``."""
        try:
            return self._fetch_page(board_id, after, limit)
        except _Gone:
            raise ProtocolError("unexpected 410 outside iter_events") from None

    def _fetch_page(self, board_id: int, after: int, limit: int) -> Any:
        query = urllib.parse.urlencode({"after": after, "limit": limit})
        return self._get_json(f"{self._base}/api/v1/boards/{int(board_id)}/events/?{query}")

    def iter_events(
        self,
        board_id: int,
        cursor: int | None = None,
        *,
        store: CursorStore | None = None,
        limit: int = 100,
        poll_interval: float | None = None,
    ) -> Iterator[Item]:
        """Yield events in feed order, and a ``Resync`` when the cursor expired.

        - Start: ``cursor`` if given, else ``store.get(board_id)``, else 0.
          With no ``store`` a fresh ``MemoryCursorStore`` is created *per call*,
          so a bare ``iter_events(board_id)`` replays from 0 every time it is
          called. Keep one store across calls, or pass ``cursor``, to resume.
        - Advance: the stored cursor moves to an item's id when you ask for the
          *next* item, i.e. after your loop body returned. Leaving the loop
          early (``break``, an exception) leaves that item uncommitted.
          After an exception call ``iter_events`` again for a new generator.
          Calling ``next()`` on the old one would treat the failed item as
          handled and commit it; a generator cannot see your exception.
        - ``poll_interval``: ``None`` (default) returns once caught up; a number
          of seconds sleeps and polls forever.

        Caught up means the server's ``next_cursor`` was null. The client never
        counts rows: a full page may or may not be the last one.

        There is no overlap option and none is needed against a 1.3 or later
        server: event ids follow insert order, not commit order, but the server
        never hands out a page past an event still committing (#2053), so reads
        are gap-free. Against an earlier server a read can step past a row that
        commits a moment later.
        """
        if not 1 <= limit <= 500:
            raise ValueError("limit must be between 1 and 500")
        store = store if store is not None else MemoryCursorStore()
        current = cursor if cursor is not None else (store.get(board_id) or 0)
        resyncs = 0  # consecutive, reset by any successful page

        while True:
            after = current
            while True:  # pages of one poll cycle
                try:
                    page = self._fetch_page(board_id, after, limit)
                except _Gone as gone:
                    resyncs += 1
                    if resyncs > _MAX_CONSECUTIVE_RESYNCS:
                        raise ProtocolError("server keeps answering 410 after re-syncing; giving up")
                    resync = self._resync(board_id, gone.body)
                    yield resync
                    # Reached only when the consumer asked for the next item.
                    store.set(board_id, resync.cursor)
                    current = resync.cursor
                    after = current
                    continue
                results, next_cursor = _validate_page(page, after)
                resyncs = 0
                for event in results:
                    yield event
                    if event["id"] > current:
                        current = event["id"]
                        store.set(board_id, current)
                if next_cursor is None:
                    break
                after = next_cursor
            if poll_interval is None:
                return
            self._sleep(poll_interval)

    def _resync(self, board_id: int, body: Any) -> Resync:
        data = body if isinstance(body, dict) else {}
        next_cursor = data.get("next_cursor")
        resync_url = data.get("resync_url")
        if _is_int(next_cursor) and next_cursor < 0:
            raise ProtocolError("410 next_cursor is negative")
        if not _is_int(next_cursor):
            raise ResyncUnsupported(
                "410 cursor_expired without next_cursor: the server predates 1.3 and "
                "offers no safe resume point; upgrade the server to 1.3 or later",
                resync_url if isinstance(resync_url, str) else None,
            )
        if not isinstance(resync_url, str):
            raise ProtocolError("410 cursor_expired without resync_url")
        try:
            snapshot = self._get_json(self._same_origin_url(resync_url))
        except _Gone:
            raise ProtocolError("unexpected 410 fetching the snapshot") from None
        if not isinstance(snapshot, dict):
            raise ProtocolError("resync snapshot is not a JSON object")
        return Resync(board_id=board_id, snapshot=snapshot, cursor=next_cursor)


class _Gone(Exception):
    def __init__(self, body: Any):
        super().__init__("410")
        self.body = body


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _decode(raw: bytes) -> Any:
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


def _detail(body: Any) -> str:
    return str(body.get("detail", "")) if isinstance(body, dict) else ""


def _code(body: Any) -> str | None:
    code = body.get("code") if isinstance(body, dict) else None
    return code if isinstance(code, str) else None


def _error_for(status: int, body: Any) -> Exception:
    detail, code = _detail(body), _code(body)
    if status == 410 and code == "cursor_expired":
        # Not an error to the caller: iter_events turns it into a Resync.
        return _Gone(body)
    if status in (401, 403):
        return AuthenticationError(status, detail, code, body)
    if status == 404:
        return NotFoundError(status, detail, code, body)
    if status == 400:
        return BadRequestError(status, detail, code, body)
    return APIError(status, detail, code, body)



def _validate_page(page: Any, after: int) -> tuple[list[dict], int | None]:
    if not isinstance(page, dict) or not isinstance(page.get("results"), list):
        raise ProtocolError("events response has no results list")
    next_cursor = page.get("next_cursor")
    if next_cursor is not None and not _is_int(next_cursor):
        raise ProtocolError("next_cursor is not an integer or null")
    for event in page["results"]:
        if not isinstance(event, dict) or not _is_int(event.get("id")):
            raise ProtocolError("event row without an integer id")
    if next_cursor is not None and next_cursor <= after:
        raise ProtocolError("next_cursor did not advance; refusing to loop")
    return page["results"], next_cursor
