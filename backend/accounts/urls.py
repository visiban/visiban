from django.urls import path
from .views import (
    AuthProvidersView, ChangePasswordView, CurrentUserView,
    PersonalAccessTokenDeleteView, PersonalAccessTokenListCreateView,
    SiteConfigView, UserSearchView,
)
from .admin_views import AdminSettingsView, AdminUsersView, AdminUserDetailView

urlpatterns = [
    path("auth/providers/", AuthProvidersView.as_view()),
    path("auth/site-config/", SiteConfigView.as_view()),
    path("auth/change-password/", ChangePasswordView.as_view()),
    path("auth/me/", CurrentUserView.as_view()),
    path("auth/tokens/", PersonalAccessTokenListCreateView.as_view()),
    path("auth/tokens/<int:pk>/", PersonalAccessTokenDeleteView.as_view()),
    path("users/", UserSearchView.as_view()),
    # Admin API — all gated by IsSiteAdmin
    path("admin/settings/", AdminSettingsView.as_view()),
    path("admin/users/", AdminUsersView.as_view()),
    path("admin/users/<int:pk>/", AdminUserDetailView.as_view()),
]
