from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import path, include
from boards.views import LivenessView, ReadinessView
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView, SpectacularRedocView

urlpatterns = [
    path("admin/", admin.site.urls),
    path("accounts/", include("allauth.urls")),
    path("api/auth/", include("dj_rest_auth.urls")),
    path("api/auth/registration/", include("dj_rest_auth.registration.urls")),
    path("api/health/liveness/", LivenessView.as_view()),
    path("api/health/readiness/", ReadinessView.as_view()),
    path("api/", include("boards.urls")),
    path("api/", include("accounts.urls")),
    path("api/", include("groups.urls")),
    # OpenAPI schema endpoints — publicly accessible (no authentication required)
    path("api/schema/", SpectacularAPIView.as_view(), name="schema"),
    path("api/schema/swagger-ui/", SpectacularSwaggerView.as_view(url_name="schema"), name="swagger-ui"),
    path("api/schema/redoc/", SpectacularRedocView.as_view(url_name="schema"), name="redoc"),
] + static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
