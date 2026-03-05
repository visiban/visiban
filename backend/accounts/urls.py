from django.urls import path
from .views import CurrentUserView

urlpatterns = [
    path("auth/user/", CurrentUserView.as_view()),
]
