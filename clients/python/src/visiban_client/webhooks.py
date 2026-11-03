"""Webhook signature verification (EXPERIMENTAL until webhooks are stable, #2070).

Scheme, from docs/api/webhooks.md "Verifying signatures"::

    X-Visiban-Signature = "v1=" + hex(HMAC-SHA256(secret, f"{timestamp}.{raw body}"))

``timestamp`` is the ``X-Visiban-Timestamp`` header (unix seconds). During a
secret rotation the header lists two comma-separated values, ``v1=<new>,v1=<old>``;
a request is accepted when any listed value matches.
"""

from __future__ import annotations

import hashlib
import hmac
import time
from typing import Mapping

TOLERANCE_SECONDS = 300
MAX_SIGNATURE_VALUES = 8
SIGNATURE_HEADER = "X-Visiban-Signature"
TIMESTAMP_HEADER = "X-Visiban-Timestamp"


def _header(headers: Mapping[str, str], name: str) -> str:
    """Case-insensitive lookup that also works for a plain ``dict``."""
    value = headers.get(name)
    if value is None:
        lowered = name.lower()
        for key, candidate in headers.items():
            if key.lower() == lowered:
                value = candidate
                break
    return value if isinstance(value, str) else ""


def verify_signature(
    secret: str | bytes,
    headers: Mapping[str, str],
    raw_body: bytes,
    *,
    tolerance: int = TOLERANCE_SECONDS,
    now: float | None = None,
) -> bool:
    """Return True when the delivery is authentic and fresh.

    ``raw_body`` must be the exact bytes received, before any JSON parsing:
    re-serialized JSON will not match. Returns False (never raises) for a
    missing or malformed header, a stale or future timestamp, a mismatch, or
    more than ``MAX_SIGNATURE_VALUES`` values in the signature header.
    """
    if not secret:
        # An empty key would let anyone forge a valid signature.
        raise ValueError("secret must not be empty")
    if not (tolerance >= 0 and tolerance != float("inf")):
        raise ValueError("tolerance must be a finite number >= 0")
    if not isinstance(raw_body, (bytes, bytearray)):
        raise TypeError("raw_body must be bytes: verify the unparsed request body")
    timestamp = _header(headers, TIMESTAMP_HEADER)
    signature = _header(headers, SIGNATURE_HEADER)
    # Length cap: int() on thousands of digits raises, and a receiver must not 500.
    if not (timestamp.isascii() and timestamp.isdigit() and len(timestamp) <= 12):
        return False
    current = time.time() if now is None else now
    # abs(): reject a timestamp too far in the future as well as one too old.
    if abs(current - int(timestamp)) > tolerance:
        return False
    key = secret.encode() if isinstance(secret, str) else secret
    message = timestamp.encode() + b"." + bytes(raw_body)
    expected = ("v1=" + hmac.new(key, message, hashlib.sha256).hexdigest()).encode()
    values = signature.split(",")
    if len(values) > MAX_SIGNATURE_VALUES:
        return False
    # Every value is compared, with no early exit, so the time taken does not say
    # which one matched. An unknown scheme is just a value that does not match.
    matched = False
    for value in values:
        matched |= hmac.compare_digest(expected, value.strip().encode())
    return matched
