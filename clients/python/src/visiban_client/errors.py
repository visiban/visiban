"""Typed errors raised by the client.

Everything derives from ``VisibanError`` so a consumer can catch one type.
"""

from __future__ import annotations

from typing import Any


class VisibanError(Exception):
    """Base class for every error this package raises on purpose."""


class APIError(VisibanError):
    """The server answered with a non-success status."""

    def __init__(self, status: int, detail: str = "", code: str | None = None, body: Any = None):
        super().__init__(f"HTTP {status}" + (f" ({code})" if code else "") + (f": {detail}" if detail else ""))
        self.status = status
        self.detail = detail
        self.code = code
        self.body = body


class AuthenticationError(APIError):
    """401 or 403: the token is missing, revoked, expired, or lacks the ``read`` scope."""


class NotFoundError(APIError):
    """404: no such board, or the token's user has no access to it."""


class BadRequestError(APIError):
    """400: a rejected query parameter (``after`` or ``limit``)."""


class RetriesExhausted(APIError):
    """429, 5xx, or a network failure persisted through every retry."""


class ProtocolError(VisibanError):
    """The response did not match the documented feed contract."""


class ResyncUnsupported(VisibanError):
    """A ``410`` arrived without ``next_cursor`` (a pre-1.3 server).

    Without ``next_cursor`` there is no safe place to resume after the
    snapshot, and guessing would silently skip or replay events, so the
    client refuses. Upgrade the server to 1.3 or later.
    """

    def __init__(self, message: str, resync_url: str | None = None):
        super().__init__(message)
        self.resync_url = resync_url
