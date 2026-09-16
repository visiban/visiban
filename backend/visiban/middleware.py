import os

from django.conf import settings
from django.http import HttpResponseForbidden, JsonResponse

from accounts.models import get_maintenance_message, get_maintenance_state
from visiban.utils import get_client_ip


# Addresses trusted by default when no DJANGO_ADMIN_ALLOWED_IPS env var is set.
# Loopback addresses only — matches both IPv4 and the IPv6 loopback.
_LOOPBACK_IPS = {"127.0.0.1", "::1"}


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

            client_ip = get_client_ip(request)
            if client_ip not in allowed_ips:
                return HttpResponseForbidden(
                    "Access to the admin interface is restricted. "
                    "Set DJANGO_ADMIN_ALLOWED_IPS to grant access."
                )

        return self.get_response(request)


# ---------------------------------------------------------------------------
# Maintenance mode (#783)
# ---------------------------------------------------------------------------

# Methods that cannot change server state. Spelled out here rather than
# imported from rest_framework.permissions so this module stays free of a DRF
# dependency — it runs on every request, including ones DRF never sees.
#
# Verified against the whole URL conf: no read-only endpoint in this codebase is
# served over POST (search is `GET /api/v1/users/?search=` and
# `GET .../cards/?q=`, never a POST body), so the method rule never blocks a
# read. It does let one write-ish GET through — `export()` in
# boards/views/import_export.py appends a BoardExportLog row — and that is
# accepted deliberately: it is an append-only audit row rather than domain
# data, blocking exports mid-maintenance would be user-hostile, and the
# alternative (classifying every endpoint as read or write by hand) is a
# surface that rots the first time someone forgets to annotate a new view.
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "TRACE"})

# Advertised on the 503 so PAT and MCP clients back off instead of retry-storming
# a box that is mid-migration. Deliberately a conservative fixed value and NOT a
# promise about when the window ends — nothing here knows that.
MAINTENANCE_RETRY_AFTER_SECONDS = 120

# Path prefixes that keep accepting writes while maintenance mode is on.
#
# Every entry is on the recovery path or the operator's break-glass path. The
# list is enumerated rather than prefix-globbed (`/api/v1/auth/` as a whole
# would have been shorter) because a blanket auth prefix silently exempts
# `PATCH /api/v1/auth/user/`, `POST /api/v1/auth/registration/` and
# `POST /api/v1/auth/tokens/` — three real writes — to buy convenience. Each
# entry keeps its trailing slash so `/api/v1/admin/` cannot be satisfied by a
# future `/api/v1/administrators/`.
_MAINTENANCE_EXEMPT_PREFIXES = (
    # THE OFF SWITCH. PATCH /api/v1/admin/settings/ is how maintenance mode is
    # turned off; blocking it makes the mode unexitable over the API. Every
    # view under this prefix already declares IsSiteAdmin
    # (accounts/admin_views.py::_ADMIN_PERMISSIONS), so exempting the prefix
    # from the *maintenance* check grants no one any new authority.
    "/api/v1/admin/",
    # THE RECOVERY PATH. Login is a POST: an admin who is logged out, or whose
    # session expired during the upgrade, must be able to authenticate before
    # they can reach the off switch above.
    "/api/v1/auth/login/",
    # NOTE: allauth's SSO login paths are exempt too, but they are matched by
    # suffix in _is_exempt_path() below rather than listed here — see the
    # comment there for why a blanket "/accounts/" prefix is wrong.
    # Nobody should be trapped in a session they cannot end. Blocking logout
    # protects nothing.
    "/api/v1/auth/logout/",
    # Break-glass for an admin locked out mid-incident. Both are already
    # IP-throttled (visiban/urls.py), so exempting them opens no new abuse
    # surface.
    "/api/v1/auth/password/reset/",
    # Forced-flow endpoints. A user carrying must_change_password or
    # must_change_username can do nothing else until they clear it, so blocking
    # these deadlocks them permanently — an admin included.
    "/api/v1/auth/password/change/",
    "/api/v1/auth/change-password/",
    "/api/v1/auth/choose-username/",
    # The one genuine POST-that-is-not-a-write in this codebase: it mints a
    # short-lived credential for the WebSocket handshake. Both consumers are
    # server-push only (`async def receive(...): pass`), so a ticket confers no
    # write capability whatsoever. Blocking it would kill live updates during
    # maintenance — exactly when people are watching for things to change —
    # while protecting nothing.
    "/api/v1/auth/ws-ticket/",
    # Django admin is the break-glass route when the SPA itself is what is
    # broken, and SiteSetting is editable there (edits go through
    # SiteSetting.save(), so cache invalidation still fires). Already restricted
    # to loopback by AdminIPRestrictionMiddleware above and staff-gated by
    # Django, so this reaches only someone already on the box.
    "/admin/",
    # Liveness and readiness must never depend on application state, or the
    # orchestrator restarts pods in the middle of the operator's window. Both
    # are GET today and so already covered by SAFE_METHODS; the explicit entry
    # exists so a probe that later moves to POST does not start a restart loop.
    "/api/health/",
)

# allauth mounts its whole URL tree at /accounts/ (see visiban/urls.py), so a
# blanket "/accounts/" prefix would be the exact mistake the enumerated list
# above exists to avoid: it silently exempts POST /accounts/signup/ (creates a
# user, bypassing InviteRegisterView), POST /accounts/email/ (adds or removes
# an email address), POST /accounts/password/change/ and the /accounts/3rdparty/
# connect and disconnect endpoints. Those are real writes into the very tables
# an operator is most likely to be migrating.
#
# What genuinely must stay reachable is only the SSO login round trip — an
# SSO-only admin who is signed out has no other way back in to reach the off
# switch. Those URLs are generated per provider by allauth's
# build_provider_urlpatterns(), so they cannot be enumerated without the list
# rotting as providers are added; they are matched by suffix instead.
_SSO_LOGIN_PREFIX = "/accounts/"
_SSO_LOGIN_SUFFIXES = ("/login/", "/login/callback/")


def _is_exempt_path(path: str) -> bool:
    """True when `path` must keep accepting writes during maintenance."""
    if path.startswith(_MAINTENANCE_EXEMPT_PREFIXES):
        return True
    return path.startswith(_SSO_LOGIN_PREFIX) and path.endswith(_SSO_LOGIN_SUFFIXES)


class MaintenanceModeMiddleware:
    """Reject non-admin writes with 503 while the instance is in maintenance mode.

    WHY MIDDLEWARE AND NOT A DRF PERMISSION CLASS: adding a permission class to
    DEFAULT_PERMISSION_CLASSES would enforce almost nothing here. This codebase
    declares an explicit `permission_classes` on essentially every view (a
    deliberate convention, #989), so the DRF defaults are inherited by close to
    zero endpoints — the same trap #1110 documents at length in
    accounts/authentication.py, where a scope gate placed in the defaults would
    have been evaluated on no endpoints at all while every test still passed.
    Declaring it on all ~53 override sites instead would be a large, drift-prone
    diff to enforce what one middleware enforces in one place. An instance-wide
    write block must not be defeatable by a single view forgetting to re-declare
    it, so it belongs at the one layer no view can opt out of.

    Note that this makes maintenance mode the first SiteSetting-driven *global*
    middleware in the project: `uploads_enabled` is enforced by a single inline
    check in one view, and AdminIPRestrictionMiddleware gates on client IP
    rather than on database state. This class is establishing that pattern
    rather than following one.

    WHY `is_site_admin` AND NOT `is_staff` / `is_superuser`: `is_site_admin` is
    the flag the entire admin surface gates on (accounts.permissions.IsSiteAdmin).
    A different flag here would create two divergent definitions of "admin" —
    someone exempt from the write block but unable to reach the admin panel, or
    the reverse. `can_access_all_content` is deliberately NOT consulted: it
    grants content visibility, not administrative authority.

    WHY THE ADMIN CHECK RESOLVES TOKENS ITSELF: `request.user` is populated
    here by AuthenticationMiddleware, which reads the *session* only. DRF's
    authenticators — PATAuthentication included — run at the view layer, after
    this middleware, so a PAT-authenticated site admin would still look like
    AnonymousUser and get blocked from their own instance. The acceptance
    criterion is that admins retain full read/write, not that admins with
    cookies do, so the token is resolved here too. That resolution is on the
    slow path by construction: it is reached only after maintenance mode has
    been confirmed active, so an install with the feature off never pays for it.

    WEBSOCKETS NEED NO GUARD, and this is worth stating because the next reader
    of visiban/asgi.py will notice that ProtocolTypeRouter routes "websocket"
    to a separate stack that never traverses Django's HTTP middleware, and
    reasonably suspect a hole. There is none: both consumers implement
    `async def receive(self, text_data): pass  # server-push only`, so the
    socket exposes no write path to close. The MCP transport is a different
    story — it is mounted outside Django's handler and IS a real write channel,
    so it carries its own check in mcp_server.server._require_maintenance_off.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        message = self._blocked_message(request)
        if message is not None:
            # 503 rather than 403: this is a temporary service condition the
            # caller should retry, not a permission decision about them.
            response = JsonResponse(
                {"code": "maintenance_mode", "detail": message},
                status=503,
            )
            response["Retry-After"] = str(MAINTENANCE_RETRY_AFTER_SECONDS)
            return response
        return self.get_response(request)

    def _blocked_message(self, request):
        """Return the notice to reject this request with, or None to let it pass.

        Ordered so that the overwhelmingly common case — an install that never
        turned maintenance mode on — costs one frozenset membership test and
        one cache read, and never a database query, a session resolution, or a
        token lookup.
        """
        if request.method in SAFE_METHODS:
            return None
        # The exemption test comes BEFORE the state read, and that ordering is
        # load-bearing rather than cosmetic. get_maintenance_state() can touch
        # the database on a cold cache, and during a rolling upgrade — new code
        # live, migration 0027 not yet applied — that read raises. Testing the
        # path first means login and the admin off switch never depend on the
        # cache or the database being healthy, which is the whole point of
        # having a recovery path. It is also a pure string comparison, so it
        # costs nothing to do first.
        if _is_exempt_path(request.path):
            return None
        # Cached read; see accounts.models.get_maintenance_state for why this
        # must never become a per-request DB query.
        active, message = get_maintenance_state()
        if not active:
            return None
        if self._is_site_admin(request):
            return None
        return get_maintenance_message(message)

    def _is_site_admin(self, request) -> bool:
        user = getattr(request, "user", None)
        if user is not None and user.is_authenticated:
            return bool(user.is_site_admin)
        return self._token_user_is_site_admin(request)

    def _token_user_is_site_admin(self, request) -> bool:
        """Resolve a PAT bearer far enough to answer "is this a site admin?".

        Deliberately calls ``resolve_personal_access_token`` rather than
        ``PATAuthentication().authenticate()``. The authenticator does two
        things this middleware must not do: it enforces the per-request scope
        baseline, and — more importantly — it calls ``record_token_usage``,
        which issues an UPDATE. Going through it would mean (a) an admin's PAT
        write pays two usage UPDATEs per request, once here and once when DRF
        authenticates again at the view layer, breaking that function's
        documented "a single write, not two" invariant, and (b) a *rejected*
        non-admin PAT request would still write a row before being refused —
        unthrottled, because the request never reaches DRF. A retrying bot
        would then drive UPDATEs into the database the operator is migrating,
        which is precisely what maintenance mode exists to stop.

        ``resolve_personal_access_token`` establishes identity only and records
        nothing, which is all that is needed here. Skipping the scope check
        costs nothing: a token whose scopes are insufficient is still refused
        by ``TokenHasScope`` at the view layer, so the request fails either
        way — this only decides which error it gets.

        Imported locally to keep this module's import graph free of
        accounts.authentication, and to make it obvious at the call site that
        the work happens only while maintenance mode is active.

        Any failure — malformed header, unknown, expired, or revoked token —
        resolves to "not an admin" and the request is rejected with 503. During
        maintenance a bad token therefore sees 503 where it would normally see
        401. That is an acceptable loss of precision for a caller presenting an
        invalid credential, and it leaks strictly less than the 401 would:
        invalid, expired and valid-but-not-admin tokens all get the identical
        response, so this is not a token-validity oracle.
        """
        auth_header = request.META.get("HTTP_AUTHORIZATION", "")
        if not auth_header.startswith("Token "):
            return False
        from accounts.authentication import (
            InvalidPersonalAccessToken,
            resolve_personal_access_token,
        )

        try:
            pat = resolve_personal_access_token(auth_header[len("Token "):].strip())
        except InvalidPersonalAccessToken:
            return False
        return bool(getattr(pat.user, "is_site_admin", False))
