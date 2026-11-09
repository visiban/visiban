from django.core.exceptions import ImproperlyConfigured


def normalize_app_version(value: str) -> str:
    """Strip a leading ``v`` so APP_VERSION always reports as bare semver.

    APP_VERSION doubles as the docker-compose/Helm image tag operators pin
    (v-prefixed, e.g. "v1.1.0", matching the tags CI actually publishes to
    GHCR -- see #1174) and the value GET /api/v1/version/ serves callers,
    which promises bare semver they can parse (docs/api/version.md). Accept
    either form here so that public API contract holds regardless of which
    one ops set APP_VERSION to.
    """
    return value.removeprefix("v")


#: Default number of trusted reverse proxies in front of Django: the frontend
#: nginx. Every shipped topology (Compose, the Helm chart without a tunnel) has
#: exactly one, which is what REST_FRAMEWORK["NUM_PROXIES"] was hardcoded to
#: before #1180 made it configurable.
DEFAULT_NUM_PROXIES = 1


def parse_num_proxies(raw: str | None) -> int:
    """Parse the ``NUM_PROXIES`` env var strictly (#1180).

    The value decides which ``X-Forwarded-For`` entry every per-IP throttle,
    the allauth rate limits and the ``/admin/`` IP allowlist key on. Too LOW
    and every visitor shares the address of the nearest proxy, so one client
    exhausts a throttle for everyone; too HIGH and a client can pick its own
    bucket by sending its own ``X-Forwarded-For``. Both are silent, so an
    unparseable value refuses to boot instead of falling back to a default the
    operator did not choose. Unset or blank means the default, so existing
    installs are unchanged.
    """
    if raw is None or not raw.strip():
        return DEFAULT_NUM_PROXIES
    value = raw.strip()
    if not value.isdigit():
        raise ImproperlyConfigured(
            f"NUM_PROXIES={raw!r} is not a non-negative integer. Set it to the number "
            "of reverse proxies in front of the backend that append to X-Forwarded-For "
            "(1 for the bundled nginx alone)."
        )
    return int(value)


def get_client_ip(request) -> str:
    """Return the originating client IP from the request.

    Mirrors DRF's ``BaseThrottle.get_ident``, reading the same
    ``REST_FRAMEWORK["NUM_PROXIES"]``: with N trusted proxies the client is the
    Nth ``X-Forwarded-For`` entry from the right, because each trusted proxy
    appends the address it received the request from and everything to the
    left of those entries is client-supplied (and so spoofable). With the
    default of 1 that is the rightmost entry, the one the bundled nginx
    appends. Keeping this identical to DRF is the point (#1180): the admin
    allowlist, the invite audit log and allauth's rate limits must key on the
    same address as the DRF throttles, or two controls disagree about who the
    client is. Falls back to REMOTE_ADDR for direct connections.

    Three deliberate, safe divergences from DRF's own ``get_ident`` (the first
    re-checked by completeness-check, #1180; the second corrected in #1852,
    after an earlier version of this note claimed the opposite; the third is
    the unconfigured ``NUM_PROXIES`` case, also documented in
    docs/architecture/open-core-boundary.md):

    * When neither ``X-Forwarded-For`` nor ``REMOTE_ADDR`` is present, this
      returns the literal string ``"unknown"`` rather than DRF's ``None`` -- a
      safer default for a value used as a throttle/audit key.
    * A present-but-empty ``X-Forwarded-For`` with ``NUM_PROXIES >= 1`` falls
      through to ``REMOTE_ADDR`` here (the header is falsy), whereas DRF only
      falls back to ``REMOTE_ADDR`` when the header is absent (``xff is None``);
      an empty string is split to ``[""]`` and DRF returns ``""``, keying every
      such client on one shared bucket. Returning the real peer address is the
      safer key. The bundled nginx always appends the peer address
      (``proxy_add_x_forwarded_for``), so the header is never empty behind it;
      this only matters for a non-default proxy that forwards an empty header.
    * With ``NUM_PROXIES = None`` (the DRF default, i.e. the setting dropped),
      DRF keys on the whole client-controlled ``X-Forwarded-For`` string
      (whitespace stripped), so a client can pick a fresh bucket per request.
      This function skips the header entirely (``num_proxies`` is falsy) and
      returns ``REMOTE_ADDR``. That is the safer key, though behind a proxy
      every client then shares the proxy's address.
    """
    from rest_framework.settings import api_settings

    xff = request.META.get("HTTP_X_FORWARDED_FOR")
    num_proxies = api_settings.NUM_PROXIES
    if xff and num_proxies:
        addrs = xff.split(",")
        return addrs[-min(num_proxies, len(addrs))].strip()
    return request.META.get("REMOTE_ADDR", "unknown")


#: Cap on the raw length of a client-submitted ``allowed_priorities`` list,
#: shared by ``GroupSerializer.validate_allowed_priorities``
#: (groups/serializers.py) and ``BoardSerializer.validate_allowed_priorities``
#: (boards/serializers.py) (#1186).
#:
#: #1169 added this identical check independently to both serializers because
#: ``groups/serializers.py`` documents a hard "no import from boards"
#: invariant (to avoid a groups<->boards cycle, since boards/serializers.py
#: already imports GroupBriefSerializer from groups/serializers.py), so
#: neither app's own module was a safe home for the shared copy. Nothing then
#: kept the two values in sync — a future change to one without the other
#: would silently reintroduce the drift #1169 fixed. ``visiban.utils`` is the
#: Django-project-level module (not an app) both already import
#: (``get_client_ip``, ``normalize_app_version``), so it holds the shared
#: constant instead of adding a new module.
MAX_ALLOWED_PRIORITIES_LENGTH = 100


def check_allowed_priorities_length(value, max_length=MAX_ALLOWED_PRIORITIES_LENGTH):
    """Raise a DRF ``ValidationError`` if ``value`` exceeds the shared cap.

    Callers must run this before any iteration or membership test over
    ``value`` (#1169 L1) so the cost of rejecting an oversized list is O(1),
    not O(n). The message wording is shared too, since #1169 introduced it
    identically in both serializers.

    ``rest_framework`` is imported locally, not at module scope, matching
    ``get_client_ip`` above: ``visiban.settings`` imports this module while
    Django is still assembling ``INSTALLED_APPS``, before DRF is safe to
    import at import time.
    """
    from rest_framework import serializers

    if len(value) > max_length:
        raise serializers.ValidationError(
            f"allowed_priorities may have at most {max_length} entries."
        )
