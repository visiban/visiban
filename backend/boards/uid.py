"""Stable UID generation for board models.

Defined in its own module so that both models.py and migrations can import the
same callable, ensuring Django serialises the default= dotted path identically
in both places (boards.uid._generate_uid).  Migrations must not import from
models.py — this module is the stable contract point.
"""
import secrets


def _generate_uid() -> str:
    """Return a 16-character lowercase hex string (64 bits of randomness)."""
    return secrets.token_hex(8)
