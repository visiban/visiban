import os

from django.conf import settings
from django.http import HttpResponseForbidden


# Addresses trusted by default when no DJANGO_ADMIN_ALLOWED_IPS env var is set.
# Loopback addresses only — matches both IPv4 and the IPv6 loopback.
_LOOPBACK_IPS = {"127.0.0.1", "::1"}


def _get_client_ip(request):
    """Return the originating client IP from the request.

    Prefer X-Forwarded-For when set (reverse-proxy deployments) but only trust
    the first (leftmost) entry, which is the client address appended by the
    outermost proxy. Fall back to REMOTE_ADDR for direct connections.
    """
    forwarded_for = request.META.get("HTTP_X_FORWARDED_FOR")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR", "")


class AdminIPRestrictionMiddleware:
    """Block access to /admin/ for any IP not in the allowlist.

    In DEBUG mode all IPs are allowed so local development is not affected.
    In production the allowlist is populated from the DJANGO_ADMIN_ALLOWED_IPS
    environment variable (comma-separated). If that variable is not set the
    allowlist defaults to loopback addresses only (127.0.0.1 and ::1).

    This provides defence-in-depth: the Nginx config already blocks external
    access to /admin/ at the network layer, but this middleware ensures that
    even if Nginx is misconfigured or bypassed the endpoint remains locked down.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path.startswith("/admin/") and not getattr(settings, "DEBUG", False):
            allowed_ips_env = os.environ.get("DJANGO_ADMIN_ALLOWED_IPS", "")
            if allowed_ips_env.strip():
                allowed_ips = {ip.strip() for ip in allowed_ips_env.split(",") if ip.strip()}
            else:
                allowed_ips = _LOOPBACK_IPS

            client_ip = _get_client_ip(request)
            if client_ip not in allowed_ips:
                return HttpResponseForbidden(
                    "Access to the admin interface is restricted. "
                    "Set DJANGO_ADMIN_ALLOWED_IPS to grant access."
                )

        return self.get_response(request)
