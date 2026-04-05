from django.contrib import admin
from django.urls import path, include
from rest_framework.permissions import IsAuthenticated
from accounts.views import InviteRegisterView
from boards.views import LivenessView, ReadinessView, ServeMediaView, ShareBoardView
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView, SpectacularRedocView

urlpatterns = [
    path("admin/", admin.site.urls),
    path("accounts/", include("allauth.urls")),
    # All versioned API endpoints live under /api/<version>/.
    # URLPathVersioning reads the version kwarg and makes it available as
    # request.version. Only "v1" is currently accepted (ALLOWED_VERSIONS setting).
    path("api/<version>/auth/", include("dj_rest_auth.urls")),
    # Override the default RegisterView with InviteRegisterView so that
    # invite-only mode validates tokens atomically with user creation.
    # The include() below still handles verify-email/ and resend-email/.
    path("api/<version>/auth/registration/", InviteRegisterView.as_view()),
    path("api/<version>/auth/registration/", include("dj_rest_auth.registration.urls")),
    path("api/health/liveness/", LivenessView.as_view()),
    path("api/health/readiness/", ReadinessView.as_view()),
    # Authenticated media serving — all media requests go through ServeMediaView.
    # No static() fallback: that would bypass auth and serve files unauthenticated.
    path("media/<path:path>", ServeMediaView.as_view()),
    path("api/<version>/", include("boards.urls")),
    path("api/<version>/", include("accounts.urls")),
    path("api/<version>/", include("groups.urls")),
    # Public board share-link — unversioned; token is the credential and the URL
    # is shared externally. Intentionally outside the versioned namespace.
    path("api/share/<str:token>/", ShareBoardView.as_view(), name="share-board"),
    # OpenAPI schema endpoints — restricted to authenticated users to avoid
    # exposing the full API surface (all endpoint paths, parameter names, field
    # shapes) to unauthenticated callers. Operators may additionally block
    # /api/schema/* at the Nginx layer for internet-facing deployments.
    path("api/schema/", SpectacularAPIView.as_view(permission_classes=[IsAuthenticated]), name="schema"),
    path("api/schema/swagger-ui/", SpectacularSwaggerView.as_view(url_name="schema", permission_classes=[IsAuthenticated]), name="swagger-ui"),
    path("api/schema/redoc/", SpectacularRedocView.as_view(url_name="schema", permission_classes=[IsAuthenticated]), name="redoc"),
]
