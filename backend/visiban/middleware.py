import codecs
import functools
import ipaddress
import logging
import os
import re

from django.conf import settings
from django.http import HttpResponseForbidden, HttpResponseRedirect, JsonResponse, QueryDict
from django.utils.datastructures import MultiValueDict
from django.urls import Resolver404, resolve

from accounts.models import get_maintenance_message, get_maintenance_state
from visiban.authorization import ACCOUNT_GATES, FORCED_CHANGE_GATES, account_state_denial
from visiban.demo import (
    DEMO_ALLOWED_WRITES,
    DEMO_READ_ONLY_CODE,
    DEMO_READ_ONLY_DETAIL,
    DEMO_SAFE_METHODS,
)
from visiban.utils import get_client_ip

logger = logging.getLogger(__name__)

# Addresses trusted by default when no DJANGO_ADMIN_ALLOWED_IPS env var is set.
# Loopback addresses only — matches both IPv4 and the IPv6 loopback.
_LOOPBACK_IPS = ("127.0.0.1", "::1")


# Text codecs Django must not decode a request with because they can turn plain
# ASCII into a lone UTF-16 surrogate (utf-7, unicode-escape, raw-unicode-escape,
# punycode) or raise even in replace mode (idna, undefined). Canonical
# ``codecs.lookup(...).name`` values, so aliases (utf7, u7, ...) match too.
# Every other text codec CPython 3.11 ships was swept over short (1- and 2-byte)
# inputs and never yields a surrogate or raises. A codec a future Python adds
# fails test_every_codec_is_classified until someone decides whether it belongs
# here (the short sweep cannot find a producer that needs 5+ bytes).
_UNSAFE_REQUEST_CODECS = frozenset({
    "utf-7", "unicode-escape", "raw-unicode-escape", "punycode", "idna", "undefined",
})


def _is_unsafe_request_codec(encoding):
    """True if ``encoding`` is a known codec Django must not decode a request with."""
    try:
        info = codecs.lookup(encoding)
    except LookupError:
        return False  # Django ignores an unknown charset, so nothing to refuse
    if info.name in _UNSAFE_REQUEST_CODECS:
        return True
    try:
        # DRF's own text-codec test: hex, base64, rot13, zlib, bz2, uu and quopri
        # are bytes-to-bytes (or str-to-str) codecs; "".encode() fails for them.
        "".encode(info.name)
    except LookupError:
        return True
    return False


def _drop_unusable_part_charsets(request):
    """Make ``request.POST``/``FILES`` treat a part with an unusable codec as absent (#2151).

    WHY: a multipart part header such as ``filename*=hex''%41.json`` makes
    Django's header parser call ``unquote(..., encoding="hex")``, and the
    ``LookupError`` (a non-text codec) escapes as a 500 wherever Django itself
    reads the body (CSRF validation on a session-authenticated POST, admin
    forms). Django already drops a part whose param is undecodable (utf-7), so
    this answers the same way: an empty ``POST``/``FILES``. DRF parses the body
    with its own parser and is covered by ``LimitedMultiPartParser``, which
    answers a 400. The request-level codec test above cannot see these: the
    codec comes from the part header, which is only available once the body is
    parsed.
    """
    original = request.parse_file_upload

    def parse_file_upload(META, post_data):
        try:
            return original(META, post_data)
        except LookupError as exc:
            if isinstance(exc, (KeyError, IndexError)):
                raise  # a real bug, not an unknown codec; keep it a loud 500
            logger.warning("Dropped multipart body: a part header names an unusable codec")
            return QueryDict(encoding=request._encoding), MultiValueDict()

    request.parse_file_upload = parse_file_upload


class RequestCharsetMiddleware:
    """Refuse a request whose ``Content-Type`` declares an unsafe ``charset`` (#2120).

    WHY: Django honors ``charset=`` on the request's ``Content-Type`` for
    ``request.POST`` and multipart field/file names, and under WSGI for
    ``request.GET`` too (under Daphne/ASGI the query string is always read as
    UTF-8, so production does not hit the query-string case; the multipart one
    is reachable there). A codec such as ``utf-7`` (``+2AA-`` decodes to
    ``"\\ud800"``) turns plain ASCII into a lone UTF-16 surrogate, which UTF-8
    cannot encode, so psycopg raises on PostgreSQL and the request is an
    unhandled 500. #2085 guarded only the JSON body. Refusing at the one place
    the encoding is chosen covers every surface, including views added later,
    instead of patching each reader.

    The check is a deny-list, so every other charset (ISO-8859-2, Windows-1251,
    Shift_JIS, GBK, KOI8-R, ...) keeps working: the four surrogate-producing text
    codecs, ``idna``/``undefined`` (which raise), and non-text codecs (``hex``,
    ``base64``, ``rot13``, ...) are refused. An unknown charset name is ignored,
    as Django does. Must stay in ``MIDDLEWARE``
    (docs/architecture/open-core-boundary.md).

    Runs right after Security/CORS (so the 400 carries their headers) and before
    anything has touched ``request.GET``/``POST`` yet. Answers the
    documented JSON ``{"detail": ...}`` 400.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        # ``request.encoding`` is what Django set from the Content-Type charset
        # (None when absent or unknown).
        encoding = request.encoding
        if encoding and _is_unsafe_request_codec(encoding):
            return JsonResponse({"detail": "Unsupported request charset. Use UTF-8."}, status=400)
        _drop_unusable_part_charsets(request)
        return self.get_response(request)


class AdminIPRestrictionMiddleware:
    """Block access to /admin/ for any IP (or CIDR range) not in the allowlist.

    In DEBUG mode all IPs are allowed so local development is not affected.
    In production the allowlist is populated from the DJANGO_ADMIN_ALLOWED_IPS
    environment variable (comma-separated). If that variable is not set the
    allowlist defaults to loopback addresses only (127.0.0.1 and ::1).

    This provides defence-in-depth: the Nginx config already blocks external
    access to /admin/ at the network layer, but this middleware ensures that
    even if Nginx is misconfigured or bypassed the endpoint remains locked down.

    Entries are parsed as IP *networks* (``ipaddress.ip_network(..., strict=False)``),
    not exact strings: the Helm chart feeds the same
    ``backend.settings.adminAllowedIPs`` value to both this middleware and the
    frontend Nginx allowlist (`frontend-configmap.yaml`), and Nginx's
    `geo`/`allow` directives already accept CIDR ranges there. A CIDR entry
    that passes Nginx but is then rejected here (exact string match only) is a
    silent misconfiguration that fails closed — the request is blocked rather
    than leaked, but the allowlisted admin access an operator configured
    simply does not work. Parsing as a network makes a bare IP and a CIDR
    range behave identically (`ip_network("10.0.0.1", strict=False)` is a
    single-address /32 or /128 network), so this is a strict superset of the
    old exact-match behaviour.

    ``strict=False`` is kept even though it silently normalizes a mistyped
    entry with host bits set (`10.0.0.5/24` becomes `10.0.0.0/24`) — Nginx's
    `geo` directive accepts the same host-bits-set entries, so rejecting them
    here would break the parity the whole CIDR fix exists for. Both that case
    and an unusually broad prefix (which could open `/admin/` to far more of
    the internet than an operator intended, `/0` most of all) are instead
    logged once at startup — see `_parse_allowed_networks`.

    An IPv4-mapped IPv6 client address (`::ffff:10.0.0.1`, which a
    dual-stack proxy can produce) is also tested against IPv4 entries: Python's
    `IPv4Network.__contains__` returns False for such an address even though
    it denotes the same host, so without this an IPv4 CIDR entry would never
    match a client that arrived over the IPv6 socket. See `_is_allowed`.
    """

    def __init__(self, get_response):
        self.get_response = get_response
        # Parsed once at process start, not per request: the env var does not
        # change at runtime, and re-parsing on every /admin/ request would be
        # pure waste on a hot path that already has to run before every other
        # check.
        self._allowed_networks = self._parse_allowed_networks()

    @staticmethod
    def _parse_allowed_networks():
        allowed_ips_env = os.environ.get("DJANGO_ADMIN_ALLOWED_IPS", "")
        entries = [ip.strip() for ip in allowed_ips_env.split(",") if ip.strip()]
        if not entries:
            entries = list(_LOOPBACK_IPS)

        networks = []
        for entry in entries:
            try:
                network = ipaddress.ip_network(entry, strict=False)
            except ValueError:
                # Logged once at startup, and deliberately WITHOUT any
                # per-request client IP — this is the operator-supplied
                # DJANGO_ADMIN_ALLOWED_IPS config value, not request data, so
                # logging it here does not log a client IP.
                logger.warning(
                    "Ignoring invalid DJANGO_ADMIN_ALLOWED_IPS entry: %r", entry
                )
                continue

            # strict=True raises exactly when the entry has host bits set
            # (e.g. "10.0.0.5/24"), which strict=False above silently
            # normalized to the network address ("10.0.0.0/24"). That
            # normalization is intentional — see the class docstring — but a
            # mistyped mask should not be silently different from what the
            # operator typed, so it is logged once here.
            try:
                ipaddress.ip_network(entry, strict=True)
            except ValueError:
                logger.warning(
                    "DJANGO_ADMIN_ALLOWED_IPS entry %r has host bits set; "
                    "normalized to network %s",
                    entry,
                    network,
                )

            # A prefix broader than this is large enough that it is more
            # likely a typo than an intentional allowlist — most of all a
            # /0, which is every address on the internet.
            broad = (network.version == 4 and network.prefixlen < 8) or (
                network.version == 6 and network.prefixlen < 32
            )
            if broad:
                if network.prefixlen == 0:
                    logger.warning(
                        "DJANGO_ADMIN_ALLOWED_IPS entry %r is /0 — this "
                        "allows every IPv%s address to reach /admin/.",
                        entry,
                        network.version,
                    )
                else:
                    logger.warning(
                        "DJANGO_ADMIN_ALLOWED_IPS entry %r resolves to the "
                        "unusually broad network %s; double-check this is "
                        "intentional.",
                        entry,
                        network,
                    )

            networks.append(network)
        return networks

    def __call__(self, request):
        if request.path.startswith("/admin/") and not getattr(settings, "DEBUG", False):
            client_ip = get_client_ip(request)
            if not self._is_allowed(client_ip):
                return HttpResponseForbidden(
                    "Access to the admin interface is restricted. "
                    "Set DJANGO_ADMIN_ALLOWED_IPS to grant access."
                )

        return self.get_response(request)

    def _is_allowed(self, client_ip: str) -> bool:
        try:
            address = ipaddress.ip_address(client_ip)
        except ValueError:
            # An unparseable client IP (e.g. get_client_ip()'s "unknown"
            # fallback, or a malformed X-Forwarded-For entry) fails closed
            # rather than being compared against the allowlist as a string.
            return False

        # An IPv4-mapped IPv6 address is the same host as its IPv4 form, so
        # it must also be checked against IPv4 allowlist entries.
        candidates = [address]
        ipv4_mapped = getattr(address, "ipv4_mapped", None)
        if ipv4_mapped is not None:
            candidates.append(ipv4_mapped)

        return any(
            candidate in network
            for candidate in candidates
            for network in self._allowed_networks
        )


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
# boards/views/import_export.py appends a BoardExportLog row, and so do movement
# exports (the `?export=` branch in boards/views/analytics.py) — and that is
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
# an email address), POST /accounts/password/reset/key/... (sets a password)
# and the /accounts/3rdparty/ connect and disconnect endpoints. Those are real
# writes into the very tables an operator is most likely to be migrating.
# (/accounts/password/change/ and /set/ redirect to the SPA for every method
# and write nothing, #1561; they are not exempt all the same.)
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
    # The dj-rest-auth routes resolve with or without the trailing slash
    # (visiban/urls.py), so an exempt auth route stays exempt in its no-slash
    # form. Limited to /api/v1/auth/ and to exact entries, so the trailing-slash
    # guard against lookalike prefixes (see above) still holds elsewhere.
    if (
        path.startswith("/api/v1/auth/")
        and not path.endswith("/")
        and (path + "/").startswith(_MAINTENANCE_EXEMPT_PREFIXES)
    ):
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


# ---------------------------------------------------------------------------
# Hosted demo fence (#1179)
# ---------------------------------------------------------------------------


class DemoModeMiddleware:
    """Refuse every unsafe request not on ``DEMO_ALLOWED_WRITES`` while ``DEMO_MODE`` is on.

    The rule itself — safe methods, the pinned allowlist, the refusal body — and
    the threat model behind it live in ``visiban.demo``. This class only applies
    it at the one layer no view can opt out of, for the same reason
    ``MaintenanceModeMiddleware`` is middleware and not a DRF default permission
    class (#989/#1110: almost no view inherits the DRF defaults).

    JURISDICTION IS EVERYTHING, NOT ``/api/``. Scoping to ``/api/`` and bolting
    on allauth's ``/accounts/`` tree separately would be two code paths; the
    maintenance fence's exempt-list shape, inverted, is one. Every unsafe
    request anywhere — ``/api/``, ``/accounts/`` (signup, email, password
    change, 3rd-party connect), ``/admin/``, ``/media/`` — is refused unless its
    ``(method, view_name)`` is on the allowlist.

    WHY ``process_view`` AND NOT ``__call__``: the allowlist is keyed on the
    resolved ``view_name`` (card routes carry ids, so a path match would need
    regexes), and ``request.resolver_match`` is only populated after URL
    resolution, which Django runs *after* every middleware's ``__call__``
    pre-phase. ``process_view`` is the hook that runs after resolution and
    before the view.

    WHY IT SITS AHEAD OF SESSION/AUTH/CSRF (see MIDDLEWARE): the fence denies
    everyone, a site admin included, so it needs no ``request.user`` — unlike
    maintenance mode, whose admin exemption does. Being first in MIDDLEWARE
    also makes its ``process_view`` run before ``CsrfViewMiddleware``'s, so a
    refused request does no CSRF, session or database work at all. Anonymous
    requests are refused too, which is what stops the password-reset endpoint
    from turning a public demo into an email relay.

    KEYED ON THE REAL METHOD. Nothing here, in Django or in DRF reads
    ``X-HTTP-Method-Override`` or a ``_method`` field, so a header cannot
    downgrade a POST to a GET; a test pins that.

    UNRESOLVED PATHS. ``process_view`` never runs for a path that resolves to
    nothing (``//api/...``, for instance), so no view — and no write — can run
    either. ``__call__`` still rewrites that 404 to the fence's 403 so the
    refusal is uniform and does not depend on the resolver staying strict.
    (Unmatched ``/api/v1/`` paths resolve to ``ApiNotFoundView`` and are
    refused by ``process_view`` like any other non-allowlisted route.)

    NOT COVERED HERE, BY DESIGN: WebSockets (server-push only, no write path —
    see MaintenanceModeMiddleware's note) and ``/mcp``, which is mounted
    outside Django's handler and carries its own check in
    ``mcp_server.server._require_demo_off``.

    With ``DEMO_MODE`` off the cost is one settings lookup per request.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        if (
            response.status_code == 404
            and getattr(request, "resolver_match", None) is None
            and self._is_refusable_method(request)
        ):
            return self._refusal()
        return response

    def process_view(self, request, view_func, view_args, view_kwargs):
        if not self._is_refusable_method(request):
            return None
        match = request.resolver_match
        view_name = match.view_name if match is not None else None
        if (request.method.upper(), view_name) in DEMO_ALLOWED_WRITES:
            return None
        return self._refusal()

    @staticmethod
    def _is_refusable_method(request) -> bool:
        # Fail closed on the flag: only an exact False lets a request through,
        # so a non-boolean settings value refuses rather than disables.
        if getattr(settings, "DEMO_MODE", False) is False:
            return False
        return (request.method or "").upper() not in DEMO_SAFE_METHODS

    @staticmethod
    def _refusal():
        # Plain JsonResponse: this runs before the view, so no DRF exception
        # handler is in play and there is nothing to roll back.
        return JsonResponse(
            {"code": DEMO_READ_ONLY_CODE, "detail": DEMO_READ_ONLY_DETAIL},
            status=403,
        )


# Session-based HTML surfaces outside the REST API: allauth's account pages and
# the Django admin. Each keeps its trailing slash so a future /administrators/
# or /accountsx/ route is not swept in by accident.
PENDING_ACTION_GATED_PREFIXES = ("/accounts/", "/admin/")

# Exact paths only. Ending the session is always allowed: a pending user must
# be able to sign out, and logging out grants nothing.
PENDING_ACTION_EXEMPT_PATHS = frozenset({"/accounts/logout/", "/admin/logout/"})

# Views under a gated prefix that an authenticated user with a pending change
# may still reach, keyed by the RESOLVED view name (the URL name, namespaced
# for the admin; the dotted view path for an unnamed route). The decision is
# made on the resolved view so that the decision and the dispatched view are
# always the same.
#
# Admission rule (docs/development/authorization-entry-points.md): a view is
# listed only when an anonymous visitor reaches it with the same effect, so a
# pending session gains nothing a signed-out browser does not have, or when it
# applies the forced-change gate itself. The SSO login and callback views of
# every installed provider are added by ``pending_action_exempt_views`` and
# belong to the second kind: a callback that would attach an identity to the
# signed-in account (``process=connect``) is refused for a pending user by
# ``accounts.adapter.SocialRegistrationAdapter.pre_social_login``.
PENDING_ACTION_EXEMPT_VIEWS = frozenset(
    {
        # Ending the session.
        "account_logout",
        "admin:logout",
        # Password reset by email: the emailed key is the credential, and a
        # completed reset clears the forced password change
        # (accounts.credentials.finalize_password_reset).
        "account_reset_password",
        "account_reset_password_done",
        "account_reset_password_from_key",
        "account_reset_password_from_key_done",
        # Email confirmation link: redirects to the SPA with the key and
        # changes nothing itself (accounts.views.EmailConfirmRedirectView).
        "accounts.views.EmailConfirmRedirectView",
        # Static result pages.
        "account_inactive",
        "socialaccount_login_cancelled",
        "socialaccount_login_error",
        # Generic OIDC nests its apps under one URL name pair.
        "openid_connect_login",
        "openid_connect_callback",
    }
)

PENDING_ACTION_REFUSAL = "Complete the pending account change in the app before continuing."

_VIEW_NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.:\-]*$")


def is_well_formed_gated_prefix(prefix) -> bool:
    """True for a path prefix such as ``/sso/``: leading and trailing slash, not ``/`` alone."""
    return (
        isinstance(prefix, str)
        and len(prefix) > 2
        and prefix.startswith("/")
        and prefix.endswith("/")
        and "//" not in prefix
    )


def pending_action_gated_prefixes() -> tuple[str, ...]:
    """The built-in gated prefixes plus ``settings.PENDING_ACTION_EXTRA_GATED_PREFIXES``.

    The setting is the extension point for an installed extension package
    that mounts its own session-based HTML pages (default ``()``). Entries
    that are not well formed are left out here and reported by the
    ``accounts.E004`` system check, so a typo cannot widen the gate to every
    path.
    """
    return PENDING_ACTION_GATED_PREFIXES + _valid_extra_gated_prefixes()


def _valid_extra_gated_prefixes() -> tuple[str, ...]:
    """The well-formed entries of ``settings.PENDING_ACTION_EXTRA_GATED_PREFIXES``.

    Shared by the gate and the E007 URL walk so the walk never derives the
    extra prefixes by slicing the combined tuple, which would silently drop
    them if that tuple were ever reordered or deduplicated (#1593).
    """
    extra = getattr(settings, "PENDING_ACTION_EXTRA_GATED_PREFIXES", ()) or ()
    if isinstance(extra, str):
        extra = (extra,)
    return tuple(p for p in extra if is_well_formed_gated_prefix(p))


def is_pending_action_gated_path(path: str) -> bool:
    """True when *path* is one of the session HTML surfaces the gate covers.

    A path without its trailing slash (``/admin``) is normalized first, so it
    is gated like ``/admin/`` rather than slipping past the prefix match.
    """
    if not path.endswith("/"):
        path = path + "/"
    if path in PENDING_ACTION_EXEMPT_PATHS:
        return False
    return path.startswith(pending_action_gated_prefixes())


def is_well_formed_exempt_view(name) -> bool:
    """True for one exact view name such as ``saml_acs`` or ``admin:logout``.

    Letters, digits, ``_``, ``.``, ``:`` and ``-`` only: no whitespace, no
    wildcard and no path, so an entry can name exactly one view.
    """
    return isinstance(name, str) and bool(_VIEW_NAME_RE.match(name))


def _view_name_of(pattern) -> str:
    """The name ``resolve()`` reports for *pattern*: its URL name, else the dotted view path."""
    if pattern.name:
        return pattern.name
    callback = pattern.callback
    # Unwrap as ResolverMatch does: functools.partial, then a class-based view's class.
    if isinstance(callback, functools.partial):
        callback = callback.func
    callback = getattr(callback, "view_class", None) or callback
    # A callable instance has no __qualname__/__name__ of its own; use its class.
    qualname = getattr(callback, "__qualname__", None) or type(callback).__qualname__
    module = getattr(callback, "__module__", None) or type(callback).__module__
    return f"{module}.{qualname}"


# A route segment such as ``<int:pk>`` in a ``path()`` route (same syntax as
# Django's own route parser).
_ROUTE_PARAMETER_RE = re.compile(r"<(?:(?P<converter>[^>:]+):)?(?P<parameter>[^>]+)>")


def _slash_free_converters() -> tuple[type, ...]:
    """Built-in path converters whose values can never contain ``/``."""
    from django.urls.converters import IntConverter, SlugConverter, StringConverter, UUIDConverter

    return (IntConverter, SlugConverter, StringConverter, UUIDConverter)


def _regex_literal_prefix(source: str) -> tuple[str, bool, bool]:
    """``(prefix, fully_literal, end_anchored)`` for a regex source such as ``^sso/(?P<x>\\w+)/$``.

    *prefix* is the literal text every match of the regex starts with
    (``sso/``); *fully_literal* is True when nothing but end anchors follows
    that text; *end_anchored* is True when such an anchor (``$``, ``\\Z``) is
    present. ``^accounts/3rdparty/signup/$`` matches only its text, while
    ``^acc`` is fully literal but open-ended: as an endpoint Django applies
    it with ``search()``, so it also serves ``/accounts/x``. Anything the
    parser cannot read, or a case-insensitive regex, gives
    ``("", False, False)``: no known prefix, so the caller cannot rule the
    route out.
    """
    try:
        from re import _parser as sre_parse  # Python 3.11+
    except ImportError:  # pragma: no cover - older interpreters
        try:
            import sre_parse  # type: ignore[no-redef]
        except ImportError:
            return "", False, False
    try:
        parsed = sre_parse.parse(source)
    except Exception:  # noqa: BLE001 - any parse failure means "unknown", never "safe"
        return "", False, False
    if parsed.state.flags & re.IGNORECASE:
        return "", False, False
    ops = list(parsed)
    i = 0
    while i < len(ops) and ops[i][0] == sre_parse.AT and ops[i][1] in (
        sre_parse.AT_BEGINNING,
        sre_parse.AT_BEGINNING_STRING,
    ):
        i += 1
    chars = []
    while i < len(ops) and ops[i][0] == sre_parse.LITERAL:
        chars.append(chr(ops[i][1]))
        i += 1
    tail = ops[i:]
    fully_literal = all(
        op == sre_parse.AT and arg in (sre_parse.AT_END, sre_parse.AT_END_STRING) for op, arg in tail
    )
    return "".join(chars), fully_literal, fully_literal and bool(tail)


def _pattern_tokens(pattern, is_endpoint: bool) -> list[tuple]:
    """Split one URL pattern into the tokens ``_can_serve_under`` matches against.

    Tokens: ``("lit", text)``; ``("re", compiled, literal_prefix, slash_free)``
    for a converter or a regex whose matches vary; ``("any",)`` for a pattern
    whose matches cannot be bounded (an unanchored regex, which Django
    applies with ``search()`` and so can sit after ANY leading text, or an
    unknown pattern class such as ``LocalePrefixPattern``).
    """
    from django.urls.resolvers import RegexPattern, RoutePattern

    if isinstance(pattern, RoutePattern):
        route = str(pattern)
        converters = getattr(pattern, "converters", None)
        if converters is None:
            return [("any",)]
        tokens: list[tuple] = []
        pos = 0
        for m in _ROUTE_PARAMETER_RE.finditer(route):
            tokens.append(("lit", route[pos : m.start()]))
            converter = converters.get(m.group("parameter"))
            if converter is None:
                return [("any",)]
            tokens.append(
                ("re", re.compile(converter.regex), "", isinstance(converter, _slash_free_converters()))
            )
            pos = m.end()
        tokens.append(("lit", route[pos:]))
        return tokens
    if isinstance(pattern, RegexPattern):
        source = str(pattern)
        anchored = source.startswith(("^", r"\A")) or (is_endpoint and source.endswith("$"))
        if not anchored:
            return [("any",)]
        prefix, fully_literal, end_anchored = _regex_literal_prefix(source)
        # A resolver (include) hands the rest of the path to its children, so
        # its literal regex is exactly its text. An endpoint without an end
        # anchor is applied with search() and serves any longer path too
        # (``^acc`` serves ``/accounts/x``), so it stays an open-ended regex
        # token, which _can_serve_under fails safe on.
        if fully_literal and (end_anchored or not is_endpoint):
            return [("lit", prefix)]
        return [("re", pattern.regex, prefix, False)]
    return [("any",)]


def _can_serve_under(tokens: list[tuple], rem: str) -> bool:
    """True when the route *tokens* can match some path that starts with *rem*.

    *rem* is a gated prefix without its leading slash (``accounts/``). This
    over-approximates on purpose: a route is dropped only when it provably
    cannot produce such a path. A converter or regex is tried at every split
    of *rem* (``<str:x>`` can be ``accounts``, ``^(?:accounts|admin)/`` can be
    ``accounts/``); a regex or ``path`` converter that would have to match
    past the end of *rem* is assumed able to (fail safe), while the
    slash-free built-in converters cannot, because *rem* ends with ``/``.
    """
    if not rem:
        return True
    if not tokens:
        # A slashless path (``/admin``) is gated like ``/admin/``.
        return rem == "/"
    token, rest = tokens[0], tokens[1:]
    if token[0] == "any":
        return True
    if token[0] == "lit":
        text = token[1]
        if text.startswith(rem):
            return True
        return rem.startswith(text) and _can_serve_under(rest, rem[len(text) :])
    _, regex, prefix, slash_free = token
    if prefix and prefix.startswith(rem):
        return True
    if not rem.startswith(prefix):
        return False
    for k in range(len(prefix), len(rem) + 1):
        if regex.fullmatch(rem[:k]) and _can_serve_under(rest, rem[k:]):
            return True
    return not slash_free


@functools.lru_cache(maxsize=8)
def _oss_gated_view_names(urlconf, extra_prefixes: tuple[str, ...]) -> frozenset[str]:
    from django.urls import URLPattern, URLResolver, get_resolver

    builtin = tuple(p[1:] for p in PENDING_ACTION_GATED_PREFIXES)
    extra = tuple(p[1:] for p in extra_prefixes)
    resolver = get_resolver(urlconf)
    # Routes the root URLconf took from its extension point (visiban/urls.py
    # ``extension_urlpatterns``) are the extension's own: they count only
    # under the built-in prefixes.
    extension_ids = {id(p) for p in getattr(resolver.urlconf_module, "extension_urlpatterns", ()) or ()}
    names: set[str] = set()

    def walk(patterns, tokens: list[tuple], namespace: str, top: bool, oss: bool) -> None:
        for p in patterns:
            here_oss = oss and not (top and id(p) in extension_ids)
            here = tokens + _pattern_tokens(p.pattern, isinstance(p, URLPattern))
            if isinstance(p, URLResolver):
                ns = f"{namespace}{p.namespace}:" if p.namespace else namespace
                walk(p.url_patterns, here, ns, False, here_oss)
            elif isinstance(p, URLPattern):
                prefixes = builtin + (extra if here_oss else ())
                if any(_can_serve_under(here, prefix) for prefix in prefixes):
                    names.add(f"{namespace}{_view_name_of(p)}")

    walk(resolver.url_patterns, [], "", True, True)
    return frozenset(names)


def oss_gated_view_names(urlconf=None) -> frozenset[str]:
    """Names of every view that can serve a path under a gated prefix and may not be exempted by an extension.

    Two sets of routes count (#1593):

    - every route that can serve a path under a BUILT-IN prefix
      (``/accounts/``, ``/admin/``), whoever mounted it;
    - every OSS route that can serve a path under an operator-added
      ``PENDING_ACTION_EXTRA_GATED_PREFIXES`` entry. A route is an
      extension's own, and does not count here, when the root URLconf took it
      from its extension point: the top-level patterns listed in the root
      module's ``extension_urlpatterns`` (``visiban/urls.py`` fills it from
      ``enterprise.urls.enterprise_urlpatterns``). A root URLconf without
      that attribute marks every route OSS, which is the fail-safe reading.

    "Can serve" is decided on each pattern's matching rules, not on its
    printed route: a regex alternation (``^(?:accounts|admin)/``), a leading
    converter (``<str:x>/``) and an unanchored regex all count, and a route
    whose reach cannot be bounded is counted rather than allowed. The walk
    covers routes that need arguments (``admin:accounts_user_change``), which
    ``reverse()`` alone would not. Used by ``accounts.E007`` and by
    ``pending_action_exempt_views`` so the check, the merge and the gate share
    one prefix list. Cached per URLconf and extra-prefix setting (the default
    URLconf is resolved first so a ROOT_URLCONF override is a different key);
    call ``oss_gated_view_names.cache_clear()`` after changing URL patterns in
    a test.
    """
    return _oss_gated_view_names(urlconf or settings.ROOT_URLCONF, _valid_extra_gated_prefixes())


oss_gated_view_names.cache_clear = _oss_gated_view_names.cache_clear  # type: ignore[attr-defined]


def _sso_round_trip_views() -> frozenset[str]:
    """``<provider>_login`` and ``<provider>_callback`` for every installed provider.

    These are the URL names allauth's ``default_urlpatterns`` gives each
    provider's login and callback views. Derived from the provider registry so
    a provider added in ``INSTALLED_APPS`` is covered without editing a list.
    Other per-provider views (Google's ``login/token/``) are not added and stay
    gated.
    """
    try:
        from allauth.socialaccount.providers import registry
    except ImportError:  # socialaccount not installed: no SSO round trip
        return frozenset()
    names = set()
    for provider_class in registry.get_class_list():
        names.add(f"{provider_class.id}_login")
        names.add(f"{provider_class.id}_callback")
    return frozenset(names)


def pending_action_exempt_views() -> frozenset[str]:
    """``PENDING_ACTION_EXEMPT_VIEWS``, the SSO round trip, and ``settings.PENDING_ACTION_EXTRA_EXEMPT_VIEWS``.

    The setting (default ``()``) is the extension point for an installed
    extension package whose own views under a gated prefix meet the admission
    rule above (for example a SAML assertion consumer). Exact view names only;
    an entry that is not well formed is left out here and reported by the
    ``accounts.E006`` system check. A name in ``oss_gated_view_names()`` (a
    view that can serve a path under ``/accounts/`` or ``/admin/``, or an OSS
    view under an extra gated prefix) that is not already exempt is also left
    out (reported by ``accounts.E007``): checks do not run under gunicorn/ASGI
    or with ``--skip-checks``, so this merge is the enforcement and the check
    is the reporter. The admission rule itself is policy; only that subset is
    enforced.
    """
    extra = getattr(settings, "PENDING_ACTION_EXTRA_EXEMPT_VIEWS", ()) or ()
    if isinstance(extra, str):
        extra = (extra,)
    return (
        PENDING_ACTION_EXEMPT_VIEWS
        | _sso_round_trip_views()
        | frozenset(
            name
            for name in extra
            if is_well_formed_exempt_view(name)
            and (name in PENDING_ACTION_EXEMPT_VIEWS or name not in oss_gated_view_names())
        )
    )


def resolved_view_name(path: str, urlconf=None) -> str | None:
    """The view name *path* resolves to, or ``None`` when it resolves to nothing.

    A slashless path that does not resolve is retried with its trailing slash,
    which is where ``CommonMiddleware`` (``APPEND_SLASH``) would send it; the
    view at the slashless path never runs in that case.
    """
    candidates = (path,) if path.endswith("/") else (path, path + "/")
    for candidate in candidates:
        try:
            return resolve(candidate, urlconf).view_name
        except Resolver404:
            continue
    return None


def is_pending_action_exempt_view(path: str, urlconf=None) -> bool:
    """True when *path* resolves to a view a pending user may still reach."""
    name = resolved_view_name(path, urlconf)
    return name is not None and name in pending_action_exempt_views()


#: The account gates this middleware applies: the forced-change gates only.
#: INACTIVE is left to the session layer, where it already holds:
#: ``AuthenticationMiddleware`` resolves an inactive account's session to
#: ``AnonymousUser`` (``ModelBackend.get_user`` refuses it), so it never
#: reaches this check as an authenticated user.
_NOT_APPLIED_HERE = frozenset(ACCOUNT_GATES) - FORCED_CHANGE_GATES


class PendingAccountActionMiddleware:
    """Apply the forced-change gates to the session-based HTML surfaces (#1551, #1561).

    Registry Rule 1 (``docs/development/security-invariants.md``): an account
    with a forced password or username change pending is refused on every
    transport. REST applies it through DRF permission classes, MCP and the
    WebSockets through ``visiban.authorization``. allauth's account pages under
    ``/accounts/`` and the Django admin under ``/admin/`` are plain Django
    views that run no DRF permission class, so the same rule is applied here,
    at the one layer every one of them passes through. ``/api/`` is not gated
    here: its views carry the DRF permission classes and their JSON 403
    contract.

    The gated prefixes are ``/accounts/``, ``/admin/`` and any listed in
    ``settings.PENDING_ACTION_EXTRA_GATED_PREFIXES``. The views a pending user
    may still reach are ``pending_action_exempt_views()``, decided on the
    resolved view (see ``PENDING_ACTION_EXEMPT_VIEWS``).

    The predicate is ``visiban.authorization.account_state_denial`` limited to
    ``FORCED_CHANGE_GATES``, the same gate objects the other transports
    evaluate. A gated GET or HEAD is redirected to the SPA (``FRONTEND_URL``),
    which walks the user through the change; any other method is refused with
    a plain 403. Neither response says which change is pending or echoes
    ``next``, and the target comes from settings only, never from the request.

    Unauthenticated requests pass, so sign-in (including the SSO round trip)
    works; after sign-in allauth redirects to ``LOGIN_REDIRECT_URL``, which is
    ``FRONTEND_URL`` and outside the gated prefixes (``accounts.checks``
    refuses a configuration where it is not, since that would loop).

    Must sit after ``AuthenticationMiddleware``, which sets ``request.user``;
    the ``accounts.E005`` system check refuses a ``MIDDLEWARE`` setting that
    drops it or puts it earlier.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        path = request.path_info
        # Cheapest test first; the URL resolution in the exemption test runs
        # only for a pending user on a gated path.
        if (
            is_pending_action_gated_path(path)
            and self._is_pending(request)
            and not is_pending_action_exempt_view(path, getattr(request, "urlconf", None))
        ):
            if request.method in ("GET", "HEAD"):
                return HttpResponseRedirect(settings.FRONTEND_URL)
            return HttpResponseForbidden(PENDING_ACTION_REFUSAL, content_type="text/plain")
        return self.get_response(request)

    @staticmethod
    def _is_pending(request) -> bool:
        user = getattr(request, "user", None)
        if user is None or not user.is_authenticated:
            return False
        return account_state_denial(user, exempt=_NOT_APPLIED_HERE) is not None
