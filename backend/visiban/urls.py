from django.contrib import admin
from django.urls import path, include
from accounts.views import InviteRegisterView
from boards.views import LivenessView, ReadinessView, ServeMediaView, ShareBoardView
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView, SpectacularRedocView

urlpatterns = [
    path("admin/", admin.site.urls),
    path("accounts/", include("allauth.urls")),
    path("api/auth/", include("dj_rest_auth.urls")),
    # Override the default RegisterView with InviteRegisterView so that
    # invite-only mode validates tokens atomically with user creation.
    # The include() below still handles verify-email/ and resend-email/.
    path("api/auth/registration/", InviteRegisterView.as_view()),
    path("api/auth/registration/", include("dj_rest_auth.registration.urls")),
    path("api/health/liveness/", LivenessView.as_view()),
    path("api/health/readiness/", ReadinessView.as_view()),
    # Authenticated media serving — all media requests go through ServeMediaView.
    # No static() fallback: that would bypass auth and serve files unauthenticated.
    path("media/<path:path>", ServeMediaView.as_view()),
    path("api/", include("boards.urls")),
    path("api/", include("accounts.urls")),
    path("api/", include("groups.urls")),
    # Public board share-link — no authentication required; token is the credential.
    # Registered at project level (not under /api/boards/) so the URL leaks no board PK.
    path("api/share/<str:token>/", ShareBoardView.as_view(), name="share-board"),
    # OpenAPI schema endpoints — publicly accessible (no authentication required)
    path("api/schema/", SpectacularAPIView.as_view(), name="schema"),
    path("api/schema/swagger-ui/", SpectacularSwaggerView.as_view(url_name="schema"), name="swagger-ui"),
    path("api/schema/redoc/", SpectacularRedocView.as_view(url_name="schema"), name="redoc"),
]
