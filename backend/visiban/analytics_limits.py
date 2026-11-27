"""Startup parsing of the analytics limit settings (#2428).

Kept free of Django app imports so ``settings.py`` can call it.
"""

from django.core.exceptions import ImproperlyConfigured

DEFAULT_ANALYTICS_MAX_CONCURRENT = 1
DEFAULT_ANALYTICS_MAX_MOVEMENTS = 150_000
# Wall-clock seconds one admitted analytics request may run. With the 8 s
# wait for a slot that is 53 s, under the tightest bundled proxy read
# timeout (the Helm chart's frontend nginx sets none for /api/, so nginx's
# 60 s default applies; Compose's nginx allows 90 s), so a client gets the
# server's own refusal rather than a proxy 504.
DEFAULT_ANALYTICS_MAX_SECONDS = 45


def parse_positive_int(raw, *, name, default):
    """``raw`` as a whole number of at least 1; blank or unset means ``default``.

    Strict on purpose, and unlike the ``ATTACHMENT_MAX_*`` quotas, 0 is not
    "no limit": these settings bound one process's analytics work, and there
    is no off switch. Anything else (0, negative, not a whole number) stops
    startup with ``ImproperlyConfigured`` rather than a bare ``ValueError``.
    """
    value = (raw or "").strip()
    if not value:
        return default
    try:
        parsed = int(value, 10)
    except ValueError:
        parsed = None
    if parsed is None or parsed < 1:
        raise ImproperlyConfigured(f"{name} must be a whole number of at least 1 (got {value!r}).")
    return parsed
