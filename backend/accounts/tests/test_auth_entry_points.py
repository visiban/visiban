"""Every auth entry point routes through the shared authorization rules (#1517).

The rules in ``docs/development/security-invariants.md`` apply on more than one
transport, and a fix to one transport's copy used to leave a sibling unfixed.
``visiban.authorization`` now holds one definition of each rule. This module
*discovers* the entry points instead of listing them, and fails when one does
not route through that definition:

- **REST** — every URL in the root resolver. For each DRF view and each HTTP
  method it serves, the view's effective ``get_permissions()`` must include
  the two forced-change gates (``MustNotHavePendingPasswordChange``,
  ``MustNotHavePendingUsernameChange``), which delegate to the shared gates,
  and its authenticators must be ones that refuse an inactive account. A
  non-DRF view must be explicitly allowlisted.
- **WebSocket** — every consumer routed by ``visiban.asgi.application``. The
  handshake must consult ``visiban.authorization`` before it touches the
  database, and the consumer's periodic re-check must use
  ``accounts.ws_auth.load_live_ws_user``, which applies the same gates.
- **MCP** — the transport middleware evaluates the shared gates, and the
  mounted app is wrapped in it (the SDK check runs only when the SDK is
  installed, like the rest of ``mcp_server/tests``).
- **Invites** — every model that looks like an invite link (``token_hash`` and
  ``created_by``) has a creator rule in
  ``visiban.authorization.INVITE_CREATOR_RULES`` or a documented exception.
- **Invite redemption** — every function in the installed apps that looks an
  invite up by its token calls ``invite_creator_is_valid`` (or a registration
  refusal function pinned to it), and the pinned call sites in
  ``REQUIRED_SHARED_CALLS`` make their shared calls (checked with ``ast``).
- **allauth adapter** — the configured adapters are the project's, the signup
  hooks allauth calls are overridden there, and the account-matching and
  registration paths call the shared functions.

An installed extension package can add allowlist entries through the optional
``EXTENSION_ALLOWLIST_MODULE`` instead of editing this file.

Each checker is a plain function and has a negative test that feeds it a
synthetic entry point without the shared check, so a checker that silently
passed everything would fail here too.

Allowlists are explicit and carry a reason per entry, and a stale entry (one
that matches nothing discovered) fails the test so the list cannot rot.
"""

from __future__ import annotations

import ast
import asyncio
import importlib.util
import inspect
import textwrap
from dataclasses import dataclass
from unittest import mock

from channels.generic.websocket import AsyncWebsocketConsumer
from channels.routing import URLRouter
from channels.testing import WebsocketCommunicator
from django.apps import apps
from django.conf import settings
from django.contrib.auth.models import AnonymousUser
from django.test import SimpleTestCase, TestCase, override_settings
from django.urls import URLPattern, URLResolver, get_resolver
from django.utils.module_loading import import_string
from rest_framework import permissions as drf_permissions
from rest_framework.authentication import SessionAuthentication, TokenAuthentication
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.request import Request
from rest_framework.test import APIRequestFactory
from rest_framework.views import APIView

from accounts.authentication import PATAuthentication
from accounts.models import User
from visiban import authorization
from visiban.authorization import (
    ACCOUNT_GATES,
    FORCED_CHANGE_GATES,
    INVITE_CREATOR_RULES,
    PENDING_PASSWORD_CHANGE,
    AccountGate,
    authorize_account,
)
from visiban.permissions import (
    MustNotHavePendingPasswordChange,
    MustNotHavePendingUsernameChange,
)

# ---------------------------------------------------------------------------
# REST
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Allow:
    """One allowlist entry: why the view is exempt, and the exact routes it is
    exempt on. A route ending in ``*`` matches by prefix. The same view class
    mounted at a new route is *not* covered and fails the test until reviewed.

    ``optional`` entries may match nothing, for views that exist only under some
    configurations (an OIDC provider installed only when its env vars are set).
    """

    reason: str
    routes: frozenset
    optional: bool = False

    def covers(self, route: str) -> bool:
        return any(
            route.startswith(r[:-1]) if r.endswith("*") else route == r for r in self.routes
        )


def _allow(reason, *routes, optional=False):
    return Allow(reason, frozenset(routes), optional)


_DJ_REST_AUTH = "Public: dj-rest-auth default."
_EMAIL_KEY = "Public: email confirmation (the key is the credential)."
_SCHEMA = "OpenAPI schema; registry Rule 1 lists this exception."
_INVITE_PREVIEW = (
    "Public invite preview; creator standing via visiban.authorization.invite_creator_is_valid. "
    "POST (redemption) carries both gates."
)

#: DRF views (or ``"<view>:<METHOD>"`` for one method) that may serve requests
#: without the forced-change gates, keyed by view and pinned to their routes.
#: Keep this short: the default is that a view inherits
#: ``DEFAULT_PERMISSION_CLASSES`` and needs no entry at all.
REST_GATE_ALLOWLIST: dict[str, Allow] = {
    # -- Forced-change exempt: the flows a pending user must reach to clear the
    #    flag (registry Rule 1, "documented exceptions").
    "accounts.views.CurrentUserView": _allow(
        "Forced-change exempt: the SPA reads must_change_* from /auth/me/.", "api/v1/auth/me/"
    ),
    "accounts.views.UserDetailsView": _allow(
        "Forced-change exempt: the SPA bootstraps must_change_* from /auth/user/.", "api/v1/auth/user/"
    ),
    "accounts.views.ChangePasswordView": _allow(
        "Forced-change exempt: clears must_change_password.", "api/v1/auth/change-password/"
    ),
    "accounts.views.TokenRevokingPasswordChangeView": _allow(
        "Forced-change exempt: clears must_change_password.", "api/v1/auth/password/change/"
    ),
    "accounts.views.ChooseUsernameView": _allow(
        "Forced-change exempt: clears must_change_username.", "api/v1/auth/choose-username/"
    ),
    "dj_rest_auth.views.UserDetailsView": _allow(
        "Forced-change exempt, same as accounts.views.UserDetailsView. "
        "Registered by include('dj_rest_auth.urls').",
        "api/v1/auth/user/?$",
    ),
    "dj_rest_auth.views.PasswordChangeView": _allow(
        "Forced-change exempt, same as TokenRevokingPasswordChangeView.", "api/v1/auth/password/change/?$"
    ),
    # -- Public by design: no authenticated principal to gate.
    "accounts.views.AuthProvidersView": _allow(
        "Public: login page lists configured providers.", "api/v1/auth/providers/"
    ),
    "accounts.views.SiteConfigView": _allow("Public: pre-login site configuration.", "api/v1/auth/site-config/"),
    "accounts.views.ThrottledLoginView": _allow(
        "Public: login. Inactive accounts are refused by the auth backends.", "api/v1/auth/login/"
    ),
    "accounts.views.ThrottledPasswordResetView": _allow(
        "Public: password reset request.", "api/v1/auth/password/reset/"
    ),
    "accounts.views.ThrottledPasswordResetConfirmView": _allow(
        "Public: password reset confirm (the key is the credential).", "api/v1/auth/password/reset/confirm/"
    ),
    "accounts.views.InviteRegisterView": _allow(
        "Public: registration. Invites are validated and consumed under a row lock through "
        "accounts.registration_tokens.registration_token_kind (registry Rule 4).",
        "api/v1/auth/registration/",
    ),
    "accounts.views.VerifyEmailView": _allow(_EMAIL_KEY, "api/v1/auth/registration/verify-email/"),
    "accounts.views.EmailConfirmRedirectView": _allow(
        "Public: redirect to the SPA confirm page.",
        r"^accounts/confirm-email/(?P<key>[\w:\-]{1,200})/$",
        r"^api/v1/auth/registration/account-confirm-email/(?P<key>[\w:\-]{1,200})/$",
    ),
    "accounts.views.SocialSignupRedirectView": _allow(
        "Public: redirect to the SPA signup page.", "^accounts/3rdparty/signup/$"
    ),
    "dj_rest_auth.views.LoginView": _allow(_DJ_REST_AUTH, "api/v1/auth/login/?$"),
    "dj_rest_auth.views.LogoutView": _allow(
        "AllowAny by dj-rest-auth design: it ends only the caller's own session or token, and "
        "has nothing to end without one.",
        "api/v1/auth/logout/?$",
    ),
    "dj_rest_auth.views.PasswordResetView": _allow(_DJ_REST_AUTH, "api/v1/auth/password/reset/?$"),
    "dj_rest_auth.views.PasswordResetConfirmView": _allow(_DJ_REST_AUTH, "api/v1/auth/password/reset/confirm/?$"),
    "dj_rest_auth.registration.views.RegisterView": _allow(
        "Shadowed by InviteRegisterView at the same path.", "api/v1/auth/registration/"
    ),
    "dj_rest_auth.registration.views.VerifyEmailView": _allow(
        _EMAIL_KEY, "api/v1/auth/registration/verify-email/?$"
    ),
    "dj_rest_auth.registration.views.ResendEmailVerificationView": _allow(
        "Public: resend confirmation email.", "api/v1/auth/registration/resend-email/?$"
    ),
    "boards.views.health.LivenessView": _allow(
        "Public: orchestrator liveness probe, no data.", "api/health/liveness/"
    ),
    "boards.views.health.ReadinessView": _allow(
        "Public: orchestrator readiness probe, no data.", "api/health/readiness/"
    ),
    "boards.views.share.ShareBoardView": _allow(
        "Public: read-only share link; the share token is the capability (Rule 3).", "api/share/<str:token>/"
    ),
    "boards.views.invites.JoinBoardView:GET": _allow(_INVITE_PREVIEW, "api/v1/boards/join/<str:token>/"),
    "groups.views.JoinGroupView:GET": _allow(_INVITE_PREVIEW, "api/v1/groups/join/<str:token>/"),
    "visiban.urls.ApiNotFoundView": _allow(
        "Public: JSON 404 for unknown /api/v1/ paths, no data.", r"^api/v1/[\s\S]*$"
    ),
    # -- Authenticated, but no data behind it.
    "visiban.urls.UnsupportedVersionView": _allow(
        "Returns 406 for /api/vN/ (N != 1); serves no data.", r"^api/v(?!1/)[\w]+/"
    ),
    "drf_spectacular.views.SpectacularAPIView": _allow(_SCHEMA, "api/schema/"),
    "drf_spectacular.views.SpectacularSwaggerView": _allow(_SCHEMA, "api/schema/swagger-ui/"),
    "drf_spectacular.views.SpectacularRedocView": _allow(_SCHEMA, "api/schema/redoc/"),
}

_ALLAUTH_SESSION = "allauth HTML flow (session)."
_ALLAUTH_OAUTH = (
    "allauth OAuth flow (session). Signup goes through SocialRegistrationAdapter, checked below."
)

#: Non-DRF Django views, keyed by view class (or function) dotted path and
#: pinned to their routes. These do not run DRF permission classes at all, so
#: each one is a decision. Exact classes, not module prefixes: a view a future
#: allauth release adds (headless, a new provider) fails here until reviewed.
NON_DRF_ALLOWLIST: dict[str, Allow] = {
    "accounts.views.VisibanSignupView": _allow(
        "allauth HTML signup; gated by RegistrationAdapter.is_open_for_signup.", "accounts/signup/"
    ),
    "accounts.views.VisibanEmailView": _allow("allauth HTML email management (session).", "accounts/email/"),
    "allauth.account.views.AccountInactiveView": _allow(_ALLAUTH_SESSION, "accounts/inactive/"),
    "allauth.account.views.ConfirmEmailView": _allow(_ALLAUTH_SESSION, r"accounts/^confirm-email/(?P<key>[-:\w]+)/$"),
    "allauth.account.views.ConfirmLoginCodeView": _allow(_ALLAUTH_SESSION, "accounts/login/code/confirm/"),
    "allauth.account.views.EmailView": _allow(_ALLAUTH_SESSION, "accounts/email/"),
    "allauth.account.views.LoginView": _allow(_ALLAUTH_SESSION, "accounts/login/"),
    "allauth.account.views.LogoutView": _allow(_ALLAUTH_SESSION, "accounts/logout/"),
    "allauth.account.views.PasswordChangeView": _allow(_ALLAUTH_SESSION, "accounts/password/change/"),
    "allauth.account.views.PasswordResetDoneView": _allow(_ALLAUTH_SESSION, "accounts/password/reset/done/"),
    "allauth.account.views.PasswordResetFromKeyDoneView": _allow(
        _ALLAUTH_SESSION, "accounts/password/reset/key/done/"
    ),
    "allauth.account.views.PasswordResetFromKeyView": _allow(
        _ALLAUTH_SESSION, r"accounts/^password/reset/key/(?P<uidb36>[0-9A-Za-z]+)-(?P<key>.+)/$"
    ),
    "allauth.account.views.PasswordResetView": _allow(_ALLAUTH_SESSION, "accounts/password/reset/"),
    "allauth.account.views.PasswordSetView": _allow(_ALLAUTH_SESSION, "accounts/password/set/"),
    "allauth.account.views.ReauthenticateView": _allow(_ALLAUTH_SESSION, "accounts/reauthenticate/"),
    "allauth.account.views.SignupView": _allow(_ALLAUTH_SESSION, "accounts/signup/"),
    "allauth.account.views.email_verification_sent": _allow(_ALLAUTH_SESSION, "accounts/confirm-email/"),
    "allauth.socialaccount.views.ConnectionsView": _allow(_ALLAUTH_OAUTH, "accounts/3rdparty/"),
    "allauth.socialaccount.views.LoginCancelledView": _allow(_ALLAUTH_OAUTH, "accounts/3rdparty/login/cancelled/"),
    "allauth.socialaccount.views.LoginErrorView": _allow(_ALLAUTH_OAUTH, "accounts/3rdparty/login/error/"),
    "allauth.socialaccount.views.SignupView": _allow(_ALLAUTH_OAUTH, "accounts/3rdparty/signup/"),
    "allauth.socialaccount.providers.google.views.LoginByTokenView": _allow(
        _ALLAUTH_OAUTH, "accounts/google/login/token/"
    ),
    "allauth.socialaccount.providers.oauth2.views.OAuth2View.adapter_view.<locals>.view": _allow(
        _ALLAUTH_OAUTH,
        "accounts/github/login/",
        "accounts/github/login/callback/",
        "accounts/gitlab/login/",
        "accounts/gitlab/login/callback/",
        "accounts/google/login/",
        "accounts/google/login/callback/",
    ),
    # Installed only when the OIDC env vars are set (visiban/settings.py _OIDC_ENABLED).
    "allauth.socialaccount.providers.openid_connect.views.login": _allow(
        _ALLAUTH_OAUTH, "accounts/oidc/*", optional=True
    ),
    "allauth.socialaccount.providers.openid_connect.views.callback": _allow(
        _ALLAUTH_OAUTH, "accounts/oidc/*", optional=True
    ),
    # allauth's legacy social/* URLs and dj-rest-auth's confirm-email placeholders:
    # redirects and static templates, no data. Pinned to these routes only.
    "django.views.generic.base.RedirectView": _allow(
        "Redirect only, no data.",
        "accounts/social/connections/",
        "accounts/social/login/cancelled/",
        "accounts/social/login/error/",
        "accounts/social/signup/",
    ),
    "django.views.generic.base.TemplateView": _allow(
        "Static template only, no data.",
        r"api/v1/auth/registration/^account-confirm-email/(?P<key>[-:\w]+)/$",
        "api/v1/auth/registration/account-email-verification-sent/?$",
    ),
}

#: Authenticators that refuse an inactive account on every request (the
#: INACTIVE gate on REST). A view that adds another must be reviewed and added.
ACTIVE_CHECKING_AUTHENTICATORS: tuple[type, ...] = (
    PATAuthentication,  # resolve_personal_access_token applies visiban.authorization.INACTIVE
    SessionAuthentication,  # DRF: refuses a session user with is_active False
    TokenAuthentication,  # DRF: refuses a token whose user has is_active False
)

# ---------------------------------------------------------------------------
# Extension point: allowlist additions from an installed extension package
# ---------------------------------------------------------------------------

#: Optional module an extension package (the enterprise edition) provides to
#: record its own decisions without editing this file. It may define any of:
#:
#: - ``REST_GATE_ALLOWLIST`` and ``NON_DRF_ALLOWLIST``: dicts keyed like the
#:   ones above. A value is either an object with ``reason``, ``routes`` and
#:   (optionally) ``optional`` attributes, or a dict with those keys, so the
#:   module never has to import this test module.
#: - ``ACTIVE_CHECKING_AUTHENTICATORS``: a tuple of authenticator classes.
#:
#: Its entries are merged with the OSS lists and get the same checks, the
#: stale-entry check included. A key the OSS list already has is an error: an
#: extension adds decisions, it does not override OSS ones. With the module
#: absent, the OSS lists are used as they are.
EXTENSION_ALLOWLIST_MODULE = "enterprise.auth_entry_point_allowlist"


def _as_allow(value) -> Allow:
    if isinstance(value, Allow):
        return value
    if isinstance(value, dict):
        return Allow(value["reason"], frozenset(value["routes"]), bool(value.get("optional", False)))
    return Allow(value.reason, frozenset(value.routes), bool(getattr(value, "optional", False)))


def load_extension_allowlists(module_name: str = EXTENSION_ALLOWLIST_MODULE):
    """The extension module, or None when it (or its package) is not installed.

    A module that exists but fails to import for another reason is an error,
    not an absence, so it is re-raised.
    """
    try:
        return importlib.import_module(module_name)
    except ModuleNotFoundError as exc:
        prefixes = {".".join(module_name.split(".")[:i]) for i in range(1, module_name.count(".") + 2)}
        if exc.name in prefixes:
            return None
        raise


def merge_allowlists(module):
    """``(rest_allowlist, non_drf_allowlist, authenticators)`` with *module*'s
    additions merged into the OSS lists (see EXTENSION_ALLOWLIST_MODULE)."""
    rest, non_drf = dict(REST_GATE_ALLOWLIST), dict(NON_DRF_ALLOWLIST)
    authenticators = ACTIVE_CHECKING_AUTHENTICATORS
    if module is None:
        return rest, non_drf, authenticators
    for name, target in (("REST_GATE_ALLOWLIST", rest), ("NON_DRF_ALLOWLIST", non_drf)):
        for key, value in (getattr(module, name, None) or {}).items():
            if key in target:
                raise ValueError(f"{module.__name__}.{name} redefines OSS entry {key!r}")
            target[key] = _as_allow(value)
    extra = tuple(getattr(module, "ACTIVE_CHECKING_AUTHENTICATORS", ()) or ())
    return rest, non_drf, authenticators + extra


EFFECTIVE_REST_ALLOWLIST, EFFECTIVE_NON_DRF_ALLOWLIST, EFFECTIVE_AUTHENTICATORS = merge_allowlists(
    load_extension_allowlists()
)


@dataclass(frozen=True)
class RestEntryPoint:
    key: str  # dotted view path
    method: str  # upper case
    route: str
    gates: frozenset  # AccountGate objects enforced by the permission chain
    authenticators: tuple  # authenticator classes
    error: str | None = None


@dataclass(frozen=True)
class NonDrfEntryPoint:
    key: str
    route: str
    django_admin: bool = False  # served by django.contrib.admin.site itself


def _enforced_gates(permission) -> frozenset:
    """Shared AccountGates a DRF permission instance enforces.

    ``AND`` enforces both sides' gates, ``OR`` only those both sides enforce
    (either side alone can admit), ``NOT`` none.
    """
    if isinstance(permission, drf_permissions.AND):
        return _enforced_gates(permission.op1) | _enforced_gates(permission.op2)
    if isinstance(permission, drf_permissions.OR):
        return _enforced_gates(permission.op1) & _enforced_gates(permission.op2)
    if isinstance(permission, drf_permissions.NOT):
        return frozenset()
    gate = getattr(permission, "gate", None)
    return frozenset({gate}) if isinstance(gate, AccountGate) else frozenset()


def _dotted(obj) -> str:
    return f"{obj.__module__}.{obj.__qualname__}"


def _served_by_django_admin_site(callback) -> bool:
    """True if *callback* is a view of ``django.contrib.admin.site`` itself.

    Decided per view, not by URL namespace: AdminSite marks its wrapped views
    with ``admin_site`` and ModelAdmin's with ``model_admin``; the login and
    logout views are bound methods of the site; ``__wrapped__`` is followed for
    views wrapped by ``site.admin_view``. Every one of them requires an active
    staff session (login and logout excepted, which serve no data). A different view merely mounted under a namespace
    called "admin" is not covered.
    """
    from django.contrib import admin

    # admin.site is a LazyObject proxy; compare against the real site it wraps.
    admin.site.name  # noqa: B018 — forces the lazy proxy to set up
    site = admin.site._wrapped
    seen = 0
    while callback is not None and seen < 10:
        if getattr(callback, "admin_site", None) is site:
            return True
        model_admin = getattr(callback, "model_admin", None)
        if model_admin is not None and getattr(model_admin, "admin_site", None) is site:
            return True
        owner = getattr(callback, "__self__", None)
        # A bound method of the site, or of a ModelAdmin registered on it
        # (UserAdmin's password view is wrapped by site.admin_view this way).
        if owner is site or getattr(owner, "admin_site", None) is site:
            return True
        callback = getattr(callback, "__wrapped__", None)
        seen += 1
    return False


_factory = APIRequestFactory()


def rest_entry_points_for_callback(callback, route: str) -> list[RestEntryPoint]:
    """One RestEntryPoint per HTTP method a DRF view callback serves.

    Builds the view the way DRF's ``as_view()`` would, then asks it for its
    *effective* permissions per method, so a ``get_permissions()`` override that
    differs by method or action is seen as it runs, not as declared.
    """
    cls = callback.cls
    initkwargs = getattr(callback, "initkwargs", {}) or {}
    actions = getattr(callback, "actions", None)
    if actions:
        method_actions = dict(actions)
        # DRF dispatches OPTIONS (metadata) on every viewset route.
        method_actions.setdefault("options", None)
    else:
        probe = cls(**initkwargs)
        method_actions = {
            m: None for m in cls.http_method_names if hasattr(probe, m) or (m == "head" and hasattr(probe, "get"))
        }
    points = []
    for method, action in sorted(method_actions.items()):
        if method == "trace":
            continue
        view = cls(**initkwargs)
        if actions:
            view.action_map = actions
        request = Request(_factory.generic(method.upper(), "/"))
        request.user = AnonymousUser()
        view.request = request
        view.args = ()
        view.kwargs = {}
        view.format_kwarg = None
        view.action = action
        try:
            gates = frozenset().union(*[_enforced_gates(p) for p in view.get_permissions()])
            authenticators = tuple(type(a) for a in view.get_authenticators())
            error = None
        except Exception as exc:  # noqa: BLE001 — an unevaluable view fails closed below
            gates, authenticators, error = frozenset(), (), f"{type(exc).__name__}: {exc}"
        points.append(RestEntryPoint(_dotted(cls), method.upper(), route, gates, authenticators, error))
    return points


def _walk(patterns, prefix=""):
    for pattern in patterns:
        if isinstance(pattern, URLResolver):
            yield from _walk(pattern.url_patterns, prefix + str(pattern.pattern))
        elif isinstance(pattern, URLPattern):
            yield prefix + str(pattern.pattern), pattern


def discover_http_entry_points():
    """Every view the root URLconf routes to: (rest_points, non_drf_points)."""
    rest, non_drf = [], []
    for route, pattern in _walk(get_resolver().url_patterns):
        callback = pattern.callback
        cls = getattr(callback, "cls", None)
        if isinstance(cls, type) and issubclass(cls, APIView):
            rest.extend(rest_entry_points_for_callback(callback, route))
            continue
        view_class = getattr(callback, "view_class", None)
        key = _dotted(view_class) if view_class is not None else _dotted(callback)
        non_drf.append(NonDrfEntryPoint(key, route, _served_by_django_admin_site(callback)))
    return rest, non_drf


def _rest_allowed(point, allowlist) -> bool:
    for key in (f"{point.key}:{point.method}", point.key):
        entry = allowlist.get(key)
        if entry is not None and entry.covers(point.route):
            return True
    return False


def rest_violations(points, allowlist, authenticators=None) -> list[str]:
    """Human-readable failures for REST entry points that skip the shared gates."""
    authenticators = EFFECTIVE_AUTHENTICATORS if authenticators is None else authenticators
    failures = []
    for point in points:
        if point.error is not None:
            failures.append(f"{point.key} {point.method} ({point.route}): could not evaluate permissions: {point.error}")
            continue
        unsupported = [
            a for a in point.authenticators if not issubclass(a, authenticators)
        ]
        if unsupported:
            failures.append(
                f"{point.key} {point.method} ({point.route}): authenticator(s) "
                f"{[_dotted(a) for a in unsupported]} are not known to refuse inactive accounts; "
                "review and add to ACTIVE_CHECKING_AUTHENTICATORS"
            )
        if FORCED_CHANGE_GATES <= point.gates:
            continue
        if _rest_allowed(point, allowlist):
            continue
        missing = sorted(g.name for g in FORCED_CHANGE_GATES - point.gates)
        failures.append(
            f"{point.key} {point.method} ({point.route}) does not apply {missing}. Keep "
            "DEFAULT_PERMISSION_CLASSES, add MustNotHavePendingPasswordChange and "
            "MustNotHavePendingUsernameChange to its permission_classes, or allowlist it "
            "(view and route) in REST_GATE_ALLOWLIST with a reason."
        )
    return failures


def non_drf_violations(points, allowlist=None) -> list[str]:
    allowlist = EFFECTIVE_NON_DRF_ALLOWLIST if allowlist is None else allowlist
    failures = []
    for point in points:
        if point.django_admin:
            continue
        entry = allowlist.get(point.key)
        if entry is not None and entry.covers(point.route):
            continue
        failures.append(
            f"{point.key} ({point.route}) is a non-DRF view, so no DRF permission class runs on it. "
            "Make it a DRF view that keeps the default permission chain, or allowlist it "
            "(view and route) in NON_DRF_ALLOWLIST with a reason."
        )
    return failures


def stale_allowlist_entries(allowlist, points) -> list[str]:
    """Allowlist (key, route) pairs that match no discovered entry point."""
    stale = []
    for key, entry in allowlist.items():
        view, _, method = key.partition(":")
        routes = {p.route for p in points if p.key == view and (not method or p.method == method)}
        for route in sorted(entry.routes):
            if route.endswith("*"):
                if not entry.optional and not any(r.startswith(route[:-1]) for r in routes):
                    stale.append(f"{key} @ {route}")
            elif route not in routes:
                stale.append(f"{key} @ {route}")
    return stale


class _GatedView(APIView):
    # The default permission chain plus nothing else.
    def get(self, request):  # pragma: no cover - never dispatched
        return None


class _UngatedView(APIView):
    # The #989 failure mode: an override that drops the gates.
    permission_classes = [IsAuthenticated]

    def get(self, request):  # pragma: no cover - never dispatched
        return None


class _OrGatedView(APIView):
    # Either operand alone admits the request, so the gate does not hold.
    permission_classes = [IsAuthenticated & (MustNotHavePendingPasswordChange | AllowAny)]

    def get(self, request):  # pragma: no cover - never dispatched
        return None


class RestEntryPointTests(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.rest_points, cls.non_drf_points = discover_http_entry_points()

    def test_discovery_finds_the_known_transports(self):
        """Guard against a walker that silently finds nothing."""
        keys = {p.key for p in self.rest_points}
        for expected in (
            "boards.views.boards.BoardViewSet",
            "groups.views.GroupViewSet",
            "accounts.views.WSTicketView",
            "boards.views.invites.JoinBoardView",
            "groups.views.JoinGroupView",
        ):
            self.assertIn(expected, keys)
        self.assertGreater(len(self.rest_points), 100)
        if settings.GIT_LENS_ENABLED:
            # Mounted only with the flag; the backend-test-git-lens CI job runs
            # this module with it on so these views are enumerated too.
            for lens_view in ("LensBoardView", "LensConnectionView", "LensUsageAdminView"):
                self.assertIn(f"git_lens.views.{lens_view}", keys)

    def test_every_rest_entry_point_applies_the_shared_account_gates(self):
        failures = rest_violations(self.rest_points, EFFECTIVE_REST_ALLOWLIST)
        self.assertEqual(failures, [], "\n".join(failures))

    def test_every_non_drf_view_is_a_recorded_decision(self):
        failures = non_drf_violations(self.non_drf_points)
        self.assertEqual(failures, [], "\n".join(failures))

    def test_invite_redemption_is_gated_even_though_preview_is_public(self):
        by_method = {
            (p.key, p.method): p for p in self.rest_points
            if p.key in ("boards.views.invites.JoinBoardView", "groups.views.JoinGroupView")
        }
        for key in ("boards.views.invites.JoinBoardView", "groups.views.JoinGroupView"):
            self.assertTrue(FORCED_CHANGE_GATES <= by_method[(key, "POST")].gates, key)

    def test_rest_allowlist_has_no_stale_entries(self):
        stale = stale_allowlist_entries(EFFECTIVE_REST_ALLOWLIST, self.rest_points)
        self.assertEqual(stale, [], "REST_GATE_ALLOWLIST names view/route pairs no URL routes to; remove them.")
        # An allowlisted view that now carries both gates on every method no
        # longer needs its entry either.
        needless = sorted(
            key for key in EFFECTIVE_REST_ALLOWLIST if ":" not in key and all(
                FORCED_CHANGE_GATES <= p.gates for p in self.rest_points if p.key == key
            )
        )
        self.assertEqual(needless, [], "These allowlisted views apply both gates; drop their entries.")

    def test_non_drf_allowlist_has_no_stale_entries(self):
        stale = stale_allowlist_entries(EFFECTIVE_NON_DRF_ALLOWLIST, self.non_drf_points)
        self.assertEqual(stale, [], "NON_DRF_ALLOWLIST names view/route pairs no URL routes to; remove them.")

    def test_django_admin_site_views_are_recognized(self):
        """Guard the admin carve-out: it must find the real admin site's views."""
        admin_routes = [p.route for p in self.non_drf_points if p.django_admin]
        self.assertTrue(any(r == "admin/" for r in admin_routes), admin_routes[:5])
        self.assertTrue(all(r.startswith("admin/") for r in admin_routes), admin_routes)

    def test_permission_classes_delegate_to_the_shared_gates(self):
        self.assertIs(MustNotHavePendingPasswordChange.gate, authorization.PENDING_PASSWORD_CHANGE)
        self.assertIs(MustNotHavePendingUsernameChange.gate, authorization.PENDING_USERNAME_CHANGE)
        self.assertEqual(MustNotHavePendingPasswordChange.message, PENDING_PASSWORD_CHANGE.message)
        self.assertEqual(MustNotHavePendingUsernameChange.code, authorization.PENDING_USERNAME_CHANGE.code)

    def test_default_permission_classes_carry_the_gates(self):
        defaults = settings.REST_FRAMEWORK["DEFAULT_PERMISSION_CLASSES"]
        self.assertIn("visiban.permissions.MustNotHavePendingPasswordChange", defaults)
        self.assertIn("visiban.permissions.MustNotHavePendingUsernameChange", defaults)

    # -- Negative tests: the checker must catch a view that skips the gates.

    def test_negative_a_view_that_drops_the_gates_is_reported(self):
        points = rest_entry_points_for_callback(_UngatedView.as_view(), "synthetic/ungated/")
        failures = rest_violations(points, {})
        self.assertTrue(failures)
        self.assertTrue(all("_UngatedView" in f for f in failures))

    def test_negative_or_composition_does_not_count_as_gated(self):
        points = rest_entry_points_for_callback(_OrGatedView.as_view(), "synthetic/or/")
        self.assertTrue(rest_violations(points, {}))

    def test_negative_a_viewset_action_that_drops_the_gates_is_reported(self):
        from rest_framework import viewsets

        class _UngatedViewSet(viewsets.ViewSet):
            def get_permissions(self):
                if self.action == "list":
                    return [IsAuthenticated()]
                return super().get_permissions()

            def list(self, request):  # pragma: no cover - never dispatched
                return None

            def create(self, request):  # pragma: no cover - never dispatched
                return None

        callback = _UngatedViewSet.as_view({"get": "list", "post": "create"})
        failures = rest_violations(rest_entry_points_for_callback(callback, "synthetic/vs/"), {})
        self.assertEqual(len(failures), 1, failures)
        self.assertIn(" GET ", failures[0])

    def test_negative_an_unknown_authenticator_is_reported(self):
        from rest_framework.authentication import BasicAuthentication

        class _BasicAuthView(APIView):
            authentication_classes = [BasicAuthentication]

            def get(self, request):  # pragma: no cover - never dispatched
                return None

        failures = rest_violations(rest_entry_points_for_callback(_BasicAuthView.as_view(), "x/"), {})
        self.assertTrue(any("BasicAuthentication" in f for f in failures), failures)

    def test_positive_the_default_chain_passes(self):
        points = rest_entry_points_for_callback(_GatedView.as_view(), "synthetic/gated/")
        self.assertEqual(rest_violations(points, {}), [])

    def test_negative_an_unlisted_non_drf_view_is_reported(self):
        def plain_view(request):  # pragma: no cover - never dispatched
            return None

        point = NonDrfEntryPoint(_dotted(plain_view), "synthetic/plain/")
        self.assertTrue(non_drf_violations([point]))

    def test_negative_an_allowlisted_view_at_a_new_route_is_reported(self):
        """Allowlist entries are pinned to routes, not just view classes."""
        rest_point = RestEntryPoint(
            "accounts.views.CurrentUserView", "GET", "api/v1/new-mount/", frozenset(), (SessionAuthentication,)
        )
        self.assertTrue(rest_violations([rest_point], EFFECTIVE_REST_ALLOWLIST))
        redirect = NonDrfEntryPoint("django.views.generic.base.RedirectView", "api/v1/new-redirect/")
        self.assertTrue(non_drf_violations([redirect]))
        future_allauth = NonDrfEntryPoint("allauth.headless.account.views.SessionView", "accounts/headless/")
        self.assertTrue(non_drf_violations([future_allauth]))

    def test_negative_a_view_under_a_namespace_named_admin_is_not_the_admin_site(self):
        def lookalike(request):  # pragma: no cover - never dispatched
            return None

        self.assertFalse(_served_by_django_admin_site(lookalike))
        point = NonDrfEntryPoint(
            _dotted(lookalike), "admin/plugin/", _served_by_django_admin_site(lookalike)
        )
        self.assertTrue(non_drf_violations([point]))

    def test_negative_a_stale_allowlist_route_is_reported(self):
        allow = {"accounts.views.CurrentUserView": Allow("x", frozenset({"api/v1/gone/"}))}
        self.assertEqual(
            stale_allowlist_entries(allow, self.rest_points), ["accounts.views.CurrentUserView @ api/v1/gone/"]
        )


class ExtensionAllowlistTests(SimpleTestCase):
    """The extension-point hook: an optional module adds allowlist entries."""

    def _fake_module(self, name, **attrs):
        import sys
        import types

        module = types.ModuleType(name)
        for key, value in attrs.items():
            setattr(module, key, value)
        patcher = mock.patch.dict(sys.modules, {name: module})
        patcher.start()
        self.addCleanup(patcher.stop)
        return module

    def test_absent_module_leaves_the_oss_lists(self):
        self.assertIsNone(load_extension_allowlists("visiban_no_such_pkg_1517.allowlist"))
        rest, non_drf, auth = merge_allowlists(None)
        self.assertEqual(rest, REST_GATE_ALLOWLIST)
        self.assertEqual(non_drf, NON_DRF_ALLOWLIST)
        self.assertEqual(auth, ACTIVE_CHECKING_AUTHENTICATORS)

    def test_module_entries_are_merged_in_either_shape(self):
        from rest_framework.authentication import BasicAuthentication

        name = "fake_extension_1517"
        module = self._fake_module(
            name,
            REST_GATE_ALLOWLIST={
                "ext.views.PublicView": {"reason": "Public: extension health.", "routes": ["api/ext/health/"]},
            },
            NON_DRF_ALLOWLIST={"ext.views.Page": _allow("Static page.", "ext/page/")},
            ACTIVE_CHECKING_AUTHENTICATORS=(BasicAuthentication,),
        )
        self.assertIs(load_extension_allowlists(name), module)
        rest, non_drf, auth = merge_allowlists(module)
        self.assertTrue(rest["ext.views.PublicView"].covers("api/ext/health/"))
        self.assertIn("ext.views.Page", non_drf)
        self.assertIn(BasicAuthentication, auth)
        self.assertIn("accounts.views.CurrentUserView", rest)
        # The stale-entry check applies to merged entries like OSS ones.
        self.assertIn("ext.views.PublicView @ api/ext/health/", stale_allowlist_entries(rest, []))
        point = RestEntryPoint("ext.views.PublicView", "GET", "api/ext/health/", frozenset(), (BasicAuthentication,))
        self.assertEqual(rest_violations([point], rest, auth), [])

    def test_module_cannot_override_an_oss_entry(self):
        module = self._fake_module(
            "fake_extension_override_1517",
            REST_GATE_ALLOWLIST={"accounts.views.CurrentUserView": {"reason": "x", "routes": ["y/"]}},
        )
        with self.assertRaises(ValueError):
            merge_allowlists(module)

    def test_a_broken_module_is_an_error_not_an_absence(self):
        """A missing dependency *inside* the module must not read as "not installed"."""
        with mock.patch.object(
            importlib, "import_module", side_effect=ModuleNotFoundError("dep", name="some_missing_dependency")
        ):
            with self.assertRaises(ModuleNotFoundError):
                load_extension_allowlists("fake_extension_broken_1517")


# ---------------------------------------------------------------------------
# WebSocket consumers
# ---------------------------------------------------------------------------


def _router_routes(router):
    for route in router.routes:
        callback = route.callback
        if isinstance(callback, URLRouter):
            yield from _router_routes(callback)
        else:
            yield route


def discover_routed_consumers():
    """``(route, consumer_class, app)`` for every consumer the ASGI app routes.

    Walks ``visiban.asgi.application``'s websocket branch through its
    middleware (``.inner``) to the URLRouter, so the enterprise extension
    point's patterns are included when the enterprise package is installed.
    """
    from visiban import asgi

    node = asgi.application.application_mapping["websocket"]
    while not isinstance(node, URLRouter):
        node = node.inner
    found = []
    for route in _router_routes(node):
        found.append((route, route.callback.consumer_class, route.callback))
    return found


class _SpyDenied(Exception):
    pass


def handshake_consults_shared_gates(app, route_kwargs) -> tuple[bool, str]:
    """Open a socket to *app* with an authenticated, credential-bound user while
    ``visiban.authorization`` is replaced by a spy that refuses everyone.

    Compliant: the spy saw the scope user and the socket was not accepted.
    The spy refuses, so a compliant consumer closes before any database
    lookup; a consumer that skips the shared check reaches the database
    instead, which this SimpleTestCase forbids, and is reported.
    """
    from accounts.ws_auth import WS_CREDENTIAL_SCOPE_KEY

    user = User(pk=987654, username="entry-point-probe-1517")
    seen = []

    def spy(candidate, exempt):
        seen.append((candidate, frozenset(exempt)))
        return PENDING_PASSWORD_CHANGE

    async def injected(scope, receive, send):
        scope = {
            **scope,
            "user": user,
            WS_CREDENTIAL_SCOPE_KEY: {"kind": "session", "ref": "probe", "auth_hash": "probe"},
            "url_route": {"args": (), "kwargs": route_kwargs},
        }
        return await app(scope, receive, send)

    async def run():
        communicator = WebsocketCommunicator(injected, "/ws/probe/")
        try:
            connected, _ = await communicator.connect(timeout=2)
            if connected:
                await communicator.disconnect()
        except Exception as exc:  # noqa: BLE001 — any crash means the gate did not decide
            return None, f"{type(exc).__name__}"
        return connected, None

    # Channels runs close_old_connections() before every handler. That is
    # connection housekeeping, not the consumer's own access check, and with
    # database access blocked it would fail every probe for reasons unrelated
    # to the gate, so it is stubbed out for the probe only.
    with mock.patch.object(authorization, "_evaluate_account_gates", spy), mock.patch(
        "channels.consumer.aclose_old_connections", mock.AsyncMock()
    ):
        connected, error = asyncio.run(run())
    calls = [exempt for candidate, exempt in seen if candidate is user]
    if not calls:
        return False, f"handshake never consulted visiban.authorization (outcome: {error or connected})"
    # The handshake has no forced-change exempt flow, so it must apply every
    # gate: a call that exempts one is as good as not asking.
    exempted = sorted({gate.name for exempt in calls for gate in exempt})
    if exempted:
        return False, f"handshake exempted shared gates {exempted}"
    if connected:
        return False, "handshake accepted a user the shared gates refused"
    return True, ""


def _called_names_in_tree(tree) -> set[str]:
    """Names called anywhere in *tree*: ``f()`` gives ``f``, ``m.f()`` gives ``f``."""
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name):
                names.add(func.id)
            elif isinstance(func, ast.Attribute):
                names.add(func.attr)
    return names


def _called_names(obj) -> set[str]:
    """Names *obj*'s own source calls (a class, function or method).

    Parsed with ``ast``, so a name appearing only in a comment, a docstring or
    an import does not count. An object without source calls nothing.
    """
    try:
        tree = ast.parse(textwrap.dedent(inspect.getsource(obj)))
    except (OSError, TypeError):  # no source available: cannot prove the call
        return set()
    return _called_names_in_tree(tree)


def _calls_name(obj, name: str) -> bool:
    return name in _called_names(obj)


def recheck_uses_live_user_loader(consumer_class) -> bool:
    """The periodic re-check must call ``load_live_ws_user``, which applies the
    shared gates to a freshly loaded row (Rule 2). Inherited re-checks count:
    every project class in the MRO is searched, Channels' own classes are not.
    """
    return any(
        _calls_name(klass, "load_live_ws_user")
        for klass in consumer_class.__mro__
        if not klass.__module__.startswith(("channels.", "builtins"))
    )


class _UngatedConsumer(AsyncWebsocketConsumer):
    """A consumer that authenticates but never asks the shared gates."""

    async def connect(self):
        if not self.scope["user"].is_authenticated:
            await self.close(code=4001)
            return
        await self.accept()


class _CommentOnlyConsumer(AsyncWebsocketConsumer):
    """Mentions the loader only in prose: load_live_ws_user."""

    async def connect(self):
        # The re-check would call load_live_ws_user(self.scope) here, but does not.
        await self.accept()


class _ExemptingConsumer(AsyncWebsocketConsumer):
    """Calls the shared function but exempts every gate."""

    async def connect(self):
        if not authorize_account(self.scope["user"], exempt=ACCOUNT_GATES):
            await self.close(code=4003)
            return
        await self.accept()


class _GatedConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        if not authorize_account(self.scope["user"]):
            await self.close(code=4003)
            return
        await self.accept()


class ConsumerEntryPointTests(SimpleTestCase):
    def test_discovery_finds_both_consumers(self):
        names = {cls.__name__ for _, cls, _ in discover_routed_consumers()}
        self.assertTrue({"BoardConsumer", "GroupConsumer"} <= names, names)

    def test_every_routed_consumer_handshake_uses_the_shared_gates(self):
        failures = []
        for route, consumer_class, app in discover_routed_consumers():
            kwargs = {name: "1" for name in route.pattern.regex.groupindex}
            ok, why = handshake_consults_shared_gates(app, kwargs)
            if not ok:
                failures.append(f"{_dotted(consumer_class)} ({route.pattern}): {why}")
        self.assertEqual(failures, [], "\n".join(failures))

    def test_every_routed_consumer_rechecks_through_load_live_ws_user(self):
        failures = [
            _dotted(cls) for _, cls, _ in discover_routed_consumers() if not recheck_uses_live_user_loader(cls)
        ]
        self.assertEqual(failures, [], f"consumers without a load_live_ws_user re-check: {failures}")

    def test_negative_a_consumer_without_the_shared_check_is_reported(self):
        ok, why = handshake_consults_shared_gates(_UngatedConsumer.as_asgi(), {})
        self.assertFalse(ok)
        self.assertIn("never consulted", why)
        self.assertFalse(recheck_uses_live_user_loader(_UngatedConsumer))

    def test_negative_a_consumer_that_exempts_the_gates_is_reported(self):
        ok, why = handshake_consults_shared_gates(_ExemptingConsumer.as_asgi(), {})
        self.assertFalse(ok)
        self.assertIn("exempted", why)

    def test_negative_a_loader_named_only_in_comments_is_reported(self):
        self.assertFalse(recheck_uses_live_user_loader(_CommentOnlyConsumer))

    def test_positive_a_consumer_with_the_shared_check_passes(self):
        ok, why = handshake_consults_shared_gates(_GatedConsumer.as_asgi(), {})
        self.assertTrue(ok, why)


class LiveUserLoaderTests(TestCase):
    """``load_live_ws_user`` (the consumers' re-check) applies the shared gates."""

    def test_recheck_consults_the_shared_gates(self):
        from accounts.ws_auth import load_live_ws_user

        user = User.objects.create_user(username="recheck-1517", password="x-Pass-1517!")
        seen = []

        def spy(candidate, exempt):
            seen.append(candidate.pk)
            return PENDING_PASSWORD_CHANGE

        with mock.patch.object(authorization, "_evaluate_account_gates", spy):
            self.assertIsNone(load_live_ws_user({"user": user}))
        self.assertEqual(seen, [user.pk])

    def test_inactive_user_is_refused_by_the_recheck(self):
        from accounts.ws_auth import load_live_ws_user

        user = User.objects.create_user(username="inactive-1517", password="x-Pass-1517!", is_active=False)
        self.assertIsNone(load_live_ws_user({"user": user}))


# ---------------------------------------------------------------------------
# MCP
# ---------------------------------------------------------------------------


class McpEntryPointTests(TestCase):
    def test_transport_auth_consults_the_shared_gates(self):
        from accounts.models import SCOPE_MCP_READ, PersonalAccessToken
        from mcp_server.auth import AccountStateBlocked, _authenticate_and_authorize

        user = User.objects.create_user(username="mcp-1517", password="x-Pass-1517!")
        _, raw = PersonalAccessToken.generate(user=user, name="mcp", scopes=[SCOPE_MCP_READ])
        seen = []

        def spy(candidate, exempt):
            seen.append(candidate.pk)
            return PENDING_PASSWORD_CHANGE

        with mock.patch.object(authorization, "_evaluate_account_gates", spy):
            with self.assertRaises(AccountStateBlocked) as ctx:
                _authenticate_and_authorize(raw)
        self.assertEqual(seen, [user.pk])
        self.assertEqual(ctx.exception.detail, PENDING_PASSWORD_CHANGE.message)
        self.assertEqual(ctx.exception.code, PENDING_PASSWORD_CHANGE.code)

    @staticmethod
    def _chain(app):
        chain = []
        while app is not None:
            chain.append(app)
            app = getattr(app, "app", None)
        return chain

    def test_mounted_mcp_app_is_wrapped_in_the_bearer_middleware(self):
        if importlib.util.find_spec("mcp.server.mcpserver") is None:  # pragma: no cover - SDK-less runs
            self.skipTest("MCP SDK not installed; the flagged CI job runs this.")
        from mcp_server.asgi_mount import McpPathRouter, mount_mcp_server
        from mcp_server.auth import BearerAuthMiddleware

        async def django_app(scope, receive, send):  # pragma: no cover - never called
            return None

        with override_settings(MCP_SERVER_ENABLED=True):
            router = mount_mcp_server(django_app)
        self.assertIsInstance(router, McpPathRouter)
        self.assertTrue(
            any(isinstance(layer, BearerAuthMiddleware) for layer in self._chain(router.mcp_app)),
            "Every MCP tool is reachable only through the mounted app; it must be wrapped in "
            "BearerAuthMiddleware, which applies the shared account gates.",
        )

    def test_negative_an_unwrapped_app_is_reported(self):
        async def bare(scope, receive, send):  # pragma: no cover - never called
            return None

        from mcp_server.auth import BearerAuthMiddleware

        self.assertFalse(any(isinstance(layer, BearerAuthMiddleware) for layer in self._chain(bare)))


# ---------------------------------------------------------------------------
# Invite links and the allauth adapter
# ---------------------------------------------------------------------------

#: Invite-like models (``token_hash`` + ``created_by``) that have no
#: redemption-time creator rule, with the reason.
INVITE_KINDS_WITHOUT_CREATOR_RULE: dict[str, str] = {
    "accounts.InviteLink": (
        "Site invites: creator standing is handled by revocation on deactivation "
        "(AdminUserDeactivateView._revoke_invite_links)."
    ),
}


def _always_valid(link, board=None):
    """Stand-in creator rule for the registry-dispatch test."""
    return True


def invite_like_models():
    for model in apps.get_models():
        names = {f.name for f in model._meta.get_fields()}
        if {"token_hash", "created_by"} <= names:
            yield model


def invite_model_violations(models, rules, exceptions) -> list[str]:
    return [
        f"{m._meta.label} looks like an invite link but has no creator rule in "
        "visiban.authorization.INVITE_CREATOR_RULES (or a reasoned exception)."
        for m in models
        if m._meta.label not in rules and m._meta.label not in exceptions
    ]


class InviteEntryPointTests(SimpleTestCase):
    def test_every_invite_kind_has_a_creator_rule(self):
        failures = invite_model_violations(
            list(invite_like_models()), INVITE_CREATOR_RULES, INVITE_KINDS_WITHOUT_CREATOR_RULE
        )
        self.assertEqual(failures, [], "\n".join(failures))

    def test_creator_rules_and_exceptions_name_real_models(self):
        labels = {m._meta.label for m in invite_like_models()}
        self.assertEqual(sorted((set(INVITE_CREATOR_RULES) | set(INVITE_KINDS_WITHOUT_CREATOR_RULE)) - labels), [])
        for target in INVITE_CREATOR_RULES.values():
            self.assertTrue(callable(import_string(target)), target)

    def test_inactive_or_deleted_creator_is_never_valid(self):
        from boards.models import BoardInviteLink
        from groups.models import GroupInviteLink

        inactive = User(pk=424242, username="gone-1517", is_active=False)
        for link in (
            BoardInviteLink(board_id=1, created_by=inactive),
            GroupInviteLink(group_id=1, created_by=inactive),
            BoardInviteLink(board_id=1, created_by=None),
            GroupInviteLink(group_id=1, created_by=None),
        ):
            self.assertFalse(authorization.invite_creator_is_valid(link), link._meta.label)

    def test_dispatch_is_driven_by_the_registry(self):
        """A kind registered in INVITE_CREATOR_RULES is dispatched from it, and a
        kind removed from it is refused, so the table and the dispatch cannot
        disagree."""
        from boards.models import BoardInviteLink

        link = BoardInviteLink(board_id=1, created_by=None)
        with mock.patch.dict(INVITE_CREATOR_RULES, {"boards.BoardInviteLink": f"{__name__}._always_valid"}):
            self.assertTrue(authorization.invite_creator_is_valid(link))
        with mock.patch.dict(INVITE_CREATOR_RULES, clear=True):
            with self.assertRaises(TypeError):
                authorization.invite_creator_is_valid(link)

    def test_sender_may_admit_accounts_requires_an_active_site_admin(self):
        self.assertFalse(authorization.sender_may_admit_accounts(None))
        self.assertFalse(authorization.sender_may_admit_accounts(User(is_active=False, is_site_admin=True)))
        self.assertFalse(authorization.sender_may_admit_accounts(User(is_active=True, is_site_admin=False)))
        self.assertTrue(authorization.sender_may_admit_accounts(User(is_active=True, is_site_admin=True)))

    def test_negative_an_unregistered_invite_kind_is_reported(self):
        from accounts.models import InviteLink

        self.assertTrue(invite_model_violations([InviteLink], INVITE_CREATOR_RULES, {}))
        with self.assertRaises(TypeError):
            authorization.invite_creator_is_valid(InviteLink())


class AllauthAdapterEntryPointTests(SimpleTestCase):
    """allauth calls these hooks during login and signup; each must be the
    project's override, or a default that admits signups without an invite (or
    matches a disabled account) would run instead."""

    SOCIAL_HOOKS = ("is_open_for_signup", "pre_social_login", "save_user")
    ACCOUNT_HOOKS = ("is_open_for_signup", "save_user")

    def test_configured_adapters_are_the_projects(self):
        from accounts.adapter import RegistrationAdapter, SocialRegistrationAdapter

        self.assertTrue(issubclass(import_string(settings.ACCOUNT_ADAPTER), RegistrationAdapter))
        self.assertTrue(issubclass(import_string(settings.SOCIALACCOUNT_ADAPTER), SocialRegistrationAdapter))

    def test_signup_hooks_are_overridden(self):
        from accounts.adapter import RegistrationAdapter, SocialRegistrationAdapter

        for cls, hooks in (
            (SocialRegistrationAdapter, self.SOCIAL_HOOKS),
            (RegistrationAdapter, self.ACCOUNT_HOOKS),
        ):
            for hook in hooks:
                self.assertIn(hook, vars(cls), f"{cls.__name__}.{hook} must be overridden")

    def test_invite_redemption_paths_dispatch_through_the_token_table(self):
        """Registration redeems invites only through ``registration_token_kind``,
        whose kinds validate under a row lock (registry Rule 4)."""
        from accounts import adapter
        from accounts.views import InviteRegisterView

        for fn in (
            adapter._validate_signup_token,
            adapter.SocialRegistrationAdapter._redeem_invite,
            InviteRegisterView.create,
        ):
            self.assertTrue(_calls_name(fn, "registration_token_kind"), fn)

    def test_negative_token_table_named_only_in_a_comment_is_reported(self):
        def comment_only(raw_token):
            # Should go through registration_token_kind(raw_token), but does not.
            return raw_token

        self.assertFalse(_calls_name(comment_only, "registration_token_kind"))


# ---------------------------------------------------------------------------
# Invite redemption and adapter call sites
# ---------------------------------------------------------------------------

#: Each function that applies a shared rule, and the calls it must make. Checked
#: with ``ast`` (a real call, not a mention), so deleting the call fails the
#: test. The registration refusal functions reach the shared rules through
#: ``_sender_still_admits``, which is pinned below as well.
REQUIRED_SHARED_CALLS: dict[str, frozenset] = {
    "boards.views.invites.JoinBoardView.get": frozenset({"invite_creator_is_valid"}),
    "boards.views.invites.JoinBoardView.post": frozenset({"invite_creator_is_valid"}),
    "groups.views.JoinGroupView.get": frozenset({"invite_creator_is_valid"}),
    "groups.views.JoinGroupView.post": frozenset({"invite_creator_is_valid"}),
    "boards.invites.board_link_registration_refusal": frozenset({"_sender_still_admits"}),
    "groups.invite_registration.group_link_registration_refusal": frozenset({"_sender_still_admits"}),
    "boards.invites._sender_still_admits": frozenset({"sender_may_admit_accounts", "invite_creator_is_valid"}),
    "groups.invite_registration._sender_still_admits": frozenset(
        {"sender_may_admit_accounts", "invite_creator_is_valid"}
    ),
    "accounts.adapter.SocialRegistrationAdapter._handle_email_collision": frozenset({"principal_is_active"}),
}

#: Calls that count as applying the creator rule in a function that looks an
#: invite up by its token: the shared function itself, or a registration
#: refusal function that REQUIRED_SHARED_CALLS pins to it.
CREATOR_RULE_CALLS: frozenset = frozenset(
    {"invite_creator_is_valid", "board_link_registration_refusal", "group_link_registration_refusal"}
)


def _resolve_dotted(path: str):
    """Import ``module.attr[.attr...]``, trying the longest module prefix first."""
    parts = path.split(".")
    for split in range(len(parts) - 1, 0, -1):
        try:
            obj = importlib.import_module(".".join(parts[:split]))
        except ImportError:
            continue
        for attr in parts[split:]:
            obj = getattr(obj, attr)
        return obj
    raise ImportError(path)


def required_call_violations(table) -> list[str]:
    failures = []
    for path, required in sorted(table.items()):
        try:
            target = _resolve_dotted(path)
        except (ImportError, AttributeError):
            failures.append(f"{path}: no longer exists; update REQUIRED_SHARED_CALLS")
            continue
        missing = sorted(required - _called_names(target))
        if missing:
            failures.append(f"{path} does not call {missing}")
    return failures


def _chain_root(node):
    while isinstance(node, (ast.Attribute, ast.Call, ast.Subscript)):
        node = node.func if isinstance(node, ast.Call) else node.value
    return node.id if isinstance(node, ast.Name) else None


def _token_lookup_model(func_node, model_names) -> str | None:
    """The invite model *func_node* looks up by a presented token, or None.

    A token lookup is ``Model.lookup_by_token(...)``, ``Model._hash_token(...)``
    or a query on ``Model`` with a ``token_hash=`` filter.
    """
    for node in ast.walk(func_node):
        if (
            isinstance(node, ast.Attribute)
            and node.attr in ("lookup_by_token", "_hash_token")
            and isinstance(node.value, ast.Name)
            and node.value.id in model_names
        ):
            return node.value.id
        if isinstance(node, ast.Call) and any(k.arg == "token_hash" for k in node.keywords):
            root = _chain_root(node)
            if root in model_names:
                return root
    return None


def invite_token_consumers(tree, module_name, model_names):
    """``(qualname, model_name, function_node)`` for each function in *tree*
    that looks an invite link up by its token. The model's own methods (whose
    lookups go through ``cls``) are not consumers."""
    found = []

    def visit(node, stack):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.ClassDef):
                visit(child, stack + [child.name])
            elif isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                qual = ".".join([module_name, *stack, child.name])
                model = _token_lookup_model(child, model_names)
                if model is not None:
                    found.append((qual, model, child))
                visit(child, stack + [child.name])

    visit(tree, [])
    return found


def _project_modules():
    """``(module_name, path)`` for every non-test, non-migration module of the
    installed apps that live in this repository (enterprise apps included)."""
    import pathlib

    base = pathlib.Path(settings.BASE_DIR).resolve()
    for config in apps.get_app_configs():
        root = pathlib.Path(config.path).resolve()
        if base not in root.parents and root != base:
            continue
        for path in root.rglob("*.py"):
            rel = path.relative_to(base)
            if {"tests", "migrations"} & set(rel.parts) or path.name.startswith("test_"):
                continue
            yield ".".join(rel.with_suffix("").parts), path


def invite_consumer_violations(consumers, model_label_by_name, exceptions) -> list[str]:
    failures = []
    for qual, model, node in consumers:
        if model_label_by_name.get(model) in exceptions:
            continue
        if not CREATOR_RULE_CALLS & _called_names_in_tree(node):
            failures.append(
                f"{qual} looks up a {model} by token but never calls "
                "visiban.authorization.invite_creator_is_valid (or a registration refusal "
                "function pinned in REQUIRED_SHARED_CALLS)."
            )
    return failures


class InviteRedemptionCallSiteTests(SimpleTestCase):
    def _models(self):
        models = list(invite_like_models())
        return {m.__name__ for m in models}, {m.__name__: m._meta.label for m in models}

    def _discover(self):
        names, _ = self._models()
        found = []
        for module_name, path in _project_modules():
            tree = ast.parse(path.read_text(encoding="utf-8"))
            found.extend(invite_token_consumers(tree, module_name, names))
        return found

    def test_required_shared_calls_are_made(self):
        failures = required_call_violations(REQUIRED_SHARED_CALLS)
        self.assertEqual(failures, [], "\n".join(failures))

    def test_discovery_finds_the_known_redemption_paths(self):
        quals = {qual for qual, _, _ in self._discover()}
        for expected in (
            "boards.views.invites.JoinBoardView.get",
            "boards.views.invites.JoinBoardView.post",
            "groups.views.JoinGroupView.get",
            "groups.views.JoinGroupView.post",
            "boards.invites.validate_board_registration_token",
            "groups.invite_registration.validate_group_registration_token",
        ):
            self.assertIn(expected, quals)

    def test_every_invite_token_consumer_applies_the_creator_rule(self):
        _, labels = self._models()
        failures = invite_consumer_violations(self._discover(), labels, INVITE_KINDS_WITHOUT_CREATOR_RULE)
        self.assertEqual(failures, [], "\n".join(failures))

    # -- Negative tests.

    _CONSUMER_SOURCE = textwrap.dedent(
        """
        class NewJoinView:
            def post(self, request, token):
                # invite_creator_is_valid(link) would go here.
                link = BoardInviteLink.objects.select_for_update().get(
                    token_hash=BoardInviteLink._hash_token(token)
                )
                return link

        def checked(token):
            link = GroupInviteLink.lookup_by_token(token)
            return invite_creator_is_valid(link)
        """
    )

    def test_negative_a_new_consumer_without_the_creator_rule_is_reported(self):
        consumers = invite_token_consumers(
            ast.parse(self._CONSUMER_SOURCE), "synthetic", {"BoardInviteLink", "GroupInviteLink"}
        )
        self.assertEqual({q for q, _, _ in consumers}, {"synthetic.NewJoinView.post", "synthetic.checked"})
        labels = {"BoardInviteLink": "boards.BoardInviteLink", "GroupInviteLink": "groups.GroupInviteLink"}
        failures = invite_consumer_violations(consumers, labels, {})
        self.assertEqual(len(failures), 1, failures)
        self.assertIn("synthetic.NewJoinView.post", failures[0])

    def test_negative_a_removed_shared_call_is_reported(self):
        def collision_without_shared_rule(matches):
            # principal_is_active(user) was here.
            return [user for user in matches if user.is_active]

        target = f"{__name__}._removed_call_probe"
        with mock.patch(target, collision_without_shared_rule, create=True):
            failures = required_call_violations({target: frozenset({"principal_is_active"})})
        self.assertEqual(len(failures), 1, failures)
        self.assertIn("principal_is_active", failures[0])

    def test_negative_a_vanished_function_is_reported(self):
        failures = required_call_violations({f"{__name__}.no_such_function_1517": frozenset({"x"})})
        self.assertIn("no longer exists", failures[0])
