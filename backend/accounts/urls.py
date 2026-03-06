from django.urls import path
from .views import AuthProvidersView

urlpatterns = [
    path("auth/providers/", AuthProvidersView.as_view()),
]
