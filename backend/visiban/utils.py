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
