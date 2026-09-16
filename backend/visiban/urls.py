from django.conf import settings
from django.contrib import admin
from django.urls import path, include, re_path
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from dj_rest_auth.views import UserDetailsView
from dj_rest_auth.registration.views import VerifyEmailView
from drf_spectacular.utils import extend_schema
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView, SpectacularRedocView
from accounts.permissions import TokenHasScope
from accounts.views import (
    EmailConfirmRedirectView,
    InviteRegisterView,
    ThrottledLoginView,
    ThrottledPasswordResetConfirmView,
    ThrottledPasswordResetView,
    TokenRevokingPasswordChangeView,
    VerifyEmailThrottle,
)
from boards.views import LivenessView, ReadinessView, ServeMediaView, ShareBoardView


class UnsupportedVersionView(APIView):
    """Return 406 for any /api/vN/ prefix that is not v1.

    Authenticated callers only (#990) — no board data is served, but gating
    on auth keeps the unauthenticated surface as small as possible and makes
    version probing visible in the same audit logs as the rest of the API.

    Use a per-method handler rather than overriding ``dispatch`` so DRF's
    normal authentication / permission / renderer pipeline runs against
    every request — overriding ``dispatch`` would bypass the auth check
    that ``permission_classes`` is supposed to enforce.
    """
    permission_classes = [IsAuthenticated, TokenHasScope]

    # Excluded from the OpenAPI schema (#1120): the catch-all re_path below
    # uses an unnamed regex group (`[\w]+` with a negative lookahead), which
    # drf-spectacular cannot turn into a clean path parameter — it synthesizes
    # a malformed template (`/api/v{var}[\w]/`, literal regex syntax leaking
    # into the "path") rather than raising. schemathesis then dutifully fuzzed
    # that literal template, producing nonsense URLs like `/api/v0[\w]/` that
    # never matched the real regex and landed on Django's own HTML 404 page
    # instead of a JSON response — undocumented-content-type / undocumented-
    # status-code noise with no bearing on the real API contract. This view
    # is an internal safety net, not a documented operation API consumers are
    # meant to call, so excluding it from the schema is the correct fix (not
    # a CI-side --exclude-path-regex workaround): it stops describing a
    # "path" that was never accurate to begin with.
    @extend_schema(exclude=True)
    def _unsupported(self, request, *args, **kwargs):
        return Response(
            {"detail": "Unsupported API version. Use /api/v1/."},
            status=406,
        )

    get = _unsupported
    post = _unsupported
    put = _unsupported
    patch = _unsupported
    delete = _unsupported
    head = _unsupported
    options = _unsupported


class ApiNotFoundView(APIView):
    """JSON 404 for any /api/v1/... path that doesn't match a real route (#1120).

    Registered dead last — after boards/accounts/groups urls, the conditional
    git_lens include, and the enterprise extension point below — so it only
    ever catches a genuinely unmatched path, never shadows a real one.

    Why this exists: a separate fix (board-pk-nonnumeric-404, merged just
    ahead of this branch) constrained the board-scoped viewsets'
    ``lookup_value_regex`` to digits so a non-numeric id no longer reaches
    ``get_object_or_404`` and crashes with a 500 — it now simply fails to
    match any URL pattern. But when NOTHING in ``urlpatterns`` matches,
    Django's own resolver renders the response itself, before any view
    (DRF's or otherwise) ever runs — the *technical* 404 debug page when
    ``DEBUG=True`` (true of the backend-schema-fuzz CI job, same as
    backend-schema-validate's), a bare ``django 404.html`` otherwise — and
    critically, ``handler404`` is a Django setting for the DEBUG=False case
    only, so pointing it at a JSON view would not fix this in this job's own
    config. The only way to guarantee a JSON response for every /api/v1/ 404
    regardless of DEBUG is to make sure *something* always matches — same
    pattern as ``UnsupportedVersionView`` above, generalized to every
    versioned path instead of just the version segment itself.

    No auth requirement — unlike ``UnsupportedVersionView``, which gates on
    auth because it discloses something (that a caller found an
    unsupported-but-live version prefix). This view fires for a path that
    matched *nothing*, real or otherwise, and `/api/v1/` mixes authenticated
    and deliberately public routes (e.g. the anonymous email-confirmation
    redirect) — an anonymous caller who mistypes or garbles one of those
    public paths must still get a plain 404, not a 401 that both breaks the
    public flow and discloses "this unmatched shape needs auth" as if it
    were meaningful. A 404 for a route that doesn't exist needs no
    authorization check: there is nothing to be authorized for.
    """
    permission_classes = []

    @extend_schema(exclude=True)
    def _not_found(self, request, *args, **kwargs):
        return Response({"detail": "Not found."}, status=404)

    get = _not_found
    post = _not_found
    put = _not_found
    patch = _not_found
    delete = _not_found
    head = _not_found
    options = _not_found


urlpatterns = [
    path("admin/", admin.site.urls),
    # Safety-net: allauth's built-in confirm-email view at accounts/confirm-email/<key>/
    # raises ImproperlyConfigured (TemplateResponseMixin has no template) because Visiban
    # ships no allauth templates — it is a headless SPA. Registering this re_path BEFORE
    # the allauth include ensures the redirect view wins and the SPA handles confirmation.
    # Same character class and length bound as the api/v1/auth/registration/ override above.
    re_path(
        r"^accounts/confirm-email/(?P<key>[\w:\-]{1,200})/$",
        EmailConfirmRedirectView.as_view(),
    ),
    path("accounts/", include("allauth.urls")),
    # All versioned API endpoints live under /api/v1/.
    # The v1 prefix is a literal path segment — not a captured kwarg — so view
    # method signatures do not need to declare a 'version' parameter.
    # request.version is set to "v1" (the DEFAULT_VERSION) by URLPathVersioning.
    # Requests to any other /api/vN/ prefix are caught by the 406 catch-all below.
    # Override the default LoginView with our rate-limited subclass — applies
    # a per-IP ceiling on top of the allauth ACCOUNT_RATE_LIMITS gate (#924).
    # Registered before dj_rest_auth.urls so Django's URL resolver picks this
    # throttled subclass instead of the default LoginView.
    path("api/v1/auth/login/", ThrottledLoginView.as_view()),
    # Override the default PasswordResetView with our rate-limited subclass to
    # prevent the reset flow from being used for bulk email sends.
    path("api/v1/auth/password/reset/", ThrottledPasswordResetView.as_view()),
    # Registered before dj_rest_auth.urls so Django's URL resolver picks this
    # throttled subclass instead of the default PasswordResetConfirmView.
    path("api/v1/auth/password/reset/confirm/", ThrottledPasswordResetConfirmView.as_view()),
    # dj-rest-auth ships these two with permission_classes = [IsAuthenticated],
    # which drops the global chain — including TokenHasScope (#1110). They are
    # reachable with a personal access token, so re-declare the chain here
    # rather than exempt them. Registered before the include() so these patterns
    # win, matching the override style used for login/ and password/reset/ above.
    #
    # BOTH deliberately omit MustNotHavePendingPasswordChange and
    # MustNotHavePendingUsernameChange, exactly like the project's own
    # CurrentUserView / ChangePasswordView / ChooseUsernameView do. These are the
    # endpoints a user with a pending forced change must still be able to reach:
    # /auth/user/ is how the SPA *discovers* must_change_password and
    # must_change_username in the first place (useAuth bootstraps through it and
    # LoginPage re-fetches it after login), so gating it on those flags locks the
    # affected user out of the very flow that clears them. Only the scope gate
    # belongs here.
    path(
        "api/v1/auth/user/",
        UserDetailsView.as_view(
            permission_classes=[IsAuthenticated, TokenHasScope]
        ),
    ),
    path(
        "api/v1/auth/password/change/",
        TokenRevokingPasswordChangeView.as_view(
            permission_classes=[IsAuthenticated, TokenHasScope]
        ),
    ),
    path("api/v1/auth/", include("dj_rest_auth.urls")),
    # Override the default RegisterView with InviteRegisterView so that
    # invite-only mode validates tokens atomically with user creation.
    # The include() below still handles verify-email/ and resend-email/.
    path("api/v1/auth/registration/", InviteRegisterView.as_view()),
    # Safety-net: browsers that navigate directly to the backend confirm-email
    # URL (e.g. stale emails sent before the adapter fix) are redirected to the
    # SPA /confirm-email/<key> route. Must be registered before the dj_rest_auth
    # include so this pattern wins over allauth's template-based ConfirmEmailView.
    # Use a regex pattern instead of <str:key> to bound input length and restrict
    # to the character set allauth actually uses (alphanumeric, hyphen, underscore,
    # colon). This prevents an unbounded path segment from reaching the view.
    re_path(
        r"^api/v1/auth/registration/account-confirm-email/(?P<key>[\w:\-]{1,200})/$",
        EmailConfirmRedirectView.as_view(),
    ),
    # Override verify-email with a throttled subclass for consistency with the
    # rest of the anonymous auth surface. Registered before the include() so
    # this pattern wins; the include still handles resend-email/.
    path(
        "api/v1/auth/registration/verify-email/",
        VerifyEmailView.as_view(throttle_classes=[VerifyEmailThrottle]),
    ),
    path("api/v1/auth/registration/", include("dj_rest_auth.registration.urls")),
    path("api/health/liveness/", LivenessView.as_view()),
    path("api/health/readiness/", ReadinessView.as_view()),
    # Authenticated media serving — all media requests go through ServeMediaView.
    # No static() fallback: that would bypass auth and serve files unauthenticated.
    path("media/<path:path>", ServeMediaView.as_view()),
    path("api/v1/", include("boards.urls")),
    path("api/v1/", include("accounts.urls")),
    path("api/v1/", include("groups.urls")),
    # Public board share-link — unversioned; token is the credential and the URL
    # is shared externally. Intentionally outside the versioned namespace.
    path("api/share/<str:token>/", ShareBoardView.as_view(), name="share-board"),
    # Catch-all: return 406 for /api/vN/ where N != 1. Must come after all
    # explicit /api/v1/ patterns so that valid requests are never intercepted.
    re_path(r"^api/v(?!1/)[\w]+/", UnsupportedVersionView.as_view()),
    # OpenAPI schema endpoints — restricted to authenticated users to avoid
    # exposing the full API surface (all endpoint paths, parameter names, field
    # shapes) to unauthenticated callers. Operators may additionally block
    # /api/schema/* at the Nginx layer for internet-facing deployments.
    path("api/schema/", SpectacularAPIView.as_view(permission_classes=[IsAuthenticated, TokenHasScope]), name="schema"),
    path("api/schema/swagger-ui/", SpectacularSwaggerView.as_view(url_name="schema", permission_classes=[IsAuthenticated, TokenHasScope]), name="swagger-ui"),
    path("api/schema/redoc/", SpectacularRedocView.as_view(url_name="schema", permission_classes=[IsAuthenticated, TokenHasScope]), name="redoc"),
]

# Issue Board Lens (experiment) — routes are only mounted when the feature flag
# is enabled, keeping the API surface dormant for installs that don't use it.
if settings.GIT_LENS_ENABLED:
    urlpatterns += [path("api/v1/", include("git_lens.urls"))]

# Enterprise extension point — the enterprise package registers additional URL
# patterns here without modifying this file. If the enterprise package is not
# installed, this block is silently skipped and the OSS URL set is used as-is.
try:
    from enterprise.urls import enterprise_urlpatterns  # type: ignore[import]
    urlpatterns += enterprise_urlpatterns
except ImportError:
    pass

# Must be genuinely last — after every include() above and the enterprise
# extension point — so it only ever catches a path nothing else claimed.
# See ApiNotFoundView's docstring for why this exists.
# `[\s\S]*`, not `.*` — plain `.` doesn't match `\n`, so a path containing a
# literal newline byte (e.g. a fuzzer-generated group/user id with an
# embedded `%0A`) failed to match this pattern too and fell all the way
# through to Django's raw, unmatched-URL response: the exact HTML-not-JSON
# bug this view exists to close, just for a narrower trigger (#1120, found
# by an independent verification run after the initial fix). The fix is not
# `re.DOTALL`: an inline `(?s)` flag in the pattern *string* makes Django's
# own URL reverse-resolution machinery (`django.utils.regex_helper.
# normalize()`, which runs on every URLconf load, not just an actual
# `reverse()` call) raise `ValueError: Non-reversible reg-exp portion: '(?s'`
# — and `re_path()` does not accept a pre-compiled pattern with the flag set
# programmatically either: `RegexPattern` stores whatever it's given as
# `self._regex` unchanged and Django's own system checks
# (`_check_pattern_startswith_slash`) call `.startswith(...)` on it,
# assuming a plain string. `[\s\S]` (any whitespace-or-not character) is a
# character class, not `.`, so it always matches `\n` with no flag needed —
# both failure modes above were discovered the hard way trying the other two
# approaches first.
urlpatterns += [re_path(r"^api/v1/[\s\S]*$", ApiNotFoundView.as_view())]
