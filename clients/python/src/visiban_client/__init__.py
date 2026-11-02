"""Visiban change-feed consumer client (experimental, 0.x). Stdlib only."""

from .client import Client, Resync
from .cursor import CursorStore, MemoryCursorStore
from .errors import (
    APIError,
    AuthenticationError,
    BadRequestError,
    NotFoundError,
    ProtocolError,
    ResyncUnsupported,
    RetriesExhausted,
    VisibanError,
)
from .webhooks import verify_signature

__all__ = [
    "APIError",
    "AuthenticationError",
    "BadRequestError",
    "Client",
    "CursorStore",
    "MemoryCursorStore",
    "NotFoundError",
    "ProtocolError",
    "Resync",
    "ResyncUnsupported",
    "RetriesExhausted",
    "VisibanError",
    "verify_signature",
]
__version__ = "0.1.0"
