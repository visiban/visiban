from django.contrib import admin
from django.urls import path, include

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/auth/", include("dj_rest_auth.urls")),
    path("api/auth/registration/", include("dj_rest_auth.registration.urls")),
    path("api/auth/social/", include("allauth.socialaccount.urls")),
    path("api/", include("boards.urls")),
    path("api/", include("accounts.urls")),
]
