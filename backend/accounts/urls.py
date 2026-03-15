from django.urls import path
from .views import AuthProvidersView, ChangePasswordView, CurrentUserView, SiteConfigView, UserSearchView

urlpatterns = [
    path("auth/providers/", AuthProvidersView.as_view()),
    path("auth/site-config/", SiteConfigView.as_view()),
    path("auth/change-password/", ChangePasswordView.as_view()),
    path("auth/me/", CurrentUserView.as_view()),
    path("users/", UserSearchView.as_view()),
]
