from django.contrib import admin
from django.urls import path, include, re_path
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from dj_rest_auth.registration.views import VerifyEmailView
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView, SpectacularRedocView
from accounts.views import InviteRegisterView, ThrottledPasswordResetView, ThrottledPasswordResetConfirmView, EmailConfirmRedirectView, VerifyEmailThrottle
from boards.views import LivenessView, ReadinessView, ServeMediaView, ShareBoardView


class UnsupportedVersionView(APIView):
    """Return 406 for any /api/vN/ prefix that is not v1."""
    permission_classes = []

    def dispatch(self, request, *args, **kwargs):
        return Response(
            {"detail": "Unsupported API version. Use /api/v1/."},
            status=406,
        )


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
    # Override the default PasswordResetView with our rate-limited subclass to
    # prevent the reset flow from being used for bulk email sends.
    path("api/v1/auth/password/reset/", ThrottledPasswordResetView.as_view()),
    # Registered before dj_rest_auth.urls so Django's URL resolver picks this
    # throttled subclass instead of the default PasswordResetConfirmView.
    path("api/v1/auth/password/reset/confirm/", ThrottledPasswordResetConfirmView.as_view()),
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
    path("api/schema/", SpectacularAPIView.as_view(permission_classes=[IsAuthenticated]), name="schema"),
    path("api/schema/swagger-ui/", SpectacularSwaggerView.as_view(url_name="schema", permission_classes=[IsAuthenticated]), name="swagger-ui"),
    path("api/schema/redoc/", SpectacularRedocView.as_view(url_name="schema", permission_classes=[IsAuthenticated]), name="redoc"),
]

# Enterprise extension point — the enterprise package registers additional URL
# patterns here without modifying this file. If the enterprise package is not
# installed, this block is silently skipped and the OSS URL set is used as-is.
try:
    from enterprise.urls import enterprise_urlpatterns  # type: ignore[import]
    urlpatterns += enterprise_urlpatterns
except ImportError:
    pass
