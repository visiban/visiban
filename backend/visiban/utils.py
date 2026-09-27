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

    One deliberate, safe divergence from DRF's own ``get_ident`` (re-checked by
    completeness-check, #1180, after an earlier version of this note got it
    wrong): when neither ``X-Forwarded-For`` nor ``REMOTE_ADDR`` is present,
    this returns the literal string ``"unknown"`` rather than DRF's ``None`` --
    a safer default for a value used as a throttle/audit key. A
    present-but-empty ``X-Forwarded-For`` is NOT a divergence: it is falsy, so
    this falls through to ``REMOTE_ADDR`` exactly as DRF's own falsy check
    does.
    """
    from rest_framework.settings import api_settings

    xff = request.META.get("HTTP_X_FORWARDED_FOR")
    num_proxies = api_settings.NUM_PROXIES
    if xff and num_proxies:
        addrs = xff.split(",")
        return addrs[-min(num_proxies, len(addrs))].strip()
    return request.META.get("REMOTE_ADDR", "unknown")
