from django.contrib import admin
from django.urls import path, include, re_path
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from accounts.views import InviteRegisterView, ThrottledPasswordResetView
from boards.views import LivenessView, ReadinessView, ServeMediaView, ShareBoardView
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView, SpectacularRedocView


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
    path("accounts/", include("allauth.urls")),
    # All versioned API endpoints live under /api/v1/.
    # The v1 prefix is a literal path segment — not a captured kwarg — so view
    # method signatures do not need to declare a 'version' parameter.
    # request.version is set to "v1" (the DEFAULT_VERSION) by URLPathVersioning.
    # Requests to any other /api/vN/ prefix are caught by the 406 catch-all below.
    # Override the default PasswordResetView with our rate-limited subclass to
    # prevent the reset flow from being used for bulk email sends.
    path("api/v1/auth/password/reset/", ThrottledPasswordResetView.as_view()),
    path("api/v1/auth/", include("dj_rest_auth.urls")),
    # Override the default RegisterView with InviteRegisterView so that
    # invite-only mode validates tokens atomically with user creation.
    # The include() below still handles verify-email/ and resend-email/.
    path("api/v1/auth/registration/", InviteRegisterView.as_view()),
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
