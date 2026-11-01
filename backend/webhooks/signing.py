"""Webhook request signing (#863).

``X-Visiban-Signature: v1=<hex HMAC-SHA256(secret, f"{timestamp}.{raw_body}")>``

The timestamp is signed with the body so a receiver can refuse a replayed
request: it checks the signature, then that ``X-Visiban-Timestamp`` is within
its tolerance (the docs recommend 5 minutes). ``v1=`` versions the scheme so a
future change can be sent beside the old one during a migration.
"""

import hashlib
import hmac

SIGNATURE_VERSION = "v1"


def sign(secret: str, timestamp: int, body: bytes) -> str:
    """Return the ``X-Visiban-Signature`` header value for *body*."""
    message = str(int(timestamp)).encode("ascii") + b"." + body
    digest = hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()
    return f"{SIGNATURE_VERSION}={digest}"


def verify(secret: str, timestamp: int, body: bytes, header: str) -> bool:
    """Constant-time check of a signature header; what a receiver does."""
    return hmac.compare_digest(sign(secret, timestamp, body), header or "")
