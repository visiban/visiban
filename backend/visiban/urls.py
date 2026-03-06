from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import path, include

urlpatterns = [
    path("admin/", admin.site.urls),
    path("accounts/", include("allauth.urls")),
    path("api/auth/", include("dj_rest_auth.urls")),
    path("api/auth/registration/", include("dj_rest_auth.registration.urls")),
    path("api/", include("boards.urls")),
    path("api/", include("accounts.urls")),
    path("api/", include("groups.urls")),
] + static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
