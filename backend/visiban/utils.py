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


def get_client_ip(request) -> str:
    """Return the originating client IP from the request.

    Prefer X-Forwarded-For when set (reverse-proxy deployments), trusting the
    rightmost entry -- the one appended by the trusted reverse proxy (Nginx).
    This matches DRF's NUM_PROXIES=1 trust model and prevents IP spoofing via
    a client-injected X-Forwarded-For header.  Fall back to REMOTE_ADDR for
    direct connections.
    """
    xff = request.META.get("HTTP_X_FORWARDED_FOR")
    if xff:
        return xff.split(",")[-1].strip()
    return request.META.get("REMOTE_ADDR", "unknown")
