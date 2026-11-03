"""Webhook request signing (#863).

``X-Visiban-Signature: v1=<hex HMAC-SHA256(secret, f"{timestamp}.{raw_body}")>``

The timestamp is signed with the body so a receiver can refuse a replayed
request: it checks the signature, then that ``X-Visiban-Timestamp`` is within
its tolerance (the docs recommend 5 minutes). ``v1=`` versions the scheme so a
future change can be sent beside the old one during a migration.

During a secret-rotation overlap (#2054) the header lists two comma-separated
values, ``v1=<new>,v1=<old>``, both over the same timestamp and body. Outside an
overlap it is exactly one value, byte-identical to :func:`sign`. A receiver holds
one secret and accepts the request when any listed value matches it.
"""

import hashlib
import hmac

SIGNATURE_VERSION = "v1"
#: More values than this is not something Visiban sends: refuse, don't scan.
MAX_SIGNATURE_VALUES = 8


def sign(secret: str, timestamp: int, body: bytes) -> str:
    """Return the ``X-Visiban-Signature`` header value for *body*."""
    message = str(int(timestamp)).encode("ascii") + b"." + body
    digest = hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()
    return f"{SIGNATURE_VERSION}={digest}"


def signature_header(secret: str, previous: str | None, timestamp: int, body: bytes) -> str:
    """The header value: the current signature, then the previous one if any."""
    current = sign(secret, timestamp, body)
    if not previous:
        return current
    return f"{current},{sign(previous, timestamp, body)}"


def verify(secret: str, timestamp: int, body: bytes, header: str) -> bool:
    """Constant-time check of a signature header; what a receiver does.

    True when any listed value matches. Every value is compared, without an
    early exit, so the time taken does not say which one matched. An unknown
    scheme is simply a value that does not match.
    """
    values = (header or "").split(",")
    if len(values) > MAX_SIGNATURE_VALUES:
        return False
    expected = sign(secret, timestamp, body).encode()
    matched = False
    for value in values:
        matched |= hmac.compare_digest(expected, value.strip().encode())
    return matched
