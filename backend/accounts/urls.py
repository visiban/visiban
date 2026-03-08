from django.urls import path
from .views import AuthProvidersView, ChangePasswordView, CurrentUserView

urlpatterns = [
    path("auth/providers/", AuthProvidersView.as_view()),
    path("auth/change-password/", ChangePasswordView.as_view()),
    path("auth/me/", CurrentUserView.as_view()),
]
